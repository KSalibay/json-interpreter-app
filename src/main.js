(function () {
  const els = {
    jatosStatus: document.getElementById('jatosStatus'),
    statusBox: document.getElementById('statusBox'),
    jspsychTarget: document.getElementById('jspsych-target')
  };

  function setStatus(msg) {
    els.statusBox.textContent = msg;
  }

  function detectJatos() {
    const ok = typeof window.jatos !== 'undefined' && window.jatos && typeof window.jatos.onLoad === 'function';
    els.jatosStatus.textContent = ok ? 'JATOS: detected' : 'JATOS: not detected (local mode)';
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

        // Local fallback: dump to console
        console.log('Experiment finished. Data:', jsPsych.data.get().values());
        setStatus('Experiment finished (local mode). Data logged to console.');
      }
    });

    jsPsych.run(compiled.timeline);
  }

  function bootstrap() {
    detectJatos();

    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    if (id) {
      setStatus(`Loading config: ${id} ...`);
      window.ConfigLoader.loadConfigById(id)
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
