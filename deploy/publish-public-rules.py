"""Publish ONLY the latest published policy and its bound images from a private snapshot.

Run on the server; the workspace snapshot stays private. No state-wide serialization.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from datetime import datetime, timezone
import zipfile


def pick(value, fields):
    return {k: value[k] for k in fields.split() if k in value}


def creative_brief(value):
    if not isinstance(value, dict):
        raise ValueError('Invalid creative brief')
    result = pick(value, 'scene lighting audience people framing')
    choices = {
        'lighting': ('natural-window', 'soft-studio', 'warm-indoor', 'side-light'),
        'people': ('none', 'adult-partial', 'adult-half', 'adult-full'),
        'framing': ('auto', 'close', 'medium', 'wide'),
    }
    for key, item in result.items():
        if not isinstance(item, str) or (key in choices and item not in choices[key]) or (key in ('scene', 'audience') and len(item) > 2000):
            raise ValueError('Invalid creative brief field: ' + key)
    return result


def requirement_preset(value):
    result = pick(value, 'id category order title stage enabledByDefault defaultCount prompt layout chineseCopy translationSeeds requiredFacts referenceIds variantScope needsReview visualMode visualKind')
    choices = {
        'recipeRole': ('hero', 'detail', 'usage', 'selling-point', 'secondary-scene', 'interaction', 'lighting', 'before-after'),
        'generationStrategy': ('single', 'paired-before-after'),
    }
    for key, options in choices.items():
        if key in value:
            if not isinstance(value[key], str) or value[key] not in options:
                raise ValueError('Invalid creative preset field: ' + key)
            result[key] = value[key]
    if 'creativeBrief' in value:
        result['creativeBrief'] = creative_brief(value['creativeBrief'])
    paired = result.get('generationStrategy') == 'paired-before-after'
    if paired and (result.get('stage') != 'marketing' or result.get('layout') != 'before-after' or result.get('visualMode') == 'white-layout'):
        raise ValueError('Invalid paired before/after preset')
    if (paired or result.get('recipeRole') == 'detail') and result.get('creativeBrief', {}).get('people', 'none') != 'none':
        raise ValueError('Detail and paired presets cannot include people')
    return result


def output_config(value):
    result = pick(value, 'marketingEnabled siteImageMode delivery')
    if 'creativeBrief' in value:
        result['creativeBrief'] = creative_brief(value['creativeBrief'])
    if 'assetCounts' in value:
        result['assetCounts'] = pick(value['assetCounts'], 'scene detail usage-size detail-white')
    if 'outputSpec' in value:
        result['outputSpec'] = pick(value['outputSpec'], 'size format maxBytes colorSpace dpi')
    if 'overlay' in value:
        overlay = value['overlay']
        result['overlay'] = {}
        if 'logo' in overlay:
            result['overlay']['logo'] = pick(overlay['logo'], 'placement applyTo customStages')
        if 'watermark' in overlay:
            result['overlay']['watermark'] = pick(overlay['watermark'], 'mode position opacity applyTo customStages')
    return result


def publish(snapshot, root):
    with zipfile.ZipFile(snapshot) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        if manifest.get('format') != 'infinite-canvas-workspace' or manifest.get('version') != 1:
            raise ValueError('Unsupported snapshot')
        stores = {s['name']: s for s in manifest['stores']}
        state_record = next(r for r in stores['app_state']['records'] if r['key'].get('v') == 'infinite-canvas:commerce_store')
        state = json.loads(state_record['value']['v'])['state']
        original = max((p for p in state['policyPacks'] if p['status'] == 'published' and p['id'] != 'builtin-sea-home'), key=lambda p: p['version'])
        pack = pick(original, 'name version sourceFileName globalStandards watermarkOpacityRange createdAt publishedAt')
        if 'creativeLibraryVersion' in original:
            if type(original['creativeLibraryVersion']) is not int or original['creativeLibraryVersion'] != 1:
                raise ValueError('Invalid creative library version')
            pack['creativeLibraryVersion'] = 1
        pack['status'] = 'published'
        pack['profiles'] = [pick(p, 'countryCode countryName locale audience visualKeywords mainImageStyle preferredColors avoidedColors modelPreference') for p in original['profiles']]
        pack['rules'] = [dict(pick(r, 'id title description severity priority countries platforms categories locales assetStages phase checker'), source=pick(r.get('source', {}), 'fileName sheet range')) for r in original['rules']]
        pack['templates'] = [pick(t, 'id category order title requirement slot chineseCopy translationSeeds requiredVariables referenceIds') for t in original['templates']]
        pack['requirementPresets'] = [requirement_preset(p) for p in original['requirementPresets']]
        for item in pack['templates'] + pack['requirementPresets']:
            item['translationSeeds'] = pick(item.get('translationSeeds', {}), 'en-US th-TH vi-VN ms-MY fil-PH id-ID')
        pack['siteReferences'] = [pick(r, 'id product locale url referenceIds note') for r in original.get('siteReferences', [])]
        if original.get('generationDefaults') is not None:
            pack['generationDefaults'] = output_config(original['generationDefaults'])
        images = {r['key']['v']: r['value'] for r in stores['image_files']['records']}
        extensions = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif'}
        binaries = {}
        references = []
        for reference in original['references']:
            node = images.get(reference.get('storageKey'))
            if node:
                if node.get('t') != 'binary' or not re.fullmatch(r'binary/\d+', node.get('path', '')):
                    raise ValueError('Invalid reference blob')
                content = archive.read(node['path'])
                if hashlib.sha256(content).hexdigest() != node['hash'] or len(content) != node['size']:
                    raise ValueError('Reference hash mismatch')
                mime = node['mime']
            else:
                match = re.fullmatch(r'data:(image/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)', reference.get('url', ''))
                if not match:
                    raise ValueError('Reference must have a local verified image')
                mime = match.group(1)
                content = base64.b64decode(match.group(2), validate=False)
            if mime not in extensions:
                raise ValueError('Only passive raster references can be public')
            signatures = {
                'image/png': content.startswith(b'\x89PNG\r\n\x1a\n'),
                'image/jpeg': content.startswith(b'\xff\xd8\xff'),
                'image/webp': content.startswith(b'RIFF') and content[8:12] == b'WEBP',
                'image/gif': content[:6] in (b'GIF87a', b'GIF89a'),
            }
            if not signatures[mime]:
                raise ValueError('Reference content does not match its MIME type')
            name = hashlib.sha256(content).hexdigest() + '.' + extensions[mime]
            binaries[name] = content
            references.append(dict(pick(reference, 'id name sheet anchor kind'), source='rule-reference', url='images/' + name))
        pack['references'] = references
        all_ids = {r['id'] for r in references}
        for item in pack['templates'] + pack['requirementPresets'] + pack['siteReferences']:
            if not set(item.get('referenceIds', [])).issubset(all_ids):
                raise ValueError('Dangling reference')
        revision = 'aoweisi-v' + str(pack['version']) + '-' + hashlib.sha256(json.dumps(pack, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
        pack['id'] = 'server-aoweisi-' + original['id'] + '-v' + str(pack['version']) + '-' + revision.rsplit('-', 1)[1]
        destination = root / 'releases' / revision
        (destination / 'images').mkdir(parents=True, exist_ok=True)
        for name, content in binaries.items():
            path = destination / 'images' / name
            if path.exists() and path.read_bytes() != content:
                raise ValueError('Existing immutable image differs')
            if not path.exists():
                path.write_bytes(content)
            path.chmod(0o644)
        for reference in pack['references']:
            reference['url'] = '/public-rules/releases/' + revision + '/' + reference['url']
        envelope = {'schemaVersion': 1, 'revision': revision, 'publishedAt': datetime.now(timezone.utc).isoformat(), 'policyPacks': [pack]}
        data = json.dumps(envelope, ensure_ascii=False, separators=(',', ':')).encode()
        catalog_name = 'catalog-creative-v1' if pack.get('creativeLibraryVersion') == 1 else 'catalog'
        catalog = root / (catalog_name + '.json')
        if catalog.exists():
            # Previous public catalogs are retained separately from the public directory.
            backup_root = Path('/opt/infinite-canvas/backups/public-rules')
            backup_root.mkdir(parents=True, exist_ok=True)
            (backup_root / (catalog_name + '-' + datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f') + '.json')).write_bytes(catalog.read_bytes())
        temporary = root / (catalog_name + '.next.json')
        temporary.write_bytes(data)
        temporary.chmod(0o644)
        os.replace(temporary, catalog)
        print(json.dumps({'revision': revision, 'version': pack['version'], 'requirements': len(pack['requirementPresets']), 'references': len(references), 'uniqueImages': len(binaries), 'catalogBytes': len(data), 'imageBytes': sum(map(len, binaries.values()))}))


if __name__ == '__main__':
    snapshot = Path(sys.argv[1]).resolve()
    if snapshot.parent != Path('/var/lib/aoweisi-sync/private-data') or not snapshot.name.startswith('snapshot-') or snapshot.suffix != '.zip':
        raise SystemExit('Unexpected snapshot path')
    publish(snapshot, Path('/var/lib/aoweisi-public-rules'))
