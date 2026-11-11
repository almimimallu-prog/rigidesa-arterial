// Vascular-age model: fuses independent estimators in the age domain.
// Pure functions, no DOM. Sources for every coefficient are in the README.

export const LIMITS = Object.freeze({
  age: [18, 95], heightCm: [130, 220], systolic: [70, 250], diastolic: [40, 150],
  restingHr: [30, 130],
});

const VASCULAR_AGE_MIN = 25; // ePWV is not monotonic in age below ~24 years
const VASCULAR_AGE_MAX = 100;
const REFERENCE_SYSTOLIC = 120;
const REFERENCE_DIASTOLIC = 80;
const REFERENCE_HR = 65;
const PWV_PER_BPM = 0.017; // m/s per bpm (≈0.17 m/s per 10 bpm, pacing studies)
const MIN_PPG_QUALITY = 0.3;
const MIN_UNCERTAINTY_YEARS = 5;

// Takazawa 1998: agingIndex = 0.023·age − 1.515
const AGI_SLOPE = 0.023;
const AGI_INTERCEPT = -1.515;
// Approximate population trend of the stiffness index (Millasseau 2002, UK Biobank).
const SI_SLOPE = 0.09;
const SI_INTERCEPT = 4.3;

const WEIGHTS = Object.freeze({
  prior: 0.25, pressureMeasured: 0.35, pressureAssumed: 0.1, agingIndex: 0.15, stiffnessIndex: 0.25,
});

const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
const inRange = (x, [low, high]) => Number.isFinite(x) && x >= low && x <= high;

/** Mean blood pressure with the 0.4 form factor used by the ePWV equation. */
export function meanPressure(systolic, diastolic) {
  return diastolic + 0.4 * (systolic - diastolic);
}

/** Estimated carotid-femoral PWV (m/s), Greve et al. 2016 / Reference Values Collab. 2010. */
export function estimatedPwv(age, meanBp) {
  return 9.587 - 0.402 * age + 4.56e-3 * age ** 2 - 2.621e-5 * age ** 2 * meanBp
    + 3.176e-3 * age * meanBp - 1.832e-2 * meanBp;
}

const REFERENCE_MBP = meanPressure(REFERENCE_SYSTOLIC, REFERENCE_DIASTOLIC);

/** PWV expected at a given age with reference pressure (120/80) and heart rate. */
export function referencePwv(age) {
  return estimatedPwv(age, REFERENCE_MBP);
}

/** Age at which the reference population has this PWV (bisection, clamped). */
export function ageForPwv(pwv) {
  let low = VASCULAR_AGE_MIN, high = VASCULAR_AGE_MAX;
  if (pwv <= referencePwv(low)) return low;
  if (pwv >= referencePwv(high)) return high;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (referencePwv(mid) < pwv) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

export function validateInputs(input) {
  const errors = [];
  if (!inRange(input.age, LIMITS.age)) errors.push('Edat fora de rang (18–95).');
  if (!inRange(input.heightCm, LIMITS.heightCm)) errors.push('Alçada fora de rang (130–220 cm).');
  const hasSys = input.systolic != null, hasDia = input.diastolic != null;
  if (hasSys !== hasDia) errors.push('Introdueix les dues xifres de pressió o cap.');
  if (hasSys && hasDia) {
    if (!inRange(input.systolic, LIMITS.systolic) || !inRange(input.diastolic, LIMITS.diastolic)
      || input.systolic <= input.diastolic) {
      errors.push('Pressió arterial no vàlida.');
    }
  }
  if (input.restingHr != null && !inRange(input.restingHr, LIMITS.restingHr)) {
    errors.push('FC en repòs fora de rang (30–130).');
  }
  return errors;
}

function pressureEstimator(input) {
  const measured = input.systolic != null && input.diastolic != null;
  const meanBp = measured ? meanPressure(input.systolic, input.diastolic) : REFERENCE_MBP;
  const hrShift = input.restingHr != null ? PWV_PER_BPM * (input.restingHr - REFERENCE_HR) : 0;
  const pwv = estimatedPwv(input.age, meanBp) + hrShift;
  return {
    id: 'pressure',
    label: measured ? 'Pressió arterial + FC (ePWV)' : 'FC en repòs (sense pressió)',
    vascularAge: ageForPwv(pwv),
    weight: measured ? WEIGHTS.pressureMeasured : WEIGHTS.pressureAssumed,
  };
}

function ppgEstimators(input) {
  const { ppg } = input;
  if (!ppg || !ppg.features || !(ppg.quality >= MIN_PPG_QUALITY)) return [];
  const { agingIndex, deltaT } = ppg.features;
  const stiffnessIndex = input.heightCm / 100 / deltaT;
  return [
    {
      id: 'agingIndex',
      label: 'Índex d\'envelliment SDPPG',
      vascularAge: clamp((agingIndex - AGI_INTERCEPT) / AGI_SLOPE, LIMITS.age[0], VASCULAR_AGE_MAX),
      weight: WEIGHTS.agingIndex * ppg.quality,
    },
    {
      id: 'stiffnessIndex',
      label: 'Índex de rigidesa (alçada/ΔT)',
      vascularAge: clamp((stiffnessIndex - SI_INTERCEPT) / SI_SLOPE, LIMITS.age[0], VASCULAR_AGE_MAX),
      weight: WEIGHTS.stiffnessIndex * ppg.quality,
      value: stiffnessIndex,
    },
  ];
}

function confidenceLabel(input, estimators) {
  const hasPpg = estimators.some((e) => e.id === 'agingIndex');
  const hasPressure = input.systolic != null;
  if (hasPpg && hasPressure && input.ppg.quality >= 0.6) return 'alta';
  if (hasPpg || hasPressure) return 'mitjana';
  return 'baixa';
}

/**
 * @param {{age:number, heightCm:number, systolic?:number, diastolic?:number,
 *          restingHr?:number, ppg?:{quality:number, features:object|null}}} input
 * @returns vascular age, PWV equivalent, uncertainty and per-estimator breakdown
 */
export function estimateVascularAge(input) {
  const errors = validateInputs(input);
  if (errors.length > 0) throw new Error(errors.join(' '));

  const prior = { id: 'prior', label: 'Edat cronològica (ancoratge)', vascularAge: input.age, weight: WEIGHTS.prior };
  const estimators = [prior, pressureEstimator(input), ...ppgEstimators(input)];
  const totalWeight = estimators.reduce((sum, e) => sum + e.weight, 0);
  const vascularAge = estimators.reduce((sum, e) => sum + e.weight * e.vascularAge, 0) / totalWeight;
  const spread = Math.sqrt(
    estimators.reduce((sum, e) => sum + e.weight * (e.vascularAge - vascularAge) ** 2, 0) / totalWeight,
  );
  const stiffness = estimators.find((e) => e.id === 'stiffnessIndex');
  return {
    vascularAge,
    ageDifference: vascularAge - input.age,
    pwv: referencePwv(clamp(vascularAge, VASCULAR_AGE_MIN, VASCULAR_AGE_MAX)),
    expectedPwv: referencePwv(clamp(input.age, VASCULAR_AGE_MIN, VASCULAR_AGE_MAX)),
    uncertaintyYears: Math.max(MIN_UNCERTAINTY_YEARS, spread),
    stiffnessIndex: stiffness ? stiffness.value : null,
    confidence: confidenceLabel(input, estimators),
    estimators: estimators.map((e) => ({ ...e, share: e.weight / totalWeight })),
  };
}
