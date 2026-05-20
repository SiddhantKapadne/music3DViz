/** Split a song into 4 bands for visualization (instant, no AI download) */

async function filterCopy(buffer, type, frequency, Q = 1) {
  const { numberOfChannels: ch, length, sampleRate: sr } = buffer;
  const ctx = new OfflineAudioContext(ch, length, sr);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = Q;
  source.connect(filter);
  filter.connect(ctx.destination);
  source.start(0);
  return ctx.startRendering();
}

function toTrack(buffer) {
  return {
    channelData: Array.from({ length: buffer.numberOfChannels }, (_, i) =>
      buffer.getChannelData(i)
    ),
    sampleRate: buffer.sampleRate,
  };
}

/** Boost quiet filtered bands so bass/vocals/other stay audible and visible */
function normalizeTrack(raw) {
  const { channelData, sampleRate } = raw;
  let peak = 0;
  for (const ch of channelData) {
    for (let i = 0; i < ch.length; i++) {
      peak = Math.max(peak, Math.abs(ch[i]));
    }
  }
  if (peak < 1e-8) return { channelData, sampleRate };

  const gain = Math.min(4, 0.9 / peak);
  return {
    channelData: channelData.map((ch) => {
      const out = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
      return out;
    }),
    sampleRate,
  };
}

export async function splitIntoStems(buffer) {
  const [bassBuf, drumsBuf, vocalsBuf, otherBuf] = await Promise.all([
    filterCopy(buffer, "lowpass", 220, 0.85),
    filterCopy(buffer, "bandpass", 320, 1.2),
    filterCopy(buffer, "bandpass", 2200, 1),
    filterCopy(buffer, "highpass", 3800, 0.75),
  ]);

  return {
    bass: normalizeTrack(toTrack(bassBuf)),
    drums: normalizeTrack(toTrack(drumsBuf)),
    vocals: normalizeTrack(toTrack(vocalsBuf)),
    other: normalizeTrack(toTrack(otherBuf)),
  };
}
