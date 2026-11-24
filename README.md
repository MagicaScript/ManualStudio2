# ManualStudio Assembly

ManualStudio is a local Three.js editor for creating assembly steps, surface annotations and guides from 3D models. The desktop browser interface is based on the Assembly workspace in Bambu Studio v02.09.01.70. The HTTP API and command line use the same project documents as the editor.

## Open a project

On Windows, double-click `Open ManualStudio.cmd` in the cloned repository. You can run the same launcher from PowerShell.

```powershell
& '.\Open ManualStudio.cmd'
```

The launcher lists any dependency installs and build work before asking for confirmation. Press Enter or **Y** to prepare the workspace, or **N** to cancel. It opens Chrome or Edge when the workspace is ready.

For manual setup, use the [local development commands](#local-development) and open `http://127.0.0.1:4189`.

A fresh workspace starts empty. Use the **File** menu to create or restore a project.

- **Open 3MF or F3D…** imports a model file. F3D uses the Fusion add-in.
- **Import from Fusion cloud…** reads the latest saved version of a Fusion design through the add-in.
- **Open project archive…** restores a portable `.manualstudio` project with its geometry and authored steps.

## Assembly workspace

- Overall preview and a single 3D workspace, dark gray panels, material swatches, view presets, measurement, section planes, explosion ratio, object/part selection, move/rotate and point/face alignment.
- Section View establishes a camera-aligned cut with solid orange caps and preserved holes. Orbiting keeps the plane fixed; **Reset direction** aligns it to the new view. Hover the green keyboard icon for assembly shortcuts.
- Overall **Explosion Ratio** runs from 1 to 3 and follows the source assembly offsets. Automatic teardown inside a step uses six-axis packing with 5 mm spacing; inherited assemblies remain fixed. X-Ray uses 0.15 opacity, front-face rendering, depth testing and display-space blending.
- Assembly Structure cards with empty steps, membership selection, rename, copy, inheritance, insertion, deletion and drag reordering. Create up to 255 ordinary steps plus a dedicated Final assembly.
- Structure, List and Guide share header disclosure arrows, hover/focus feedback and a reversible 180 ms height animation. Collapsed panels show only their headers, including Guide's Timeline. Disclosure state survives frame changes; List has a separate tree expand/collapse action.
- Structure search matches step names, instructions, inherited groups, part names, paths and materials while retaining global step numbers. Clearing the search restores all cards. Searching and panel disclosure do not edit the saved project.
- The add-object picker stages checked parts, completed assemblies and canvas/list drops together. **Cancel** discards the draft; **OK** commits one batch and one Undo entry.
- **Create final assembly** creates a whole-model card after ordinary steps, seeded from their completed poses. Its Start, transition and End keyframes remain editable; explicit refresh reseeds End while preserving other frames. Source updates synchronize inventory without flattening authored animation. New operations always insert before it.
- **Merge and add steps** opens checked-card mode with Select All, Cancel and Confirm. It combines Start/End poses into a new card while retaining the original operations and their annotations/transitions. Later checked cards win overlapping poses. Full model coverage appends a new Final assembly; a previous Final becomes an ordinary step with all its authoring preserved. Merged frames have independent editable labels; **New step from selection** remains available for selected 3D parts.
- Drag a step tag into the gap between cards to reorder it. The target gap smoothly opens a full card of space. Dropping on a card or either original-position gap cancels without changing order, revision or undo history.
- Assembly list with rendered 3D thumbnails, search, unassembled filtering, selection highlighting and automatic scroll to the selected part. Native imports retain Fusion Browser occurrence nesting and order, with construction axes under their owning components. Object, body and axis rows have independent eye controls; an object's eye hides its descendants.
- Native Fusion body material names and appearance names in part properties, list rows and material swatch tooltips. Search matches either name.
- Native construction axes with source names, complete occurrence transforms, validated display-cache extents, individual visibility, selection and centering. Axes follow a rigid component move and remain fixed when its bodies are independently exploded.
- Drag parts directly from the X-Ray canvas onto a step. Drag a completed step’s assembly chip onto a later step to retain its internal arrangement as a group.
- Start, transition and end frames retain part poses, camera, annotations and duration. Record a view with **Save update**, add/delete transition frames, apply a camera to all frames, scrub, play, pause and change speed.
- Global playback and MP4 share a timeline with a 2-second cover, 1.5-second step titles, saved transitions and completed-step holds. The start frame's duration sets the completed-step hold. Later durations set their incoming transition. Local playback omits global cards. GUI, API and CLI video exports render at 1920 × 1080 with exact 60 fps sampling, including final poses and removal endpoints.
- Object/part labels with automatic placement, font size, hide/reset, per-label offsets and automatic subassembly labels.
- Surface-bound Clip, Glue, Screw, Remove, Text, Arrow, Circle, Rectangle and Pencil notes. Choose **Snap to** for points, entities, connected faces or cylindrical segments.
- Rectangle, Circle and Arrow use Bambu's seven preset colors, with hover feedback and a green selection outline. Caption backgrounds have seven darker presets for white text. Existing custom colors display their saved swatch; creation and editing use the same presets, and shape selections retain the separate glue-color default.
- Rectangle and Circle centers follow their 3D attachment while their outlines face the camera. Their millimeter dimensions scale with zoom. Shapes, arrows and caption leaders use 2 px strokes in the editor. Video scales those strokes with the annotation layer. New notes default to Bambu green; part-name leaders use the native green line and endpoint dot. Click an outline or arrowhead to edit it; hollow interiors pass through to the model.
- Glue supports whole surfaces, circular patches, axial bands and brush strokes. Repeated clicks add separate regions to one operation; each region can be removed independently. Opaque surface coverage prevents overlapping strokes from darkening. New glue marks use muted blue-violet (`#8c91b5`).
- Surface paint is shaded in the body's own draw, with analytic region-edge coverage and multisampled geometry edges. It uses the body's depth without a displaced overlay, so inserted coated tubes are occluded by their sleeves.
- Assembly Structure and Assembly Guide actions have hover and keyboard-focus feedback. Name-copy confirmations stack vertically, hold for 500 ms, then fade for 200 ms; new entries and reflow move over 120 ms.
- **Frame settings…**, **Move along axis…**, **Label positions…**, note **Placement…** and each region's **Edit…** expose precise frame/camera, construction-axis offset, label and surface-boundary editing. Region clipping planes retain the originally picked connected surface.
- **Initially assembled** establishes the starting state of printed parts and supports. **Remove** leaves the support visible at the start frame, moves and hides it at the end, and excludes it from subsequent inherited assemblies.
- PNG, PDF, Markdown with images, MP4, JSON and portable `.manualstudio` project archives. Export settings include the document title, cover image and second-page image.

## Native Fusion import and updates

Use **Fusion cloud** to read the latest saved version of the active cloud design. **Open model** also accepts an F3D archive. The installed **ManualStudioBridge** add-in must be running in Fusion; its **Run on Startup** option is enabled. Fusion remains responsible for decoding its native format. Model extraction does not create or save a new cloud version.

Native import includes every solid and surface BRep body and every construction axis, whether visible or hidden. Fusion mesh bodies are excluded. It preserves the native occurrence hierarchy and order, including empty occurrences, and keeps axes under their owning components. Fusion's local eye states, body/construction folder states and ancestor visibility determine the imported defaults. Hidden entities remain in the Assembly list and can be enabled with their eye controls. **Show axes** controls the whole construction-axis overlay.

The complete F3D source archive, physical material and appearance names, source colors, Fusion surface normals and occurrence identity tokens are retained. Construction axes remain reference geometry separate from assembly parts.

Construction-axis display ranges are read from entity-linked OGS `WorkAxis` records in the native F3D archive. Native identity, line-buffer layout, bounds and collinearity are checked before accepting a range. Definition-derived, mirrored-definition and component-bound ranges remain available when a usable display record is absent.

The command `fusion-refresh-metadata PROJECT_ID` refreshes the native browser tree and construction axes from the saved cloud design without remeshing. Apply its returned sync preview to retain the existing part geometry, authored steps and settings.

BRep viewing geometry is triangulated by Fusion's native mesh calculator at High Quality with a surface tolerance of at most 0.025 mm. Native body revision IDs and occurrence transforms permit reuse of unchanged BRep geometry. Imports run in bounded batches so progress updates do not dominate extraction time.

**Sync model → Read latest Fusion cloud version** changes the model baseline only when that cloud file's saved version changes. A normal sync of an already complete, unchanged version is a no-op: it leaves the model, project revision and authored work intact. An incomplete import can be repaired within the same source version without advancing the baseline version.

When a new saved version is applied, its full inventory becomes the baseline and local eye overrides are cleared to restore Fusion's visibility defaults. Fusion resolves prior entity tokens so surviving parts retain their ManualStudio IDs. Their step/frame IDs, cameras, authored pose offsets and annotations are preserved; deleted source parts are removed from affected memberships, poses, groups and annotations, with affected steps listed in the sync preview. New parts are not automatically inserted into existing steps. A stored origin offset retains the authored coordinate system when a project initially imported through 3MF switches to a native Fusion source.

**Overall preview** is a functional return control inside a step. It is hidden in the overall view.

## 3MF import and updates

**Open 3MF or F3D…** creates a new project when you select a 3MF file. Bambu assembly transforms are used when present. Fusion and standard 3MF files use their nested component and build transforms. Units are converted to millimeters. Source geometry and authored assembly poses remain separate. Use native Fusion import for construction axes and native material names.

**Sync model** imports an updated 3MF into a review window. Matching uses persistent source identifiers, unique paths/names and direct geometry comparison. Manual matches and explicit new parts are available. Ambiguous identical parts require a decision before applying the update.

Matched parts retain their ManualStudio IDs. Source names refresh unless the author has assigned a custom name. New parts enter the model without being inserted into existing steps. Removed source parts keep their last geometry for steps that already reference them. Step IDs, frame IDs, groups, notes, ordering and authored offsets are retained. Changed geometry rebinds surface attachments; affected painted regions are flagged for review.

Equivalent native mesh exports can reorder vertices and triangles. Synchronization compares oriented triangle geometry and normals independently of numbering, then retains the previous geometry reference for an equivalent mesh so existing painted triangle memberships remain exact.

## Keyboard and pointer controls

| Control | Action |
| --- | --- |
| Left-drag empty space | Orbit |
| Middle-drag or right-drag in the 3D workspace | Pan |
| Wheel | Zoom |
| Click / Ctrl-click | Select / toggle multiple selection |
| Shift-click in Assembly list | Select a continuous range |
| Tab / Shift+Tab in Assembly list | Next / previous part |
| Up / Down in Assembly list | Previous / next part; Shift extends the range |
| Click empty 3D space | Clear selection |
| Alt-click | Cycle overlapping parts; select an individual group member |
| Double-click a list name or 3D name tag | Rename inline; Enter or focus loss saves, Escape cancels |
| Middle-click a list row or 3D name tag | Focus that part, object or axis |
| Right-click a 3D part | Select it and open the assembly menu |
| Right-click a 3D name tag | Copy its full displayed name |
| Drag a selected part onto a step card | Add it to that step and stay in Overall preview when dragging from there |
| Drag a step tag to an insertion gap | Reorder the step |
| M / R | Move / rotate |
| F / Home | Fit selection / fit all |
| Navigator faces, edges and corners | 26 preset directions |
| Space | Play / pause |
| Left / Right arrows | Previous / next frame |
| Esc | Exit the current tool |
| Save update button | Record current frame and camera |
| Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y | Undo / redo |

Save, Undo and Redo show bordered hover-help boxes, including when a control is disabled. External CLI/API edits clear stale browser Undo/Redo snapshots so a later local undo cannot overwrite externally authored work.

Use **Insert Step** between cards to insert an operation at that position. The original cards and their keyframes retain their identities.

For a continuous motion, select an intermediate keyframe in **Assembly Guide → Timeline**, open **Frame settings…**, and enable **Pass through this keyframe**. Leave it unchecked wherever the motion should come to a stop. **Transition duration** is the time to reach the selected keyframe.

Use **Frame settings → Incoming motion** on a destination keyframe to define a rigid rotation, a parallel-link translation, a planar four-bar linkage, or travel through a fixed hole. The [Agent Guide](Agent%20Guide.md) documents the motion tracks used by both the editor and the `frame.motion` command.

In **Overall preview**, enable **Unassembled only** to show the visible source parts that are neither initially assembled nor assigned to an assembly operation. The **Final assembly** summary does not count as an operation for this filter.

The 128-pixel 3D navigator follows the camera. Its six faces, twelve edges and eight corners select all 26 preset directions. Hover highlights the corresponding region across adjoining faces. Drag the cube to orbit with Z up, including when the pointer leaves the cube. Double-click or press Enter for the isometric view. Ctrl+number, Ctrl+Tab and Ctrl+S are reserved for Chrome. Use the navigator and visible Save update control for the corresponding assembly actions.

Rendering splits normals at hard creases, preserves smooth curved surfaces with angle-weighted normals, and keeps the original triangle ordering for surface annotations. Camera-relative lighting keeps the underside readable. The viewport and export renderer share the same multisample antialiasing and fitted depth range.

Section bodies and stencil masks use sample coverage at the cutting plane so orange cap silhouettes receive antialiasing without closing real holes. PDF and Markdown exports include all saved keyframes. PDF shows up to two keyframes per page and continues long step descriptions on additional pages. Exported captions preserve full text and resolve overlapping boxes without changing saved label positions.

PDF, Markdown and video use the assembly display mode at export time and honor saved part, object and frame visibility. They omit world axes and Fusion construction references. PNG preserves the current editing view. Exporting leaves all saved eye settings and reference geometry intact.

The MP4 exporter draws the scene and labels at the output resolution. Chrome or Edge encodes H.264 directly through WebCodecs when available. On hosts without working AVC encoding, the exporter sends frames to FFmpeg. Both paths use the same timeline and video settings.

## Local development

| Dependency | Requirement | How the launcher prepares it |
| --- | --- | --- |
| Node.js and npm | Node.js 22.18 or newer with bundled npm | Offers Node.js LTS via the `OpenJS.NodeJS.LTS` WinGet package. |
| JavaScript packages | `package-lock.json` | Installs the locked versions using `npm ci`. |
| Browser | Chrome or Edge with WebGL 2, with Chrome used for browser tests | Uses an installed browser or the executable specified by `MANUALSTUDIO_CHROME`. Offers Google Chrome Stable via the `Google.Chrome` WinGet package if needed. |
| FFmpeg and ffprobe | FFmpeg 5.1 or newer with `libx264` | Uses compatible tools on `PATH`, or downloads [FFmpeg 9.0.2 Essentials](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2) to `.local/dependencies/` on Windows x64. The MP4 fallback and video tests use the downloaded tools when available. |
| Python for tests | Python 3.10 or newer | `--test-setup` offers CPython 3.14 via the `Python.Python.3.14` WinGet package if needed. |

Native import uses the separately installed [Autodesk Fusion](https://www.autodesk.com/products/fusion-360/overview) host and its Python API. See [Native Fusion import and updates](#native-fusion-import-and-updates) for the add-in setup.

To prepare the dependencies and build without opening the editor, use `& '.\Open ManualStudio.cmd' --test-setup`. Use these commands when the dependencies are already available.

```powershell
npm ci
npm run build
npm start
```

In a second terminal, run `npm run cli -- help` for automation commands or `npm test` for the regression suite. See [Validation](Validation.md) for test dependencies. `npm run dev` serves the editable interface on port 5189 and forwards API and model requests to the running server on port 4189.

After updating the code, save edits and let active exports finish. Stop the ManualStudio server listening on port 4189, then run `Open ManualStudio.cmd` again and reload any existing editor tabs. The launcher reuses a running server, so rebuilding the browser interface alone can leave an older API running. The launcher records the PID it started in `.local/server.pid`.

Projects and immutable geometry revisions live in `data/` or the directory configured with `MANUALSTUDIO_DATA`. Use a separate data directory for replay experiments. The previous project revision is retained under `data/backups/`. A portable `.manualstudio` archive includes the project document and its referenced geometry.

See [Agent Guide](Agent%20Guide.md) for the CLI and HTTP API, and [Bambu Assembly Reference](Bambu%20Assembly%20Reference.md) for the upstream behavior used as a reference.

## Limitations / Known Issues

- 3MF is a triangle-mesh format. Connected-face and cylinder detection operate on that mesh; they do not provide Fusion BRep face identities. Inspect flagged attachments after a substantial topology change.
- Native Fusion import requires the installed Fusion application, a signed-in account for cloud models, and the running ManualStudioBridge add-in. The native F3D remains available alongside the viewing geometry; editing and annotation in ManualStudio still use the extracted mesh.
- OGS display data is an undocumented native archive format. Unsupported or inconsistent records are rejected in favor of geometry-derived ranges. An axis with `isExtended=true` uses the archive's saved display range; it does not dynamically follow later Fusion viewport changes.
- The browser controls and interface icons are implemented in this repository. The Bambu Studio reference documents the upstream appearance and interactions.
- Identical, unnamed parts without persistent identifiers can require explicit matching during synchronization.
- Portable project archives use ManualStudio’s own schema. They are not Bambu Studio assembly-step interchange files.
- The workspace is intended for a desktop display. A very narrow browser side panel cannot expose both assembly panels at a useful scale.

## License

Copyright 2026 MagicaScript.

ManualStudio is licensed under the [Apache License 2.0](LICENSE).

MP4 packaging uses [Mediabunny](https://mediabunny.dev/), which is distributed under the [Mozilla Public License 2.0](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE).
