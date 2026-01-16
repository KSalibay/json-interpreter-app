var jsPsychRdm = (function (jspsych) {
  const info = {
    name: 'rdm',
    parameters: {
      rdm: { type: jspsych.ParameterType.OBJECT, default: {} },
      response: { type: jspsych.ParameterType.OBJECT, default: {} },
      timing: { type: jspsych.ParameterType.OBJECT, default: {} },
      transition: { type: jspsych.ParameterType.OBJECT, default: { duration_ms: 0, type: 'none' } },
      dataCollection: { type: jspsych.ParameterType.OBJECT, default: {} }
    }
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function merge(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) out[k] = v;
    return out;
  }

  function normalizeChoices(response) {
    if (!response) return [];
    if (response.choices === 'ALL_KEYS') return 'ALL_KEYS';
    if (Array.isArray(response.choices)) return response.choices;
    return [];
  }

  function buildKeyMapping(response) {
    const km = response && typeof response.key_mapping === 'object' ? response.key_mapping : null;
    if (km) return km;

    // Fallback mapping: first two choices
    const choices = Array.isArray(response.choices) ? response.choices : [];
    return {
      [choices[0] || 'f']: 'left',
      [choices[1] || 'j']: 'right'
    };
  }

  function computeMouseSide(x, y, cx, cy, startAngleDeg, segments) {
    const dx = x - cx;
    const dy = y - cy;
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0=right
    const norm = (angle - startAngleDeg + 360) % 360;
    const seg = Math.floor((norm / 360) * segments);

    // For 2 segments, seg 0 = right half, seg 1 = left half.
    if (segments === 2) return seg === 0 ? 'right' : 'left';

    // Generic: treat segments in [0..segments/2) as right-ish
    return seg < segments / 2 ? 'right' : 'left';
  }

  class JsPsychRdmPlugin {
    constructor(jsPsych) {
      this.jsPsych = jsPsych;
    }

    trial(display_element, trial) {
      const rdm = trial.rdm || {};
      const timing = trial.timing || {};
      const response = trial.response || {};
      const transition = trial.transition || { duration_ms: 0, type: 'none' };
      const dataCollection = trial.dataCollection || {};

      const experimentType = rdm.experiment_type || 'trial-based';

      const fixationDuration = Number(timing.fixation_duration ?? rdm.fixation_duration ?? 0);
      const stimulusDuration = Number(timing.stimulus_duration ?? rdm.stimulus_duration ?? 1500);
      const responseDeadline = Number(timing.response_deadline ?? rdm.response_deadline ?? stimulusDuration);

      const requireResponse = response.require_response !== false;
      const responseDevice = response.response_device || 'keyboard';

      // Continuous-only
      const endOnResponse = experimentType === 'continuous' && response.end_condition_on_response === true;

      const choices = normalizeChoices(response);
      const keyMapping = buildKeyMapping(response);

      const canvasW = Number(rdm.canvas_width ?? 600);
      const canvasH = Number(rdm.canvas_height ?? 600);

      display_element.innerHTML = `
        <div id="rdm-wrap" style="width:100%; display:flex; justify-content:center; align-items:center; flex-direction:column; gap:10px;">
          <canvas id="rdm-canvas" width="${canvasW}" height="${canvasH}" style="border: 1px solid rgba(255,255,255,0.15);"></canvas>
          <div id="rdm-feedback" style="min-height: 24px;"></div>
        </div>
      `;

      const canvas = display_element.querySelector('#rdm-canvas');
      const ctx = canvas.getContext('2d');

      // Fixation phase: draw cross on blank bg
      const bg = (typeof rdm.background_color === 'string' && rdm.background_color.trim() !== '') ? rdm.background_color : '#000000';

      const showFixation = () => {
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        ctx.strokeStyle = (typeof rdm.fixation_color === 'string' && rdm.fixation_color.trim() !== '') ? rdm.fixation_color : '#ffffff';
        ctx.lineWidth = Number(rdm.fixation_width ?? 2);
        const size = Number(rdm.fixation_size ?? 10);
        ctx.beginPath();
        ctx.moveTo(cx - size, cy);
        ctx.lineTo(cx + size, cy);
        ctx.moveTo(cx, cy - size);
        ctx.lineTo(cx, cy + size);
        ctx.stroke();
      };

      let engine = null;
      let responded = false;
      let ended = false;
      let responseKey = null;
      let responseSide = null;
      let rt = null;
      let responseTs = null;
      let startTs = null;

      const correctSide = window.RDMEngine.computeCorrectSide(rdm);

      const endTrial = async (reason) => {
        if (ended) return;
        ended = true;
        if (engine) engine.stop();
        cleanupListeners();

        // Transition screen (continuous only)
        if (experimentType === 'continuous') {
          const ms = Number(transition.duration_ms ?? 0);
          if (ms > 0) {
            await showTransition(ms, transition.type || 'both', rdm);
          }
        }

        const includeRt = dataCollection['reaction-time'] === true;
        const includeAccuracy = dataCollection['accuracy'] === true;
        const includeCorrectness = dataCollection['correctness'] === true;

        const isCorrect = (responseSide !== null) ? (responseSide === correctSide) : null;

        const data = {
          experiment_type: experimentType,
          stimulus_type: rdm.type,
          response_device: responseDevice,
          correct_side: correctSide,
          response_side: responseSide,
          response_key: responseKey,
          end_reason: reason || null,
          ...(includeRt ? { rt_ms: rt } : {}),
          ...(includeAccuracy ? { accuracy: isCorrect } : {}),
          ...(includeCorrectness ? { correctness: isCorrect } : {})
        window.jsPsychRdm = JsPsychRdmPlugin;

        // Keep the trial params for analysis/debugging
        data.rdm_parameters = rdm;
        data.response_parameters = response;
        data.timing_parameters = { fixationDuration, stimulusDuration, responseDeadline };
        data.transition = transition;

        this.jsPsych.finishTrial(data);
      };

      const showFeedback = (isCorrect) => {
        const fb = response && response.feedback && response.feedback.enabled ? response.feedback : null;
        if (!fb) return;

        const el = display_element.querySelector('#rdm-feedback');
        if (!el) return;

        const duration = Number(rdm.feedback_duration ?? fb.duration_ms ?? 500);

        if (fb.type === 'corner-text') {
          el.innerHTML = `<div style="width: ${canvasW}px; display:flex; justify-content:space-between;">
            <span style="color:${isCorrect ? '#5CFF8A' : '#FF5C5C'}; font-weight:600;">${isCorrect ? 'Correct' : 'Incorrect'}</span>
            <span style="opacity:0.7">${responseSide || ''}</span>
          </div>`;
        } else if (fb.type === 'arrow') {
          el.innerHTML = `<div style="width: ${canvasW}px; text-align:center; font-size: 20px; color:${isCorrect ? '#5CFF8A' : '#FF5C5C'};">${isCorrect ? '✓' : '✗'}</div>`;
        } else if (fb.type === 'custom') {
          el.innerHTML = `<div style="width: ${canvasW}px; text-align:center; opacity:0.85;">(custom feedback placeholder)</div>`;
        }

        window.setTimeout(() => {
          el.innerHTML = '';
        }, Number.isFinite(duration) ? duration : 500);
      };

      const showTransition = (ms, type, rdmParams) => {
        return new Promise((resolve) => {
          const cx = canvas.width / 2;
          const cy = canvas.height / 2;

          ctx.save();
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          if (type === 'fixation' || type === 'both') {
            ctx.strokeStyle = (typeof rdmParams.fixation_color === 'string' && rdmParams.fixation_color.trim() !== '') ? rdmParams.fixation_color : '#ffffff';
            ctx.lineWidth = Number(rdmParams.fixation_width ?? 2);
            const size = Number(rdmParams.fixation_size ?? 10);
            ctx.beginPath();
            ctx.moveTo(cx - size, cy);
            ctx.lineTo(cx + size, cy);
            ctx.moveTo(cx, cy - size);
            ctx.lineTo(cx, cy + size);
            ctx.stroke();
          }

          // mask/both: just blank bg; already drawn
          ctx.restore();

          this.jsPsych.pluginAPI.setTimeout(resolve, ms);
        });
      };

      const onResponse = (payload) => {
        if (responded) return;
        responded = true;

        responseKey = payload.key || null;
        responseSide = payload.side || null;
        responseTs = nowMs();
        rt = startTs ? Math.round(responseTs - startTs) : null;

        const isCorrect = responseSide !== null ? responseSide === correctSide : null;
        if (isCorrect !== null) showFeedback(isCorrect);

        if (experimentType === 'trial-based') {
          endTrial('response');
          return;
        }

        // continuous
        if (endOnResponse) {
          endTrial('response_end_condition');
        }
      };

      let keyListener = null;
      let mouseListener = null;

      const setupListeners = () => {
        if (responseDevice === 'keyboard') {
          keyListener = (e) => {
            const k = e.key;
            if (choices === 'ALL_KEYS') {
              const side = keyMapping && keyMapping[k] ? keyMapping[k] : null;
              onResponse({ key: k, side });
              return;
            }
            if (Array.isArray(choices) && choices.includes(k)) {
              const side = keyMapping && keyMapping[k] ? keyMapping[k] : null;
              onResponse({ key: k, side });
            }
          };
          window.addEventListener('keydown', keyListener);
        } else if (responseDevice === 'mouse' || responseDevice === 'touch') {
          const mr = response.mouse_response || {};
          const segments = Number(mr.segments ?? 2);
          const startAngle = Number(mr.start_angle_deg ?? 0);

          mouseListener = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const side = computeMouseSide(x, y, canvas.width / 2, canvas.height / 2, startAngle, segments);
            onResponse({ key: null, side });
          };
          canvas.addEventListener('click', mouseListener);
        } else if (responseDevice === 'voice') {
          // Not implemented
        }
      };

      const cleanupListeners = () => {
        if (keyListener) window.removeEventListener('keydown', keyListener);
        if (mouseListener && canvas) canvas.removeEventListener('click', mouseListener);
        keyListener = null;
        mouseListener = null;
      };

      const startStimulus = () => {
        engine = new window.RDMEngine(canvas, merge(rdm, { show_fixation: false }));
        engine.start();
        startTs = nowMs();
        setupListeners();

        // stimulus phase
        if (Number.isFinite(stimulusDuration) && stimulusDuration > 0) {
          this.jsPsych.pluginAPI.setTimeout(() => {
            // Stop stimulus, keep response window (blank bg)
            if (engine) engine.stop();
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }, stimulusDuration);
        }

        // deadline
        if (Number.isFinite(responseDeadline) && responseDeadline > 0) {
          this.jsPsych.pluginAPI.setTimeout(() => {
            if (ended) return;

            // trial-based usually ends earlier on response; if not, treat as deadline/timeout
            if (requireResponse && !responded) {
              endTrial('timeout');
              return;
            }

            endTrial('deadline');
          }, responseDeadline);
        }
      };

      // Start
      if (Number.isFinite(fixationDuration) && fixationDuration > 0) {
        showFixation();
        this.jsPsych.pluginAPI.setTimeout(() => {
          startStimulus();
        }, fixationDuration);
      } else {
        startStimulus();
      }
    }
  }

  JsPsychRdmPlugin.info = info;
  window.jsPsychRdm = JsPsychRdmPlugin;
})(window.jsPsychModule || window.jsPsych);

