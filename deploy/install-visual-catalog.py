"""Install reviewed v4 public-only catalog; old immutable images and catalog remain recoverable."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone


def install(source):
    root = Path('/var/lib/aoweisi-public-rules').resolve(strict=True)
    current_path = root / 'catalog.json'
    old_bytes = current_path.read_bytes()
    old = json.loads(old_bytes)
    new_bytes = source.read_bytes()
    new = json.loads(new_bytes)
    if old['revision'] != 'aoweisi-v3-e39a32a62f12':
        raise ValueError('Current catalog changed; aborting')
    if not re.fullmatch(r'aoweisi-v4-[a-f0-9]{12}', new['revision']):
        raise ValueError('Unexpected new revision')
    before, after = old['policyPacks'][0], new['policyPacks'][0]
    if len(new['policyPacks']) != 1 or after['version'] != 4:
        raise ValueError('Unexpected pack')
    if len(after['requirementPresets']) != 40 or len(after['references']) != 87:
        raise ValueError('Unexpected inventory')
    if {p['id'] for p in before['requirementPresets']} != {p['id'] for p in after['requirementPresets']}:
        raise ValueError('Requirement identity changed')
    if set(after) != set(before):
        raise ValueError('Unexpected public fields')
    for field in ('profiles', 'rules', 'templates', 'siteReferences', 'generationDefaults', 'globalStandards', 'watermarkOpacityRange'):
        if before.get(field) != after.get(field):
            raise ValueError('Unreviewed change to ' + field)
    original_refs = {r['id']: r for r in before['references']}
    planned = []
    for ref in after['references']:
        previous = original_refs[ref['id']]
        if {k: v for k, v in ref.items() if k != 'url'} != {k: v for k, v in previous.items() if k != 'url'}:
            raise ValueError('Reference metadata changed')
        if ref['url'] != previous['url'].replace(old['revision'], new['revision']):
            raise ValueError('Reference remapping invalid')
        name = Path(ref['url']).name
        if not re.fullmatch(r'[a-f0-9]{64}\.(png|jpg|webp|gif)', name):
            raise ValueError('Invalid image name')
        existing = (root / 'releases' / old['revision'] / 'images' / name).resolve(strict=True)
        if not existing.is_relative_to(root) or hashlib.sha256(existing.read_bytes()).hexdigest() != name.split('.')[0]:
            raise ValueError('Image digest/path mismatch')
        target = root / 'releases' / new['revision'] / 'images' / name
        planned.append((existing, target))
    for existing, target in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            os.link(existing, target)
        elif hashlib.sha256(target.read_bytes()).hexdigest() != target.stem:
            raise ValueError('Immutable destination differs')
    backup = Path('/opt/infinite-canvas/backups/public-rules')
    backup.mkdir(parents=True, exist_ok=True)
    (backup / ('catalog-before-visual-v4-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S') + '.json')).write_bytes(old_bytes)
    temporary = root / 'catalog.visual-next.json'
    temporary.write_bytes(new_bytes)
    temporary.chmod(0o644)
    # Old browser bundles only know catalog.json; never feed corrected defaults to the old executor.
    os.replace(temporary, root / 'catalog-visual-v2.json')
    print(json.dumps({'revision': new['revision'], 'requirements': 40, 'references': 87, 'uniqueImages': len({t for _, t in planned})}))


if __name__ == '__main__':
    install(Path(sys.argv[1]).resolve(strict=True))
