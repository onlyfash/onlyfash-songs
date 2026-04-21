/* ── Track config ── */

const TRACKS = {
  slowDance: 'audio/Fash - Slow Dance.mp3',
  passengerSide: 'audio/Fash - Passenger Side.mp3'
};

/* ── DOM refs ── */

const panelSD  = document.getElementById('panelSlowDance');
const panelPS  = document.getElementById('panelPassengerSide');
const audioSD  = document.getElementById('audioSlowDance');
const audioPS  = document.getElementById('audioPassengerSide');
const canvasSD = document.getElementById('canvasSlowDance');
const canvasPS = document.getElementById('canvasPassengerSide');

const panels = [
  { panel: panelSD, audio: audioSD, canvas: canvasSD, name: 'Slow Dance' },
  { panel: panelPS, audio: audioPS, canvas: canvasPS, name: 'Passenger Side' }
];

/* ── Reduced motion ── */

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── Web Audio ── */

let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function initAudioNode(audio) {
  if (audio._analyser) return audio._analyser;
  const source = audioCtx.createMediaElementSource(audio);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  audio._source = source;
  audio._analyser = analyser;
  return analyser;
}

/* ── Canvas sizing ── */

function resizeCanvas(canvas) {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(rect.width  * dpr);
  canvas.height = Math.round(rect.height * dpr);
}

if (!prefersReducedMotion) {
  resizeCanvas(canvasSD);
  resizeCanvas(canvasPS);
  window.addEventListener('resize', () => {
    resizeCanvas(canvasSD);
    resizeCanvas(canvasPS);
  });
}

/* ── Slow Dance visualizer state ── */

const sdState = {
  bassPunchLevel: 0,
  lastBassEnergy: 0
};

/* ── Passenger Side visualizer state ── */

const psWaveHistory = [];
let psDriftPhase = 0;

/* ── drawSlowDance — Liquid Bloom ── */

function drawSlowDance(ctx, analyser, W, H) {
  ctx.clearRect(0, 0, W, H);

  const bufLen = analyser.frequencyBinCount; // 1024
  const freq = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(freq);

  // Bass: bins 0–8, normalized 0–1
  let bassSum = 0;
  for (let i = 0; i < 9; i++) bassSum += freq[i];
  const bassEnergy = bassSum / 9 / 255;

  // Mids: bins 20–100
  let midSum = 0;
  for (let i = 20; i < 100; i++) midSum += freq[i];
  const midEnergy = midSum / 80 / 255;

  // RMS overall volume
  let rmsSum = 0;
  for (let i = 0; i < bufLen; i++) rmsSum += freq[i] * freq[i];
  const rms = Math.sqrt(rmsSum / bufLen) / 255;

  // Bass punch: trigger on sudden loud bass hit, decay over ~200ms (~12 frames at 60fps)
  if (bassEnergy > 0.6 && bassEnergy > sdState.lastBassEnergy + 0.1) {
    sdState.bassPunchLevel = 1.0;
  }
  sdState.lastBassEnergy = bassEnergy;
  sdState.bassPunchLevel = Math.max(0, sdState.bassPunchLevel - 1 / 12);

  const shorter = Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;
  const t = performance.now() / 1000;
  const orbitSpeed = 0.08 + rms * 0.3;

  const BLOBS = [
    { rgb: [74,  24,  66], baseR: 0.22, orbitR: 0.08, tMul: 1.00 },
    { rgb: [45,  10,  58], baseR: 0.18, orbitR: 0.12, tMul: 0.70 },
    { rgb: [107, 26,  92], baseR: 0.20, orbitR: 0.10, tMul: 1.30 },
    { rgb: [61,  18,  80], baseR: 0.16, orbitR: 0.09, tMul: 0.85 },
    { rgb: [85,  15,  72], baseR: 0.19, orbitR: 0.07, tMul: 1.10 },
    { rgb: [35,   8,  50], baseR: 0.25, orbitR: 0.14, tMul: 0.60 },
  ];

  ctx.save();
  ctx.filter = 'blur(40px)';
  ctx.globalCompositeOperation = 'screen';

  for (let i = 0; i < BLOBS.length; i++) {
    const { rgb, baseR, orbitR, tMul } = BLOBS[i];
    const phaseOff = (i / BLOBS.length) * Math.PI * 2;
    const angle = phaseOff + t * orbitSpeed * tMul;
    const orbit = shorter * orbitR;
    const bx = cx + Math.cos(angle) * orbit;
    const by = cy + Math.sin(angle * 0.71) * orbit;

    const radius = shorter * baseR
      * (1 + bassEnergy * 1.8)
      * (1 + sdState.bassPunchLevel * 1.3);

    const alpha = 0.4 + midEnergy * 0.3;
    const [r, g, b] = rgb;

    const grad = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
    grad.addColorStop(0,   `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.6, `rgba(${r},${g},${b},0.4)`);
    grad.addColorStop(1,   `rgba(${r},${g},${b},0)`);

    ctx.globalAlpha = alpha;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(bx, by, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/* ── drawPassengerSide — Horizontal Waveform ── */

function drawPassengerSide(ctx, analyser, W, H) {
  ctx.clearRect(0, 0, W, H);

  const fftSize = analyser.fftSize; // 2048
  const wave = new Uint8Array(fftSize);
  analyser.getByteTimeDomainData(wave);

  // Keep a rolling buffer of recent waveform frames for echo/ghost lines
  psWaveHistory.push(new Uint8Array(wave));
  if (psWaveHistory.length > 8) psWaveHistory.shift();

  const freqLen = analyser.frequencyBinCount; // 1024
  const freq = new Uint8Array(freqLen);
  analyser.getByteFrequencyData(freq);

  // Overall energy for amplitude scaling
  let energySum = 0;
  for (let i = 0; i < freqLen; i++) energySum += freq[i];
  const energy = energySum / freqLen / 255;

  // Treble peak: bins 400–700 — brightens the main line's glow
  const trebleEnd = Math.min(700, freqLen);
  let trebleSum = 0;
  for (let i = 400; i < trebleEnd; i++) trebleSum += freq[i];
  const trebleEnergy = trebleEnd > 400 ? trebleSum / (trebleEnd - 400) / 255 : 0;

  // Amplitude grows with energy: quiet = thin flex, loud = big swing
  const amplitudeScale = H * (0.06 + energy * 0.30) / 128;

  // Slow sinusoidal horizontal drift — keeps motion alive between notes
  psDriftPhase += 0.002;
  const driftX = Math.sin(psDriftPhase) * 8;

  const centerY = H * 0.5;
  const echoOffset  = H * 0.07;  // ~35px at 500px height
  const ghostOffset = H * 0.14;  // ~70px at 500px height
  const SAMPLES = 256;
  const step = Math.floor(fftSize / SAMPLES);

  function drawLine(waveData, yOffset, alpha, glowMult) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(220, 230, 245, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = (trebleEnergy > 0.5 ? 20 : 12) * glowMult;
    ctx.shadowColor = 'rgba(180, 200, 230, 0.6)';
    ctx.beginPath();
    for (let i = 0; i < SAMPLES; i++) {
      const x = (i / (SAMPLES - 1)) * W + driftX;
      const sVal = waveData[i * step] ?? 128;
      const y = centerY + yOffset + (sVal - 128) * amplitudeScale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Ghost line — oldest available frame, maximum offset
  if (psWaveHistory.length >= 6) {
    drawLine(psWaveHistory[psWaveHistory.length - 6], ghostOffset, 0.10, 0.5);
  }

  // Echo line — a few frames behind, intermediate offset
  if (psWaveHistory.length >= 3) {
    drawLine(psWaveHistory[psWaveHistory.length - 3], echoOffset, 0.35, 0.8);
  }

  // Main line — current frame
  drawLine(wave, 0, 1.0, 1.0);
}

/* ── RAF loop ── */

let rafId = null;
let activeEntry = null;

function rafLoop() {
  if (!activeEntry) {
    rafId = null;
    return;
  }

  const { canvas, audio, panel } = activeEntry;
  const analyser = audio._analyser;

  if (analyser && canvas.width > 0 && canvas.height > 0) {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.width  / dpr;
    const H   = canvas.height / dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (panel.id === 'panelSlowDance') {
      drawSlowDance(ctx, analyser, W, H);
    } else {
      drawPassengerSide(ctx, analyser, W, H);
    }
  }

  rafId = requestAnimationFrame(rafLoop);
}

function setCanvasVisible(canvas, visible) {
  canvas.style.transition = `opacity ${visible ? 0.6 : 0.4}s ease`;
  canvas.style.opacity = visible ? '1' : '0';
}

/* ── Playback logic ── */

function handlePanelActivate(active) {
  const other = panels.find(p => p !== active);

  if (active.audio.paused) {
    // Stop the other track
    other.audio.pause();
    other.audio.currentTime = 0;
    other.panel.classList.remove('is-playing');
    if (!prefersReducedMotion) setCanvasVisible(other.canvas, false);
    updateAriaLabel(other);

    // Init Web Audio on first user gesture (required by autoplay policy)
    ensureAudioContext();
    initAudioNode(active.audio);

    // Play
    active.audio.play();
    active.panel.classList.add('is-playing');

    if (!prefersReducedMotion) {
      psWaveHistory.length = 0; // clear echo buffer when switching tracks
      setCanvasVisible(active.canvas, true);
      activeEntry = active;
      if (!rafId) rafId = requestAnimationFrame(rafLoop);
    }
  } else {
    // Pause
    active.audio.pause();
    active.panel.classList.remove('is-playing');

    if (!prefersReducedMotion) {
      setCanvasVisible(active.canvas, false);
      activeEntry = null;
    }
  }

  updateAriaLabel(active);
}

function updateAriaLabel(entry) {
  const state = entry.panel.classList.contains('is-playing') ? 'playing' : 'paused';
  entry.panel.setAttribute('aria-label', `${entry.name} — ${state}. Click to ${state === 'playing' ? 'pause' : 'play'}.`);
}

/* ── Event binding ── */

panels.forEach(entry => {
  entry.panel.addEventListener('click', () => handlePanelActivate(entry));

  entry.panel.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      handlePanelActivate(entry);
    }
  });

  entry.panel.addEventListener('pointerenter', () => entry.panel.classList.add('is-hover'));
  entry.panel.addEventListener('pointerleave', () => entry.panel.classList.remove('is-hover'));

  entry.audio.addEventListener('ended', () => {
    entry.panel.classList.remove('is-playing');
    if (!prefersReducedMotion) {
      setCanvasVisible(entry.canvas, false);
      if (activeEntry === entry) activeEntry = null;
    }
    updateAriaLabel(entry);
  });

  updateAriaLabel(entry);
});
