import importlib.util
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
adsk.core.CustomEventHandler = object
spec = importlib.util.spec_from_file_location('fusion_import_rules', ROOT / 'tools/fusion/ManualStudioBridge/ManualStudioBridge.py')
bridge = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion}):
    spec.loader.exec_module(bridge)


class FusionImportRulesTests(unittest.TestCase):
    def test_hidden_brep_bodies_are_imported_and_mesh_bodies_are_excluded(self):
        def body(name, visible):
            return types.SimpleNamespace(name=name, isVisible=visible)
        hidden_child = types.SimpleNamespace(name='Hidden child', isVisible=False,
                                            bRepBodies=[body('Hidden inner body', False)], meshBodies=[], childOccurrences=[])
        hidden_parent = types.SimpleNamespace(name='Hidden parent', isVisible=False,
                                             bRepBodies=[body('Hidden shell', False)], meshBodies=[], childOccurrences=[hidden_child])
        visible = types.SimpleNamespace(name='Visible component', isVisible=True,
                                        bRepBodies=[body('Visible shell', True), body('Hidden support', False)], meshBodies=[body('Hidden mesh', False)], childOccurrences=[])
        root = types.SimpleNamespace(bRepBodies=[body('Hidden root body', False)], meshBodies=[], occurrences=[hidden_parent, visible])
        entries = bridge.all_body_entries(root, bridge.ordered_occurrences(root))
        self.assertEqual([body.name for body, _ in entries], [
            'Hidden root body', 'Hidden shell', 'Hidden inner body', 'Visible shell', 'Hidden support'])
        self.assertIs(entries[2][1], hidden_child)

    def test_only_complete_matching_versions_qualify_for_no_op(self):
        self.assertFalse(bridge.is_current_import({'versionId': 'v3'}, 'v3'))
        complete = {'versionId': 'v3', 'contentScope': bridge.CONTENT_SCOPE}
        self.assertTrue(bridge.is_current_import(complete, 'v3'))
        self.assertFalse(bridge.is_current_import(complete, 'v4'))
        self.assertFalse(bridge.is_current_import({'contentScope': bridge.CONTENT_SCOPE}, None))

    def test_same_version_no_op_does_not_replace_model_or_project(self):
        source = {'versionId': 'v3', 'version': 3, 'contentScope': bridge.CONTENT_SCOPE}
        cloud_file = types.SimpleNamespace(versionId='v3', versionNumber=3)
        cloud_file.latestVersion = cloud_file
        app = types.SimpleNamespace(activeDocument=None, data=types.SimpleNamespace(findFileById=lambda _: cloud_file))
        with tempfile.TemporaryDirectory(prefix='manualstudio-import-rules-') as directory:
            data = pathlib.Path(directory)
            (data / 'projects').mkdir()
            folder = data / 'job'
            folder.mkdir()
            model = {'id': 'original-model', 'source': source, 'parts': [{'id': 'body'}], 'constructionAxes': []}
            project_file = data / 'projects/project.json'
            saved = json.dumps({'model': model, 'revision': 5})
            project_file.write_text(saved, encoding='utf-8')
            request = {'projectId': 'project', 'modelId': 'unused-model', 'fileId': 'cloud-file', 'source': source}
            with patch.object(bridge, 'DATA', data), patch.object(bridge, '_app', app):
                result = list(bridge.export_design(request, folder))
            self.assertEqual(len(result), 1)
            self.assertTrue(result[0]['unchanged'])
            self.assertEqual(result[0]['modelId'], 'original-model')
            self.assertEqual(result[0]['projectId'], 'project')
            self.assertEqual(project_file.read_text(encoding='utf-8'), saved)
            self.assertFalse((data / 'models').exists())
            self.assertEqual(result[0]['metrics']['calculatedParts'], 0)


if __name__ == '__main__':
    unittest.main()
