// Browser glue: form, camera capture, rendering, local history.
import { analyzePpg, median } from './dsp.js';
import { estimateVascularAge, validateInputs } from './model.js';
import { describeDiagnostics, formatReport } from './diagnostics.js';

const SETTLE_SECONDS = 8; // lets auto-exposure stabilise before recording
const RECORD_SECONDS = 60;
const SAMPLE_SIZE = 24; // px, frames are averaged over a tiny canvas
const FINGER_MIN_RED = 60;
const FINGER_RED_TO_GREEN = 1.5;
const FINGER_LOST_SECONDS = 0.3; // longer gaps would be interpolated into fake beats
const SATURATION_LEVEL = 250;
const PLOT_SECONDS = 5;
const HISTORY_KEY = 'rigidesa.history';
const PROFILE_KEY = 'rigidesa.profile';
const HISTORY_LIMIT = 100;
const HISTORY_SHOWN = 8;
const MEDIAN_WINDOW = 3;

const $ = (id) => document.getElementById(id);
const steps = { form: $('step-form'), measure: $('step-measure'), result: $('step-result') };
const FIELDS = {
  age: $('age'), heightCm: $('height'), systolic: $('systolic'), diastolic: $('diastolic'),
  restingHr: $('resting-hr'), rmssd: $('rmssd'),
};
const FRAGMENT_KEYS = { age: 'age', h: 'heightCm', sys: 'systolic', dia: 'diastolic', hr: 'restingHr', rmssd: 'rmssd' };

let capture = null; // active camera session, or null
let wakeLock = null; // screen wake lock held while measuring, or null
let lastReport = null; // copyable diagnostic text of the latest measurement

function showStep(name) {
  for (const [key, element] of Object.entries(steps)) element.hidden = key !== name;
  window.scrollTo(0, 0);
}

// ---------- storage (best effort: private mode may throw) ----------

function loadJson(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the app still works, only without history.
  }
}

// ---------- form ----------

function readNumber(input) {
  const text = input.value.trim();
  return text === '' ? null : Number(text);
}

function readForm() {
  return Object.fromEntries(Object.entries(FIELDS).map(([key, input]) => [key, readNumber(input)]));
}

function fillForm(values) {
  for (const [key, value] of Object.entries(values)) {
    if (FIELDS[key] && Number.isFinite(value)) FIELDS[key].value = String(value);
  }
}

/** Watch data arrives in the URL fragment, which is never sent to a server. */
function readFragment() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const values = {};
  for (const [param, key] of Object.entries(FRAGMENT_KEYS)) {
    const number = Number(params.get(param));
    if (params.has(param) && Number.isFinite(number) && number > 0) values[key] = Math.round(number);
  }
  return values;
}

function validatedForm() {
  const input = readForm();
  const errors = validateInputs(input);
  const errorBox = $('form-error');
  errorBox.hidden = errors.length === 0;
  errorBox.textContent = errors.join(' ');
  if (errors.length > 0) return null;
  saveJson(PROFILE_KEY, {
    age: input.age, heightCm: input.heightCm, systolic: input.systolic, diastolic: input.diastolic,
  });
  return input;
}

// ---------- camera capture ----------

function stopStream(stream) {
  if (stream) stream.getTracks().forEach((track) => track.stop());
}

/**
 * Keeps the screen on so the phone does not lock mid-measurement.
 * Best effort: unsupported browsers (or a denied request) just measure
 * without it. The browser drops the lock itself if the page is hidden,
 * which already aborts the measurement (see visibilitychange).
 */
async function acquireWakeLock() {
  if (wakeLock || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function stopCapture() {
  releaseWakeLock();
  if (!capture) return;
  capture.active = false;
  stopStream(capture.stream); // null while the permission prompt is still open
  $('video').srcObject = null;
  capture = null;
}

/**
 * Frame timestamp in seconds. mediaTime is the frame's own presentation
 * timestamp (far less jitter than the callback time, which matters for
 * sub-frame beat alignment), but some browsers do not advance it for live
 * camera streams: then switch for good to the callback clock and restart.
 */
function frameTime(session, now, metadata) {
  const mediaTime = metadata ? metadata.mediaTime : NaN;
  if (!session.useCallbackClock && Number.isFinite(mediaTime) && mediaTime > session.lastMediaTime) {
    session.lastMediaTime = mediaTime;
    return mediaTime;
  }
  if (!session.useCallbackClock) {
    session.useCallbackClock = true;
    session.samples = [];
    session.fingerSince = null;
    session.lostSince = null;
    session.lastTime = -Infinity;
  }
  return now / 1000;
}

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Aquest navegador no permet usar la càmera (cal HTTPS).');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 60 },
    },
  });
  const track = stream.getVideoTracks()[0];
  let torch = false;
  try {
    await track.applyConstraints({ advanced: [{ torch: true }] });
    torch = true;
  } catch {
    // No torch control (e.g. iOS Safari): the user needs strong ambient light.
  }
  return { stream, torch };
}

function frameColour(context, video) {
  context.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
  let red = 0, green = 0;
  for (let i = 0; i < data.length; i += 4) { red += data[i]; green += data[i + 1]; }
  const pixels = data.length / 4;
  return { red: red / pixels, green: green / pixels };
}

function drawWave(samples) {
  const canvas = $('wave');
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (samples.length < 3) return;
  const latest = samples[samples.length - 1].t;
  const recent = samples.filter((s) => s.t >= latest - PLOT_SECONDS);
  const values = recent.map((s) => -s.red);
  const low = Math.min(...values), high = Math.max(...values);
  if (high <= low) return;
  context.strokeStyle = '#ff5d5d';
  context.lineWidth = 3;
  context.beginPath();
  recent.forEach((sample, i) => {
    const x = ((sample.t - (latest - PLOT_SECONDS)) / PLOT_SECONDS) * canvas.width;
    const y = canvas.height - 10 - ((values[i] - low) / (high - low)) * (canvas.height - 20);
    if (i === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

/** Advances the capture state for one frame; returns true when recording is complete. */
function handleFrame(session, time, colour) {
  if (time <= session.lastTime) return false;
  session.lastTime = time;
  const fingerOn = colour.red > FINGER_MIN_RED && colour.red > FINGER_RED_TO_GREEN * colour.green;
  const status = $('measure-status');
  if (!fingerOn) {
    if (session.lostSince === null) session.lostSince = time;
    if (time - session.lostSince > FINGER_LOST_SECONDS) {
      session.samples = [];
      session.fingerSince = null;
      session.fingerResets += 1;
      $('measure-progress').value = 0;
      status.textContent = session.torch
        ? 'Tapa la càmera i el flaix amb el dit.'
        : 'Tapa la càmera amb el dit i acosta\'l a una llum forta (sense flaix).';
    }
    return false;
  }
  session.lostSince = null;
  if (session.fingerSince === null) session.fingerSince = time;
  const elapsed = time - session.fingerSince;
  if (elapsed < SETTLE_SECONDS) {
    status.textContent = `Dit detectat. Estabilitzant… ${Math.ceil(SETTLE_SECONDS - elapsed)} s`;
    return false;
  }
  session.samples.push({ t: time, red: colour.red, green: colour.green });
  const recorded = elapsed - SETTLE_SECONDS;
  $('measure-progress').value = Math.min(1, recorded / RECORD_SECONDS);
  status.textContent = `Mesurant… ${Math.max(0, Math.ceil(RECORD_SECONDS - recorded))} s. No et moguis.`;
  drawWave(session.samples);
  return recorded >= RECORD_SECONDS;
}

function runFrameLoop(session, video, onComplete) {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const useVideoFrames = 'requestVideoFrameCallback' in video;
  const schedule = () => (useVideoFrames
    ? video.requestVideoFrameCallback(onFrame)
    : requestAnimationFrame(onFrame));
  function onFrame(now, metadata) {
    if (!session.active) return;
    const time = frameTime(session, now, metadata);
    if (handleFrame(session, time, frameColour(context, video))) {
      onComplete(session.samples);
      return;
    }
    schedule();
  }
  schedule();
}

async function startMeasurement(input) {
  if (capture) return;
  showStep('measure');
  $('diagnostics').hidden = true; // belongs to the previous measurement
  $('measure-progress').value = 0;
  $('measure-status').textContent = 'Preparant la càmera…';
  // Registered before the first await so Cancel can reach it at any moment.
  const session = {
    stream: null, torch: false, active: true, samples: [], lastTime: -Infinity,
    fingerSince: null, lostSince: null, lastMediaTime: -Infinity, useCallbackClock: false,
    fingerResets: 0,
  };
  capture = session;
  try {
    await acquireWakeLock();
    if (!session.active) { releaseWakeLock(); return; } // cancelled meanwhile
    const { stream, torch } = await openCamera();
    if (!session.active) { stopStream(stream); return; } // cancelled during the prompt
    session.stream = stream;
    session.torch = torch;
    const video = $('video');
    video.srcObject = stream;
    await video.play();
    if (!session.active) return;
    runFrameLoop(session, video, (samples) => {
      // Read before stopCapture() releases the wake lock.
      const setup = { torch: session.torch, wakeLock: wakeLock !== null, fingerResets: session.fingerResets };
      stopCapture();
      finishMeasurement(input, samples, setup);
    });
  } catch (error) {
    const cancelled = !session.active;
    stopStream(session.stream);
    if (capture === session) stopCapture();
    if (cancelled) return;
    showStep('form');
    const errorBox = $('form-error');
    errorBox.hidden = false;
    errorBox.textContent = error instanceof Error && error.name === 'NotAllowedError'
      ? 'Cal donar permís a la càmera per mesurar el pols.'
      : `No s'ha pogut obrir la càmera: ${error instanceof Error ? error.message : 'error desconegut'}`;
  }
}

// ---------- diagnostic panel ----------

const STATUS_MARK = { ok: '✓', warn: '!', bad: '✗' };
const PULSE_MARK_COLOURS = { systolic: '#ff5d5d', notch: '#f5b942', diastolic: '#3ecf8e' };

function drawPulse(template, marks) {
  const canvas = $('diag-pulse');
  const visible = Array.isArray(template) && template.length > 2;
  canvas.hidden = !visible;
  $('diag-pulse-note').hidden = !visible;
  if (!visible) return;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  const low = Math.min(...template), high = Math.max(...template);
  if (high <= low) return;
  const xOf = (index) => (index / (template.length - 1)) * canvas.width;
  context.lineWidth = 2;
  for (const [name, colour] of Object.entries(PULSE_MARK_COLOURS)) {
    if (!marks || !Number.isFinite(marks[name])) continue;
    context.strokeStyle = colour;
    context.beginPath();
    context.moveTo(xOf(marks[name]), 0);
    context.lineTo(xOf(marks[name]), canvas.height);
    context.stroke();
  }
  context.strokeStyle = '#eef3f7';
  context.lineWidth = 3;
  context.beginPath();
  template.forEach((value, index) => {
    const y = canvas.height - 10 - ((value - low) / (high - low)) * (canvas.height - 20);
    if (index === 0) context.moveTo(xOf(index), y); else context.lineTo(xOf(index), y);
  });
  context.stroke();
}

function diagnosticRow({ label, value, status }) {
  const item = document.createElement('li');
  const name = document.createElement('span');
  const detail = document.createElement('span');
  name.textContent = `${STATUS_MARK[status]} ${label}`;
  detail.textContent = value;
  detail.className = status;
  item.append(name, detail);
  return item;
}

function showDiagnostics(ppg, setup) {
  const rows = describeDiagnostics(ppg.diagnostics, setup);
  $('diag-rows').replaceChildren(...rows.map(diagnosticRow));
  const problems = rows.filter((row) => row.status !== 'ok').length;
  $('diag-summary').textContent = problems === 0
    ? 'Cap problema detectat. Els llindars són orientatius, no validats.'
    : `${problems} punt(s) a revisar. Els llindars són orientatius, no validats.`;
  drawPulse(ppg.template, ppg.diagnostics ? ppg.diagnostics.marks : null);
  lastReport = formatReport(ppg.diagnostics, setup, ppg.template);
  const panel = $('diagnostics');
  panel.hidden = false;
  panel.open = rows.some((row) => row.status === 'bad');
}

async function copyDiagnostics() {
  if (!lastReport) return;
  const button = $('copy-diagnostics');
  try {
    await navigator.clipboard.writeText(lastReport);
    button.textContent = 'Copiat ✓';
  } catch {
    button.textContent = 'No s\'ha pogut copiar';
  }
  setTimeout(() => { button.textContent = 'Copia el diagnòstic'; }, 2000);
}

function finishMeasurement(input, samples, setup) {
  const times = samples.map((s) => s.t);
  const redSaturated = median(samples.map((s) => s.red)) >= SATURATION_LEVEL;
  const channel = samples.map((s) => (redSaturated ? s.green : s.red));
  const ppg = analyzePpg(times, channel);
  showDiagnostics(ppg, { ...setup, channel: redSaturated ? 'verd' : 'vermell', redSaturated });
  if (!ppg.ok) {
    showStep('form');
    const errorBox = $('form-error');
    errorBox.hidden = false;
    errorBox.textContent = ppg.reason;
    return;
  }
  showResult(input, ppg);
}

// ---------- result ----------

function addMetric(container, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  wrapper.append(term, detail);
  container.append(wrapper);
}

function ppgNote(ppg) {
  if (!ppg) return 'Sense mesura de càmera: resultat basat només en pressió, FC i edat.';
  const fps = `${Math.round(ppg.frameRate)} fps, ${ppg.beatsUsed}/${ppg.beatsDetected} batecs vàlids`;
  if (ppg.quality < 0.3) return `Senyal de càmera de baixa qualitat (${fps}): no s'ha fet servir. Repeteix la mesura.`;
  if (!ppg.features) {
    return `Pols net (${fps}) però sense ona diastòlica separable; passa en artèries rígides o amb el dit fred. `
      + 'La morfologia no s\'ha fet servir.';
  }
  return `Morfologia del pols usada (${fps}).`;
}

function showResult(input, ppg) {
  const result = estimateVascularAge({ ...input, ppg });
  $('result-age').textContent = String(Math.round(result.vascularAge));
  const diff = Math.round(result.ageDifference);
  const pill = $('result-diff');
  pill.textContent = diff === 0 ? 'igual que l\'edat cronològica'
    : `${Math.abs(diff)} anys ${diff > 0 ? 'més' : 'menys'} que l'edat cronològica`;
  pill.className = `pill ${diff > 2 ? 'bad' : diff < -2 ? 'good' : ''}`;

  const metrics = $('result-metrics');
  metrics.replaceChildren();
  addMetric(metrics, 'Marge d\'error', `± ${Math.round(result.uncertaintyYears)} anys`);
  addMetric(metrics, 'Confiança', result.confidence);
  addMetric(metrics, 'VOP equivalent', `${result.pwv.toFixed(1)} m/s`);
  addMetric(metrics, 'VOP esperada per edat', `${result.expectedPwv.toFixed(1)} m/s`);
  if (result.stiffnessIndex !== null) addMetric(metrics, 'Índex de rigidesa', `${result.stiffnessIndex.toFixed(1)} m/s`);
  if (ppg && ppg.features) {
    addMetric(metrics, 'Índex d\'envelliment', ppg.features.agingIndex.toFixed(2));
    addMetric(metrics, 'ΔT sístole–diàstole', `${Math.round(ppg.features.deltaT * 1000)} ms`);
    addMetric(metrics, 'Índex de reflexió', `${Math.round(ppg.features.reflectionIndex * 100)} %`);
  }
  if (ppg) addMetric(metrics, 'FC (càmera)', `${Math.round(ppg.heartRate)} bpm`);
  if (ppg) addMetric(metrics, 'Qualitat del senyal', `${Math.round(ppg.quality * 100)} %`);
  if (input.rmssd !== null) addMetric(metrics, 'RMSSD (rellotge)', `${input.rmssd} ms`);

  const body = $('result-estimators').querySelector('tbody');
  body.replaceChildren(...result.estimators.map((estimator) => {
    const row = document.createElement('tr');
    for (const text of [estimator.label, Math.round(estimator.vascularAge), `${Math.round(estimator.share * 100)} %`]) {
      const cell = document.createElement('td');
      cell.textContent = String(text);
      row.append(cell);
    }
    return row;
  }));
  $('result-note').textContent = ppgNote(ppg);

  const history = [...loadJson(HISTORY_KEY, []), {
    date: new Date().toISOString(),
    vascularAge: Math.round(result.vascularAge * 10) / 10,
    pwv: Math.round(result.pwv * 10) / 10,
    quality: ppg ? Math.round(ppg.quality * 100) / 100 : null,
  }].slice(-HISTORY_LIMIT);
  saveJson(HISTORY_KEY, history);
  renderHistory();
  showStep('result');
}

function renderHistory() {
  const stored = loadJson(HISTORY_KEY, []);
  const history = Array.isArray(stored) ? stored.filter((e) => e && Number.isFinite(e.vascularAge)) : [];
  $('history-card').hidden = history.length === 0;
  if (history.length === 0) return;
  const recent = history.slice(-MEDIAN_WINDOW).map((entry) => entry.vascularAge);
  $('history-summary').textContent = recent.length < MEDIAN_WINDOW
    ? `Fes ${MEDIAN_WINDOW - recent.length} mesura/es més: la mediana de ${MEDIAN_WINDOW} és més fiable que una de sola.`
    : `Mediana de les últimes ${MEDIAN_WINDOW}: ${Math.round(median(recent))} anys`;
  $('history-list').replaceChildren(...history.slice(-HISTORY_SHOWN).reverse().map((entry) => {
    const item = document.createElement('li');
    const when = document.createElement('span');
    const value = document.createElement('span');
    when.textContent = new Date(entry.date).toLocaleString('ca-ES', { dateStyle: 'short', timeStyle: 'short' });
    value.textContent = `${Math.round(entry.vascularAge)} anys`;
    item.append(when, value);
    return item;
  }));
}

// ---------- wiring ----------

function init() {
  const stored = loadJson(PROFILE_KEY, {});
  if (stored && typeof stored === 'object') fillForm(stored);
  const applyFragment = () => {
    const fromWatch = readFragment();
    // A watch hand-off without pressure must not silently reuse an old reading.
    if (fromWatch.restingHr !== undefined && fromWatch.systolic === undefined) {
      FIELDS.systolic.value = '';
      FIELDS.diastolic.value = '';
    }
    fillForm(fromWatch);
    $('watch-banner').hidden = Object.keys(fromWatch).length === 0;
  };
  applyFragment();
  // The watch may reopen an already loaded page with new values.
  window.addEventListener('hashchange', applyFragment);
  renderHistory();

  $('profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = validatedForm();
    if (input) startMeasurement(input);
  });
  $('skip-camera').addEventListener('click', () => {
    const input = validatedForm();
    if (!input) return;
    $('diagnostics').hidden = true; // no camera measurement to diagnose
    showResult(input, null);
  });
  $('copy-diagnostics').addEventListener('click', copyDiagnostics);
  $('cancel-measure').addEventListener('click', () => { stopCapture(); showStep('form'); });
  $('repeat').addEventListener('click', () => {
    const input = validatedForm();
    if (input) startMeasurement(input); else showStep('form');
  });
  $('edit-data').addEventListener('click', () => showStep('form'));
  $('clear-history').addEventListener('click', () => {
    if (window.confirm('Vols esborrar tot l\'historial d\'aquest dispositiu?')) {
      saveJson(HISTORY_KEY, []);
      renderHistory();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && capture) { stopCapture(); showStep('form'); }
  });
}

init();
