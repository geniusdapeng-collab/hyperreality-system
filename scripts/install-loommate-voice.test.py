import hashlib
import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('installer', Path(__file__).with_name('install-loommate-voice.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def test_atomic_manifest_contains_no_token(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'loommate-voice.json'
            installer.atomic_json(file, {'profile': 'loommate-sweet'})
            self.assertEqual(json.loads(file.read_text()), {'profile': 'loommate-sweet'})
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_checksum_detects_missing_and_corrupt_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            digest = hashlib.sha256(b'valid').hexdigest()
            with self.assertRaisesRegex(RuntimeError, 'Missing'):
                installer.verify_weights(root, {'weight': digest})
            (root / 'weight').write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                installer.verify_weights(root, {'weight': digest})
            (root / 'weight').write_bytes(b'valid')
            for name in ['config.json', 'vocab.json', 'merges.txt', 'tokenizer_config.json', 'speech_tokenizer/config.json']:
                p = root / name
                p.parent.mkdir(exist_ok=True)
                p.write_text('{}')
            installer.verify_weights(root, {'weight': digest})

    def test_station_rejects_world_readable_token_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            token = root / 'bridge-token'
            token.write_text('test-only')
            token.chmod(0o644)
            with self.assertRaisesRegex(RuntimeError, '0600'):
                installer.require_station(root)
            token.chmod(0o600)
            python = root / 'venv/bin/python'
            python.parent.mkdir(parents=True)
            python.touch()
            self.assertEqual(installer.require_station(root), python)
            token.rename(root / 'source')
            token.symlink_to(root / 'source')
            with self.assertRaisesRegex(RuntimeError, '0600'):
                installer.require_station(root)


    def test_model_activation_is_idempotent_and_rejects_existing_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            station = Path(folder) / 'station'
            source = Path(folder) / 'download'
            source.mkdir()
            ((source / 'config.json').resolve()).write_text('{}')
            configuration = {'revision': 'abc123', 'requiredFiles': ['config.json']}
            model = installer.activate_model(station, source, configuration)
            self.assertEqual((model / 'config.json').resolve(), (source / 'config.json').resolve())
            self.assertEqual(installer.activate_model(station, source, configuration), model)
            (model / 'config.json').unlink()
            (model / 'config.json').write_text('user-file')
            with self.assertRaisesRegex(RuntimeError, 'Refusing to overwrite'):
                installer.activate_model(station, source, configuration)
            self.assertEqual((model / 'config.json').read_text(), 'user-file')

    def test_empty_station_token_and_offline_missing_dependency_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            station = Path(folder)
            token = station / 'bridge-token'
            token.write_text(' ')
            token.chmod(0o600)
            with self.assertRaisesRegex(RuntimeError, 'empty'):
                installer.require_station(station)
        with patch.object(installer.subprocess, 'run') as run:
            run.return_value.returncode = 1
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                installer.run_dependency(Path('/test/python'), 'misaki[zh]==0.9.4', True)
            self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()
