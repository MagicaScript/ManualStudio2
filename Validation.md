# Validation

## Run the checks

Use the Windows launcher to prepare the locked npm packages, build, Chrome, Python and FFmpeg tools. The dependency requirements and sources are listed under [Local development](README.md#local-development). Set `MANUALSTUDIO_CHROME` if Chrome is installed at a custom path. Open a new terminal before running tests if the launcher just installed Python.

```powershell
& '.\Open ManualStudio.cmd' --test-setup
npm test
```

The build type-checks the TypeScript and generates the browser bundle in `dist/`. The test runner executes browser test files sequentially and starts isolated test servers as needed. Screenshots from browser tests are saved to the local `artifacts/` directory.

## Regression coverage

- Assembly edits cover membership, inheritance, teardown, support removal, reordering, step insertion, grouping, Final assembly, Undo and Redo.
- Browser checks exercise panel disclosure, shortcut help, selection and rename interactions, playback, the API session, and GUI editing of frames, surfaces and labels.
- Rendering tests cover projected annotations, sharp mesh normals, surface paint, section cap antialiasing, text layout, 1080p60 MP4 from the GUI and API, and exact removal endpoints in the FFmpeg fallback.
- Model tests use synthetic 3MF data, mocked Fusion imports and synthetic OGS display records. They exercise hierarchy and visibility, source-version replacement and matching, native cache line layouts, and archive restoration.

## Optional native tube check

The nested tube occlusion test reads `tests/fixtures/private/tube-occlusion.json` and the referenced local buffers under `data/models/`. The input contains two `Part` records ordered inner tube then outer sleeve, their two `Pose` values, a paint `region` and `color`, an `axis` with `origin` and `direction`, and the `sleeveRadius` in millimeters. The configured case tests paint visibility while the sleeve is installed and removed at four viewing angles. A fresh checkout without this private fixture skips that case.

Use a separate `MANUALSTUDIO_DATA` directory when preparing or replaying cases against an application instance. See [Agent Guide](Agent%20Guide.md) for the API and command-line workflow.
