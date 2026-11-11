// Turns the raw measurement diagnostics into readable rows ("ok" | "warn" | "bad")
// and a copyable report. Pure functions, no DOM.
//
// The thresholds are rules of thumb to spot a bad recording; they have NOT
// been validated against a reference device.

const FPS_OK = 50;
const FPS_WARN = 25;
const PULSATILITY_BAD_BELOW = 0.1; // %
const PULSATILITY_WARN_BELOW = 0.3; // %
const BEATS_OK = 40;
const BEATS_WARN = 15;
const CORRELATION_OK = 0.97;
const CORRELATION_WARN = 0.93;
const IBI_CV_OK = 0.08;
const IBI_CV_WARN = 0.15;
const REGULAR_SHARE_WARN = 0.6;
const REPORT_DECIMALS = 3;

const row = (label, value, status = 'ok') => ({ label, value: String(value), status });
const has = (x) => typeof x === 'number' && Number.isFinite(x);

/** "ok" when value >= okAt, "warn" when >= warnAt, else "bad". */
const higherIsBetter = (value, okAt, warnAt) => (value >= okAt ? 'ok' : value >= warnAt ? 'warn' : 'bad');
/** "ok" when value < okBelow, "warn" when < warnBelow, else "bad". */
const lowerIsBetter = (value, okBelow, warnBelow) => (value < okBelow ? 'ok' : value < warnBelow ? 'warn' : 'bad');

function timingRows(d) {
  const rows = [];
  if (has(d.frames)) {
    const seconds = has(d.durationS) ? ` en ${d.durationS.toFixed(0)} s` : '';
    rows.push(row('Imatges registrades', `${d.frames}${seconds}`));
  }
  if (has(d.frameRate)) {
    rows.push(row('Imatges per segon', d.frameRate.toFixed(0), higherIsBetter(d.frameRate, FPS_OK, FPS_WARN)));
  }
  if (has(d.pulsatilityPercent)) {
    const status = d.pulsatilityPercent < PULSATILITY_BAD_BELOW ? 'bad'
      : d.pulsatilityPercent < PULSATILITY_WARN_BELOW ? 'warn' : 'ok';
    rows.push(row('Pulsatilitat del senyal', `${d.pulsatilityPercent.toFixed(2)} %`, status));
  }
  return rows;
}

function beatRows(d) {
  const rows = [];
  if (has(d.beatsDetected)) rows.push(row('Batecs detectats', d.beatsDetected));
  if (has(d.beatsRegular) && has(d.beatsDetected) && d.beatsDetected > 0) {
    const share = d.beatsRegular / d.beatsDetected;
    rows.push(row('Batecs amb ritme regular', d.beatsRegular, share >= REGULAR_SHARE_WARN ? 'ok' : 'warn'));
  }
  if (has(d.beatsUsed)) rows.push(row('Batecs usats', d.beatsUsed, higherIsBetter(d.beatsUsed, BEATS_OK, BEATS_WARN)));
  if (has(d.meanCorrelation)) {
    rows.push(row('Correlació entre batecs', d.meanCorrelation.toFixed(3),
      higherIsBetter(d.meanCorrelation, CORRELATION_OK, CORRELATION_WARN)));
  }
  if (has(d.ibiCv)) {
    rows.push(row('Regularitat del ritme', `${(d.ibiCv * 100).toFixed(1)} % de variació`,
      lowerIsBetter(d.ibiCv, IBI_CV_OK, IBI_CV_WARN)));
  }
  return rows;
}

function contextRows(context) {
  const rows = [];
  if (typeof context.torch === 'boolean') {
    rows.push(row('Flaix', context.torch ? 'encès' : 'no disponible', context.torch ? 'ok' : 'warn'));
  }
  if (typeof context.wakeLock === 'boolean') {
    rows.push(row('Pantalla encesa', context.wakeLock ? 'sí' : 'no garantida', context.wakeLock ? 'ok' : 'warn'));
  }
  if (typeof context.exposureLocked === 'boolean') {
    rows.push(row('Exposició bloquejada', context.exposureLocked ? 'sí' : 'no (automàtica)', context.exposureLocked ? 'ok' : 'warn'));
  }
  if (has(context.fingerResets)) {
    rows.push(row('Dit aixecat', context.fingerResets === 0 ? 'cap vegada' : `${context.fingerResets} vegades`,
      context.fingerResets === 0 ? 'ok' : 'warn'));
  }
  if (context.channel) {
    const saturated = context.redSaturated === true;
    rows.push(row('Canal usat', saturated ? `${context.channel} (vermell saturat)` : context.channel,
      saturated ? 'warn' : 'ok'));
  }
  return rows;
}

function outcomeRows(d) {
  const rows = [];
  if (d.failedStage) rows.push(row('Etapa on ha fallat', d.failedStage, 'bad'));
  if (d.featureFailure) rows.push(row('Ona diastòlica', d.featureFailure, 'bad'));
  else if (d.marks) rows.push(row('Ona diastòlica', 'localitzada'));
  return rows;
}

/**
 * @param {object} diagnostics  `analyzePpg(...).diagnostics` (fields may be missing)
 * @param {object} context      capture setup: torch, wakeLock, channel, redSaturated, fingerResets
 * @returns {{label: string, value: string, status: 'ok'|'warn'|'bad'}[]}
 */
export function describeDiagnostics(diagnostics, context) {
  const d = diagnostics || {};
  return [...timingRows(d), ...beatRows(d), ...contextRows(context || {}), ...outcomeRows(d)];
}

const rounded = (value) => (typeof value === 'number'
  ? Number(value.toFixed(REPORT_DECIMALS))
  : value);

function roundDeep(value) {
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundDeep(item)]));
  }
  return rounded(value);
}

/** JSON text (rounded numbers) to paste in a bug report or a chat. */
export function formatReport(diagnostics, context, template) {
  return JSON.stringify(roundDeep({ context, diagnostics, template: template || null }), null, 1);
}
