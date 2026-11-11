// Live signal-quality hint shown while recording. Pure (no DOM).
// Thresholds are heuristic and unvalidated: they only guide finger placement.

const WINDOW_SECONDS = 3;
const MIN_SPAN_SECONDS = 1.5;
const MIN_SAMPLES = 20;
const SATURATED_LEVEL = 250;
const WEAK_PULSATILITY = 0.3; // % of mean level, peak to peak
const MOVING_PULSATILITY = 8;

const EXPOSURE_TRIGGER_LEVEL = 245; // red mean from which exposure is lowered
const EXPOSURE_TARGET_LEVEL = 200; // red mean we aim for (linear approximation)

/**
 * Exposure time to use before locking: lowered in proportion when the red
 * channel is close to clipping, never below the camera minimum.
 * The torch intensity itself cannot be set from a browser.
 * @param {number} current exposure time as reported by the camera
 * @param {number} meanRed recent mean of the red channel (0-255)
 * @param {{min?: number, max?: number}} [range] camera exposureTime capability
 */
export function targetExposureTime(current, meanRed, range) {
  if (!Number.isFinite(current) || !Number.isFinite(meanRed) || meanRed < EXPOSURE_TRIGGER_LEVEL) {
    return current;
  }
  const wanted = (current * EXPOSURE_TARGET_LEVEL) / meanRed;
  const floor = range && Number.isFinite(range.min) ? range.min : 0;
  return Math.max(wanted, Math.min(floor, current));
}

const MESSAGES =Object.freeze({
  waiting: 'Llegint el senyal…',
  good: 'Senyal bo. Continua quiet.',
  weak: 'Pols molt feble: escalfa el dit o canvia lleugerament la pressió.',
  saturated: 'Imatge saturada: prem una mica menys o redueix la llum.',
  moving: 'Massa moviment: recolza la mà i no parlis.',
});

const result = (level) => Object.freeze({ level, message: MESSAGES[level] });

/** Peak-to-peak of the series after removing its least-squares line. */
function detrendedRange(points) {
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanY = points.reduce((sum, p) => sum + p.red, 0) / n;
  let covariance = 0, variance = 0;
  for (const p of points) {
    covariance += (p.t - meanT) * (p.red - meanY);
    variance += (p.t - meanT) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  let low = Infinity, high = -Infinity;
  for (const p of points) {
    const residual = p.red - meanY - slope * (p.t - meanT);
    low = Math.min(low, residual);
    high = Math.max(high, residual);
  }
  return { range: high - low, meanY };
}

/**
 * @param {ReadonlyArray<{t: number, red: number}>} samples recent frames, oldest first
 * @returns {{level: 'waiting'|'good'|'weak'|'saturated'|'moving', message: string}}
 */
export function liveQuality(samples) {
  if (!samples || samples.length === 0) return result('waiting');
  const latest = samples[samples.length - 1].t;
  const recent = samples.filter((s) => s.t >= latest - WINDOW_SECONDS);
  if (recent.length < MIN_SAMPLES || latest - recent[0].t < MIN_SPAN_SECONDS) {
    return result('waiting');
  }
  const { range, meanY } = detrendedRange(recent);
  if (meanY >= SATURATED_LEVEL) return result('saturated');
  const pulsatility = (range / meanY) * 100;
  if (pulsatility > MOVING_PULSATILITY) return result('moving');
  if (pulsatility < WEAK_PULSATILITY) return result('weak');
  return result('good');
}
