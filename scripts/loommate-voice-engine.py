#!/usr/bin/env python3
"""Dedicated loopback CPU Kokoro worker for the optional LoomMate voice pack."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import signal
import struct
import subprocess
import sys
from threading import BoundedSemaphore, Lock, Thread
import time

MAX_AUDIO_BYTES = 32 * 1024 * 1024


def phoneme_batches(phonemes, vocab):
    tokens = [vocab[character] for character in phonemes if character in vocab]
    if not tokens:
        raise RuntimeError('text_has_no_supported_phonemes')
    return [tokens[start:start + 510] for start in range(0, len(tokens), 510)]


class ProcessSynthesizer:
    """One persistent model process; model operations stay on its main thread."""
    def __init__(self, argv, startup_timeout=90, request_timeout=30):
        self.argv = argv
        self.startup_timeout = startup_timeout
        self.request_timeout = request_timeout
        self.process = None
        self.closed = False
        self.stop_lock = Lock()
        self.start()

    def receive(self, timeout):
        deadline = time.monotonic() + timeout

        def read_exact(size):
            data = bytearray()
            while len(data) < size:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([self.process.stdout], [], [], max(0, remaining))[0]:
                    raise TimeoutError('voice_model_deadline')
                block = os.read(self.process.stdout.fileno(), min(size - len(data), 1024 * 1024))
                if not block:
                    raise RuntimeError('voice_model_exited')
                data.extend(block)
            return bytes(data)

        length = struct.unpack('!I', read_exact(4))[0]
        if length < 1 or length > MAX_AUDIO_BYTES + 1:
            raise RuntimeError('invalid_model_frame')
        frame = read_exact(length)
        if frame[0] != 0:
            raise RuntimeError('voice_model_failed')
        return frame[1:]

    def stop_process(self):
        with self.stop_lock:
            process = self.process
            if process is None:
                return
            try:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
                self.process = None
            finally:
                process.stdin.close()
                process.stdout.close()

    def start(self):
        if self.closed:
            raise RuntimeError('voice_worker_closed')
        self.process = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        try:
            if self.receive(self.startup_timeout) != b'ready':
                raise RuntimeError('invalid_model_ready_frame')
        except BaseException:
            self.stop_process()
            raise

    def __call__(self, text):
        if self.closed:
            raise RuntimeError('voice_worker_closed')
        if self.process is not None and self.process.poll() is not None:
            self.stop_process()
        if self.process is None:
            self.start()
        try:
            if self.process.stdin.closed:
                raise RuntimeError('voice_model_termination_pending')
            payload = (json.dumps({'input': text}, ensure_ascii=False) + '\n').encode()
            offset = 0
            while offset < len(payload):
                written = self.process.stdin.write(payload[offset:])
                if not written:
                    raise RuntimeError('voice_model_pipe_closed')
                offset += written
            return self.receive(self.request_timeout)
        except BaseException:
            self.stop_process()
            raise

    def close(self):
        self.closed = True
        self.stop_process()


def load_synthesizer(model_path, spec):
    # Keep this before importing ONNX Runtime: full lifetime network suppression.
    os.environ['ORT_DISABLE_TELEMETRY'] = '1'
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from misaki.zh import ZHG2P
    ort.disable_telemetry_events()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    model = ort.InferenceSession(str(model_path / spec['modelFile']), sess_options=options,
                                 providers=['CPUExecutionProvider'])
    configuration = model.get_modelmeta().custom_metadata_map.get('kokoro_config')
    if not configuration:
        raise RuntimeError('model_vocabulary_missing')
    vocab = json.loads(configuration)['vocab']
    if not isinstance(vocab, dict) or not vocab:
        raise RuntimeError('model_vocabulary_invalid')
    voice_path = model_path / spec['voiceFile']
    with np.load(voice_path, allow_pickle=False) as voices:
        voice = np.asarray(voices[spec['voice']], dtype=np.float32)
    if voice.ndim != 3 or voice.shape[1:] != (1, 256) or voice.shape[0] < 1:
        raise RuntimeError('female_voice_shape_invalid')
    g2p = ZHG2P()

    def synthesize(text):
        phonemes, _ = g2p(text)
        chunks = []
        # Preserve every token if a direct HTTP client sends a longer sentence.
        # Normal callers already segment to 80 Unicode characters server-side.
        for batch in phoneme_batches(phonemes, vocab):
            audio = model.run(None, {
                'input_ids': np.asarray([[0, *batch, 0]], dtype=np.int64),
                'style': voice[min(len(batch), len(voice)) - 1],
                'speed': np.asarray([spec['speed']], dtype=np.float32),
            })[0].reshape(-1)
            if not len(audio) or not np.isfinite(audio).all():
                raise RuntimeError('model_audio_invalid')
            chunks.append(audio)
        if not chunks:
            raise RuntimeError('empty_audio')
        buffer = BytesIO()
        sf.write(buffer, np.concatenate(chunks), 24000, format='WAV', subtype='PCM_16')
        audio = buffer.getvalue()
        if len(audio) > MAX_AUDIO_BYTES:
            raise RuntimeError('audio_size')
        return audio

    return synthesize


def create_voice_server(spec, model_path, synthesizer_factory, max_pending=4):
    """Handle idle sockets independently while serializing bounded model work."""
    inference = ThreadPoolExecutor(max_workers=1, thread_name_prefix='loommate-inference')
    pending = BoundedSemaphore(max_pending)
    voice_path = model_path / spec['voiceFile']
    try:
        synthesize = inference.submit(synthesizer_factory).result()
    except BaseException:
        inference.shutdown(wait=True, cancel_futures=True)
        raise

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return  # Never log speech text or request headers.

        def reply(self, status, data, content_type='application/json'):
            self.close_connection = True
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            data = {'ok': True, 'profile': spec['profile'], 'voice': spec['voice'], 'revision': spec['revision']}
            try:
                self.reply(200 if self.path == '/health' else 404, json.dumps(data).encode())
            except (BrokenPipeError, ConnectionResetError):
                return  # Health clients may cancel; there is no partial audio.

        def do_POST(self):
            try:
                if self.path != '/v1/audio/speech':
                    self.reply(404, b'{"error":"not_found"}')
                    return
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 16384:
                    raise ValueError('request_size')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('invalid_body')
                text = body.get('input')
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError('invalid_text')
                if body.get('model') != str(model_path) or body.get('voice') != str(voice_path):
                    raise ValueError('invalid_voice_asset')
                if body.get('lang_code') != spec['language'] or body.get('speed') != spec['speed']:
                    raise ValueError('invalid_voice_parameters')
                if not pending.acquire(blocking=False):
                    self.reply(503, b'{"error":"voice_busy"}')
                    return
                try:
                    audio = inference.submit(synthesize, text).result()
                finally:
                    pending.release()
                if not isinstance(audio, bytes) or not audio or len(audio) > 32 * 1024 * 1024:
                    raise RuntimeError('invalid_audio_output')
                self.reply(200, audio, 'audio/wav')
            except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                self.reply(400, b'{"error":"invalid_voice_request"}')
            except (BrokenPipeError, ConnectionResetError):
                return  # The client cancelled; no partial audio is published.
            except Exception as error:
                print('LoomMate inference failed: ' + type(error).__name__, file=sys.stderr, flush=True)
                try:
                    self.reply(503, b'{"error":"voice_inference_failed"}')
                except (BrokenPipeError, ConnectionResetError):
                    return

        def setup(self):
            super().setup()
            self.connection.settimeout(30)

    class VoiceServer(ThreadingHTTPServer):
        daemon_threads = True
        # Browser pools can pre-open more than TCPServer's default backlog of 5.
        request_queue_size = 32

        def server_close(self):
            super().server_close()
            if hasattr(synthesize, 'close'):
                synthesize.close()
            inference.shutdown(wait=True, cancel_futures=True)

        def handle_error(self, request, client_address):
            error_type = sys.exc_info()[0]
            if error_type and issubclass(error_type, (BrokenPipeError, ConnectionResetError, TimeoutError)):
                print('LoomMate client connection ended: ' + error_type.__name__, file=sys.stderr, flush=True)
                return
            super().handle_error(request, client_address)

    try:
        return VoiceServer(('127.0.0.1', spec['enginePort']), Handler)
    except BaseException:
        if hasattr(synthesize, 'close'):
            synthesize.close()
        inference.shutdown(wait=True, cancel_futures=True)
        raise


def read_installed(station, spec_file):
    spec = json.loads(spec_file.read_text())
    installed = json.loads((station / 'loommate-voice.json').read_text())
    if installed.get('model') != spec['model'] or installed.get('revision') != spec['revision']:
        raise RuntimeError('Installed model does not match worker specification')
    model_path = Path(installed['modelPath']).resolve()
    if not (model_path / spec['voiceFile']).is_file():
        raise RuntimeError('Installed female voice file is missing')
    return spec, model_path


def inference_child(station, spec_file):
    parent = os.getppid()

    def watch_parent():
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                os._exit(0)  # A killed supervisor must not leave a resident model.

    Thread(target=watch_parent, daemon=True).start()
    output = sys.stdout.buffer

    def send(ok, data):
        frame = bytes([0 if ok else 1]) + data
        output.write(struct.pack('!I', len(frame)) + frame)
        output.flush()

    # Libraries may print diagnostics; keep the binary IPC stream separate.
    with redirect_stdout(sys.stderr):
        spec, model_path = read_installed(station, spec_file)
        synthesize = load_synthesizer(model_path, spec)
        send(True, b'ready')
        for line in sys.stdin.buffer:
            try:
                body = json.loads(line)
                text = body['input']
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError('invalid_text')
                send(True, synthesize(text))
            except Exception as error:
                print('LoomMate model failed: ' + type(error).__name__, file=sys.stderr, flush=True)
                send(False, type(error).__name__.encode('ascii'))


def serve(station, spec_file):
    spec, model_path = read_installed(station, spec_file)
    argv = [sys.executable, str(Path(__file__).resolve()), '--inference-child', '--station-dir', str(station), '--spec', str(spec_file)]
    server = create_voice_server(spec, model_path, lambda: ProcessSynthesizer(argv))
    print('LoomMate voice worker ready on loopback port ' + str(spec['enginePort']), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station-dir', type=Path, required=True)
    parser.add_argument('--spec', type=Path, required=True)
    parser.add_argument('--inference-child', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        station, spec_file = args.station_dir.expanduser().resolve(), args.spec.expanduser().resolve()
        if args.inference_child:
            inference_child(station, spec_file)
        else:
            def terminate(_signal, _frame):
                raise SystemExit(0)
            signal.signal(signal.SIGTERM, terminate)
            serve(station, spec_file)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print('LoomMate voice worker could not start: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
