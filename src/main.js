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

  function downloadDebugData(jsPsych, idForName) {
    const stamp = formatTimestampForFilename(new Date());
    const safeId = String(idForName || 'local').trim() || 'local';
    const fmt = getDebugFormat();

    if (fmt === 'json') {
      const dataJson = jsPsych.data.get().json();
      return downloadTextFile(dataJson, `psychjson-data-${safeId}-${stamp}.json`, 'application/json');
    }

    // Default: CSV
    // jsPsych's csv() doesn't expand nested arrays (like continuous RDM 'records'),
    // so we expand those into one row per record.
    const values = jsPsych.data.get().values();
    const expanded = expandJsPsychRowsForCsv(values);
    const dataCsv = rowsToCsv(expanded);
    return downloadTextFile(dataCsv, `psychjson-data-${safeId}-${stamp}.csv`, 'text/csv');
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

  async function startExperiment(config) {
    const compiled = window.TimelineCompiler.compileToJsPsychTimeline(config);
    setStatus(`Compiled timeline: ${compiled.timeline.length} items (${compiled.experimentType}). Starting...`);

    const jsPsych = initJsPsych({
      display_element: 'jspsych-target',
      on_finish: async () => {
        const dataJson = jsPsych.data.get().json();

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
          downloadDebugData(jsPsych, id);
        }

        // Local fallback: dump to console
        console.log('Experiment finished. Data:', jsPsych.data.get().values());
        setStatus('Experiment finished (local mode). Data logged to console.');
      }
    });

    jsPsych.run(compiled.timeline);
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

    const timeline = [];
    for (const c of seq) {
      const cfg = c && c.config ? c.config : null;
      if (!cfg) continue;

      const taskType = (cfg.task_type || 'task').toString();
      timeline.push({
        type: jsPsychHtmlKeyboardResponse,
        stimulus: `<div style="max-width: 900px; margin: 0 auto; text-align:left;">
          <h3>Next task: ${escapeHtml(taskType)}</h3>
          <div style="opacity:0.75">Code: ${escapeHtml(code)} • Config: ${escapeHtml(c.id || '')}</div>
          <div style="margin-top:12px; opacity:0.9">Press any key to begin.</div>
        </div>`,
        choices: 'ALL_KEYS',
        data: { plugin_type: 'task-break', code, task_type: taskType, config_id: c.id || null }
      });

      const compiled = window.TimelineCompiler.compileToJsPsychTimeline(cfg);
      for (const t of compiled.timeline) {
        const baseData = (t && typeof t.data === 'object' && t.data) ? t.data : {};
        t.data = { ...baseData, code, task_type: taskType, config_id: c.id || null };
        timeline.push(t);
      }
    }

    setStatus(`Loaded ${seq.length} config(s) for code ${code}. Timeline length: ${timeline.length}. Starting...`);

    const jsPsych = initJsPsych({
      display_element: 'jspsych-target',
      on_finish: async () => {
        const dataJson = jsPsych.data.get().json();

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
          downloadDebugData(jsPsych, String(code || 'multi'));
        }

        console.log('Experiment finished. Data:', jsPsych.data.get().values());
        setStatus('Experiment finished (local mode). Data logged to console.');
      }
    });

    jsPsych.run(timeline);
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
        .then(({ config }) => startExperiment(config))
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
