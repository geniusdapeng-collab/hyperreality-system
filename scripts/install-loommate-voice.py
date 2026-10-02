#!/usr/bin/env python3
"""Add a pinned CPU Mandarin female voice to the existing local voice station."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

SPEC_FILE = Path(__file__).resolve().parents[1] / 'apps/server/src/voice/loommate-voice.json'


def verify_weights(model_path, expected, required=('config.json',)):
    for name, digest in expected.items():
        file = model_path / name
        if not file.is_file():
            raise RuntimeError('Missing model weight: ' + name)
        sha = hashlib.sha256()
        with file.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                sha.update(block)
        if sha.hexdigest() != digest:
            raise RuntimeError('Model checksum mismatch: ' + name)
    for name in required:
        if not (model_path / name).is_file():
            raise RuntimeError('Missing model configuration: ' + name)


def require_station(station):
    token = station / 'bridge-token'
    stat = token.lstat()
    if token.is_symlink() or not token.is_file() or stat.st_mode & 0o077 or stat.st_uid != os.getuid():
        raise RuntimeError('bridge-token must be a regular file owned by this user with mode 0600')
    if not token.read_text().strip():
        raise RuntimeError('Existing voice station has an empty bridge-token')
    python = station / 'venv/bin/python'
    if not python.is_file():
        raise RuntimeError('Install the existing voice station before adding LoomMate voice')
    return python


def atomic_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=file.parent, delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run_dependency(python, dependency, offline):
    package = dependency.split('==', 1)[0].split('[', 1)[0]
    version = dependency.split('==', 1)[1]
    module = 'misaki.zh' if package == 'misaki' else package
    code = 'import importlib.util as u,importlib.metadata as m,sys; sys.exit(0 if u.find_spec(sys.argv[1]) and m.version(sys.argv[2])==sys.argv[3] else 1)'
    env = {**os.environ, 'ORT_DISABLE_TELEMETRY': '1'}
    check = subprocess.run([str(python), '-c', code, module, package, version], env=env, capture_output=True, timeout=60)
    if check.returncode == 0:
        return
    if offline:
        raise RuntimeError('Chinese voice processing dependency is missing; rerun without --offline')
    uv = shutil.which('uv')
    argv = [uv, 'pip', 'install', '--python', str(python), dependency] if uv else [str(python), '-m', 'pip', 'install', dependency]
    result = subprocess.run(argv, env=env, capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError('Could not install the pinned Chinese processing dependency; install uv or pip and retry')


def download_asset(file, url, digest, offline):
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.exists():
        verify_weights(file.parent, {file.name: digest}, required=())
        return
    if offline:
        raise RuntimeError('Pinned voice asset is not cached: ' + file.name)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as output:
            temporary = Path(output.name)
            sha = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(url, timeout=60) as response:
                while block := response.read(1024 * 1024):
                    size += len(block)
                    if size > 400 * 1024 * 1024:
                        raise RuntimeError('Voice asset exceeds its download size limit')
                    sha.update(block)
                    output.write(block)
        if sha.hexdigest() != digest:
            raise RuntimeError('Downloaded voice asset checksum mismatch: ' + file.name)
        os.chmod(temporary, 0o600)
        os.replace(temporary, file)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def prepare_model(station, python, spec, offline):
    source = station / 'models/loommate-download' / ('kokoro-onnx-' + spec['revision'][:12])
    for name, digest in spec['weightsSha256'].items():
        download_asset(source / name, spec['weightsUrls'][name], digest, offline)
    config = source / 'config.json'
    if not config.exists():
        # The exported graph carries its exact vocabulary; never guess from a
        # different Kokoro revision or fetch a second unpinned configuration.
        code = ('import onnxruntime as o,json,sys; o.disable_telemetry_events(); '
                'opt=o.SessionOptions(); opt.intra_op_num_threads=2; opt.inter_op_num_threads=1; '
                's=o.InferenceSession(sys.argv[1],sess_options=opt,providers=["CPUExecutionProvider"]); '
                'print(s.get_modelmeta().custom_metadata_map["kokoro_config"])')
        result = subprocess.run([str(python), '-c', code, str(source / spec['modelFile'])],
                                env={**os.environ, 'ORT_DISABLE_TELEMETRY': '1'}, text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError('Could not read the fixed voice model vocabulary')
        configuration = json.loads(result.stdout)
        if not isinstance(configuration.get('vocab'), dict) or not configuration['vocab']:
            raise RuntimeError('Fixed voice model vocabulary is invalid')
        atomic_json(config, configuration)
    verify_weights(source, spec['weightsSha256'], spec['requiredFiles'])
    return activate_model(station, source, spec)


def activate_model(station, source, spec):
    # Keep immutable downloaded assets separate from the active local manifest.
    target = station / 'models/loommate' / ('kokoro-82m-' + spec['revision'][:12])
    target.mkdir(parents=True, exist_ok=True)
    for name in spec['requiredFiles']:
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        origin = (source / name).resolve()
        if dest.is_symlink() and dest.resolve() == origin:
            continue
        if dest.exists() or dest.is_symlink():
            raise RuntimeError('Refusing to overwrite an existing local voice asset: ' + name)
        dest.symlink_to(origin)
    return target


def wait_worker(spec, timeout_seconds=90):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        try:
            with opener.open('http://127.0.0.1:' + str(spec['enginePort']) + '/health', timeout=3) as response:
                data = json.loads(response.read())
                if response.status == 200 and data.get('revision') == spec['revision'] and data.get('voice') == spec['voice']:
                    return
        except (OSError, ValueError):
            pass  # Startup is bounded and a persistent failure remains fatal.
        time.sleep(1)
    raise RuntimeError('LoomMate model worker did not become ready within its startup budget')


def bootstrap_worker(domain, plist):
    # A just-unloaded launch agent may reject its first bootstrap. Retry only
    # this exact job, with a fixed bound; persistent activation errors stay fatal.
    for attempt in range(5):
        result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True, timeout=30)
        if result.returncode == 0:
            return
        if attempt < 4:
            time.sleep(min(4, 2 ** attempt))
    raise RuntimeError('Could not start the LoomMate launch agent; model is installed but worker activation failed')


def start_worker(domain, plist, label, same_arguments):
    target = domain + '/' + label
    probe = subprocess.run(['launchctl', 'print', target], capture_output=True, timeout=15)
    if probe.returncode == 0:
        if same_arguments:
            restarted = subprocess.run(['launchctl', 'kickstart', '-k', target], capture_output=True, timeout=30)
            if restarted.returncode:
                raise RuntimeError('Could not restart the existing LoomMate worker')
            return
        stopped = subprocess.run(['launchctl', 'bootout', target], capture_output=True, timeout=30)
        if stopped.returncode:
            raise RuntimeError('Could not stop the previous LoomMate worker; no other voice service was changed')
    bootstrap_worker(domain, plist)


def install_worker(station, python, spec):
    runtime = station / 'loommate-runtime'
    runtime.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).with_name('loommate-voice-engine.py')
    worker = runtime / source.name
    temporary = worker.with_suffix('.tmp')
    try:
        shutil.copyfile(source, temporary)
        os.chmod(temporary, 0o600)
        os.replace(temporary, worker)
    finally:
        temporary.unlink(missing_ok=True)
    local_spec = runtime / 'loommate-voice.json'
    atomic_json(local_spec, spec)
    label = 'cool.workloom.loommate-voice-engine'
    log = station / 'logs/loommate-engine.log'
    log.parent.mkdir(parents=True, exist_ok=True)
    plist = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    plist.parent.mkdir(parents=True, exist_ok=True)
    data = {'Label': label, 'ProgramArguments': [str(python), str(worker), '--station-dir', str(station), '--spec', str(local_spec)],
            'RunAtLoad': True, 'KeepAlive': False, 'WorkingDirectory': str(station),
            'ProcessType': 'Interactive',
            'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
    previous = plistlib.loads(plist.read_bytes()) if plist.exists() else {}
    same_arguments = previous.get('ProgramArguments') == data['ProgramArguments'] and previous.get('ProcessType') == data['ProcessType']
    temporary = plist.with_suffix('.tmp')
    try:
        with temporary.open('wb') as stream:
            plistlib.dump(data, stream)
        os.chmod(temporary, 0o600)
        os.replace(temporary, plist)
    finally:
        temporary.unlink(missing_ok=True)
    domain = 'gui/' + str(os.getuid())
    start_worker(domain, plist, label, same_arguments)
    wait_worker(spec)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--station-dir', type=Path, default=Path.home() / '.workloom/voice-station')
    parser.add_argument('--offline', action='store_true', help='Use already downloaded weights and dependencies only')
    parser.add_argument('--skip-worker', action='store_true', help='Install assets without starting the optional local worker')
    parser.add_argument('--check', action='store_true', help='Verify the installed manifest and model without changes')
    args = parser.parse_args(argv)
    station = args.station_dir.expanduser().resolve()
    spec = json.loads(SPEC_FILE.read_text())
    python = require_station(station)
    code = 'import importlib.metadata as m; print(m.version("mlx-audio"))'
    runtime = subprocess.run([str(python), '-c', code], text=True, capture_output=True, timeout=30)
    if runtime.returncode or runtime.stdout.strip() != spec['mlxAudioVersion']:
        raise RuntimeError('Existing station needs tested mlx-audio==' + spec['mlxAudioVersion'] + '; its shared environment was not upgraded')
    manifest = station / 'loommate-voice.json'
    if args.check:
        run_dependency(python, spec['pythonDependency'], True)
        run_dependency(python, spec['runtimeDependency'], True)
        installed = json.loads(manifest.read_text())
        if installed.get('model') != spec['model'] or installed.get('revision') != spec['revision']:
            raise RuntimeError('Installed LoomMate model does not match the pinned model')
        model_path = Path(installed['modelPath'])
    else:
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise RuntimeError('This installer is verified on Apple Silicon macOS; existing clone/system fallback remains available elsewhere')
        run_dependency(python, spec['pythonDependency'], args.offline)
        run_dependency(python, spec['runtimeDependency'], args.offline)
        model_path = prepare_model(station, python, spec, args.offline)
    verify_weights(model_path, spec['weightsSha256'], spec['requiredFiles'])
    if not args.check:
        atomic_json(manifest, {'schema': spec['schema'], 'model': spec['model'],
                              'revision': spec['revision'], 'modelPath': str(model_path),
                              'profile': spec['profile'], 'voice': spec['voice'], 'license': spec['license'], 'backend': spec['backend']})
        if not args.skip_worker:
            install_worker(station, python, spec)
    print(json.dumps({'ok': True, 'profile': spec['profile'], 'voice': spec['voice'], 'revision': spec['revision'],
                      'modelPath': str(model_path), 'checked': args.check}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired) as error:
        print('LoomMate voice installation failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
