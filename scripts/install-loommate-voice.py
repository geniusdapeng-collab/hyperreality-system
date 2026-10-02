#!/usr/bin/env python3
"""Add a pinned natural Mandarin female voice to the existing local MLX station."""
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
    version = dependency.split('==', 1)[1]
    code = 'import misaki.zh; import mlx_audio; import importlib.metadata as m; import sys; sys.exit(0 if m.version("misaki")==sys.argv[1] else 1)'
    check = subprocess.run([str(python), '-c', code, version], capture_output=True, timeout=60)
    if check.returncode == 0:
        return
    if offline:
        raise RuntimeError('Chinese voice processing dependency is missing; rerun without --offline')
    uv = shutil.which('uv')
    argv = [uv, 'pip', 'install', '--python', str(python), dependency] if uv else [str(python), '-m', 'pip', 'install', dependency]
    result = subprocess.run(argv, capture_output=True, timeout=600)
    if result.returncode:
        raise RuntimeError('Could not install the pinned Chinese processing dependency; install uv or pip and retry')


def activate_model(station, source, spec):
    # Old Kokoro metadata has no model_type. A stable, descriptive local folder lets
    # mlx-audio identify its architecture without altering upstream config/weights.
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
            'StandardOutPath': str(log), 'StandardErrorPath': str(log)}
    temporary = plist.with_suffix('.tmp')
    try:
        with temporary.open('wb') as stream:
            plistlib.dump(data, stream)
        os.chmod(temporary, 0o600)
        os.replace(temporary, plist)
    finally:
        temporary.unlink(missing_ok=True)
    domain = 'gui/' + str(os.getuid())
    probe = subprocess.run(['launchctl', 'print', domain + '/' + label], capture_output=True, timeout=15)
    if probe.returncode == 0:
        stopped = subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True, timeout=30)
        if stopped.returncode:
            raise RuntimeError('Could not stop the previous LoomMate worker; no other voice service was changed')
    result = subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], capture_output=True, timeout=30)
    if result.returncode:
        raise RuntimeError('Could not start the LoomMate launch agent; model is installed but worker activation failed')


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
        installed = json.loads(manifest.read_text())
        if installed.get('model') != spec['model'] or installed.get('revision') != spec['revision']:
            raise RuntimeError('Installed LoomMate model does not match the pinned model')
        model_path = Path(installed['modelPath'])
    else:
        if platform.system() != 'Darwin' or platform.machine() != 'arm64':
            raise RuntimeError('This MLX voice pack requires Apple Silicon macOS; existing clone/system fallback remains available elsewhere')
        run_dependency(python, spec['pythonDependency'], args.offline)
        code = ('from huggingface_hub import snapshot_download; import sys,json; '
                'print(snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], '
                'cache_dir=sys.argv[3], local_files_only=sys.argv[4]=="1",allow_patterns=json.loads(sys.argv[5])))')
        env = os.environ.copy()
        env['HF_HUB_DISABLE_XET'] = '1'
        result = subprocess.run([str(python), '-c', code, spec['model'], spec['revision'],
                                 str(station / 'models/hub'), '1' if args.offline else '0', json.dumps(spec['requiredFiles'])],
                                env=env, text=True, capture_output=True, timeout=1800)
        if result.returncode:
            raise RuntimeError('Pinned model download failed; check network/proxy or use --offline with a complete cached model')
        source = Path(result.stdout.strip().splitlines()[-1]).resolve()
        verify_weights(source, spec['weightsSha256'], spec['requiredFiles'])
        model_path = activate_model(station, source, spec)
    verify_weights(model_path, spec['weightsSha256'], spec['requiredFiles'])
    if not args.check:
        atomic_json(manifest, {'schema': spec['schema'], 'model': spec['model'],
                              'revision': spec['revision'], 'modelPath': str(model_path),
                              'profile': spec['profile'], 'voice': spec['voice'], 'license': spec['license']})
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
