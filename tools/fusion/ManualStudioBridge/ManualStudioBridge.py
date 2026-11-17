import adsk.core
import adsk.fusion
import array
import datetime
import importlib.util
import json
import math
import pathlib
import shutil
import threading
import time
import traceback
import uuid

EVENT_ID = 'ManualStudioFusionRead'
CONTENT_SCOPE = 'brep-bodies-and-axes'
ROOT = pathlib.Path(__file__).resolve().parents[3]
DATA = ROOT / 'data'
_cache_spec = importlib.util.spec_from_file_location('manualstudio_display_axis_cache', pathlib.Path(__file__).with_name('display_axis_cache.py'))
_axis_cache = importlib.util.module_from_spec(_cache_spec)
_cache_spec.loader.exec_module(_axis_cache)
_app = None
_event = None
_handler = None
_thread = None
_stop = threading.Event()
_pending = False
_generator = None
_job_folder = None
_last_heartbeat = 0.0


def write_json(filename, value):
    temporary = filename.with_suffix('.pending')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.replace(filename)


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def document_info():
    doc = _app.activeDocument
    data = doc.dataFile if doc else None
    return {'connected': True, 'updatedAt': utc_now(), 'documentName': doc.name if doc else None,
            'modified': doc.isModified if doc else False, 'fileId': data.id if data else None,
            'version': data.versionNumber if data else None, 'latestVersion': data.latestVersionNumber if data else None}


def resolve_token(design, token):
    if not token:
        return None
    entities = design.findEntityByToken(token)
    return entities[0] if len(entities) == 1 else None


def native_key(entity, occurrence):
    native = entity.nativeObject or entity
    return ((occurrence.entityToken if occurrence else ''), native.entityToken)


def ordered_occurrences(root):
    result = []
    def visit(occurrence):
        result.append(occurrence)
        for child in occurrence.childOccurrences:
            visit(child)
    for occurrence in root.occurrences:
        visit(occurrence)
    return result


def all_body_entries(root, occurrences):
    return [(body, None) for body in root.bRepBodies] + [
        (body, occurrence) for occurrence in occurrences for body in occurrence.bRepBodies]


def is_current_import(source, version_id):
    return bool(version_id and source.get('versionId') == version_id and source.get('contentScope') == CONTENT_SCOPE)


def line_box_extent(origin, direction, bounds):
    lower, upper = -math.inf, math.inf
    for i in range(3):
        if abs(direction[i]) < 1e-12:
            if origin[i] < bounds[0][i] - 1e-7 or origin[i] > bounds[1][i] + 1e-7:
                return None
            continue
        a, b = sorted(((bounds[0][i] - origin[i]) / direction[i], (bounds[1][i] - origin[i]) / direction[i]))
        lower, upper = max(lower, a), min(upper, b)
    return [lower, upper] if math.isfinite(lower) and math.isfinite(upper) and upper - lower > 1e-8 else None


def reference_points(entity, owner_occurrence):
    native = entity.nativeObject or entity
    context = entity.assemblyContext
    transform = context.transform2 if context else (owner_occurrence.transform2 if owner_occurrence else None)
    geometry = native.worldGeometry if isinstance(native, (adsk.fusion.SketchPoint, adsk.fusion.SketchLine)) else native.geometry
    if isinstance(geometry, adsk.core.Point3D):
        points = [geometry.copy()]
    elif isinstance(geometry, adsk.core.Line3D):
        points = [geometry.startPoint.copy(), geometry.endPoint.copy()]
    elif isinstance(native, adsk.fusion.BRepFace):
        points = [vertex.geometry.copy() for vertex in native.vertices]
    elif isinstance(native, adsk.fusion.BRepEdge):
        points = [native.startVertex.geometry.copy(), native.endVertex.geometry.copy()]
    else:
        points = []
    if transform:
        for point in points:
            point.transformBy(transform)
    return [list(point.asArray()) for point in points]


def axis_reference_geometry(axis, occurrence, mirrored_references=(), display_cache=None):
    line = axis.geometry
    origin, direction = line.origin.copy(), line.direction.copy()
    direction.normalize()
    if occurrence:
        # Proxy geometry leaves axis directions unrotated in the installed Fusion build.
        origin.transformBy(occurrence.transform2)
        direction.transformBy(occurrence.transform2)
    direction_scale = direction.length
    direction.normalize()
    world_origin, world_direction = list(origin.asArray()), list(direction.asArray())
    if display_cache is not None:
        extent = _axis_cache.cached_axis_extent(display_cache, axis.entityToken, list(line.origin.asArray()), list(line.direction.asArray()))
        if extent is not None:
            return {'origin': [value * 10 for value in world_origin], 'direction': world_direction,
                    'extent': [value * direction_scale * 10 for value in extent], 'extentSource': 'display-cache'}
    definition = axis.definition
    fields = {'adsk::fusion::ConstructionAxisTwoPointDefinition': ['pointEntityOne', 'pointEntityTwo'],
              'adsk::fusion::ConstructionAxisEdgeDefinition': ['edgeEntity'],
              'adsk::fusion::ConstructionAxisCircularFaceDefinition': ['circularFace']}
    points = [point for field in fields.get(definition.objectType, []) for point in reference_points(getattr(definition, field), occurrence)]
    projections = [sum((point[i] - world_origin[i]) * world_direction[i] for i in range(3)) for point in points]
    extent = [min(projections), max(projections)] if projections and max(projections) - min(projections) > 1e-7 else None
    source = 'definition'
    if extent is None and definition.objectType.endswith('ConstructionAxisByLineDefinition'):
        matches = []
        for candidate in mirrored_references:
            dot = sum(world_direction[i] * candidate['direction'][i] for i in range(3))
            if math.dist([value * 10 for value in world_origin], candidate['origin']) < .0001 and abs(abs(dot) - 1) < 1e-8:
                candidate_extent = candidate['extent'] if dot >= 0 else [-candidate['extent'][1], -candidate['extent'][0]]
                if not any(max(abs(candidate_extent[i] - old[i]) for i in range(2)) < .0001 for old in matches):
                    matches.append(candidate_extent)
        if len(matches) == 1:
            extent = [value / 10 for value in matches[0]]
            source = 'mirrored-definition'
    if extent is None:
        # Infinite ByLine axes have no finite reference; bound them in their owning component.
        bounds = axis.component.boundingBox
        local_bounds = [list(bounds.minPoint.asArray()), list(bounds.maxPoint.asArray())]
        local_origin, local_direction = list(line.origin.asArray()), list(line.direction.asArray())
        extent = line_box_extent(local_origin, local_direction, local_bounds)
        if extent is None:
            projections = [sum((point[i] - local_origin[i]) * local_direction[i] for i in range(3))
                           for point in [(x, y, z) for x in (local_bounds[0][0], local_bounds[1][0])
                                         for y in (local_bounds[0][1], local_bounds[1][1]) for z in (local_bounds[0][2], local_bounds[1][2])]]
            extent = [min(projections), max(projections)]
        source = 'component-bounds'
    return {'origin': [value * 10 for value in world_origin], 'direction': world_direction,
            'extent': [value * 10 for value in extent], 'extentSource': source}


def mirror_axis_references(root):
    references = []
    for feature in root.features.mirrorFeatures:
        try:
            entities = feature.inputEntities
        except RuntimeError as error:
            # Historical mirror inputs may no longer be available at the current timeline position.
            if 'input is null' not in str(error):
                raise
            continue
        plane = feature.mirrorPlane.geometry
        if not isinstance(plane, adsk.core.Plane):
            continue
        normal = list(plane.normal.asArray())
        origin = [value * 10 for value in plane.origin.asArray()]
        def visit(occurrence):
            for axis in occurrence.component.constructionAxes:
                if axis.definition.objectType.endswith('ConstructionAxisByLineDefinition'):
                    continue
                geometry = axis_reference_geometry(axis, occurrence)
                if geometry['extentSource'] != 'definition':
                    continue
                distance = sum((geometry['origin'][i] - origin[i]) * normal[i] for i in range(3))
                direction_dot = sum(geometry['direction'][i] * normal[i] for i in range(3))
                references.append({'origin': [geometry['origin'][i] - 2 * distance * normal[i] for i in range(3)],
                    'direction': [geometry['direction'][i] - 2 * direction_dot * normal[i] for i in range(3)], 'extent': geometry['extent']})
            for child in occurrence.childOccurrences:
                visit(child)
        for entity in entities:
            if isinstance(entity, adsk.fusion.Occurrence):
                visit(entity)
    return references


def refresh_references(design, model, request):
    root = design.rootComponent
    part_keys = {}
    for part in model['parts']:
        body = resolve_token(design, part.get('nativeToken'))
        occurrence = resolve_token(design, part.get('occurrenceToken'))
        if body and (not part.get('occurrenceToken') or occurrence):
            part_keys[native_key(body, occurrence)] = part
    axis_keys = {}
    for axis in request.get('knownAxes') or []:
        native = resolve_token(design, axis.get('nativeToken'))
        occurrence = resolve_token(design, axis.get('occurrenceToken'))
        if native and (not axis.get('occurrenceToken') or occurrence):
            axis_keys[native_key(native, occurrence)] = axis['id']
    object_ids = {}
    def remember(nodes):
        for node in nodes:
            if node.get('occurrenceToken'):
                occurrence = resolve_token(design, node['occurrenceToken'])
                if occurrence:
                    object_ids[occurrence.entityToken] = node['id']
            remember(node.get('children', []))
    remember(request.get('knownTree') or [])
    origin_offset = model.get('source', {}).get('originOffset', [0, 0, 0])
    display_cache = _axis_cache.load_axis_display_cache(DATA / model['source']['archiveFile'].lstrip('/'))
    mirrored_references = None
    model['constructionAxes'] = []
    def children(component, occurrence):
        nonlocal mirrored_references
        path = occurrence.fullPathName if occurrence else root.name
        nodes = []
        bodies = occurrence.bRepBodies if occurrence else root.bRepBodies
        for body in bodies:
            part = part_keys.get(native_key(body, occurrence))
            if part:
                nodes.append({'id': 'part:' + part['id'], 'kind': 'part', 'name': part['name'], 'partId': part['id'], 'visible': bool(body.isLightBulbOn and component.isBodiesFolderLightBulbOn)})
            else:
                raise RuntimeError('The body inventory is incomplete: ' + path + '/' + body.name)
        for native in component.constructionAxes:
            geometry = axis_reference_geometry(native, occurrence, display_cache=display_cache)
            if geometry['extentSource'] == 'component-bounds' and native.definition.objectType.endswith('ConstructionAxisByLineDefinition'):
                if mirrored_references is None:
                    mirrored_references = mirror_axis_references(root)
                geometry = axis_reference_geometry(native, occurrence, mirrored_references)
            geometry['origin'] = [geometry['origin'][i] + origin_offset[i] for i in range(3)]
            axis_id = axis_keys.get(native_key(native, occurrence)) or 'axis-' + str(uuid.uuid4())
            visible = bool(native.isLightBulbOn and component.isConstructionFolderLightBulbOn)
            owner_parts = [part['id'] for part in model['parts'] if not occurrence or part['objectName'] == path or part['objectName'].startswith(path + '+')]
            model['constructionAxes'].append({'id': axis_id, 'name': native.name, 'componentPath': path, 'nativeToken': native.entityToken,
                'occurrenceToken': occurrence.entityToken if occurrence else None, **geometry, 'isExtended': native.isExtended, 'visible': visible, 'partIds': owner_parts})
            nodes.append({'id': 'axis:' + axis_id, 'kind': 'axis', 'name': native.name, 'axisId': axis_id, 'visible': visible})
        for child in occurrence.childOccurrences if occurrence else root.occurrences:
            descendants = children(child.component, child)
            nodes.append({'id': object_ids.get(child.entityToken) or 'object-' + str(uuid.uuid4()), 'kind': 'object', 'name': child.name,
                'componentPath': child.fullPathName, 'occurrenceToken': child.entityToken, 'visible': bool(child.isLightBulbOn), 'children': descendants})
        return nodes
    model['browserTree'] = children(root, None)


def export_design(request, folder):
    started = time.perf_counter()
    timings = {'openSeconds': 0.0, 'archiveSeconds': 0.0, 'identitySeconds': 0.0, 'meshSeconds': 0.0, 'bufferSeconds': 0.0, 'metadataSeconds': 0.0, 'axesSeconds': 0.0, 'calculatedParts': 0, 'reusedParts': 0, 'archiveReused': False, 'sourceVersionReused': False}
    previous = _app.activeDocument
    opened = False
    doc = None
    try:
        if request.get('archivePath'):
            options = _app.importManager.createFusionArchiveImportOptions(request['archivePath'])
            doc = _app.importManager.importToNewDocument(options)
            opened = True
        else:
            file_id = request.get('fileId') or (previous.dataFile.id if previous and previous.dataFile else None)
            if not file_id:
                raise RuntimeError('Open a saved Fusion cloud design or choose an F3D file.')
            cloud_file = _app.data.findFileById(file_id)
            if not cloud_file:
                raise RuntimeError('Fusion could not access the requested cloud design.')
            cloud_file = cloud_file.latestVersion
            source = request.get('source') or {}
            if request.get('projectId') and is_current_import(source, cloud_file.versionId) and not request.get('metadataOnly'):
                project = json.loads((DATA / 'projects' / (request['projectId'] + '.json')).read_text(encoding='utf-8-sig'))
                model = project['model']
                if is_current_import(model.get('source', {}), cloud_file.versionId):
                    timings.update({'reusedParts': len(model['parts']), 'archiveReused': True, 'sourceVersionReused': True, 'totalSeconds': time.perf_counter() - started})
                    write_json(folder / 'timings.json', timings)
                    yield {'phase': 'Already at Fusion v' + str(cloud_file.versionNumber), 'progress': 1,
                           'modelId': model['id'], 'projectId': request['projectId'], 'unchanged': True,
                           'parts': len(model['parts']), 'axes': len(model.get('constructionAxes', [])), 'metrics': timings}
                    return
            doc = next((d for d in _app.documents if d.dataFile and d.dataFile.versionId == cloud_file.versionId), None)
            if doc and doc.isModified:
                raise RuntimeError('The cloud design has unsaved edits in Fusion. Save it before importing the cloud version.')
            if not doc:
                doc = _app.documents.open(cloud_file, False)
                opened = True
        if not doc:
            raise RuntimeError('Fusion could not open the source design.')
        design = adsk.fusion.Design.cast(doc.products.itemByProductType('DesignProductType'))
        if not design:
            raise RuntimeError('The source document contains no Fusion design.')
        data_file = doc.dataFile
        timings['openSeconds'] = time.perf_counter() - started
        if request.get('metadataOnly'):
            if not request.get('projectId') or not data_file or data_file.versionId != request.get('source', {}).get('versionId'):
                raise RuntimeError('The saved source version changed. Import the model update before refreshing reference metadata.')
            project = json.loads((DATA / 'projects' / (request['projectId'] + '.json')).read_text(encoding='utf-8-sig'))
            model = project['model']
            model['parts'] = [part for part in model['parts'] if part['sourceStatus'] == 'active']
            reference_started = time.perf_counter()
            refresh_references(design, model, request)
            timings.update({'axesSeconds': time.perf_counter() - reference_started, 'reusedParts': len(model['parts']),
                            'archiveReused': True, 'sourceVersionReused': True, 'totalSeconds': time.perf_counter() - started})
            model['id'] = request['modelId']
            model['importedAt'] = utc_now()
            model['importMetrics'] = timings
            model_folder = DATA / 'models' / model['id']
            model_folder.mkdir(parents=True, exist_ok=True)
            write_json(model_folder / 'model.json', model)
            write_json(folder / 'timings.json', timings)
            yield {'phase': 'Native hierarchy and construction references refreshed', 'progress': 1, 'modelId': model['id'],
                   'parts': len(model['parts']), 'axes': len(model['constructionAxes'])}
            return
        model_id = request['modelId']
        model_folder = DATA / 'models' / model_id
        model_folder.mkdir(parents=True, exist_ok=True)
        archive = model_folder / 'source.f3d'
        yield {'phase': 'Saving native F3D source', 'progress': .01}
        archive_started = time.perf_counter()
        source = request.get('source') or {}
        prior_archive = DATA / source.get('archiveFile', '').lstrip('/')
        if request.get('archivePath'):
            shutil.copyfile(request['archivePath'], archive)
        elif data_file and source.get('versionId') == data_file.versionId and prior_archive.is_file():
            shutil.copyfile(prior_archive, archive)
            timings['archiveReused'] = True
        else:
            options = design.exportManager.createFusionArchiveExportOptions(str(archive))
            if not options or not design.exportManager.execute(options):
                raise RuntimeError('Fusion could not export its native F3D archive.')
        timings['archiveSeconds'] = time.perf_counter() - archive_started
        identity_started = time.perf_counter()
        known_parts = {}
        for old in request.get('knownParts', []):
            body = resolve_token(design, old.get('nativeToken'))
            occurrence = resolve_token(design, old.get('occurrenceToken'))
            if body and (not old.get('occurrenceToken') or occurrence):
                known_parts[native_key(body, occurrence)] = old
        root = design.rootComponent
        timings['identitySeconds'] = time.perf_counter() - identity_started
        occurrences = ordered_occurrences(root)
        body_entries = all_body_entries(root, occurrences)
        source_inventory = {'version': data_file.versionNumber if data_file else None,
                            'bodies': [], 'occurrences': [{'path': occurrence.fullPathName, 'visible': bool(occurrence.isLightBulbOn)} for occurrence in occurrences],
                            'excludedMeshBodies': root.meshBodies.count + sum(occurrence.component.meshBodies.count for occurrence in occurrences)}
        model = {'id': model_id, 'name': doc.name, 'sourceFile': doc.name + '.f3d', 'revision': 1,
                 'importedAt': utc_now(), 'parts': [], 'materials': [], 'materialNames': [], 'constructionAxes': [],
                 'source': {'kind': 'fusion', 'fileId': data_file.id if data_file else request.get('sourceFileId'),
                            'versionId': data_file.versionId if data_file else None, 'version': data_file.versionNumber if data_file else None,
                            'archiveFile': '/models/' + model_id + '/source.f3d', 'documentName': doc.name, 'contentScope': CONTENT_SCOPE}}
        appearance_indices = {}
        geometry_url = '/models/' + model_id + '/geometry.bin'
        with (model_folder / 'geometry.bin').open('wb') as binary:
            for part_index, (body, occurrence) in enumerate(body_entries):
                native = body.nativeObject or body
                path = occurrence.fullPathName if occurrence else root.name
                key = native_key(body, occurrence)
                prior = known_parts.get(key)
                revision = native.revisionId
                transform = list(occurrence.transform2.asArray() if occurrence else adsk.core.Matrix3D.create().asArray())
                cached = bool(revision and prior and prior.get('nativeRevision') == revision and prior.get('nativeTransform') == transform
                              and prior['geometry'].get('normalsOffset') is not None
                              and (DATA / prior['geometry']['file'].lstrip('/')).is_file())
                if cached:
                    origin = source.get('originOffset', [0, 0, 0])
                    center = [prior['home']['position'][i] - origin[i] for i in range(3)]
                    bounds = [[point[i] - origin[i] for i in range(3)] for point in prior['bounds']]
                    geometry = prior['geometry'].copy()
                    timings['reusedParts'] += 1
                else:
                    mesh_started = time.perf_counter()
                    calculator = body.meshManager.createMeshCalculator()
                    calculator.setQuality(adsk.fusion.TriangleMeshQualityOptions.HighQualityTriangleMesh)
                    calculator.surfaceTolerance = min(calculator.surfaceTolerance, .0025)
                    mesh = calculator.calculate()
                    timings['meshSeconds'] += time.perf_counter() - mesh_started
                    timings['calculatedParts'] += 1
                    if not mesh or not mesh.triangleCount:
                        raise RuntimeError('Fusion returned no mesh for ' + path + '/' + body.name)
                    buffer_started = time.perf_counter()
                    coordinates = array.array('f', mesh.nodeCoordinatesAsFloat)
                    indices = array.array('I', mesh.nodeIndices)
                    normals = array.array('f', mesh.normalVectorsAsFloat)
                    if len(normals) != len(coordinates):
                        raise RuntimeError('Fusion returned inconsistent surface normals for ' + body.name)
                    bounds = [[min(coordinates[axis::3]) * 10 for axis in range(3)], [max(coordinates[axis::3]) * 10 for axis in range(3)]]
                    center = [(bounds[0][axis] + bounds[1][axis]) / 2 for axis in range(3)]
                    for i in range(0, len(coordinates), 3):
                        coordinates[i] = coordinates[i] * 10 - center[0]
                        coordinates[i + 1] = coordinates[i + 1] * 10 - center[1]
                        coordinates[i + 2] = coordinates[i + 2] * 10 - center[2]
                    offset = binary.tell()
                    coordinates.tofile(binary)
                    indices.tofile(binary)
                    normals_offset = binary.tell()
                    normals.tofile(binary)
                    timings['bufferSeconds'] += time.perf_counter() - buffer_started
                    geometry = {'file': geometry_url, 'offset': offset, 'vertices': mesh.nodeCount, 'triangles': mesh.triangleCount, 'normalsOffset': normals_offset}
                metadata_started = time.perf_counter()
                appearance = body.appearance
                material = body.material
                color_value = appearance.color if appearance else None
                color = '#%02x%02x%02x' % (color_value.red, color_value.green, color_value.blue) if color_value else '#d6d6d2'
                appearance_key = appearance.id if appearance else color
                if appearance_key not in appearance_indices:
                    appearance_indices[appearance_key] = len(model['materials'])
                    model['materials'].append(color)
                    model['materialNames'].append(appearance.name if appearance else 'Default appearance')
                key = native_key(body, occurrence)
                part_id = 'part-' + str(uuid.uuid4())
                part = {'id': part_id, 'name': body.name, 'sourceName': body.name, 'objectName': path,
                        'objectId': occurrence.entityToken if occurrence else 'fusion-root', 'path': path + '/' + body.name,
                        'sourceObject': path + '/' + native.entityToken, 'sourceKey': prior['sourceKey'] if prior else '|'.join(key),
                        'nativeToken': native.entityToken, 'occurrenceToken': occurrence.entityToken if occurrence else None,
                        'nativeRevision': revision, 'nativeTransform': transform,
                        'geometry': geometry,
                        'home': {'position': center, 'quaternion': [0, 0, 0, 1]}, 'bounds': bounds,
                        'color': color, 'material': appearance_indices[appearance_key], 'materialName': material.name if material else None,
                        'materialId': material.id if material else None, 'appearanceName': appearance.name if appearance else None,
                        'appearanceId': appearance.id if appearance else None, 'sourceStatus': 'active', 'initiallyAssembled': False}
                if prior and prior.get('explosionOffset'):
                    origin = source.get('originOffset', [0, 0, 0])
                    part['explosionOffset'] = [prior['explosionOffset'][i] + center[i] + origin[i] - prior['home']['position'][i] for i in range(3)]
                model['parts'].append(part)
                source_inventory['bodies'].append({'partId': part_id, 'path': part['path'], 'visible': bool(body.isVisible)})
                timings['metadataSeconds'] += time.perf_counter() - metadata_started
                yield {'phase': 'Reading bodies, materials and native normals', 'part': body.name, 'completed': part_index + 1,
                       'total': len(body_entries), 'progress': .05 + .85 * (part_index + 1) / len(body_entries)}
        axes_started = time.perf_counter()
        assembly_center = [(min(p['bounds'][0][i] for p in model['parts']) + max(p['bounds'][1][i] for p in model['parts'])) / 2 for i in range(3)]
        for part in model['parts']:
            part.setdefault('explosionOffset', [part['home']['position'][i] - assembly_center[i] for i in range(3)])
        refresh_references(design, model, request)
        source_inventory['axes'] = [{'axisId': axis['id'], 'path': axis['componentPath'] + '/' + axis['name']} for axis in model['constructionAxes']]
        write_json(folder / 'source-inventory.json', source_inventory)
        timings['axesSeconds'] = time.perf_counter() - axes_started
        timings['totalSeconds'] = time.perf_counter() - started
        model['importMetrics'] = timings
        write_json(model_folder / 'model.json', model)
        write_json(folder / 'timings.json', timings)
        yield {'phase': 'Native import ready', 'progress': 1, 'modelId': model_id, 'parts': len(model['parts']), 'axes': len(model['constructionAxes'])}
    finally:
        if opened and doc:
            doc.close(False)
            if previous and previous.isValid:
                previous.activate()


class JobHandler(adsk.core.CustomEventHandler):
    def notify(self, args):
        global _pending, _generator, _job_folder, _last_heartbeat
        try:
            if time.monotonic() - _last_heartbeat > 1:
                write_json(DATA / 'fusion' / 'bridge.json', document_info())
                _last_heartbeat = time.monotonic()
            if _generator is None:
                queued = [p for p in sorted((DATA / 'fusion' / 'jobs').glob('*/request.json'))
                          if not (p.parent / 'status.json').exists()]
                if not queued:
                    return
                if _app.userInterface.activeCommand != 'SelectCommand':
                    return
                _job_folder = queued[0].parent
                request = json.loads(queued[0].read_text(encoding='utf-8-sig'))
                _generator = export_design(request, _job_folder)
                write_json(_job_folder / 'status.json', {'state': 'running', 'phase': 'Opening Fusion source', 'progress': 0})
            batch_started = time.perf_counter()
            update = None
            finished = False
            for _ in range(16):
                item = next(_generator, None)
                if item is None:
                    finished = True
                    break
                update = item
                if time.perf_counter() - batch_started >= .1:
                    break
            if finished:
                status = json.loads((_job_folder / 'status.json').read_text(encoding='utf-8'))
                status.update(update or {})
                status['state'] = 'complete'
                write_json(_job_folder / 'status.json', status)
                _generator = None
                _job_folder = None
            else:
                write_json(_job_folder / 'status.json', {'state': 'running', **update})
        except Exception:
            if _job_folder:
                write_json(_job_folder / 'status.json', {'state': 'failed', 'error': traceback.format_exc()})
            if _generator:
                _generator.close()
            _generator = None
            _job_folder = None
        finally:
            _pending = False


def poll():
    global _pending
    while not _stop.wait(.05 if _generator else 1):
        if not _pending:
            _pending = True
            _app.fireCustomEvent(EVENT_ID)


def run(context):
    global _app, _event, _handler, _thread
    if _thread and _thread.is_alive():
        return
    (DATA / 'fusion' / 'jobs').mkdir(parents=True, exist_ok=True)
    _app = adsk.core.Application.get()
    _event = _app.registerCustomEvent(EVENT_ID)
    if not _event:
        raise RuntimeError('ManualStudio Fusion Bridge is already registered.')
    _handler = JobHandler()
    _event.add(_handler)
    _stop.clear()
    _thread = threading.Thread(target=poll, name='ManualStudio Fusion Reader', daemon=True)
    _thread.start()
    write_json(DATA / 'fusion' / 'bridge.json', document_info())


def stop(context):
    global _generator
    _stop.set()
    if _generator:
        _generator.close()
        _generator = None
    if _event and _handler:
        _event.remove(_handler)
    if _app:
        _app.unregisterCustomEvent(EVENT_ID)
