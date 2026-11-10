"""Download catalog-listed public game artwork with standard-library Python.

No game account or private cache is read. Existing valid files are reused.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import re
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
ASSET_PATH = re.compile(r'^/assets/hbr/(card|chara_icon)/[A-Za-z0-9_.-]+\.webp$')
SOURCE_URL = re.compile(r'^https://cdn\.hbr\.quest/webp/jp/(card|chara_icon)/[A-Za-z0-9_.-]+\.webp$')


def catalog_assets(catalog: dict) -> list[dict]:
    assets = {}
    for item in [*catalog['characters'], *catalog['styles']]:
        for key in ('portrait', 'artwork'):
            asset = item.get(key)
            if not asset:
                continue
            path, url = asset.get('path', ''), asset.get('sourceUrl', '')
            if not ASSET_PATH.fullmatch(path) or not SOURCE_URL.fullmatch(url):
                raise ValueError('Unexpected public image path/source')
            if url.removeprefix('https://cdn.hbr.quest/webp/jp/') != path.removeprefix('/assets/hbr/'):
                raise ValueError('Public image path and source do not agree')
            assets[path] = {'path': path, 'sourceUrl': url}
    return [assets[key] for key in sorted(assets)]


def image_info(data: bytes) -> dict:
    if len(data) < 20 or data[:4] != b'RIFF' or data[8:12] != b'WEBP':
        raise ValueError('Response is not a WebP image')
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def destination(root: Path, asset: dict) -> Path:
    path = root / 'public' / asset['path'].lstrip('/')
    allowed = (root / 'public' / 'assets' / 'hbr').resolve()
    if not path.resolve().is_relative_to(allowed) or any(p.is_symlink() for p in (path, *path.parents) if p != root and p.is_relative_to(root)):
        raise ValueError('Image destination must remain inside public/assets/hbr without links')
    return path


def fetch_image(root: Path, asset: dict, expected: dict | None = None) -> dict:
    path = destination(root, asset)
    if path.exists():
        info = image_info(path.read_bytes())
        if expected and expected.get('sha256') and info['sha256'] != expected['sha256']:
            raise ValueError('Existing image differs from its source manifest; preserved for review')
        return {**asset, **info, 'status': 'cached'}
    request = urllib.request.Request(asset['sourceUrl'], headers={'User-Agent': 'HBR-Planner/0.11 (public artwork cache)'})
    with urllib.request.urlopen(request, timeout=45) as response:
        if not SOURCE_URL.fullmatch(response.url):
            raise ValueError('Image download redirected outside the public image CDN')
        data = response.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise ValueError('Image exceeded the download size limit')
    info = image_info(data)
    if expected and expected.get('sha256') and info['sha256'] != expected['sha256']:
        raise ValueError('Downloaded image differs from its source manifest')
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive destination creation never replaces an existing user file.
    created = False
    try:
        with path.open('xb') as handle:
            created = True
            handle.write(data)
    except FileExistsError:
        actual = image_info(path.read_bytes())
        if actual['sha256'] != info['sha256']:
            raise ValueError('An image was added concurrently; preserved for review')
    except BaseException:
        if created:
            path.unlink(missing_ok=True)
        raise
    return {**asset, **info, 'status': 'downloaded'}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--dry-run', action='store_true', help='Validate and count public image references without network access')
    args = parser.parse_args(argv)
    catalog = json.loads((ROOT / 'public/data/catalog.json').read_text(encoding='utf-8-sig'))
    assets = catalog_assets(catalog)
    for asset in assets:
        destination(ROOT, asset)
    if args.dry_run:
        print(json.dumps({'images': len(assets), 'networkRequests': 0}))
        return 0
    manifest_path = ROOT / 'public/data/image-manifest.json'
    old = json.loads(manifest_path.read_text(encoding='utf-8-sig')) if manifest_path.exists() else {}
    expected = {x['path']: x for x in old.get('assets', [])}
    def run(asset):
        try:
            return fetch_image(ROOT, asset, expected.get(asset['path']))
        except Exception as exc:
            # Do not save local exception paths in public metadata.
            return {**asset, 'status': 'failed', 'errorType': type(exc).__name__}
    with ThreadPoolExecutor(max_workers=max(1, min(16, args.workers))) as pool:
        results = list(pool.map(run, assets))
    failed = [x for x in results if x['status'] == 'failed']
    counts = {status: sum(x['status'] == status for x in results) for status in ('downloaded', 'cached', 'failed')}
    if not failed:
        output = {'catalogVersion': catalog['version'], 'source': 'hbr.quest public image CDN', 'assets': results}
        temporary = manifest_path.with_name(manifest_path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temporary.replace(manifest_path)
        finally:
            temporary.unlink(missing_ok=True)
    print(json.dumps({'images': len(assets), **counts}))
    for row in failed:
        print(row['path'] + ': ' + row['errorType'])
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
