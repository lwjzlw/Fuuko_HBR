"""Export an allowlisted, privacy-checked HBR source tree or deterministic ZIP."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_support import export_tree, generic_ico, generic_png, read_sources, with_manifest
from download_images import catalog_assets, image_info

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = (
    '.gitignore', '.gitattributes', 'README.md', 'NOTICE.md', 'hbr_app.py', 'hbr_cache.py', 'hbr_enemy_parameters.py',
    'workbench.json', 'package.json', '启动研究室.vbs', 'Update-Catalog.ps1', 'Update-Images.ps1',
)
PUBLIC_MODULES = (
    'app.mjs', 'boss-model.mjs', 'boss-ui.mjs', 'box-ui.mjs', 'box.mjs', 'cache-sync.mjs',
    'catalog-images.mjs', 'catalog-ui.mjs', 'catalog.mjs', 'designer-ui.mjs', 'equipment.mjs',
    'legacy-storage.mjs', 'persist.mjs', 'planner-axis.mjs', 'planner-ui.mjs', 'planner-results.mjs', 'planner-loadout.mjs', 'planner-gear.mjs',
    'progress.mjs', 'soul.mjs', 'storage-v2.mjs', 'storage.mjs', 'team-verification.mjs', 'planner-enemies.mjs',
    'index.html', 'theme.js', 'style.css', 'catalog.css', 'image-placeholder.svg',
    'sim/cards.mjs', 'sim/axis-repair.mjs', 'sim/axis-neighborhood.mjs', 'sim/loadout-neighborhood.mjs', 'sim/long-search.mjs', 'sim/search-checkpoint.mjs', 'sim/designer.mjs', 'sim/expr.mjs', 'sim/optimizer-sub.mjs',
    'sim/optimizer-worker.mjs', 'sim/optimizer.mjs', 'sim/optimizer-options.mjs', 'sim/party.mjs', 'sim/search.mjs', 'sim/team-seeds.mjs', 'sim/worker.mjs',
    'sim/hbr/battle.mjs', 'sim/hbr/damage.mjs', 'sim/hbr/deck.mjs', 'sim/hbr/effects.mjs',
    'sim/hbr/model.mjs', 'sim/hbr/rules.mjs', 'sim/hbr/stats.mjs',
)
SCRIPTS = (
    'build-bosses.py', 'build-catalog.mjs', 'build-equipment.mjs', 'build-skills.py',
    'build-stats.py', 'build-wave-parameters.py', 'followup-hits.json', 'package_release.py', 'release_support.py', 'download_images.py',
)
TESTS = (
    'automatic-skills.test.mjs', 'planner-skill-branches.test.mjs', 'special-status.test.mjs', 'long-search.test.mjs', 'axis-neighborhood.test.mjs', 'loadout-neighborhood.test.mjs',
    'boss-model.test.mjs', 'box.test.mjs', 'cache-sync.test.mjs', 'catalog.test.mjs',
    'search-axis.test.mjs', 'team-seeds.test.mjs', 'planner-known-party.test.mjs', 'equipment.test.mjs', 'planner.test.mjs', 'planner-results.test.mjs', 'planner-display.test.mjs', 'progress.test.mjs', 'storage.test.mjs',
    'test_build_bosses.py', 'test_build_skills.py', 'test_build_stats.py', 'test_hbr_app.py',
    'test_hbr_cache.py', 'test_wave_parameters.py', 'test_release.py', 'optimizer.test.mjs', 'optimizer-stability.test.mjs', 'monte-carlo.test.mjs', 'planner-enemies.test.mjs', 'enemy-stats.test.mjs', 'fixtures/optimizer-input.mjs', 'fixtures/community-cases.json',
)


def source_names(root: Path) -> list[str]:
    root = root.resolve()
    names = list(ROOT_FILES)
    names += ['public/' + name for name in PUBLIC_MODULES]
    names += ['scripts/' + name for name in SCRIPTS]
    names += ['tests/' + name for name in TESTS]
    names += ['shared/' + name for name in ('wbkit.py', 'wbkit.js', 'fuuko.css', 'README.md')]
    names += ['public/data/' + name for name in ('catalog.json', 'skills.json', 'stats.json', 'equipment.json', 'image-manifest.json', 'bosses/index.json')]
    names += [name for name in ('LICENSE', 'LICENSE.md', 'LICENSE.txt') if (root / name).is_file()]
    # Event membership comes from the public catalog, never an unrestricted walk.
    index = json.loads((root / 'public/data/bosses/index.json').read_text(encoding='utf-8-sig'))
    for event in index['events']:
        name = event['file']
        if not re.fullmatch(r'(sa|dimension|wave)/[A-Za-z0-9_-]+\.json', name):
            raise ValueError('Unexpected boss catalog filename')
        names.append('public/data/bosses/' + name)
    return sorted(set(names))


def release_files(root: Path, include_images: bool = False) -> dict[str, bytes]:
    root = root.resolve()
    files = read_sources(root, source_names(root))
    catalog = json.loads(files['public/data/catalog.json'].decode('utf-8-sig'))
    assets = catalog_assets(catalog)
    image_manifest = json.loads(files['public/data/image-manifest.json'].decode('utf-8-sig'))
    old_images = {row['path']: row for row in image_manifest.get('assets', [])}
    public_images = []
    for asset in assets:
        recorded = old_images.get(asset['path'], {})
        row = {**asset, **{key: recorded[key] for key in ('sha256', 'bytes') if key in recorded},
               'status': 'bundled' if include_images else 'not-bundled'}
        if include_images:
            if not row.get('sha256'):
                raise ValueError('Image has no reviewed source hash: ' + asset['path'])
            path = 'public' + asset['path']
            data = read_sources(root, [path])[path]
            if image_info(data)['sha256'] != row['sha256']:
                raise ValueError('Image source hash mismatch: ' + asset['path'])
            files[path] = data
        public_images.append(row)
    files['public/data/image-manifest.json'] = (json.dumps({
        'catalogVersion': catalog['version'], 'source': 'hbr.quest public image CDN',
        'assets': public_images}, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    skills = json.loads(files['public/data/skills.json'].decode('utf-8-sig'))
    skills['source']['styles'] = 'https://master.hbr.quest/v1/styles.json'
    files['public/data/skills.json'] = (json.dumps(skills, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')
    color = (196, 85, 63)
    files['public/hbr-icon.png'] = generic_png(256, color)
    files['public/hbr.ico'] = generic_ico(color)
    marker = b'# Generic release icons are maintained public assets.'
    if marker not in files['.gitignore']:
        files['.gitignore'] += b'\n' + marker + b'\n!/public/hbr-icon.png\n!/public/hbr.ico\n'
    image_block = b'\n# Artwork explicitly bundled after source-hash verification.\n!/public/assets/hbr/\n'
    files['.gitignore'] = files['.gitignore'].replace(image_block, b'')
    if include_images:
        files['.gitignore'] += image_block
    return with_manifest(files, 'hbr-planner')


def build_tree(root: Path, output: Path, *, refresh: bool = False, include_images: bool = False) -> tuple[int, int]:
    return export_tree(release_files(root, include_images), output, refresh=refresh)


def build_zip(root: Path, output: Path, *, include_images: bool = False) -> tuple[int, int]:
    output = output.absolute()
    if output.exists():
        raise FileExistsError('Output already exists: ' + str(output))
    files = release_files(root, include_images)
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open('xb') as handle:
            created = True
            with zipfile.ZipFile(handle, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
                for name, data in sorted(files.items()):
                    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    archive.writestr(info, data)
    except BaseException:
        if created:
            output.unlink(missing_ok=True)
        raise
    return len(files), output.stat().st_size


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path, help='New source directory or .zip file')
    parser.add_argument('--refresh', action='store_true', help='Update an unedited previous directory export')
    parser.add_argument('--include-images', action='store_true', help='Include only catalog-listed artwork that matches recorded public source hashes')
    args = parser.parse_args(argv)
    try:
        if args.output.suffix.lower() == '.zip':
            if args.refresh:
                raise ValueError('--refresh is only available for source directories')
            count, size = build_zip(ROOT, args.output, include_images=args.include_images)
        else:
            count, size = build_tree(ROOT, args.output, refresh=args.refresh, include_images=args.include_images)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'{exc}\n')
    print(f'{args.output.resolve()} ({count} files, {size} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
