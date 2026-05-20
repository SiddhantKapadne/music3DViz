import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  barFrequencyBin,
  createMetricState,
  readStemMetrics,
} from "./audioMetrics.js";

const STEM_CONFIG = [
  {
    id: "drums",
    label: "Drums",
    motion: "coalesce",
    signature: "snap",
    color: 0x4b77cf,
    accent: 0x6b95d4,
    center: new THREE.Vector3(-1.5, 0.95, 0.2),
    count: 32,
    traits: "Freq height · hit snap",
  },
  {
    id: "bass",
    label: "Bass",
    motion: "coalesce",
    signature: "offset",
    color: 0xb8ff00,
    accent: 0xc8ff40,
    center: new THREE.Vector3(1.5, 0.95, 0.2),
    count: 28,
    traits: "Freq height · low pulse",
  },
  {
    id: "vocals",
    label: "Vocals",
    motion: "coalesce",
    signature: "open",
    color: 0x03936c,
    accent: 0x05a67a,
    center: new THREE.Vector3(-0.5, 0.95, -1.1),
    count: 30,
    traits: "Freq height · voice opens",
  },
  {
    id: "other",
    label: "Swirl",
    motion: "coalesce",
    signature: "depth",
    color: 0xea4cbf,
    accent: 0xee60c8,
    center: new THREE.Vector3(0.5, 0.95, 1.1),
    count: 30,
    traits: "Freq height · depth shimmer",
  },
];

const BAR_WIDTH = 0.07;
const BAR_DEPTH = 0.04;
const BASE_HEIGHT = 1.2;
/** Subtle gather/spread — small range so motion is barely noticeable */
const COALESCE_SPREAD_BASE = 0.97;
const COALESCE_SPREAD_WAVE = 0.04;
const COALESCE_SPREAD_ENERGY = 0.05;
const COALESCE_GROUP_PULSE = 0.04;
const COALESCE_HEIGHT_PULSE = 0.06;
const COALESCE_WIDTH_PULSE = 0.025;
const PAUSED_TIME_SCALE = 0.04;
const PLAYING_TIME_SCALE_MIN = 0.45;
const PLAYBACK_BLEND_PLAY = 0.07;
const PLAYBACK_BLEND_PAUSE = 0.02;
const FREQ_LEN_MIN = 0.38;
const FREQ_LEN_MAX = 2.55;
const FREQ_LEN_SMOOTH = 0.26;
const STATIC_OPACITY = 0.58;
const DISABLED_GROUP_SCALE = 0.46;
const DISABLED_BAR_SCALE = 0.4;
const DISABLED_SPREAD = 0.5;
const LEVITATE_STEM_AMP = 0.32;
const LEVITATE_BAR_AMP = 0.26;
const LEVITATE_IDLE = 0.06;

function lerpColor(base, accent, t) {
  return base.clone().lerp(accent, Math.min(1, Math.max(0, t)));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

const _gradientScratch = new THREE.Color();

/** Vertical gradient: stem color at bottom → accent at top (no artificial brightening) */
function applyBarVertexGradient(geometry, bottomColor, topColor, barHeight = BASE_HEIGHT) {
  const pos = geometry.attributes.position;
  let attr = geometry.attributes.color;
  if (!attr || attr.count !== pos.count) {
    attr = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
    geometry.setAttribute("color", attr);
  }

  const halfH = barHeight / 2;
  const bottom = bottomColor.isColor ? bottomColor : new THREE.Color(bottomColor);
  const top = topColor.isColor ? topColor : new THREE.Color(topColor);

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, (y + halfH) / barHeight));
    _gradientScratch.copy(bottom).lerp(top, t);
    attr.setXYZ(i, _gradientScratch.r, _gradientScratch.g, _gradientScratch.b);
  }

  attr.needsUpdate = true;
}

function createGradientBarGeometry(width, height, depth, bottomColor, topColor) {
  const geo = new THREE.BoxGeometry(width, height, depth);
  applyBarVertexGradient(geo, bottomColor, topColor, height);
  return geo;
}

export class Visualizer3D {
  constructor(container) {
    this.container = container;
    this.analysers = new Map();
    this.masterAnalyser = null;
    this.masterMetricState = null;
    this.muted = new Map();
    this.metricStates = new Map();
    this.smoothMetrics = new Map();
    this.smoothGlobal = { energy: 0, speed: 0, peak: 0 };
    this.barData = new Map();
    this.running = false;
    this.isPlaying = false;
    this.clock = new THREE.Clock();
    this.visualTime = 0;
    this.timeScale = PAUSED_TIME_SCALE;
    this.playbackBlend = 0;
    this._raf = null;

    const w = container.clientWidth || 800;
    const h = container.clientHeight || 420;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe2e2e5);
    this.scene.fog = null;

    this.camera = new THREE.PerspectiveCamera(42, w / h, 0.1, 100);
    this.camera.position.set(0, 2.4, 7.5);
    this.camera.lookAt(0, 0.85, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this._setupTouchControls();

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72));
    const dir = new THREE.DirectionalLight(0xffffff, 0.48);
    dir.position.set(4, 8, 6);
    this.scene.add(dir);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    for (const cfg of STEM_CONFIG) {
      this._buildStemCluster(cfg);
      this.muted.set(cfg.id, false);
      this.smoothMetrics.set(cfg.id, {
        rms: 0,
        peak: 0,
        centroid: 0,
        flux: 0,
        brightness: 0,
        low: 0,
        mid: 0,
        high: 0,
      });
    }

    this._onResize = () => this.resize();
    window.addEventListener("resize", this._onResize);
    window.addEventListener("orientationchange", this._onResize);
    this._onViewportResize = () => this.resize();
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", this._onViewportResize);
    }
  }

  _setupTouchControls() {
    const el = this.renderer.domElement;
    const c = this.controls;

    el.style.touchAction = "none";
    el.style.webkitTapHighlightColor = "transparent";

    c.target.set(0, 0.85, 0);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 3;
    c.maxDistance = 22;
    c.maxPolarAngle = Math.PI * 0.48;
    c.enableZoom = true;
    c.enableRotate = true;
    c.enablePan = true;
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 0.9;
    c.panSpeed = 0.7;
    c.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    c.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    c.update();

    this._blockCanvasScroll = (e) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchmove", this._blockCanvasScroll, { passive: false });
  }

  _buildStemCluster(cfg) {
    const group = new THREE.Group();
    group.position.copy(cfg.center);
    const baseColor = new THREE.Color(cfg.color);
    const accentColor = new THREE.Color(cfg.accent);
    const bars = [];

    for (let i = 0; i < cfg.count; i++) {
      const barBase = baseColor.clone();
      const barBright = accentColor.clone();
      const geo = createGradientBarGeometry(
        BAR_WIDTH,
        BASE_HEIGHT,
        BAR_DEPTH,
        barBase,
        barBright
      );
      const mat = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        color: 0xffffff,
        emissive: accentColor.clone(),
        emissiveIntensity: 0.32,
        toneMapped: false,
        transparent: true,
        opacity: 0.68 + Math.random() * 0.22,
        roughness: 0.32,
        metalness: 0.04,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geo, mat);
      const angle = (i / cfg.count) * Math.PI * 2;
      const radius = 0.4 + Math.random() * 1.4;
      const bx = Math.cos(angle) * radius * (0.6 + Math.random() * 0.8);
      const bz = Math.sin(angle) * radius * (0.6 + Math.random() * 0.8);
      const anchorY = 0.1 + Math.random() * 0.65;
      const h = 0.5 + Math.random() * 1.8;

      mesh.position.set(bx, anchorY, bz);
      mesh.rotation.y = (Math.random() - 0.5) * 0.4;
      mesh.scale.set(1, h, 1);

      group.add(mesh);
      bars.push({
        mesh,
        baseX: bx,
        baseY: anchorY,
        anchorY,
        baseZ: bz,
        baseScaleY: h,
        baseRotY: mesh.rotation.y,
        phase: Math.random() * Math.PI * 2,
        baseColor: barBase,
        brightColor: barBright,
        accentColor,
        smoothHeight: 1,
        motionScaleY: h,
      });
    }

    this.root.add(group);
    this.barData.set(cfg.id, { cfg, bars, group, floatPhase: Math.random() * Math.PI * 2 });
  }

  setAnalysers(map) {
    this.analysers = map;
    this.metricStates.clear();
    for (const [id, analyser] of map) {
      this.metricStates.set(id, createMetricState(analyser.fftSize));
    }
  }

  setMasterAnalyser(analyser) {
    this.masterAnalyser = analyser;
    this.masterMetricState = analyser ? createMetricState(analyser.fftSize) : null;
  }

  setPlaybackState(playing) {
    this.isPlaying = playing;
    if (playing) this.playbackBlend = Math.max(this.playbackBlend, 0.15);
  }

  setMuted(stemId, muted) {
    this.muted.set(stemId, muted);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.controls.update();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }

  startIdle() {
    this.setPlaybackState(false);
    this.start();
  }

  _smoothMetric(id, raw, rate) {
    const prev = this.smoothMetrics.get(id);
    const next = {
      rms: lerp(prev.rms, raw.rms ?? 0, rate),
      peak: lerp(prev.peak, raw.peak ?? 0, rate),
      centroid: lerp(prev.centroid, raw.centroid ?? 0, rate),
      flux: lerp(prev.flux, raw.flux ?? 0, rate),
      brightness: lerp(prev.brightness, raw.brightness ?? 0, rate),
      low: lerp(prev.low, raw.low ?? 0, rate),
      mid: lerp(prev.mid, raw.mid ?? 0, rate),
      high: lerp(prev.high, raw.high ?? 0, rate),
    };
    this.smoothMetrics.set(id, next);
    return next;
  }

  _smoothGlobal(raw, rate) {
    this.smoothGlobal.energy = lerp(this.smoothGlobal.energy, raw.energy, rate);
    this.smoothGlobal.speed = lerp(this.smoothGlobal.speed, raw.speed, rate);
    this.smoothGlobal.peak = lerp(this.smoothGlobal.peak, raw.peak, rate);
    return this.smoothGlobal;
  }

  _readGlobalMix() {
    let master = { rms: 0, peak: 0, flux: 0, brightness: 0 };
    if (this.masterAnalyser && this.masterMetricState) {
      master = readStemMetrics(this.masterAnalyser, this.masterMetricState);
    }

    let sum = 0;
    let count = 0;
    for (const cfg of STEM_CONFIG) {
      if (this.muted.get(cfg.id)) continue;
      sum += this.smoothMetrics.get(cfg.id).rms;
      count++;
    }
    const avg = count > 0 ? sum / count : 0;

    return {
      energy: master.rms * 0.55 + avg * 0.45,
      speed: master.rms * 0.4 + master.flux * 0.35 + avg * 0.25,
      peak: master.peak,
    };
  }

  _updatePlaybackBlend() {
    const target = this.isPlaying ? 1 : 0;
    const rate = this.isPlaying ? PLAYBACK_BLEND_PLAY : PLAYBACK_BLEND_PAUSE;
    this.playbackBlend = lerp(this.playbackBlend, target, rate);
    return this.playbackBlend;
  }

  _updateTimeScale(global) {
    const playingTarget =
      PLAYING_TIME_SCALE_MIN + global.energy * 2.4 + global.speed * 1.1 + global.peak * 0.35;
    const target = lerp(PAUSED_TIME_SCALE, playingTarget, this.playbackBlend);
    this.timeScale = lerp(this.timeScale, target, 0.06);
    return this.timeScale;
  }

  /** Shared subtle coalesce wave — per-stem signature tweaks drive/phase */
  _coalesceWave(cfg, t, m, motion) {
    let phase = 0;
    let rate = 2.1;
    let drive = m.rms;

    switch (cfg.signature) {
      case "snap":
        drive = m.rms;
        break;
      case "offset":
        phase = Math.PI;
        rate = 1.05;
        drive = m.low * 0.72 + m.rms * 0.28;
        break;
      case "open":
        drive = m.mid * 0.45 + m.brightness * 0.4 + m.rms * 0.15;
        break;
      case "depth":
        rate = 1.5 + m.flux * 1.5;
        drive = m.flux * 0.55 + m.rms * 0.25 + m.high * 0.2;
        break;
    }

    const safeDrive = Number.isFinite(drive) ? drive : 0;
    const visDrive = Math.max(0.12, safeDrive) * motion;
    const wave = Math.sin(t * rate + phase + visDrive * 3) * 0.5 + 0.5;
    let spread = COALESCE_SPREAD_BASE + wave * (COALESCE_SPREAD_WAVE + visDrive * COALESCE_SPREAD_ENERGY);
    if (cfg.signature === "snap") spread += m.peak * 0.04;

    const together = 1 - Math.min(1, (spread - COALESCE_SPREAD_BASE) / 0.12);
    return { wave, spread, together, drive };
  }

  _applyCategoryMotion(cfg, bars, group, t, m, motion) {
    if (cfg.motion !== "coalesce") return;

    const { wave, spread, together, drive } = this._coalesceWave(cfg, t, m, motion);

    group.rotation.y = 0;
    const unity = 1 - wave * 0.2 * motion;
    group.scale.setScalar(1 - (1 - unity) * COALESCE_GROUP_PULSE * motion - drive * 0.03 * motion);

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const mesh = b.mesh;
      const delta = spread - COALESCE_SPREAD_BASE;
      let xMul = spread;
      let zMul = spread;
      let heightExtra = (together * COALESCE_HEIGHT_PULSE + drive * 0.1) * motion;
      let colorMix = together * 0.15 + drive * 0.25;
      let opacity = 0.4 + together * 0.08 + drive * 0.3;

      switch (cfg.signature) {
        case "snap": {
          const radial = Math.hypot(b.baseX, b.baseZ);
          const snap = m.peak * (radial > 1.0 ? 0.05 : 0.03);
          xMul += snap;
          zMul += snap;
          colorMix += m.peak * 0.45;
          opacity += m.peak * 0.2;
          break;
        }
        case "offset":
          xMul = spread;
          zMul = spread;
          heightExtra = together * COALESCE_HEIGHT_PULSE * 0.6 + m.low * 0.05;
          colorMix = m.low * 0.35 + together * 0.1;
          break;
        case "open":
          heightExtra += m.brightness * 0.12 + m.mid * 0.08;
          colorMix = m.brightness * 0.7 + m.mid * 0.25 + together * 0.08;
          opacity += m.brightness * 0.15;
          break;
        case "depth": {
          const barWave =
            Math.sin(t * (1.5 + m.flux * 1.2) + b.phase * 0.55) * 0.5 + 0.5;
          const zShift = (barWave - 0.5) * 0.14 * (0.4 + m.flux);
          xMul = spread;
          zMul = spread;
          colorMix = m.flux * 0.45 + m.brightness * 0.3 + together * 0.08;
          opacity += m.flux * 0.12;
          mesh.position.z = b.baseZ * zMul + zShift;
          break;
        }
      }

      if (cfg.signature !== "depth") {
        mesh.position.z = b.baseZ * zMul;
      }
      mesh.position.x = b.baseX * xMul;
      const sy = Math.max(0.4, b.baseScaleY * (0.92 + heightExtra));
      b.motionScaleY = sy;
      mesh.scale.x = 1 - (1 - together) * COALESCE_WIDTH_PULSE;
      mesh.scale.z = mesh.scale.x;
      mesh.rotation.y = b.baseRotY;
      this._updateBarGradient(b, colorMix);
      const emitColor = lerpColor(b.baseColor, b.brightColor, 0.45 + colorMix * 0.55);
      mesh.material.emissive.copy(emitColor);
      mesh.material.emissiveIntensity = 0.2 + colorMix * 0.45;
      mesh.material.opacity = Math.max(0.58, Math.min(0.92, opacity));
    }
  }

  /** Surface + glow use the same stem hues (default → accent) */
  _updateBarGradient(bar, mix) {
    const bottom = bar.baseColor;
    const top = lerpColor(bar.baseColor, bar.brightColor, 0.55 + mix * 0.45);
    applyBarVertexGradient(bar.mesh.geometry, bottom, top, BASE_HEIGHT);
  }

  /** Bar length from live frequency bins (per stem band) */
  _applyFrequencyLength(cfg, bars, stemId, rate, motion) {
    const analyser = this.analysers.get(stemId);
    const state = this.metricStates.get(stemId);
    const n = bars.length;
    const binCount = state?.freq?.length ?? 0;

    for (let i = 0; i < n; i++) {
      const b = bars[i];
      let target = 1;
      if (this.isPlaying && analyser && state && binCount > 0 && motion > 0.02) {
        const bin = barFrequencyBin(i, n, binCount, cfg.signature);
        const level = state.freq[bin] / 255;
        const live = FREQ_LEN_MIN + level * (FREQ_LEN_MAX - FREQ_LEN_MIN);
        target = lerp(1, live, motion);
      }
      b.smoothHeight = lerp(b.smoothHeight, target, rate);
      const sy = Math.max(0.35, (b.motionScaleY ?? b.baseScaleY) * b.smoothHeight);
      b.mesh.scale.y = sy;
    }
  }

  /** Subtle vertical float — bars levitate around anchor, not locked to a ground plane */
  _applyLevitation(cfg, bars, group, floatPhase, t, m, g, motion) {
    const energy = (m.rms * 0.55 + m.peak * 0.25 + g.energy * 0.2) * motion;
    const idle = LEVITATE_IDLE * (0.25 + 0.75 * motion);
    const stemBob =
      Math.sin(t * (0.75 + m.low * 0.4) + floatPhase) * (idle + energy * LEVITATE_STEM_AMP) +
      Math.sin(t * 1.35 + floatPhase * 1.3) * energy * 0.08;
    group.position.y = cfg.center.y + stemBob;

    for (const b of bars) {
      const barBob =
        Math.sin(t * (1.05 + m.flux * 0.5) + b.phase) * (idle + energy * LEVITATE_BAR_AMP) +
        Math.sin(t * 2.2 + b.phase * 1.6) * (m.brightness * 0.07 + m.mid * 0.05) * motion +
        m.peak * 0.05 * Math.sin(b.phase * 3) * motion;
      b.mesh.position.y = (b.anchorY ?? b.baseY) + barBob;
    }
  }

  /** Reset cluster to rest pose — used when stem motion is off (mute button) */
  _applyStaticPose(cfg, bars, group, rate) {
    group.position.copy(cfg.center);
    group.rotation.set(0, 0, 0);
    const gs = lerp(group.scale.x, DISABLED_GROUP_SCALE, rate);
    group.scale.setScalar(gs);

    for (const b of bars) {
      b.smoothHeight = lerp(b.smoothHeight, DISABLED_BAR_SCALE, rate);
      b.motionScaleY = b.baseScaleY * DISABLED_BAR_SCALE;
      const mesh = b.mesh;
      const sy = b.baseScaleY * b.smoothHeight;
      const ay = b.anchorY ?? b.baseY;
      mesh.position.set(b.baseX * DISABLED_SPREAD, ay - 0.12, b.baseZ * DISABLED_SPREAD);
      mesh.rotation.set(0, b.baseRotY, 0);
      mesh.scale.set(DISABLED_SPREAD, sy, DISABLED_SPREAD);
      this._updateBarGradient(b, 0);
      mesh.material.emissive.copy(b.baseColor);
      mesh.material.emissiveIntensity = lerp(mesh.material.emissiveIntensity, 0.15, rate);
      mesh.material.opacity = lerp(mesh.material.opacity, STATIC_OPACITY, rate);
    }
  }

  /** Universal energy, speed & rotation on every bar */
  _applyUniversalLayer(bars, t, g, stemEnergy, motion) {
    const e = (g.energy * 0.65 + stemEnergy * 0.35) * motion;
    const s = g.speed * motion;
    const rotRate = (0.2 + s * 1.4 + e * 0.9) * this.timeScale * motion;
    const scalePulse = 1 + e * 0.14 + s * 0.1 + g.peak * 0.08 * motion;

    for (const b of bars) {
      const mesh = b.mesh;
      mesh.rotation.y = b.baseRotY + t * rotRate + Math.sin(t * 1.8 + b.phase) * e * 0.22;
      mesh.rotation.x = Math.sin(t * 1.1 + b.phase * 0.6) * e * 0.1 * s;
      mesh.rotation.z = Math.cos(t * 0.85 + b.phase) * s * 0.08;
      const sx = mesh.scale.x * scalePulse;
      mesh.scale.x = sx;
      mesh.scale.z = sx;
      mesh.material.opacity = Math.max(
        0.58,
        Math.min(0.92, mesh.material.opacity * (0.96 + e * 0.04))
      );
    }
  }

  _tick() {
    if (!this.running) return;

    const dt = Math.min(this.clock.getDelta(), 0.05);
    const motion = this._updatePlaybackBlend();
    const smoothRate = lerp(0.035, 0.2, motion);
    const decay = lerp(0.978, 0.992, motion);

    const g = this.isPlaying
      ? this._smoothGlobal(this._readGlobalMix(), smoothRate)
      : this._smoothGlobal(
          {
            energy: this.smoothGlobal.energy * decay,
            speed: this.smoothGlobal.speed * (decay - 0.004),
            peak: this.smoothGlobal.peak * (decay - 0.01),
          },
          smoothRate
        );
    this._updateTimeScale(g);
    const timeStep = lerp(PAUSED_TIME_SCALE * 0.35, this.timeScale, motion);
    this.visualTime += dt * timeStep;
    const t = this.visualTime;

    const rootTarget = (Math.sin(t * 0.12) * 0.2 + g.energy * 0.35) * motion;
    this.root.rotation.y = lerp(this.root.rotation.y, rootTarget, smoothRate);

    for (const cfg of STEM_CONFIG) {
      const stemId = cfg.id;
      const data = this.barData.get(stemId);
      if (!data) continue;

      const zero = {
        rms: 0,
        peak: 0,
        centroid: 0,
        flux: 0,
        brightness: 0,
        low: 0,
        mid: 0,
        high: 0,
      };
      let m;
      if (this.muted.get(stemId)) {
        m = this._smoothMetric(stemId, zero, smoothRate);
      } else if (motion > 0.02) {
        const raw = readStemMetrics(
          this.analysers.get(stemId),
          this.metricStates.get(stemId) ?? createMetricState(2048)
        );
        m = this._smoothMetric(stemId, raw, smoothRate);
      } else {
        const prev = this.smoothMetrics.get(stemId);
        m = this._smoothMetric(
          stemId,
          {
            rms: prev.rms * decay,
            peak: prev.peak * (decay - 0.01),
            centroid: prev.centroid * decay,
            flux: prev.flux * (decay - 0.002),
            brightness: prev.brightness * decay,
            low: prev.low * decay,
            mid: prev.mid * decay,
            high: prev.high * decay,
          },
          smoothRate
        );
      }
      const motionOff = this.muted.get(stemId);
      const freqRate = lerp(0.05, FREQ_LEN_SMOOTH, motion);

      if (motionOff) {
        this._applyStaticPose(cfg, data.bars, data.group, smoothRate);
        continue;
      }

      this._applyCategoryMotion(cfg, data.bars, data.group, t, m, motion);
      this._applyUniversalLayer(data.bars, t, g, m.rms, motion);
      this._applyFrequencyLength(cfg, data.bars, stemId, freqRate, motion);
      this._applyLevitation(cfg, data.bars, data.group, data.floatPhase, t, m, g, motion);
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this._raf = requestAnimationFrame(() => this._tick());
  }

  dispose() {
    this.stop();
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("orientationchange", this._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this._onViewportResize);
    }
    const el = this.renderer?.domElement;
    if (el && this._blockCanvasScroll) {
      el.removeEventListener("touchmove", this._blockCanvasScroll);
    }
    this.controls.dispose();
    this.renderer.dispose();
    this.container.removeChild(this.renderer.domElement);
    for (const data of this.barData.values()) {
      for (const b of data.bars) {
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
      }
    }
  }
}

export { STEM_CONFIG };
