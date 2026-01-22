# JSON Interpreter App (JATOS/jsPsych runtime)

Static runtime that loads a PsychJSON Builder export and runs it via jsPsych.

## How it loads configs

- Primary: `?id=YOUR_ID`
  - Loads `JSON_Interpreter_App/configs/YOUR_ID.json`
  - `id` is sanitized to `[A-Za-z0-9_-]`.

- Multi-config mode: `?id=XXXXXXX` (7 alphanumeric characters)
  - Loads all `configs/XXXXXXX-*.json`, shuffles their order, and runs them as one jsPsych session.
  - File discovery is best-effort:
    - If the server exposes a directory listing for `configs/`, it will be scraped.
    - Otherwise, create/update `configs/manifest.json` (array of filenames) and it will be used.

- Optional remote config sources (e.g., SharePoint)
  - `?base=...` sets the directory/URL used for loading configs (default: `configs`).
  - `?manifest=...` sets an explicit manifest JSON URL (recommended for SharePoint).
  - Example:
    - `index.html?id=ABC1234&base=https://your-site/configs&manifest=https://your-site/configs/manifest.json`

- Fallback: no `id` → you can upload a JSON file via the UI.

## Quick start (local)

Use VS Code Live Server on `JSON_Interpreter_App/index.html`.

Example:
- `http://127.0.0.1:5500/JSON_Interpreter_App/index.html?id=experiment_config_2026-01-16`

Multi-config example:
- `http://127.0.0.1:5500/JSON_Interpreter_App/index.html?id=ABC1234`

Debugging (local):
- Add `&debug=1` to auto-download the jsPsych data CSV on finish.
  - Example: `.../index.html?id=ABC1234&debug=1`
- Optional: `&debug=json` to download JSON instead.

If Live Server doesn't expose a directory listing, generate/update the manifest:
- PowerShell: `powershell -ExecutionPolicy Bypass -File scripts/generate-manifest.ps1`

## JATOS

When hosted inside JATOS, the page will detect `window.jatos` and will:
- submit jsPsych data via `jatos.submitResultData(...)`
- then end the study via `jatos.endStudyAjax(true)`

## Current scope / assumptions

- Supports both `experiment_type: "trial-based"` and `"continuous"`.
- `block` components are expanded up-front and sampled **per-trial**.
- Expected total scale is ~≤ 5k trials/frames.

## Files

- `index.html`: loader UI + jsPsych boot
- `src/main.js`: orchestration
- `src/configLoader.js`: load by id or file
- `src/timelineCompiler.js`: expand blocks + map to jsPsych timeline
- `src/rdmEngine.js`: dot-motion renderer used by the jsPsych plugin
- `src/jspsych-rdm.js`: custom jsPsych plugin for RDM stimuli
