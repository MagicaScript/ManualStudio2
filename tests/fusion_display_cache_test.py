import base64
import gzip
import pathlib
import struct
import sys
import tempfile
import unittest
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools/fusion/ManualStudioBridge'))
from display_axis_cache import SCENE_FOLDER, cached_axis_extent, load_axis_display_cache, native_entity_id


def wide_text(value):
    return struct.pack('<I', len(value)) + value.encode('utf-16-le')


def axis_example(entity_id, name, origin, direction, extent, *, interleaved=False):
    points = [tuple(origin[i] + distance * direction[i] for i in range(3)) for distance in extent]
    bounds = [min(values) for values in zip(*points)] + [max(values) for values in zip(*points)]
    stream_offset = 12
    vertices = bytearray(stream_offset)
    for point in points:
        vertices.extend(struct.pack('<3f', *point))
        if interleaved:
            vertices.extend(struct.pack('<6f', 0, 0, 1, 0, 1, 0))

    record = struct.pack('>Q', entity_id) + bytes(8) + b'\x01'
    record += wide_text('WorkGeometryClientType') + b'\x01'
    label = len(record) + 4
    record += wide_text('WorkAxis')
    record += bytes(label + 61 - len(record)) + wide_text('OgsSimpleMesh')
    record += struct.pack('<6fI', *bounds, 3) + b'\x01\x00\x01'
    record += wide_text('VertexFormat') + wide_text('0123456789ABCDEF')
    offset_field = len(record) + 8
    record += struct.pack('<4I', 1, 0, stream_offset, len(vertices) - stream_offset)
    record += bytes(2) + struct.pack('<6d', *bounds)

    key = gzip.compress(f'0 0 8 0 {entity_id}'.encode('ascii'), mtime=0)
    token = base64.b64encode(b'\xfe\xfe\x01\x00\x00\x00FRKey\x00' + key).decode('ascii')
    return {
        'id': entity_id, 'name': name, 'token': token, 'origin': origin, 'direction': direction,
        'extent': extent, 'record': record, 'vertices': vertices, 'offset_field': offset_field,
        'stream_offset': stream_offset,
    }


class DisplayAxisCacheTests(unittest.TestCase):
    def setUp(self):
        self.examples = [
            axis_example(101, 'Position-only axis', (6, -2, 1), (1, 0, 0), (-4, 6)),
            axis_example(202, 'Interleaved diagonal axis', (5, -4, 2), (0.6, 0.8, 0), (-5, 10), interleaved=True),
        ]

    def cache(self, example, record=None, vertices=None):
        with tempfile.TemporaryDirectory(prefix='manualstudio-axis-cache-') as directory:
            filename = pathlib.Path(directory) / 'Reference.f3d'
            with zipfile.ZipFile(filename, 'w') as archive:
                archive.writestr(SCENE_FOLDER + 'world', record if record is not None else example['record'])
                archive.writestr(SCENE_FOLDER + 'stream_mesh_000', vertices if vertices is not None else example['vertices'])
            return load_axis_display_cache(filename)

    def test_position_only_and_interleaved_records(self):
        for example in self.examples:
            with self.subTest(axis=example['name']):
                self.assertEqual(native_entity_id(example['token']), example['id'])
                extent = cached_axis_extent(self.cache(example), example['token'], example['origin'], example['direction'])
                self.assertIsNotNone(extent)
                for actual, expected in zip(extent, example['extent']):
                    self.assertAlmostEqual(actual, expected, places=8)

    def test_stale_line_or_identity_is_not_accepted(self):
        example = self.examples[0]
        cache = self.cache(example)
        x, y, z = example['origin']
        self.assertIsNone(cached_axis_extent(cache, example['token'], (x, y + 1, z), example['direction']))
        self.assertIsNone(cached_axis_extent(cache, self.examples[1]['token'], example['origin'], example['direction']))
        self.assertIsNone(native_entity_id('not-a-native-token'))

    def test_corrupt_buffer_or_mismatched_bounds_is_rejected(self):
        example = self.examples[0]
        vertices = bytearray(example['vertices'])
        struct.pack_into('<f', vertices, example['stream_offset'], 999.0)
        self.assertEqual(self.cache(example, vertices=vertices), {})
        record = bytearray(example['record'])
        struct.pack_into('<I', record, example['offset_field'], 10000)
        self.assertEqual(self.cache(example, record=record), {})

    def test_disagreeing_ranges_are_ambiguous(self):
        example = self.examples[0]
        cache = self.cache(example)
        points = cache[example['id']][0]
        longer = [tuple(point[i] + example['direction'][i] for i in range(3)) for point in points]
        cache[example['id']].append(longer)
        self.assertIsNone(cached_axis_extent(cache, example['token'], example['origin'], example['direction']))


if __name__ == '__main__':
    unittest.main()
