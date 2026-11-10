"""Public release invariants, using synthetic state and isolated directories."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('hbr_package_release', ROOT / 'scripts/package_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
import download_images
import release_support


class ReleaseTests(unittest.TestCase):
    def test_source_is_clean_standalone_and_keeps_private_files_out(self):
        with tempfile.TemporaryDirectory(prefix='hbr-public-') as temporary:
            output = Path(temporary) / 'source'
            release.build_tree(ROOT, output)
            names = {p.relative_to(output).as_posix() for p in output.rglob('*') if p.is_file()}
            self.assertIn('public/sim/optimizer.mjs', names)
            self.assertIn('public/planner-results.mjs', names)
            self.assertIn('* -text', (output / '.gitattributes').read_text())
            self.assertNotIn('AGENTS.md', names)
            self.assertNotIn('STATUS.md', names)
            self.assertNotIn('server.mjs', names)
            self.assertFalse(any(name.startswith(('work/', 'status/', 'agent_records/', 'public/assets/hbr/')) for name in names))
            self.assertEqual((output / 'public/hbr-icon.png').read_bytes(), release.generic_png(256, (196, 85, 63)))
            metadata = json.loads((output / 'public/data/image-manifest.json').read_text(encoding='utf-8'))
            self.assertTrue(all(row['status'] == 'not-bundled' for row in metadata['assets']))
            code = '''
import json, pathlib, sys, urllib.request
sys.path.insert(0, sys.argv[1])
import hbr_app
app = hbr_app.build_app(pathlib.Path(sys.argv[2]), port=0)
try:
    url = app.start()
    with urllib.request.urlopen(url, timeout=5) as response:
        assert b'HBR' in response.read()
    req = urllib.request.Request(url + 'api/archive', headers={'X-WB-Token': app.token})
    with urllib.request.urlopen(req, timeout=5) as response:
        assert json.load(response)['archive'] is None
    with urllib.request.urlopen(url + 'data/catalog.json', timeout=5) as response:
        assert len(json.load(response)['styles']) > 100
    with urllib.request.urlopen(url + '_shared/fuuko.css', timeout=5) as response:
        assert response.status == 200
finally:
    app.stop()
'''
            done = subprocess.run([sys.executable, '-I', '-B', '-c', code, str(output), str(Path(temporary) / 'data')],
                                  capture_output=True, text=True, timeout=30,
                                  creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def test_release_refuses_overwrite_and_user_edits(self):
        with tempfile.TemporaryDirectory(prefix='hbr-public-') as temporary:
            output = Path(temporary) / 'source'
            release.build_tree(ROOT, output)
            with self.assertRaises(FileExistsError):
                release.build_tree(ROOT, output)
            release.build_tree(ROOT, output, refresh=True)
            path = output / 'README.md'
            path.write_text('keep my edit', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'user edits'):
                release.build_tree(ROOT, output, refresh=True)
            self.assertEqual(path.read_text(), 'keep my edit')

    def test_private_content_scan_fails_closed_without_echoing_value(self):
        sample = ('-----BEGIN ' + 'PRIVATE KEY-----').encode()
        issues = release_support.audit({'public/example.txt': sample})
        self.assertEqual(issues, ['public/example.txt: private key'])

    def test_only_public_catalog_image_paths_are_accepted(self):
        for path, source in [('/assets/hbr/../../private.webp', 'https://cdn.hbr.quest/webp/jp/card/x.webp'),
                             ('/assets/hbr/card/x.webp', 'https://example.com/x.webp')]:
            with self.assertRaises(ValueError):
                download_images.catalog_assets({'characters': [], 'styles': [{'portrait': {'path': path, 'sourceUrl': source}}]})

    def test_existing_images_are_not_overwritten_on_hash_mismatch(self):
        with tempfile.TemporaryDirectory(prefix='hbr-image-') as temporary:
            root = Path(temporary)
            asset = {'path': '/assets/hbr/card/x.webp', 'sourceUrl': 'https://cdn.hbr.quest/webp/jp/card/x.webp'}
            path = root / 'public/assets/hbr/card/x.webp'
            path.parent.mkdir(parents=True)
            sample = b'RIFF' + b'\x00' * 4 + b'WEBP' + b'\x00' * 20
            path.write_bytes(sample)
            with patch.object(download_images.urllib.request, 'urlopen') as download:
                with self.assertRaisesRegex(ValueError, 'preserved'):
                    download_images.fetch_image(root, asset, {'sha256': '0' * 64})
                download.assert_not_called()
            self.assertEqual(path.read_bytes(), sample)

    def test_public_export_does_not_pick_a_sibling_legacy_archive(self):
        import hbr_app
        with tempfile.TemporaryDirectory(prefix='hbr-portable-') as temporary:
            root = Path(temporary)
            exported, legacy = root / 'export', root / 'legacy'
            exported.mkdir(); legacy.mkdir()
            (exported / 'SOURCE-MANIFEST.json').write_text('{}')
            with patch.object(hbr_app, 'HERE', exported), patch.object(hbr_app, 'LEGACY_DATA_DIR', legacy), \
                    patch.dict(os.environ, {'LOCALAPPDATA': str(root / 'local')}):
                old = os.environ.pop('HBR_DATA_DIR', None)
                try:
                    self.assertEqual(hbr_app.data_dir(), root / 'local/FuukoWorkbenches/hbr')
                    (exported / 'SOURCE-MANIFEST.json').unlink()
                    self.assertEqual(hbr_app.data_dir(), legacy)
                finally:
                    if old is not None:
                        os.environ['HBR_DATA_DIR'] = old


if __name__ == '__main__':
    unittest.main()
