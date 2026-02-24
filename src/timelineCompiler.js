(function () {
  function isObject(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x);
  }

  function clamp(x, lo, hi) {
    const n = Number(x);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function logit(p) {
    const pp = clamp(p, 1e-6, 1 - 1e-6);
    return Math.log(pp / (1 - pp));
  }

  function normalPdf(x, mu, sigma) {
    const s = Number(sigma);
    if (!Number.isFinite(s) || s <= 0) return 0;
    const z = (Number(x) - Number(mu)) / s;
    return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
  }

  class QuestStaircase {
    constructor(cfg) {
      const c = isObject(cfg) ? cfg : {};

      this.parameter = (c.parameter || 'coherence').toString();
      this.target = Number.isFinite(Number(c.target_performance)) ? Number(c.target_performance) : 0.82;
      this.beta = Number.isFinite(Number(c.beta)) ? Number(c.beta) : 3.5;
      this.delta = Number.isFinite(Number(c.delta)) ? Number(c.delta) : 0.01;
      this.gamma = Number.isFinite(Number(c.gamma)) ? Number(c.gamma) : 0.5;
      this.minValue = Number.isFinite(Number(c.min_value)) ? Number(c.min_value) : -Infinity;
      this.maxValue = Number.isFinite(Number(c.max_value)) ? Number(c.max_value) : Infinity;

      const startValue = Number.isFinite(Number(c.start_value)) ? Number(c.start_value) : 0;
      const startSd = Number.isFinite(Number(c.start_sd)) ? Math.max(1e-6, Number(c.start_sd)) : 0.2;

      // Discrete posterior over threshold T.
      const span = 5 * startSd;
      const lo = clamp(startValue - span, this.minValue, this.maxValue);
      const hi = clamp(startValue + span, this.minValue, this.maxValue);
      const steps = 200;
      const grid = [];
      const post = [];
      for (let i = 0; i < steps; i++) {
        const t = (steps === 1) ? lo : (lo + (hi - lo) * (i / (steps - 1)));
        grid.push(t);
        post.push(normalPdf(t, startValue, startSd));
      }

      this.grid = grid;
      this.posterior = post;
      this._normalize();

      // Offset from threshold to target performance for our logistic psychometric.
      // p = gamma + (1-gamma-delta) * sigmoid(beta*(x - T))
      const denom = (1 - this.gamma - this.delta);
      const scaled = denom > 1e-6 ? (this.target - this.gamma) / denom : 0.5;
      const safeScaled = clamp(scaled, 1e-6, 1 - 1e-6);
      this.offset = logit(safeScaled) / (Number.isFinite(this.beta) && this.beta !== 0 ? this.beta : 1);

      this.lastX = null;
      this.trialIndex = 0;
    }

    _normalize() {
      const s = this.posterior.reduce((a, b) => a + b, 0);
      if (!(s > 0)) {
        const n = this.posterior.length || 1;
        for (let i = 0; i < this.posterior.length; i++) this.posterior[i] = 1 / n;
        return;
      }
      for (let i = 0; i < this.posterior.length; i++) this.posterior[i] /= s;
    }

    meanThreshold() {
      let m = 0;
      for (let i = 0; i < this.grid.length; i++) {
        m += this.grid[i] * this.posterior[i];
      }
      return m;
    }

    next() {
      const tMean = this.meanThreshold();
      const x = clamp(tMean + this.offset, this.minValue, this.maxValue);
      this.lastX = x;
      this.trialIndex++;
      return x;
    }

    psychometric(x, threshold) {
      const beta = Number.isFinite(this.beta) ? this.beta : 1;
      const z = beta * (Number(x) - Number(threshold));
      const sig = 1 / (1 + Math.exp(-z));
      const p = this.gamma + (1 - this.gamma - this.delta) * sig;
      return clamp(p, 1e-6, 1 - 1e-6);
    }

    update(isCorrect) {
      if (!Number.isFinite(this.lastX)) return;
      const r = isCorrect === true ? 1 : 0;
      const x = this.lastX;

      for (let i = 0; i < this.grid.length; i++) {
        const t = this.grid[i];
        const p = this.psychometric(x, t);
        const like = r ? p : (1 - p);
        this.posterior[i] *= like;
      }
      this._normalize();
    }
  }

  class WeightedUpDownStaircase {
    constructor(cfg) {
      const c = isObject(cfg) ? cfg : {};
      this.parameter = (c.parameter || 'coherence').toString();
      this.mode = (c.mode || 'simple').toString();
      this.target = Number.isFinite(Number(c.target_performance)) ? Number(c.target_performance) : 0.82;
      this.step = Number.isFinite(Number(c.step_size)) ? Math.abs(Number(c.step_size)) : 0.05;
      this.minValue = Number.isFinite(Number(c.min_value)) ? Number(c.min_value) : -Infinity;
      this.maxValue = Number.isFinite(Number(c.max_value)) ? Number(c.max_value) : Infinity;
      this.value = Number.isFinite(Number(c.start_value)) ? Number(c.start_value) : 0;
      this.lastX = null;
      this.trialIndex = 0;
    }

    next() {
      const x = clamp(this.value, this.minValue, this.maxValue);
      this.lastX = x;
      this.trialIndex++;
      return x;
    }

    update(isCorrect) {
      const correct = isCorrect === true;
      if (this.mode === 'staircase') {
        // Weighted step-down to converge near target performance:
        // E[Δ] = p*(-k*step) + (1-p)*(+step) = 0 => k = (1-p)/p
        const p = clamp(this.target, 1e-3, 1 - 1e-3);
        const k = (1 - p) / p;
        if (correct) this.value -= this.step * k;
        else this.value += this.step;
      } else {
        // simple: symmetric 1-up-1-down
        if (correct) this.value -= this.step;
        else this.value += this.step;
      }
      this.value = clamp(this.value, this.minValue, this.maxValue);
    }
  }

  function deepMerge(base, override) {
    const out = isObject(base) ? { ...base } : {};
    if (!isObject(override)) return out;
    for (const [k, v] of Object.entries(override)) {
      if (isObject(v) && isObject(out[k])) out[k] = deepMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  }

  function mulberry32(seedUint32) {
    let a = seedUint32 >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeedToUint32(seedStr) {
    let h = 2166136261;
    const s = (seedStr ?? 'default').toString();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function parseNbackTokenPool(rawPool, stimulusMode) {
    const raw = (rawPool ?? '').toString();
    const parts = raw
      .split(/[\n,]/g)
      .map(s => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts;

    const mode = (stimulusMode ?? 'letters').toString().trim().toLowerCase();
    if (mode === 'numbers') return ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    if (mode === 'shapes') return ['●', '■', '▲', '◆', '★', '⬟'];
    if (mode === 'custom') return ['A', 'B', 'C'];
    return ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  }

  function expandNbackTrialSequence(seq, opts) {
    const s = isObject(seq) ? seq : {};

    const nbackDefaults = (opts && isObject(opts.nbackDefaults)) ? opts.nbackDefaults : {};
    const pick = (k, fallback) => {
      if (s[k] !== undefined && s[k] !== null) return s[k];
      if (nbackDefaults && nbackDefaults[k] !== undefined && nbackDefaults[k] !== null) return nbackDefaults[k];
      return fallback;
    };
    const resolveDevice = (raw) => {
      const d = (raw ?? 'inherit').toString().trim().toLowerCase();
      if (!d || d === 'inherit') {
        const def = (nbackDefaults.response_device ?? 'keyboard').toString().trim().toLowerCase();
        return (def === 'mouse' || def === 'keyboard') ? def : 'keyboard';
      }
      return (d === 'mouse' || d === 'keyboard') ? d : 'keyboard';
    };

    const n = Number.isFinite(Number(pick('n', 2))) ? Math.max(1, Math.floor(Number(pick('n', 2)))) : 2;
    const length = Number.isFinite(Number(pick('length', 30))) ? Math.max(1, Math.floor(Number(pick('length', 30)))) : 30;

    const seedStr = (typeof pick('seed', '') === 'string') ? pick('seed', '') : '';
    const seed = hashSeedToUint32(seedStr || 'default');
    const rng = mulberry32(seed);

    const pool = parseNbackTokenPool(pick('stimulus_pool', ''), pick('stimulus_mode', 'letters'));
    const targetProb = clamp(pick('target_probability', 0.25), 0, 1);

    const responseParadigm = (pick('response_paradigm', 'go_nogo') || 'go_nogo').toString().trim().toLowerCase();
    const responseDevice = resolveDevice(pick('response_device', 'inherit'));
    const goKey = (pick('go_key', 'space') || 'space').toString();
    const matchKey = (pick('match_key', 'j') || 'j').toString();
    const nonmatchKey = (pick('nonmatch_key', 'f') || 'f').toString();
    const showButtons = pick('show_buttons', false) === true;

    const renderMode = (pick('render_mode', 'token') || 'token').toString().trim().toLowerCase();
    const templateHtml = (renderMode === 'custom_html') ? (pick('stimulus_template_html', null) ?? null) : null;

    const stimMs = pick('stimulus_duration_ms', undefined);
    const isiMs = pick('isi_duration_ms', undefined);
    const trialMs = pick('trial_duration_ms', undefined);

    const showFeedback = pick('show_feedback', false) === true;
    const feedbackMs = pick('feedback_duration_ms', undefined);

    const showFixationCrossBetweenTrials = pick('show_fixation_cross_between_trials', false) === true;

    const pickFromPool = (avoidToken) => {
      if (!Array.isArray(pool) || pool.length === 0) return 'A';
      if (!avoidToken || pool.length === 1) return pool[Math.floor(rng() * pool.length)];
      let token = pool[Math.floor(rng() * pool.length)];
      let guard = 0;
      while (token === avoidToken && guard < 10) {
        token = pool[Math.floor(rng() * pool.length)];
        guard++;
      }
      return token;
    };

    const tokens = [];
    const isMatch = [];
    for (let i = 0; i < length; i++) {
      if (i >= n && rng() < targetProb) {
        tokens[i] = tokens[i - n];
        isMatch[i] = true;
      } else {
        const avoid = (i >= n) ? tokens[i - n] : null;
        tokens[i] = pickFromPool(avoid);
        isMatch[i] = (i >= n) ? (tokens[i] === tokens[i - n]) : false;
      }
    }

    const out = [];
    for (let i = 0; i < length; i++) {
      const m = isMatch[i] === true;

      const correctResponse = (() => {
        if (responseParadigm === '2afc') {
          const mk = (s.match_key ?? '').toString().trim() ? matchKey : goKey;
          return m ? mk : nonmatchKey;
        }
        return m ? goKey : null;
      })();

      out.push({
        type: 'nback-block',
        n,
        token: tokens[i],
        is_match: m,
        correct_response: correctResponse,

        response_paradigm: responseParadigm,
        response_device: responseDevice,
        go_key: goKey,
        match_key: matchKey,
        nonmatch_key: nonmatchKey,
        show_buttons: showButtons,

        render_mode: renderMode,
        ...(templateHtml !== null && templateHtml !== undefined ? { stimulus_template_html: templateHtml } : {}),
        ...(stimMs !== undefined ? { stimulus_duration_ms: stimMs } : {}),
        ...(isiMs !== undefined ? { isi_duration_ms: isiMs } : {}),
        ...(trialMs !== undefined ? { trial_duration_ms: trialMs } : {}),

        ...(showFeedback ? { show_feedback: true } : {}),
        ...(feedbackMs !== undefined ? { feedback_duration_ms: feedbackMs } : {}),

        ...(showFixationCrossBetweenTrials ? { show_fixation_cross_between_trials: true } : {}),

        _generated_from_nback_sequence: true,
        _sequence_seed: seed,
        _sequence_index: i
      });
    }

    return out;
  }

  function expandBlock(block, opts) {
    const length = Math.max(1, Number.parseInt(block.block_length ?? block.length ?? 1, 10) || 1);
    const baseType = (typeof block.block_component_type === 'string' && block.block_component_type.trim())
      ? block.block_component_type.trim()
      : (typeof block.component_type === 'string' && block.component_type.trim())
        ? block.component_type.trim()
        : 'rdm-trial';

    // N-back: treat Block as the generator (Builder UX).
    if (baseType === 'nback-block') {
      const src = (block && typeof block === 'object' && block.parameter_values && typeof block.parameter_values === 'object')
        ? { ...block, ...block.parameter_values }
        : (block || {});

      const nbackDefaults = (opts && isObject(opts.nbackDefaults)) ? opts.nbackDefaults : {};
      const pickFromDefaults = (raw, defKey, fallback) => {
        if (raw !== undefined && raw !== null) return raw;
        if (nbackDefaults && nbackDefaults[defKey] !== undefined && nbackDefaults[defKey] !== null) return nbackDefaults[defKey];
        return fallback;
      };
      const resolveDevice = (raw) => {
        const d = (raw ?? 'inherit').toString().trim().toLowerCase();
        if (!d || d === 'inherit') {
          const def = (nbackDefaults.response_device ?? 'keyboard').toString().trim().toLowerCase();
          return (def === 'mouse' || def === 'keyboard') ? def : 'keyboard';
        }
        return (d === 'mouse' || d === 'keyboard') ? d : 'keyboard';
      };

      const renderMode = (pickFromDefaults(src.nback_render_mode, 'render_mode', 'token') ?? 'token').toString().trim().toLowerCase();

      return expandNbackTrialSequence({
        n: pickFromDefaults(src.nback_n, 'n', 2),
        length,
        seed: (pickFromDefaults(src.seed, 'seed', '') ?? '').toString(),
        stimulus_mode: pickFromDefaults(src.nback_stimulus_mode, 'stimulus_mode', 'letters'),
        stimulus_pool: pickFromDefaults(src.nback_stimulus_pool, 'stimulus_pool', ''),
        target_probability: pickFromDefaults(src.nback_target_probability, 'target_probability', 0.25),

        render_mode: renderMode,
        stimulus_template_html: (renderMode === 'custom_html')
          ? pickFromDefaults(src.nback_stimulus_template_html, 'stimulus_template_html', null)
          : null,

        stimulus_duration_ms: pickFromDefaults(src.nback_stimulus_duration_ms, 'stimulus_duration_ms', 500),
        isi_duration_ms: pickFromDefaults(src.nback_isi_duration_ms, 'isi_duration_ms', 700),
        trial_duration_ms: pickFromDefaults(src.nback_trial_duration_ms, 'trial_duration_ms', 1200),

        show_fixation_cross_between_trials: (src.nback_show_fixation_cross_between_trials !== undefined && src.nback_show_fixation_cross_between_trials !== null)
          ? (src.nback_show_fixation_cross_between_trials === true)
          : (nbackDefaults.show_fixation_cross_between_trials === true),

        response_paradigm: pickFromDefaults(src.nback_response_paradigm, 'response_paradigm', 'go_nogo'),
        response_device: resolveDevice(pickFromDefaults(src.nback_response_device, 'response_device', 'inherit')),
        go_key: pickFromDefaults(src.nback_go_key, 'go_key', 'space'),
        match_key: pickFromDefaults(src.nback_match_key, 'match_key', 'j'),
        nonmatch_key: pickFromDefaults(src.nback_nonmatch_key, 'nonmatch_key', 'f'),
        show_buttons: (src.nback_show_buttons !== undefined && src.nback_show_buttons !== null)
          ? src.nback_show_buttons
          : (nbackDefaults.show_buttons ?? false),

        show_feedback: (src.nback_show_feedback !== undefined && src.nback_show_feedback !== null)
          ? src.nback_show_feedback
          : (nbackDefaults.show_feedback ?? false),
        feedback_duration_ms: pickFromDefaults(src.nback_feedback_duration_ms, 'feedback_duration_ms', 250)
      });
    }

    // Clone so we can safely delete block-level-only fields.
    // Builder exports parameter_windows as an array of { parameter, min, max }.
    // Support both object-map and array forms.
    const windows = (() => {
      if (isObject(block.parameter_windows)) return { ...block.parameter_windows };
      if (Array.isArray(block.parameter_windows)) {
        const out = {};
        for (const w of block.parameter_windows) {
          if (!isObject(w)) continue;
          const p = (w.parameter ?? '').toString().trim();
          if (!p) continue;
          out[p] = { min: w.min, max: w.max };
        }
        return out;
      }
      return {};
    })();
    const values = isObject(block.parameter_values) ? { ...block.parameter_values } : {};

    const seedParsed = Number.parseInt((block.seed ?? '').toString(), 10);
    const seed = Number.isFinite(seedParsed) ? (seedParsed >>> 0) : null;
    const rng = seed === null ? Math.random : mulberry32(seed);

    const sampleNumber = (min, max) => {
      const a = Number(min);
      const b = Number(max);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return lo + (hi - lo) * rng();
    };

    const sampleFromValues = (v) => {
      if (Array.isArray(v)) {
        if (v.length === 0) return null;
        const idx = Math.floor(rng() * v.length);
        return v[Math.max(0, Math.min(v.length - 1, idx))];
      }
      return v;
    };

    const normalizeOptions = (raw) => {
      if (raw === undefined || raw === null) return [];
      if (Array.isArray(raw)) return raw;
      return [raw];
    };

    const sampleFromOptions = (opts) => {
      const arr = Array.isArray(opts) ? opts : [];
      if (arr.length === 0) return null;
      const idx = Math.floor(rng() * arr.length);
      return arr[Math.max(0, Math.min(arr.length - 1, idx))];
    };

    // Adaptive / staircase support (trial-based). In continuous mode this isn't supported yet.
    let staircase = null;
    let adaptiveMeta = null;

    // Gabor QUEST blocks export values.adaptive = { mode:'quest', parameter: ... }
    if (baseType === 'gabor-trial' && isObject(values.adaptive) && (values.adaptive.mode || '').toString() === 'quest') {
      const a = values.adaptive;
      adaptiveMeta = {
        mode: 'quest',
        parameter: (a.parameter || 'target_tilt_deg').toString()
      };

      // If min/max not provided, try to infer from block windows.
      const inferredMin = (adaptiveMeta.parameter in windows && isObject(windows[adaptiveMeta.parameter])) ? Number(windows[adaptiveMeta.parameter].min) : undefined;
      const inferredMax = (adaptiveMeta.parameter in windows && isObject(windows[adaptiveMeta.parameter])) ? Number(windows[adaptiveMeta.parameter].max) : undefined;

      staircase = new QuestStaircase({
        ...a,
        parameter: adaptiveMeta.parameter,
        ...(Number.isFinite(inferredMin) && a.min_value === undefined ? { min_value: inferredMin } : {}),
        ...(Number.isFinite(inferredMax) && a.max_value === undefined ? { max_value: inferredMax } : {})
      });
    }

    // RDM adaptive blocks (builder exports: windows.initial_coherence, windows.step_size, values.algorithm)
    if (baseType === 'rdm-adaptive') {
      const algo = (values.algorithm || 'quest').toString();
      const target = Number.isFinite(Number(values.target_performance)) ? Number(values.target_performance) : 0.82;

      const initW = isObject(windows.initial_coherence) ? windows.initial_coherence : {};
      const stepW = isObject(windows.step_size) ? windows.step_size : {};
      const startValue = sampleNumber(initW.min, initW.max);
      const stepSize = sampleNumber(stepW.min, stepW.max);

      delete windows.initial_coherence;
      delete windows.step_size;

      adaptiveMeta = { mode: algo, parameter: 'coherence' };

      if (algo === 'quest') {
        staircase = new QuestStaircase({
          parameter: 'coherence',
          target_performance: target,
          start_value: Number.isFinite(startValue) ? startValue : 0.1,
          start_sd: Number.isFinite(stepSize) ? Math.max(0.02, stepSize) : 0.08,
          // Coherence is bounded.
          min_value: 0,
          max_value: 1,
          // For 2AFC-like left/right decisions.
          gamma: 0.5,
          delta: 0.01,
          beta: 5
        });
      } else {
        staircase = new WeightedUpDownStaircase({
          mode: algo,
          parameter: 'coherence',
          target_performance: target,
          start_value: Number.isFinite(startValue) ? startValue : 0.1,
          step_size: Number.isFinite(stepSize) ? stepSize : 0.05,
          min_value: 0,
          max_value: 1
        });
      }
    }

    const trials = [];
    for (let i = 0; i < length; i++) {
      const t = { type: baseType, _generated_from_block: true, _block_index: i };

      // Apply fixed values
      for (const [k, v] of Object.entries(values)) {
        t[k] = sampleFromValues(v);
      }

      // Apply sampled windows
      for (const [k, w] of Object.entries(windows)) {
        if (!isObject(w)) continue;
        const s = sampleNumber(w.min, w.max);
        if (s === null) continue;
        // Many windowed parameters are intended to be integer-ish (ms, px, counts).
        // However, some parameters *end with* `_px` but are continuous-valued, e.g.
        // `spatial_frequency_cyc_per_px` for Gabor. Rounding those to integers
        // collapses values like 0.06 -> 0, which makes the stimulus invisible.
        const isCyclesPerPx = /cyc_per_px$/i.test(k);
        const shouldRound = !isCyclesPerPx && /(_ms|_px|_deg|_count|_trials|_repetitions)$/i.test(k);
        t[k] = shouldRound ? Math.round(s) : s;
      }

      // Gabor cue presence gating (optional): jointly sample spatial/value cue presence per trial.
      // This is applied only when the Builder exports *enabled/probability fields*.
      if (baseType === 'gabor-trial' || baseType === 'gabor-quest') {
        const hasSpatialGate = (Object.prototype.hasOwnProperty.call(values, 'spatial_cue_enabled') || Object.prototype.hasOwnProperty.call(values, 'spatial_cue_probability'));
        const hasValueGate = (Object.prototype.hasOwnProperty.call(values, 'value_cue_enabled') || Object.prototype.hasOwnProperty.call(values, 'value_cue_probability'));

        if (hasSpatialGate || hasValueGate) {
          const spatialEnabled = Object.prototype.hasOwnProperty.call(values, 'spatial_cue_enabled') ? (values.spatial_cue_enabled === true) : true;
          const valueEnabled = Object.prototype.hasOwnProperty.call(values, 'value_cue_enabled') ? (values.value_cue_enabled === true) : true;

          const pSpatial = Object.prototype.hasOwnProperty.call(values, 'spatial_cue_probability') ? clamp(values.spatial_cue_probability, 0, 1) : 1;
          const pValue = Object.prototype.hasOwnProperty.call(values, 'value_cue_probability') ? clamp(values.value_cue_probability, 0, 1) : 1;

          const spatialPresent = spatialEnabled && rng() < pSpatial;
          const valuePresent = valueEnabled && rng() < pValue;

          if (!spatialPresent) {
            t.spatial_cue = 'none';
          } else {
            const opts = normalizeOptions(values.spatial_cue);
            const filtered = opts.filter(x => (x ?? '').toString().trim().toLowerCase() !== 'none');
            const picked = sampleFromOptions(filtered.length > 0 ? filtered : opts);
            t.spatial_cue = picked === null ? (t.spatial_cue ?? 'none') : picked;
          }

          if (!valuePresent) {
            t.left_value = 'neutral';
            t.right_value = 'neutral';
          } else {
            const lvOpts = normalizeOptions(values.left_value);
            const rvOpts = normalizeOptions(values.right_value);
            const lvFiltered = lvOpts.filter(x => (x ?? '').toString().trim().toLowerCase() !== 'neutral');
            const rvFiltered = rvOpts.filter(x => (x ?? '').toString().trim().toLowerCase() !== 'neutral');

            const leftPicked = sampleFromOptions(lvFiltered.length > 0 ? lvFiltered : lvOpts);
            const rightPicked = sampleFromOptions(rvFiltered.length > 0 ? rvFiltered : rvOpts);

            if (leftPicked !== null) t.left_value = leftPicked;
            if (rightPicked !== null) t.right_value = rightPicked;
          }

          // Don't leak gating config into per-trial parameters.
          delete t.spatial_cue_enabled;
          delete t.spatial_cue_probability;
          delete t.value_cue_enabled;
          delete t.value_cue_probability;
        }
      }

      // Adaptive override for the selected parameter.
      if (staircase && adaptiveMeta && typeof adaptiveMeta.parameter === 'string') {
        const p = adaptiveMeta.parameter;

        // NOTE: adaptive values must be chosen at runtime (on_start) so updates from
        // previous trials can influence the next trial. Precomputing values here would
        // freeze the staircase.
        let realizedAdaptiveValue = null;

        // Attach hooks (compiler will carry these into jsPsych trials).
        t.on_start = (trial) => {
          // If the parameter was already set by values/windows, adaptive should win.
          // For target_tilt_deg, QUEST adapts magnitude but we randomize sign for discriminate_tilt.
          let val;
          if (p === 'target_tilt_deg') {
            const mag = Math.abs(Number(staircase.next()));
            const sign = rng() < 0.5 ? -1 : 1;
            val = sign * mag;
          } else {
            val = staircase.next();
          }

          realizedAdaptiveValue = val;

          // Keep it on the expanded item too (useful for debugging / introspection).
          t[p] = val;

          if (isObject(trial.rdm)) {
            trial.rdm[p] = val;
          } else {
            trial[p] = val;
          }

          trial.data = isObject(trial.data) ? trial.data : {};
          trial.data.adaptive_mode = adaptiveMeta.mode;
          trial.data.adaptive_parameter = p;
          trial.data.adaptive_value = val;
        };

        t.on_finish = (data) => {
          // Determine correctness from plugin outputs.
          let isCorrect = false;

          if (data && typeof data.correctness === 'boolean') {
            isCorrect = data.correctness;
          } else if (data && typeof data.correct === 'boolean') {
            isCorrect = data.correct;
          } else if (data && data.response_side !== undefined && data.correct_side !== undefined) {
            isCorrect = (data.response_side !== null && data.response_side === data.correct_side);
          }

          staircase.update(isCorrect);

          // Keep the realized adaptive value on the data for analysis.
          if (data && typeof data === 'object') {
            data.adaptive_mode = adaptiveMeta.mode;
            data.adaptive_parameter = p;
            data.adaptive_value = realizedAdaptiveValue;
          }
        };
      }

      // dot-groups helper: group_2_percentage = 100 - group_1_percentage
      if (baseType === 'rdm-dot-groups') {
        if (Number.isFinite(t.group_1_percentage)) {
          const g1 = Math.max(0, Math.min(100, Math.round(t.group_1_percentage)));
          t.group_1_percentage = g1;
          t.group_2_percentage = 100 - g1;
        }
      }

      // Per-block response override
      if (isObject(block.response_parameters_override)) {
        t.response_parameters_override = { ...block.response_parameters_override };
      }

      // Per-trial transition info (continuous mode)
      if (Number.isFinite(values.transition_duration)) {
        t.transition_duration = values.transition_duration;
      }
      if (typeof values.transition_type === 'string') {
        t.transition_type = values.transition_type;
      }

      trials.push(t);
    }

    return trials;
  }

  function expandTimeline(rawTimeline, opts) {
    const inTl = Array.isArray(rawTimeline) ? rawTimeline : [];
    const out = [];

    const preserveFor = (() => {
      const list = (opts && Array.isArray(opts.preserveBlocksForComponentTypes)) ? opts.preserveBlocksForComponentTypes : [];
      return new Set(list.map(x => (x ?? '').toString().trim()).filter(Boolean));
    })();

    for (const item of inTl) {
      if (!isObject(item)) continue;

      if (item.type === 'nback-trial-sequence') {
        const expandNback = opts && opts.expandNbackSequences === true;
        if (expandNback) {
          out.push(...expandNbackTrialSequence(item, opts));
        } else {
          out.push(item);
        }
        continue;
      }

      if (item.type === 'block') {
        const baseType = (typeof item.component_type === 'string' && item.component_type.trim())
          ? item.component_type.trim()
          : (typeof item.block_component_type === 'string' && item.block_component_type.trim())
            ? item.block_component_type.trim()
            : 'rdm-trial';

        if (preserveFor.has(baseType)) {
          out.push(item);
        } else {
          out.push(...expandBlock(item, opts));
        }
        continue;
      }

      out.push(item);
    }

    return out;
  }

  function compileToJsPsychTimeline(config) {
    if (!isObject(config)) throw new Error('Config must be an object');

    function wrapPsyScreenHtml(stimulusHtml, promptHtml) {
      const stim = (stimulusHtml === null || stimulusHtml === undefined) ? '' : String(stimulusHtml);
      const prm = (promptHtml === null || promptHtml === undefined) ? '' : String(promptHtml);
      return `
        <div class="psy-wrap">
          <div class="psy-stage">
            <div class="psy-text">
              ${stim}
              ${prm ? `<div class="psy-prompt">${prm}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    }

    function wrapMaybeFunctionStimulus(stimulus, prompt) {
      const stimIsFn = typeof stimulus === 'function';
      const promptIsFn = typeof prompt === 'function';
      if (!stimIsFn && !promptIsFn) {
        const s = (stimulus === null || stimulus === undefined) ? '' : stimulus;
        const p = (prompt === undefined ? null : prompt);
        return wrapPsyScreenHtml(s, p);
      }

      return function () {
        let s = stimulus;
        let p = prompt;
        try { if (typeof s === 'function') s = s(); } catch { /* ignore */ }
        try { if (typeof p === 'function') p = p(); } catch { /* ignore */ }
        const ss = (s === null || s === undefined) ? '' : s;
        const pp = (p === undefined ? null : p);
        return wrapPsyScreenHtml(ss, pp);
      };
    }

    function resolveMaybeRelativeUrl(rawUrl) {
      const u = (rawUrl === null || rawUrl === undefined) ? '' : String(rawUrl).trim();
      if (!u) return '';
      // asset:// refs are Builder-only; they must be rewritten at export time.
      if (/^asset:\/\//i.test(u)) return '';
      if (/^(https?:|data:|blob:)/i.test(u)) return u;

      const src = (config && typeof config.__source_url === 'string') ? config.__source_url : '';
      if (!src) return u;

      try {
        // src can be relative (e.g., "configs/ABC1234.json"), so first make it absolute.
        const absSrc = new URL(src, window.location.href).toString();
        return new URL(u, absSrc).toString();
      } catch {
        return u;
      }
    }

    function resolvePlugin(p) {
      if (typeof p === 'function') return p;
      if (p && typeof p === 'object' && typeof p.default === 'function') return p.default;
      return null;
    }

    function requirePlugin(name, maybePlugin) {
      const resolved = resolvePlugin(maybePlugin);
      if (!resolved) {
        throw new Error(`Missing required plugin: ${name}`);
      }
      return resolved;
    }

    // html-keyboard-response comes from an external jsPsych plugin package.
    // Depending on bundling, it may be a function or an object with a `default` export.
    const HtmlKeyboardResponsePlugin = resolvePlugin(
      (typeof jsPsychHtmlKeyboardResponse !== 'undefined') ? jsPsychHtmlKeyboardResponse : null
    ) || resolvePlugin(window.jsPsychHtmlKeyboardResponse);

    const HtmlKeyboard = requirePlugin('html-keyboard-response (jsPsychHtmlKeyboardResponse)', HtmlKeyboardResponsePlugin);

    const experimentType = config.experiment_type || 'trial-based';
    const taskType = config.task_type || 'rdm';

    const baseRdmParams = normalizeRdmParams({
      ...(isObject(config.display_settings) ? config.display_settings : {}),
      ...(isObject(config.display_parameters) ? config.display_parameters : {}),
      ...(isObject(config.aperture_parameters) ? config.aperture_parameters : {}),
      ...(isObject(config.dot_parameters) ? config.dot_parameters : {}),
      ...(isObject(config.motion_parameters) ? config.motion_parameters : {}),
      ...(isObject(config.timing_parameters) ? config.timing_parameters : {}),

      // Continuous-mode meta (not all runtimes will use these yet, but keep them available)
      ...(Number.isFinite(config.frame_rate) ? { frame_rate: config.frame_rate } : {}),
      ...(Number.isFinite(config.duration) ? { duration: config.duration } : {}),
      ...(Number.isFinite(config.update_interval) ? { update_interval: config.update_interval } : {})
    });

    const responseDefaults = isObject(config.response_parameters) ? config.response_parameters : {};
    const dataCollection = normalizeDataCollection(config.data_collection);

    const defaultTransition = isObject(config.transition_settings) ? config.transition_settings : { duration_ms: 0, type: 'both' };

    const gaborDefaults = isObject(config.gabor_settings) ? config.gabor_settings : {};
    const stroopDefaults = isObject(config.stroop_settings) ? config.stroop_settings : {};
    const simonDefaults = isObject(config.simon_settings) ? config.simon_settings : {};
    const pvtDefaults = isObject(config.pvt_settings) ? config.pvt_settings : {};
    const nbackDefaults = isObject(config.nback_settings) ? config.nback_settings : {};

    const resolveNbackResponseDevice = (raw) => {
      const d = (raw ?? 'inherit').toString().trim().toLowerCase();
      if (!d || d === 'inherit') {
        const def = (nbackDefaults.response_device ?? 'keyboard').toString().trim().toLowerCase();
        return (def === 'mouse' || def === 'keyboard') ? def : 'keyboard';
      }
      return (d === 'mouse' || d === 'keyboard') ? d : 'keyboard';
    };

    const baseIti = (() => {
      const tp = isObject(config.timing_parameters) ? config.timing_parameters : {};
      const iti = Number(tp.inter_trial_interval ?? config.default_iti ?? 0);
      return Number.isFinite(iti) ? iti : 0;
    })();

    const preservePvtBlocks = (pvtDefaults && pvtDefaults.add_trial_per_false_start === true);
    const preserveNbackBlocks = (experimentType === 'continuous' && taskType === 'nback');
    const preserveBlocksFor = [
      ...(preservePvtBlocks ? ['pvt-trial'] : []),
      ...(preserveNbackBlocks ? ['nback-block'] : [])
    ];

    const expandedRaw = expandTimeline(config.timeline, {
      preserveBlocksForComponentTypes: preserveBlocksFor,
      expandNbackSequences: experimentType === 'trial-based',
      nbackDefaults
    });

    // SOC Dashboard: the Builder has "helper" component types (`soc-subtask-*`, `soc-dashboard-icon`) that are
    // intended to be composed into a single `soc-dashboard` session at export time.
    // If a config reaches the Interpreter without an explicit `soc-dashboard` session container, running the
    // helper items as separate timeline trials will always look sequential (one SOC desktop per trial).
    //
    // To be resilient to such exports, auto-compose these helper items into one `soc-dashboard` trial.
    const socDefaultsGlobal = isObject(config.soc_dashboard_settings) ? config.soc_dashboard_settings : null;

    let expanded = (() => {
      if (taskType !== 'soc-dashboard') return expandedRaw;
      const tl = Array.isArray(expandedRaw) ? expandedRaw : [];
      const hasSession = tl.some((it) => it && typeof it === 'object' && it.type === 'soc-dashboard');
      if (hasSession) return tl;

      const isSocSubtaskType = (t) => {
        return t === 'soc-subtask-sart-like'
          || t === 'soc-subtask-nback-like'
          || t === 'soc-subtask-flanker-like'
          || t === 'soc-subtask-wcst-like'
          || t === 'soc-subtask-pvt-like';
      };

      const mapSocSubtaskKind = (t) => {
        switch (t) {
          case 'soc-subtask-sart-like': return 'sart-like';
          case 'soc-subtask-nback-like': return 'nback-like';
          case 'soc-subtask-flanker-like': return 'flanker-like';
          case 'soc-subtask-wcst-like': return 'wcst-like';
          case 'soc-subtask-pvt-like': return 'pvt-like';
          default: return 'unknown';
        }
      };

      const extractSubtaskParams = (rawItem) => {
        const o = (rawItem && typeof rawItem === 'object') ? rawItem : {};
        const out = {};
        for (const [k, v] of Object.entries(o)) {
          if (k === 'type' || k === 'name' || k === 'title' || k === 'parameters' || k === 'data') continue;
          out[k] = v;
        }
        return out;
      };

      const subtasks = [];
      const icons = [];
      let insertAt = -1;

      for (let i = 0; i < tl.length; i++) {
        const item = tl[i];
        if (!item || typeof item !== 'object') continue;
        const t = item.type;
        if (t === 'soc-dashboard-icon') {
          if (insertAt < 0) insertAt = i;
          icons.push({
            label: (item.label || item.name || 'Icon').toString(),
            app: (item.app || 'soc').toString(),
            icon_text: (item.icon_text || '').toString(),
            row: Number.isFinite(Number(item.row)) ? parseInt(item.row, 10) : 0,
            col: Number.isFinite(Number(item.col)) ? parseInt(item.col, 10) : 0,
            distractor: (item.distractor !== undefined) ? !!item.distractor : true
          });
          continue;
        }
        if (isSocSubtaskType(t)) {
          if (insertAt < 0) insertAt = i;
          subtasks.push({
            type: mapSocSubtaskKind(t),
            title: (item.title || item.name || mapSocSubtaskKind(t) || 'Subtask').toString(),
            ...extractSubtaskParams(item)
          });
        }
      }

      if (insertAt < 0 || (subtasks.length === 0 && icons.length === 0)) return tl;

      // If the SOC defaults don't specify duration, infer it from the scheduled subtasks.
      const inferSessionDurationMs = () => {
        let maxEnd = 0;
        for (const s of subtasks) {
          const start = Number.isFinite(Number(s.start_at_ms)) ? Number(s.start_at_ms)
            : (Number.isFinite(Number(s.start_delay_ms)) ? Number(s.start_delay_ms) : 0);
          let end = null;
          if (Number.isFinite(Number(s.duration_ms)) && Number(s.duration_ms) > 0) {
            end = start + Number(s.duration_ms);
          } else if (Number.isFinite(Number(s.end_at_ms)) && Number(s.end_at_ms) > 0) {
            end = Number(s.end_at_ms);
          }
          if (Number.isFinite(end) && end > maxEnd) maxEnd = end;
        }
        return maxEnd > 0 ? Math.ceil(maxEnd) : null;
      };

      const inferredDuration = inferSessionDurationMs();
      const session = {
        type: 'soc-dashboard',
        // Leave most fields to socDefaultsGlobal merge at compile time.
        ...(inferredDuration !== null ? { trial_duration_ms: inferredDuration } : {}),
        ...(subtasks.length ? { subtasks } : {}),
        ...(icons.length ? { desktop_icons: icons } : {}),
        ...(socDefaultsGlobal && socDefaultsGlobal.num_tasks === undefined ? { num_tasks: subtasks.length || icons.length || 1 } : {})
      };

      const out = [];
      for (let i = 0; i < tl.length; i++) {
        if (i === insertAt) out.push(session);

        const item = tl[i];
        if (!item || typeof item !== 'object') {
          out.push(item);
          continue;
        }

        const t = item.type;
        if (t === 'soc-dashboard-icon' || isSocSubtaskType(t)) {
          continue; // absorbed into session
        }

        out.push(item);
      }

      return out;
    })();

    // Rewards activation normalization:
    // - Builder exports a top-level `reward_settings.enabled` flag.
    // - Rewards policy is defined by a `reward-settings` timeline component.
    // To be resilient to hand-edited / legacy configs, treat `reward_settings.enabled` as a master switch:
    //   - enabled === true  => ensure a reward-settings component exists and runs first
    //   - enabled === false => ignore/remove any reward-settings components
    const rewardSettingsCfg = isObject(config.reward_settings) ? config.reward_settings : null;
    const rewardsEnabledFlag = (rewardSettingsCfg && typeof rewardSettingsCfg.enabled === 'boolean') ? rewardSettingsCfg.enabled : null;
    const rewardSettingsOverrides = (() => {
      if (!rewardSettingsCfg) return null;
      const o = { ...rewardSettingsCfg };
      delete o.enabled;
      return Object.keys(o).length ? o : null;
    })();

    if (rewardsEnabledFlag !== null) {
      const tl = Array.isArray(expanded) ? expanded : [];
      const isRewardSettingsItem = (it) => it && typeof it === 'object' && it.type === 'reward-settings';
      const firstRewardSettings = tl.find(isRewardSettingsItem) || null;
      const rest = tl.filter((it) => !isRewardSettingsItem(it));

      if (rewardsEnabledFlag === true) {
        const base = firstRewardSettings ? { ...firstRewardSettings } : { type: 'reward-settings' };
        expanded = [{ ...base, ...(rewardSettingsOverrides ? rewardSettingsOverrides : {}) }, ...rest];
      } else {
        expanded = rest;
      }
    }

    const timeline = [];

    // Rewards (optional): configured by a reward-settings timeline component.
    let rewardsPolicy = null;
    let rewardsStoreKey = '__psy_rewards';

    const normBoolFromData = (v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v > 0;
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') return true;
        if (s === 'false' || s === '0' || s === 'no') return false;
      }
      return null;
    };

    const getRtMsFromData = (data) => {
      if (!data || typeof data !== 'object') return null;
      const a = Number(data.rt_ms);
      if (Number.isFinite(a) && a >= 0) return a;
      const b = Number(data.rt);
      if (Number.isFinite(b) && b >= 0) return b;
      return null;
    };

    const getCorrectFromData = (data) => {
      if (!data || typeof data !== 'object') return null;
      if (Object.prototype.hasOwnProperty.call(data, 'correctness')) return normBoolFromData(data.correctness);
      if (Object.prototype.hasOwnProperty.call(data, 'correct')) return normBoolFromData(data.correct);
      if (Object.prototype.hasOwnProperty.call(data, 'accuracy')) return normBoolFromData(data.accuracy);
      return null;
    };

    const scoringBasisLabel = (basis) => {
      const b = (basis || '').toString().trim().toLowerCase();
      if (b === 'reaction_time') return 'Reaction time';
      if (b === 'accuracy') return 'Accuracy';
      if (b === 'both') return 'Accuracy + reaction time';
      return basis || 'both';
    };

    const continueKeyLabel = (k) => {
      const key = (k || 'space').toString();
      if (key === ' ') return 'SPACE';
      if (key.toLowerCase() === 'space') return 'SPACE';
      if (key.toLowerCase() === 'enter') return 'ENTER';
      if (key === 'ALL_KEYS') return 'ANY KEY';
      return key.toUpperCase();
    };

    const renderTemplate = (tpl, vars) => {
      const raw = (tpl ?? '').toString();
      return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
        const v = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
        return (v === null || v === undefined) ? '' : String(v);
      });
    };

    const normalizeRewardScreen = (raw, legacyTitle, legacyTpl) => {
      const s = (raw && typeof raw === 'object') ? raw : {};
      return {
        title: ((s.title ?? legacyTitle ?? '') || '').toString(),
        template_html: ((s.template_html ?? s.html ?? legacyTpl ?? '') || '').toString(),
        image_url: ((s.image_url ?? '') || '').toString(),
        audio_url: ((s.audio_url ?? '') || '').toString()
      };
    };

    const resolveRewardMediaUrl = (maybeUrl) => {
      const u = (maybeUrl ?? '').toString().trim();
      if (!u) return '';
      return resolveMaybeRelativeUrl(u) || u;
    };

    const playRewardAudio = (maybeUrl) => {
      const u = resolveRewardMediaUrl(maybeUrl);
      if (!u) return;
      try {
        const a = new Audio(u);
        a.preload = 'auto';
        // Autoplay may be blocked; ignore failures.
        a.play().catch(() => {});
      } catch {
        // ignore
      }
    };

    const renderRewardScreenHtml = (screen, vars, { titleFallback } = {}) => {
      const scr = (screen && typeof screen === 'object') ? screen : {};
      const title = (scr.title || titleFallback || 'Rewards').toString();
      const tpl = (scr.template_html || '').toString();
      const body = tpl ? renderTemplate(tpl, vars) : '';
      const imageUrl = resolveRewardMediaUrl(scr.image_url);
      const audioUrl = resolveRewardMediaUrl(scr.audio_url);

      const imgHtml = imageUrl
        ? `<div style="margin: 12px 0;"><img src="${escapeHtml(imageUrl)}" alt="reward media" style="max-width:100%; max-height: 45vh; object-fit: contain;" /></div>`
        : '';

      const audioHtml = audioUrl
        ? `<div style="margin: 12px 0;"><audio controls src="${escapeHtml(audioUrl)}" style="width: 100%;"></audio></div>`
        : '';

      return `
        <div class="psy-wrap">
          <div class="psy-stage">
            <div class="psy-text">
              <h2 style="margin:0 0 8px 0;">${escapeHtml(title)}</h2>
              ${imgHtml}
              <div>${body}</div>
              ${audioHtml}
            </div>
          </div>
        </div>
      `;
    };

    const isRewardSuccess = (event, policy) => {
      const p = (policy && typeof policy === 'object') ? policy : {};
      const basis = (p.scoring_basis || 'both').toString().trim().toLowerCase();
      const rtThresh = Number(p.rt_threshold_ms);

      const rtOk = Number.isFinite(rtThresh)
        ? (event.rt_ms !== null && event.rt_ms !== undefined && Number(event.rt_ms) <= rtThresh)
        : true;

      const correctOk = (event.correct === true);
      const correctKnown = (event.correct === true || event.correct === false);
      const requireCorrectForRt = p.require_correct_for_rt === true;

      if (basis === 'accuracy') {
        return correctOk;
      }
      if (basis === 'reaction_time') {
        return rtOk && (!requireCorrectForRt || !correctKnown || correctOk);
      }
      // both
      return correctOk && rtOk;
    };

    const computeRewardPoints = (event, policy) => {
      const p = (policy && typeof policy === 'object') ? policy : {};
      const points = Number(p.points_per_success);
      if (!isRewardSuccess(event, p)) return 0;
      return Number.isFinite(points) ? points : 0;
    };

    const recordRewardEvent = (data, pluginType) => {
      if (!rewardsPolicy) return null;
      const storeKey = rewardsStoreKey;
      try {
        const bag = window[storeKey];
        if (!bag || bag.enabled !== true) return null;
        const policy = (bag.policy && typeof bag.policy === 'object') ? bag.policy : rewardsPolicy;
        const state = (bag.state && typeof bag.state === 'object') ? bag.state : (bag.state = {});
        const events = Array.isArray(state.events) ? state.events : (state.events = []);

        const evt = {
          plugin_type: pluginType || null,
          rt_ms: getRtMsFromData(data),
          correct: getCorrectFromData(data)
        };

        events.push(evt);
        state.eligible_trials = events.length;

        // Keep state updated every trial (needed for milestone triggers).
        const pts = computeRewardPoints(evt, policy);
        const success = isRewardSuccess(evt, policy);

        state.total_points = Number.isFinite(Number(state.total_points)) ? Number(state.total_points) : 0;
        state.rewarded_trials = Number.isFinite(Number(state.rewarded_trials)) ? Number(state.rewarded_trials) : 0;
        state.success_streak = Number.isFinite(Number(state.success_streak)) ? Number(state.success_streak) : 0;

        state.total_points += pts;
        if (pts > 0) state.rewarded_trials += 1;
        state.success_streak = success ? (state.success_streak + 1) : 0;
        evt.reward_points = pts;

        // Milestone queueing
        const queue = Array.isArray(state.screen_queue) ? state.screen_queue : (state.screen_queue = []);
        const shown = (state.milestones_shown && typeof state.milestones_shown === 'object')
          ? state.milestones_shown
          : (state.milestones_shown = {});

        const ms = Array.isArray(policy.milestones) ? policy.milestones : [];
        for (let i = 0; i < ms.length; i++) {
          const m0 = ms[i];
          if (!m0 || typeof m0 !== 'object') continue;
          const id = (m0.id ?? `m${i + 1}`).toString();
          if (shown[id]) continue;

          const trigger = (m0.trigger_type ?? m0.trigger ?? 'trial_count').toString();
          const threshold = Number(m0.threshold ?? m0.value);
          if (!Number.isFinite(threshold) || threshold <= 0) continue;

          let achieved = false;
          if (trigger === 'trial_count') achieved = state.eligible_trials >= threshold;
          else if (trigger === 'total_points') achieved = state.total_points >= threshold;
          else if (trigger === 'success_streak') achieved = state.success_streak >= threshold;

          if (achieved) {
            shown[id] = true;
            const scr = (m0.screen && typeof m0.screen === 'object') ? m0.screen : m0;
            queue.push(normalizeRewardScreen(scr, 'Rewards', scr.template_html ?? scr.html ?? ''));
          }
        }

        const calcOnFly = policy.calculate_on_the_fly === true;
        if (calcOnFly) {
          return {
            pts,
            total: state.total_points,
            rewarded_trials: state.rewarded_trials,
            eligible_trials: state.eligible_trials,
            success_streak: state.success_streak
          };
        }
        return {
          pts: null,
          total: null,
          rewarded_trials: null,
          eligible_trials: state.eligible_trials,
          success_streak: state.success_streak
        };
      } catch {
        return null;
      }
    };

    const maybeWrapOnFinishWithRewards = (originalOnFinish, pluginType) => {
      if (!rewardsPolicy) return originalOnFinish;
      return (data) => {
        const res = recordRewardEvent(data, pluginType);
        if (res && res.pts !== null) {
          try {
            data.reward_points = res.pts;
            data.reward_total_points = res.total;
            data.reward_rewarded_trials = res.rewarded_trials;
            data.reward_eligible_trials = res.eligible_trials;
            data.reward_success_streak = res.success_streak;
          } catch {
            // ignore
          }
        }
        if (typeof originalOnFinish === 'function') {
          try { originalOnFinish(data); } catch { /* ignore */ }
        }
      };
    };

    const maybeWrapTrialWithRewardPopups = (trial, pluginType) => {
      if (!rewardsPolicy) return trial;
      const ms = Array.isArray(rewardsPolicy.milestones) ? rewardsPolicy.milestones : [];
      if (!ms.length) return trial;

      const storeKey = rewardsStoreKey;

      const queueNotEmpty = () => {
        try {
          const bag = window[storeKey];
          const q = bag && bag.state && Array.isArray(bag.state.screen_queue) ? bag.state.screen_queue : [];
          return q.length > 0;
        } catch {
          return false;
        }
      };

      const contChoices = rewardsPolicy.continue_key === 'ALL_KEYS'
        ? 'ALL_KEYS'
        : (rewardsPolicy.continue_key === 'enter' ? ['Enter'] : [' ']);

      const rewardPopupTrial = {
        type: HtmlKeyboard,
        stimulus: () => {
          try {
            const bag = window[storeKey];
            const policy = bag && bag.policy ? bag.policy : rewardsPolicy;
            const state = (bag && bag.state && typeof bag.state === 'object') ? bag.state : {};
            const q = Array.isArray(state.screen_queue) ? state.screen_queue : [];
            const next = q.shift();

            const vars = {
              currency_label: (policy.currency_label || 'points').toString(),
              scoring_basis: policy.scoring_basis,
              scoring_basis_label: scoringBasisLabel(policy.scoring_basis),
              rt_threshold_ms: Number.isFinite(Number(policy.rt_threshold_ms)) ? Number(policy.rt_threshold_ms) : 0,
              points_per_success: Number.isFinite(Number(policy.points_per_success)) ? Number(policy.points_per_success) : 0,
              continue_key: policy.continue_key,
              continue_key_label: continueKeyLabel(policy.continue_key),
              total_points: Number.isFinite(Number(state.total_points)) ? Number(state.total_points) : 0,
              rewarded_trials: Number.isFinite(Number(state.rewarded_trials)) ? Number(state.rewarded_trials) : 0,
              eligible_trials: Number.isFinite(Number(state.eligible_trials)) ? Number(state.eligible_trials) : 0,
              success_streak: Number.isFinite(Number(state.success_streak)) ? Number(state.success_streak) : 0,
              badge_level: (state.badge_level ?? '')
            };

            const screen = normalizeRewardScreen(next, 'Rewards', '');
            return renderRewardScreenHtml(screen, vars, { titleFallback: screen.title || 'Rewards' });
          } catch {
            return `<div class="psy-wrap"><div class="psy-stage"><div class="psy-text"><h2>Rewards</h2><p>Could not render milestone.</p></div></div></div>`;
          }
        },
        choices: contChoices,
        on_start: () => {
          try {
            const bag = window[storeKey];
            const state = (bag && bag.state && typeof bag.state === 'object') ? bag.state : {};
            const q = Array.isArray(state.screen_queue) ? state.screen_queue : [];
            const next = q[0];
            if (next && typeof next === 'object' && next.audio_url) {
              playRewardAudio(next.audio_url);
            }
          } catch {
            // ignore
          }
        },
        data: { plugin_type: 'reward-milestone' }
      };

      const popups = {
        timeline: [rewardPopupTrial],
        conditional_function: queueNotEmpty,
        loop_function: queueNotEmpty
      };

      return { timeline: [trial, popups] };
    };

    // Continuous mode (RDM only): run the entire expanded sequence inside one plugin trial
    // so we don't re-render the DOM between frames.
    //
    // Other task types (e.g., soc-dashboard prototype) compile as normal trials even if
    // experiment_type is set to "continuous".
    if (experimentType === 'continuous' && taskType === 'rdm') {
      const RdmContinuous = requirePlugin('rdm-continuous (window.jsPsychRdmContinuous)', window.jsPsychRdmContinuous);
      const ui = isObject(config) ? config : {};
      const updateInterval = Number(ui.update_interval ?? 100);

      let segmentIndex = 0;
      let frames = [];

      const pushRdmContinuousSegment = () => {
        if (!frames.length) return;
        segmentIndex += 1;
        const segFrames = frames;
        frames = [];

        timeline.push({
          type: RdmContinuous,
          frames: segFrames,
          update_interval_ms: Number.isFinite(updateInterval) ? updateInterval : 100,
          default_transition: defaultTransition,
          dataCollection,
          data: { plugin_type: 'rdm-continuous', segment_index: segmentIndex }
        });
      };

      for (const item of expanded) {
        const type = item.type;

        if (type === 'detection-response-task-start') {
          // Ensure prior RDM frames run before starting a new DRT segment.
          pushRdmContinuousSegment();
          timeline.push({
            type: HtmlKeyboard,
            stimulus: '',
            prompt: null,
            choices: 'NO_KEYS',
            trial_duration: 1,
            response_ends_trial: false,
            on_start: () => {
              try {
                if (window.DrtEngine && typeof window.DrtEngine.start === 'function') {
                  window.DrtEngine.start(item);
                }
              } catch {
                // ignore
              }
            },
            data: { plugin_type: 'drt-start', task_type: 'drt' }
          });
          continue;
        }

        if (type === 'detection-response-task-stop') {
          // Ensure prior RDM frames run before stopping DRT.
          pushRdmContinuousSegment();
          timeline.push({
            type: HtmlKeyboard,
            stimulus: '',
            prompt: null,
            choices: 'NO_KEYS',
            trial_duration: 1,
            response_ends_trial: false,
            on_start: () => {
              try {
                if (window.DrtEngine && typeof window.DrtEngine.stop === 'function') {
                  window.DrtEngine.stop();
                }
              } catch {
                // ignore
              }
            },
            data: { plugin_type: 'drt-stop', task_type: 'drt' }
          });
          continue;
        }

        if (type === 'html-keyboard-response' || type === 'instructions') {
          // Keep instructions as their own trial.
          pushRdmContinuousSegment();
          timeline.push({
            type: HtmlKeyboard,
            stimulus: wrapMaybeFunctionStimulus(item.stimulus, item.prompt),
            prompt: null,
            choices: item.choices === 'ALL_KEYS' ? 'ALL_KEYS' : (Array.isArray(item.choices) ? item.choices : 'ALL_KEYS'),
            stimulus_duration: (item.stimulus_duration === undefined ? null : item.stimulus_duration),
            trial_duration: (item.trial_duration === undefined ? null : item.trial_duration),
            response_ends_trial: (item.response_ends_trial === undefined ? true : item.response_ends_trial),
            data: { plugin_type: type }
          });
          continue;
        }

        if (type === 'image-keyboard-response') {
          pushRdmContinuousSegment();
          const src = resolveMaybeRelativeUrl(item.stimulus);
          const w = Number.isFinite(Number(item.stimulus_width)) ? Number(item.stimulus_width) : null;
          const h = Number.isFinite(Number(item.stimulus_height)) ? Number(item.stimulus_height) : null;
          const keep = (item.maintain_aspect_ratio !== undefined) ? (item.maintain_aspect_ratio === true) : true;

          const style = [
            'max-width:100%;',
            'max-height:55vh;',
            'object-fit:contain;'
          ];
          if (w !== null) style.push(`width:${w}px;`);
          if (h !== null) style.push(`height:${h}px;`);
          if (!keep) style.push('object-fit:fill;');

          const stimulusHtml = src
            ? `<div style="display:flex; justify-content:center;"><img src="${escapeHtml(src)}" alt="stimulus" style="${style.join(' ')}" /></div>`
            : `<div class="psy-muted">(Missing image stimulus)</div>`;

          timeline.push({
            type: HtmlKeyboard,
            stimulus: wrapMaybeFunctionStimulus(stimulusHtml, item.prompt),
            prompt: null,
            choices: item.choices === 'ALL_KEYS' ? 'ALL_KEYS' : (Array.isArray(item.choices) ? item.choices : 'ALL_KEYS'),
            stimulus_duration: (item.stimulus_duration === undefined ? null : item.stimulus_duration),
            trial_duration: (item.trial_duration === undefined ? null : item.trial_duration),
            response_ends_trial: (item.response_ends_trial === undefined ? true : item.response_ends_trial),
            data: { plugin_type: type }
          });
          continue;
        }

        if (type === 'survey-response') {
          pushRdmContinuousSegment();
          const SurveyResponse = requirePlugin('survey-response (window.jsPsychSurveyResponse)', window.jsPsychSurveyResponse);
          timeline.push({
            type: SurveyResponse,
            title: item.title || 'Survey',
            instructions: item.instructions || '',
            submit_label: item.submit_label || 'Continue',
            allow_empty_on_timeout: item.allow_empty_on_timeout === true,
            timeout_ms: (item.timeout_ms === null || item.timeout_ms === undefined) ? null : Number(item.timeout_ms),
            questions: Array.isArray(item.questions) ? item.questions : [],
            data: { plugin_type: type }
          });
          continue;
        }

        if (typeof type === 'string' && type.startsWith('rdm-')) {
          const itemCopy = { ...item };
          delete itemCopy.response_parameters_override;
          delete itemCopy.transition_duration;
          delete itemCopy.transition_type;

          const responseOverride = isObject(item.response_parameters_override) ? item.response_parameters_override : null;
          const response = responseOverride ? deepMerge(responseDefaults, responseOverride) : { ...responseDefaults };

          const transition = {
            duration_ms: Number.isFinite(item.transition_duration) ? Number(item.transition_duration) : (Number(defaultTransition.duration_ms) || 0),
            type: (typeof item.transition_type === 'string' && item.transition_type.trim()) ? item.transition_type : (defaultTransition.type || 'both')
          };

          const rdm = applyResponseDerivedRdmFields(normalizeRdmParams({
            ...baseRdmParams,
            ...itemCopy,
            experiment_type: 'continuous'
          }), response);

          frames.push({
            rdm,
            response,
            timing: isObject(config.timing_parameters) ? config.timing_parameters : {},
            transition
          });
          continue;
        }

        // Unsupported components in continuous mode: treat as a segment boundary.
        pushRdmContinuousSegment();
      }

      // Flush trailing RDM frames.
      pushRdmContinuousSegment();

      return { experimentType, timeline };
    }

    for (const item of expanded) {
      const type = item.type;

      if (type === 'detection-response-task-start') {
        timeline.push({
          type: HtmlKeyboard,
          stimulus: '',
          prompt: null,
          choices: 'NO_KEYS',
          trial_duration: 1,
          response_ends_trial: false,
          on_start: () => {
            try {
              if (window.DrtEngine && typeof window.DrtEngine.start === 'function') {
                window.DrtEngine.start(item);
              }
            } catch {
              // ignore
            }
          },
          data: { plugin_type: 'drt-start', task_type: 'drt' }
        });
        continue;
      }

      if (type === 'detection-response-task-stop') {
        timeline.push({
          type: HtmlKeyboard,
          stimulus: '',
          prompt: null,
          choices: 'NO_KEYS',
          trial_duration: 1,
          response_ends_trial: false,
          on_start: () => {
            try {
              if (window.DrtEngine && typeof window.DrtEngine.stop === 'function') {
                window.DrtEngine.stop();
              }
            } catch {
              // ignore
            }
          },
          data: { plugin_type: 'drt-stop', task_type: 'drt' }
        });
        continue;
      }

      // PVT blocks (special handling): optionally extend by one trial per false start
      // to preserve the target number of valid (non-false-start) trials.
      if (type === 'block') {
        const baseType = (typeof item.component_type === 'string' && item.component_type.trim())
          ? item.component_type.trim()
          : (typeof item.block_component_type === 'string' && item.block_component_type.trim())
            ? item.block_component_type.trim()
            : '';

        // N-back continuous: Block is the generator.
        if (baseType === 'nback-block' && experimentType === 'continuous') {
          const NbackContinuous = requirePlugin('nback-continuous (window.jsPsychNbackContinuous)', window.jsPsychNbackContinuous);
          const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, 'nback-continuous');

          const src = (item && typeof item === 'object' && item.parameter_values && typeof item.parameter_values === 'object')
            ? { ...item, ...item.parameter_values }
            : item;

          const blockLen = Number.parseInt(src.block_length ?? src.length ?? 30, 10);
          const len = Number.isFinite(blockLen) ? Math.max(1, blockLen) : 30;

          const pickFromDefaults = (raw, defKey, fallback) => {
            if (raw !== undefined && raw !== null) return raw;
            if (nbackDefaults && nbackDefaults[defKey] !== undefined && nbackDefaults[defKey] !== null) return nbackDefaults[defKey];
            return fallback;
          };

          const renderMode = (pickFromDefaults(src.nback_render_mode, 'render_mode', 'token') ?? 'token').toString().trim().toLowerCase();
          const responseDevice = resolveNbackResponseDevice(pickFromDefaults(src.nback_response_device, 'response_device', 'inherit'));

          timeline.push({
            type: NbackContinuous,

            n: pickFromDefaults(src.nback_n, 'n', 2),
            length: len,
            seed: (pickFromDefaults(src.seed, 'seed', '') ?? '').toString(),

            stimulus_mode: pickFromDefaults(src.nback_stimulus_mode, 'stimulus_mode', 'letters'),
            stimulus_pool: pickFromDefaults(src.nback_stimulus_pool, 'stimulus_pool', ''),
            target_probability: pickFromDefaults(src.nback_target_probability, 'target_probability', 0.25),

            render_mode: renderMode,
            stimulus_template_html: (renderMode === 'custom_html')
              ? pickFromDefaults(src.nback_stimulus_template_html, 'stimulus_template_html', null)
              : null,

            stimulus_duration_ms: pickFromDefaults(src.nback_stimulus_duration_ms, 'stimulus_duration_ms', 500),
            isi_duration_ms: pickFromDefaults(src.nback_isi_duration_ms, 'isi_duration_ms', 700),
            trial_duration_ms: pickFromDefaults(src.nback_trial_duration_ms, 'trial_duration_ms', 1200),

            show_fixation_cross_between_trials: (src.nback_show_fixation_cross_between_trials !== undefined && src.nback_show_fixation_cross_between_trials !== null)
              ? (src.nback_show_fixation_cross_between_trials === true)
              : (nbackDefaults.show_fixation_cross_between_trials === true),

            response_paradigm: pickFromDefaults(src.nback_response_paradigm, 'response_paradigm', 'go_nogo'),
            response_device: responseDevice,
            go_key: pickFromDefaults(src.nback_go_key, 'go_key', 'space'),
            match_key: pickFromDefaults(src.nback_match_key, 'match_key', 'j'),
            nonmatch_key: pickFromDefaults(src.nback_nonmatch_key, 'nonmatch_key', 'f'),
            show_buttons: (src.nback_show_buttons !== undefined && src.nback_show_buttons !== null)
              ? (src.nback_show_buttons === true)
              : (nbackDefaults.show_buttons === true),

            show_feedback: (src.nback_show_feedback !== undefined && src.nback_show_feedback !== null)
              ? (src.nback_show_feedback === true)
              : (nbackDefaults.show_feedback === true),
            feedback_duration_ms: pickFromDefaults(src.nback_feedback_duration_ms, 'feedback_duration_ms', 250),

            ...(onFinish ? { on_finish: onFinish } : {}),
            data: { plugin_type: 'nback-continuous', task_type: 'nback', original_type: type }
          });
          continue;
        }

        if (baseType === 'pvt-trial' && pvtDefaults && pvtDefaults.add_trial_per_false_start === true) {
          const Pvt = requirePlugin('pvt (window.jsPsychPvt)', window.jsPsychPvt);

          const targetValidTrials = Math.max(1, Number.parseInt(item.block_length ?? item.length ?? 1, 10) || 1);

          // Builder exports parameter_windows as an array of { parameter, min, max }.
          // Support both object-map and array forms.
          const windows = (() => {
            if (isObject(item.parameter_windows)) return { ...item.parameter_windows };
            if (Array.isArray(item.parameter_windows)) {
              const out = {};
              for (const w of item.parameter_windows) {
                if (!isObject(w)) continue;
                const p = (w.parameter ?? '').toString().trim();
                if (!p) continue;
                out[p] = { min: w.min, max: w.max };
              }
              return out;
            }
            return {};
          })();

          const values = isObject(item.parameter_values) ? { ...item.parameter_values } : {};
          const seed = Number.isFinite(item.seed) ? (item.seed >>> 0) : null;
          const rng = seed === null ? Math.random : mulberry32(seed);

          const sampleNumber = (min, max) => {
            const a = Number(min);
            const b = Number(max);
            if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            return lo + (hi - lo) * rng();
          };

          const sampleFromValues = (v) => {
            if (Array.isArray(v)) {
              if (v.length === 0) return null;
              const idx = Math.floor(rng() * v.length);
              return v[Math.max(0, Math.min(v.length - 1, idx))];
            }
            return v;
          };

          const toStr = (v) => (v === undefined || v === null) ? '' : v.toString();
          const norm = (v) => toStr(v).trim();

          const resolveDevice = (v, fallback) => {
            const s = norm(v).toLowerCase();
            if (s === 'keyboard' || s === 'mouse' || s === 'both') return s;
            const fb = norm(fallback).toLowerCase();
            if (fb === 'mouse' || fb === 'both') return fb;
            return 'keyboard';
          };

          const parseBool = (v) => {
            if (typeof v === 'boolean') return v;
            if (typeof v === 'number') return v > 0;
            if (typeof v === 'string') {
              const s = v.trim().toLowerCase();
              if (s === '' || s === 'inherit') return null;
              if (s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'enabled') return true;
              if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'disabled') return false;
            }
            return null;
          };

          const state = {
            target_valid_trials: targetValidTrials,
            valid_done: 0,
            total_done: 0
          };

          const internalOnFinish = (data) => {
            state.total_done += 1;
            const fs = (data && typeof data === 'object') ? (data.false_start === true) : false;
            if (!fs) state.valid_done += 1;
          };

          const onFinish = maybeWrapOnFinishWithRewards(internalOnFinish, 'pvt-trial');

          const trialTemplate = {
            type: Pvt,

            on_start: (trial) => {
              // Sample parameters for this trial at runtime.
              const sampled = {};

              for (const [k, v] of Object.entries(values)) {
                sampled[k] = sampleFromValues(v);
              }

              for (const [k, w] of Object.entries(windows)) {
                if (!isObject(w)) continue;
                const s = sampleNumber(w.min, w.max);
                if (s === null) continue;
                const shouldRound = /(_ms|_px|_deg|_count|_trials|_repetitions)$/i.test(k);
                sampled[k] = shouldRound ? Math.round(s) : s;
              }

              // Resolve inheritance against experiment defaults.
              trial.response_device = resolveDevice(
                (sampled.response_device && sampled.response_device !== 'inherit') ? sampled.response_device : null,
                pvtDefaults.response_device || 'keyboard'
              );

              trial.response_key = (typeof sampled.response_key === 'string' && sampled.response_key.trim() !== '' && sampled.response_key !== 'inherit')
                ? sampled.response_key
                : (typeof pvtDefaults.response_key === 'string' && pvtDefaults.response_key.trim() !== '' ? pvtDefaults.response_key : 'space');

              trial.foreperiod_ms = Number.isFinite(Number(sampled.foreperiod_ms))
                ? Number(sampled.foreperiod_ms)
                : (Number.isFinite(Number(pvtDefaults.foreperiod_ms)) ? Number(pvtDefaults.foreperiod_ms) : 4000);

              trial.trial_duration_ms = Number.isFinite(Number(sampled.trial_duration_ms))
                ? Number(sampled.trial_duration_ms)
                : (Number.isFinite(Number(pvtDefaults.trial_duration_ms)) ? Number(pvtDefaults.trial_duration_ms) : 10000);

              const itiMs = Number.isFinite(Number(sampled.iti_ms))
                ? Number(sampled.iti_ms)
                : (Number.isFinite(Number(pvtDefaults.iti_ms)) ? Number(pvtDefaults.iti_ms) : baseIti);
              trial.iti_ms = itiMs;
              trial.post_trial_gap = itiMs;

              const fbEnabled = (() => {
                const a = parseBool(sampled.feedback_enabled);
                if (a !== null) return a;
                const b = parseBool(pvtDefaults.feedback_enabled);
                if (b !== null) return b;
                return false;
              })();

              const fbMessage = (typeof sampled.feedback_message === 'string' && sampled.feedback_message.trim() !== '' && sampled.feedback_message !== 'inherit')
                ? sampled.feedback_message
                : (typeof pvtDefaults.feedback_message === 'string' ? pvtDefaults.feedback_message : '');

              trial.feedback_enabled = fbEnabled;
              trial.feedback_message = fbMessage;

              // Data fields
              trial.data = {
                plugin_type: 'pvt-trial',
                task_type: 'pvt',
                _generated_from_block: true,
                _block_index: state.total_done,
                pvt_target_valid_trials: state.target_valid_trials,
                pvt_valid_trials_completed_before: state.valid_done,
                pvt_total_trials_completed_before: state.total_done
              };
            },

            on_finish: onFinish
          };

          timeline.push({
            timeline: [maybeWrapTrialWithRewardPopups(trialTemplate, 'pvt-trial')],
            loop_function: () => {
              return state.valid_done < state.target_valid_trials;
            }
          });

          continue;
        }
      }

      const socDefaults = (type === 'soc-dashboard' && isObject(config?.soc_dashboard_settings))
        ? config.soc_dashboard_settings
        : null;

        if (type === 'html-keyboard-response' || type === 'instructions') {
        timeline.push({
          type: HtmlKeyboard,
          stimulus: wrapMaybeFunctionStimulus(item.stimulus, item.prompt),
          prompt: null,
          choices: item.choices === 'ALL_KEYS' ? 'ALL_KEYS' : (Array.isArray(item.choices) ? item.choices : 'ALL_KEYS'),
          stimulus_duration: (item.stimulus_duration === undefined ? null : item.stimulus_duration),
          trial_duration: (item.trial_duration === undefined ? null : item.trial_duration),
          response_ends_trial: (item.response_ends_trial === undefined ? true : item.response_ends_trial),
          data: { plugin_type: type }
        });
        continue;
      }

      if (type === 'image-keyboard-response') {
        const src = resolveMaybeRelativeUrl(item.stimulus);
        const w = Number.isFinite(Number(item.stimulus_width)) ? Number(item.stimulus_width) : null;
        const h = Number.isFinite(Number(item.stimulus_height)) ? Number(item.stimulus_height) : null;
        const keep = (item.maintain_aspect_ratio !== undefined) ? (item.maintain_aspect_ratio === true) : true;

        const style = [
          'max-width:100%;',
          'max-height:55vh;',
          'object-fit:contain;'
        ];
        if (w !== null) style.push(`width:${w}px;`);
        if (h !== null) style.push(`height:${h}px;`);
        if (!keep) style.push('object-fit:fill;');

        const stimulusHtml = src
          ? `<div style="display:flex; justify-content:center;"><img src="${escapeHtml(src)}" alt="stimulus" style="${style.join(' ')}" /></div>`
          : `<div class="psy-muted">(Missing image stimulus)</div>`;

        timeline.push({
          type: HtmlKeyboard,
          stimulus: wrapMaybeFunctionStimulus(stimulusHtml, item.prompt),
          prompt: null,
          choices: item.choices === 'ALL_KEYS' ? 'ALL_KEYS' : (Array.isArray(item.choices) ? item.choices : 'ALL_KEYS'),
          stimulus_duration: (item.stimulus_duration === undefined ? null : item.stimulus_duration),
          trial_duration: (item.trial_duration === undefined ? null : item.trial_duration),
          response_ends_trial: (item.response_ends_trial === undefined ? true : item.response_ends_trial),
          data: { plugin_type: type }
        });
        continue;
      }

      if (type === 'survey-response') {
        const SurveyResponse = requirePlugin('survey-response (window.jsPsychSurveyResponse)', window.jsPsychSurveyResponse);
        timeline.push({
          type: SurveyResponse,
          title: item.title || 'Survey',
          instructions: item.instructions || '',
          submit_label: item.submit_label || 'Continue',
          allow_empty_on_timeout: item.allow_empty_on_timeout === true,
          timeout_ms: (item.timeout_ms === null || item.timeout_ms === undefined) ? null : Number(item.timeout_ms),
          questions: Array.isArray(item.questions) ? item.questions : [],
          data: { plugin_type: type }
        });
        continue;
      }

      if (type === 'visual-angle-calibration') {
        const Vac = requirePlugin('visual-angle-calibration (window.jsPsychVisualAngleCalibration)', window.jsPsychVisualAngleCalibration);
        const itemCopy = { ...item };
        delete itemCopy.type;
        timeline.push({
          type: Vac,
          ...itemCopy,
          data: { plugin_type: type }
        });
        continue;
      }

      if (type === 'reward-settings') {
        // Store policy globally + show participant-facing reward instructions.
        const itemCopy = { ...item };
        delete itemCopy.type;

        rewardsStoreKey = (itemCopy.store_key || '__psy_rewards').toString();
        const continueKey = (itemCopy.continue_key || 'space').toString();

        const instructionsScreen = normalizeRewardScreen(
          itemCopy.instructions_screen,
          itemCopy.instructions_title || 'Rewards',
          itemCopy.instructions_template_html || ''
        );

        const summaryScreen = normalizeRewardScreen(
          itemCopy.summary_screen,
          itemCopy.summary_title || 'Rewards Summary',
          itemCopy.summary_template_html || ''
        );

        const intermediateScreens = Array.isArray(itemCopy.intermediate_screens)
          ? itemCopy.intermediate_screens.map((s) => normalizeRewardScreen(s, 'Rewards', s && (s.template_html ?? s.html) ? (s.template_html ?? s.html) : ''))
          : (Array.isArray(itemCopy.extra_screens)
              ? itemCopy.extra_screens.map((s) => normalizeRewardScreen(s, 'Rewards', s && (s.template_html ?? s.html) ? (s.template_html ?? s.html) : ''))
              : []);

        const milestones = Array.isArray(itemCopy.milestones)
          ? itemCopy.milestones.map((m, idx) => {
              const mm = (m && typeof m === 'object') ? m : {};
              const scr = (mm.screen && typeof mm.screen === 'object') ? mm.screen : mm;
              return {
                id: (mm.id ?? `m${idx + 1}`).toString(),
                trigger_type: (mm.trigger_type ?? mm.trigger ?? 'trial_count').toString(),
                threshold: Number(mm.threshold ?? mm.value ?? 0),
                screen: normalizeRewardScreen(scr, 'Rewards', scr && (scr.template_html ?? scr.html) ? (scr.template_html ?? scr.html) : '')
              };
            })
          : [];

        rewardsPolicy = {
          store_key: rewardsStoreKey,
          currency_label: (itemCopy.currency_label || 'points').toString(),
          scoring_basis: (itemCopy.scoring_basis || 'both').toString(),
          rt_threshold_ms: Number.isFinite(Number(itemCopy.rt_threshold_ms)) ? Number(itemCopy.rt_threshold_ms) : 600,
          points_per_success: Number.isFinite(Number(itemCopy.points_per_success)) ? Number(itemCopy.points_per_success) : 1,
          require_correct_for_rt: itemCopy.require_correct_for_rt === true,
          calculate_on_the_fly: itemCopy.calculate_on_the_fly !== false,
          show_summary_at_end: itemCopy.show_summary_at_end !== false,
          continue_key: continueKey,

          // v2 screen model
          instructions_screen: instructionsScreen,
          intermediate_screens: intermediateScreens,
          milestones,
          summary_screen: summaryScreen,

          // legacy flat fields (kept for compatibility)
          instructions_title: (itemCopy.instructions_title || instructionsScreen.title || 'Rewards').toString(),
          instructions_template_html: (itemCopy.instructions_template_html || instructionsScreen.template_html || '').toString(),
          summary_title: (itemCopy.summary_title || summaryScreen.title || 'Rewards Summary').toString(),
          summary_template_html: (itemCopy.summary_template_html || summaryScreen.template_html || '').toString()
        };

        const basisLabel = scoringBasisLabel(rewardsPolicy.scoring_basis);
        const contLabel = continueKeyLabel(rewardsPolicy.continue_key);
        const contChoices = rewardsPolicy.continue_key === 'ALL_KEYS'
          ? 'ALL_KEYS'
          : (rewardsPolicy.continue_key === 'enter' ? ['Enter'] : [' ']);

        const vars = {
          currency_label: rewardsPolicy.currency_label,
          scoring_basis: rewardsPolicy.scoring_basis,
          scoring_basis_label: basisLabel,
          rt_threshold_ms: rewardsPolicy.rt_threshold_ms,
          points_per_success: rewardsPolicy.points_per_success,
          continue_key: rewardsPolicy.continue_key,
          continue_key_label: contLabel
        };

        const html = renderRewardScreenHtml(rewardsPolicy.instructions_screen, vars, { titleFallback: rewardsPolicy.instructions_title || 'Rewards' });

        timeline.push({
          type: HtmlKeyboard,
          stimulus: html,
          choices: contChoices,
          on_start: () => {
            try {
              window[rewardsStoreKey] = {
                enabled: true,
                policy: { ...rewardsPolicy },
                state: {
                  total_points: 0,
                  rewarded_trials: 0,
                  eligible_trials: 0,
                  success_streak: 0,
                  badge_level: '',
                  events: [],
                  computed_at_end: false,
                  screen_queue: [],
                  milestones_shown: {}
                }
              };

              if (rewardsPolicy.instructions_screen && rewardsPolicy.instructions_screen.audio_url) {
                playRewardAudio(rewardsPolicy.instructions_screen.audio_url);
              }
            } catch {
              // ignore
            }
          },
          data: { plugin_type: type }
        });

        // Additional screens shown once between instructions and first task trial.
        if (Array.isArray(rewardsPolicy.intermediate_screens) && rewardsPolicy.intermediate_screens.length) {
          for (let i = 0; i < rewardsPolicy.intermediate_screens.length; i++) {
            const scr = rewardsPolicy.intermediate_screens[i];
            timeline.push({
              type: HtmlKeyboard,
              stimulus: () => {
                try {
                  const bag = window[rewardsStoreKey];
                  const policy = bag && bag.policy ? bag.policy : rewardsPolicy;
                  const vars2 = {
                    currency_label: (policy.currency_label || 'points').toString(),
                    scoring_basis: policy.scoring_basis,
                    scoring_basis_label: scoringBasisLabel(policy.scoring_basis),
                    rt_threshold_ms: Number.isFinite(Number(policy.rt_threshold_ms)) ? Number(policy.rt_threshold_ms) : 0,
                    points_per_success: Number.isFinite(Number(policy.points_per_success)) ? Number(policy.points_per_success) : 0,
                    continue_key: policy.continue_key,
                    continue_key_label: continueKeyLabel(policy.continue_key),
                    total_points: 0,
                    rewarded_trials: 0,
                    eligible_trials: 0,
                    success_streak: 0,
                    badge_level: ''
                  };
                  return renderRewardScreenHtml(scr, vars2, { titleFallback: scr.title || 'Rewards' });
                } catch {
                  return renderRewardScreenHtml(scr, vars, { titleFallback: scr.title || 'Rewards' });
                }
              },
              choices: contChoices,
              on_start: () => {
                try {
                  if (scr && scr.audio_url) playRewardAudio(scr.audio_url);
                } catch {
                  // ignore
                }
              },
              data: { plugin_type: 'reward-intermediate', index: i }
            });
          }
        }
        continue;
      }

      if (type === 'soc-dashboard') {
        const SocDashboard = requirePlugin('soc-dashboard (window.jsPsychSocDashboard)', window.jsPsychSocDashboard);
        const itemCopy = { ...item };
        delete itemCopy.type;
        timeline.push({
          type: SocDashboard,
          ...(socDefaults ? { ...socDefaults } : {}),
          ...itemCopy,
          data: { plugin_type: type, task_type: 'soc-dashboard' }
        });
        continue;
      }

      // Builder-only helper components: allow running a single SOC subtask directly by
      // wrapping it in a one-window SOC Dashboard session.
      if (
        type === 'soc-subtask-sart-like'
        || type === 'soc-subtask-nback-like'
        || type === 'soc-subtask-flanker-like'
        || type === 'soc-subtask-wcst-like'
        || type === 'soc-subtask-pvt-like'
      ) {
        const SocDashboard = requirePlugin('soc-dashboard (window.jsPsychSocDashboard)', window.jsPsychSocDashboard);

        const kind = (t) => {
          switch (t) {
            case 'soc-subtask-sart-like': return 'sart-like';
            case 'soc-subtask-nback-like': return 'nback-like';
            case 'soc-subtask-flanker-like': return 'flanker-like';
            case 'soc-subtask-wcst-like': return 'wcst-like';
            case 'soc-subtask-pvt-like': return 'pvt-like';
            default: return 'unknown';
          }
        };

        const itemCopy = { ...item };
        delete itemCopy.type;

        const subtaskTitle = (itemCopy.title ?? itemCopy.name ?? kind(type) ?? 'Subtask').toString();
        const startAt = Number.isFinite(Number(itemCopy.start_at_ms)) ? Number(itemCopy.start_at_ms) : 0;
        const duration = Number.isFinite(Number(itemCopy.duration_ms)) ? Number(itemCopy.duration_ms) : null;
        const sessionDuration = (duration !== null && duration > 0)
          ? Math.max(1, Math.floor(startAt + duration))
          : null;

        const subtaskParams = { ...itemCopy };
        delete subtaskParams.title;
        delete subtaskParams.name;
        delete subtaskParams.parameters;
        delete subtaskParams.data;

        timeline.push({
          type: SocDashboard,
          ...(socDefaults ? { ...socDefaults } : {}),
          title: 'SOC Dashboard',
          ...(sessionDuration !== null ? { trial_duration_ms: sessionDuration } : {}),
          subtasks: [{ type: kind(type), title: subtaskTitle, ...subtaskParams }],
          data: { plugin_type: 'soc-dashboard', task_type: 'soc-dashboard', original_type: type }
        });
        continue;
      }

      if (typeof type === 'string' && type.startsWith('rdm-')) {
        const Rdm = requirePlugin('rdm (window.jsPsychRdm)', window.jsPsychRdm);
        const onStart = typeof item.on_start === 'function' ? item.on_start : null;
        const onFinish0 = typeof item.on_finish === 'function' ? item.on_finish : null;
        const onFinish = maybeWrapOnFinishWithRewards(onFinish0, type);

        const itemCopy = { ...item };
        delete itemCopy.response_parameters_override;
        delete itemCopy.transition_duration;
        delete itemCopy.transition_type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        const responseOverride = isObject(item.response_parameters_override) ? item.response_parameters_override : null;
        const response = responseOverride ? deepMerge(responseDefaults, responseOverride) : { ...responseDefaults };

        const timing = isObject(config.timing_parameters) ? config.timing_parameters : {};

        const transition = (experimentType === 'continuous')
          ? {
              duration_ms: Number.isFinite(item.transition_duration) ? Number(item.transition_duration) : (Number(defaultTransition.duration_ms) || 0),
              type: (typeof item.transition_type === 'string' && item.transition_type.trim()) ? item.transition_type : (defaultTransition.type || 'both')
            }
          : { duration_ms: 0, type: 'none' };

        const rdm = applyResponseDerivedRdmFields(normalizeRdmParams({
          ...baseRdmParams,
          ...itemCopy,
          experiment_type: experimentType
        }), response);

        const trial = {
          type: Rdm,
          rdm,
          response,
          timing,
          transition,
          dataCollection,
          ...(experimentType === 'trial-based' && baseIti > 0 ? { post_trial_gap: baseIti } : {}),
          ...(onStart ? { on_start: onStart } : {}),
          ...(onFinish ? { on_finish: onFinish } : {}),
          data: {
            plugin_type: type,
            _generated_from_block: !!item._generated_from_block,
            _block_index: Number.isFinite(item._block_index) ? item._block_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // Flanker task
      if (type === 'flanker-trial') {
        const Flanker = requirePlugin('flanker (window.jsPsychFlanker)', window.jsPsychFlanker);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);
        const trial = {
          ...item,
          type: Flanker,
          post_trial_gap: Number.isFinite(Number(item.iti_ms)) ? Number(item.iti_ms) : 0,
          ...(onFinish ? { on_finish: onFinish } : {}),
          data: { plugin_type: type, task_type: 'flanker' }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // SART task
      if (type === 'sart-trial') {
        const Sart = requirePlugin('sart (window.jsPsychSart)', window.jsPsychSart);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);
        const trial = {
          ...item,
          type: Sart,
          post_trial_gap: Number.isFinite(Number(item.iti_ms)) ? Number(item.iti_ms) : 0,
          ...(onFinish ? { on_finish: onFinish } : {}),
          data: { plugin_type: type, task_type: 'sart' }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // N-back task (trial-based)
      if (type === 'nback-block') {
        const Nback = requirePlugin('nback (window.jsPsychNback)', window.jsPsychNback);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);

        const itemCopy = { ...item };
        if ('response_device' in itemCopy) itemCopy.response_device = resolveNbackResponseDevice(itemCopy.response_device);
        const rm = (itemCopy.render_mode ?? 'token').toString().trim().toLowerCase();
        itemCopy.render_mode = rm;
        if (rm !== 'custom_html') delete itemCopy.stimulus_template_html;

        const trial = {
          ...itemCopy,
          type: Nback,
          ...(onFinish ? { on_finish: onFinish } : {}),
          data: {
            plugin_type: type,
            task_type: 'nback',
            _generated_from_nback_sequence: item._generated_from_nback_sequence === true,
            _sequence_seed: Number.isFinite(item._sequence_seed) ? item._sequence_seed : null,
            _sequence_index: Number.isFinite(item._sequence_index) ? item._sequence_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // N-back task (continuous stream)
      if (type === 'nback-trial-sequence' && experimentType === 'continuous') {
        const NbackContinuous = requirePlugin('nback-continuous (window.jsPsychNbackContinuous)', window.jsPsychNbackContinuous);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, 'nback-continuous');

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        // Apply experiment-wide N-back defaults when fields are missing.
        for (const [k, v] of Object.entries(nbackDefaults || {})) {
          if (itemCopy[k] === undefined || itemCopy[k] === null) itemCopy[k] = v;
        }

        itemCopy.response_device = resolveNbackResponseDevice(itemCopy.response_device);
        const renderMode = (itemCopy.render_mode ?? 'token').toString().trim().toLowerCase();
        itemCopy.render_mode = renderMode;
        if (renderMode !== 'custom_html') delete itemCopy.stimulus_template_html;

        const trial = {
          type: NbackContinuous,
          ...itemCopy,
          ...(onFinish ? { on_finish: onFinish } : {}),
          data: { plugin_type: 'nback-continuous', task_type: 'nback', original_type: type }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, 'nback-continuous'));
        continue;
      }

      // Gabor task
      if (type === 'gabor-trial') {
        const Gabor = requirePlugin('gabor (window.jsPsychGabor)', window.jsPsychGabor);
        const onStart = typeof item.on_start === 'function' ? item.on_start : null;
        const onFinish0 = typeof item.on_finish === 'function' ? item.on_finish : null;
        const onFinish = maybeWrapOnFinishWithRewards(onFinish0, type);

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        const trial = {
          type: Gabor,

          // Inherit experiment-wide gabor settings by default.
          ...gaborDefaults,

          // Allow per-trial overrides.
          ...itemCopy,

          ...(onStart ? { on_start: onStart } : {}),
          ...(onFinish ? { on_finish: onFinish } : {}),

          data: {
            plugin_type: type,
            task_type: 'gabor',
            _generated_from_block: !!item._generated_from_block,
            _block_index: Number.isFinite(item._block_index) ? item._block_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // Stroop task
      if (type === 'stroop-trial') {
        const Stroop = requirePlugin('stroop (window.jsPsychStroop)', window.jsPsychStroop);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        const stimuli = Array.isArray(stroopDefaults.stimuli) ? stroopDefaults.stimuli : [];

        const toStr = (v) => (v === undefined || v === null) ? '' : v.toString();
        const norm = (v) => toStr(v).trim();

        const findInkHex = (inkName, fallbackHex) => {
          const needle = norm(inkName).toLowerCase();
          for (const s of stimuli) {
            const n = norm(s && s.name).toLowerCase();
            if (n && n === needle) {
              const c = norm(s && (s.color || s.hex || s.color_hex));
              if (c) return c;
            }
          }
          return norm(fallbackHex) || '#ffffff';
        };

        const computeCongruency = (word, inkName) => {
          const w = norm(word).toLowerCase();
          const i = norm(inkName).toLowerCase();
          if (!w || !i) return 'auto';
          return (w === i) ? 'congruent' : 'incongruent';
        };

        const responseMode = (item.response_mode && item.response_mode !== 'inherit')
          ? item.response_mode
          : (stroopDefaults.response_mode || 'color_naming');

        const responseDevice = (item.response_device && item.response_device !== 'inherit')
          ? item.response_device
          : (stroopDefaults.response_device || 'keyboard');

        const choiceKeys = (Array.isArray(item.choice_keys) && item.choice_keys.length > 0)
          ? item.choice_keys
          : (Array.isArray(stroopDefaults.choice_keys) ? stroopDefaults.choice_keys : []);

        const congruentKey = (typeof item.congruent_key === 'string' && item.congruent_key.trim() !== '')
          ? item.congruent_key
          : (typeof stroopDefaults.congruent_key === 'string' ? stroopDefaults.congruent_key : 'f');

        const incongruentKey = (typeof item.incongruent_key === 'string' && item.incongruent_key.trim() !== '')
          ? item.incongruent_key
          : (typeof stroopDefaults.incongruent_key === 'string' ? stroopDefaults.incongruent_key : 'j');

        const fontSizePx = Number.isFinite(Number(item.stimulus_font_size_px))
          ? Number(item.stimulus_font_size_px)
          : (Number.isFinite(Number(stroopDefaults.stimulus_font_size_px)) ? Number(stroopDefaults.stimulus_font_size_px) : 72);

        const stimMs = Number.isFinite(Number(item.stimulus_duration_ms))
          ? Number(item.stimulus_duration_ms)
          : (Number.isFinite(Number(stroopDefaults.stimulus_duration_ms)) ? Number(stroopDefaults.stimulus_duration_ms) : 0);

        const trialMs = Number.isFinite(Number(item.trial_duration_ms))
          ? Number(item.trial_duration_ms)
          : (Number.isFinite(Number(stroopDefaults.trial_duration_ms)) ? Number(stroopDefaults.trial_duration_ms) : 2000);

        const itiMs = Number.isFinite(Number(item.iti_ms))
          ? Number(item.iti_ms)
          : (Number.isFinite(Number(stroopDefaults.iti_ms)) ? Number(stroopDefaults.iti_ms) : 0);

        const word = norm(item.word || '');
        const inkName = norm(item.ink_color_name || '');

        const providedCongruency = norm(item.congruency || 'auto').toLowerCase();
        const congruency = (providedCongruency === 'congruent' || providedCongruency === 'incongruent')
          ? providedCongruency
          : computeCongruency(word, inkName);

        const inkHex = findInkHex(inkName, item.ink_color_hex);

        const trial = {
          type: Stroop,

          ...itemCopy,

          // Effective defaults (compiler resolves inheritance)
          stimuli,
          response_mode: responseMode,
          response_device: responseDevice,
          choice_keys: choiceKeys,
          congruent_key: congruentKey,
          incongruent_key: incongruentKey,
          stimulus_font_size_px: fontSizePx,
          stimulus_duration_ms: stimMs,
          trial_duration_ms: trialMs,
          ink_color_hex: inkHex,
          congruency,

          post_trial_gap: itiMs,
          ...(onFinish ? { on_finish: onFinish } : {}),

          data: {
            plugin_type: type,
            task_type: 'stroop',
            _generated_from_block: !!item._generated_from_block,
            _block_index: Number.isFinite(item._block_index) ? item._block_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // Simon task
      if (type === 'simon-trial') {
        const Simon = requirePlugin('simon (window.jsPsychSimon)', window.jsPsychSimon);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        const stimuli = Array.isArray(simonDefaults.stimuli) ? simonDefaults.stimuli : [];

        const toStr = (v) => (v === undefined || v === null) ? '' : v.toString();
        const norm = (v) => toStr(v).trim();

        const coerceSide = (v, fallback) => {
          const s = norm(v).toLowerCase();
          if (s === 'left' || s === 'right') return s;
          return fallback;
        };

        const findStimulusHex = (colorName, fallbackHex) => {
          const needle = norm(colorName).toLowerCase();
          for (const s of stimuli) {
            const n = norm(s && s.name).toLowerCase();
            if (n && n === needle) {
              const c = norm(s && (s.color || s.hex || s.color_hex));
              if (c) return c;
            }
          }
          return norm(fallbackHex) || '#ffffff';
        };

        const resolveDevice = (v, fallback) => {
          const s = norm(v).toLowerCase();
          if (s === 'keyboard' || s === 'mouse') return s;
          return (fallback || 'keyboard').toString().trim().toLowerCase() === 'mouse' ? 'mouse' : 'keyboard';
        };

        const responseDevice = resolveDevice(
          (item.response_device && item.response_device !== 'inherit') ? item.response_device : null,
          simonDefaults.response_device || 'keyboard'
        );

        const leftKey = (typeof item.left_key === 'string' && item.left_key.trim() !== '' && item.left_key !== 'inherit')
          ? item.left_key
          : (typeof simonDefaults.left_key === 'string' ? simonDefaults.left_key : 'f');

        const rightKey = (typeof item.right_key === 'string' && item.right_key.trim() !== '' && item.right_key !== 'inherit')
          ? item.right_key
          : (typeof simonDefaults.right_key === 'string' ? simonDefaults.right_key : 'j');

        const diameterPx = Number.isFinite(Number(item.circle_diameter_px))
          ? Number(item.circle_diameter_px)
          : (Number.isFinite(Number(simonDefaults.circle_diameter_px)) ? Number(simonDefaults.circle_diameter_px) : 140);

        const stimMs = Number.isFinite(Number(item.stimulus_duration_ms))
          ? Number(item.stimulus_duration_ms)
          : (Number.isFinite(Number(simonDefaults.stimulus_duration_ms)) ? Number(simonDefaults.stimulus_duration_ms) : 0);

        const trialMs = Number.isFinite(Number(item.trial_duration_ms))
          ? Number(item.trial_duration_ms)
          : (Number.isFinite(Number(simonDefaults.trial_duration_ms)) ? Number(simonDefaults.trial_duration_ms) : 1500);

        const itiMs = Number.isFinite(Number(item.iti_ms))
          ? Number(item.iti_ms)
          : (Number.isFinite(Number(simonDefaults.iti_ms)) ? Number(simonDefaults.iti_ms) : 0);

        const stimulusSide = coerceSide(item.stimulus_side, 'left');
        const stimulusColorName = norm(item.stimulus_color_name || '')
          || norm(stimuli[0] && stimuli[0].name)
          || 'BLUE';

        const providedCorrectSide = coerceSide(item.correct_response_side, '');
        const derivedCorrectSide = (() => {
          const needle = stimulusColorName.toLowerCase();
          const first = norm(stimuli[0] && stimuli[0].name).toLowerCase();
          const second = norm(stimuli[1] && stimuli[1].name).toLowerCase();
          if (needle && first && needle === first) return 'left';
          if (needle && second && needle === second) return 'right';
          return 'left';
        })();

        const correctSide = (providedCorrectSide === 'left' || providedCorrectSide === 'right')
          ? providedCorrectSide
          : derivedCorrectSide;

        const congruency = (stimulusSide === correctSide) ? 'congruent' : 'incongruent';
        const stimulusHex = findStimulusHex(stimulusColorName, item.stimulus_color_hex);

        const trial = {
          type: Simon,

          ...itemCopy,

          // Effective defaults (compiler resolves inheritance)
          stimuli,
          response_device: responseDevice,
          left_key: leftKey,
          right_key: rightKey,
          circle_diameter_px: diameterPx,
          stimulus_duration_ms: stimMs,
          trial_duration_ms: trialMs,

          stimulus_side: stimulusSide,
          stimulus_color_name: stimulusColorName,
          stimulus_color_hex: stimulusHex,
          correct_response_side: correctSide,
          congruency,

          iti_ms: itiMs,
          post_trial_gap: itiMs,
          ...(onFinish ? { on_finish: onFinish } : {}),

          data: {
            plugin_type: type,
            task_type: 'simon',
            _generated_from_block: !!item._generated_from_block,
            _block_index: Number.isFinite(item._block_index) ? item._block_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // Psychomotor Vigilance Task (PVT)
      if (type === 'pvt-trial') {
        const Pvt = requirePlugin('pvt (window.jsPsychPvt)', window.jsPsychPvt);
        const onFinish = maybeWrapOnFinishWithRewards(typeof item.on_finish === 'function' ? item.on_finish : null, type);

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        const toStr = (v) => (v === undefined || v === null) ? '' : v.toString();
        const norm = (v) => toStr(v).trim();

        const resolveDevice = (v, fallback) => {
          const s = norm(v).toLowerCase();
          if (s === 'keyboard' || s === 'mouse' || s === 'both') return s;
          const fb = norm(fallback).toLowerCase();
          if (fb === 'mouse' || fb === 'both') return fb;
          return 'keyboard';
        };

        const responseDevice = resolveDevice(
          (item.response_device && item.response_device !== 'inherit') ? item.response_device : null,
          pvtDefaults.response_device || 'keyboard'
        );

        const parseBool = (v) => {
          if (typeof v === 'boolean') return v;
          if (typeof v === 'number') return v > 0;
          if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            if (s === '' || s === 'inherit') return null;
            if (s === 'true' || s === '1' || s === 'yes' || s === 'on' || s === 'enabled') return true;
            if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === 'disabled') return false;
          }
          return null;
        };

        const feedbackEnabled = (() => {
          const a = parseBool(item.feedback_enabled);
          if (a !== null) return a;
          const b = parseBool(pvtDefaults.feedback_enabled);
          if (b !== null) return b;
          return false;
        })();

        const feedbackMessage = (typeof item.feedback_message === 'string' && item.feedback_message.trim() !== '' && item.feedback_message !== 'inherit')
          ? item.feedback_message
          : (typeof pvtDefaults.feedback_message === 'string' ? pvtDefaults.feedback_message : '');

        const responseKey = (typeof item.response_key === 'string' && item.response_key.trim() !== '' && item.response_key !== 'inherit')
          ? item.response_key
          : (typeof pvtDefaults.response_key === 'string' && pvtDefaults.response_key.trim() !== '' ? pvtDefaults.response_key : 'space');

        const foreperiodMs = Number.isFinite(Number(item.foreperiod_ms))
          ? Number(item.foreperiod_ms)
          : (Number.isFinite(Number(pvtDefaults.foreperiod_ms)) ? Number(pvtDefaults.foreperiod_ms) : 4000);

        const trialMs = Number.isFinite(Number(item.trial_duration_ms))
          ? Number(item.trial_duration_ms)
          : (Number.isFinite(Number(pvtDefaults.trial_duration_ms)) ? Number(pvtDefaults.trial_duration_ms) : 10000);

        const itiMs = Number.isFinite(Number(item.iti_ms))
          ? Number(item.iti_ms)
          : (Number.isFinite(Number(pvtDefaults.iti_ms)) ? Number(pvtDefaults.iti_ms) : baseIti);

        const trial = {
          type: Pvt,

          ...itemCopy,

          response_device: responseDevice,
          response_key: responseKey,
          foreperiod_ms: foreperiodMs,
          trial_duration_ms: trialMs,

          feedback_enabled: feedbackEnabled,
          feedback_message: feedbackMessage,

          iti_ms: itiMs,
          post_trial_gap: itiMs,
          ...(onFinish ? { on_finish: onFinish } : {}),

          data: {
            plugin_type: type,
            task_type: 'pvt',
            _generated_from_block: !!item._generated_from_block,
            _block_index: Number.isFinite(item._block_index) ? item._block_index : null
          }
        };
        timeline.push(maybeWrapTrialWithRewardPopups(trial, type));
        continue;
      }

      // Unknown component types: show as a debug screen.
      timeline.push({
        type: HtmlKeyboard,
        stimulus: `<div style="max-width: 900px; margin: 0 auto; text-align:left;">
          <h3>Unsupported component</h3>
          <div><b>type</b>: ${String(type)}</div>
          <pre style="white-space: pre-wrap;">${escapeHtml(JSON.stringify(item, null, 2))}</pre>
          <div style="opacity:0.7">Press any key to continue.</div>
        </div>`,
        choices: 'ALL_KEYS',
        data: { plugin_type: 'unsupported', original_type: type }
      });
    }

    // Optional end-of-experiment reward summary screen.
    if (rewardsPolicy && rewardsPolicy.show_summary_at_end === true) {
      const storeKey = rewardsStoreKey;
      const contChoices = rewardsPolicy.continue_key === 'ALL_KEYS'
        ? 'ALL_KEYS'
        : (rewardsPolicy.continue_key === 'enter' ? ['Enter'] : [' ']);

      timeline.push({
        type: HtmlKeyboard,
        stimulus: () => {
          try {
            const bag = window[storeKey];
            const policy = bag && bag.policy ? bag.policy : rewardsPolicy;
            const state = (bag && bag.state && typeof bag.state === 'object') ? bag.state : {};
            const events = Array.isArray(state.events) ? state.events : [];

            if (policy && policy.calculate_on_the_fly !== true) {
              // Compute totals at summary time from recorded outcomes.
              let total = 0;
              let rewarded = 0;
              for (const evt of events) {
                const pts = computeRewardPoints(evt, policy);
                total += pts;
                if (pts > 0) rewarded += 1;
              }
              state.total_points = total;
              state.rewarded_trials = rewarded;
              state.eligible_trials = events.length;
              state.computed_at_end = true;
              if (bag && bag.state) bag.state = state;
            }

            const vars = {
              currency_label: (policy.currency_label || 'points').toString(),
              scoring_basis: policy.scoring_basis,
              scoring_basis_label: scoringBasisLabel(policy.scoring_basis),
              rt_threshold_ms: Number.isFinite(Number(policy.rt_threshold_ms)) ? Number(policy.rt_threshold_ms) : 0,
              points_per_success: Number.isFinite(Number(policy.points_per_success)) ? Number(policy.points_per_success) : 0,
              continue_key: policy.continue_key,
              continue_key_label: continueKeyLabel(policy.continue_key),
              total_points: Number.isFinite(Number(state.total_points)) ? Number(state.total_points) : 0,
              rewarded_trials: Number.isFinite(Number(state.rewarded_trials)) ? Number(state.rewarded_trials) : 0,
              eligible_trials: Number.isFinite(Number(state.eligible_trials)) ? Number(state.eligible_trials) : events.length,
              success_streak: Number.isFinite(Number(state.success_streak)) ? Number(state.success_streak) : 0,
              badge_level: (state.badge_level ?? '')
            };

            const summaryScreen = normalizeRewardScreen(
              policy.summary_screen,
              policy.summary_title || 'Rewards Summary',
              policy.summary_template_html || ''
            );

            // If template is still empty, provide a minimal fallback.
            if (!summaryScreen.template_html) {
              summaryScreen.template_html = '<p><b>Total earned</b>: {{total_points}} {{currency_label}}</p>\n<p><b>Rewarded trials</b>: {{rewarded_trials}} / {{eligible_trials}}</p>\n<p>Press {{continue_key_label}} to finish.</p>';
            }

            return renderRewardScreenHtml(summaryScreen, vars, { titleFallback: summaryScreen.title || 'Rewards Summary' });
          } catch (e) {
            return `<div class="psy-wrap"><div class="psy-stage"><div class="psy-text"><h2>Rewards Summary</h2><p>Could not compute rewards.</p></div></div></div>`;
          }
        },
        choices: contChoices,
        on_start: () => {
          try {
            const bag = window[storeKey];
            const policy = bag && bag.policy ? bag.policy : rewardsPolicy;
            const summaryScreen = normalizeRewardScreen(
              policy.summary_screen,
              policy.summary_title || 'Rewards Summary',
              policy.summary_template_html || ''
            );
            if (summaryScreen.audio_url) playRewardAudio(summaryScreen.audio_url);
          } catch {
            // ignore
          }
        },
        data: { plugin_type: 'reward-summary' }
      });
    }

    return { experimentType, timeline };
  }

  function normalizeDataCollection(raw) {
    // RDM builder exports booleans under keys like 'reaction-time'.
    // Some example schemas use nested { reaction_time: { enabled: true } }.
    if (!isObject(raw)) return {};

    // If it already looks like the hyphenated boolean map, keep it.
    if (
      typeof raw['reaction-time'] === 'boolean' ||
      typeof raw['accuracy'] === 'boolean' ||
      typeof raw['correctness'] === 'boolean'
    ) {
      return raw;
    }

    const out = {};
    if (isObject(raw.reaction_time) && typeof raw.reaction_time.enabled === 'boolean') out['reaction-time'] = raw.reaction_time.enabled;
    if (isObject(raw.accuracy) && typeof raw.accuracy.enabled === 'boolean') out['accuracy'] = raw.accuracy.enabled;
    if (isObject(raw.correctness) && typeof raw.correctness.enabled === 'boolean') out['correctness'] = raw.correctness.enabled;
    if (isObject(raw['eye-tracking']) && typeof raw['eye-tracking'].enabled === 'boolean') out['eye-tracking'] = raw['eye-tracking'].enabled;
    if (isObject(raw.eye_tracking) && typeof raw.eye_tracking.enabled === 'boolean') out['eye-tracking'] = raw.eye_tracking.enabled;
    return out;
  }

  function normalizeRdmParams(params) {
    const p = isObject(params) ? { ...params } : {};

    // Allow nested config style: per-trial overrides may provide aperture fields under
    // `aperture_parameters: { ... }`. Flatten any missing keys for convenience.
    if (isObject(p.aperture_parameters)) {
      for (const [k, v] of Object.entries(p.aperture_parameters)) {
        if (p[k] === undefined) p[k] = v;
      }
    }

    // Builder commonly exports aperture parameters as { shape, diameter }.
    if (p.aperture_shape === undefined && p.shape !== undefined) {
      const s = String(p.shape).toLowerCase();
      if (s === 'circle') p.aperture_shape = 'circle';
      else if (s === 'square' || s === 'rectangle') p.aperture_shape = 'square';
      else p.aperture_shape = 'circle';
    }

    // Use diameter as our "aperture_size" (engine interprets circle size as diameter).
    if (p.aperture_size === undefined) {
      if (p.aperture_diameter !== undefined) p.aperture_size = p.aperture_diameter;
      else if (p.diameter !== undefined) p.aperture_size = p.diameter;
    }

    return p;
  }

  function applyResponseDerivedRdmFields(rdm, response) {
    const out = isObject(rdm) ? { ...rdm } : {};
    const resp = isObject(response) ? response : {};

    // Map response-target-group (builder uses group_1/group_2 strings in overrides).
    if (out.response_target_group === undefined && resp.response_target_group !== undefined) {
      const raw = resp.response_target_group;
      if (raw === 'group_1') out.response_target_group = 1;
      else if (raw === 'group_2') out.response_target_group = 2;
      else if (Number.isFinite(Number(raw))) out.response_target_group = Number(raw);
    }

    // Cue border: builder may export as response.cue_border = { enabled, mode, target_group, color, width }.
    if (isObject(resp.cue_border) && resp.cue_border.enabled) {
      const cue = resp.cue_border;
      const width = Number(cue.width ?? cue.border_width ?? 3);

      // The engine currently expects flat fields. We map any enabled cue to a custom border with explicit color.
      out.cue_border_mode = 'custom';
      if (Number.isFinite(width)) out.cue_border_width = width;
      if (typeof cue.color === 'string') out.cue_border_color = cue.color;

      if (out.response_target_group === undefined) {
        if (cue.target_group === 'group_1') out.response_target_group = 1;
        else if (cue.target_group === 'group_2') out.response_target_group = 2;
      }
    }

    return out;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  window.TimelineCompiler = {
    expandTimeline,
    compileToJsPsychTimeline
  };
})();
