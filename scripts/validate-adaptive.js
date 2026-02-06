#!/usr/bin/env node

/*
  Headless validation for adaptive blocks + Gabor parameter propagation.

  Usage:
    node scripts/validate-adaptive.js configs/sample_adaptive_gabor_rdm.json

  What it does:
    - Loads the config JSON
    - Loads src/timelineCompiler.js into a VM sandbox (browser-style IIFE)
    - Compiles to a jsPsych timeline (with stub plugin constructors)
    - Simulates running on_start/on_finish for trials with adaptive hooks
      to verify trial-to-trial adaptation actually changes values.
*/

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function formatNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function loadJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

const arg = process.argv[2];
if (!arg) {
  die('Usage: node scripts/validate-adaptive.js <path-to-config.json>');
}

const configPath = path.resolve(process.cwd(), arg);
if (!fs.existsSync(configPath)) {
  die(`Config not found: ${configPath}`);
}

const config = loadJson(configPath);

const compilerPath = path.resolve(__dirname, '..', 'src', 'timelineCompiler.js');
if (!fs.existsSync(compilerPath)) {
  die(`timelineCompiler.js not found: ${compilerPath}`);
}

const compilerCode = fs.readFileSync(compilerPath, 'utf8');

// Browser-ish sandbox
const sandbox = {
  console,
  Math,
  setTimeout,
  clearTimeout,
  window: {
    // Stubs for plugin constructors referenced by compileToJsPsychTimeline.
    jsPsychRdm: function jsPsychRdm() {},
    jsPsychRdmContinuous: function jsPsychRdmContinuous() {},
    jsPsychSurveyResponse: function jsPsychSurveyResponse() {},
    jsPsychFlanker: function jsPsychFlanker() {},
    jsPsychSart: function jsPsychSart() {},
    jsPsychGabor: function jsPsychGabor() {}
  },

  // jsPsych core plugin used for instructions / debug screens
  jsPsychHtmlKeyboardResponse: function jsPsychHtmlKeyboardResponse() {}
};

vm.createContext(sandbox);
vm.runInContext(compilerCode, sandbox, { filename: compilerPath });

if (!sandbox.window.TimelineCompiler) {
  die('TimelineCompiler not found on sandbox.window.');
}

const { compileToJsPsychTimeline } = sandbox.window.TimelineCompiler;

let compiled;
try {
  compiled = compileToJsPsychTimeline(config);
} catch (e) {
  die(`compileToJsPsychTimeline failed: ${e && e.message ? e.message : String(e)}`);
}

const timeline = Array.isArray(compiled.timeline) ? compiled.timeline : [];
console.log(`Compiled: ${timeline.length} trial(s) (${compiled.experimentType})`);

const adaptiveTrials = timeline
  .map((t, idx) => ({ t, idx }))
  .filter(({ t }) => t && typeof t.on_start === 'function' && typeof t.on_finish === 'function');

console.log(`Adaptive trials with hooks: ${adaptiveTrials.length}`);

const rows = [];
for (let i = 0; i < adaptiveTrials.length; i++) {
  const { t, idx } = adaptiveTrials[i];

  // Simulate jsPsych calling on_start with the actual trial object.
  t.on_start(t);

  const forcedCorrect = i % 2 === 0; // alternate correctness to force changes
  const data = { correctness: forcedCorrect };

  t.on_finish(data);

  rows.push({
    index: idx,
    plugin_type: (t && t.data && t.data.plugin_type) ? t.data.plugin_type : 'unknown',
    adaptive_mode: data.adaptive_mode,
    adaptive_parameter: data.adaptive_parameter,
    adaptive_value: data.adaptive_value,
    correctness: data.correctness
  });
}

if (rows.length > 0) {
  console.log('\nAdaptive trace (first 20):');
  for (const r of rows.slice(0, 20)) {
    console.log(
      `${String(r.index).padStart(3, ' ')}  ${String(r.plugin_type).padEnd(12, ' ')}  ` +
      `${String(r.adaptive_mode).padEnd(9, ' ')}  ${String(r.adaptive_parameter).padEnd(18, ' ')}  ` +
      `${formatNum(r.adaptive_value).padStart(10, ' ')}  correct=${r.correctness}`
    );
  }

  const byParam = new Map();
  for (const r of rows) {
    const k = `${r.plugin_type}::${r.adaptive_mode}::${r.adaptive_parameter}`;
    if (!byParam.has(k)) byParam.set(k, []);
    byParam.get(k).push(r.adaptive_value);
  }

  let allOk = true;
  for (const [k, vals] of byParam.entries()) {
    const uniq = new Set(vals.map((v) => formatNum(v))).size;
    if (uniq <= 1) {
      allOk = false;
      console.warn(`WARNING: adaptive values did not change for ${k} (unique=${uniq})`);
    } else {
      console.log(`OK: ${k} changed across trials (unique=${uniq})`);
    }
  }

  if (!allOk) {
    process.exitCode = 2;
  }
} else {
  console.log('No adaptive trials found; nothing to validate.');
}

// Quick check: Gabor parameter propagation from config.gabor_settings
const gaborTrials = timeline.filter((t) => t && t.data && t.data.task_type === 'gabor');
if (gaborTrials.length > 0) {
  const t0 = gaborTrials[0];
  console.log('\nGabor settings on first compiled gabor trial:');
  console.log(`  spatial_frequency_cyc_per_px: ${formatNum(t0.spatial_frequency_cyc_per_px)}`);
  console.log(`  grating_waveform: ${String(t0.grating_waveform)}`);
}
