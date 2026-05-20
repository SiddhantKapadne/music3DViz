import { Visualizer3D, STEM_CONFIG } from "./visualizer3d.js";
import { splitIntoStems } from "./audioSplit.js";

const STEM_UI = {
  vocals: { css: "var(--vocals)" },
  drums: { css: "var(--drums)" },
  bass: { css: "var(--bass)" },
  other: { css: "var(--swirl)" },
};

const STEM_ORDER = ["vocals", "drums", "bass", "other"].map((id) => {
  const c = STEM_CONFIG.find((s) => s.id === id);
  return {
    id,
    label: c.label.toUpperCase(),
    color: STEM_UI[id]?.css ?? `#${c.color.toString(16).padStart(6, "0")}`,
  };
});

const FFT_SIZE = 2048;
const SMOOTHING = 0.82;
const MP3_WAV_EXT = /\.(mp3|wav)$/i;
const DEFAULT_TRACK_URL = `${import.meta.env.BASE_URL}Default.mp3`;
const DEFAULT_TRACK_NAME = "Default.mp3";

function isMp3OrWavFile(file) {
  return MP3_WAV_EXT.test((file?.name ?? "").trim());
}

const $ = (id) => document.getElementById(id);

const dropZone = $("dropZone");
const fileInput = $("fileInput");
const browseBtn = $("browseBtn");
const experience = $("experience");
const viz3dContainer = $("viz3d");
const stemControls = $("stemControls");
const playPauseBtn = $("playPauseBtn");
const playIcon = $("playIcon");
const progress = $("progress");
const progressFill = $("progressFill");
const currentTimeEl = $("currentTime");
const durationEl = $("duration");
const masterVolume = $("masterVolume");
const trackName = $("trackName");
const statusEl = $("status");
const separateProgress = $("separateProgress");
const separateBar = $("separateBar");
const separateLabel = $("separateLabel");
const newTrackBtn = $("newTrackBtn");

let audioContext = null;
let stemBuffers = new Map();
let stemAnalysers = new Map();
let stemGains = new Map();
let stemMuted = new Map();
let stemSources = new Map();
let masterGain = null;
let masterAnalyser = null;
let visualizer = null;
let duration = 0;
let isPlaying = false;
let startTime = 0;
let pauseTime = 0;
let progressRaf = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ensureAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioContext.createGain();
    masterGain.gain.value = Number(masterVolume.value);
    masterAnalyser = audioContext.createAnalyser();
    masterAnalyser.fftSize = FFT_SIZE;
    masterAnalyser.smoothingTimeConstant = SMOOTHING;
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(audioContext.destination);
  }
  return audioContext;
}

async function decodeToBuffer(file) {
  const ctx = ensureAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error("Could not read this file. Use a normal MP3 or WAV.");
  }
  if (!buffer.length || buffer.duration <= 0) {
    throw new Error("This file appears empty. Try another MP3 or WAV.");
  }
  return buffer;
}

function rawAudioToBuffer(ctx, raw) {
  const { channelData, sampleRate } = raw;
  const buf = ctx.createBuffer(channelData.length, channelData[0].length, sampleRate);
  channelData.forEach((ch, i) => buf.copyToChannel(ch, i));
  return buf;
}

function showProgress(visible, label = "", pct = 0) {
  separateProgress.classList.toggle("hidden", !visible);
  separateLabel.textContent = label;
  separateBar.style.width = `${pct}%`;
}

function teardownPlayback() {
  for (const src of stemSources.values()) {
    try {
      src.stop();
    } catch (_) {}
  }
  stemSources.clear();
  isPlaying = false;
  updatePlayIcon(false);
  if (progressRaf) {
    cancelAnimationFrame(progressRaf);
    progressRaf = null;
  }
}

function resetStems() {
  teardownPlayback();
  visualizer?.stop();
  stemBuffers.clear();
  stemAnalysers.clear();
  stemGains.clear();
  stemMuted.clear();
  stemControls.innerHTML = "";
  duration = 0;
  pauseTime = 0;
  progress.value = 0;
  currentTimeEl.textContent = "0:00";
  durationEl.textContent = "0:00";
}

function ensureVisualizer() {
  if (!visualizer) visualizer = new Visualizer3D(viz3dContainer);
  visualizer.setAnalysers(stemAnalysers);
  visualizer.setMasterAnalyser(masterAnalyser);
  visualizer.setPlaybackState(isPlaying);
  return visualizer;
}

function buildStemControls() {
  stemControls.innerHTML = "";
  const ctx = ensureAudioContext();

  for (const stem of STEM_ORDER) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = SMOOTHING;

    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(analyser);
    analyser.connect(masterGain);

    stemAnalysers.set(stem.id, analyser);
    stemGains.set(stem.id, gain);
    stemMuted.set(stem.id, false);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stem-btn";
    btn.dataset.stem = stem.id;
    btn.textContent = stem.label;
    btn.style.setProperty("--stem-color", stem.color);
    btn.setAttribute("aria-label", `${stem.label} — click to disable`);
    btn.setAttribute("aria-pressed", "false");

    btn.addEventListener("click", () => {
      const muted = !stemMuted.get(stem.id);
      stemMuted.set(stem.id, muted);
      stemGains.get(stem.id).gain.value = muted ? 0 : 1;
      visualizer?.setMuted(stem.id, muted);
      btn.classList.toggle("motion-off", muted);
      btn.setAttribute("aria-pressed", String(muted));
      btn.setAttribute(
        "aria-label",
        muted ? `${stem.label} — click to enable` : `${stem.label} — click to disable`
      );
    });

    stemControls.appendChild(btn);
  }

  ensureVisualizer();
}

function getPlaybackTime() {
  if (!audioContext) return pauseTime;
  if (!isPlaying) return pauseTime;
  return Math.min(duration, audioContext.currentTime - startTime);
}

function updateProgressUI() {
  const t = getPlaybackTime();
  currentTimeEl.textContent = formatTime(t);
  if (duration > 0) {
    const pct = (t / duration) * 100;
    progress.value = pct;
    progressFill.style.width = `${pct}%`;
  }
}

function updatePlayIcon(playing) {
  playPauseBtn.classList.toggle("is-playing", playing);
  playPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

async function play() {
  if (!stemBuffers.size) return;
  const ctx = ensureAudioContext();
  if (ctx.state === "suspended") await ctx.resume();

  teardownPlayback();
  isPlaying = true;
  updatePlayIcon(true);

  for (const [stemId, buffer] of stemBuffers) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(stemGains.get(stemId));
    source.start(0, pauseTime);
    stemSources.set(stemId, source);
  }

  startTime = ctx.currentTime - pauseTime;
  const viz = ensureVisualizer();
  viz.setPlaybackState(true);
  viz.start();
  setStatus("Playing.");

  const tick = () => {
    if (!isPlaying) return;
    updateProgressUI();
    if (getPlaybackTime() >= duration - 0.05) {
      pause();
      pauseTime = 0;
      progress.value = 0;
      setStatus("Track finished.");
      return;
    }
    progressRaf = requestAnimationFrame(tick);
  };
  progressRaf = requestAnimationFrame(tick);
}

function pause() {
  if (!isPlaying) return;
  pauseTime = getPlaybackTime();
  teardownPlayback();
  if (visualizer) {
    visualizer.setPlaybackState(false);
    visualizer.start();
  }
  setStatus("Paused.");
}

async function togglePlayPause() {
  if (!stemBuffers.size) return;
  if (isPlaying) pause();
  else await play();
}

function onStemsReady(tracks, fileName, fileSize) {
  resetStems();
  buildStemControls();
  const ctx = ensureAudioContext();

  for (const stem of STEM_ORDER) {
    const raw = tracks[stem.id];
    if (!raw) continue;
    const buf = rawAudioToBuffer(ctx, raw);
    stemBuffers.set(stem.id, buf);
    if (buf.duration > duration) duration = buf.duration;
  }

  durationEl.textContent = formatTime(duration);
  trackName.textContent = fileName.replace(/\.(mp3|wav)$/i, "") || fileName;

  dropZone.classList.add("hidden");
  showProgress(false);
  experience.classList.remove("hidden");
  requestAnimationFrame(() => {
    const viz = ensureVisualizer();
    viz.resize();
    viz.setPlaybackState(false);
    viz.start();
  });
  setTimeout(() => visualizer?.resize(), 120);
  setStatus("");
  progressFill.style.width = "0%";
  updatePlayIcon(false);
}

async function loadFile(file) {
  if (!file || !isMp3OrWavFile(file)) {
    setStatus("Please upload an MP3 or WAV file (.mp3 or .wav).", true);
    return;
  }

  if (audioContext) {
    teardownPlayback();
    visualizer?.dispose();
    visualizer = null;
    await audioContext.close().catch(() => {});
    audioContext = null;
    masterGain = null;
    masterAnalyser = null;
  }

  experience.classList.add("hidden");
  dropZone.classList.add("hidden");
  showProgress(true, "Loading audio…", 20);
  setStatus("");

  try {
    const buffer = await decodeToBuffer(file);
    showProgress(true, "Preparing stems…", 60);
    const tracks = await splitIntoStems(buffer);
    onStemsReady(tracks, file.name, file.size);
  } catch (err) {
    showProgress(false);
    dropZone.classList.remove("hidden");
    setStatus(err?.message || "Something went wrong.", true);
  }
}

browseBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) loadFile(file);
});

playPauseBtn.addEventListener("click", togglePlayPause);

newTrackBtn.addEventListener("click", () => {
  if (isPlaying) pause();
  fileInput.value = "";
  fileInput.click();
});

progress.addEventListener("input", () => {
  if (!duration) return;
  progressFill.style.width = `${progress.value}%`;
  const wasPlaying = isPlaying;
  if (isPlaying) pause();
  pauseTime = (progress.value / 100) * duration;
  currentTimeEl.textContent = formatTime(pauseTime);
  if (wasPlaying) play();
});

masterVolume.addEventListener("input", () => {
  if (masterGain) masterGain.gain.value = Number(masterVolume.value);
});

async function loadDefaultTrack() {
  try {
    const response = await fetch(DEFAULT_TRACK_URL);
    if (!response.ok) throw new Error("Default track not found");
    const blob = await response.blob();
    const file = new File([blob], DEFAULT_TRACK_NAME, { type: blob.type || "audio/mpeg" });
    await loadFile(file);
  } catch {
    dropZone.classList.remove("hidden");
    setStatus("Upload an MP3 or WAV to get started.");
  }
}

loadDefaultTrack();
