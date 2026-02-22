<p align="center">
  <img src="img/logo_dark.png" alt="CogFlow" width="280" />
</p>

# CogFlow Interpreter App (JATOS/jsPsych runtime)

Static runtime that loads a CogFlow Builder export and runs it via jsPsych.

## Repositories

- Interpreter repo: https://github.com/KSalibay/json-interpreter-app
- Builder repo: https://github.com/KSalibay/json-builder-app

## Recent highlights (Feb 2026)

- N-back support added end-to-end (compilation + runtime rendering) for both **trial-based** and **continuous** N-back exports.
- Fixation cross support added as an ITI visual marker via `show_fixation_cross_between_trials`.
- UI/theming improvements aligned with the CogFlow palette and typography updates (to match Builder exports and improve readability).

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
  - If eye tracking is enabled, debug mode also downloads a second gaze-only JSON file: `cogflow-eye-tracking-...json`.
  - Debug mode also shows an on-screen eye-tracking HUD (when eye tracking is enabled) to confirm that samples are accumulating.

Validation (local):
- Add `&validate=1` to run a quick console self-check of adaptive blocks (QUEST/staircase) and Gabor parameter propagation.
  - This compiles a separate timeline for validation so it does not affect the real run.
- Use `&validate=only` to run validation without starting the experiment.
- Example sample configs included (single-task to match Builder validators):
  - Gabor QUEST: `.../index.html?id=sample_adaptive_gabor_quest&validate=1&debug=1`
  - RDM staircase: `.../index.html?id=sample_adaptive_rdm_staircase&validate=1&debug=1`

If Live Server doesn't expose a directory listing, generate/update the manifest:
- PowerShell: `powershell -ExecutionPolicy Bypass -File scripts/generate-manifest.ps1`

## SOC Dashboard (Feb 2026)

The interpreter includes a custom jsPsych plugin that renders a multi-window “SOC desktop” inside a single jsPsych trial.

- Timeline `type`: `"soc-dashboard"` (plugin: `src/jspsych-soc-dashboard.js`)
- Compiled by: `src/timelineCompiler.js` (loads `window.jsPsychSocDashboard`)
- Optional global defaults: top-level `soc_dashboard_settings` is merged into each SOC Dashboard trial.

### Included sample configs

- `.../index.html?id=sample_soc_sart_10s&debug=1`
- `.../index.html?id=sample_soc_nback_10s&debug=1`
- `.../index.html?id=sample_soc_pvt_like_01&debug=1`
- Overlap demo (scheduled windows): `.../index.html?id=sample_soc_nback_sart_overlap&debug=1`

Optional SOC debug overlay:

- Add `&soc_debug=1` to show additional per-window debug text inside SOC subtasks.
- `&debug=1` also enables SOC debug text.

Note: pass the config id **without** the `.json` suffix.

### Subtasks (inside `subtasks[]`)

Implemented subtask types:

- `sart-like` — log triage Go/No-Go
  - GO commits a triage action that is consistent for the whole run:
    - `go_condition: "target"`  → GO yields `ALLOW`
    - `go_condition: "distractor"` → GO yields `BLOCK`
  - `show_markers` (default false) toggles target/distractor badges.
  - `instructions` supports placeholder substitution: `{{GO_CONTROL}}`, `{{TARGETS}}`, `{{DISTRACTORS}}`.

- `nback-like` — alert correlation ($n$-back)
  - `match_field: "src_ip" | "username"`
  - `response_paradigm: "go_nogo" | "2afc"`
  - `instructions` supports placeholders: `{{GO_CONTROL}}`, `{{NOGO_CONTROL}}`, `{{N}}`, `{{MATCH_FIELD}}`.

- `flanker-like` — traffic spikes monitor (flanker-inspired “center vs flankers” decision)
  - Keys:
    - `allow_key` (default `f`)
    - `reject_key` (default `j`)
  - Timing:
    - `response_window_ms` (window where a response is accepted)
    - `trial_interval_ms` (cadence)
    - `num_trials` (optional; if provided with a scheduled duration, trials are distributed across the run)
  - Logic:
    - `reject_rule: "high_only" | "medium_or_high"`
    - The “Reject?” prompt is only visible during the response window and self-heals if a render bug would otherwise leave it stuck on screen.
  - Logging: responses are integrated into trial events (with RT/correctness), and late responses can be attached to the most recent just-ended trial.

- `wcst-like` — phishing-style email sorting (WCST-inspired rule discovery + shifts)
  - Response mode:
    - `response_device: "keyboard" | "mouse"`
    - Keyboard: `choice_keys` (4 keys for targets; default `1,2,3,4`)
    - Mouse: `mouse_response_mode: "click" | "drag"`
  - Participant support:
    - Optional in-window help overlay: `help_overlay_enabled`, `help_overlay_title`, `help_overlay_html`
  - Researcher-provided example libraries (optional):
    - Sender identity: `sender_domains`, `sender_display_names`
    - Email text: `subject_lines_neutral|urgent|reward|threat`, `preview_lines_neutral|urgent|reward|threat`
    - Link/attachment labels: `link_text_*`, `link_href_*`, `attachment_label_pdf|docm|zip`

- `pvt-like` — incident alert monitor (PVT-inspired vigilance)
  - Goal: respond as fast as possible when the red flash appears; early responses count as false starts.
  - Parameters:
    - `response_device: "keyboard" | "mouse"`, `response_key`
    - `countdown_seconds`, `flash_duration_ms`, `response_window_ms`
    - `alert_min_interval_ms`, `alert_max_interval_ms`
    - `show_countdown`, `show_red_flash`
  - Data: emits trial-level events and also writes summary stats under `subtasks_summary.pvt_like`.

### Scheduling (automatic window show/hide)

Each subtask can include optional timing fields to automatically show/hide the window during the SOC Dashboard trial:

- `start_at_ms` or `start_delay_ms`
- `duration_ms` (preferred) or `end_at_ms`

If any timing field is set, the window is scheduled:

- The window appears/disappears automatically based on the schedule.
- The **subtask itself does not start** until the participant clicks its instruction popup (if `instructions` is non-empty). This anchors `t_subtask_ms` to a true, participant-controlled start.

### Data output

SOC Dashboard data is written into the trial’s `events` array. Key event types include:

- Window lifecycle: `subtask_window_show`, `subtask_window_hide`
- SART-like: `sart_subtask_start`, `sart_present`, `sart_response`, `sart_miss`, `sart_subtask_end`
- N-back-like: `nback_subtask_start`, `nback_present`, `nback_response`, `nback_no_response`, `nback_subtask_end`
- Flanker-like: `flanker_subtask_start`, `flanker_present`, `flanker_response`, `flanker_no_response`, `flanker_late_response`, `flanker_subtask_forced_end`
- WCST-like: `wcst_subtask_start`, `wcst_present`, `wcst_response`, `wcst_omission`, `wcst_rule_change`, `wcst_subtask_forced_end`
- PVT-like: `pvt_like_subtask_start`, `pvt_like_alert_scheduled`, `pvt_like_countdown_start`, `pvt_like_flash_onset`, `pvt_like_response`, `pvt_like_false_start`, `pvt_like_timeout`, `pvt_like_subtask_auto_end`, `pvt_like_subtask_forced_end`

## Trial-based tasks (Feb 2026)

The interpreter includes additional jsPsych plugins for trial-based tasks compiled from CogFlow Builder exports.

### Included sample configs

- Stroop: `.../index.html?id=sample_stroop_01&debug=1`
- Simon: `.../index.html?id=sample_simon_01&debug=1`
- PVT: `.../index.html?id=sample_pvt_01&debug=1`
- N-back (trial-based): `.../index.html?id=sample_nback_trial_based&debug=1`
- N-back (continuous): `.../index.html?id=sample_nback_continuous&debug=1`

### Component types

- `stroop-trial` (plugin: `src/jspsych-stroop.js`)
- `simon-trial` (plugin: `src/jspsych-simon.js`)
- `pvt-trial` (plugin: `src/jspsych-pvt.js`)
- `nback-block` (plugins: `src/jspsych-nback.js` for trial-based, `src/jspsych-nback-continuous.js` for continuous)

### Experiment-wide defaults

Builder exports task-specific defaults at the top level (merged into each trial when fields are missing):

- `stroop_settings`
- `simon_settings`
- `pvt_settings`
- `nback_settings`

### PVT blocks and false-start compensation

If `pvt_settings.add_trial_per_false_start === true` and a `block` generates `pvt-trial`, the compiler uses a jsPsych loop so the block produces the requested number of **valid** trials (false starts do not count toward the target).

## JATOS

When hosted inside JATOS, the page will detect `window.jatos` and will:
- submit jsPsych data via `jatos.submitResultData(...)`
- then end the study via `jatos.endStudyAjax(true)`

## Eye tracking (WebGazer)

The interpreter can optionally collect camera-based gaze estimates via WebGazer.

- Enable in config: `data_collection.eye_tracking.enabled = true` (also supports legacy `data_collection["eye-tracking"] = true`).
- Note: camera access typically requires HTTPS (or `localhost`) so the browser can prompt for permission.
- Flow:
  - Permission/start screen is injected so the camera prompt is tied to a user gesture.
  - Calibration/training is injected by default (WebGazer often returns null predictions until trained).
  - If the Builder timeline includes a **Calibration Instructions** preface screen (tagged with `data.plugin_type = "eye-tracking-calibration-instructions"`), it is automatically moved to appear between the permission screen and the calibration dots.
- Output:
  - On finish, an eye-tracking payload is attached to the jsPsych data.
  - If the jsPsych runtime does not allow mutating the data store safely, the interpreter falls back to appending a final extra row at export/submission time.
  - The eye-tracking payload row uses `plugin_type = "eye-tracking"` and includes:
    - `eye_tracking_samples_json` (stringified array of gaze samples)
    - `eye_tracking_calibration_json` (stringified array of calibration events)
    - `eye_tracking_stats`, start/stop results, and sample counts
- Reliability: recommended to vendor a pinned copy at `vendor/webgazer.min.js` so studies don’t depend on external CDNs.
  - The interpreter will try `vendor/webgazer.min.js` first, then fall back to a pinned CDN.
  - Override sources via `data_collection.eye_tracking.webgazer_srcs` (string array) or `webgazer_src` (single string).
- If you later want CDN-only (e.g., for a packaged distribution), set `webgazer_srcs` to just the CDN URL (or remove `vendor/webgazer.min.js`).
- Licensing: WebGazer is GPL-3.0; see `vendor/THIRD_PARTY_NOTICES.md` before distributing builds.
- Sample: `configs/sample_eye_tracking_webgazer.json`

### Eye tracking config knobs

Under `data_collection.eye_tracking` (object form), supported settings include:

- `enabled` (boolean)
- Sampling:
  - `sample_interval_ms` (preferred; milliseconds between stored samples)
  - `sample_rate` (Hz; used only if `sample_interval_ms` is not provided)
- Sources:
  - `webgazer_srcs` (string array) or `webgazer_src` (string)
- UI:
  - `show_video` (boolean) — show/hide webcam preview box
- Calibration:
  - `calibration_enabled` (boolean; default true)
  - `calibration_points` (number; default 9)
  - `calibration_key` (string; default space)
- Permission prompting:
  - `force_permission_request` (boolean; default true)
  - `cam_constraints` (object; passed to `getUserMedia` when forcing the prompt)

## Current scope / assumptions

- Supports both `experiment_type: "trial-based"` and `"continuous"`.
- `block` components are expanded up-front and sampled **per-trial** (with a special case for PVT blocks when `add_trial_per_false_start` is enabled; see above).
- Adaptive/staircase blocks (e.g. QUEST) choose their next value at runtime (via `on_start`) and update after each trial (via `on_finish`).
- Expected total scale is ~≤ 5k trials/frames.

### Block parameter windows

The compiler accepts either of these `parameter_windows` shapes:

- Builder shape: array of objects: `{ parameter, min, max }`
- Legacy/alternate shape: object map: `{ "coherence": {"min": 0.2, "max": 0.8}, ... }`

## Files

- `index.html`: loader UI + jsPsych boot
- `src/main.js`: orchestration
- `src/configLoader.js`: load by id or file
- `src/timelineCompiler.js`: expand blocks + map to jsPsych timeline
- `src/rdmEngine.js`: dot-motion renderer used by the jsPsych plugin
- `src/jspsych-rdm.js`: custom jsPsych plugin for RDM stimuli
- `src/jspsych-stroop.js`: jsPsych plugin for Stroop trials
- `src/jspsych-simon.js`: jsPsych plugin for Simon trials
- `src/jspsych-pvt.js`: jsPsych plugin for PVT trials
