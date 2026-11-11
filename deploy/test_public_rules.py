import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-public-rules.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicRuleExportTests(unittest.TestCase):
    def fixture(self, directory, image=b'\x89PNG\r\n\x1a\nfixture', updates=None):
        reference = {'id': 'ref-1', 'name': 'rule.png', 'storageKey': 'image:rule', 'url': 'blob:private-origin', 'sheet': 'Rules', 'anchor': 'B2', 'kind': 'reference'}
        pack = {
            'id': 'local-rule-pack', 'name': 'Published rules', 'version': 3, 'status': 'published', 'sourceFileName': 'rules.xlsx',
            'profiles': [], 'rules': [], 'templates': [], 'references': [reference], 'globalStandards': [],
            'requirementPresets': [{'id': 'plan-1', 'referenceIds': ['ref-1'], 'translationSeeds': {'en-US': 'Public text', 'apiKey': 'PRIVATE_SECRET'}}],
            'generationDefaults': {'marketingEnabled': True, 'apiKey': 'PRIVATE_SECRET', 'overlay': {'logo': {'placement': 'off', 'secret': 'PRIVATE_SECRET'}}},
            'owner': {'pinHash': 'PRIVATE_SECRET'},
        }
        pack.update(updates or {})
        state = {'policyPacks': [pack, {**pack, 'id': 'draft', 'version': 99, 'status': 'draft'}], 'jobs': [{'name': 'PRIVATE_JOB'}], 'modelRoles': {'removalApiKey': 'PRIVATE_SECRET'}}
        node = {'t': 'binary', 'path': 'binary/0', 'hash': hashlib.sha256(image).hexdigest(), 'size': len(image), 'mime': 'image/png'}
        manifest = {'format': 'infinite-canvas-workspace', 'version': 1, 'stores': [
            {'name': 'app_state', 'records': [{'key': {'v': 'infinite-canvas:commerce_store'}, 'value': {'v': json.dumps({'state': state})}}]},
            {'name': 'image_files', 'records': [{'key': {'v': 'image:rule'}, 'value': node}, {'key': {'v': 'image:private'}, 'value': {'t': 'binary', 'path': 'binary/1'}}]},
        ]}
        path = directory / 'snapshot.zip'
        with zipfile.ZipFile(path, 'w') as archive:
            archive.writestr('manifest.json', json.dumps(manifest))
            archive.writestr('binary/0', image)
            archive.writestr('binary/1', b'PRIVATE_IMAGE')
        return path

    def test_only_published_rule_fields_and_bound_images_are_public(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            source = self.fixture(directory)
            original = source.read_bytes()
            root = directory / 'public'
            with contextlib.redirect_stdout(io.StringIO()):
                publisher.publish(source, root)
            text = (root / 'catalog.json').read_text(encoding='utf-8')
            self.assertNotIn('PRIVATE_', text)
            self.assertNotIn('storageKey', text)
            self.assertNotIn('blob:', text)
            catalog = json.loads(text)
            self.assertEqual(len(catalog['policyPacks']), 1)
            pack = catalog['policyPacks'][0]
            self.assertEqual(pack['version'], 3)
            self.assertTrue(pack['id'].startswith('server-aoweisi-'))
            self.assertEqual(pack['requirementPresets'][0]['id'], 'plan-1')
            self.assertNotIn('creativeLibraryVersion', pack)
            self.assertNotIn('creativeBrief', pack['generationDefaults'])
            self.assertNotIn('recipeRole', pack['requirementPresets'][0])
            self.assertFalse((root / 'catalog-creative-v1.json').exists())
            self.assertTrue(pack['references'][0]['url'].startswith('/public-rules/releases/'))
            self.assertEqual(len(list(root.glob('releases/*/images/*'))), 1)
            self.assertEqual(source.read_bytes(), original)

    def creative_fields(self):
        brief = {'scene': '书桌', 'lighting': 'natural-window', 'audience': '居家用户', 'people': 'none', 'framing': 'wide', 'apiKey': 'PRIVATE_SECRET', 'custom': {'pinHash': 'PRIVATE_SECRET'}}
        return {
            'version': 5, 'creativeLibraryVersion': 1,
            'requirementPresets': [{'id': 'pair', 'stage': 'marketing', 'layout': 'before-after', 'visualMode': 'generate', 'recipeRole': 'before-after', 'generationStrategy': 'paired-before-after', 'creativeBrief': brief, 'referenceIds': ['ref-1'], 'apiKey': 'PRIVATE_SECRET'}],
            'generationDefaults': {'creativeBrief': brief, 'apiKey': 'PRIVATE_SECRET'},
        }

    def test_creative_fields_are_whitelisted_and_publish_to_separate_endpoint(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            fields = self.creative_fields()
            source = self.fixture(directory, updates=fields)
            original = source.read_bytes()
            root = directory / 'public'
            root.mkdir()
            legacy = b'{"legacy":"catalog must remain byte-for-byte unchanged"}'
            visual = b'{"legacy":"visual v2 must also remain unchanged"}'
            (root / 'catalog.json').write_bytes(legacy)
            (root / 'catalog-visual-v2.json').write_bytes(visual)
            with contextlib.redirect_stdout(io.StringIO()):
                publisher.publish(source, root)
            text = (root / 'catalog-creative-v1.json').read_text(encoding='utf-8')
            self.assertNotIn('PRIVATE_', text)
            self.assertNotIn('apiKey', text)
            self.assertNotIn('custom', text)
            pack = json.loads(text)['policyPacks'][0]
            expected = {key: fields['generationDefaults']['creativeBrief'][key] for key in ('scene', 'lighting', 'audience', 'people', 'framing')}
            self.assertEqual(pack['creativeLibraryVersion'], 1)
            self.assertEqual(pack['generationDefaults'], {'creativeBrief': expected})
            self.assertEqual(pack['requirementPresets'][0]['creativeBrief'], expected)
            self.assertEqual(pack['requirementPresets'][0]['recipeRole'], 'before-after')
            self.assertEqual(pack['requirementPresets'][0]['generationStrategy'], 'paired-before-after')
            self.assertEqual(pack['requirementPresets'][0]['referenceIds'], ['ref-1'])
            self.assertEqual(len(pack['references']), 1)
            self.assertEqual((root / 'catalog.json').read_bytes(), legacy)
            self.assertEqual((root / 'catalog-visual-v2.json').read_bytes(), visual)
            self.assertEqual(source.read_bytes(), original)
            self.assertFalse((root / 'catalog-creative-v1.next.json').exists())

    def test_invalid_creative_fields_never_publish(self):
        mutations = [
            lambda p: p.update(creativeLibraryVersion=2),
            lambda p: p.update(creativeLibraryVersion=True),
            lambda p: p['requirementPresets'][0].update(creativeBrief=None),
            lambda p: p['requirementPresets'][0].update(creativeBrief=[]),
            lambda p: p['requirementPresets'][0]['creativeBrief'].update(scene={'apiKey': 'PRIVATE_SECRET'}),
            lambda p: p['requirementPresets'][0]['creativeBrief'].update(audience='x' * 2001),
            lambda p: p['requirementPresets'][0]['creativeBrief'].update(lighting='invalid'),
            lambda p: p['requirementPresets'][0]['creativeBrief'].update(framing='invalid'),
            lambda p: p['requirementPresets'][0].update(recipeRole='invalid'),
            lambda p: p['requirementPresets'][0].update(generationStrategy='invalid'),
            lambda p: p['requirementPresets'][0].update(stage='scene'),
            lambda p: p['requirementPresets'][0].update(layout='single-hero'),
            lambda p: p['requirementPresets'][0].update(visualMode='white-layout'),
            lambda p: p['requirementPresets'][0]['creativeBrief'].update(people='adult-partial'),
            lambda p: p['generationDefaults'].update(creativeBrief={'people': 'child'}),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(case=index), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                fields = self.creative_fields()
                mutate(fields)
                source = self.fixture(directory, updates=fields)
                root = directory / 'public'
                with self.assertRaises(ValueError):
                    publisher.publish(source, root)
                self.assertFalse(root.exists())

    def test_omitted_creative_overrides_are_not_synthesized(self):
        self.assertEqual(publisher.creative_brief({}), {})
        self.assertEqual(publisher.output_config({}), {})
        self.assertEqual(publisher.requirement_preset({'id': 'legacy'}), {'id': 'legacy'})

    def test_mislabeled_active_content_is_not_published(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            source = self.fixture(directory, b'<svg onload="bad()"/>')
            with self.assertRaises(ValueError):
                publisher.publish(source, directory / 'public')
            self.assertFalse((directory / 'public/catalog.json').exists())


if __name__ == '__main__':
    unittest.main()
