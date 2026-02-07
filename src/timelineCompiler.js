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

  function expandBlock(block) {
    const length = Math.max(1, Number.parseInt(block.length ?? 1, 10) || 1);
    const baseType = (typeof block.component_type === 'string' && block.component_type.trim()) ? block.component_type : 'rdm-trial';

    // Clone so we can safely delete block-level-only fields
    const windows = isObject(block.parameter_windows) ? { ...block.parameter_windows } : {};
    const values = isObject(block.parameter_values) ? { ...block.parameter_values } : {};

    const seed = Number.isFinite(block.seed) ? (block.seed >>> 0) : null;
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
        t[k] = s;
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

  function expandTimeline(rawTimeline) {
    const inTl = Array.isArray(rawTimeline) ? rawTimeline : [];
    const out = [];

    for (const item of inTl) {
      if (!isObject(item)) continue;

      if (item.type === 'block') {
        out.push(...expandBlock(item));
        continue;
      }

      out.push(item);
    }

    return out;
  }

  function compileToJsPsychTimeline(config) {
    if (!isObject(config)) throw new Error('Config must be an object');

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

    const baseIti = (() => {
      const tp = isObject(config.timing_parameters) ? config.timing_parameters : {};
      const iti = Number(tp.inter_trial_interval ?? config.default_iti ?? 0);
      return Number.isFinite(iti) ? iti : 0;
    })();

    const expanded = expandTimeline(config.timeline);

    const timeline = [];

    // Continuous mode (RDM only): run the entire expanded sequence inside one plugin trial
    // so we don't re-render the DOM between frames.
    //
    // Other task types (e.g., soc-dashboard prototype) compile as normal trials even if
    // experiment_type is set to "continuous".
    if (experimentType === 'continuous' && taskType === 'rdm') {
      const frames = [];
      for (const item of expanded) {
        const type = item.type;

        if (type === 'html-keyboard-response' || type === 'instructions') {
          // Keep instructions as their own trial.
          timeline.push({
            type: HtmlKeyboard,
            stimulus: item.stimulus || '',
            prompt: (item.prompt === undefined ? null : item.prompt),
            choices: item.choices === 'ALL_KEYS' ? 'ALL_KEYS' : (Array.isArray(item.choices) ? item.choices : 'ALL_KEYS'),
            stimulus_duration: (item.stimulus_duration === undefined ? null : item.stimulus_duration),
            trial_duration: (item.trial_duration === undefined ? null : item.trial_duration),
            response_ends_trial: (item.response_ends_trial === undefined ? true : item.response_ends_trial),
            data: { plugin_type: type }
          });
          continue;
        }

        if (type === 'survey-response') {
          timeline.push({
            type: window.jsPsychSurveyResponse,
            title: item.title || 'Survey',
            instructions: item.instructions || '',
            submit_label: item.submit_label || 'Continue',
            allow_empty_on_timeout: item.allow_empty_on_timeout === true,
            timeout_ms: (item.timeout_ms === null || item.timeout_ms === undefined) ? null : Number(item.timeout_ms),
            questions: Array.isArray(item.questions) ? item.questions : [],
            detection_response_task_enabled: item.detection_response_task_enabled === true,
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

        // Unsupported components in continuous mode: ignore for now.
      }

      const ui = isObject(config) ? config : {};
      const updateInterval = Number(ui.update_interval ?? 100);

      timeline.push({
        type: window.jsPsychRdmContinuous,
        frames,
        update_interval_ms: Number.isFinite(updateInterval) ? updateInterval : 100,
        default_transition: defaultTransition,
        dataCollection,
        data: { plugin_type: 'rdm-continuous' }
      });

      return { experimentType, timeline };
    }

    for (const item of expanded) {
      const type = item.type;

      const socDefaults = (type === 'soc-dashboard' && isObject(config?.soc_dashboard_settings))
        ? config.soc_dashboard_settings
        : null;

        if (type === 'html-keyboard-response' || type === 'instructions') {
        timeline.push({
          type: HtmlKeyboard,
          stimulus: item.stimulus || '',
          prompt: (item.prompt === undefined ? null : item.prompt),
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
          detection_response_task_enabled: item.detection_response_task_enabled === true,
          data: { plugin_type: type }
        });
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

      if (typeof type === 'string' && type.startsWith('rdm-')) {
        const Rdm = requirePlugin('rdm (window.jsPsychRdm)', window.jsPsychRdm);
        const onStart = typeof item.on_start === 'function' ? item.on_start : null;
        const onFinish = typeof item.on_finish === 'function' ? item.on_finish : null;

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

        timeline.push({
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
        });
        continue;
      }

      // Flanker task
      if (type === 'flanker-trial') {
        const Flanker = requirePlugin('flanker (window.jsPsychFlanker)', window.jsPsychFlanker);
        timeline.push({
          ...item,
          type: Flanker,
          post_trial_gap: Number.isFinite(Number(item.iti_ms)) ? Number(item.iti_ms) : 0,
          data: { plugin_type: type, task_type: 'flanker' }
        });
        continue;
      }

      // SART task
      if (type === 'sart-trial') {
        const Sart = requirePlugin('sart (window.jsPsychSart)', window.jsPsychSart);
        timeline.push({
          ...item,
          type: Sart,
          post_trial_gap: Number.isFinite(Number(item.iti_ms)) ? Number(item.iti_ms) : 0,
          data: { plugin_type: type, task_type: 'sart' }
        });
        continue;
      }

      // Gabor task
      if (type === 'gabor-trial') {
        const Gabor = requirePlugin('gabor (window.jsPsychGabor)', window.jsPsychGabor);
        const onStart = typeof item.on_start === 'function' ? item.on_start : null;
        const onFinish = typeof item.on_finish === 'function' ? item.on_finish : null;

        const itemCopy = { ...item };
        delete itemCopy.type;
        delete itemCopy.on_start;
        delete itemCopy.on_finish;

        timeline.push({
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
        });
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
