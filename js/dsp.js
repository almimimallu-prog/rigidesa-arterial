// Pure signal-processing core for fingertip camera PPG.
// No DOM access: runs in the browser and in Node (tests).

export const TARGET_FS = 100; // Hz, uniform grid used for all analysis
const BAND_LOW_HZ = 0.5;
const BAND_HIGH_HZ = 10;
const REFRACTORY_S = 0.33;
const SLOPE_THRESHOLD_RATIO = 0.5;
const IBI_TOLERANCE = 0.25;
const MIN_BEAT_CORRELATION = 0.9;
const TEMPLATE_PRE_S = 0.2;
const TEMPLATE_MAX_POST_S = 1.0;
const MIN_BEATS = 15;
const TARGET_BEATS = 40;

/** Linear interpolation of an irregularly sampled signal onto a uniform grid. */
export function resampleUniform(times, values, fs = TARGET_FS) {
  if (times.length !== values.length || times.length < 2) {
    throw new Error('resampleUniform: calen almenys 2 mostres aparellades');
  }
  const start = times[0];
  const count = Math.floor((times[times.length - 1] - start) * fs) + 1;
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = start + i / fs;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const span = times[j + 1] - times[j];
    const frac = span > 0 ? Math.min(1, Math.max(0, (t - times[j]) / span)) : 0;
    out[i] = values[j] + frac * (values[j + 1] - values[j]);
  }
  return out;
}

function biquadCoefficients(type, cutoffHz, fs) {
  const w0 = (2 * Math.PI * cutoffHz) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const edge = type === 'lowpass' ? 1 - cos : 1 + cos;
  const b1 = type === 'lowpass' ? edge : -edge;
  return {
    b0: edge / 2 / a0, b1: b1 / a0, b2: edge / 2 / a0,
    a1: (-2 * cos) / a0, a2: (1 - alpha) / a0,
  };
}

function runBiquad(signal, c) {
  const out = new Float64Array(signal.length);
  let x1 = signal[0], x2 = signal[0];
  // Start in steady state for a constant input to limit edge transients.
  const dcGain = (c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2);
  let y1 = signal[0] * dcGain, y2 = y1;
  for (let i = 0; i < signal.length; i++) {
    const x0 = signal[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function zeroPhase(signal, coefficients) {
  const forward = runBiquad(signal, coefficients);
  const backward = runBiquad(Float64Array.from(forward).reverse(), coefficients);
  return backward.reverse();
}

/** Zero-phase 0.5–10 Hz band-pass (keeps pulse morphology, removes drift). */
export function bandpass(signal, fs = TARGET_FS) {
  const high = zeroPhase(signal, biquadCoefficients('highpass', BAND_LOW_HZ, fs));
  return zeroPhase(high, biquadCoefficients('lowpass', BAND_HIGH_HZ, fs));
}

export function derivative(signal, fs) {
  const out = new Float64Array(signal.length);
  for (let i = 1; i < signal.length - 1; i++) {
    out[i] = ((signal[i + 1] - signal[i - 1]) * fs) / 2;
  }
  return out;
}

function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sub-sample position of an extremum from its 3 neighbouring samples. */
function parabolicOffset(left, centre, right) {
  const denominator = left - 2 * centre + right;
  return denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
}

/**
 * Beat fiducials = maximum systolic upslope, in fractional sample units.
 * The steepest-slope point is the most noise-robust landmark of a PPG pulse.
 */
export function detectBeats(signal, fs = TARGET_FS) {
  const slope = derivative(signal, fs);
  const threshold = SLOPE_THRESHOLD_RATIO * percentile(slope, 0.97);
  const refractory = Math.round(REFRACTORY_S * fs);
  const beats = [];
  let lastIndex = -Infinity;
  for (let i = 1; i < slope.length - 1; i++) {
    const isPeak = slope[i] > threshold && slope[i] >= slope[i - 1] && slope[i] > slope[i + 1];
    if (!isPeak) continue;
    if (i - lastIndex < refractory) {
      if (slope[i] > slope[lastIndex]) {
        beats[beats.length - 1] = i + parabolicOffset(slope[i - 1], slope[i], slope[i + 1]);
        lastIndex = i;
      }
      continue;
    }
    beats.push(i + parabolicOffset(slope[i - 1], slope[i], slope[i + 1]));
    lastIndex = i;
  }
  return beats;
}

function sampleAt(signal, position) {
  const i = Math.floor(position);
  if (i < 0 || i >= signal.length - 1) return NaN;
  const frac = position - i;
  return signal[i] + frac * (signal[i + 1] - signal[i]);
}

function correlation(a, b) {
  let sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / a.length, mb = sb / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

function meanOf(segments) {
  const out = new Float64Array(segments[0].length);
  for (const segment of segments) {
    for (let i = 0; i < out.length; i++) out[i] += segment[i] / segments.length;
  }
  return out;
}

function emptyTemplate(beatsDetected, medianIbi, beatsRegular = 0) {
  return {
    template: null, beatsUsed: 0, beatsDetected, beatsRegular, medianIbi, meanCorrelation: 0, fiducialIndex: 0,
  };
}

/** Beats whose neighbouring intervals are close to the median (drops ectopics/misses). */
function regularBeats(beats, intervals, medianIbi) {
  const isRegular = (interval) => Math.abs(interval - medianIbi) < IBI_TOLERANCE * medianIbi;
  return beats.filter((_, i) => {
    const before = i > 0 ? intervals[i - 1] : medianIbi;
    const after = i < intervals.length ? intervals[i] : medianIbi;
    return isRegular(before) && isRegular(after);
  });
}

function normalisedSegment(signal, beat, pre, length) {
  const segment = new Float64Array(length);
  let low = Infinity, high = -Infinity;
  for (let k = 0; k < length; k++) {
    const v = sampleAt(signal, beat - pre + k);
    if (Number.isNaN(v)) return null;
    segment[k] = v;
    if (v < low) low = v;
    if (v > high) high = v;
  }
  if (high <= low) return null;
  return segment.map((v) => (v - low) / (high - low));
}

/**
 * Ensemble-averaged pulse. Beats land at random phases relative to camera
 * frames, so averaging beats aligned at sub-frame precision recovers a
 * waveform finer than the frame interval and cancels uncorrelated noise.
 */
export function buildTemplate(signal, beats, fs = TARGET_FS) {
  const intervals = [];
  for (let i = 1; i < beats.length; i++) intervals.push((beats[i] - beats[i - 1]) / fs);
  const medianIbi = median(intervals);
  const pre = Math.round(TEMPLATE_PRE_S * fs);
  const post = Math.round(Math.min(TEMPLATE_MAX_POST_S, medianIbi - TEMPLATE_PRE_S) * fs);
  if (!(post > 0)) return emptyTemplate(beats.length, medianIbi);

  const regular = regularBeats(beats, intervals, medianIbi);
  const segments = regular
    .map((beat) => normalisedSegment(signal, beat, pre, pre + post))
    .filter((segment) => segment !== null);
  if (segments.length === 0) return emptyTemplate(beats.length, medianIbi, regular.length);

  const draft = meanOf(segments);
  const kept = segments
    .map((segment) => ({ segment, r: correlation(segment, draft) }))
    .filter((scored) => scored.r >= MIN_BEAT_CORRELATION);
  if (kept.length === 0) return emptyTemplate(beats.length, medianIbi, regular.length);

  return {
    template: meanOf(kept.map((scored) => scored.segment)),
    beatsUsed: kept.length,
    beatsDetected: beats.length,
    beatsRegular: regular.length,
    medianIbi,
    meanCorrelation: kept.reduce((sum, scored) => sum + scored.r, 0) / kept.length,
    fiducialIndex: pre,
  };
}

function smooth3(signal) {
  const out = Float64Array.from(signal);
  for (let i = 1; i < signal.length - 1; i++) {
    out[i] = (signal[i - 1] + 2 * signal[i] + signal[i + 1]) / 4;
  }
  return out;
}

function argExtreme(signal, from, to, sign) {
  let best = from;
  for (let i = from; i <= to && i < signal.length; i++) {
    if (sign * signal[i] > sign * signal[best]) best = i;
  }
  return best;
}

function localExtrema(signal, from, to) {
  const found = [];
  for (let i = Math.max(1, from); i <= to && i < signal.length - 1; i++) {
    if (signal[i] > signal[i - 1] && signal[i] >= signal[i + 1]) found.push({ index: i, kind: 'max' });
    if (signal[i] < signal[i - 1] && signal[i] <= signal[i + 1]) found.push({ index: i, kind: 'min' });
  }
  return found;
}

/**
 * c (late max) and d (late min) wave values between b and e. When they are
 * fused (monotonic rise from b to e) both take the value at the shoulder:
 * the interior point where the rise is slowest, or the midpoint if none.
 */
function lateSystolicWaves(d2, bIndex, eIndex, fs) {
  const between = localExtrema(d2, bIndex + 1, eIndex - 1);
  const cEntry = between.find((x) => x.kind === 'max');
  const dEntry = cEntry && between.find((x) => x.kind === 'min' && x.index > cEntry.index);
  if (cEntry && dEntry) return { c: d2[cEntry.index], d: d2[dEntry.index] };
  const d3 = derivative(d2, fs);
  const shoulder = localExtrema(d3, bIndex + 2, eIndex - 2).find((x) => x.kind === 'min');
  const index = shoulder ? shoulder.index : Math.round((bIndex + eIndex) / 2);
  return { c: d2[index], d: d2[index] };
}

const DELTA_T_RANGE_S = [0.1, 0.5];
const REFLECTION_INDEX_RANGE = [0.1, 1.0];

// Written as a negated "inside" test so NaN counts as outside.
const outside = (x, [low, high]) => !(x >= low && x <= high);

/** Why a feature set was rejected (Catalan: shown in the diagnostic panel), or null. */
function implausibilityReason(deltaT, reflectionIndex) {
  if (outside(deltaT, DELTA_T_RANGE_S)) {
    return `ΔT fora de rang (${Math.round(deltaT * 1000)} ms; s'espera 100–500 ms).`;
  }
  if (outside(reflectionIndex, REFLECTION_INDEX_RANGE)) {
    return `Índex de reflexió fora de rang (${Math.round(reflectionIndex * 100)} %; s'espera 10–100 %).`;
  }
  return null;
}

/** Diastolic peak: first maximum after the notch; else the inflection point. */
function diastolicLandmark(template, d1, eIndex, fs) {
  const to = Math.min(template.length - 2, eIndex + Math.round(0.25 * fs));
  const peak = localExtrema(template, eIndex, to).find((x) => x.kind === 'max');
  return { index: peak ? peak.index : argExtreme(d1, eIndex, to, 1), separate: Boolean(peak) };
}

const featureFailure = (failure) => ({ features: null, failure });

/**
 * Morphology features from the averaged pulse, plus the reason when they
 * cannot be trusted ({ features, failure }; exactly one of them is null):
 *  - deltaT: systolic peak → diastolic peak/inflection (s). SI = height / deltaT.
 *  - agingIndex: (b − c − d − e) / a on the second derivative (Takazawa 1998).
 *  - reflectionIndex, crestTime, marks (template sample indices of the landmarks).
 */
export function analyseFeatures(template, fiducialIndex, fs = TARGET_FS) {
  const d1 = derivative(template, fs);
  const d2 = smooth3(derivative(d1, fs));
  const footIndex = argExtreme(template, 0, fiducialIndex, -1);
  const systolicIndex = argExtreme(template, fiducialIndex, fiducialIndex + Math.round(0.3 * fs), 1);

  const aIndex = argExtreme(d2, footIndex, fiducialIndex, 1);
  // e wave (dicrotic notch) = most prominent positive wave after the systolic peak.
  const eFrom = systolicIndex + Math.round(0.03 * fs);
  const eTo = Math.min(template.length - 2, systolicIndex + Math.round(0.35 * fs));
  if (d2[aIndex] <= 0 || eFrom >= eTo) return featureFailure('No es localitza la pujada sistòlica (ona a).');
  const lateMaxima = localExtrema(d2, eFrom, eTo).filter((x) => x.kind === 'max');
  if (lateMaxima.length === 0) return featureFailure('No es troba l\'osca dicrota (ona e).');
  const eIndex = lateMaxima.reduce((best, x) => (d2[x.index] > d2[best.index] ? x : best)).index;
  const bIndex = argExtreme(d2, aIndex, Math.min(eIndex - 3, aIndex + Math.round(0.2 * fs)), -1);
  if (eIndex - bIndex < 4) return featureFailure('Les ones b i e són massa properes per separar-les.');

  const a = d2[aIndex];
  const late = lateSystolicWaves(d2, bIndex, eIndex, fs);
  const agingIndex = (d2[bIndex] - late.c - late.d - d2[eIndex]) / a;

  const diastolic = diastolicLandmark(template, d1, eIndex, fs);
  const deltaT = (diastolic.index - systolicIndex) / fs;
  const amplitude = template[systolicIndex] - template[footIndex];
  if (amplitude <= 0) return featureFailure('Amplitud del pols nul·la.');
  const reflectionIndex = (template[diastolic.index] - template[footIndex]) / amplitude;
  const reason = implausibilityReason(deltaT, reflectionIndex);
  if (reason) return featureFailure(reason);

  return {
    failure: null,
    features: {
      deltaT,
      agingIndex,
      reflectionIndex,
      crestTime: (systolicIndex - footIndex) / fs,
      waves: { bOverA: d2[bIndex] / a, cOverA: late.c / a, dOverA: late.d / a, eOverA: d2[eIndex] / a },
      separateDiastolicPeak: diastolic.separate,
      marks: { foot: footIndex, systolic: systolicIndex, notch: eIndex, diastolic: diastolic.index },
    },
  };
}

/** Features only (null when landmarks cannot be located). */
export function extractFeatures(template, fiducialIndex, fs = TARGET_FS) {
  return analyseFeatures(template, fiducialIndex, fs).features;
}

function clamp01(x) { return Math.min(1, Math.max(0, x)); }

/**
 * Full pipeline: raw camera samples → heart rate, morphology features, quality.
 * @param {number[]} times  seconds, increasing
 * @param {number[]} brightness  mean channel intensity per frame
 */
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

function stdDev(values) {
  const centre = mean(values);
  return Math.sqrt(mean(Array.from(values, (v) => (v - centre) ** 2)));
}

/** Frame timing and pulsatility (band-passed RMS relative to the mean level, in %). */
function signalStats(times, brightness, filtered) {
  const durationS = times[times.length - 1] - times[0];
  const level = mean(brightness);
  return {
    frames: times.length,
    durationS,
    frameRate: (times.length - 1) / durationS,
    meanLevel: level,
    pulsatilityPercent: level > 0 ? (100 * stdDev(filtered)) / level : 0,
  };
}

function beatStats(beats, fs) {
  const intervals = [];
  for (let i = 1; i < beats.length; i++) intervals.push((beats[i] - beats[i - 1]) / fs);
  const average = intervals.length > 0 ? mean(intervals) : 0;
  return {
    beatsDetected: beats.length,
    medianIbi: intervals.length > 0 ? median(intervals) : 0,
    ibiCv: average > 0 ? stdDev(intervals) / average : 0,
  };
}

const rejected = (reason, diagnostics) => ({ ok: false, reason, diagnostics });

/** The three factors whose product is the quality score (each 0–1). */
function qualityFactors(built) {
  return {
    beatsKept: clamp01(built.beatsUsed / built.beatsDetected),
    correlation: clamp01((built.meanCorrelation - MIN_BEAT_CORRELATION) / 0.07),
    beatCount: clamp01(built.beatsUsed / TARGET_BEATS),
  };
}

export function analyzePpg(times, brightness) {
  if (!Array.isArray(times) || !Array.isArray(brightness)
    || times.length !== brightness.length || times.length < 100) {
    const frames = Array.isArray(times) ? times.length : 0;
    return rejected('Senyal massa curt.', { frames, failedStage: 'dades de la càmera' });
  }
  const fs = TARGET_FS;
  // Blood absorbs light: more volume = darker frame, so invert.
  const inverted = brightness.map((v) => -v);
  const filtered = bandpass(resampleUniform(times, inverted, fs), fs);
  const beats = detectBeats(filtered, fs);
  const signal = { ...signalStats(times, brightness, filtered), ...beatStats(beats, fs) };
  if (beats.length < MIN_BEATS) {
    return rejected('No s\'han detectat prou batecs. Repeteix amb el dit quiet.',
      { ...signal, failedStage: 'detecció de batecs' });
  }
  const built = buildTemplate(filtered, beats, fs);
  const stats = {
    ...signal, beatsRegular: built.beatsRegular, beatsUsed: built.beatsUsed, meanCorrelation: built.meanCorrelation,
  };
  if (!built.template || built.beatsUsed < MIN_BEATS) {
    return rejected('Senyal massa irregular. Repeteix sense moure el dit ni prémer fort.',
      { ...stats, failedStage: 'plantilla del pols' });
  }
  const factors = qualityFactors(built);
  const analysis = analyseFeatures(built.template, built.fiducialIndex, fs);
  return {
    ok: true,
    heartRate: 60 / built.medianIbi,
    beatsUsed: built.beatsUsed,
    beatsDetected: built.beatsDetected,
    quality: factors.beatsKept * factors.correlation * factors.beatCount,
    features: analysis.features,
    template: Array.from(built.template),
    frameRate: signal.frameRate,
    diagnostics: {
      ...stats,
      qualityFactors: factors,
      featureFailure: analysis.failure,
      marks: analysis.features ? analysis.features.marks : null,
    },
  };
}
