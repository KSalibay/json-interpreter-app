(function (jspsych) {
  const info = {
    name: 'gabor',
    parameters: {
      // Task / response
      response_task: { type: jspsych.ParameterType.STRING, default: 'discriminate_tilt' },
      left_key: { type: jspsych.ParameterType.STRING, default: 'f' },
      right_key: { type: jspsych.ParameterType.STRING, default: 'j' },
      yes_key: { type: jspsych.ParameterType.STRING, default: 'f' },
      no_key: { type: jspsych.ParameterType.STRING, default: 'j' },

      // Stimulus definition
      target_location: { type: jspsych.ParameterType.STRING, default: 'left' }, // left|right|none
      target_tilt_deg: { type: jspsych.ParameterType.FLOAT, default: 45 },
      distractor_orientation_deg: { type: jspsych.ParameterType.FLOAT, default: 0 },
      spatial_cue: { type: jspsych.ParameterType.STRING, default: 'none' }, // none|left|right|both
      left_value: { type: jspsych.ParameterType.STRING, default: 'neutral' }, // neutral|high|low
      right_value: { type: jspsych.ParameterType.STRING, default: 'neutral' }, // neutral|high|low

      // Timings (defaults usually come from config.gabor_settings)
      fixation_ms: { type: jspsych.ParameterType.INT, default: 1000 },
      placeholders_ms: { type: jspsych.ParameterType.INT, default: 400 },
      cue_ms: { type: jspsych.ParameterType.INT, default: 300 },
      cue_delay_min_ms: { type: jspsych.ParameterType.INT, default: 100 },
      cue_delay_max_ms: { type: jspsych.ParameterType.INT, default: 200 },
      stimulus_duration_ms: { type: jspsych.ParameterType.INT, default: 67 },
      mask_duration_ms: { type: jspsych.ParameterType.INT, default: 67 },
      response_window_ms: { type: jspsych.ParameterType.INT, default: 1500 },

      // Value cue colors
      high_value_color: { type: jspsych.ParameterType.STRING, default: '#00aa00' },
      low_value_color: { type: jspsych.ParameterType.STRING, default: '#0066ff' },
      neutral_value_color: { type: jspsych.ParameterType.STRING, default: '#666666' },

      detection_response_task_enabled: { type: jspsych.ParameterType.BOOL, default: false }
    }
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
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

  function expandKeyVariants(key) {
    const k = (key || '').toString();
    if (k.length === 1 && /[a-z]/i.test(k)) {
      return [k.toLowerCase(), k.toUpperCase()];
    }
    return [k];
  }

  function clamp(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function valueToFrameColor(value, highColor, lowColor, neutralColor) {
    if (value === 'high') return highColor;
    if (value === 'low') return lowColor;
    return neutralColor;
  }

  function drawRoundedRectStroke(ctx, x, y, width, height, radius, strokeStyle, lineWidth) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawFixation(ctx, x, y) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - 10, y);
    ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y + 10);
    ctx.stroke();
    ctx.restore();
  }

  function drawCueArrow(ctx, x, y, spatialCue) {
    const cueText = (spatialCue === 'left') ? '←'
      : (spatialCue === 'right') ? '→'
      : (spatialCue === 'both') ? '↔'
      : '';

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (cueText) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = '48px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
      ctx.fillText(cueText, x, y);
    }
    ctx.restore();
  }

  function makeGaborImageData(ctx, sizePx, orientationDeg, { freq = 0.06, sigmaFrac = 6, contrast = 0.95, phase = 0 } = {}) {
    const w = Math.max(8, Math.floor(sizePx));
    const h = w;
    const r = Math.floor(w / 2);
    const theta = (Number.isFinite(orientationDeg) ? orientationDeg : 0) * Math.PI / 180;

    const sigma = w / sigmaFrac;
    const img = ctx.createImageData(w, h);
    const data = img.data;

    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const twoSigma2 = 2 * sigma * sigma;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - r;
        const dy = y - r;
        const rr = dx * dx + dy * dy;
        const idx = (y * w + x) * 4;

        if (rr > r * r) {
          data[idx + 0] = 0;
          data[idx + 1] = 0;
          data[idx + 2] = 0;
          data[idx + 3] = 0;
          continue;
        }

        const xRot = dx * cosT + dy * sinT;
        const envelope = Math.exp(-(rr) / twoSigma2);
        const grating = Math.cos(2 * Math.PI * freq * xRot + phase);
        const val = 127.5 + 127.5 * contrast * envelope * grating;
        const v = Math.max(0, Math.min(255, Math.round(val)));

        data[idx + 0] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }

    return { img, r };
  }

  function drawGaborPatch(ctx, centerX, centerY, sizePx, orientationDeg) {
    const { img, r } = makeGaborImageData(ctx, sizePx, orientationDeg);
    ctx.putImageData(img, Math.round(centerX - r), Math.round(centerY - r));

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, r - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawNoiseMask(ctx, centerX, centerY, sizePx) {
    const w = Math.max(8, Math.floor(sizePx));
    const h = w;
    const r = Math.floor(w / 2);

    const img = ctx.createImageData(w, h);
    const data = img.data;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - r;
        const dy = y - r;
        const rr = dx * dx + dy * dy;
        const idx = (y * w + x) * 4;

        if (rr > r * r) {
          data[idx + 3] = 0;
          continue;
        }

        const v = Math.floor(Math.random() * 255);
        data[idx + 0] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(img, Math.round(centerX - r), Math.round(centerY - r));

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY, r - 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function renderGaborScene(canvas, {
    phase,
    spatialCue,
    leftFrameColor,
    rightFrameColor,
    leftAngle,
    rightAngle,
    showCue,
    showStimulus,
    showMask
  }) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0b0b0b';
    ctx.fillRect(0, 0, w, h);

    // Layout similar to builder preview
    const pad = 24;
    const patchSize = Math.min(240, Math.floor((w - pad * 2) / 3));
    const frameSize = patchSize + 48;
    const cy = Math.floor(h * 0.60);
    const leftCx = Math.floor(w * 0.32);
    const rightCx = Math.floor(w * 0.68);

    // Frames + placeholder circles
    drawRoundedRectStroke(ctx, leftCx - frameSize / 2, cy - frameSize / 2, frameSize, frameSize, 18, leftFrameColor, 7);
    drawRoundedRectStroke(ctx, rightCx - frameSize / 2, cy - frameSize / 2, frameSize, frameSize, 18, rightFrameColor, 7);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(leftCx, cy, Math.floor(patchSize / 2) - 2, 0, Math.PI * 2);
    ctx.arc(rightCx, cy, Math.floor(patchSize / 2) - 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Cue
    if (showCue) {
      drawCueArrow(ctx, Math.floor(w / 2), Math.floor(h * 0.18), spatialCue);
    }

    // Stimulus / mask
    if (showStimulus) {
      drawGaborPatch(ctx, leftCx, cy, patchSize, leftAngle);
      drawGaborPatch(ctx, rightCx, cy, patchSize, rightAngle);
    } else if (showMask) {
      drawNoiseMask(ctx, leftCx, cy, patchSize);
      drawNoiseMask(ctx, rightCx, cy, patchSize);
    }

    // Fixation is shown in all phases
    drawFixation(ctx, Math.floor(w / 2), cy);

    // Optional subtle label for debugging stages (off by default; can be enabled by CSS later)
    if (phase) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
      ctx.textAlign = 'left';
      ctx.fillText(String(phase), 10, h - 10);
      ctx.restore();
    }
  }

  class JsPsychGaborPlugin {
    constructor(jsPsych) {
      this.jsPsych = jsPsych;
    }

    trial(display_element, trial) {
      const responseTask = (trial.response_task || 'discriminate_tilt').toString();
      const leftKey = normalizeKeyName(trial.left_key || 'f');
      const rightKey = normalizeKeyName(trial.right_key || 'j');
      const yesKey = normalizeKeyName(trial.yes_key || 'f');
      const noKey = normalizeKeyName(trial.no_key || 'j');

      const targetLocation = (trial.target_location ?? 'left').toString();
      const targetTilt = Number(trial.target_tilt_deg);
      const distractorOrientation = Number(trial.distractor_orientation_deg);
      const spatialCue = (trial.spatial_cue ?? 'none').toString();
      const leftValue = (trial.left_value ?? 'neutral').toString();
      const rightValue = (trial.right_value ?? 'neutral').toString();

      const fixationMs = Math.max(0, Number(trial.fixation_ms ?? 1000) || 0);
      const placeholdersMs = Math.max(0, Number(trial.placeholders_ms ?? 400) || 0);
      const cueMs = Math.max(0, Number(trial.cue_ms ?? 300) || 0);
      const cueDelayMin = Math.max(0, Number(trial.cue_delay_min_ms ?? 100) || 0);
      const cueDelayMax = Math.max(0, Number(trial.cue_delay_max_ms ?? 200) || 0);
      const stimMs = Math.max(0, Number(trial.stimulus_duration_ms ?? 67) || 0);
      const maskMs = Math.max(0, Number(trial.mask_duration_ms ?? 67) || 0);
      const responseWindowMs = Math.max(0, Number(trial.response_window_ms ?? 1500) || 0);

      const highColor = (trial.high_value_color ?? '#00aa00').toString();
      const lowColor = (trial.low_value_color ?? '#0066ff').toString();
      const neutralColor = (trial.neutral_value_color ?? '#666666').toString();

      const leftFrameColor = valueToFrameColor(leftValue, highColor, lowColor, neutralColor);
      const rightFrameColor = valueToFrameColor(rightValue, highColor, lowColor, neutralColor);

      // Determine which angle goes on which side
      const leftAngle = (targetLocation === 'left') ? targetTilt : distractorOrientation;
      const rightAngle = (targetLocation === 'right') ? targetTilt : distractorOrientation;

      // Target-present inference (for detect_target). Allows future catch trials via JSON edit.
      const explicitPresent = (typeof trial.target_present === 'boolean') ? trial.target_present : null;
      const inferredPresent = (targetLocation === 'left' || targetLocation === 'right') && Number.isFinite(targetTilt);
      const targetPresent = (explicitPresent === null) ? inferredPresent : explicitPresent;

      const cueDelay = (() => {
        if (!Number.isFinite(cueDelayMin) || !Number.isFinite(cueDelayMax)) return 0;
        const lo = Math.min(cueDelayMin, cueDelayMax);
        const hi = Math.max(cueDelayMin, cueDelayMax);
        if (hi <= lo) return lo;
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      })();

      const drtEnabled = trial.detection_response_task_enabled === true;
      const drtKey = ' ';
      let drtShown = false;
      let drtOnsetTs = null;
      let drtRt = null;

      let responded = false;
      let responseKey = null;
      let rt = null;

      let stimulusOnsetTs = null;
      let responseListenerStarted = false;

      const timeouts = [];
      const safeSetTimeout = (fn, ms) => {
        const id = this.jsPsych.pluginAPI.setTimeout(fn, ms);
        timeouts.push(id);
        return id;
      };

      const endTrial = (reason) => {
        this.jsPsych.pluginAPI.cancelAllKeyboardResponses();

        // Best effort: clear pending timeouts
        if (typeof this.jsPsych.pluginAPI.clearAllTimeouts === 'function') {
          this.jsPsych.pluginAPI.clearAllTimeouts();
        } else {
          for (const id of timeouts) {
            try { clearTimeout(id); } catch { /* ignore */ }
          }
        }

        const correctness = (() => {
          if (!responded) return null;

          if (responseTask === 'detect_target') {
            const correctKey = targetPresent ? yesKey : noKey;
            return responseKey === correctKey;
          }

          // discriminate_tilt: map tilt sign to left/right key
          if (!Number.isFinite(targetTilt) || targetTilt === 0) return null;
          const correctKey = (targetTilt < 0) ? leftKey : rightKey;
          return responseKey === correctKey;
        })();

        const correctKeyOut = (() => {
          if (responseTask === 'detect_target') {
            return targetPresent ? yesKey : noKey;
          }
          if (!Number.isFinite(targetTilt) || targetTilt === 0) return null;
          return (targetTilt < 0) ? leftKey : rightKey;
        })();

        this.jsPsych.finishTrial({
          plugin_type: 'gabor-trial',
          end_reason: reason || (responded ? 'response' : 'deadline'),

          response_task: responseTask,
          target_location: targetLocation,
          target_present: targetPresent,
          target_tilt_deg: Number.isFinite(targetTilt) ? targetTilt : null,
          distractor_orientation_deg: Number.isFinite(distractorOrientation) ? distractorOrientation : null,
          spatial_cue: spatialCue,
          left_value: leftValue,
          right_value: rightValue,

          cue_delay_ms: cueDelay,

          response_key: responseKey,
          correct_key: correctKeyOut,
          rt_ms: rt,
          correct: correctness,
          accuracy: correctness,
          correctness,

          ...(drtEnabled ? { drt_enabled: true, drt_shown: drtShown, drt_rt_ms: drtRt } : {})
        });
      };

      // DOM
      display_element.innerHTML = `
        <div id="gabor-wrap" style="position:relative; width:100%; display:flex; flex-direction:column; align-items:center; justify-content:center;">
          <canvas id="gabor-canvas" width="900" height="450" style="width:min(1000px, 96vw); height:auto; display:block; background:#0b0b0b; border-radius: 10px;"></canvas>
        </div>
      `;

      const wrapEl = display_element.querySelector('#gabor-wrap');
      const canvas = display_element.querySelector('#gabor-canvas');

      const render = (phase, opts) => {
        if (!canvas) return;
        renderGaborScene(canvas, {
          phase,
          spatialCue,
          leftFrameColor,
          rightFrameColor,
          leftAngle,
          rightAngle,
          showCue: !!opts?.showCue,
          showStimulus: !!opts?.showStimulus,
          showMask: !!opts?.showMask
        });
      };

      // Keyboard response handler (starts at stimulus onset)
      const startResponseListener = () => {
        if (responseListenerStarted) return;
        responseListenerStarted = true;

        const validKeys = (() => {
          if (responseTask === 'detect_target') {
            return Array.from(new Set([...expandKeyVariants(yesKey), ...expandKeyVariants(noKey)]));
          }
          return Array.from(new Set([...expandKeyVariants(leftKey), ...expandKeyVariants(rightKey)]));
        })();

        this.jsPsych.pluginAPI.getKeyboardResponse({
          callback_function: (info) => {
            const rawKey = info && info.key !== undefined ? info.key : null;
            const k = normalizeKeyName(rawKey);

            // DRT capture should not count as a primary response.
            if (drtEnabled && k === drtKey) {
              if (drtShown && drtRt === null && drtOnsetTs) {
                drtRt = Math.round(nowMs() - drtOnsetTs);
              }
              return;
            }

            if (responded) return;
            responded = true;
            responseKey = k;
            rt = stimulusOnsetTs ? Math.round(nowMs() - stimulusOnsetTs) : (Number.isFinite(info && info.rt) ? Math.round(info.rt) : null);
            endTrial('response');
          },
          valid_responses: validKeys.concat(drtEnabled ? [drtKey] : []),
          rt_method: 'performance',
          persist: true,
          allow_held_key: false
        });
      };

      // Phase schedule
      render('fixation', { showCue: false, showStimulus: false, showMask: false });

      // DRT schedule (during the post-stimulus response window by default)
      if (drtEnabled) {
        // Schedule after cue onset so it doesn't always overlap fixation.
        const totalPreStim = fixationMs + placeholdersMs + cueMs + cueDelay;
        const minDelay = totalPreStim + 150;
        const maxDelay = totalPreStim + Math.max(150, Math.floor((stimMs + maskMs + responseWindowMs) * 0.75));
        const delay = minDelay + Math.floor(Math.random() * Math.max(1, (maxDelay - minDelay)));

        safeSetTimeout(() => {
          drtShown = true;
          drtOnsetTs = nowMs();

          const el = document.createElement('div');
          el.id = 'drt-dot';
          el.style.cssText = 'position:absolute; top: 18px; left: 18px; width: 14px; height: 14px; border-radius: 50%; background: #FFD23F; box-shadow: 0 0 0 3px rgba(0,0,0,0.3);';

          if (wrapEl) {
            wrapEl.appendChild(el);
            window.setTimeout(() => {
              if (el && el.parentNode) el.remove();
            }, 200);
          }
        }, delay);
      }

      // Placeholders
      safeSetTimeout(() => {
        render('placeholders', { showCue: false, showStimulus: false, showMask: false });
      }, fixationMs);

      // Cue
      safeSetTimeout(() => {
        render('cue', { showCue: true, showStimulus: false, showMask: false });
      }, fixationMs + placeholdersMs);

      // Cue delay (cue off)
      safeSetTimeout(() => {
        render('cue-delay', { showCue: false, showStimulus: false, showMask: false });
      }, fixationMs + placeholdersMs + cueMs);

      // Stimulus
      safeSetTimeout(() => {
        stimulusOnsetTs = nowMs();
        render('stimulus', { showCue: false, showStimulus: true, showMask: false });
        startResponseListener();
      }, fixationMs + placeholdersMs + cueMs + cueDelay);

      // Mask
      safeSetTimeout(() => {
        render('mask', { showCue: false, showStimulus: false, showMask: true });
      }, fixationMs + placeholdersMs + cueMs + cueDelay + stimMs);

      // Post-mask response window (blank placeholders)
      safeSetTimeout(() => {
        render('response', { showCue: false, showStimulus: false, showMask: false });
      }, fixationMs + placeholdersMs + cueMs + cueDelay + stimMs + maskMs);

      // Deadline
      const deadlineMs = fixationMs + placeholdersMs + cueMs + cueDelay + stimMs + maskMs + responseWindowMs;
      if (deadlineMs > 0) {
        safeSetTimeout(() => {
          endTrial('deadline');
        }, deadlineMs);
      }
    }
  }

  JsPsychGaborPlugin.info = info;
  window.jsPsychGabor = JsPsychGaborPlugin;
})(window.jsPsychModule || window.jsPsych);
