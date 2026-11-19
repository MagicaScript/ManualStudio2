# Agent Guide

ManualStudio exposes the same assembly document and command engine to the interface, HTTP API and command line. An agent can import, synchronize, edit, save and export without Computer Use.

## Start and inspect

```powershell
node tools/launch.mjs --yes --no-browser
npm run cli -- health
npm run cli -- projects
npm run cli -- get PROJECT_ID project.json
```

With Node.js and npm installed, `--yes` accepts dependency installation and frontend builds when needed. `--no-browser` starts the server without opening a browser. The default endpoint is `http://127.0.0.1:4189`. Set `MANUALSTUDIO_URL` for the CLI or `MANUALSTUDIO_PORT` for the server if another port is needed. The server binds only to loopback.

A new workspace starts empty. Import a model or open a portable archive, then use `npm run cli -- projects` to list project IDs. Use the chosen ID wherever the examples say `PROJECT_ID`. Run replay experiments against a separate API instance with an isolated `MANUALSTUDIO_DATA` directory and point `MANUALSTUDIO_URL` at that instance.

| Request | Result |
| --- | --- |
| `GET /api/health` | Application, reference version and data directory |
| `GET /api/projects` | Project summaries |
| `GET /api/projects/:id` | Complete project document |
| `POST /api/projects/:id/commands` | Preview or apply an atomic command batch with an expected revision |
| `POST /api/projects/:id/geometry` | Find parts and axes, measure a mesh surface, or generate a paint region |
| `POST /api/projects/:id/motion-check` | Check sampled motion against selected obstacle parts |
| `PUT /api/projects/:id` | Replace the document using `{project, expectedRevision}` |
| `GET/PUT /api/projects/:id/session` | Inspect or set the visible step, frame, selection and display mode |
| `GET /api/events` | Live project and selection updates |
| `POST /api/import?name=Model.3mf` | Import raw 3MF bytes into an empty project |
| `POST /api/projects/:id/sync?name=Updated.3mf` | Import raw bytes and return a synchronization preview |
| `POST /api/sync/:id/resolve` | Apply explicit new-to-old part matches and return a revised preview |
| `POST /api/sync/:id/apply` | Apply the reviewed update |
| `GET /api/projects/:id/archive` | Download a portable project archive |
| `POST /api/open-archive` | Open raw portable-archive bytes as a new project |
| `POST /api/render` | Start an independent browser renderer for exports, scoped previews or label coordinates |
| `GET /api/render/:jobId` | Export status and the saved file’s path/URL |
| `GET /api/fusion/status` | Fusion reader connection, active cloud file and latest version |
| `POST /api/fusion/import` | Queue a native cloud import with optional `fileId` and `projectId` for sync |
| `POST /api/fusion/import?name=Model.f3d` | Queue raw native F3D bytes; optional `project=PROJECT_ID` requests a sync preview |
| `GET /api/fusion/jobs/:jobId` | Progress, failure, completed `projectId` / `syncPlanId`, `unchanged`, and import `metrics` |
| `GET /api/sync/:syncPlanId` | Read the prepared model update before applying |

## Native Fusion workflow

```powershell
npm run cli -- fusion-status
npm run cli -- fusion-import CLOUD_FILE_ID
npm run cli -- fusion-job JOB_ID
npm run cli -- fusion-sync PROJECT_ID
npm run cli -- fusion-refresh-metadata PROJECT_ID
npm run cli -- fusion-job JOB_ID
npm run cli -- fusion-plan SYNC_PLAN_ID
npm run cli -- sync-apply SYNC_PLAN_ID
npm run cli -- import-f3d "D:\Models\Assembly.f3d"
```

The installed `ManualStudioBridge` add-in reads requests on Fusion's main thread and writes immutable model geometry and a native F3D archive locally. It never saves the cloud design. A cloud import uses the latest saved version. An open modified source must be saved before extraction; unchanged-version reuse does not read unsaved edits. Starting the installed add-in is a one-time desktop setup; ordinary imports and updates use the CLI/API.

The native import contract includes **all solid and surface BRep bodies and construction axes**, regardless of visibility. Exclude Fusion `MeshBody` objects. Preserve native occurrence order and nesting, including empty occurrences. Visibility is metadata, never an inventory filter. Local eye states, body/construction folder states and ancestor visibility establish the source defaults.

`Model.source.contentScope = 'brep-bodies-and-axes'` identifies a complete import. A normal cloud sync of that same saved version returns `unchanged:true` and the existing `projectId`; it does not create a new model baseline, sync preview or project revision. An incomplete import must first undergo a full same-version repair. Only a changed saved version of the same cloud file advances the baseline.

Completed native jobs expose `metrics`: extraction time, mesh-calculation time, calculated/reused body counts and cloud-version reuse. BRep meshes retain Fusion High Quality and a maximum surface tolerance of 0.025 mm. `Part.nativeRevision` and `nativeTransform` permit BRep cache reuse and are not user-authored identifiers. Retain referenced geometry files when archiving a project: a new native revision can share immutable meshes with earlier model folders.

`Part.materialName` / `materialId` identify the physical material. `appearanceName` / `appearanceId` identify the visual appearance. `Model.materialNames` names the appearance swatches. `nativeToken` and `occurrenceToken` are resolved inside Fusion on subsequent imports; do not treat token-string equality as the only identity test.

`Model.constructionAxes` contains named reference lines in model coordinates: `origin`, normalized `direction`, display `extent` in millimeters, source visibility and owning `partIds`. Settings `showConstructionAxes` and `constructionAxisVisibility` control their display. `Model.source` records the cloud lineage/version, native `archiveFile`, and optional `originOffset`. The offset maps native Fusion coordinates in millimeters into the existing authored project coordinate system.

Axis `extentSource` identifies `display-cache`, `definition`, `mirrored-definition` or `component-bounds`; `isExtended` preserves Fusion's source display mode. Cached ranges are independently validated against the native infinite line before applying occurrence transforms and the project origin offset.

`Model.browserTree` stores the ordered occurrence hierarchy with `object`, `part` and `axis` nodes, including hidden entities and empty occurrences. Axis nodes appear under their owning occurrence. Source visibility stays on the nodes and axes; `settings.objectVisibility`, `partVisibility` and `constructionAxisVisibility` hold local eye overrides. Hidden object ancestors also hide their bodies and axes, while a body eye does not hide a sibling axis. The shared `modelVisibility()` function is used by the list and viewport. Applying a new source-version baseline clears these overrides and enables the construction-axis overlay so Fusion's imported defaults take effect.

`fusion-refresh-metadata` submits `{projectId, metadataOnly:true}` to `/api/fusion/import`. It requires a complete import and refreshes axes and browser metadata from the same saved native source, reusing all geometry. Read its `syncPlanId`, inspect it with `fusion-plan`, then use `sync-apply`. This explicit metadata refresh preserves authored frames, notes, part IDs and the original coordinate offset without advancing the source-version baseline.

## Command batches

Write one command or an array of commands to a JSON file, then run:

```powershell
npm run cli -- command PROJECT_ID commands.json
npm run cli -- command PROJECT_ID commands.json --preview
```

The CLI reads the current revision before submitting. HTTP callers submit `{ "expectedRevision": 12, "commands": [...] }`. A `409` response means the project changed; reread and reconcile before retrying. The batch is applied to one document and saved atomically. Open interfaces refresh automatically.

Add `preview: true` to evaluate the same commands without saving or incrementing the revision. The response includes the proposed project, command results, affected step and frame IDs in `changes.steps`, and pose/visibility differences in `changes.handoffWarnings`. Handoff checks compare shared parts from one playback step's End to the next step's Start, using thresholds of 0.001 mm and 0.01°. Preview an empty command array to audit all current handoffs. When applying a reviewed batch over HTTP, pass the same `expectedRevision` as the preview.

`shared/types.ts` is the definitive schema. `shared/document.ts` implements the commands.

| Command | Fields besides `type` |
| --- | --- |
| `model.pose` | `poses: {partId: Pose}` |
| `step.add` | Optional `name`, `parts`, `before`, `after`, `inherit` |
| `step.rename` | `stepId`, `name` |
| `step.description` | `stepId`, `text` |
| `step.delete` | `stepId` |
| `step.reorder` | `stepId`, optional `before` |
| `step.copy` | `stepId`, optional `inherit: true` |
| `step.merge` | `stepIds` containing at least two saved cards; optional `camera` supplies the framing direction |
| `step.members` | `stepId`, complete `partIds` array |
| `step.group` | `stepId`, `sourceStepId` of an earlier completed assembly |
| `step.final` | `stepId` of an existing step, `value:true` creates or refreshes the dedicated Final assembly and returns its ID; `value:false` removes that summary |
| `part.rename` | `partId`, `name` |
| `object.rename` | `nodeId`, `name` |
| `axis.rename` | `axisId`, `name` |
| `group.rename` | `stepId`, `groupId`, `name` |
| `part.initial` | `partIds`, `value` |
| `part.remove` | `stepId`, `partIds`, `value` |
| `frame.add` | `stepId`, `afterId`, optional new `frameId` for later commands in the same batch |
| `frame.delete` | `stepId`, `frameId` of a transition frame |
| `frame.update` | `stepId`, `frameId`, `patch` containing poses, hidden IDs, `xrayPartIds`, camera, duration, image or name |
| `frame.transform` | `stepId`, `frameId`, ordered `motions` of selected parts or step groups |
| `frame.cameraAll` | `stepId`, `camera` |
| `note.put` | `stepId`, `frameId`, complete `note` |
| `note.update` | `stepId`, `frameId`, `noteId`, property `patch` |
| `note.delete` | `stepId`, `frameId`, `noteId` |
| `settings.update` | `patch` |

`step.final` never converts the referenced ordinary step. Its name, ID, membership and frames remain intact. Final assembly is unique, includes every active baseline body and stays after ordinary steps. Creation seeds its poses from the latest completed operations. Explicit refresh reseeds only its End and removal visibility; independently authored Start and transition frames remain intact. Inventory synchronization adds/prunes bodies while preserving surviving frame poses. Final keyframes, cameras, labels and annotations are editable. Editing Final End poses also updates `Part.assemblyHome`, leaving the native `home` and ordinary frames unchanged. Ordinary insertions/copies/reorders stay before Final; it cannot be copied, inherited, reordered or assigned a subset of members.

`step.merge` is the native checked-card operation. Sources are processed in document order regardless of click or command-array order. Partial coverage inserts a new **Merged Step** after the last selected card: its two frames combine source Start/End poses, and later sources win overlaps. Source transitions and annotations remain in their original cards; they are not copied. The new frames receive fitted cameras and their own editable label presentation. Full active-baseline coverage appends a fresh Final assembly with the composite Start/End. If Final already exists, only its `final` flag changes to false: its ID, frames, transitions and annotations remain intact as an ordinary step. This requires an available ordinary-step slot. Every other source record remains unchanged. The operation is one command batch and one Undo entry.

`Keyframe.labels`, when present, contains frame-local `showLabels`, `labelMode`, `labelFontSize`, `labelOffsets` and `hiddenLabels`. Viewport, exports and label editors use it; otherwise they use project settings. Merge initializes local labels so rebuilding the new composition does not move labels on source operations.

The add-object picker stages individual checks and completed assemblies together. Cancel and Escape discard that draft without saving. OK sends the grouped additions and final membership in one command batch and one Undo entry.

Example: create a support-removal operation using IDs from the loaded model:

```json
[
  {"type":"part.initial","partIds":["PART_ID","SUPPORT_ID"],"value":true},
  {"type":"step.add","name":"Remove printed supports","parts":["PART_ID","SUPPORT_ID"]}
]
```

The response’s `results` array supplies newly created step/frame IDs. Next set `part.remove` on the support and use `step.copy` with `inherit:true` to create the following step. The inherited group excludes removed supports and retains the end-frame poses.

Reordering before the same step or into its existing position is a no-op. A batch containing only unchanged `step.reorder` operations does not increment the project revision. Incoming external edits clear local browser Undo/Redo history; normal echoes of the browser's own saves preserve it.

### Author motion in a batch

Each motion takes `partIds`, `groupIds`, or both. It can apply `translation` in world millimeters, a signed `distance` along an axis, and a right-hand `angleDegrees` about that axis. When combined, rotation precedes translation. An axis can be `{ "axisId": "AXIS_ID" }` for a construction axis or `{ "origin": [0,0,0], "direction": [0,0,1] }` in world coordinates. Add `partId` to an explicit axis to express it in that part's local coordinates. References resolve from the target keyframe's poses before each motion. The members receive the same rigid transform at that keyframe. Between saved frames, playback interpolates their individual poses. Place additional keyframes where the path needs to follow an arc.

```json
[
  {"type":"frame.add","stepId":"STEP_ID","afterId":"START_ID","frameId":"insert-aligned"},
  {"type":"frame.transform","stepId":"STEP_ID","frameId":"insert-aligned","motions":[
    {"groupIds":["INSERT_GROUP_ID"],"axis":{"axisId":"SPINDLE_AXIS_ID"},"distance":18,"angleDegrees":15}
  ]},
  {"type":"frame.update","stepId":"STEP_ID","frameId":"insert-aligned","patch":{
    "duration":0.8,"hidden":[],"xrayPartIds":["SLEEVE_ID"],"camera":{"eye":[40,-50,45],"target":[0,0,0],"up":[0,0,1],"margin":1.1}
  }}
]
```

Append a `note.put` with the same frame ID to set an annotation in that batch.

## Geometry and annotations

Coordinates use millimeters, Z-up, and quaternions `[x,y,z,w]`. `Part.home` is the imported source pose. `Part.assemblyHome` is an optional authored assembly baseline. `Keyframe.poses` are the displayed world poses for that frame.

Each `GeometryRef` points to an immutable binary file. At `offset`, read `vertices * 3` little-endian Float32 positions, followed by `triangles * 3` little-endian Uint32 indices. Native Fusion imports additionally store `vertices * 3` Float32 surface normals at `normalsOffset`. Geometry is local to the part center. The geometry URL can be fetched from the same server. `shared/surfaces.ts` provides connected-surface selection and cylinder-axis inference in both Node and the interface.

### Query a model or measure a surface

Send JSON to `POST /api/projects/:id/geometry`, or use `npm run cli -- geometry PROJECT_ID query.json`. Each operation accepts an optional `frameId` and `progress` from 0 to 1 for the outgoing keyframe transition. Omitting the frame uses the assembled overview pose. All responses include the project revision. Optionally set `expectedRevision` to pin a query to a revision.

| Operation | Input and result |
| --- | --- |
| `find` | Optional case-insensitive `query` searches names, IDs and hierarchy paths. Returns objects, parts with their world poses, and construction axes with their origin, direction and axial extent. Optional `referencePartId` adds each part's column-major `localToReference` matrix and each axis in that part's local coordinates. |
| `surface` | Pass `partId` and either a zero-based `triangle` index or a 3D `point` with `space: "local"` (default) or `"world"`. A point snaps to the nearest triangle. Returns a part-local anchor, its world point/normal, connected triangles, bounds and area. `angleDegrees` defaults to 25. Pass explicit `triangles` containing the seed to measure a known selection, or `includeMesh: true` to return its individual triangle vertices. A recognizable cylinder also returns the fitted diameter, axis, axial range and maximum radial fit error in millimeters. |
| `paint` | Uses the same surface selector. Accepts `band: {range: [min, max], axis?}` and optional `clipPlanes`. The result includes a `note.put`-ready `anchor`, actually covered triangles, local bounds, area in mm² and the retained axial range for a band. Zero coverage returns `anchor: null`. |

A band's range is measured along the supplied axis from its origin in millimeters. Omitting the axis uses the fitted cylinder's origin and direction returned from `surface`. Each clip plane keeps `dot(normal, point) + constant <= 0` in the requested `space`. Run one paint query per disjoint region and put the resulting anchors in the same glue note.

```json
{
  "operation":"paint",
  "partId":"SLEEVE_ID",
  "triangle":42,
  "band":{"axis":{"axisId":"SPINDLE_AXIS_ID"},"range":[2,12]},
  "clipPlanes":[{"normal":[1,0,0],"constant":0}]
}
```

Annotations store `Anchor.partId`, a local `point`, local `normal`, `triangle` index and `target` (`point`, `part`, `face`, `band`). A surface `region` stores its connected triangles, center, normal, circle radius, cylinder axis and band width. A single glue note may have multiple anchors/regions. A label’s `offset` is in display pixels; it does not replace the 3D attachment.

```json
{
  "type":"note.put",
  "stepId":"STEP_ID",
  "frameId":"FRAME_ID",
  "note":{
    "id":"note-adhesive",
    "kind":"glue",
    "text":"Apply adhesive to this band.",
    "color":"#8c91b5",
    "background":"#30343c",
    "size":5,
    "offset":[30,-40],
    "anchors":[{
      "partId":"PART_ID",
      "point":[0,0,20],
      "normal":[1,0,0],
      "target":"band",
      "triangle":0,
      "region":{
        "kind":"band",
        "triangles":[0,1],
        "center":[0,0,20],
        "normal":[1,0,0],
        "radius":5,
        "axis":[0,0,1],
        "width":10
      }
    }]
  }
}
```

The numeric values and triangle IDs above illustrate the schema; derive actual values from the target geometry. Surface notes must reference parts belonging to the selected step.

`SurfaceRegion.clipPlanes` optionally trims a painted region to mating boundaries without changing mesh triangle IDs. Each entry is `{normal: Vec3, constant: number}` in the part's local coordinates; retain points where `dot(normal, point) + constant <= 0`. Use normalized normals. A cylinder band can therefore terminate at an oblique panel seam while excluding its non-contact surface.

## Motion and clearance checks

Send JSON to `POST /api/projects/:id/motion-check`, or use `npm run cli -- motion-check PROJECT_ID check.json`. Select `moving: {partIds?, groupIds?}` and `obstaclePartIds`. Use `stepId` to resolve step groups, and `frameId` to choose a starting keyframe when needed. With only a step ID, motion checks start at that step's Start frame. A check without either ID starts at the assembled overview pose. Add `expectedRevision` to check a specific revision.

| Path `kind` | Motion |
| --- | --- |
| `saved` | Check transitions in the selected step through its End or an optional `path.toFrameId`. Use the saved poses of both moving and obstacle parts at each sampled time. |
| `insertion` | Translate the moving parts by `path.distance` along `path.axis`. Obstacles keep their starting poses. `path.duration` defaults to one second. |
| `waypoints` | Follow `path.waypoints`, an ordered array of `{duration, poses}` objects. Each pose is an absolute world pose for a moving member. Unspecified poses carry forward and obstacles stay fixed. This accepts a candidate path without saving keyframes. |

```json
{
  "frameId":"START_ID",
  "moving":{"groupIds":["INSERT_GROUP_ID"]},
  "obstaclePartIds":["SLEEVE_ID","STOP_ID"],
  "path":{"kind":"insertion","axis":{"axisId":"SPINDLE_AXIS_ID"},"distance":18},
  "minimumClearance":0.2,
  "sampleRate":60,
  "allowedContacts":[["PIN_ID","SLEEVE_ID"]]
}
```

The result reports the measured minimum clearance, first violation time, part IDs and closest points in world coordinates. Each pair lists its own minimum and first contact. Surface crossings and contact report zero clearance, with containment also detected for closed meshes. Include a pair under `allowedContacts` to report it without applying the clearance or contact rejection to that pair. Hidden and X-Ray state affect presentation, so supply only the parts you want checked. Each transition uses playback easing and includes both endpoints at the requested sampling density, 30 samples per second by default. Short contacts between samples can require a higher rate. Measurements use the imported triangle meshes.

## Synchronization

```powershell
npm run cli -- sync PROJECT_ID "D:\Models\Assembly Updated.3mf"
npm run cli -- sync-resolve SYNC_ID mapping.json
npm run cli -- sync-apply SYNC_ID
```

`mapping.json` is an object mapping incoming part IDs to existing stable IDs. Use the value `"new"` to explicitly create a separate part. Inspect `matches`, `added`, `removed` and `unresolved` before applying. The plan is tied to the current project revision.

Do not regenerate step IDs or rewrite memberships to incoming IDs. Synchronization performs the identity rebinding, updates names/geometry, preserves authored offsets and rebinds changed surface anchors. `needsReview` identifies attachments that should be inspected after topology changes.

For a changed saved Fusion version in the same file lineage, `replacesBaseline:true` means the incoming inventory replaces the previous inventory. Deleted parts are removed from step membership, frame poses/hidden lists, groups and attached annotations; the preview's `removedFromSteps` identifies affected steps, parts and notes. Surviving step/frame IDs, cameras and authored content are retained. Same-version completeness repair does not remove existing inventory or advance the baseline. A 3MF update retains source-removed parts for steps that still reference them.

When a mesh only changes vertex or triangle ordering, the comparison preserves oriented triangles and supplied normals, and the original geometry reference is retained. This keeps triangle-bound notes and painted regions unchanged without treating real shape, winding, normal or connectivity changes as equivalent.

## Exports without UI control

```powershell
npm run cli -- render PROJECT_ID pdf
npm run cli -- render PROJECT_ID mp4 xray
npm run cli -- render-status JOB_ID
```

Valid kinds are `png`, `pdf`, `markdown`, `mp4` and `json`. A separate headless Chrome/Edge renderer loads the same document without controlling the author’s browser. The result includes a local path and download URL. Both the GUI and the API render H.264 MP4 at 1920 × 1080 and 60 fps. The renderer uses WebCodecs when H.264 encoding is available and falls back to FFmpeg otherwise. Set `MANUALSTUDIO_CHROME` if Chrome/Edge is installed in another location.

Global video playback includes a 2-second cover and 1.5-second step titles. `Keyframe.duration` on a start frame controls the completed-step hold; durations on later frames control their incoming transitions. `shared/playback.ts` supplies the same plan to the interface and exporter. The exporter samples the timeline at 60 fps independently of rendering speed. CLI renders use 1× and interface exports use the selected playback speed. Title durations remain fixed while transitions and holds scale with speed.

An unscoped PNG uses the selected session frame if set. PDF, Markdown and MP4 traverse the saved frames and use the assembly display mode captured when export starts. `POST /api/render` accepts an optional `display` of `xray`, `current` or `all`. Without an override, the job uses the session display, the saved project default or `xray`, in that order. The CLI accepts the same optional value after the export kind.

### Render part of a timeline

Pass `scope` to `POST /api/render`, or give the CLI a JSON file after the display argument.

```powershell
npm run cli -- render PROJECT_ID png current frame-scope.json
npm run cli -- render PROJECT_ID mp4 current clip-scope.json
```

| Scope | PNG | MP4 |
| --- | --- | --- |
| `{"stepId":"STEP_ID"}` | Step Start | Step motion and completed-step hold, without title cards |
| `{"frameId":"FRAME_ID"}` | Saved keyframe, with optional `progress` from 0 to 1 | Outgoing transition, or completed-step hold for an End frame |
| `{"stepId":"STEP_ID","time":1.2}` | Frame at a time in seconds | |
| `{"stepId":"STEP_ID","range":[0.4,2.1]}` | | Specified time range in seconds, retaining the source transition easing |

For `time` or `range`, omitting `stepId` selects the global playback timeline including cover and step titles. Scoped PNG frames use the same 1920 × 1080 composition as MP4. Scope jobs capture the document revision when queued and report an error if it changes before the renderer loads it. The scope controls navigation in the independent renderer while the author keeps their editing view. Read file results with `render-status` or `GET /api/render/:jobId`.

### Keyframe X-Ray and default display

Use `frame.update` with `patch: { "xrayPartIds": ["PART_ID"] }` to make those parts translucent in one keyframe. The list replaces the previous list. Use `[]` to restore opaque parts. Each ID must belong to that step. Visibility takes precedence, so a hidden part stays hidden even when its ID is listed. Keyframe X-Ray works in all three display modes and follows the start keyframe until playback reaches the next one.

Use `settings.update` with `patch: { "defaultDisplayMode": "current" }` to open the project's steps in **Current Step Parts Only**. Both settings travel in a project archive. In the GUI, **Assembly options → Default assembly display** saves the project default. Right-click selected parts in the viewport or Assembly list and choose **X-Ray in this keyframe** or **Restore opacity in this keyframe**.

### Label coordinates

```powershell
npm run --silent cli -- label-layout PROJECT_ID FRAME_ID "0,0.25,0.5,0.75,1" xray
```

`FRAME_ID` selects the start of a transition. Each progress value ranges from `0` at that frame to `1` at the next frame in the same step. An end frame returns its held layout. The command prints JSON containing the sampled time in seconds, viewport dimensions and the visible tags. Each tag includes its ID, text, `x`, `y`, `width`, `height`, `anchorX` and `anchorY` in CSS pixels, measured from the upper left of the 1920 × 1080 export viewport. These positions include camera projection, authored offsets and automatic avoidance. Export scales the original 1600 × 938 annotation layout uniformly by output height and centers it in the frame. Scoped PNG previews and MP4 frames use the same composition and reported coordinates.

API callers submit `{ "projectId": "PROJECT_ID", "kind": "label-layout", "frameId": "FRAME_ID", "progress": [0, 0.5, 1], "display": "xray" }` to `POST /api/render` and read `result.layout` from `GET /api/render/:jobId`. Keep a note ID consistent across adjacent keyframes to ease its position between them. Adding a keyframe copies its notes with their existing IDs.

To set the visible frame or selection from the CLI:

```powershell
npm run cli -- open-step PROJECT_ID STEP_ID
npm run cli -- select PROJECT_ID PART_ID
```

The browser also exposes `window.manualStudio` for authorized local development: `getProject`, `getSession`, `command`, `openStep`, `selectParts`, `capture`, `export` and `view`. Normal agent work should use the CLI/API.

An external step/frame session update stops active playback and restores the target frame's saved camera. Selection-only updates retain playback and the current camera. Session notifications contain `changes` and a sender `origin`; the editor ignores its own echoes, so a delayed local notification cannot overwrite a newer local view.

Session updates also accept `section` (0–1), optional world-space `sectionNormal`, and `frameProgress` (0 inclusive to 1 exclusive), interpolating from the selected keyframe toward the next frame in the same step. Cross-step intervals hold the completed frame. GUI section and timeline changes publish the same state used by CLI PNG rendering. Progress is relative to a stable frame ID rather than a global timeline index. Selecting an explicit step/frame without progress clears the previous fractional preview. A new step resets selection and the section plane unless those fields are provided explicitly.

The GUI exposes numeric authoring through Timeline **Frame settings…**, Step details **Move along axis…**, Label **Label positions…**, note **Placement…**, and painted-region **Edit…**. Axis offsets are absolute from the first selected part's assembly position; other selected parts receive the same translation. Region editing preserves the picked triangle set and supports local clipping planes. These controls submit the same revision-checked commands as the CLI.

Surface paint uses a render-only indexed clone with unchanged triangle order and positions. A per-triangle mask texture and analytic region boundaries color the source material in one body draw. Source geometry and anchors remain unchanged. Each painted material binds fresh frame uniforms, even when successive frames use the same shader layout with different clipping planes.
