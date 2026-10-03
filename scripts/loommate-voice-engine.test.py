import importlib.util
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from io import BytesIO
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import wave

module_spec = importlib.util.spec_from_file_location('loommate_worker', Path(__file__).with_name('loommate-voice-engine.py'))
worker = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(worker)

FAKE_CHILD = '''
import json,os,struct,sys,threading,time
def send(data):
    frame=b'\\x00'+data
    sys.stdout.buffer.write(struct.pack('!I',len(frame))+frame)
    sys.stdout.buffer.flush()
send(b'ready')
for line in sys.stdin.buffer:
    text=json.loads(line)['input']
    if text=='wait':time.sleep(3)
    if text=='bad-frame':
        sys.stdout.buffer.write(struct.pack('!I',32*1024*1024+2))
        sys.stdout.buffer.flush()
        continue
    send(json.dumps({'pid':os.getpid(),'main_thread':threading.current_thread() is threading.main_thread(),'text':text}).encode())
'''


class ModelProcessTests(unittest.TestCase):
    def test_matching_chinese_frontend_preserves_english_and_reports_empty_english(self):
        chinese, english_factory, english = Mock(), Mock(), Mock()
        english_factory.return_value = english
        modules = {'misaki.zh': SimpleNamespace(ZHG2P=chinese),
                   'misaki.espeak': SimpleNamespace(EspeakFallback=english_factory)}
        with patch.dict(sys.modules, modules):
            worker.create_phonemizer({'phonemizerVersion': '1.1'})
        english_factory.assert_called_once_with(british=False)
        self.assertEqual(chinese.call_args.kwargs['version'], '1.1')
        callback = chinese.call_args.kwargs['en_callable']
        english.return_value = ('ˈAˌI', 2)
        self.assertEqual(callback('AI'), 'ˈAˌI')
        self.assertEqual(english.call_args.args[0].text, 'AI')
        english.return_value = (None, None)
        with self.assertRaisesRegex(RuntimeError, 'english_phonemization_failed'):
            callback('AI')

    def test_unsupported_phonemes_are_rejected_instead_of_skipped(self):
        with self.assertRaisesRegex(RuntimeError, 'unsupported_phonemes'):
            worker.phoneme_batches('a❓b', {'a': 11, 'b': 22})

    def test_slow_os_termination_keeps_child_owned_until_it_is_reaped(self):
        model = worker.ProcessSynthesizer.__new__(worker.ProcessSynthesizer)
        model.stop_lock = threading.Lock()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = worker.subprocess.TimeoutExpired('test-child', 3)
        model.process = process
        with self.assertRaises(worker.subprocess.TimeoutExpired):
            model.stop_process()
        self.assertIs(model.process, process)
        process.kill.assert_called_once()
        process.poll.return_value = 0
        model.stop_process()
        self.assertIsNone(model.process)

    def test_long_phoneme_input_keeps_every_token_and_empty_tokens_fail(self):
        phonemes = 'ab' * 511
        batches = worker.phoneme_batches(phonemes, {'a': 11, 'b': 22})
        self.assertEqual([len(batch) for batch in batches], [510, 510, 2])
        self.assertEqual([token for batch in batches for token in batch], [11, 22] * 511)
        with self.assertRaisesRegex(RuntimeError, 'supported_phonemes'):
            worker.phoneme_batches('unsupported', {})

    def test_installed_voice_and_frontend_must_match_current_specification(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            spec = {'model': 'model', 'revision': 'fixed', 'voice': 'zf_001',
                    'phonemizerVersion': '1.1', 'voiceFile': 'voices.bin'}
            installed = {**spec, 'modelPath': str(root)}
            file = root / 'spec.json'
            file.write_text(json.dumps(spec))
            (root / 'voices.bin').touch()
            manifest = root / 'loommate-voice.json'
            manifest.write_text(json.dumps(installed))
            self.assertEqual(worker.read_installed(root, file)[1], root.resolve())
            for override in [{'voice': 'zf_xiaoni'}, {'phonemizerVersion': None}]:
                manifest.write_text(json.dumps({**installed, **override}))
                with self.assertRaisesRegex(RuntimeError, 'specification'):
                    worker.read_installed(root, file)

    def test_model_process_stays_on_main_thread_and_is_reused_and_closed(self):
        model = worker.ProcessSynthesizer([sys.executable, '-u', '-c', FAKE_CHILD], startup_timeout=15)
        process = model.process
        try:
            first, second = json.loads(model('你好')), json.loads(model('第二句'))
            self.assertTrue(first['main_thread'])
            self.assertEqual(first['pid'], second['pid'])
            self.assertEqual(first['text'], '你好')
        finally:
            model.close()
        self.assertIsNotNone(process.poll())
        with self.assertRaisesRegex(RuntimeError, 'closed'):
            model('after_close')

    def test_model_deadline_terminates_only_child_and_next_request_restarts(self):
        model = worker.ProcessSynthesizer([sys.executable, '-u', '-c', FAKE_CHILD], startup_timeout=15, request_timeout=0.2)
        process = model.process
        try:
            with self.assertRaises(TimeoutError):
                model('wait')
            self.assertIsNone(model.process)
            self.assertIsNotNone(process.poll())
            model.request_timeout = 5
            recovered = json.loads(model('recovered'))
            self.assertNotEqual(recovered['pid'], process.pid)
        finally:
            model.close()

    def test_child_exit_and_oversized_ipc_frame_fail_and_release_process(self):
        with self.assertRaisesRegex(RuntimeError, 'exited'):
            worker.ProcessSynthesizer([sys.executable, '-c', 'raise SystemExit(1)'], startup_timeout=15)
        model = worker.ProcessSynthesizer([sys.executable, '-u', '-c', FAKE_CHILD], startup_timeout=15)
        try:
            with self.assertRaisesRegex(RuntimeError, 'frame'):
                model('bad-frame')
            self.assertIsNone(model.process)
        finally:
            model.close()


class VoiceWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.model = Path(self.temporary.name)
        self.spec = {'enginePort': 0, 'voiceFile': 'voices/test.safetensors', 'profile': 'loommate-sweet',
                     'voice': 'test', 'revision': 'test-pinned', 'language': 'z', 'speed': 1.0}
        self.entered = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.fail_inference = False
        self.factory_thread = None
        self.call_threads = []
        self.active = 0
        self.maximum_active = 0
        self.state_lock = threading.Lock()
        self.server = None

    def factory(self):
        self.factory_thread = threading.get_ident()

        def synthesize(_text):
            with self.state_lock:
                self.active += 1
                self.maximum_active = max(self.active, self.maximum_active)
                self.call_threads.append(threading.get_ident())
            try:
                self.entered.set()
                if self.block and not self.release.wait(3):
                    raise RuntimeError('fixture_timeout')
                if self.fail_inference:
                    raise RuntimeError('fixture_inference_failed')
                time.sleep(0.05)
                output = BytesIO()
                with wave.open(output, 'wb') as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(24000)
                    wav.writeframes(b'\x00\x00' * 240)
                return output.getvalue()
            finally:
                with self.state_lock:
                    self.active -= 1

        return synthesize

    def start(self, max_pending=4):
        self.server = worker.create_voice_server(self.spec, self.model, self.factory, max_pending=max_pending)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def request(self, method='GET', path='/health', body=None):
        connection = HTTPConnection('127.0.0.1', self.port, timeout=3)
        try:
            payload = json.dumps(body).encode() if body is not None else None
            connection.request(method, path, payload, {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def speech_body(self, **overrides):
        return {'model': str(self.model), 'voice': str(self.model / self.spec['voiceFile']),
                'input': '你好，小织。', 'lang_code': 'z', 'speed': 1.0, **overrides}

    def tearDown(self):
        self.release.set()
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=3)
        self.temporary.cleanup()

    def test_idle_preopened_socket_does_not_block_health(self):
        self.start()
        sockets = []
        try:
            sockets = [socket.create_connection(('127.0.0.1', self.port), timeout=3) for _ in range(6)]
            began = time.monotonic()
            status, body = self.request()
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['profile'], 'loommate-sweet')
            self.assertLess(time.monotonic() - began, 1.5)
        finally:
            for connection in sockets:
                connection.close()
        self.assertEqual(self.request(path='/unknown')[0], 404)

    def test_factory_and_parallel_speech_use_one_fixed_inference_thread(self):
        self.start()
        with ThreadPoolExecutor(max_workers=3) as clients:
            futures = [clients.submit(self.request, 'POST', '/v1/audio/speech', self.speech_body(input='你好' + str(index))) for index in range(3)]
            for future in futures:
                status, audio = future.result(timeout=3)
                self.assertEqual(status, 200)
                with wave.open(BytesIO(audio)) as wav:
                    self.assertEqual(wav.getnframes(), 240)
        self.assertEqual(self.maximum_active, 1)
        self.assertEqual(self.call_threads, [self.factory_thread] * 3)

    def test_health_stays_responsive_during_inference_and_busy_queue_is_bounded(self):
        self.block = True
        self.start(max_pending=1)
        with ThreadPoolExecutor(max_workers=1) as client:
            first = client.submit(self.request, 'POST', '/v1/audio/speech', self.speech_body())
            self.assertTrue(self.entered.wait(2))
            self.assertEqual(self.request()[0], 200)
            status, body = self.request('POST', '/v1/audio/speech', self.speech_body(input='第二句'))
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(body)['error'], 'voice_busy')
            self.release.set()
            self.assertEqual(first.result(timeout=3)[0], 200)

    def test_invalid_body_assets_parameters_and_text_never_reach_model(self):
        self.start()
        bodies = [[], self.speech_body(model='/other/model'), self.speech_body(voice='/private/file'),
                  self.speech_body(input=' '), self.speech_body(input='甲' * 2001), self.speech_body(speed=2)]
        for body in bodies:
            self.assertEqual(self.request('POST', '/v1/audio/speech', body)[0], 400)
        self.assertEqual(self.request('POST', '/unknown', {})[0], 404)
        self.assertEqual(self.call_threads, [])

    def test_inference_failure_returns_structured_error_and_next_request_recovers(self):
        self.fail_inference = True
        self.start()
        status, body = self.request('POST', '/v1/audio/speech', self.speech_body())
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)['error'], 'voice_inference_failed')
        self.fail_inference = False
        self.assertEqual(self.request('POST', '/v1/audio/speech', self.speech_body())[0], 200)


if __name__ == '__main__':
    unittest.main()
