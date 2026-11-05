/**
 * SOLDADURA SANJO SIMULATOR — versión Android táctil
 *
 * Controles:
 *  - Arrastra un dedo por la pantalla para mover la antorcha (la punta queda
 *    un poco ARRIBA del dedo para que no la tape).
 *  - Mantén el botón SOLDAR con el otro pulgar (o activa "Auto-soldar al tocar").
 */
(() => {
'use strict';

/* ====================================================================
 * Utilidades
 * ==================================================================== */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const canvas = $('gameCanvas');
const ctx = canvas.getContext('2d');

const LEVEL_TIME_LIMIT = 90; // segundos (01:30)
const TICK_RATE = 60;        // las mediciones de soldadura corren a 60 Hz fijos (independiente de los Hz de la pantalla)
const HOT_TIME = 1.5;        // segundos que tarda un cordón en enfriarse

const LEVELS = {
  medialuna:    { name: '1. Media luna',   desc: 'Arcos cóncavos continuos.' },
  zigzag_curvo: { name: '2. Zigzag curvo', desc: 'Ondulaciones horizontales.' },
  triangulo:    { name: '3. Triángulo',    desc: 'Vértices triangulares agudos.' },
  rectangulo:   { name: '4. Rectángulo',   desc: 'Ángulos de 90° e hilada cuadrada.' },
  ocho:         { name: '5. Ocho',         desc: 'Lazos cruzados continuos.' },
  circulos:     { name: '6. Círculos',     desc: 'Espirales circulares superpuestas.' }
};

/* ====================================================================
 * Ajustes y récords (persisten en el teléfono)
 * ==================================================================== */
const store = {
  get(key, fallback) {
    try { return Object.assign({}, fallback, JSON.parse(localStorage.getItem(key) || '{}')); }
    catch (e) { return Object.assign({}, fallback); }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
};
const settings = store.get('sanjo.settings', { autoWeld: false, haptics: true, sound: true, lefty: false });
const bestScores = store.get('sanjo.best', {});

/* ====================================================================
 * Estado del juego
 * ==================================================================== */
let state = 'MENU'; // MENU | PLAYING | PAUSED | RESULTS
let selectedLevel = 'medialuna';

let W = 0, H = 0, DPR = 1, U = 1; // U = factor de escala según el alto de pantalla
let guidePath = [];

let score = 0;
let precisionAcc = [];
let precisionSum = 0;
let weldCount = 0;
let heat = 0;
let isOverheated = false;
let isWelding = false;
let timeRemaining = LEVEL_TIME_LIMIT;
let lastTimerSecond = -1;
let gameTime = 0;
let tickAcc = 0;

// Antorcha / entrada táctil
const tip = { x: 0, y: 0 };      // punta de la antorcha (suavizada)
const target = { x: 0, y: 0 };   // dónde quiere el dedo la punta
const finger = { x: 0, y: 0 };   // posición real del dedo
let torchPointer = null;
let weldHeld = false;
let hasTorch = false;

// Partículas y cordón
let sparks = [];
let smokes = [];
let hotBeads = [];

// Capas pre-renderizadas (para que el celular no redibuje todo en cada frame)
const staticLayer = document.createElement('canvas'); // fondo + guía
const beadLayer = document.createElement('canvas');   // cordón ya frío
const staticCtx = staticLayer.getContext('2d');
const beadCtx = beadLayer.getContext('2d');

/* ====================================================================
 * Háptica (Capacitor en la app; navigator.vibrate como respaldo)
 * ==================================================================== */
const Cap = window.Capacitor;
const Haptics = Cap && Cap.Plugins && Cap.Plugins.Haptics;
let lastWarnBuzz = 0;

function buzz(kind) {
  if (!settings.haptics) return;
  try {
    if (Haptics) {
      if (kind === 'start') Haptics.impact({ style: 'MEDIUM' });
      else if (kind === 'heavy') Haptics.impact({ style: 'HEAVY' });
      else if (kind === 'warn') Haptics.vibrate({ duration: 25 });
      else Haptics.impact({ style: 'LIGHT' });
    } else if (navigator.vibrate) {
      navigator.vibrate(kind === 'heavy' ? 200 : kind === 'warn' ? 25 : 15);
    }
  } catch (e) {}
}

/* ====================================================================
 * Audio (Web Audio, generado por código: no hay archivos de sonido)
 * ==================================================================== */
let audioCtx = null;
let weld = null;      // { osc, noise, gain } mientras suena el arco
let warnBeepBusy = false;

function initAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(freq, duration, type, vol) {
  if (!settings.sound) return;
  initAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(t); osc.stop(t + duration);
  } catch (e) {}
}
const playUIBeep = (f = 600, d = 0.08) => tone(f, d, 'sine', 0.1);
const playTimerBeep = () => tone(950, 0.15, 'triangle', 0.15);

function startWeldingAudio() {
  if (!settings.sound || weld) return;
  initAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(120, t);

    const size = Math.floor(audioCtx.sampleRate * 0.5);
    const buffer = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    const noise = audioCtx.createBufferSource();
    noise.buffer = buffer; noise.loop = true;

    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1200, t);
    filter.Q.setValueAtTime(1.5, t);

    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.15, t);

    osc.connect(filter); noise.connect(filter);
    filter.connect(gain); gain.connect(audioCtx.destination);
    osc.start(); noise.start();
    weld = { osc, noise, gain };
  } catch (e) { weld = null; }
}

function stopWeldingAudio() {
  if (!weld) return;
  const w = weld;
  weld = null; // se libera YA, así un nuevo arco puede sonar enseguida
  try {
    w.gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
    setTimeout(() => {
      try { w.osc.stop(); w.noise.stop(); w.osc.disconnect(); w.noise.disconnect(); w.gain.disconnect(); } catch (e) {}
    }, 70);
  } catch (e) {}
}

function playWarningSound() {
  if (warnBeepBusy) return;
  warnBeepBusy = true;
  tone(880, 0.1, 'square', 0.08);
  setTimeout(() => { warnBeepBusy = false; }, 120);
}

/* ====================================================================
 * Trazados de los 6 niveles (función pura: sirve para el juego y las miniaturas)
 * ==================================================================== */
function buildPath(key, w, h, opts) {
  const ampK = (opts && opts.ampK) || 0.16;
  const tolK = (opts && opts.tolK) || 1;
  const pts = [];
  const margin = w * 0.12;
  const startX = margin, endX = w - margin;
  const cy = h * 0.5;
  const amp = h * ampK;
  const push = (x, y, tol) => pts.push({ x, y, tolerance: tol * tolK });

  if (key === 'medialuna') {
    const repeat = 12, stepX = (endX - startX) / repeat, sub = 12;
    for (let i = 0; i < repeat; i++) {
      const x0 = startX + i * stepX, x1 = startX + (i + 1) * stepX;
      for (let j = 0; j <= sub; j++) {
        const t = j / sub;
        push(x0 + (x1 - x0) * t, cy + Math.sin(t * Math.PI) * amp, 22);
      }
    }
  } else if (key === 'zigzag_curvo') {
    const steps = 150, freq = 7;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      push(startX + (endX - startX) * t, cy + Math.sin(t * Math.PI * 2 * freq) * amp, 22);
    }
  } else if (key === 'triangulo') {
    const repeat = 9, stepX = (endX - startX) / repeat;
    for (let i = 0; i < repeat; i++) {
      const x0 = startX + i * stepX, xm = x0 + stepX * 0.5, x1 = x0 + stepX;
      for (let j = 0; j <= 6; j++) { const t = j / 6; push(x0 + (xm - x0) * t, cy - amp * t, 20); }
      for (let j = 0; j <= 6; j++) { const t = j / 6; push(xm + (x1 - xm) * t, (cy - amp) + amp * t, 20); }
    }
  } else if (key === 'rectangulo') {
    const repeat = 7, stepX = (endX - startX) / repeat;
    for (let i = 0; i < repeat; i++) {
      const x0 = startX + i * stepX, x1 = x0 + stepX * 0.5, x2 = x0 + stepX;
      for (let j = 0; j <= 4; j++) push(x0, cy - amp * j / 4, 20);
      for (let j = 0; j <= 4; j++) push(x0 + (x1 - x0) * (j / 4), cy - amp, 20);
      for (let j = 0; j <= 4; j++) push(x1, (cy - amp) + amp * j / 4, 20);
      for (let j = 0; j <= 4; j++) push(x1 + (x2 - x1) * (j / 4), cy, 20);
    }
  } else if (key === 'ocho') {
    const steps = 180, freq = 6;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      push(startX + (endX - startX) * t, cy + Math.sin(t * Math.PI * 2 * freq * 2) * (amp * 0.85), 22);
    }
  } else if (key === 'circulos') {
    const loops = 8, stepX = (endX - startX) / loops, r = amp * 0.8, sub = 16;
    for (let i = 0; i < loops; i++) {
      const cx = startX + i * stepX + r;
      for (let j = 0; j <= sub; j++) {
        const a = (j / sub) * Math.PI * 2;
        push(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 22);
      }
    }
  }
  return pts;
}

/* ====================================================================
 * Tamaño de pantalla y capas
 * ==================================================================== */
function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  U = clamp(H / 380, 0.75, 1.6);

  for (const c of [canvas, staticLayer, beadLayer]) {
    c.width = Math.round(W * DPR);
    c.height = Math.round(H * DPR);
  }
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  staticCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  beadCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

  if (state !== 'MENU') guidePath = buildPath(selectedLevel, W, H, { tolK: U * 1.1 });
  drawStaticLayer();
}

function drawStaticLayer() {
  const c = staticCtx;
  c.fillStyle = '#1e293b';
  c.fillRect(0, 0, W, H);

  c.strokeStyle = '#334155';
  c.lineWidth = 1;
  const grid = 40 * U;
  c.beginPath();
  for (let x = 0; x < W; x += grid) { c.moveTo(x, 0); c.lineTo(x, H); }
  for (let y = 0; y < H; y += grid) { c.moveTo(0, y); c.lineTo(W, y); }
  c.stroke();

  if (state !== 'MENU' && guidePath.length > 1) {
    const trace = () => {
      c.beginPath();
      c.moveTo(guidePath[0].x, guidePath[0].y);
      for (let i = 1; i < guidePath.length; i++) c.lineTo(guidePath[i].x, guidePath[i].y);
    };
    c.lineCap = 'round'; c.lineJoin = 'round';
    trace();
    c.strokeStyle = 'rgba(56, 189, 248, 0.35)';
    c.lineWidth = 22 * U;
    c.stroke();
    trace();
    c.strokeStyle = '#0284c7';
    c.lineWidth = 2;
    c.setLineDash([6, 6]);
    c.stroke();
    c.setLineDash([]);
  }
}

/* ====================================================================
 * Entrada táctil
 * ==================================================================== */
const fingerOffset = () => 58 * U; // la punta queda por encima del dedo

function wantWeld() {
  return settings.autoWeld ? torchPointer !== null : weldHeld;
}

function setTargetFromEvent(e) {
  finger.x = clamp(e.clientX, 0, W);
  finger.y = clamp(e.clientY, 0, H);
  target.x = finger.x;
  target.y = clamp(finger.y - fingerOffset(), 0, H);
}

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (state !== 'PLAYING' || torchPointer !== null) return;
  torchPointer = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
  setTargetFromEvent(e);
  tip.x = target.x; tip.y = target.y; // salto directo al primer toque
  hasTorch = true;
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === torchPointer && state === 'PLAYING') setTargetFromEvent(e);
});
const releaseTorch = (e) => { if (e.pointerId === torchPointer) torchPointer = null; };
canvas.addEventListener('pointerup', releaseTorch);
canvas.addEventListener('pointercancel', releaseTorch);

const weldBtn = $('weldBtn');
weldBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  try { weldBtn.setPointerCapture(e.pointerId); } catch (err) {}
  weldHeld = true;
  weldBtn.classList.add('down');
});
const releaseWeld = () => { weldHeld = false; weldBtn.classList.remove('down'); };
weldBtn.addEventListener('pointerup', releaseWeld);
weldBtn.addEventListener('pointercancel', releaseWeld);
weldBtn.addEventListener('lostpointercapture', releaseWeld);

document.addEventListener('contextmenu', (e) => e.preventDefault());

/* ====================================================================
 * Menús
 * ==================================================================== */
function renderMenu() {
  const wrap = $('levels');
  wrap.innerHTML = '';
  Object.keys(LEVELS).forEach((key) => {
    const cfg = LEVELS[key];
    const b = document.createElement('button');
    b.className = 'level' + (key === selectedLevel ? ' sel' : '');
    b.dataset.key = key;
    const best = bestScores[key];
    b.innerHTML =
      `<span class="name">${cfg.name}</span>` +
      `<canvas width="240" height="40"></canvas>` +
      `<span class="desc">${cfg.desc}</span>` +
      `<span class="best">${best ? 'Mejor: ' + best.grade + ' · ' + best.score.toLocaleString('es') : ''}</span>`;
    b.addEventListener('click', () => selectLevel(key));
    wrap.appendChild(b);

    // Miniatura del patrón
    const pc = b.querySelector('canvas').getContext('2d');
    const pts = buildPath(key, 240, 40, { ampK: 0.33 });
    pc.strokeStyle = '#38bdf8'; pc.lineWidth = 2; pc.lineJoin = 'round';
    pc.beginPath();
    pts.forEach((p, i) => (i ? pc.lineTo(p.x, p.y) : pc.moveTo(p.x, p.y)));
    pc.stroke();
  });
  refreshToggles();
}

function refreshToggles() {
  document.querySelectorAll('.toggle').forEach((t) => {
    t.classList.toggle('on', !!settings[t.dataset.setting]);
  });
  $('helpText').textContent = settings.autoWeld
    ? 'Arrastra un dedo: la antorcha suelda mientras la pantalla esté tocada.'
    : 'Arrastra un dedo para mover la antorcha y mantén SOLDAR con el otro pulgar.';
  weldBtn.classList.toggle('lefty', settings.lefty);
}

document.querySelectorAll('.toggle').forEach((t) => {
  t.addEventListener('click', () => {
    const k = t.dataset.setting;
    settings[k] = !settings[k];
    store.set('sanjo.settings', settings);
    refreshToggles();
    if (k === 'sound' && !settings.sound) stopWeldingAudio();
    if (k === 'sound' && settings.sound) playUIBeep(800);
    if (k === 'haptics' && settings.haptics) buzz('start');
  });
});

function selectLevel(key) {
  selectedLevel = key;
  playUIBeep(700);
  document.querySelectorAll('.level').forEach((b) => b.classList.toggle('sel', b.dataset.key === key));
}

const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function startGame() {
  initAudio();
  playUIBeep(900);

  state = 'PLAYING';
  score = 0; precisionAcc = []; precisionSum = 0; weldCount = 0;
  heat = 0; isOverheated = false; isWelding = false;
  timeRemaining = LEVEL_TIME_LIMIT; lastTimerSecond = -1;
  gameTime = 0; tickAcc = 0;
  sparks = []; smokes = []; hotBeads = [];
  torchPointer = null; weldHeld = false; weldBtn.classList.remove('down');
  stopWeldingAudio();

  guidePath = buildPath(selectedLevel, W, H, { tolK: U * 1.1 });
  beadCtx.clearRect(0, 0, W, H);
  drawStaticLayer();

  // La antorcha arranca en el inicio del trazado
  tip.x = target.x = guidePath[0].x;
  tip.y = target.y = guidePath[0].y;
  hasTorch = true;

  ['menu', 'results', 'pause', 'banner'].forEach(hide);
  show('hud');
  if (!settings.autoWeld) show('weldBtn'); else hide('weldBtn');
  $('heatBar').style.width = '0%';
  $('hudTimer').parentElement.classList.remove('danger');
  document.querySelector('.heat').classList.remove('over');
}

function pauseGame() {
  if (state !== 'PLAYING') return;
  state = 'PAUSED';
  isWelding = false;
  torchPointer = null; weldHeld = false; weldBtn.classList.remove('down');
  stopWeldingAudio();
  $('flash').style.opacity = '0';
  show('pause');
}

function resumeGame() {
  if (state !== 'PAUSED') return;
  state = 'PLAYING';
  hide('pause');
}

function returnToMenu() {
  state = 'MENU';
  isWelding = false;
  stopWeldingAudio();
  ['results', 'pause', 'hud', 'banner', 'weldBtn'].forEach(hide);
  show('menu');
  $('flash').style.opacity = '0';
  renderMenu();
  drawStaticLayer();
}

$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);
$('restartBtn').addEventListener('click', startGame);
$('resumeBtn').addEventListener('click', resumeGame);
$('pauseMenuBtn').addEventListener('click', returnToMenu);
$('resultsMenuBtn').addEventListener('click', returnToMenu);
$('pauseBtn').addEventListener('click', pauseGame);

/* ====================================================================
 * Partículas
 * ==================================================================== */
function addSparks(x, y, count) {
  for (let i = 0; i < count && sparks.length < 260; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = (2 + Math.random() * 8) * U * 0.7;
    sparks.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - Math.random() * 2,
      life: 1, decay: 0.03 + Math.random() * 0.05,
      size: (1.5 + Math.random() * 2.5) * U,
      color: Math.random() > 0.3 ? '#38bdf8' : '#f59e0b'
    });
  }
}
function addSmoke(x, y) {
  if (Math.random() > 0.4 || smokes.length > 60) return;
  smokes.push({
    x: x + (Math.random() - 0.5) * 10, y: y - 5,
    vx: (Math.random() - 0.5) * 0.8, vy: -1 - Math.random() * 1.5,
    radius: (4 + Math.random() * 6) * U, life: 0.8, decay: 0.015
  });
}

function stampBead(b) {
  beadCtx.beginPath();
  beadCtx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
  beadCtx.fillStyle = '#94a3b8';
  beadCtx.fill();
  beadCtx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
  beadCtx.lineWidth = 1;
  beadCtx.stroke();
}

function closestGuide(px, py) {
  let best = Infinity, idx = 0;
  for (let i = 0; i < guidePath.length; i++) {
    const dx = px - guidePath[i].x, dy = py - guidePath[i].y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; idx = i; }
  }
  return { distance: Math.sqrt(best), point: guidePath[idx], index: idx };
}

/* ====================================================================
 * Lógica por frame
 * ==================================================================== */
const hudTimer = $('hudTimer');
const hudTimerBox = hudTimer.parentElement;
const heatBox = document.querySelector('.heat');
let hudCache = { prec: '', score: '', heat: -1 };

function updateTimerHUD() {
  const sec = Math.ceil(timeRemaining);
  if (sec === lastTimerSecond) return;
  const warn = timeRemaining <= 10;
  hudTimer.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  hudTimerBox.classList.toggle('danger', warn);
  if (warn) { show('banner'); if (lastTimerSecond !== -1) playTimerBeep(); } else hide('banner');
  lastTimerSecond = sec;
}

// Un "tick" de soldadura (60 por segundo mientras se suelda).
function weldTick() {
  addSparks(tip.x, tip.y, 4);
  addSmoke(tip.x, tip.y);

  const bead = { x: tip.x, y: tip.y, r: (8 + Math.random() * 3) * U, t: gameTime };
  hotBeads.push(bead);
  weldCount++;

  const info = closestGuide(tip.x, tip.y);
  const tol = info.point ? info.point.tolerance : 22 * U;

  if (info.distance <= tol) {
    const p = Math.max(0, 1 - info.distance / tol);
    precisionAcc.push(p); precisionSum += p;
    score += Math.round(10 * p);
    $('flash').style.opacity = '0';
  } else {
    precisionAcc.push(0);
    score = Math.max(0, score - 5);
    $('flash').style.opacity = '1';
    playWarningSound();
    const now = performance.now();
    if (now - lastWarnBuzz > 160) { buzz('warn'); lastWarnBuzz = now; }
  }
  return info.index >= guidePath.length - 2; // true = trazado completado
}

function update(dt) {
  if (state !== 'PLAYING') return;
  gameTime += dt;

  // 1. Cronómetro
  timeRemaining = Math.max(0, timeRemaining - dt);
  updateTimerHUD();
  if (timeRemaining <= 0) { finishGame(); return; }

  // 2. Suavizado de la punta de la antorcha
  const k = 1 - Math.exp(-dt * 40);
  tip.x += (target.x - tip.x) * k;
  tip.y += (target.y - tip.y) * k;

  // 3. Estado de soldadura (según botón / toque)
  const shouldWeld = wantWeld() && !isOverheated;
  if (shouldWeld !== isWelding) {
    isWelding = shouldWeld;
    if (isWelding) { startWeldingAudio(); buzz('start'); } else stopWeldingAudio();
  }

  // 4. Temperatura
  if (isWelding) {
    heat += 15 * dt;
    if (heat >= 100) {
      heat = 100; isOverheated = true; isWelding = false;
      stopWeldingAudio(); playWarningSound(); buzz('heavy');
    }
  } else {
    heat -= 35 * dt;
    if (heat <= 0) { heat = 0; isOverheated = false; }
  }
  const heatPct = Math.round(heat);
  if (heatPct !== hudCache.heat) {
    hudCache.heat = heatPct;
    $('heatBar').style.width = heatPct + '%';
  }
  heatBox.classList.toggle('over', isOverheated);

  // 5. Soldadura a 60 Hz fijos
  if (isWelding) {
    tickAcc += dt * TICK_RATE;
    let n = 0, done = false;
    while (tickAcc >= 1 && n < 4 && !done) { tickAcc -= 1; n++; done = weldTick(); }
    if (tickAcc > 4) tickAcc = 0;
    if (done) { finishGame(); return; }
  } else {
    tickAcc = 0;
    $('flash').style.opacity = '0';
  }

  // 6. Enfriamiento del cordón: lo pasa a la capa estática cuando se enfría
  while (hotBeads.length && gameTime - hotBeads[0].t > HOT_TIME) stampBead(hotBeads.shift());

  // 7. Física de partículas (normalizada a 60 fps)
  const f = dt * 60;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * f; s.y += s.vy * f; s.vy += 0.2 * f; s.life -= s.decay * f;
    if (s.life <= 0) sparks.splice(i, 1);
  }
  for (let i = smokes.length - 1; i >= 0; i--) {
    const s = smokes[i];
    s.x += s.vx * f; s.y += s.vy * f; s.radius += 0.2 * f; s.life -= s.decay * f;
    if (s.life <= 0) smokes.splice(i, 1);
  }

  // 8. HUD
  const prec = precisionAcc.length ? (precisionSum / precisionAcc.length * 100).toFixed(1) : '100.0';
  if (prec !== hudCache.prec) { hudCache.prec = prec; $('hudPrecision').textContent = prec + '%'; }
  const sc = String(score).padStart(5, '0');
  if (sc !== hudCache.score) { hudCache.score = sc; $('hudScore').textContent = sc; }
}

/* ====================================================================
 * Resultados
 * ==================================================================== */
function finishGame() {
  isWelding = false;
  torchPointer = null; weldHeld = false; weldBtn.classList.remove('down');
  stopWeldingAudio();
  state = 'RESULTS';
  playUIBeep(1000, 0.2);
  buzz('heavy');
  $('flash').style.opacity = '0';

  const avgPrecision = precisionAcc.length ? (precisionSum / precisionAcc.length) * 100 : 0;
  const coverage = Math.min(100, (weldCount / guidePath.length) * 120);
  const finalPct = Math.min(100, avgPrecision * 0.6 + coverage * 0.4);

  let grade, feedback;
  if (finalPct >= 96) {
    grade = 'A';
    feedback = '¡Excelente nivel de maestría técnica! Mantuviste una distancia de arco constante, velocidad uniforme y una penetración homogénea en todo el trazado. Para sostener este nivel en soldadura real, asegúrate de mantener el ángulo de trabajo a 45° y controlar adecuadamente la velocidad de enfriamiento del baño de fusión.';
  } else if (finalPct >= 86) {
    grade = 'B';
    feedback = 'Buen desempeño técnico, aunque con pequeños detalles a corregir. Se observaron leves variaciones en el pulso y la alineación del cordón. Recomendación pedagógica: afianza el apoyo de la mano guía, mantén un ritmo de avance constante para evitar socavaciones o exceso de aporte y estabiliza el movimiento en las curvas.';
  } else if (finalPct >= 51) {
    grade = 'C';
    feedback = 'Calificación regular. Existen oscilaciones marcadas fuera del eje guía y discontinuidad en el cordón. Consejo técnico: practica la postura de trabajo para mejorar el control motriz. Recuerda que desviarse de la línea causa falta de fusión y porosidad en las juntas reales. Modera la velocidad de avance.';
  } else {
    grade = 'D';
    feedback = 'Calificación insuficiente (50% o menos). El cordón presenta desviaciones severas y falta de continuidad crítica. Diagnóstico técnico: falta de control del arco y movimiento errático. Recomendación: apoya la mano para estabilizar el pulso, reduce la aceleración voluntaria y repite el ejercicio guiando la vista 1 cm por delante del punto de fusión.';
  }

  const timeUsed = (LEVEL_TIME_LIMIT - timeRemaining).toFixed(1);
  const total = Math.round(score + finalPct * 50);

  const g = $('finalGrade');
  g.textContent = grade;
  g.className = 'g-' + grade;
  $('resPrecision').textContent = avgPrecision.toFixed(1) + '%';
  $('resCoverage').textContent = coverage.toFixed(1) + '% (' + finalPct.toFixed(1) + '% final)';
  $('resTime').textContent = timeUsed + 's / 90s';
  $('resTotalScore').textContent = total.toLocaleString('es') + ' PTS';
  $('resFeedback').textContent = '"' + feedback + '"';

  const prev = bestScores[selectedLevel];
  const isRecord = !prev || total > prev.score;
  if (isRecord) {
    bestScores[selectedLevel] = { score: total, grade };
    store.set('sanjo.best', bestScores);
  }
  $('recordTag').classList.toggle('hidden', !isRecord);

  ['hud', 'banner', 'weldBtn'].forEach(hide);
  show('results');
}

/* ====================================================================
 * Dibujo
 * ==================================================================== */
function drawTorch(x, y) {
  const s = 0.42 * U;
  const mirror = settings.lefty ? -1 : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * mirror, s);
  ctx.rotate(Math.PI / 6);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#475569';

  // Tobera cerámica
  ctx.fillStyle = '#f8fafc';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(16, 6); ctx.lineTo(24, 14); ctx.lineTo(6, 18); ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Cuello metálico
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath(); ctx.moveTo(18, 10); ctx.quadraticCurveTo(60, 30, 90, 70); ctx.lineTo(105, 80);
  ctx.quadraticCurveTo(65, 45, 12, 16); ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Mango naranja
  ctx.fillStyle = '#ea580c';
  ctx.beginPath(); ctx.moveTo(90, 70); ctx.lineTo(150, 125); ctx.lineTo(185, 155); ctx.lineTo(165, 175);
  ctx.lineTo(125, 145); ctx.lineTo(75, 88); ctx.closePath();
  ctx.fill(); ctx.stroke();

  // Empuñadura de goma
  ctx.fillStyle = '#0f172a';
  ctx.beginPath(); ctx.moveTo(110, 88); ctx.lineTo(135, 110); ctx.lineTo(145, 102); ctx.lineTo(120, 80); ctx.closePath();
  ctx.fill();

  // Guante
  ctx.fillStyle = '#334155'; ctx.strokeStyle = '#1e293b';
  ctx.beginPath(); ctx.moveTo(135, 135); ctx.lineTo(240, 220); ctx.lineTo(290, 170); ctx.lineTo(170, 105); ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.strokeStyle = '#cbd5e1'; ctx.setLineDash([8, 8]);
  ctx.beginPath(); ctx.moveTo(150, 145); ctx.lineTo(180, 120); ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.drawImage(staticLayer, 0, 0, W, H);
  if (state === 'MENU') return;

  // Cordón frío
  ctx.drawImage(beadLayer, 0, 0, W, H);

  // Cordón caliente (sin shadowBlur: demasiado pesado en celulares)
  for (const b of hotBeads) {
    const age = gameTime - b.t;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 4 * U, 0, Math.PI * 2);
    ctx.fillStyle = age < 0.4 ? 'rgba(249, 115, 22, 0.35)' : 'rgba(239, 68, 68, 0.2)';
    ctx.fill();
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = age < 0.4 ? '#ffffff' : '#f97316';
    ctx.fill();
  }

  // Humo y chispas
  for (const s of smokes) {
    ctx.beginPath(); ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(148, 163, 184, ' + (s.life * 0.25) + ')';
    ctx.fill();
  }
  for (const s of sparks) {
    ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
  }

  if (!hasTorch) return;

  // Destello del arco
  if (isWelding) {
    const r = 45 * U;
    const g = ctx.createRadialGradient(tip.x, tip.y, 2, tip.x, tip.y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.2, 'rgba(56,189,248,0.8)');
    g.addColorStop(0.6, 'rgba(14,165,233,0.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, r, 0, Math.PI * 2); ctx.fill();
  }

  // Indicador del dedo (muestra dónde estás tocando)
  if (torchPointer !== null) {
    ctx.beginPath(); ctx.arc(finger.x, finger.y, 20 * U, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.30)'; ctx.lineWidth = 2; ctx.stroke();
  }

  drawTorch(tip.x, tip.y);

  // Mira de precisión en la punta
  ctx.strokeStyle = isWelding ? '#fbbf24' : '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tip.x, tip.y, 4 * U, 0, Math.PI * 2); ctx.stroke();
}

/* ====================================================================
 * Bucle principal
 * ==================================================================== */
let last = performance.now();
function loop(ts) {
  const dt = Math.min((ts - last) / 1000, 0.1);
  last = ts;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

/* ====================================================================
 * Integración con Android (botón Atrás, segundo plano)
 * ==================================================================== */
function handleBack() {
  if (state === 'PLAYING') pauseGame();
  else if (state === 'PAUSED' || state === 'RESULTS') returnToMenu();
  else if (Cap && Cap.Plugins && Cap.Plugins.App) Cap.Plugins.App.exitApp();
}

function autoPause() { if (state === 'PLAYING') pauseGame(); }

const AppPlugin = Cap && Cap.Plugins && Cap.Plugins.App;
if (AppPlugin) {
  AppPlugin.addListener('backButton', handleBack);
  AppPlugin.addListener('appStateChange', (s) => { if (!s.isActive) autoPause(); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 150));

// Atajo de teclado para pruebas en PC
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); weldHeld = true; weldBtn.classList.add('down'); }
  if (e.code === 'Escape') handleBack();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') releaseWeld();
});

/* Arranque */
resize();
renderMenu();
requestAnimationFrame((ts) => { last = ts; loop(ts); });

// Hook para pruebas automáticas
window.__sanjo = { startGame, selectLevel, get state() { return state; } };
})();
