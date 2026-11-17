"""Read finite construction-axis lines from the native F3D display snapshot."""

import base64
import binascii
import gzip
import math
import re
import struct
import zipfile
import zlib


SCENE_FOLDER = 'FusionAssetName[Active]/OGS.BlobFolder/OGS/DefaultScene/'
WORK_AXIS = struct.pack('<I', 8) + 'WorkAxis'.encode('utf-16-le')
WORK_TYPE = struct.pack('<I', 22) + 'WorkGeometryClientType'.encode('utf-16-le') + b'\x01'


def native_entity_id(token):
    """Decode only the observed FRKey variant; other token encodings stay unsupported."""
    try:
        raw = base64.b64decode(token, validate=True)
        if not raw.startswith(b'\xfe\xfe\x01\x00\x00\x00FRKey\x00'):
            return None
        payload = gzip.decompress(raw[12:])
    except (ValueError, binascii.Error, gzip.BadGzipFile, EOFError, zlib.error):
        return None
    match = re.search(rb'0 0 8 0 (\d+)$', payload)
    return int(match.group(1)) if match else None


def _wide_string(data, offset):
    if offset + 4 > len(data):
        return None, offset
    count = struct.unpack_from('<I', data, offset)[0]
    end = offset + 4 + count * 2
    if end > len(data):
        return None, end
    try:
        return data[offset + 4:end].decode('utf-16-le'), end
    except UnicodeDecodeError:
        return None, end


def load_axis_display_cache(archive_path):
    """Return native entity IDs and local-centimeter endpoints from recognized OGS records.

    OGS is an undocumented archive format. Each accepted record must have the observed
    WorkAxis client key, line primitive, vertex buffer layout and matching bounds.
    Missing or unsupported display records are omitted for the caller's geometry fallback.
    """
    result = {}
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        if SCENE_FOLDER + 'world' not in names:
            return result
        world = archive.read(SCENE_FOLDER + 'world')
        streams = {}
        cursor = 0
        while True:
            marker = world.find(WORK_AXIS, cursor)
            if marker < 0:
                break
            cursor = marker + len(WORK_AXIS)
            label = marker + 4
            if marker < len(WORK_TYPE) + 17 or world[marker - len(WORK_TYPE):marker] != WORK_TYPE:
                continue
            entity_id = struct.unpack_from('>Q', world, label - 70)[0]
            if not entity_id or world[label - 62:label - 54] != bytes(8) or world[label - 54] != 1:
                continue
            mesh_name, mesh = _wide_string(world, label + 61)
            if mesh_name != 'OgsSimpleMesh' or mesh + 31 > len(world):
                continue
            float_bounds = struct.unpack_from('<6f', world, mesh)
            primitive = struct.unpack_from('<I', world, mesh + 24)[0]
            if primitive != 3 or world[mesh + 28:mesh + 31] != b'\x01\x00\x01':
                continue
            format_name, field = _wide_string(world, mesh + 31)
            reference, field = _wide_string(world, field)
            if format_name != 'VertexFormat' or not reference or not re.fullmatch(r'[0-9A-F]{16}', reference):
                continue
            if field + 66 > len(world):
                continue
            count, stream_index, offset, byte_count = struct.unpack_from('<4I', world, field)
            if count != 1 or byte_count not in (24, 72) or world[field + 16:field + 18] != b'\x00\x00':
                continue
            double_bounds = struct.unpack_from('<6d', world, field + 18)
            stream_name = SCENE_FOLDER + f'stream_mesh_{stream_index:03d}'
            if stream_name not in names:
                continue
            if stream_index not in streams:
                streams[stream_index] = archive.read(stream_name)
            stream = streams[stream_index]
            if offset + byte_count > len(stream):
                continue
            # Both observed formats contain two vertices; the 72-byte layout interleaves
            # two auxiliary vectors per position, which must not be treated as endpoints.
            points = [struct.unpack_from('<3f', stream, offset + vertex * byte_count // 2) for vertex in range(2)]
            bounds = [min(point[axis] for point in points) for axis in range(3)]
            bounds += [max(point[axis] for point in points) for axis in range(3)]
            if not all(math.isfinite(value) for value in (*bounds, *float_bounds, *double_bounds)):
                continue
            if not all(math.isclose(a, b, rel_tol=2e-7, abs_tol=1e-6)
                       for stored in (float_bounds, double_bounds) for a, b in zip(bounds, stored)):
                continue
            if math.dist(*points) <= 1e-7:
                continue
            result.setdefault(entity_id, []).append(points)
    return result


def cached_axis_extent(cache, token, origin, direction):
    """Project matching display endpoints onto the independently read native infinite line."""
    entity_id = native_entity_id(token)
    candidates = cache.get(entity_id, [])
    length = math.sqrt(sum(value * value for value in direction))
    if not candidates or length <= 1e-12:
        return None
    unit = [value / length for value in direction]
    extents = []
    for points in candidates:
        values = [sum((point[i] - origin[i]) * unit[i] for i in range(3)) for point in points]
        # The cache stores float32 positions. Require agreement with the live native line
        # to within 0.001 mm before accepting the cached display range.
        if any(math.dist(point, [origin[i] + value * unit[i] for i in range(3)]) > .0001
               for point, value in zip(points, values)):
            continue
        extent = sorted(values)
        if not any(max(abs(a - b) for a, b in zip(extent, previous)) <= .0001 for previous in extents):
            extents.append(extent)
    return extents[0] if len(extents) == 1 else None
