# JSON Interpreter App (JATOS/jsPsych runtime)

Static runtime that loads a PsychJSON Builder export and runs it via jsPsych.

## How it loads configs

- Primary: `?id=YOUR_ID`
  - Loads `JSON_Interpreter_App/configs/YOUR_ID.json`
  - `id` is sanitized to `[A-Za-z0-9_-]`.

- Fallback: no `id` → you can upload a JSON file via the UI.

## Quick start (local)

Use VS Code Live Server on `JSON_Interpreter_App/index.html`.

Example:
- `http://127.0.0.1:5500/JSON_Interpreter_App/index.html?id=experiment_config_2026-01-16`

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
