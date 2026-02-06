(function () {
  const els = {
    jatosStatus: document.getElementById('jatosStatus'),
    statusBox: document.getElementById('statusBox'),
    jspsychTarget: document.getElementById('jspsych-target')
  };

  function getDebugMode() {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = (params.get('debug') || '').toString().trim().toLowerCase();
      return v === '1' || v === 'true' || v === 'yes' || v === 'csv' || v === 'json';
    } catch {
      return false;
    }
  }

  function getDebugFormat() {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = (params.get('debug') || '').toString().trim().toLowerCase();
      if (v === 'json') return 'json';
      // Default to CSV when debug is enabled.
      return 'csv';
    } catch {
      return 'csv';
    }
  }

  function getValidateMode() {
    try {
      const params = new URLSearchParams(window.location.search);
      const v = (params.get('validate') || '').toString().trim().toLowerCase();
      if (!v) return false;
      if (v === 'only') return 'only';
      return v === '1' || v === 'true' || v === 'yes' ? true : false;
    } catch {
      return false;
    }
  }

  function formatNum(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return x;
    return Number(n.toFixed(6));
  }

  function runAdaptiveValidation(timeline) {
    const tl = Array.isArray(timeline) ? timeline : [];

    const rows = [];
    let adaptiveIndex = 0;

    for (let i = 0; i < tl.length; i++) {
      const t = tl[i];
      if (!t || typeof t !== 'object') continue;
      if (typeof t.on_start !== 'function' || typeof t.on_finish !== 'function') continue;

      try {
        // jsPsych passes the trial object into on_start.
        t.on_start(t);
      } catch (e) {
        console.warn('Adaptive validate: on_start failed for index', i, e);
      }

      // Alternate correctness to force staircase updates.
      const isCorrect = adaptiveIndex % 2 === 0;
      adaptiveIndex++;

      const data = { correctness: isCorrect };
      try {
        t.on_finish(data);
      } catch (e) {
        console.warn('Adaptive validate: on_finish failed for index', i, e);
      }

      rows.push({
        index: i,
        plugin_type: (t.data && typeof t.data === 'object') ? t.data.plugin_type : null,
        adaptive_mode: data.adaptive_mode,
        adaptive_parameter: data.adaptive_parameter,
        adaptive_value: formatNum(data.adaptive_value),
        correctness: data.correctness
      });
    }

    console.groupCollapsed(`[Interpreter] Adaptive validate: ${rows.length} adaptive trial(s)`);
    if (rows.length) {
      try {
        console.table(rows.slice(0, 30));
      } catch {
        console.log(rows.slice(0, 30));
      }

      const byKey = new Map();
      for (const r of rows) {
        const k = `${r.plugin_type}::${r.adaptive_mode}::${r.adaptive_parameter}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r.adaptive_value);
      }

      let ok = true;
      for (const [k, vals] of byKey.entries()) {
        const uniq = new Set(vals.map((v) => String(v))).size;
        if (uniq <= 1) {
          ok = false;
          console.warn('Adaptive validate WARNING: values did not change for', k, '(unique=', uniq, ')');
        } else {
          console.log('Adaptive validate OK:', k, 'unique=', uniq);
        }
      }

      if (ok) console.log('Adaptive validate PASS');
      else console.warn('Adaptive validate had warnings (see above)');
    }

    // Quick Gabor parameter check: ensure defaults propagated into compiled trials.
    const firstGabor = tl.find((t) => t && t.data && t.data.task_type === 'gabor');
    if (firstGabor) {
      console.log('Gabor param check:', {
        spatial_frequency_cyc_per_px: formatNum(firstGabor.spatial_frequency_cyc_per_px),
        grating_waveform: firstGabor.grating_waveform
      });
    }
    console.groupEnd();
  }

  function validateTimelinePlugins(timeline, label) {
    const tl = Array.isArray(timeline) ? timeline : [];
    const problems = [];
    const unwrapped = [];

    for (let i = 0; i < tl.length; i++) {
      const node = tl[i];
      if (!node || typeof node !== 'object') continue;

      let t = node.type;

      // Some UMD builds expose plugins as { default: PluginClass }.
      if (t && typeof t === 'object' && typeof t.default === 'function') {
        node.type = t.default;
        t = node.type;
        unwrapped.push({ index: i, from: 'object.default', name: t && t.name ? t.name : null });
      }

      // jsPsych's runtime requirement is essentially that `type` is a function/class.
      // (We still log if `info` is missing, but don't block execution.)
      const ok = typeof t === 'function';
      if (ok) {
        if (!(t && t.info && typeof t.info === 'object')) {
          // Warn-only: v9+ will require info.version/info.data, but runtime may still proceed.
          // This keeps validation from becoming a false positive.
          // (We already patched our custom plugins to include these fields.)
        }
        continue;
      }

      problems.push({
        index: i,
        type_kind: typeof t,
        type_value: (typeof t === 'string') ? t : (t === null ? 'null' : (t === undefined ? 'undefined' : (t && t.name ? t.name : 'non-string'))),
        has_info: !!(t && t.info),
        data_plugin_type: (node.data && typeof node.data === 'object') ? node.data.plugin_type : null,
        data_task_type: (node.data && typeof node.data === 'object') ? node.data.task_type : null
      });
    }

    if (unwrapped.length > 0) {
      console.groupCollapsed(`[Interpreter] Unwrapped plugin defaults (${label || 'timeline'})`);
      try {
        console.table(unwrapped.slice(0, 50));
      } catch {
        console.log(unwrapped.slice(0, 50));
      }
      console.groupEnd();
    }

    if (problems.length > 0) {
      const first = problems[0];
      console.group(`[Interpreter] Invalid jsPsych trial.type detected (${label || 'timeline'})`);
      try {
        console.table(problems.slice(0, 50));
      } catch {
        console.log(problems.slice(0, 50));
      }

      try {
        const badNode = tl[first.index];
        const safe = JSON.parse(JSON.stringify(badNode, (k, v) => (typeof v === 'function' ? `[Function ${v.name || 'anonymous'}]` : v)));
        console.log('Offending node (safe json):', safe);
      } catch (e) {
        console.log('Failed to serialize offending node:', e);
      }

      console.groupEnd();

      setStatus(`Invalid plugin type at index ${first.index} (typeof=${first.type_kind}, value=${String(first.type_value)}). See console for details.`);
      throw new Error(`Invalid jsPsych plugin type in compiled timeline at index ${first.index}`);
    }
  }

  function logPluginGlobals() {
    const isPluginFn = (ref) => typeof ref === 'function' || (ref && typeof ref === 'object' && typeof ref.default === 'function');
    const getInfo = (ref) => {
      const r = (ref && typeof ref === 'object' && typeof ref.default === 'function') ? ref.default : ref;
      return r && r.info && typeof r.info === 'object' ? r.info : null;
    };

    const jsPsychModulePresent = typeof window.jsPsychModule !== 'undefined' && window.jsPsychModule;
    const jsPsychPresent = typeof window.jsPsych !== 'undefined' && window.jsPsych;
    const parameterTypePresent = !!((jsPsychModulePresent && window.jsPsychModule.ParameterType) || (jsPsychPresent && window.jsPsych.ParameterType));

    const scriptPresent = (srcSuffix) => {
      try {
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        return scripts.some((s) => typeof s.src === 'string' && s.src.replace(/\\/g, '/').endsWith(srcSuffix));
      } catch {
        return false;
      }
    };

    const items = [
      ['jsPsychHtmlKeyboardResponse', typeof jsPsychHtmlKeyboardResponse !== 'undefined' ? jsPsychHtmlKeyboardResponse : undefined],
      ['window.jsPsychRdm', window.jsPsychRdm],
      ['window.jsPsychRdmContinuous', window.jsPsychRdmContinuous],
      ['window.jsPsychGabor', window.jsPsychGabor],
      ['window.jsPsychFlanker', window.jsPsychFlanker],
      ['window.jsPsychSart', window.jsPsychSart],
      ['window.jsPsychSurveyResponse', window.jsPsychSurveyResponse]
    ];

    const rows = items.map(([name, ref]) => ({
      name,
      present: isPluginFn(ref),
      info_name: (() => {
        const info = getInfo(ref);
        return info && typeof info.name === 'string' ? info.name : null;
      })(),
      info_version: (() => {
        const info = getInfo(ref);
        return info && typeof info.version === 'string' ? info.version : null;
      })()
    }));

    console.groupCollapsed('[Interpreter] Plugin globals');
    console.log('jsPsych globals:', {
      has_jsPsychModule: !!jsPsychModulePresent,
      has_jsPsych: !!jsPsychPresent,
      has_ParameterType: parameterTypePresent
    });
    console.log('Script tags present:', {
      'src/rdmEngine.js': scriptPresent('src/rdmEngine.js'),
      'src/jspsych-rdm.js': scriptPresent('src/jspsych-rdm.js'),
      'src/jspsych-rdm-continuous.js': scriptPresent('src/jspsych-rdm-continuous.js')
    });
    try {
      console.table(rows);
    } catch {
      console.log(rows);
    }
    console.groupEnd();
  }

  function formatTimestampForFilename(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  function downloadTextFile(text, filename, mimeType) {
    try {
      const blob = new Blob([text], { type: mimeType || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch (e) {
      console.warn('Failed to download debug data file:', e);
      return false;
    }
  }

  function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (/[\r\n,\"]/g.test(s)) {
      return `"${s.replaceAll('"', '""')}"`;
    }
    return s;
  }

  function rowsToCsv(rows) {
    const dataRows = Array.isArray(rows) ? rows : [];

    const keySet = new Set();
    for (const r of dataRows) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) keySet.add(k);
    }

    const preferred = [
      'code',
      'task_type',
      'config_id',
      'plugin_type',
      'trial_type',
      'experiment_type',
      'frame_index',
      'event',
      'ended_reason',
      'response_side',
      'response_key',
      'correct_side',
      'rt_ms',
      'accuracy',
      'correctness'
    ];

    const remaining = Array.from(keySet)
      .filter((k) => !preferred.includes(k))
      .sort((a, b) => a.localeCompare(b));

    const headers = preferred.filter((k) => keySet.has(k)).concat(remaining);

    const lines = [];
    lines.push(headers.map(csvEscape).join(','));

    for (const r of dataRows) {
      const line = headers.map((k) => {
        const v = r && typeof r === 'object' ? r[k] : undefined;
        if (v && typeof v === 'object') {
          try {
            return csvEscape(JSON.stringify(v));
          } catch {
            return csvEscape(String(v));
          }
        }
        return csvEscape(v);
      }).join(',');
      lines.push(line);
    }

    return lines.join('\r\n') + '\r\n';
  }

  function expandJsPsychRowsForCsv(values) {
    const inRows = Array.isArray(values) ? values : [];
    const out = [];

    for (const row of inRows) {
      if (!row || typeof row !== 'object') continue;

      const records = Array.isArray(row.records) ? row.records : null;
      if (!records) {
        out.push(row);
        continue;
      }

      const { records: _omit, ...base } = row;

      // On expanded per-record rows, jsPsych's time_elapsed refers to the END of the parent trial.
      // That looks like a "frozen" timestamp across all records, so preserve it under a clearer name.
      if (Object.prototype.hasOwnProperty.call(base, 'time_elapsed')) {
        base.trial_time_elapsed_end = base.time_elapsed;
        delete base.time_elapsed;
      }

      for (let i = 0; i < records.length; i++) {
        const rec = records[i] && typeof records[i] === 'object' ? records[i] : { value: records[i] };
        const merged = { ...base, ...rec, record_index: i };

        // Reduce nested objects to JSON strings to keep CSV readable.
        if (merged.rdm && typeof merged.rdm === 'object') {
          merged.rdm_json = JSON.stringify(merged.rdm);
          delete merged.rdm;
        }
        if (merged.response && typeof merged.response === 'object') {
          merged.response_json = JSON.stringify(merged.response);
          delete merged.response;
        }

        out.push(merged);
      }
    }

    return out;
  }

  function getJsPsychValues(jsPsych) {
    try {
      if (!jsPsych || !jsPsych.data || typeof jsPsych.data.get !== 'function') return [];
      const vals = jsPsych.data.get().values();
      return Array.isArray(vals) ? vals : [];
    } catch {
      return [];
    }
  }

  function tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload) {
    // jsPsych v8 doesn't support writing arbitrary rows via data.write.
    // Some versions expose addToLast on the DataCollection returned by data.get().
    try {
      if (!jsPsych || !jsPsych.data) return { ok: false, reason: 'no_jspsych' };

      if (typeof jsPsych.data.get === 'function') {
        const dc = jsPsych.data.get();
        if (dc && typeof dc.addToLast === 'function') {
          dc.addToLast(eyePayload);
          return { ok: true, method: 'data.get().addToLast' };
        }
      }

      // Older patterns (rare)
      if (typeof jsPsych.data.addToLast === 'function') {
        jsPsych.data.addToLast(eyePayload);
        return { ok: true, method: 'data.addToLast' };
      }

      return { ok: false, reason: 'no_addToLast' };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  function downloadDebugData(jsPsych, idForName, overrideValues) {
    const stamp = formatTimestampForFilename(new Date());
    const safeId = String(idForName || 'local').trim() || 'local';
    const fmt = getDebugFormat();

    let delayedEyeDownload = null;

    // If eye tracking is enabled and we appended an eye-tracking row (or attached fields to a trial),
    // also export it separately.
    // This keeps the main CSV/JSON intact while providing a clean gaze-only file.
    try {
      const values = Array.isArray(overrideValues) ? overrideValues : getJsPsychValues(jsPsych);
      const eyeRow = Array.isArray(values)
        ? (
          values.find((r) => r && typeof r === 'object' && r.plugin_type === 'eye-tracking' && r.eye_tracking_provider === 'webgazer')
          || values.find((r) => r && typeof r === 'object' && typeof r.eye_tracking_samples_json === 'string')
        )
        : null;

      if (eyeRow && typeof eyeRow.eye_tracking_samples_json === 'string' && eyeRow.eye_tracking_samples_json.trim()) {
        // Keep this resilient: if parsing fails, still save the raw string.
        let parsed = null;
        try {
          parsed = JSON.parse(eyeRow.eye_tracking_samples_json);
        } catch {
          parsed = null;
        }

        const payload = {
          provider: 'webgazer',
          sample_count: Number(eyeRow.eye_tracking_sample_count) || (Array.isArray(parsed) ? parsed.length : null),
          samples: Array.isArray(parsed) ? parsed : null,
          samples_json: Array.isArray(parsed) ? undefined : eyeRow.eye_tracking_samples_json
        };

        delayedEyeDownload = () => downloadTextFile(
          JSON.stringify(payload, null, 2),
          `psychjson-eye-tracking-${safeId}-${stamp}.json`,
          'application/json'
        );
      }
    } catch (e) {
      console.warn('Failed to download eye-tracking debug file:', e);
    }

    if (fmt === 'json') {
      const values = Array.isArray(overrideValues) ? overrideValues : getJsPsychValues(jsPsych);
      const dataJson = JSON.stringify(values);
      const ok = downloadTextFile(dataJson, `psychjson-data-${safeId}-${stamp}.json`, 'application/json');
      if (typeof delayedEyeDownload === 'function') setTimeout(delayedEyeDownload, 250);
      return ok;
    }

    // Default: CSV
    // jsPsych's csv() doesn't expand nested arrays (like continuous RDM 'records'),
    // so we expand those into one row per record.
    const values = Array.isArray(overrideValues) ? overrideValues : getJsPsychValues(jsPsych);
    const expanded = expandJsPsychRowsForCsv(values);
    const dataCsv = rowsToCsv(expanded);
    const ok = downloadTextFile(dataCsv, `psychjson-data-${safeId}-${stamp}.csv`, 'text/csv');
    if (typeof delayedEyeDownload === 'function') setTimeout(delayedEyeDownload, 250);
    return ok;
  }

  function setStatus(msg) {
    if (els.statusBox) {
      els.statusBox.textContent = msg;
    } else {
      // Minimal UI mode: fall back to console.
      console.log('[Interpreter]', msg);
    }
  }

  function detectJatos() {
    const ok = typeof window.jatos !== 'undefined' && window.jatos && typeof window.jatos.onLoad === 'function';
    if (els.jatosStatus) {
      els.jatosStatus.textContent = ok ? 'JATOS: detected' : 'JATOS: not detected (local mode)';
    }
    return ok;
  }

  async function ensureJatosLoaded() {
    if (typeof window.jatos !== 'undefined' && window.jatos) return true;

    const host = (window.location && window.location.hostname) ? window.location.hostname : '';
    const proto = (window.location && window.location.protocol) ? window.location.protocol : '';
    const isLocal =
      proto === 'file:' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1';

    if (isLocal) {
      return false;
    }

    // Avoid noisy "Refused to execute script ... MIME type text/html" in local mode.
    // Probe first; only attach <script> if it looks like real JS.
    try {
      const res = await fetch('/jatos.js', { method: 'HEAD', cache: 'no-store' });
      if (!res.ok) return false;
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('javascript')) return false;
    } catch {
      return false;
    }

    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = '/jatos.js';
      script.async = true;
      script.onload = () => resolve(typeof window.jatos !== 'undefined' && !!window.jatos);
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }

  function generateCalibrationPoints(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (n <= 0) return [];

    const margin = 0.12;
    const pts = [];

    // Common defaults
    if (n === 1) return [{ x: 0.5, y: 0.5 }];
    if (n === 5) {
      return [
        { x: margin, y: margin },
        { x: 1 - margin, y: margin },
        { x: 0.5, y: 0.5 },
        { x: margin, y: 1 - margin },
        { x: 1 - margin, y: 1 - margin }
      ];
    }
    if (n === 9) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          pts.push({
            x: (margin + (1 - 2 * margin) * c / 2),
            y: (margin + (1 - 2 * margin) * r / 2)
          });
        }
      }
      return pts;
    }

    // Fallback: sample a grid, then take first n points
    const grid = Math.ceil(Math.sqrt(n));
    const denom = Math.max(1, grid - 1);
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        pts.push({
          x: (margin + (1 - 2 * margin) * c / denom),
          y: (margin + (1 - 2 * margin) * r / denom)
        });
      }
    }
    return pts.slice(0, n);
  }

  function safeRecordWebgazerScreenPosition(x, y) {
    try {
      if (!window.webgazer || typeof window.webgazer.recordScreenPosition !== 'function') return { ok: false, reason: 'recordScreenPosition_missing' };
      try {
        window.webgazer.recordScreenPosition(x, y, 'click');
      } catch {
        window.webgazer.recordScreenPosition(x, y);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : String(e) };
    }
  }

  function maybeCreateEyeTrackingDebugHud(enabled) {
    if (!enabled) return null;
    if (!getDebugMode()) return null;

    try {
      const hud = document.createElement('div');
      hud.id = 'eye-tracking-debug-hud';
      hud.style.position = 'fixed';
      hud.style.top = '8px';
      hud.style.right = '8px';
      hud.style.zIndex = '99999';
      hud.style.background = 'rgba(0,0,0,0.72)';
      hud.style.color = '#fff';
      hud.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
      hud.style.fontSize = '12px';
      hud.style.padding = '10px 12px';
      hud.style.borderRadius = '8px';
      hud.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
      hud.style.pointerEvents = 'none';
      hud.style.maxWidth = '420px';
      hud.style.whiteSpace = 'pre';
      hud.textContent = 'Eye tracking HUD: initializing...';
      document.body.appendChild(hud);

      const formatBool = (v) => (v ? 'true' : 'false');
      const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const startedAt = now();

      const tick = () => {
        try {
          const mgr = window.EyeTrackingWebGazer;
          const stats = (mgr && typeof mgr.getStats === 'function') ? mgr.getStats() : null;
          const samplesLen = (mgr && typeof mgr.getSamples === 'function' && Array.isArray(mgr.getSamples())) ? mgr.getSamples().length : null;

          const lines = [];
          lines.push('Eye tracking (debug)');
          lines.push(`t=${Math.round(now() - startedAt)}ms`);
          if (!stats) {
            lines.push('stats: unavailable');
          } else {
            lines.push(`active=${formatBool(stats.active)} ready_after_begin=${formatBool(stats.ready_after_begin)}`);
            lines.push(`samples=${samplesLen !== null ? samplesLen : stats.sample_count}`);
            lines.push(`listener_total=${stats.listener_calls_total} null=${stats.listener_calls_null} nonnull=${stats.listener_calls_nonnull}`);
            lines.push(`last_elapsed=${stats.last_listener_elapsed !== null ? Math.round(stats.last_listener_elapsed) : 'null'}`);
            lines.push(`last_nonnull_t=${stats.last_nonnull_t !== null ? Math.round(stats.last_nonnull_t) : 'null'}`);
            lines.push(`src=${stats.begin_src || 'unknown'}`);
          }

          hud.textContent = lines.join('\n');
        } catch {
          // ignore
        }
      };

      tick();
      const intervalId = setInterval(tick, 250);

      return {
        stop: () => {
          try { clearInterval(intervalId); } catch { /* ignore */ }
          try { hud.remove(); } catch { /* ignore */ }
        }
      };
    } catch {
      return null;
    }
  }

  function buildEyeTrackingCalibrationTimeline(eyeCfg, calibrationEvents, dataStamp) {
    const enabled = !!(eyeCfg && eyeCfg.enabled && eyeCfg.calibration_enabled !== false);
    // Be defensive: older cached builds of EyeTrackingWebGazer may not include calibration_points.
    // Default to 9 points unless explicitly set to 0.
    let pointCount = 9;
    try {
      if (eyeCfg && Object.prototype.hasOwnProperty.call(eyeCfg, 'calibration_points')) {
        const v = Number(eyeCfg.calibration_points);
        pointCount = Number.isFinite(v) ? v : 9;
      }
    } catch {
      pointCount = 9;
    }

    const pts = enabled ? generateCalibrationPoints(pointCount) : [];
    if (!pts.length) return [];

    const key = (eyeCfg && typeof eyeCfg.calibration_key === 'string') ? eyeCfg.calibration_key : ' ';
    const keyLabel = (key === ' ') ? 'SPACE' : key;

    const trials = [];
    trials.push({
      type: jsPsychHtmlKeyboardResponse,
      stimulus: `<div style="max-width:900px;margin:0 auto;text-align:left;">
        <h3>Eye tracking calibration</h3>
        <p>You will see ${pts.length} dot(s). For each dot:</p>
        <ol>
          <li>Look directly at the dot.</li>
          <li>Press <b>${escapeHtml(keyLabel)}</b> while looking at it.</li>
        </ol>
        <p style="opacity:0.8;">This helps WebGazer start producing gaze estimates.</p>
        <p style="margin-top:12px;opacity:0.9;">Press <b>${escapeHtml(keyLabel)}</b> to begin calibration.</p>
      </div>`,
      choices: [key],
      data: { ...(dataStamp || {}), plugin_type: 'eye-tracking-calibration-intro' }
    });

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const px = Math.round(p.x * window.innerWidth);
      const py = Math.round(p.y * window.innerHeight);

      trials.push({
        type: jsPsychHtmlKeyboardResponse,
        stimulus: `<div style="position:relative;width:100vw;height:100vh;">
          <div style="position:absolute;left:${(p.x * 100).toFixed(3)}%;top:${(p.y * 100).toFixed(3)}%;transform:translate(-50%,-50%);
                      width:18px;height:18px;border-radius:50%;background:#ff3b3b;box-shadow:0 0 0 6px rgba(255,59,59,0.25);"></div>
          <div style="position:absolute;left:0;right:0;bottom:24px;text-align:center;opacity:0.9;">
            Point ${i + 1}/${pts.length} — Look at the dot and press <b>${escapeHtml(keyLabel)}</b>
          </div>
        </div>`,
        choices: [key],
        data: { ...(dataStamp || {}), plugin_type: 'eye-tracking-calibration', calibration_index: i },
        on_finish: () => {
          const res = safeRecordWebgazerScreenPosition(px, py);
          if (Array.isArray(calibrationEvents)) {
            calibrationEvents.push({
              index: i,
              x: px,
              y: py,
              x_norm: p.x,
              y_norm: p.y,
              t: (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(),
              record_result: res
            });
          }
        }
      });
    }

    trials.push({
      type: jsPsychHtmlKeyboardResponse,
      stimulus: `<div style="max-width:900px;margin:0 auto;text-align:left;">
        <h3>Calibration complete</h3>
        <p>Press any key to continue to the task.</p>
      </div>`,
      choices: 'ALL_KEYS',
      data: { ...(dataStamp || {}), plugin_type: 'eye-tracking-calibration-complete' }
    });

    return trials;
  }

  function extractCalibrationPrefaceTrials(jsPsychTimeline) {
    const timeline = Array.isArray(jsPsychTimeline) ? jsPsychTimeline : [];
    const preface = [];
    const kept = [];

    for (const t of timeline) {
      const pluginType = (t && t.data && typeof t.data === 'object') ? t.data.plugin_type : null;
      if (pluginType === 'eye-tracking-calibration-instructions') {
        preface.push(t);
      } else {
        kept.push(t);
      }
    }

    return { preface, timeline: kept };
  }

  async function startExperiment(config, configId) {
    const validateMode = getValidateMode();

    let compiled = window.TimelineCompiler.compileToJsPsychTimeline(config);

    // If the researcher added a calibration-instructions screen in the Builder,
    // move it to occur before the auto calibration dots.
    let calibrationPrefaceTrials = [];
    try {
      const ex = extractCalibrationPrefaceTrials(compiled.timeline);
      calibrationPrefaceTrials = ex.preface;
      compiled.timeline = ex.timeline;
    } catch {
      calibrationPrefaceTrials = [];
    }

    // Optional: Eye tracking via WebGazer (enabled in Builder data_collection)
    let eyeTrackingEnabled = false;
    let eyeTrackingStartResult = null;
    const eyeTrackingCalibrationEvents = [];
    let eyeTrackingCfg = null;
    try {
      eyeTrackingCfg = (window.EyeTrackingWebGazer && window.EyeTrackingWebGazer.getEyeTrackingConfig)
        ? window.EyeTrackingWebGazer.getEyeTrackingConfig(config)
        : null;
      eyeTrackingEnabled = !!(eyeTrackingCfg && eyeTrackingCfg.enabled);
    } catch {
      eyeTrackingEnabled = false;
      eyeTrackingCfg = null;
    }

    const eyeHud = maybeCreateEyeTrackingDebugHud(eyeTrackingEnabled);

    if (eyeTrackingEnabled) {
      // Insert a short permission prompt so camera access is tied to a user gesture.
      try {
        compiled.timeline = [
          {
            type: jsPsychHtmlKeyboardResponse,
            stimulus: `<div style="max-width: 900px; margin:0 auto; text-align:left;">
              <h3>Eye tracking enabled</h3>
              <p>This study will request access to your camera for gaze estimation (WebGazer).</p>
              <p>If prompted, please allow camera access, then press any key to begin.</p>
              <p style="opacity:0.75; font-size: 0.95em;">Note: camera-based eye tracking typically requires HTTPS or localhost.</p>
            </div>`,
            choices: 'ALL_KEYS',
            data: { plugin_type: 'eye-tracking-permission' },
            on_finish: async () => {
              // IMPORTANT: start on_finish so it happens right after the keypress (user gesture).
              try {
                if (window.EyeTrackingWebGazer && typeof window.EyeTrackingWebGazer.start === 'function') {
                  eyeTrackingStartResult = await window.EyeTrackingWebGazer.start(config);
                  if (!eyeTrackingStartResult || eyeTrackingStartResult.ok !== true || eyeTrackingStartResult.started !== true) {
                    console.warn('EyeTrackingWebGazer start failed:', eyeTrackingStartResult);
                  }
                } else {
                  eyeTrackingStartResult = { ok: false, started: false, reason: 'EyeTrackingWebGazer_missing' };
                }
              } catch (e) {
                eyeTrackingStartResult = { ok: false, started: false, reason: e && e.message ? e.message : String(e) };
                console.warn('EyeTrackingWebGazer start threw:', e);
              }
            }
          },
          ...(() => {
            // Stamp identifiers (config_id) for consistency.
            const cfgId = (typeof configId === 'string' && configId.trim()) ? configId.trim() : null;
            for (const t of calibrationPrefaceTrials) {
              const baseData = (t && typeof t.data === 'object' && t.data) ? t.data : {};
              t.data = { ...baseData, config_id: cfgId };
            }
            return calibrationPrefaceTrials;
          })(),
          ...buildEyeTrackingCalibrationTimeline(
            eyeTrackingCfg,
            eyeTrackingCalibrationEvents,
            { plugin_type: 'eye-tracking-calibration-meta', config_id: (configId || null) }
          ),
          ...compiled.timeline
        ];
      } catch (e) {
        console.warn('Failed to inject eye-tracking permission trial:', e);
      }
    }

    // Helpful when debugging plugin-load issues.
    logPluginGlobals();
    validateTimelinePlugins(compiled.timeline, configId || 'single');

    if (validateMode) {
      try {
        // IMPORTANT: running adaptive hooks mutates staircase state.
        // Compile a fresh timeline for validation, then recompile for the real run.
        runAdaptiveValidation(compiled.timeline);
      } catch (e) {
        console.warn('Adaptive validate failed:', e);
      }

      if (validateMode === 'only') {
        setStatus('Validation complete (validate=only). Not starting the experiment.');
        return;
      }

      compiled = window.TimelineCompiler.compileToJsPsychTimeline(config);
    }

    setStatus(`Compiled timeline: ${compiled.timeline.length} items (${compiled.experimentType}). Starting...`);

    const jsPsych = initJsPsych({
      display_element: 'jspsych-target',
      on_finish: async () => {
        try {
          if (eyeHud && typeof eyeHud.stop === 'function') eyeHud.stop();
        } catch {
          // ignore
        }

        let eyeTrackingExtraRow = null;

        // Stop eye tracking and attach samples before exporting/submitting.
        try {
          if (eyeTrackingEnabled && window.EyeTrackingWebGazer) {
            const stopRes = await window.EyeTrackingWebGazer.stop();
            const samples = window.EyeTrackingWebGazer.getSamples ? window.EyeTrackingWebGazer.getSamples() : [];

            const safeSamples = Array.isArray(samples) ? samples : [];
            const stats = (window.EyeTrackingWebGazer && typeof window.EyeTrackingWebGazer.getStats === 'function')
              ? window.EyeTrackingWebGazer.getStats()
              : null;
            const eyePayload = {
              plugin_type: 'eye-tracking',
              eye_tracking_provider: 'webgazer',
              eye_tracking_enabled: true,
              eye_tracking_started: !!(eyeTrackingStartResult && eyeTrackingStartResult.ok === true && eyeTrackingStartResult.started === true),
              eye_tracking_start_result: eyeTrackingStartResult,
              eye_tracking_stop_result: stopRes,
              eye_tracking_calibration_json: JSON.stringify(Array.isArray(eyeTrackingCalibrationEvents) ? eyeTrackingCalibrationEvents : []),
              eye_tracking_sample_count: safeSamples.length,
              eye_tracking_samples_json: JSON.stringify(safeSamples),
              eye_tracking_stats: stats
            };

            const persisted = tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload);
            if (!persisted || persisted.ok !== true) {
              // Fallback: include it at export time even if we can't mutate jsPsych's store.
              eyeTrackingExtraRow = eyePayload;
              console.warn('Could not persist eye tracking payload (single) (no addToLast); will append at export time');
            }

            // Clear buffer after writing to jsPsych data so memory doesn't linger.
            if (window.EyeTrackingWebGazer.clear) window.EyeTrackingWebGazer.clear();
            if (stopRes && stopRes.ok === false) {
              console.warn('EyeTrackingWebGazer stop returned error:', stopRes);
            }
          }
        } catch (e) {
          console.warn('Eye tracking finalize failed:', e);

          // Even if finalize throws, still write a row so the payload reflects the issue.
          try {
            if (eyeTrackingEnabled && jsPsych && jsPsych.data) {
              const eyePayload = {
                plugin_type: 'eye-tracking',
                eye_tracking_provider: 'webgazer',
                eye_tracking_enabled: true,
                eye_tracking_started: false,
                eye_tracking_start_result: eyeTrackingStartResult,
                eye_tracking_finalize_error: e && e.message ? e.message : String(e),
                eye_tracking_calibration_json: JSON.stringify(Array.isArray(eyeTrackingCalibrationEvents) ? eyeTrackingCalibrationEvents : []),
                eye_tracking_sample_count: 0,
                eye_tracking_samples_json: '[]'
              };

              const persisted = tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload);
              if (!persisted || persisted.ok !== true) {
                eyeTrackingExtraRow = eyePayload;
                console.warn('Could not persist eye tracking error payload (single); will append at export time');
              }
            }
          } catch {
            // ignore
          }
        }

        const baseValues = getJsPsychValues(jsPsych);
        const finalValues = eyeTrackingExtraRow ? baseValues.concat([eyeTrackingExtraRow]) : baseValues;
        const dataJson = JSON.stringify(finalValues);

        if (typeof window.jatos !== 'undefined' && window.jatos && typeof window.jatos.submitResultData === 'function') {
          try {
            await window.jatos.submitResultData(dataJson);
            if (typeof window.jatos.endStudyAjax === 'function') {
              window.jatos.endStudyAjax(true);
            } else if (typeof window.jatos.endStudy === 'function') {
              window.jatos.endStudy(true);
            }
            return;
          } catch (e) {
            console.error('JATOS submit failed:', e);
            setStatus(`JATOS submit failed: ${e && e.message ? e.message : String(e)}`);
          }
        }

        // Local debug: optionally auto-download the exact payload that would be sent to JATOS.
        if (getDebugMode()) {
          const params = new URLSearchParams(window.location.search);
          const id = (params.get('id') || 'local').toString().trim() || 'local';
          downloadDebugData(jsPsych, id, finalValues);
        }

        // Local fallback: dump to console
        console.log('Experiment finished. Data:', jsPsych.data.get().values());
        setStatus('Experiment finished (local mode). Data logged to console.');
      }
    });

    // Ensure core identifiers are present on *every* row (useful for debug CSV/JSON).
    // Multi-config mode already stamps these per trial since they change by config.
    try {
      const taskType = (config && config.task_type ? String(config.task_type) : 'task');
      const experimentType = (config && config.experiment_type ? String(config.experiment_type) : (compiled.experimentType || 'trial-based'));
      const cfgId = (typeof configId === 'string' && configId.trim()) ? configId.trim() : null;
      jsPsych.data.addProperties({
        task_type: taskType,
        experiment_type: experimentType,
        config_id: cfgId
      });
    } catch (e) {
      console.warn('Failed to add global data properties:', e);
    }

    Promise.resolve(jsPsych.run(compiled.timeline)).catch((e) => {
      console.error('jsPsych.run failed:', e);
      setStatus(e && e.message ? e.message : String(e));
    });
  }

  function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  async function startExperimentFromConfigs(configs, code) {
    const seq = Array.isArray(configs) ? [...configs] : [];
    shuffleInPlace(seq);

    // Optional: Eye tracking via WebGazer (enabled per-config in Builder data_collection)
    let eyeTrackingEnabledAny = false;
    let eyeTrackingStartResult = null;
    const eyeTrackingCalibrationEvents = [];
    let eyeTrackingCfg = null;
    try {
      eyeTrackingEnabledAny = seq.some((c) => {
        const cfg = c && c.config ? c.config : null;
        if (!cfg) return false;
        return !!(window.EyeTrackingWebGazer && window.EyeTrackingWebGazer.getEyeTrackingConfig && window.EyeTrackingWebGazer.getEyeTrackingConfig(cfg).enabled);
      });
    } catch {
      eyeTrackingEnabledAny = false;
    }

    const eyeHud = maybeCreateEyeTrackingDebugHud(eyeTrackingEnabledAny);

    // Compile each config up front so we can:
    // 1) extract a single calibration preface screen (if present), and
    // 2) ensure it occurs before auto-injected calibration dots.
    const compiledSeq = [];
    let calibrationPrefaceTrials = [];

    // Precompute the first config that enabled eye tracking (used for start + calibration settings).
    const firstEnabledCfg = (() => {
      try {
        return seq.map((c) => (c && c.config ? c.config : null)).find((cfg) => {
          try {
            return !!(cfg && window.EyeTrackingWebGazer && window.EyeTrackingWebGazer.getEyeTrackingConfig && window.EyeTrackingWebGazer.getEyeTrackingConfig(cfg).enabled);
          } catch {
            return false;
          }
        }) || null;
      } catch {
        return null;
      }
    })();

    // Compute calibration/settings snapshot now, so the calibration trials can be injected immediately.
    try {
      eyeTrackingCfg = (firstEnabledCfg && window.EyeTrackingWebGazer && window.EyeTrackingWebGazer.getEyeTrackingConfig)
        ? window.EyeTrackingWebGazer.getEyeTrackingConfig(firstEnabledCfg)
        : null;
    } catch {
      eyeTrackingCfg = null;
    }

    for (const c of seq) {
      const cfg = c && c.config ? c.config : null;
      if (!cfg) continue;

      const taskType = (cfg.task_type || 'task').toString();
      const compiled = window.TimelineCompiler.compileToJsPsychTimeline(cfg);

      // Remove any calibration-instructions screens from the task timeline; we show it once globally.
      try {
        const ex = extractCalibrationPrefaceTrials(compiled.timeline);
        if (ex.preface && ex.preface.length && calibrationPrefaceTrials.length === 0) {
          calibrationPrefaceTrials = ex.preface;
        }
        compiled.timeline = ex.timeline;
      } catch {
        // ignore
      }

      compiledSeq.push({
        id: c.id || null,
        taskType,
        timeline: compiled.timeline
      });
    }

    const timeline = [];

    if (eyeTrackingEnabledAny) {
      // Insert a short permission prompt so camera access is tied to a user gesture.
      timeline.push({
        type: jsPsychHtmlKeyboardResponse,
        stimulus: `<div style="max-width: 900px; margin:0 auto; text-align:left;">
          <h3>Eye tracking enabled</h3>
          <p>This study will request access to your camera for gaze estimation (WebGazer).</p>
          <p>If prompted, please allow camera access, then press any key to begin.</p>
          <p style="opacity:0.75; font-size: 0.95em;">Note: camera-based eye tracking typically requires HTTPS or localhost.</p>
        </div>`,
        choices: 'ALL_KEYS',
        data: { plugin_type: 'eye-tracking-permission', code, task_type: null, config_id: null },
        on_finish: async () => {
          // Start on_finish so it happens right after the keypress (user gesture).
          try {
            if (window.EyeTrackingWebGazer && typeof window.EyeTrackingWebGazer.start === 'function') {
              eyeTrackingStartResult = await window.EyeTrackingWebGazer.start(firstEnabledCfg || {});
              if (!eyeTrackingStartResult || eyeTrackingStartResult.ok !== true || eyeTrackingStartResult.started !== true) {
                console.warn('EyeTrackingWebGazer start failed (multi):', eyeTrackingStartResult);
              }
            } else {
              eyeTrackingStartResult = { ok: false, started: false, reason: 'EyeTrackingWebGazer_missing' };
            }
          } catch (e) {
            eyeTrackingStartResult = { ok: false, started: false, reason: e && e.message ? e.message : String(e) };
            console.warn('EyeTrackingWebGazer start threw (multi):', e);
          }
        }
      });

      // If any config included a calibration-instructions screen, insert it here (before calibration dots).
      try {
        for (const t of calibrationPrefaceTrials) {
          const baseData = (t && typeof t.data === 'object' && t.data) ? t.data : {};
          t.data = { ...baseData, code, task_type: null, config_id: null };
          timeline.push(t);
        }
      } catch {
        // ignore
      }

      for (const t of buildEyeTrackingCalibrationTimeline(
        eyeTrackingCfg,
        eyeTrackingCalibrationEvents,
        { plugin_type: 'eye-tracking-calibration-meta', code, task_type: null, config_id: null }
      )) {
        timeline.push(t);
      }
    }

    for (const c of compiledSeq) {
      timeline.push({
        type: jsPsychHtmlKeyboardResponse,
        stimulus: `<div style="max-width: 900px; margin: 0 auto; text-align:left;">
          <h3>Next task: ${escapeHtml(c.taskType)}</h3>
          <div style="opacity:0.75">Code: ${escapeHtml(code)} • Config: ${escapeHtml(c.id || '')}</div>
          <div style="margin-top:12px; opacity:0.9">Press any key to begin.</div>
        </div>`,
        choices: 'ALL_KEYS',
        data: { plugin_type: 'task-break', code, task_type: c.taskType, config_id: c.id || null }
      });

      for (const t of c.timeline) {
        const baseData = (t && typeof t.data === 'object' && t.data) ? t.data : {};
        t.data = { ...baseData, code, task_type: c.taskType, config_id: c.id || null };
        timeline.push(t);
      }
    }

    // Helpful when debugging plugin-load issues.
    logPluginGlobals();
    validateTimelinePlugins(timeline, code || 'multi');

    setStatus(`Loaded ${seq.length} config(s) for code ${code}. Timeline length: ${timeline.length}. Starting...`);

    const jsPsych = initJsPsych({
      display_element: 'jspsych-target',
      on_finish: async () => {
        try {
          if (eyeHud && typeof eyeHud.stop === 'function') eyeHud.stop();
        } catch {
          // ignore
        }

        let eyeTrackingExtraRow = null;

        // Multi-config mode: if any config enabled eye tracking, we try to stop and attach samples.
        // (If not started, stop() is a no-op.)
        try {
          if (eyeTrackingEnabledAny && window.EyeTrackingWebGazer && typeof window.EyeTrackingWebGazer.stop === 'function') {
            const stopRes = await window.EyeTrackingWebGazer.stop();
            const samples = window.EyeTrackingWebGazer.getSamples ? window.EyeTrackingWebGazer.getSamples() : [];

            const safeSamples = Array.isArray(samples) ? samples : [];
            const stats = (window.EyeTrackingWebGazer && typeof window.EyeTrackingWebGazer.getStats === 'function')
              ? window.EyeTrackingWebGazer.getStats()
              : null;
            const eyePayload = {
              plugin_type: 'eye-tracking',
              eye_tracking_provider: 'webgazer',
              eye_tracking_enabled: true,
              eye_tracking_started: !!(eyeTrackingStartResult && eyeTrackingStartResult.ok === true && eyeTrackingStartResult.started === true),
              eye_tracking_start_result: eyeTrackingStartResult,
              eye_tracking_stop_result: stopRes,
              eye_tracking_calibration_json: JSON.stringify(Array.isArray(eyeTrackingCalibrationEvents) ? eyeTrackingCalibrationEvents : []),
              eye_tracking_sample_count: safeSamples.length,
              eye_tracking_samples_json: JSON.stringify(safeSamples),
              eye_tracking_stats: stats
            };

            const persisted = tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload);
            if (!persisted || persisted.ok !== true) {
              eyeTrackingExtraRow = eyePayload;
              console.warn('Could not persist eye tracking payload (multi) (no addToLast); will append at export time');
            }

            if (window.EyeTrackingWebGazer.clear) window.EyeTrackingWebGazer.clear();
            if (stopRes && stopRes.ok === false) {
              console.warn('EyeTrackingWebGazer stop returned error (multi):', stopRes);
            }
          } else if (eyeTrackingEnabledAny && jsPsych && jsPsych.data) {
            // Eye tracking enabled but WebGazer manager missing.
            const eyePayload = {
              plugin_type: 'eye-tracking',
              eye_tracking_provider: 'webgazer',
              eye_tracking_enabled: true,
              eye_tracking_started: false,
              eye_tracking_start_result: eyeTrackingStartResult || { ok: false, started: false, reason: 'EyeTrackingWebGazer_missing' },
              eye_tracking_calibration_json: JSON.stringify(Array.isArray(eyeTrackingCalibrationEvents) ? eyeTrackingCalibrationEvents : []),
              eye_tracking_sample_count: 0,
              eye_tracking_samples_json: '[]'
            };

            const persisted = tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload);
            if (!persisted || persisted.ok !== true) {
              eyeTrackingExtraRow = eyePayload;
              console.warn('Could not persist eye tracking payload (multi missing manager); will append at export time');
            }
          }
        } catch (e) {
          console.warn('Eye tracking finalize failed (multi):', e);

          // Still write a row so the payload reflects the issue.
          try {
            if (eyeTrackingEnabledAny && jsPsych && jsPsych.data) {
              const eyePayload = {
                plugin_type: 'eye-tracking',
                eye_tracking_provider: 'webgazer',
                eye_tracking_enabled: true,
                eye_tracking_started: false,
                eye_tracking_start_result: eyeTrackingStartResult,
                eye_tracking_finalize_error: e && e.message ? e.message : String(e),
                eye_tracking_calibration_json: JSON.stringify(Array.isArray(eyeTrackingCalibrationEvents) ? eyeTrackingCalibrationEvents : []),
                eye_tracking_sample_count: 0,
                eye_tracking_samples_json: '[]'
              };

              const persisted = tryPersistEyeTrackingToJsPsych(jsPsych, eyePayload);
              if (!persisted || persisted.ok !== true) {
                eyeTrackingExtraRow = eyePayload;
                console.warn('Could not persist eye tracking error payload (multi); will append at export time');
              }
            }
          } catch {
            // ignore
          }
        }

        const baseValues = getJsPsychValues(jsPsych);
        const finalValues = eyeTrackingExtraRow ? baseValues.concat([eyeTrackingExtraRow]) : baseValues;
        const dataJson = JSON.stringify(finalValues);

        if (typeof window.jatos !== 'undefined' && window.jatos && typeof window.jatos.submitResultData === 'function') {
          try {
            await window.jatos.submitResultData(dataJson);
            if (typeof window.jatos.endStudyAjax === 'function') {
              window.jatos.endStudyAjax(true);
            } else if (typeof window.jatos.endStudy === 'function') {
              window.jatos.endStudy(true);
            }
            return;
          } catch (e) {
            console.error('JATOS submit failed:', e);
            setStatus(`JATOS submit failed: ${e && e.message ? e.message : String(e)}`);
          }
        }

        if (getDebugMode()) {
          downloadDebugData(jsPsych, String(code || 'multi'), finalValues);
        }

        console.log('Experiment finished. Data:', jsPsych.data.get().values());
        setStatus('Experiment finished (local mode). Data logged to console.');
      }
    });

    Promise.resolve(jsPsych.run(timeline)).catch((e) => {
      console.error('jsPsych.run failed:', e);
      setStatus(e && e.message ? e.message : String(e));
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function bootstrap() {
    detectJatos();

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const baseParam = params.get('base');
    const manifestParam = params.get('manifest');
    const loaderOpts = {
      baseUrl: (typeof window.ConfigLoader.normalizeBaseUrl === 'function')
        ? window.ConfigLoader.normalizeBaseUrl(baseParam, 'configs')
        : (baseParam || 'configs'),
      manifestUrl: manifestParam
    };

    if (id) {
      const trimmed = String(id).trim();
      const looksLikeCode = /^[A-Za-z0-9]{7}$/.test(trimmed);

      if (looksLikeCode && typeof window.ConfigLoader.loadConfigsByCode === 'function') {
        setStatus(`Loading configs for code: ${trimmed} ...`);
        window.ConfigLoader.loadConfigsByCode(trimmed, loaderOpts)
          .then((configs) => startExperimentFromConfigs(configs, trimmed))
          .catch((e) => {
            console.error(e);
            setStatus(e && e.message ? e.message : String(e));
          });
        return;
      }

      setStatus(`Loading config: ${id} ...`);
      window.ConfigLoader.loadConfigById(id, loaderOpts)
        .then(({ config, id: loadedId }) => startExperiment(config, loadedId || id))
        .catch((e) => {
          console.error(e);
          setStatus(e && e.message ? e.message : String(e));
        });
    } else {
      setStatus('Missing required URL param: ?id=...');
    }
  }

  ensureJatosLoaded().then((hasJatos) => {
    if (hasJatos && typeof window.jatos.onLoad === 'function') {
      window.jatos.onLoad(bootstrap);
    } else {
      bootstrap();
    }
  });
})();
