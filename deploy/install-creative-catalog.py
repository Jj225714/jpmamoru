"""Stage the v3-executor-only creative catalog without changing legacy endpoints."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone


def install(source, root=Path('/var/lib/aoweisi-public-rules'), backup=Path('/opt/infinite-canvas/backups/public-rules')):
    root = root.resolve(strict=True)
    old_bytes = (root / 'catalog-visual-v2.json').read_bytes()
    old = json.loads(old_bytes)
    new_bytes = source.read_bytes()
    new = json.loads(new_bytes)
    if old['revision'] != 'aoweisi-v4-3e62e18c1632' or not re.fullmatch(r'aoweisi-creative-v5-[a-f0-9]{12}', new['revision']):
        raise ValueError('Unexpected source or target version')
    if len(new['policyPacks']) != 1:
        raise ValueError('Unexpected pack count')
    before, after = old['policyPacks'][0], new['policyPacks'][0]
    if after['version'] != 5 or after.get('creativeLibraryVersion') != 1 or set(after) != set(before) | {'creativeLibraryVersion'}:
        raise ValueError('Invalid creative pack')
    for field in ('profiles', 'rules', 'siteReferences', 'generationDefaults', 'globalStandards', 'watermarkOpacityRange'):
        if before.get(field) != after.get(field):
            raise ValueError('Unreviewed change to ' + field)
    presets = after['requirementPresets']
    if len(presets) != 32 or len({p['id'] for p in presets}) != 32:
        raise ValueError('Expected 32 independent recipes')
    for category in ('地毯地垫类', '桌垫类', '洞洞板类', '收纳筐类'):
        group = [p for p in presets if p['category'] == category]
        if len(group) != 8 or sum(p['enabledByDefault'] for p in group) != 4:
            raise ValueError('Expected 8 recipes and 4 defaults per category')
    previous_refs = {r['id']: r for r in before['references']}
    if len(after['references']) != len(previous_refs) or {r['id'] for r in after['references']} != set(previous_refs):
        raise ValueError('Reference inventory changed')
    planned = []
    for ref in after['references']:
        previous = previous_refs[ref['id']]
        if {k: v for k, v in ref.items() if k != 'url'} != {k: v for k, v in previous.items() if k != 'url'} or ref['url'] != previous['url'].replace(old['revision'], new['revision']):
            raise ValueError('Invalid reference remapping')
        name = Path(ref['url']).name
        if not re.fullmatch(r'[a-f0-9]{64}\.(png|jpg|webp|gif)', name):
            raise ValueError('Invalid reference name')
        existing = (root / 'releases' / old['revision'] / 'images' / name).resolve(strict=True)
        if not existing.is_relative_to(root) or hashlib.sha256(existing.read_bytes()).hexdigest() != existing.stem:
            raise ValueError('Reference digest or path mismatch')
        planned.append((existing, root / 'releases' / new['revision'] / 'images' / name))
    for existing, target in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            os.link(existing, target)
        elif hashlib.sha256(target.read_bytes()).hexdigest() != target.stem:
            raise ValueError('Immutable reference differs')
    destination = root / 'catalog-creative-v1.json'
    backup.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    (backup / ('catalog-before-creative-' + stamp + '.json')).write_bytes(destination.read_bytes() if destination.exists() else old_bytes)
    temporary = root / 'catalog.creative-next.json'
    temporary.write_bytes(new_bytes)
    temporary.chmod(0o644)
    os.replace(temporary, destination)
    print(json.dumps({'revision': new['revision'], 'recipes': 32, 'references': len(previous_refs), 'uniqueImages': len({t for _, t in planned})}))


if __name__ == '__main__':
    install(Path(sys.argv[1]).resolve(strict=True))
