(function (jspsych) {
  const info = {
    name: 'rdm-continuous',
    parameters: {
      frames: { type: jspsych.ParameterType.OBJECT, array: true, default: [] },
      update_interval_ms: { type: jspsych.ParameterType.INT, default: 100 },
      default_transition: { type: jspsych.ParameterType.OBJECT, default: { duration_ms: 150, type: 'both' } },
      dataCollection: { type: jspsych.ParameterType.OBJECT, default: {} }
    }
  };

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function safeNum(x, fallback) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeTransitionType(raw) {
    const t = (typeof raw === 'string' ? raw.trim().toLowerCase() : '');
    // Builder historically used: both|mask|fixation. We reinterpret these as smooth blending controls.
    if (t === 'none' || t === 'off') return 'none';
    if (t === 'speed') return 'speed';
    if (t === 'color') return 'color';
    if (t === 'mask') return 'speed';
    if (t === 'fixation') return 'color';
    return 'both';
  }

  function computeCorrectSide(rdmParams) {
    return window.RDMEngine.computeCorrectSide(rdmParams);
  }

  function buildKeyMapping(response) {
    const km = response && typeof response.key_mapping === 'object' ? response.key_mapping : null;
    if (km) return km;

    const choices = Array.isArray(response.choices) ? response.choices : [];
    return {
      [choices[0] || 'f']: 'left',
      [choices[1] || 'j']: 'right'
    };
  }

  function normalizeChoices(response) {
    if (!response) return [];
    if (response.choices === 'ALL_KEYS') return 'ALL_KEYS';
    if (Array.isArray(response.choices)) return response.choices;
    return [];
  }

  function expandKeyVariants(key) {
    const k = (key || '').toString();
    if (k.length === 1 && /[a-z]/i.test(k)) {
      return [k.toLowerCase(), k.toUpperCase()];
    }
    return [k];
  }

  class JsPsychRdmContinuousPlugin {
    constructor(jsPsych) {
      this.jsPsych = jsPsych;
    }

    trial(display_element, trial) {
      const frames = Array.isArray(trial.frames) ? trial.frames : [];
      const updateInterval = Math.max(1, safeNum(trial.update_interval_ms, 100));
      const dataCollection = trial.dataCollection || {};

      if (frames.length === 0) {
        display_element.innerHTML = '<div style="padding:24px;">No frames to run.</div>';
        this.jsPsych.finishTrial({ error: 'no_frames' });
        return;
      }

      // First frame determines canvas sizing.
      const first = frames[0] || {};
      const firstRdm = first.rdm || {};
      const canvasW = safeNum(firstRdm.canvas_width, 600);
      const canvasH = safeNum(firstRdm.canvas_height, 600);

      display_element.innerHTML = `
        <div id="rdm-wrap" style="width:100%; display:flex; justify-content:center; align-items:center; flex-direction:column; gap:10px;">
          <canvas id="rdm-canvas" width="${canvasW}" height="${canvasH}" style="border: 1px solid rgba(255,255,255,0.15);"></canvas>
          <div id="rdm-feedback" style="min-height: 24px;"></div>
        </div>
      `;

      const canvas = display_element.querySelector('#rdm-canvas');
      const feedbackEl = display_element.querySelector('#rdm-feedback');

      const engine = new window.RDMEngine(canvas, firstRdm);
      engine.start();

      let frameIndex = 0;
      let segmentStart = nowMs();
      let lastAdvance = segmentStart;

      // Transition interpolation state
      let fromRdm = firstRdm;
      let toRdm = firstRdm;
      let transitionStart = segmentStart;
      let transitionDuration = 0;
      let transitionType = 'none';

      // Response state
      let respondedThisFrame = false;
      let startTs = nowMs();
      let ended = false;

      const trialStartTs = nowMs();

      // Per-frame summary fields (so CSV has one row per frame with these columns)
      let frameResponseSide = null;
      let frameResponseKey = null;
      let frameRtMs = null;
      let frameIsCorrect = null;

      // Detection Response Task (DRT) state (per-frame)
      const drtKey = ' ';
      let drtActive = false;
      let drtShown = false;
      let drtOnsetTs = null;
      let drtRt = null;
      let drtTimeoutId = null;

      const clearDrt = () => {
        drtActive = false;
        drtShown = false;
        drtOnsetTs = null;
        drtRt = null;
        if (drtTimeoutId) {
          window.clearTimeout(drtTimeoutId);
          drtTimeoutId = null;
        }
        const existing = display_element.querySelector('#drt-dot');
        if (existing && existing.parentNode) existing.remove();
      };

      const scheduleDrtForCurrentFrame = () => {
        clearDrt();

        const frame = getFrame(frameIndex);
        const rdm = frame.rdm || {};
        if (rdm.detection_response_task_enabled !== true) return;

        drtActive = true;

        const timing = frame.timing || {};
        const deadline = safeNum(timing.response_deadline, safeNum(timing.stimulus_duration, updateInterval));

        const minDelay = 300;
        const maxDelay = Math.max(minDelay, Math.floor(Math.max(1, deadline) * 0.75));
        const delay = minDelay + Math.floor(Math.random() * Math.max(1, (maxDelay - minDelay)));

        drtTimeoutId = window.setTimeout(() => {
          if (ended || !drtActive) return;

          drtShown = true;
          drtOnsetTs = nowMs();

          const el = document.createElement('div');
          el.id = 'drt-dot';
          el.style.cssText = 'position:absolute; top: 18px; left: 18px; width: 14px; height: 14px; border-radius: 50%; background: #FFD23F; box-shadow: 0 0 0 3px rgba(0,0,0,0.3);';

          const wrap = display_element.querySelector('#rdm-wrap');
          if (wrap) {
            wrap.style.position = 'relative';
            wrap.appendChild(el);
            window.setTimeout(() => {
              if (el && el.parentNode) el.remove();
            }, 200);
          }
        }, delay);
      };

      const records = [];

      const getFrame = (idx) => frames[Math.max(0, Math.min(frames.length - 1, idx))];

      const showFeedback = (frame, isCorrect) => {
        const resp = frame.response || {};
        const fb = resp && resp.feedback && resp.feedback.enabled ? resp.feedback : null;
        if (!fb || !feedbackEl) return;

        const duration = safeNum((frame.rdm || {}).feedback_duration ?? fb.duration_ms, 150);
        const color = isCorrect ? '#5CFF8A' : '#FF5C5C';

        if (fb.type === 'corner-text') {
          feedbackEl.innerHTML = `<div style="width:${canvasW}px; display:flex; justify-content:space-between;">
            <span style="color:${color}; font-weight:600;">${isCorrect ? 'Correct' : 'Incorrect'}</span>
            <span style="opacity:0.7"></span>
          </div>`;
        } else if (fb.type === 'arrow') {
          feedbackEl.innerHTML = `<div style="width:${canvasW}px; text-align:center; font-size: 20px; color:${color};">${isCorrect ? '✓' : '✗'}</div>`;
        } else {
          feedbackEl.innerHTML = `<div style="width:${canvasW}px; text-align:center; opacity:0.85;">(custom feedback placeholder)</div>`;
        }

        window.setTimeout(() => {
          feedbackEl.innerHTML = '';
        }, duration);
      };

      const advanceFrame = (reason) => {
        const frame = getFrame(frameIndex);
        const rdm = frame.rdm || {};
        const response = frame.response || {};

        const correctSide = computeCorrectSide(rdm);

        // Record end-of-frame even if no response
        records.push({
          frame_index: frameIndex,
          event: 'frame_end',
          t_ms: Math.round(nowMs() - trialStartTs),
          ended_reason: reason || 'advance',
          rdm,
          response,
          correct_side: correctSide,
          rt_ms: frameRtMs,
          accuracy: frameIsCorrect,
          correctness: frameIsCorrect,
          response_side: frameResponseSide,
          response_key: frameResponseKey,
          ...(rdm.detection_response_task_enabled ? {
            drt_enabled: true,
            drt_shown: drtShown,
            drt_rt_ms: drtRt
          } : {})
        });

        frameIndex++;
        respondedThisFrame = false;
        startTs = nowMs();

        frameResponseSide = null;
        frameResponseKey = null;
        frameRtMs = null;
        frameIsCorrect = null;

        clearDrt();

        if (frameIndex >= frames.length) {
          finish('completed');
          return;
        }

        // Setup interpolation to next
        const next = getFrame(frameIndex);
        fromRdm = rdm;
        toRdm = next.rdm || {};

        const nextTransition = next.transition || {};
        const defaultTransition = trial.default_transition || { duration_ms: 150, type: 'both' };

        transitionDuration = Math.max(0, safeNum(nextTransition.duration_ms, safeNum(defaultTransition.duration_ms, 150)));
        transitionType = normalizeTransitionType(nextTransition.type ?? defaultTransition.type);
        transitionStart = nowMs();

        // If structural params changed, re-init engine immediately (rare).
        if (typeof engine.needsReinitFor === 'function' && engine.needsReinitFor(fromRdm, toRdm)) {
          engine.updateParams(toRdm);
          // After a structural reinit, treat interpolation as done.
          transitionDuration = 0;
          transitionType = 'none';
          fromRdm = toRdm;
        }

        segmentStart = nowMs();
        lastAdvance = segmentStart;

        scheduleDrtForCurrentFrame();

        // New frame => restart keyboard mapping/choices.
        setKeyboardListenerForCurrentFrame();
      };

      const finish = (reason) => {
        if (ended) return;
        ended = true;
        engine.stop();
        cleanupListeners();

        this.jsPsych.finishTrial({
          experiment_type: 'continuous',
          frames_count: frames.length,
          ended_reason: reason,
          records,
          ...(dataCollection['correctness'] ? { correctness_enabled: true } : {})
        });
      };

      const maybeApplyInterpolation = () => {
        if (transitionDuration <= 0 || transitionType === 'none') {
          // Hard switch at the start of the segment.
          engine.applyDynamicsFromParams(toRdm);
          return;
        }

        const t = Math.max(0, Math.min(1, (nowMs() - transitionStart) / transitionDuration));
        engine.applyInterpolatedDynamics(fromRdm, toRdm, t, transitionType);
      };

      // Run loop: keep presentation continuous; only update parameters.
      const tick = () => {
        if (ended) return;

        maybeApplyInterpolation();

        const frame = getFrame(frameIndex);
        const timing = frame.timing || {};
        const deadline = safeNum(timing.response_deadline, safeNum(timing.stimulus_duration, updateInterval));

        const resp = frame.response || {};
        const endOnResponse = resp.end_condition_on_response === true;

        const elapsed = nowMs() - segmentStart;

        // Auto-advance on deadline (or on end-on-response when response arrives).
        if (elapsed >= deadline) {
          advanceFrame('deadline');
        } else {
          // Maintain update cadence too (helps align with exported update_interval semantics)
          const stepElapsed = nowMs() - lastAdvance;
          if (stepElapsed >= updateInterval) {
            lastAdvance = nowMs();
            // no-op; the visual engine is continuous via RAF
          }
        }

        requestAnimationFrame(tick);
      };

      // Responses
      let keyListenerId = null;
      let mouseListener = null;

      const handleResponse = (side, key) => {
        if (ended) return;

        // DRT capture should not affect the main response.
        if (drtActive && key === drtKey) {
          if (drtShown && drtRt === null && drtOnsetTs) {
            drtRt = Math.round(nowMs() - drtOnsetTs);
          }
          return;
        }

        const frame = getFrame(frameIndex);
        const rdm = frame.rdm || {};
        const response = frame.response || {};

        const correctSide = computeCorrectSide(rdm);
        const isCorrect = side ? side === correctSide : null;

        if (!respondedThisFrame) {
          respondedThisFrame = true;
          const rt = Math.round(nowMs() - startTs);

          frameResponseSide = side;
          frameResponseKey = key || null;
          frameRtMs = rt;
          frameIsCorrect = isCorrect;

          // Attach response to the latest record (or create a response record)
          records.push({
            frame_index: frameIndex,
            event: 'response',
            t_ms: Math.round(nowMs() - trialStartTs),
            response_side: side,
            response_key: key || null,
            rt_ms: rt,
            correct_side: correctSide,
            accuracy: isCorrect,
            correctness: isCorrect
          });

          if (isCorrect !== null) showFeedback(frame, isCorrect);

          // Continuous-only: end condition advances immediately.
          if (response.end_condition_on_response === true) {
            advanceFrame('response_end_condition');
          }
        }
      };

      const setKeyboardListenerForCurrentFrame = () => {
        if (keyListenerId) {
          this.jsPsych.pluginAPI.cancelKeyboardResponse(keyListenerId);
          keyListenerId = null;
        }

        const frame = getFrame(frameIndex);
        const response = frame.response || {};
        const responseDevice = response.response_device || 'keyboard';
        if (responseDevice !== 'keyboard') return;

        const choices = normalizeChoices(response);
        const keyMapping = buildKeyMapping(response);

        const normalizedKeyMapping = (() => {
          const out = {};
          if (keyMapping && typeof keyMapping === 'object') {
            for (const [k, v] of Object.entries(keyMapping)) {
              if (typeof k === 'string') {
                out[k] = v;
                out[k.toLowerCase()] = v;
              }
            }
          }
          return out;
        })();

        const validResponses = (() => {
          if (choices === 'ALL_KEYS') return 'ALL_KEYS';
          const base = Array.isArray(choices)
            ? Array.from(new Set(choices.flatMap(expandKeyVariants)))
            : [];
          return Array.from(new Set(base.concat([drtKey])));
        })();

        keyListenerId = this.jsPsych.pluginAPI.getKeyboardResponse({
          callback_function: (info) => {
            const rawKey = info && info.key !== undefined ? info.key : null;
            const k = (typeof rawKey === 'string') ? rawKey : null;
            const kLower = (typeof k === 'string') ? k.toLowerCase() : null;

            // DRT capture should not affect the main response.
            if (drtActive && k === drtKey) {
              if (drtShown && drtRt === null && drtOnsetTs) {
                drtRt = Math.round(nowMs() - drtOnsetTs);
              }
              return;
            }

            if (choices === 'ALL_KEYS') {
              const side = (k && normalizedKeyMapping && normalizedKeyMapping[k])
                ? normalizedKeyMapping[k]
                : (kLower && normalizedKeyMapping && normalizedKeyMapping[kLower])
                  ? normalizedKeyMapping[kLower]
                  : null;
              const rtOverride = (info && Number.isFinite(info.rt)) ? Math.round(info.rt) : null;
              if (rtOverride !== null) startTs = nowMs() - rtOverride;
              handleResponse(side, kLower || k);
              return;
            }

            if (Array.isArray(choices) && k) {
              const ok = choices.includes(k) || (kLower && choices.includes(kLower));
              if (!ok) return;
              const side = (normalizedKeyMapping && normalizedKeyMapping[k])
                ? normalizedKeyMapping[k]
                : (kLower && normalizedKeyMapping && normalizedKeyMapping[kLower])
                  ? normalizedKeyMapping[kLower]
                  : null;
              const rtOverride = (info && Number.isFinite(info.rt)) ? Math.round(info.rt) : null;
              if (rtOverride !== null) startTs = nowMs() - rtOverride;
              handleResponse(side, kLower || k);
            }
          },
          valid_responses: validResponses,
          rt_method: 'performance',
          persist: true,
          allow_held_key: false
        });
      };

      const setupListeners = () => {
        const frame = getFrame(frameIndex);
        const response = frame.response || {};
        const responseDevice = response.response_device || 'keyboard';

        if (responseDevice === 'keyboard') {
          setKeyboardListenerForCurrentFrame();
          return;
        }

        if (responseDevice === 'mouse' || responseDevice === 'touch') {
          const mr = response.mouse_response || {};
          const segments = Math.max(2, safeNum(mr.segments, 2));
          const startAngle = safeNum(mr.start_angle_deg, 0);

          const computeMouseSide = (x, y) => {
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const dx = x - cx;
            const dy = y - cy;
            const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
            const norm = (angle - startAngle + 360) % 360;
            const seg = Math.floor((norm / 360) * segments);
            if (segments === 2) return seg === 0 ? 'right' : 'left';
            return seg < segments / 2 ? 'right' : 'left';
          };

          mouseListener = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const side = computeMouseSide(x, y);
            handleResponse(side, null);
          };

          canvas.addEventListener('click', mouseListener);
        }
      };

      const cleanupListeners = () => {
        if (keyListenerId) this.jsPsych.pluginAPI.cancelKeyboardResponse(keyListenerId);
        if (mouseListener) canvas.removeEventListener('click', mouseListener);
        keyListenerId = null;
        mouseListener = null;
      };

      // Kick off
      setupListeners();
      // Initialize interpolation state to first frame
      fromRdm = firstRdm;
      toRdm = firstRdm;
      engine.applyDynamicsFromParams(firstRdm);

      scheduleDrtForCurrentFrame();

      // Ensure keyboard listener exists for first frame, and refresh it as frames advance.
      setKeyboardListenerForCurrentFrame();

      requestAnimationFrame(tick);
    }
  }

  JsPsychRdmContinuousPlugin.info = info;
  window.jsPsychRdmContinuous = JsPsychRdmContinuousPlugin;
})(window.jsPsychModule || window.jsPsych);
