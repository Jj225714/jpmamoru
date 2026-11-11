"""Read only snapshot counts and checksums; never print configuration values."""
import hashlib
import json
import pathlib
import sys
import zipfile

snapshot = pathlib.Path(sys.argv[1]).resolve()
private_root = pathlib.Path('/var/lib/aoweisi-sync/private-data').resolve()
if snapshot.parent != private_root or not snapshot.name.startswith('snapshot-') or snapshot.suffix != '.zip':
    raise SystemExit('Unexpected snapshot path')
digest = hashlib.sha256()
with snapshot.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
report = {'bytes': snapshot.stat().st_size, 'sha256': digest.hexdigest(), 'stores': {}}
with zipfile.ZipFile(snapshot) as archive:
    manifest = json.loads(archive.read('manifest.json'))
    if manifest.get('format') != 'infinite-canvas-workspace' or manifest.get('version') != 1:
        raise SystemExit('Unexpected manifest format')
    report['localStorageKeys'] = len(manifest.get('local', []))
    for store in manifest['stores']:
        report['stores'][store['name']] = len(store['records'])
        if store['name'] != 'app_state':
            continue
        for record in store['records']:
            key = record.get('key', {}).get('v')
            value = record.get('value', {}).get('v')
            if not isinstance(value, str):
                continue
            if key == 'infinite-canvas:commerce_store':
                state = json.loads(value)['state']
                report['commerce'] = {
                    'jobs': len(state.get('jobs', [])),
                    'brands': len(state.get('brands', [])),
                    'policyPacks': len(state.get('policyPacks', [])),
                    'policies': [{'version': p.get('version'), 'requirements': len(p.get('requirementPresets', [])), 'references': len(p.get('references', []))} for p in state.get('policyPacks', [])],
                    'generatedAssets': sum(len(s.get('assets', [])) for j in state.get('jobs', []) for s in j.get('skus', [])),
                }
            if key == 'infinite-canvas:canvas_store':
                report['canvasProjects'] = len(json.loads(value)['state'].get('projects', []))
print(json.dumps(report, ensure_ascii=False, indent=2))
