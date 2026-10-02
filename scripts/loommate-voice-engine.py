#!/usr/bin/env python3
"""Dedicated loopback Kokoro worker for the optional LoomMate voice pack."""
import argparse
from io import BytesIO
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import sys


def serve(station, spec_file):
    # This worker owns only the small female model. Keep the shared film/clone
    # engine unchanged and bound its Metal allocator cache on 8 GB machines.
    os.environ['HF_HUB_OFFLINE'] = '1'
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model
    mx.set_cache_limit(128 * 1024 * 1024)
    spec = json.loads(spec_file.read_text())
    installed = json.loads((station / 'loommate-voice.json').read_text())
    if installed.get('model') != spec['model'] or installed.get('revision') != spec['revision']:
        raise RuntimeError('Installed model does not match worker specification')
    model_path = Path(installed['modelPath']).resolve()
    voice_path = model_path / spec['voiceFile']
    if not voice_path.is_file():
        raise RuntimeError('Installed female voice file is missing')
    model = load_model(str(model_path), model_type='kokoro')

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            return  # Never log speech text or request headers.

        def reply(self, status, data, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            data = {'ok': True, 'profile': spec['profile'], 'voice': spec['voice'], 'revision': spec['revision']}
            self.reply(200 if self.path == '/health' else 404, json.dumps(data).encode())

        def do_POST(self):
            if self.path != '/v1/audio/speech':
                self.reply(404, b'{"error":"not_found"}')
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 1 or length > 16384:
                    raise ValueError('request_size')
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise ValueError('invalid_body')
                text = body.get('input')
                if not isinstance(text, str) or not text.strip() or len(text) > 2000:
                    raise ValueError('invalid_text')
                # The service never loads arbitrary client-supplied models/paths.
                if body.get('model') != str(model_path) or body.get('voice') != str(voice_path):
                    raise ValueError('invalid_voice_asset')
                if body.get('lang_code') != spec['language'] or body.get('speed') != spec['speed']:
                    raise ValueError('invalid_voice_parameters')
                chunks = [np.asarray(result.audio) for result in model.generate(
                    text, voice=str(voice_path), lang_code=spec['language'], speed=spec['speed'])]
                if not chunks:
                    raise RuntimeError('empty_audio')
                buffer = BytesIO()
                sf.write(buffer, np.concatenate(chunks), model.sample_rate, format='WAV', subtype='PCM_16')
                audio = buffer.getvalue()
                if len(audio) > 32 * 1024 * 1024:
                    raise RuntimeError('audio_size')
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

    server = HTTPServer(('127.0.0.1', spec['enginePort']), Handler)
    print('LoomMate voice worker ready on loopback port ' + str(spec['enginePort']), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station-dir', type=Path, required=True)
    parser.add_argument('--spec', type=Path, required=True)
    args = parser.parse_args()
    try:
        serve(args.station_dir.expanduser().resolve(), args.spec.expanduser().resolve())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print('LoomMate voice worker could not start: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
