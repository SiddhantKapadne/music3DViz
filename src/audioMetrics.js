/** Per-stem energy + timbre features for the 3D visualizer */

export function createMetricState(fftSize) {
  const binCount = fftSize / 2;
  return {
    freq: new Uint8Array(binCount),
    time: new Uint8Array(fftSize),
    prevFreq: new Uint8Array(binCount),
    prevRms: 0,
    hasPrev: false,
  };
}

export function readStemMetrics(analyser, state) {
  if (!analyser) {
    return { rms: 0, peak: 0, centroid: 0, flux: 0, brightness: 0 };
  }

  const binCount = analyser.frequencyBinCount;
  if (state.freq.length < binCount) {
    Object.assign(state, createMetricState(analyser.fftSize));
  }

  analyser.getByteFrequencyData(state.freq);
  analyser.getByteTimeDomainData(state.time);

  let sumSq = 0;
  for (let i = 0; i < state.time.length; i++) {
    const v = (state.time[i] - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / state.time.length);

  const peak = state.hasPrev ? Math.min(1, Math.max(0, (rms - state.prevRms) * 14)) : 0;
  state.prevRms = state.prevRms * 0.75 + rms * 0.25;
  state.hasPrev = true;

  let weighted = 0;
  let total = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  const third = Math.floor(binCount / 3);

  for (let i = 0; i < binCount; i++) {
    const m = state.freq[i] / 255;
    weighted += i * m;
    total += m;
    if (i < third) low += m;
    else if (i < third * 2) mid += m;
    else high += m;
  }

  const centroid = total > 0.001 ? weighted / total / binCount : 0;
  const norm = total > 0.001 ? 1 / total : 0;
  const lowN = low * norm;
  const midN = mid * norm;
  const highN = high * norm;

  let flux = 0;
  for (let i = 0; i < binCount; i++) {
    const d = (state.freq[i] - state.prevFreq[i]) / 255;
    if (d > 0) flux += d;
  }
  flux = binCount > 0 ? flux / binCount : 0;
  state.prevFreq.set(state.freq);

  const brightness = centroid * 0.55 + highN * 0.45;

  return { rms, peak, centroid, flux, brightness, low: lowN, mid: midN, high: highN };
}

/** Map each visual bar to a frequency bin for its stem band */
export function barFrequencyBin(barIndex, barCount, binCount, signature) {
  const t = barCount > 1 ? barIndex / (barCount - 1) : 0;
  let start = 0;
  let span = 1;
  switch (signature) {
    case "offset":
      start = 0;
      span = 0.38;
      break;
    case "snap":
      start = 0.08;
      span = 0.48;
      break;
    case "open":
      start = 0.22;
      span = 0.45;
      break;
    case "depth":
      start = 0.42;
      span = 0.58;
      break;
    default:
      span = 1;
  }
  return Math.min(binCount - 1, Math.floor((start + t * span) * binCount));
}
