(function (jspsych) {
  const PT = (jspsych && jspsych.ParameterType)
    || (window.jsPsychModule && window.jsPsychModule.ParameterType)
    || (window.jsPsych && window.jsPsych.ParameterType)
    || {
      BOOL: 'BOOL',
      STRING: 'STRING',
      INT: 'INT',
      FLOAT: 'FLOAT',
      OBJECT: 'OBJECT',
      KEY: 'KEY',
      KEYS: 'KEYS',
      SELECT: 'SELECT',
      HTML_STRING: 'HTML_STRING',
      COMPLEX: 'COMPLEX',
      FUNCTION: 'FUNCTION',
      TIMELINE: 'TIMELINE'
    };

  const info = {
    name: 'soc-dashboard',
    version: '0.6.2',
    parameters: {
      trial_duration_ms: { type: PT.INT, default: 60000 },
      end_key: { type: PT.STRING, default: 'escape' },
      title: { type: PT.STRING, default: 'SOC Dashboard' },
      wallpaper_url: { type: PT.STRING, default: '' },
      background_color: { type: PT.STRING, default: '#0b1220' },
      start_menu_enabled: { type: PT.BOOL, default: true },
      default_app: { type: PT.STRING, default: 'soc' },
      pinned_apps: { type: PT.COMPLEX, default: ['soc', 'email', 'terminal'] },
      num_tasks: { type: PT.INT, default: 1 },
      subtasks: { type: PT.COMPLEX, default: null },
      desktop_icons: { type: PT.COMPLEX, default: null },
      icons_clickable: { type: PT.BOOL, default: true },
      log_icon_clicks: { type: PT.BOOL, default: true },
      icon_clicks_are_distractors: { type: PT.BOOL, default: true }
    },
    data: {
      ended_reason: { type: PT.STRING },
      active_app: { type: PT.STRING },
      events: { type: PT.COMPLEX },
      plugin_version: { type: PT.STRING }
    }
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function clamp(n, min, max) {
    const x = Number(n);
    if (!Number.isFinite(x)) return min;
    return Math.max(min, Math.min(max, x));
  }

  function parseTokenList(raw) {
    if (Array.isArray(raw)) {
      return raw
        .map(x => (x ?? '').toString().trim())
        .filter(Boolean);
    }
    const text = (raw ?? '').toString();
    return text
      .split(/[\r\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function pickRandom(list) {
    if (!Array.isArray(list) || list.length === 0) return null;
    const idx = Math.floor(Math.random() * list.length);
    return list[idx];
  }

  function randomInt(min, max) {
    const lo = Math.ceil(min);
    const hi = Math.floor(max);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  function randomIp() {
    // Use private-ish ranges to avoid looking like real addresses.
    const a = 10;
    const b = randomInt(0, 255);
    const c = randomInt(0, 255);
    const d = randomInt(1, 254);
    return `${a}.${b}.${c}.${d}`;
  }

  function formatClock(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function normalizeKeyName(raw) {
    const str = (raw ?? '').toString();
    if (str === ' ') return ' ';

    const t = str.trim();
    const lower = t.toLowerCase();
    if (lower === 'space') return ' ';
    if (lower === 'enter') return 'Enter';
    if (lower === 'escape' || lower === 'esc') return 'Escape';
    if (t.length === 1) return t.toLowerCase();
    return t;
  }

  function escHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function makeShellStyle() {
    const style = document.createElement('style');
    style.dataset.socDashboard = 'true';
    style.textContent = `
      .soc-shell { position: relative; width: 100%; height: 100vh; background: #0b1220; color: #e7eefc; overflow: hidden; }
      .soc-wallpaper { position:absolute; inset:0; background: radial-gradient(1200px 600px at 20% 10%, rgba(61,122,255,0.35), transparent 55%), radial-gradient(900px 500px at 70% 60%, rgba(20,200,160,0.25), transparent 55%), linear-gradient(135deg, #0b1220, #070b13); filter: saturate(1.05) contrast(1.02); }
      .soc-shell.has-wallpaper .soc-wallpaper { background-size: cover; background-position: center; }

      .soc-desktop { position:absolute; inset:0; padding: 18px; }
      .soc-desktop-icons { position:absolute; top: 18px; left: 18px; display:flex; flex-direction: column; gap: 10px; z-index: 2; }
      .soc-icon { width: 92px; user-select:none; cursor: default; text-align:center; padding: 6px 6px 10px 6px; border-radius: 10px; }
      .soc-icon.clickable { cursor: pointer; }
      .soc-icon.clickable:hover { background: rgba(255,255,255,0.10); }
      .soc-icon .ico { width: 44px; height: 44px; margin: 0 auto 6px auto; border-radius: 10px; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.16); display:flex; align-items:center; justify-content:center; font-weight: 700; }
      .soc-icon .lbl { font-size: 12px; opacity: 0.95; text-shadow: 0 1px 2px rgba(0,0,0,0.4); }

      .soc-windows { position:absolute; top: 18px; right: 18px; bottom: 18px; left: 140px; display:grid; gap: 12px; grid-auto-rows: 1fr; z-index: 3; }
      .soc-appwin { background: rgba(12,16,26,0.88); border: 1px solid rgba(255,255,255,0.12); border-radius: 12px; box-shadow: 0 18px 55px rgba(0,0,0,0.50); overflow:hidden; min-height: 0; }
      /* Keep grid position stable when windows hide/show */
      .soc-appwin.soc-win-hidden { visibility: hidden; pointer-events: none; }
      .soc-appwin .titlebar { height: 38px; display:flex; align-items:center; gap: 10px; padding: 0 12px; background: rgba(255,255,255,0.06); border-bottom: 1px solid rgba(255,255,255,0.10); }
      .soc-appwin .titlebar .ttl { font-weight: 600; font-size: 13px; }
      .soc-appwin .content { padding: 12px; height: calc(100% - 38px); overflow:auto; }

      .soc-card { border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05); border-radius: 12px; padding: 12px; }
      .soc-card h4 { margin:0 0 6px 0; font-size: 13px; }
      .soc-card .muted { opacity: 0.8; font-size: 12px; }
      .soc-table { width:100%; border-collapse: collapse; font-size: 12px; }
      .soc-table th, .soc-table td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 6px 6px; text-align:left; }
      .soc-pill { display:inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); }
      .soc-pill.high { background: rgba(255,70,70,0.16); border-color: rgba(255,70,70,0.45); }
      .soc-pill.med { background: rgba(255,190,61,0.16); border-color: rgba(255,190,61,0.45); }
      .soc-pill.low { background: rgba(61,214,255,0.14); border-color: rgba(61,214,255,0.40); }

      .soc-log-header { display:flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .soc-log-header .hint { font-size: 12px; opacity: 0.85; }
      .soc-log-feed { width:100%; border-collapse: collapse; font-size: 12px; }
      .soc-log-feed th, .soc-log-feed td { border-bottom: 1px solid rgba(255,255,255,0.08); padding: 6px 6px; text-align:left; }
      .soc-log-feed tbody tr { transition: background 120ms ease; }
      .soc-log-feed tbody tr.target { background: rgba(255, 77, 77, 0.12); }
      .soc-log-feed tbody tr.distractor { background: rgba(61, 214, 255, 0.10); }
      .soc-log-feed tbody tr.current { box-shadow: inset 0 0 0 2px rgba(250,204,21,0.55); }
      .soc-log-feed tbody tr.responded { opacity: 0.78; }
      .soc-log-feed tbody tr:hover { background: rgba(255,255,255,0.06); }
      .soc-log-feed tbody tr.clickable { cursor: pointer; }
      .soc-log-tag { display:inline-block; font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); }
      .soc-log-go-btn { font-size: 11px; padding: 4px 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.08); color: #fff; cursor: pointer; }
      .soc-log-go-btn:hover { background: rgba(255,255,255,0.12); }
      .soc-log-go-btn:disabled { opacity: 0.5; cursor: default; }

      /* Per-subtask instructions overlay */
      .soc-card.soc-subtask-wrap { position: relative; }
      .soc-subtask-overlay { position: absolute; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(2,6,23,0.72); backdrop-filter: blur(6px); }
      .soc-subtask-overlay .panel { max-width: 620px; width: 100%; border-radius: 14px; border: 1px solid rgba(255,255,255,0.14); background: rgba(12,16,26,0.92); box-shadow: 0 20px 70px rgba(0,0,0,0.60); padding: 14px 14px; cursor: pointer; }
      .soc-subtask-overlay .panel h3 { margin: 0 0 8px 0; font-size: 14px; }
      .soc-subtask-overlay .panel .body { font-size: 12px; opacity: 0.95; line-height: 1.45; }
      .soc-subtask-overlay .panel .hint { margin-top: 10px; font-size: 12px; opacity: 0.80; }

      /* Inline instructions (for scheduled subtasks: non-blocking) */
      .soc-inline-instructions { margin: 0 0 10px; padding: 10px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04); }
      .soc-inline-instructions summary { cursor: pointer; font-size: 12px; opacity: 0.9; }
      .soc-inline-instructions .body { margin-top: 8px; font-size: 12px; opacity: 0.95; line-height: 1.45; }

      /* N-back-like (alert correlation) */
      .soc-nback-header { display:flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .soc-nback-header .hint { font-size: 12px; opacity: 0.85; }
      .soc-nback-card { border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.05); border-radius: 12px; padding: 12px; }
      .soc-nback-card .top { display:flex; justify-content: space-between; gap: 10px; align-items: baseline; }
      .soc-nback-grid { margin-top: 10px; display:grid; grid-template-columns: 140px 1fr; gap: 6px 12px; font-size: 12px; }
      .soc-nback-k { opacity: 0.78; }
      .soc-nback-v b { font-weight: 650; }
      .soc-nback-pill { display:inline-block; font-size: 10px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); }
      .soc-nback-flash { animation: socFlash 220ms ease-out; }
      @keyframes socFlash { from { box-shadow: 0 0 0 0 rgba(14,165,233,0.35); } to { box-shadow: 0 0 0 10px rgba(14,165,233,0.0); } }
    `;
    return style;
  }

  function defaultDesktopIcons() {
    return [
      { label: 'Documents', app: 'docs', icon_text: 'DOC', distractor: true },
      { label: 'My File', app: 'file', icon_text: 'FILE', distractor: true },
      { label: 'Recycle Bin', app: 'bin', icon_text: 'BIN', distractor: true }
    ];
  }

  function coerceDesktopIcons(raw) {
    if (!Array.isArray(raw)) return defaultDesktopIcons();
    const icons = raw
      .filter(x => x && typeof x === 'object')
      .map((x) => ({
        label: (x.label ?? x.name ?? 'Icon').toString(),
        app: (x.app ?? '').toString(),
        icon_text: (x.icon_text ?? '').toString(),
        distractor: (x.distractor !== undefined) ? !!x.distractor : true
      }));
    return icons.length ? icons : defaultDesktopIcons();
  }

  function makeTaskRows(taskIndex) {
    const rows = [];
    const n = 6;
    for (let i = 0; i < n; i++) {
      const sev = (i % 3 === 0) ? 'high' : (i % 3 === 1 ? 'med' : 'low');
      rows.push({
        id: `EV-${taskIndex + 1}-${String(i + 1).padStart(2, '0')}`,
        service: (i % 2 === 0) ? 'Auth' : 'Payments',
        msg: (i % 2 === 0) ? 'Login spike detected' : 'Latency above threshold',
        sev
      });
    }
    return rows;
  }

  function JsPsychSocDashboardPlugin(jsPsych) {
    this.jsPsych = jsPsych;
  }

  JsPsychSocDashboardPlugin.prototype.trial = function (display_element, trial) {
    const startTs = nowMs();
    const events = [];

    const trialMs = Number.isFinite(Number(trial.trial_duration_ms)) ? Number(trial.trial_duration_ms) : null;
    const endKey = normalizeKeyName(trial.end_key ?? 'escape');
    const title = (trial.title ?? 'SOC Dashboard').toString();

    const numTasksRaw = Number(trial.num_tasks);
    const fallbackCount = Number.isFinite(numTasksRaw) ? Math.max(1, Math.min(4, Math.floor(numTasksRaw))) : 1;

    const rawSubtasks = Array.isArray(trial.subtasks) ? trial.subtasks : [];
    const subtasks = rawSubtasks
      .filter(x => x && typeof x === 'object')
      .map((x) => {
        const copy = { ...x };
        copy.type = (x.type ?? x.kind ?? '').toString();
        copy.title = (x.title ?? x.name ?? '').toString();
        return copy;
      })
      .filter(x => x.title || x.type);

    function coerceSchedule(rawSubtask) {
      const o = (rawSubtask && typeof rawSubtask === 'object') ? rawSubtask : {};

      const startAtRaw = Number(o.start_at_ms);
      const startDelayRaw = Number(o.start_delay_ms);
      const durationRaw = Number(o.duration_ms);
      const endAtRaw = Number(o.end_at_ms);

      const hasSchedule = (
        (Number.isFinite(startAtRaw) && startAtRaw > 0)
        || (Number.isFinite(startDelayRaw) && startDelayRaw > 0)
        || (Number.isFinite(durationRaw) && durationRaw > 0)
        || (Number.isFinite(endAtRaw) && endAtRaw > 0)
      );

      if (!hasSchedule) {
        return { has_schedule: false, start_at_ms: 0, end_at_ms: null };
      }

      let startAt = startAtRaw;
      if (!Number.isFinite(startAt)) startAt = startDelayRaw;
      startAt = Number.isFinite(startAt) ? Math.max(0, Math.floor(startAt)) : 0;

      const duration = durationRaw;
      let endAt = endAtRaw;

      if (Number.isFinite(duration) && duration > 0) {
        const dur = Math.max(1, Math.floor(duration));
        endAt = startAt + dur;
      } else if (Number.isFinite(endAt) && endAt > 0) {
        endAt = Math.max(1, Math.floor(endAt));
      } else {
        endAt = null;
      }

      if (Number.isFinite(endAt) && endAt < startAt) {
        endAt = startAt;
      }

      return { has_schedule: true, start_at_ms: startAt, end_at_ms: Number.isFinite(endAt) ? endAt : null };
    }

    const windowsSpec = subtasks.length
      ? subtasks.map((s, idx) => ({
          subtask_type: s.type || null,
          subtask_title: s.title || (s.type ? s.type : `Subtask ${idx + 1}`),
          subtask: s,
          schedule: coerceSchedule(s)
        }))
      : Array.from({ length: fallbackCount }, (_, i) => ({
          subtask_type: null,
          subtask_title: `Task ${i + 1}`,
          subtask: null,
          schedule: { has_schedule: false, start_at_ms: 0, end_at_ms: null }
        }));

    const subtaskStartTs = new Array(windowsSpec.length).fill(null);
    const markGenericSubtaskStart = (idx) => {
      if (!Number.isFinite(idx) || idx < 0 || idx >= windowsSpec.length) return;
      if (subtaskStartTs[idx] !== null) return;
      subtaskStartTs[idx] = nowMs();
      const wSpec = windowsSpec[idx] || {};
      events.push({
        t_ms: Math.round(nowMs() - startTs),
        type: 'subtask_start',
        subtask_index: idx,
        subtask_title: (wSpec.subtask_title ?? '').toString() || null,
        subtask_type: (wSpec.subtask_type ?? '').toString() || null
      });
    };

    const installInstructionsOverlay = (hostEl, overlayTitle, instructionsHtml, onStart) => {
      const raw = (instructionsHtml ?? '').toString();
      const html = raw.trim();
      if (!html) {
        try { onStart?.(); } catch { /* ignore */ }
        return null;
      }

      const overlay = document.createElement('div');
      overlay.className = 'soc-subtask-overlay';
      overlay.innerHTML = `
        <div class="panel" role="button" tabindex="0" aria-label="Subtask instructions">
          <h3>${escHtml(overlayTitle || 'Instructions')}</h3>
          <div class="body" data-soc-overlay-body="true"></div>
          <div class="hint">Click this popup to begin.</div>
        </div>
      `;

      const body = overlay.querySelector('[data-soc-overlay-body="true"]');
      if (body) {
        // Treat as trusted experiment-authored HTML.
        body.innerHTML = raw;
      }

      const startOnce = () => {
        try { overlay.remove(); } catch { /* ignore */ }
        try { onStart?.(); } catch { /* ignore */ }
      };

      overlay.addEventListener('click', startOnce, { once: true });
      overlay.addEventListener('keydown', (e) => {
        const k = normalizeKeyName(e.key);
        if (k === 'Enter' || k === ' ') {
          e.preventDefault();
          startOnce();
        }
      });

      hostEl.appendChild(overlay);
      return overlay;
    };

    const renderInlineInstructions = (hostEl, overlayTitle, instructionsHtml) => {
      const raw = (instructionsHtml ?? '').toString();
      const html = raw.trim();
      if (!html) return null;

      const details = document.createElement('details');
      details.className = 'soc-inline-instructions';
      details.open = false;
      details.innerHTML = `
        <summary>${escHtml(overlayTitle || 'Instructions')}</summary>
        <div class="body" data-soc-inline-body="true"></div>
      `;

      const body = details.querySelector('[data-soc-inline-body="true"]');
      if (body) {
        // Treat as trusted experiment-authored HTML.
        body.innerHTML = raw;
      }

      try {
        hostEl.insertAdjacentElement('afterbegin', details);
      } catch {
        try { hostEl.prepend(details); } catch { /* ignore */ }
      }
      return details;
    };

    const substitutePlaceholders = (html, map) => {
      let out = (html ?? '').toString();
      for (const [k, v] of Object.entries(map || {})) {
        const safe = escHtml((v ?? '').toString());
        out = out.replaceAll(`{{${k}}}`, safe);
        out = out.replaceAll(`{{${k.toLowerCase()}}}`, safe);
      }
      return out;
    };

    const cols = (windowsSpec.length <= 2) ? windowsSpec.length : 2;

    const logIconClicks = (trial.log_icon_clicks !== undefined) ? !!trial.log_icon_clicks : true;
    const iconsClickable = (trial.icons_clickable !== undefined) ? !!trial.icons_clickable : true;

    let ended = false;
    let activeWindowIndex = 0;

    const scheduledTimeouts = [];
    const scheduledIntervals = [];

    const setSafeTimeout = (fn, ms) => {
      const id = setTimeout(fn, ms);
      scheduledTimeouts.push(id);
      return id;
    };

    const clearAllTimers = () => {
      for (const id of scheduledTimeouts) {
        try { clearTimeout(id); } catch { /* ignore */ }
      }
      for (const id of scheduledIntervals) {
        try { clearInterval(id); } catch { /* ignore */ }
      }
      scheduledTimeouts.length = 0;
      scheduledIntervals.length = 0;
    };

    const windowEls = new Array(windowsSpec.length).fill(null);
    const subtaskAutoStart = new Array(windowsSpec.length).fill(null);
    const subtaskForceEnd = new Array(windowsSpec.length).fill(null);
    const windowHasStarted = new Array(windowsSpec.length).fill(false);

    // Per-window instruction popup (click-to-start)
    const windowInstructionsHost = new Array(windowsSpec.length).fill(null);
    const windowInstructionsTitle = new Array(windowsSpec.length).fill(null);
    const windowInstructionsHtml = new Array(windowsSpec.length).fill('');
    const windowInstructionsOverlay = new Array(windowsSpec.length).fill(null);
    const windowStartIsGated = new Array(windowsSpec.length).fill(false);

    const isWindowVisible = (idx) => {
      const el = windowEls[idx];
      if (!el) return false;
      return !el.classList.contains('soc-win-hidden');
    };

    const pickFirstVisibleKeyboardWindow = () => {
      for (let i = 0; i < windowsSpec.length; i++) {
        if (!isWindowVisible(i)) continue;
        const t = (windowsSpec[i]?.subtask_type ?? '').toString().toLowerCase();
        if (t === 'sart-like' || t === 'nback-like') return i;
      }
      for (let i = 0; i < windowsSpec.length; i++) {
        if (isWindowVisible(i)) return i;
      }
      return 0;
    };

    const ensureActiveWindowVisible = () => {
      if (Number.isFinite(activeWindowIndex) && activeWindowIndex >= 0 && activeWindowIndex < windowsSpec.length && isWindowVisible(activeWindowIndex)) {
        return;
      }
      activeWindowIndex = pickFirstVisibleKeyboardWindow();
    };

    const showWindow = (idx) => {
      const el = windowEls[idx];
      if (!el) return;
      const wasHidden = el.classList.contains('soc-win-hidden');
      if (wasHidden) {
        el.classList.remove('soc-win-hidden');
        events.push({
          t_ms: Math.round(nowMs() - startTs),
          type: 'subtask_window_show',
          subtask_index: idx,
          subtask_title: (windowsSpec[idx]?.subtask_title ?? '').toString() || null,
          subtask_type: (windowsSpec[idx]?.subtask_type ?? '').toString() || null
        });
      }
      activeWindowIndex = idx;
      // If this window has instructions, install the popup when the window becomes visible.
      maybeInstallWindowInstructions(idx);
    };

    const hideWindow = (idx) => {
      const el = windowEls[idx];
      if (!el) return;
      if (el.classList.contains('soc-win-hidden')) return;
      el.classList.add('soc-win-hidden');
      events.push({
        t_ms: Math.round(nowMs() - startTs),
        type: 'subtask_window_hide',
        subtask_index: idx,
        subtask_title: (windowsSpec[idx]?.subtask_title ?? '').toString() || null,
        subtask_type: (windowsSpec[idx]?.subtask_type ?? '').toString() || null
      });
      if (activeWindowIndex === idx) {
        ensureActiveWindowVisible();
      }
    };

    const startWindowIfNeeded = (idx) => {
      if (windowHasStarted[idx]) return;
      windowHasStarted[idx] = true;
      try { subtaskAutoStart[idx]?.(); } catch { /* ignore */ }
      ensureActiveWindowVisible();
    };

    const maybeInstallWindowInstructions = (idx) => {
      if (!Number.isFinite(idx) || idx < 0 || idx >= windowsSpec.length) return;
      if (windowHasStarted[idx]) return;
      if (windowInstructionsOverlay[idx]) return;

      const hostEl = windowInstructionsHost[idx];
      if (!hostEl) return;
      if (!isWindowVisible(idx)) return;

      const raw = (windowInstructionsHtml[idx] ?? '').toString();
      const html = raw.trim();

      if (!html) {
        windowStartIsGated[idx] = false;
        // No instructions => start immediately when the window becomes visible.
        startWindowIfNeeded(idx);
        return;
      }

      const titleRaw = (windowInstructionsTitle[idx] ?? windowsSpec[idx]?.subtask_title ?? 'Instructions').toString();
      const overlay = installInstructionsOverlay(hostEl, titleRaw, raw, () => startWindowIfNeeded(idx));
      windowInstructionsOverlay[idx] = overlay;
      windowStartIsGated[idx] = !!overlay;
    };

    const forceEndWindow = (idx, reason = 'scheduled_end') => {
      try { subtaskForceEnd[idx]?.(reason); } catch { /* ignore */ }
    };

    const coerceSartLikeConfig = (raw) => {
      const o = (raw && typeof raw === 'object') ? raw : {};
      let minRun = Number(o.min_run_ms);
      let maxRun = Number(o.max_run_ms);
      minRun = Number.isFinite(minRun) ? Math.max(0, Math.floor(minRun)) : 30000;
      maxRun = Number.isFinite(maxRun) ? Math.max(0, Math.floor(maxRun)) : 60000;
      if (minRun > 0 && maxRun > 0 && maxRun < minRun) {
        const tmp = minRun;
        minRun = maxRun;
        maxRun = tmp;
      }

      const visibleEntries = clamp(o.visible_entries, 3, 25);
      const scrollInterval = clamp(o.scroll_interval_ms, 100, 10000);
      const responseDevice = ((o.response_device ?? 'keyboard').toString().trim().toLowerCase() === 'mouse') ? 'mouse' : 'keyboard';
      const goKey = normalizeKeyName(o.go_key ?? 'space');
      const goButton = ((o.go_button ?? 'action').toString().trim().toLowerCase() === 'change') ? 'change' : 'action';
      const goCondition = ((o.go_condition ?? 'target').toString().trim().toLowerCase() === 'distractor') ? 'distractor' : 'target';

      const showMarkers = (o.show_markers !== undefined) ? !!o.show_markers : false;

      const highlight = (o.highlight_subdomains !== undefined) ? !!o.highlight_subdomains : true;
      const targetColor = (o.target_highlight_color ?? '#ff4d4d').toString();
      const distractorColor = (o.distractor_highlight_color ?? '#3dd6ff').toString();

      const targetList = parseTokenList(o.target_subdomains);
      const distractorList = parseTokenList(o.distractor_subdomains);
      const neutralList = parseTokenList(o.neutral_subdomains);

      const targetProb = clamp(o.target_probability, 0, 1);
      const distractorProb = clamp(o.distractor_probability, 0, 1);

      return {
        visible_entries: visibleEntries,
        scroll_interval_ms: scrollInterval,
        min_run_ms: minRun,
        max_run_ms: maxRun,
        response_device: responseDevice,
        go_key: goKey,
        go_button: goButton,
        go_condition: goCondition,
        show_markers: showMarkers,
        highlight_subdomains: highlight,
        target_highlight_color: targetColor,
        distractor_highlight_color: distractorColor,
        target_subdomains: targetList,
        distractor_subdomains: distractorList,
        neutral_subdomains: neutralList,
        target_probability: targetProb,
        distractor_probability: distractorProb
      };
    };

    const sartStates = [];
    const nbackStates = [];

    const styleEl = makeShellStyle();
    display_element.innerHTML = '';
    display_element.appendChild(styleEl);

    const shell = document.createElement('div');
    shell.className = 'soc-shell';

    const wallpaper = document.createElement('div');
    wallpaper.className = 'soc-wallpaper';
    const wallpaperUrl = (trial.wallpaper_url ?? '').toString().trim();
    if (wallpaperUrl) {
      shell.classList.add('has-wallpaper');
      wallpaper.style.backgroundImage = `url(${JSON.stringify(wallpaperUrl).slice(1, -1)})`;
      wallpaper.style.backgroundSize = 'cover';
      wallpaper.style.backgroundPosition = 'center';
    } else {
      const bg = (trial.background_color ?? '').toString().trim();
      if (bg) {
        wallpaper.style.background = `radial-gradient(1200px 600px at 20% 10%, rgba(61,122,255,0.25), transparent 55%), radial-gradient(900px 500px at 70% 60%, rgba(20,200,160,0.18), transparent 55%), linear-gradient(135deg, ${bg}, #070b13)`;
      }
    }

    const desktop = document.createElement('div');
    desktop.className = 'soc-desktop';

    const iconsHost = document.createElement('div');
    iconsHost.className = 'soc-desktop-icons';
    const desktopIcons = coerceDesktopIcons(trial.desktop_icons);
    iconsHost.innerHTML = desktopIcons.map((ico) => {
      const label = escHtml(ico.label);
      const app = escHtml(ico.app);
      const iconText = escHtml(ico.icon_text || (ico.label || 'I').slice(0, 2).toUpperCase());
      const cls = `soc-icon${iconsClickable ? ' clickable' : ''}`;
      return `
        <div class="${cls}" data-label="${label}" data-app="${app}" role="button" tabindex="0">
          <div class="ico">${iconText}</div>
          <div class="lbl">${label}</div>
        </div>
      `;
    }).join('');

    const windows = document.createElement('div');
    windows.className = 'soc-windows';
    windows.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    for (let i = 0; i < windowsSpec.length; i++) {
      const wSpec = windowsSpec[i];
      const w = document.createElement('div');
      w.className = 'soc-appwin';

      windowEls[i] = w;
      const schedule = wSpec.schedule || { has_schedule: false, start_at_ms: 0, end_at_ms: null };
      if (schedule.has_schedule && Number(schedule.start_at_ms) > 0) {
        w.classList.add('soc-win-hidden');
      }

      const isSartLike = (wSpec.subtask_type || '').toString().toLowerCase() === 'sart-like';
      const isNbackLike = (wSpec.subtask_type || '').toString().toLowerCase() === 'nback-like';
      const winId = `soc_win_${i}`;

      w.innerHTML = `
        <div class="titlebar"><div class="ttl">${escHtml(title)} · ${escHtml(wSpec.subtask_title)}</div></div>
        <div class="content">
          <div class="soc-card" id="${escHtml(winId)}"></div>
        </div>
      `;
      windows.appendChild(w);

      // Initialize subtask content
      const host = w.querySelector(`#${winId}`);
      if (!host) continue;

      host.classList.add('soc-subtask-wrap');

      const subtaskInstructions = (wSpec?.subtask?.instructions ?? '').toString();
      const subtaskInstructionsTitleRaw = (wSpec?.subtask?.instructions_title ?? '').toString();
      const subtaskInstructionsTitle = subtaskInstructionsTitleRaw.trim() ? subtaskInstructionsTitleRaw : null;

      if (!isSartLike && !isNbackLike) {
        host.innerHTML = `
          <h4>Subtask window</h4>
          <div class="muted">Desktop icon clicks are distractors.${wSpec.subtask_type ? ` • Subtask: ${escHtml(wSpec.subtask_type)}` : ''}</div>
          <div class="muted" style="margin-top:12px;">End key: <b>${escHtml((trial.end_key ?? 'escape').toString())}</b>${trialMs ? ` • Auto-end: ${Math.round(trialMs / 1000)}s` : ''}</div>
        `;

        const startGeneric = () => {
          markGenericSubtaskStart(i);
        };

        subtaskAutoStart[i] = startGeneric;
        subtaskForceEnd[i] = () => { /* no-op */ };

        windowInstructionsHost[i] = host;
        windowInstructionsTitle[i] = wSpec.subtask_title;
        windowInstructionsHtml[i] = subtaskInstructions;
        maybeInstallWindowInstructions(i);
        continue;
      }

      if (isNbackLike) {
        const coerceNbackLikeConfig = (raw) => {
          const o = (raw && typeof raw === 'object') ? raw : {};

          const nRaw = Number(o.n);
          const n = Number.isFinite(nRaw) ? Math.max(1, Math.min(3, Math.floor(nRaw))) : 2;

          const matchField = ((o.match_field ?? 'src_ip').toString().trim().toLowerCase() === 'username') ? 'username' : 'src_ip';
          const paradigm = ((o.response_paradigm ?? 'go_nogo').toString().trim().toLowerCase() === '2afc') ? '2afc' : 'go_nogo';

          const goKey = normalizeKeyName(o.go_key ?? 'space');
          const matchKey = normalizeKeyName(o.match_key ?? 'j');
          const nonMatchKey = normalizeKeyName(o.nonmatch_key ?? 'f');

          const stimInterval = clamp(o.stimulus_interval_ms, 200, 10000);
          const targetProb = clamp(o.target_probability, 0, 1);

          let minRun = Number(o.min_run_ms);
          let maxRun = Number(o.max_run_ms);
          minRun = Number.isFinite(minRun) ? Math.max(0, Math.floor(minRun)) : 30000;
          maxRun = Number.isFinite(maxRun) ? Math.max(0, Math.floor(maxRun)) : 60000;
          if (minRun > 0 && maxRun > 0 && maxRun < minRun) {
            const tmp = minRun;
            minRun = maxRun;
            maxRun = tmp;
          }

          const showFeedback = (o.show_feedback !== undefined) ? !!o.show_feedback : false;

          return {
            n,
            match_field: matchField,
            response_paradigm: paradigm,
            go_key: goKey,
            match_key: matchKey,
            nonmatch_key: nonMatchKey,
            stimulus_interval_ms: stimInterval || 1200,
            target_probability: Number.isFinite(targetProb) ? targetProb : 0.25,
            min_run_ms: minRun,
            max_run_ms: maxRun,
            show_feedback: showFeedback
          };
        };

        const cfg = coerceNbackLikeConfig(wSpec.subtask || {});

        const state = {
          idx: i,
          title: wSpec.subtask_title,
          cfg,
          ended: false,
          started: false,
          subtask_start_ts: null,
          presented: 0,
          hits: 0,
          misses: 0,
          false_alarms: 0,
          correct_rejects: 0,
          omissions: 0,
          omissions_target: 0,
          omissions_nontarget: 0,
          buffer: [],
          current: null,
          current_is_match: false,
          current_presented_at: null,
          current_responded: false,
          current_response: null
        };
        nbackStates[i] = state;

        const tSubtaskMs = () => {
          const base = (state.subtask_start_ts ?? startTs);
          return Math.round(nowMs() - base);
        };

        const resolvedMatchFieldLabel = (cfg.match_field === 'username') ? 'Username' : 'Source IP';
        const resolvedGoControl = (cfg.response_paradigm === 'go_nogo')
          ? (cfg.go_key === ' ' ? 'SPACE' : cfg.go_key)
          : `${cfg.nonmatch_key === ' ' ? 'SPACE' : cfg.nonmatch_key} (NO) / ${cfg.match_key === ' ' ? 'SPACE' : cfg.match_key} (YES)`;
        const resolvedNoGoControl = (cfg.response_paradigm === 'go_nogo')
          ? 'withhold'
          : (cfg.nonmatch_key === ' ' ? 'SPACE' : cfg.nonmatch_key);

        const instructionsTitle = subtaskInstructionsTitle || 'Correlating repeat offenders';
        const resolvedInstructionsHtml = substitutePlaceholders(subtaskInstructions, {
          GO_CONTROL: resolvedGoControl,
          NOGO_CONTROL: resolvedNoGoControl,
          N: String(cfg.n),
          MATCH_FIELD: resolvedMatchFieldLabel
        });

        host.innerHTML = `
          <div class="soc-nback-header">
            <div>
              <h4 style="margin:0;">Alert correlation (${escHtml(String(cfg.n))}-back)</h4>
              <div class="hint">Press ${escHtml(resolvedGoControl)} when ${escHtml(resolvedMatchFieldLabel)} matches ${escHtml(String(cfg.n))}-back.</div>
            </div>
            <div class="hint" id="soc_nback_status_${i}">Ready</div>
          </div>

          <div class="soc-nback-card" id="soc_nback_card_${i}">
            <div class="top">
              <div class="soc-nback-pill" id="soc_nback_time_${i}">--:--:--</div>
              <div class="soc-nback-pill" id="soc_nback_disp_${i}">Disposition: —</div>
            </div>
            <div class="soc-nback-grid">
              <div class="soc-nback-k">Source IP</div><div class="soc-nback-v"><b id="soc_nback_src_${i}">—</b></div>
              <div class="soc-nback-k">Username</div><div class="soc-nback-v"><b id="soc_nback_user_${i}">—</b></div>
              <div class="soc-nback-k">Destination</div><div class="soc-nback-v" id="soc_nback_dest_${i}">—</div>
              <div class="soc-nback-k">Event</div><div class="soc-nback-v" id="soc_nback_evt_${i}">—</div>
              <div class="soc-nback-k">Risk</div><div class="soc-nback-v"><span id="soc_nback_risk_${i}">—</span></div>
              <div class="soc-nback-k">Match field</div><div class="soc-nback-v">${escHtml(resolvedMatchFieldLabel)}</div>
            </div>
          </div>
        `;

        const statusEl = host.querySelector(`#soc_nback_status_${i}`);
        const cardEl = host.querySelector(`#soc_nback_card_${i}`);
        const timeEl = host.querySelector(`#soc_nback_time_${i}`);
        const dispEl = host.querySelector(`#soc_nback_disp_${i}`);
        const srcEl = host.querySelector(`#soc_nback_src_${i}`);
        const userEl = host.querySelector(`#soc_nback_user_${i}`);
        const destEl = host.querySelector(`#soc_nback_dest_${i}`);
        const evtEl = host.querySelector(`#soc_nback_evt_${i}`);
        const riskEl = host.querySelector(`#soc_nback_risk_${i}`);

        const names = ['a.nguyen', 'j.smith', 'm.patel', 'r.garcia', 's.chen', 'k.johnson', 't.kim', 'l.brown'];
        const dests = ['secure-login.example', 'admin-portal.example', 'vpn.example', 'mail.example', 'files.example', 'hr.example'];
        const evts = ['Failed login', 'MFA challenge', 'Password spray suspected', 'Geo anomaly', 'New device', 'Impossible travel'];

        const computeStopAt = () => {
          const minR = cfg.min_run_ms;
          const maxR = cfg.max_run_ms;
          if (!minR && !maxR) return Infinity;
          if (minR && !maxR) return minR;
          if (!minR && maxR) return maxR;
          return randomInt(minR, maxR);
        };

        let startWall = null;
        let stopAt = null;

        const makeEntry = () => {
          const createdAt = nowMs();
          const entry = {
            id: `ALERT-${i + 1}-${String(state.presented + 1).padStart(4, '0')}`,
            createdAt,
            clock: formatClock(Date.now()),
            src_ip: randomIp(),
            username: pickRandom(names) || 'a.nguyen',
            dest: pickRandom(dests) || 'secure-login.example',
            event: pickRandom(evts) || 'Failed login',
            risk: randomInt(20, 95),
            disposition: '—'
          };
          return entry;
        };

        const renderEntry = (entry) => {
          if (!entry) return;
          if (timeEl) timeEl.textContent = entry.clock;
          if (srcEl) srcEl.textContent = entry.src_ip;
          if (userEl) userEl.textContent = entry.username;
          if (destEl) destEl.textContent = entry.dest;
          if (evtEl) evtEl.textContent = entry.event;
          if (riskEl) riskEl.textContent = String(entry.risk);
          if (dispEl) dispEl.textContent = `Disposition: ${entry.disposition || '—'}`;
        };

        const flashFeedback = (text) => {
          if (!cfg.show_feedback) return;
          if (!statusEl) return;
          statusEl.textContent = text;
          if (cardEl) {
            try { cardEl.classList.remove('soc-nback-flash'); } catch { /* ignore */ }
            try { void cardEl.offsetWidth; cardEl.classList.add('soc-nback-flash'); } catch { /* ignore */ }
          }
        };

        const finalizeOmissionIfNeeded = () => {
          if (!state.current) return;
          if (state.current_responded) return;

          state.omissions += 1;
          if (state.current_is_match) state.omissions_target += 1;
          else state.omissions_nontarget += 1;

          if (cfg.response_paradigm === 'go_nogo') {
            if (state.current_is_match) state.misses += 1;
            else state.correct_rejects += 1;
          } else {
            // 2AFC: omission counts as an error (no explicit response).
            if (state.current_is_match) state.misses += 1;
            // non-target omissions do not map cleanly; keep in omissions counts.
          }

          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: tSubtaskMs(),
            type: 'nback_no_response',
            subtask_index: i,
            subtask_title: state.title,
            stimulus_id: state.current.id,
            is_match: !!state.current_is_match,
            match_field: cfg.match_field,
            paradigm: cfg.response_paradigm
          });
        };

        const presentNext = () => {
          const canMatch = state.buffer.length >= cfg.n;
          const wantsMatch = canMatch ? (Math.random() < cfg.target_probability) : false;
          const entry = makeEntry();

          let isMatch = false;
          if (wantsMatch) {
            const ref = state.buffer[state.buffer.length - cfg.n];
            if (ref) {
              isMatch = true;
              if (cfg.match_field === 'username') entry.username = ref.username;
              else entry.src_ip = ref.src_ip;
            }
          }

          state.presented += 1;
          state.current = entry;
          state.current_is_match = isMatch;
          state.current_presented_at = nowMs();
          state.current_responded = false;
          state.current_response = null;

          state.buffer.push({
            src_ip: entry.src_ip,
            username: entry.username
          });
          while (state.buffer.length > 50) state.buffer.shift();

          renderEntry(entry);

          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: tSubtaskMs(),
            type: 'nback_present',
            subtask_index: i,
            subtask_title: state.title,
            stimulus_id: entry.id,
            is_match: !!isMatch,
            n: cfg.n,
            match_field: cfg.match_field,
            src_ip: entry.src_ip,
            username: entry.username,
            dest: entry.dest,
            event: entry.event,
            risk: entry.risk
          });
        };

        const respond = (responseKind, device, keyName) => {
          if (!state.started || state.ended) return;
          if (!state.current) return;
          if (state.current_responded) return;

          state.current_responded = true;
          state.current_response = responseKind;

          const rt = state.current_presented_at ? Math.round(nowMs() - state.current_presented_at) : null;
          const isMatch = !!state.current_is_match;

          let correct = false;
          if (cfg.response_paradigm === 'go_nogo') {
            // Any response means "match".
            correct = isMatch;
            if (isMatch) state.hits += 1;
            else state.false_alarms += 1;
            state.current.disposition = correct ? 'FLAGGED (repeat)' : 'FLAGGED (error)';
          } else {
            // 2AFC: explicit yes/no.
            const saidMatch = responseKind === 'match';
            correct = (saidMatch === isMatch);

            if (saidMatch) {
              if (isMatch) state.hits += 1;
              else state.false_alarms += 1;
              state.current.disposition = correct ? 'FLAGGED (repeat)' : 'FLAGGED (error)';
            } else {
              if (!isMatch) state.correct_rejects += 1;
              else state.misses += 1;
              state.current.disposition = correct ? 'CLEARED' : 'CLEARED (miss)';
            }
          }

          renderEntry(state.current);

          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: tSubtaskMs(),
            type: 'nback_response',
            subtask_index: i,
            subtask_title: state.title,
            device,
            key: keyName || null,
            response: responseKind,
            is_match: isMatch,
            correct,
            rt_ms: rt,
            stimulus_id: state.current.id
          });

          flashFeedback(correct ? 'Correct' : 'Incorrect');
        };

        // Expose for global keyboard handler
        state.respond = respond;

        const tick = () => {
          if (ended || state.ended || !state.started) return;

          const elapsed = nowMs() - startWall;
          if (elapsed >= stopAt) {
            finalizeOmissionIfNeeded();
            state.ended = true;
            if (statusEl) statusEl.textContent = 'Complete';
            events.push({
              t_ms: Math.round(nowMs() - startTs),
              t_subtask_ms: tSubtaskMs(),
              type: 'nback_subtask_end',
              subtask_index: i,
              subtask_title: state.title,
              presented: state.presented,
              hits: state.hits,
              misses: state.misses,
              false_alarms: state.false_alarms,
              correct_rejects: state.correct_rejects,
              omissions: state.omissions,
              omissions_target: state.omissions_target,
              omissions_nontarget: state.omissions_nontarget
            });
            return;
          }

          finalizeOmissionIfNeeded();
          if (statusEl) statusEl.textContent = 'Running…';
          presentNext();
          setSafeTimeout(tick, cfg.stimulus_interval_ms);
        };

        const startNbackSubtask = () => {
          if (state.started) return;
          state.started = true;
          state.subtask_start_ts = nowMs();
          startWall = state.subtask_start_ts;
          stopAt = computeStopAt();

          markGenericSubtaskStart(i);

          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: 0,
            type: 'nback_subtask_start',
            subtask_index: i,
            subtask_title: state.title,
            n: cfg.n,
            match_field: cfg.match_field,
            paradigm: cfg.response_paradigm
          });

          setSafeTimeout(tick, 0);
        };

        subtaskAutoStart[i] = startNbackSubtask;
        subtaskForceEnd[i] = (reason) => {
          if (state.ended) return;
          finalizeOmissionIfNeeded();
          state.ended = true;
          if (statusEl) statusEl.textContent = 'Complete';
          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: tSubtaskMs(),
            type: 'nback_subtask_forced_end',
            reason: (reason ?? 'forced').toString(),
            subtask_index: i,
            subtask_title: state.title
          });
        };

        windowInstructionsHost[i] = host;
        windowInstructionsTitle[i] = instructionsTitle;
        windowInstructionsHtml[i] = resolvedInstructionsHtml;
        maybeInstallWindowInstructions(i);
        continue;
      }

      const cfg = coerceSartLikeConfig(wSpec.subtask || {});
      const state = {
        idx: i,
        title: wSpec.subtask_title,
        cfg,
        ended: false,
        started: false,
        subtask_start_ts: null,
        entries: [],
        responded: new Set(),
        presented: 0,
        hits: 0,
        misses: 0,
        false_alarms: 0,
        correct_rejects: 0
      };
      sartStates[i] = state;

      const showMarkers = !!cfg.show_markers;
      const resolvedGoControl = (cfg.response_device === 'keyboard')
        ? (cfg.go_key === ' ' ? 'SPACE' : cfg.go_key)
        : (cfg.go_button === 'change' ? 'Change' : 'Action');

      const instructionsTitleRaw = (wSpec?.subtask?.instructions_title ?? 'Filtering harmful logins').toString();
      const instructionsTitle = instructionsTitleRaw.trim() ? instructionsTitleRaw : 'Filtering harmful logins';

      const resolvedInstructionsHtml = substitutePlaceholders(subtaskInstructions, {
        GO_CONTROL: resolvedGoControl,
        TARGETS: (cfg.target_subdomains.length ? cfg.target_subdomains.join(', ') : '(set target_subdomains)'),
        DISTRACTORS: (cfg.distractor_subdomains.length ? cfg.distractor_subdomains.join(', ') : '(set distractor_subdomains)')
      });

      const goHint = (cfg.response_device === 'keyboard')
        ? `Go key: ${cfg.go_key === ' ' ? 'SPACE' : escHtml(cfg.go_key)}`
        : `Click "${cfg.go_button === 'change' ? 'Change' : 'Action'}" on the highlighted row`;

      const goRule = (cfg.go_condition === 'target')
        ? 'GO on TARGET entries; withhold otherwise.'
        : 'GO on DISTRACTOR entries; withhold otherwise.';

      host.innerHTML = `
        <div class="soc-log-header">
          <div>
            <h4 style="margin:0;">Log triage (Go/No-Go)</h4>
            <div class="hint">${escHtml(goRule)} • ${goHint}</div>
          </div>
          <div class="hint" id="soc_sart_status_${i}">Ready</div>
        </div>
        <div style="margin-top:6px;">
          <table class="soc-log-feed" aria-label="Log feed">
            <thead><tr><th>Time</th><th>Src IP</th><th>Dest</th><th>Event</th><th>Action</th>${showMarkers ? '<th>Tag</th>' : ''}</tr></thead>
            <tbody id="soc_sart_rows_${i}"></tbody>
          </table>
        </div>
      `;

      const rowsEl = host.querySelector(`#soc_sart_rows_${i}`);
      const statusEl = host.querySelector(`#soc_sart_status_${i}`);

      const shouldGoFor = (entryClass) => {
        if (cfg.go_condition === 'target') return entryClass === 'target';
        if (cfg.go_condition === 'distractor') return entryClass === 'distractor';
        return false;
      };

      const classifyEntry = (kind) => {
        if (kind === 'target') return 'target';
        if (kind === 'distractor') return 'distractor';
        return 'neutral';
      };

      const makeNeutralDest = () => {
        const neutral = pickRandom(cfg.neutral_subdomains);
        if (neutral) return neutral;
        const verbs = ['cdn', 'static', 'assets', 'img', 'telemetry', 'updates', 'api'];
        const roots = ['news', 'media', 'shop', 'status', 'docs', 'portal', 'support'];
        const tlds = ['example', 'local', 'test'];
        return `${pickRandom(verbs)}.${pickRandom(roots)}.${pickRandom(tlds)}`;
      };

      const makeEntry = () => {
        const pTarget = cfg.target_probability;
        const pDistractor = cfg.distractor_probability;
        const r = Math.random();

        let kind = 'neutral';
        if (r < pTarget) kind = 'target';
        else if (r < (pTarget + pDistractor)) kind = 'distractor';

        let dest = null;
        if (kind === 'target') dest = pickRandom(cfg.target_subdomains);
        if (kind === 'distractor') dest = pickRandom(cfg.distractor_subdomains);
        if (!dest) {
          // If list empty, degrade gracefully.
          kind = 'neutral';
          dest = makeNeutralDest();
        }

        const id = `LOG-${i + 1}-${String(state.presented + 1).padStart(4, '0')}`;
        const createdAt = nowMs();
        const clock = formatClock(Date.now());

        const actions = ['DNS query', 'TLS handshake', 'HTTP GET', 'HTTP POST', 'Auth attempt', 'File fetch'];
        const action = pickRandom(actions) || 'HTTP GET';

        const entry = {
          id,
          kind,
          cls: classifyEntry(kind),
          t_presented_ms: Math.round(createdAt - (state.subtask_start_ts ?? startTs)),
          createdAt,
          clock,
          src_ip: randomIp(),
          dest,
          action,
          triage_action: '—'
        };
        return entry;
      };

      const actionButtonLabel = () => (cfg.go_button === 'change' ? 'Change' : 'Action');

      const applyTriageAction = (entry) => {
        if (!entry) return;
        // Semantics: GO commits a triage decision.
        // To avoid mixing ALLOW/BLOCK in the same run, bind the action to the configured GO rule:
        // - GO on target  => ALLOW (even if a participant responds on a distractor)
        // - GO on distractor => BLOCK (even if a participant responds on a target)
        entry.triage_action = (cfg.go_condition === 'distractor') ? 'BLOCK' : 'ALLOW';
      };

      const renderRows = () => {
        if (!rowsEl) return;

        const current = state.entries.length ? state.entries[state.entries.length - 1] : null;
        const currentId = current ? current.id : null;

        rowsEl.innerHTML = state.entries.map((e) => {
          const isCurrent = !!(currentId && e.id === currentId);
          const already = state.responded.has(e.id);
          const clickable = (cfg.response_device === 'mouse' && isCurrent && !already) ? ' clickable' : '';

          const rowClass = (cfg.highlight_subdomains && e.cls !== 'neutral') ? e.cls : '';

          const flags = `${isCurrent ? ' current' : ''}${already ? ' responded' : ''}`;

          const tag = (e.cls === 'target')
            ? '<span class="soc-log-tag">TARGET</span>'
            : (e.cls === 'distractor')
              ? '<span class="soc-log-tag">DISTRACTOR</span>'
              : '<span class="soc-log-tag">NEUTRAL</span>';

          // Optional per-class tint overrides
          let style = '';
          if (cfg.highlight_subdomains && e.cls === 'target') {
            style = `style="background: ${escHtml(cfg.target_highlight_color)}22;"`;
          }
          if (cfg.highlight_subdomains && e.cls === 'distractor') {
            style = `style="background: ${escHtml(cfg.distractor_highlight_color)}22;"`;
          }

          const actionCell = (() => {
            const val = escHtml(e.triage_action ?? '—');
            if (cfg.response_device !== 'mouse') {
              return `<span class="soc-log-tag">${val}</span>`;
            }
            if (!isCurrent) {
              return `<span class="soc-log-tag">${val}</span>`;
            }
            return `
              <span class="soc-log-tag" style="margin-right: 6px;">${val}</span>
              <button type="button" class="soc-log-go-btn" data-entry-id="${escHtml(e.id)}" ${already ? 'disabled' : ''}>
                ${escHtml(actionButtonLabel())}
              </button>
            `;
          })();

          return `
            <tr class="${escHtml(rowClass)}${flags}${clickable}" data-entry-id="${escHtml(e.id)}" ${style}>
              <td>${escHtml(e.clock)}</td>
              <td>${escHtml(e.src_ip)}</td>
              <td>${escHtml(e.dest)}</td>
              <td>${escHtml(e.action)}</td>
              <td style="white-space: nowrap;">${actionCell}</td>
              ${showMarkers ? `<td>${tag}</td>` : ''}
            </tr>
          `;
        }).join('');
      };

      // Expose for global keyboard handler (active window)
      state.renderRows = renderRows;

      const tSubtaskMs = () => {
        const base = (state.subtask_start_ts ?? startTs);
        return Math.round(nowMs() - base);
      };

      const recordMissIfNeeded = (entry) => {
        if (!entry) return;
        if (!shouldGoFor(entry.cls)) {
          state.correct_rejects += 1;
          return;
        }

        if (state.responded.has(entry.id)) return;
        state.misses += 1;
        events.push({
          t_ms: Math.round(nowMs() - startTs),
          t_subtask_ms: tSubtaskMs(),
          type: 'sart_miss',
          subtask_index: i,
          subtask_title: state.title,
          entry_id: entry.id,
          entry_class: entry.cls
        });
      };

      const recordResponse = (entry, device) => {
        if (!entry) return;
        if (!state.started) return;
        if (state.responded.has(entry.id)) return;
        state.responded.add(entry.id);

        applyTriageAction(entry);

        const rt = Math.round(nowMs() - entry.createdAt);
        const isGoTarget = shouldGoFor(entry.cls);
        const correct = isGoTarget;

        if (correct) state.hits += 1;
        else state.false_alarms += 1;

        events.push({
          t_ms: Math.round(nowMs() - startTs),
          t_subtask_ms: tSubtaskMs(),
          type: 'sart_response',
          subtask_index: i,
          subtask_title: state.title,
          device,
          entry_id: entry.id,
          entry_class: entry.cls,
          triage_action: entry.triage_action,
          correct,
          rt_ms: rt
        });

        renderRows();
      };

      // Mouse response: click the per-row button responds (current row only).
      if (cfg.response_device === 'mouse' && rowsEl) {
        rowsEl.addEventListener('click', (e) => {
          if (!state.started) return;
          const btn = e.target.closest('button[data-entry-id]');
          if (!btn) return;
          const row = btn.closest('tr[data-entry-id]');
          if (!row) return;
          activeWindowIndex = i;
          const id = (row.dataset.entryId || '').toString();
          const entry = state.entries.find(x => x.id === id);
          recordResponse(entry, 'mouse');
        });
      }

      // Schedule ticks via recursive timeouts (starts when instructions are dismissed).
      let startWall = null;
      let stopAt = null;

      const computeStopAt = () => {
        const minR = cfg.min_run_ms;
        const maxR = cfg.max_run_ms;
        if (!minR && !maxR) return Infinity;
        if (minR && !maxR) return minR;
        if (!minR && maxR) return maxR;
        // Both positive
        return randomInt(minR, maxR);
      };

      const tick = () => {
        if (ended || state.ended || !state.started) return;

        const elapsed = nowMs() - startWall;
        if (elapsed >= stopAt) {
          state.ended = true;
          if (statusEl) statusEl.textContent = 'Complete';
          events.push({
            t_ms: Math.round(nowMs() - startTs),
            t_subtask_ms: tSubtaskMs(),
            type: 'sart_subtask_end',
            subtask_index: i,
            subtask_title: state.title,
            presented: state.presented,
            hits: state.hits,
            misses: state.misses,
            false_alarms: state.false_alarms,
            correct_rejects: state.correct_rejects
          });
          return;
        }

        const entry = makeEntry();
        state.presented += 1;

        events.push({
          t_ms: Math.round(nowMs() - startTs),
          t_subtask_ms: tSubtaskMs(),
          type: 'sart_present',
          subtask_index: i,
          subtask_title: state.title,
          entry_id: entry.id,
          entry_class: entry.cls,
          dest: entry.dest,
          src_ip: entry.src_ip,
          action: entry.action,
          triage_action: entry.triage_action
        });

        state.entries.push(entry);
        while (state.entries.length > cfg.visible_entries) {
          const removed = state.entries.shift();
          recordMissIfNeeded(removed);
        }

        renderRows();
        setSafeTimeout(tick, cfg.scroll_interval_ms);
      };

      const startSartSubtask = () => {
        if (state.started) return;
        state.started = true;
        state.subtask_start_ts = nowMs();
        startWall = state.subtask_start_ts;
        stopAt = computeStopAt();

        if (statusEl) statusEl.textContent = 'Running…';

        events.push({
          t_ms: Math.round(nowMs() - startTs),
          t_subtask_ms: 0,
          type: 'sart_subtask_start',
          subtask_index: i,
          subtask_title: state.title
        });

        renderRows();
        setSafeTimeout(tick, 0);
      };

      subtaskAutoStart[i] = startSartSubtask;
      subtaskForceEnd[i] = (reason) => {
        if (state.ended) return;
        state.ended = true;
        if (statusEl) statusEl.textContent = 'Complete';
        events.push({
          t_ms: Math.round(nowMs() - startTs),
          t_subtask_ms: tSubtaskMs(),
          type: 'sart_subtask_forced_end',
          reason: (reason ?? 'forced').toString(),
          subtask_index: i,
          subtask_title: state.title
        });
      };

      renderRows();

      windowInstructionsHost[i] = host;
      windowInstructionsTitle[i] = instructionsTitle;
      windowInstructionsHtml[i] = resolvedInstructionsHtml;
      maybeInstallWindowInstructions(i);
    }

    // Default keyboard focus to the first visible keyboard-relevant window.
    activeWindowIndex = pickFirstVisibleKeyboardWindow();

    function recordPointerEvent(e) {
      events.push({
        t_ms: Math.round(nowMs() - startTs),
        type: e.type,
        x: Number.isFinite(e.clientX) ? Math.round(e.clientX) : null,
        y: Number.isFinite(e.clientY) ? Math.round(e.clientY) : null
      });
    }

    function onDesktopClick(e) {
      const icon = e.target.closest('.soc-icon');
      if (!icon) return;
      if (!logIconClicks) return;

      const label = (icon.dataset.label || '').toString();
      const app = (icon.dataset.app || '').toString();
      events.push({
        t_ms: Math.round(nowMs() - startTs),
        type: 'icon_click',
        label: label || null,
        app: app || null,
        distractor: true
      });
    }

    const onKeyDown = (e) => {
      ensureActiveWindowVisible();
      const k = normalizeKeyName(e.key);
      events.push({ t_ms: Math.round(nowMs() - startTs), type: 'key', key: k });
      if (k === normalizeKeyName(endKey)) {
        e.preventDefault();
        endTrial('end_key');
        return;
      }

      // SART-like: apply keyboard go response to the active window (if configured for keyboard)
      const st = sartStates[activeWindowIndex];
      if (st && st.started && !st.ended && st.cfg && st.cfg.response_device === 'keyboard') {
        const goKey = normalizeKeyName(st.cfg.go_key);
        if (goKey && k === goKey) {
          e.preventDefault();
          const latest = st.entries.length ? st.entries[st.entries.length - 1] : null;
          if (latest) {
            // Inline response logic to avoid cross-closure lookups.
            const shouldGoFor = (entryClass) => {
              if (st.cfg.go_condition === 'target') return entryClass === 'target';
              if (st.cfg.go_condition === 'distractor') return entryClass === 'distractor';
              return false;
            };

            if (!st.responded.has(latest.id)) {
              st.responded.add(latest.id);

              // Apply action update for realism
              latest.triage_action = (st.cfg.go_condition === 'distractor') ? 'BLOCK' : 'ALLOW';

              const rt = Math.round(nowMs() - latest.createdAt);
              const correct = shouldGoFor(latest.cls);
              if (correct) st.hits += 1;
              else st.false_alarms += 1;

              events.push({
                t_ms: Math.round(nowMs() - startTs),
                type: 'sart_response',
                subtask_index: activeWindowIndex,
                subtask_title: st.title,
                device: 'keyboard',
                entry_id: latest.id,
                entry_class: latest.cls,
                triage_action: latest.triage_action,
                correct,
                rt_ms: rt
              });

              try {
                if (typeof st.renderRows === 'function') st.renderRows();
              } catch {
                // ignore
              }
            }
          }
        }
      }

      // N-back-like: apply keyboard response to the active window (keyboard-only)
      const nb = nbackStates[activeWindowIndex];
      if (nb && nb.started && !nb.ended && nb.cfg) {
        const p = nb.cfg.response_paradigm;
        if (p === 'go_nogo') {
          const gk = normalizeKeyName(nb.cfg.go_key);
          if (gk && k === gk) {
            e.preventDefault();
            try { nb.respond?.('match', 'keyboard', k); } catch { /* ignore */ }
          }
        } else {
          const mk = normalizeKeyName(nb.cfg.match_key || nb.cfg.go_key);
          const nk = normalizeKeyName(nb.cfg.nonmatch_key);
          if (mk && k === mk) {
            e.preventDefault();
            try { nb.respond?.('match', 'keyboard', k); } catch { /* ignore */ }
          } else if (nk && k === nk) {
            e.preventDefault();
            try { nb.respond?.('nonmatch', 'keyboard', k); } catch { /* ignore */ }
          }
        }
      }
    };

    const endTrial = (reason) => {
      if (ended) return;
      ended = true;

      clearAllTimers();

      shell.removeEventListener('click', recordPointerEvent, true);
      shell.removeEventListener('mousedown', recordPointerEvent, true);
      shell.removeEventListener('mouseup', recordPointerEvent, true);
      iconsHost.removeEventListener('click', onDesktopClick);
      document.removeEventListener('keydown', onKeyDown);

      try {
        const styleToRemove = display_element.querySelector('style[data-soc-dashboard="true"]');
        if (styleToRemove) styleToRemove.remove();
      } catch {
        // ignore
      }

      display_element.innerHTML = '';

      this.jsPsych.finishTrial({
        ended_reason: reason,
        active_app: 'tasks',
        events,
        plugin_version: info.version
      });
    };

    shell.appendChild(wallpaper);
    desktop.appendChild(iconsHost);
    desktop.appendChild(windows);
    shell.appendChild(desktop);
    display_element.appendChild(shell);

    // Scheduled windows: auto-show/auto-start and auto-hide/auto-end.
    for (let i = 0; i < windowsSpec.length; i++) {
      const sch = windowsSpec[i]?.schedule || { has_schedule: false, start_at_ms: 0, end_at_ms: null };
      if (!sch.has_schedule) continue;

      const startAt = Math.max(0, Math.floor(Number(sch.start_at_ms) || 0));
      const endAt = (sch.end_at_ms === null || sch.end_at_ms === undefined)
        ? null
        : Math.max(0, Math.floor(Number(sch.end_at_ms)));

      const doStart = () => {
        if (ended) return;
        showWindow(i);
        // If this subtask has instruction text, require the participant to click the popup to start.
        if (!windowStartIsGated[i]) {
          startWindowIfNeeded(i);
        }
      };

      if (startAt > 0) {
        setSafeTimeout(doStart, startAt);
      } else {
        doStart();
      }

      if (Number.isFinite(endAt)) {
        setSafeTimeout(() => {
          if (ended) return;
          forceEndWindow(i, 'scheduled_end');
          hideWindow(i);
        }, endAt);
      }
    }

    // Track last-clicked window for keyboard responses
    windows.addEventListener('mousedown', (e) => {
      const winEl = e.target.closest('.soc-appwin');
      if (!winEl) return;
      const idx = Array.from(windows.children).indexOf(winEl);
      if (idx >= 0) activeWindowIndex = idx;
    }, true);

    shell.addEventListener('click', recordPointerEvent, true);
    shell.addEventListener('mousedown', recordPointerEvent, true);
    shell.addEventListener('mouseup', recordPointerEvent, true);
    iconsHost.addEventListener('click', onDesktopClick);
    document.addEventListener('keydown', onKeyDown);

    if (Number.isFinite(trialMs) && trialMs > 0) {
      this.jsPsych.pluginAPI.setTimeout(() => {
        endTrial('timeout');
      }, trialMs);
    }
  };

  JsPsychSocDashboardPlugin.info = info;
  window.jsPsychSocDashboard = JsPsychSocDashboardPlugin;
})(window.jsPsychModule || window.jsPsych);
