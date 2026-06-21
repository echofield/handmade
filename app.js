/*
  ASTROLAB Field Interpreter v0
  The phone listens to the place and translates it into a living drone.

  field state  <-  microphone (density + brightness), motion (wow/stillness),
                   geolocation (harmonic identity), time of day (darkness/warmth)
  living synth  ->  Web Audio (A=432, detuned drone, lowpass, convolution reverb)
  living field  ->  canvas aurora reacting to the state

  One page. No build step. Secure context required for mic/geo (https or localhost).
*/

const A4 = 432;
const TAU = Math.PI * 2;

// ---- modes (scale interval sets) — geolocation picks one ----
const MODES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],   // minor — melancholy, distance
  dorian:  [0, 2, 3, 5, 7, 9, 10],   // hopeful minor
  lydian:  [0, 2, 4, 6, 7, 9, 11],   // luminous, floating
  phrygian:[0, 1, 3, 5, 7, 8, 10],   // shadowed, ancient
  ionian:  [0, 2, 4, 5, 7, 9, 11],   // warm major (sparing)
};
const MODE_NAMES = Object.keys(MODES);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

const midiToFreq = (m) => A4 * Math.pow(2, (m - 69) / 12);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---- the field state (smoothed environment readings) ----
const Field = {
  density: 0,     // mic loudness -> intensity
  brightness: 0,  // mic spectral centroid -> filter / shimmer
  motion: 0,      // device motion -> wow/flutter
  light: 0,       // camera mean luminance -> shimmer + aurora glow
  root: 9,        // semitone 0..11 (default A)
  mode: 'aeolian',
  frozen: false,
};

// ---- macros (user sliders) ----
const Macro = { body: 0.55, warmth: 0.5, space: 0.55, sensitivity: 0.6 };

let audio = null;     // the synth (built on Start)
let analyser = null;  // mic analyser
let micData = null, freqData = null;
let started = false;
let video = null, lumaCanvas = null, lumaCtx = null, cameraLight = 0;  // camera -> room light

// =====================================================================
// AUDIO ENGINE
// =====================================================================
function buildSynth() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();

  // master chain: voices -> filter -> warmth -> [dry + reverb] -> comp -> out
  const master = ctx.createGain();      master.gain.value = 0.0;  // fade in
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 24; comp.ratio.value = 3;
  comp.attack.value = 0.05; comp.release.value = 0.4;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = 900; filter.Q.value = 0.6;

  const warmth = ctx.createWaveShaper();
  warmth.curve = makeWarmthCurve(0.5); warmth.oversample = '2x';

  const dry = ctx.createGain(); dry.gain.value = 0.6;
  const wet = ctx.createGain(); wet.gain.value = 0.5;
  const reverb = ctx.createConvolver(); reverb.buffer = makeIR(ctx, 4.5);

  // voices
  const voices = ctx.createGain(); voices.gain.value = 0.5;
  voices.connect(filter);
  filter.connect(warmth);
  warmth.connect(dry); warmth.connect(reverb);
  dry.connect(master); reverb.connect(wet); wet.connect(master);
  master.connect(comp); comp.connect(ctx.destination);

  // wow LFO -> oscillator detune (motion drives its depth)
  const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.5;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0; // cents
  lfo.connect(lfoGain); lfo.start();

  // build the drone voicing from current root/mode
  const oscs = [];
  const voicing = chordVoicing(Field.root, Field.mode);
  voicing.forEach((midi, i) => {
    const o = ctx.createOscillator();
    o.type = i === 0 ? 'sine' : (i % 2 ? 'sine' : 'triangle');
    o.frequency.value = midiToFreq(midi);
    o.detune.value = (i - voicing.length / 2) * 4; // gentle spread
    const g = ctx.createGain();
    g.gain.value = i === 0 ? 0.5 : 0.32 / Math.sqrt(i); // sub strongest
    lfoGain.connect(o.detune);
    o.connect(g); g.connect(voices);
    o.start();
    oscs.push({ o, g, midi });
  });

  // shimmer voice (octave up) — brightness/light gated
  const shimOsc = ctx.createOscillator(); shimOsc.type = 'sine';
  shimOsc.frequency.value = midiToFreq(voicing[0] + 24);
  const shim = ctx.createGain(); shim.gain.value = 0;
  lfoGain.connect(shimOsc.detune);
  shimOsc.connect(shim); shim.connect(voices); shimOsc.start();

  // fade in
  master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);

  return { ctx, master, filter, warmth, dry, wet, voices, lfo, lfoGain,
           oscs, shimOsc, shim, voicing };
}

function makeWarmthCurve(drive) {
  const n = 1024, c = new Float32Array(n), k = 1 + drive * 3;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}

function makeIR(ctx, seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // two overlaid decays + slight predelay -> ambiguous, not a hall
      const env = Math.exp(-3 * t) + 0.4 * Math.exp(-1 * t);
      d[i] = (Math.random() * 2 - 1) * env * (i > 700 ? 1 : 0.4);
    }
  }
  return buf;
}

function chordVoicing(root, modeName) {
  const scale = MODES[modeName];
  const base = 33 + root;                 // ~A1 region
  const degs = [0, 2, 4, 6];              // 1-3-5-7 of the mode
  const v = degs.map((d) => base + scale[d % scale.length] + 12 * Math.floor(d / scale.length));
  v.unshift(base - 12);                   // sub
  return v;                               // [sub, 1, 3, 5, 7]
}

// retune the whole drone when geolocation resolves a new root/mode
function retune(root, modeName) {
  if (!audio) return;
  const v = chordVoicing(root, modeName);
  const now = audio.ctx.currentTime;
  audio.oscs.forEach((node, i) => {
    if (i < v.length) node.o.frequency.setTargetAtTime(midiToFreq(v[i]), now, 1.5);
  });
  audio.shimOsc.frequency.setTargetAtTime(midiToFreq(v[0] + 24), now, 1.5);
  audio.voicing = v;
}

// =====================================================================
// SENSORS
// =====================================================================
async function startMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = audio.ctx.createMediaStreamSource(stream);
    analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.6;
    src.connect(analyser);          // NOT to destination (no feedback)
    micData = new Uint8Array(analyser.fftSize);
    freqData = new Uint8Array(analyser.frequencyBinCount);
    return true;
  } catch (e) { console.warn('mic denied/failed', e); return false; }
}

// the room's light -> Field.light (rear camera if available; front on a laptop)
async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: 320, height: 240 }, audio: false });
    video = document.createElement('video');
    video.id = 'cam';
    video.setAttribute('playsinline', '');   // iOS: stay inline, don't go fullscreen
    video.muted = true; video.srcObject = stream;
    await video.play();
    document.body.appendChild(video);         // small visible preview = what the field senses
    lumaCanvas = document.createElement('canvas');
    lumaCanvas.width = 32; lumaCanvas.height = 24;
    lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
    return true;
  } catch (e) { console.warn('camera denied/failed', e); return false; }
}

function sampleLight() {
  if (!video || video.readyState < 2) return;
  lumaCtx.drawImage(video, 0, 0, lumaCanvas.width, lumaCanvas.height);
  const { data } = lumaCtx.getImageData(0, 0, lumaCanvas.width, lumaCanvas.height);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  const mean = sum / (data.length / 4) / 255;        // 0..1 average luminance
  cameraLight = clamp(Math.pow(mean, 0.6), 0, 1);    // gamma so dim rooms still register
}

function startGeo() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((pos) => {
    const { latitude, longitude } = pos.coords;
    // hash position -> root + mode (stable for a place, different across places)
    const h = Math.abs(Math.sin(latitude * 12.9898 + longitude * 78.233) * 43758.5453);
    Field.root = Math.floor((h % 1) * 12);
    Field.mode = MODE_NAMES[Math.floor((((h * 7) % 1)) * MODE_NAMES.length)];
    retune(Field.root, Field.mode);
    updateIdentity();
  }, (e) => console.warn('geo denied', e), { enableHighAccuracy: false, timeout: 8000 });
}

let motionAccum = 0, lastAccel = null;
function startMotion() {
  const handler = (ev) => {
    const a = ev.accelerationIncludingGravity || ev.acceleration;
    if (!a) return;
    if (lastAccel) {
      const d = Math.abs((a.x||0)-lastAccel.x) + Math.abs((a.y||0)-lastAccel.y) + Math.abs((a.z||0)-lastAccel.z);
      motionAccum = motionAccum * 0.9 + d * 0.1;
    }
    lastAccel = { x: a.x||0, y: a.y||0, z: a.z||0 };
  };
  if (typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then((s) => {
      if (s === 'granted') window.addEventListener('devicemotion', handler);
    }).catch(()=>{});
  } else if (typeof DeviceMotionEvent !== 'undefined') {
    window.addEventListener('devicemotion', handler);
  }
}

function timeOfDayWarmth() {
  const h = new Date().getHours();
  // night: darker + warmer; midday: brighter + cooler
  const night = Math.cos(((h - 14) / 24) * TAU) * 0.5 + 0.5; // ~1 at night
  return night; // 0..1
}

// =====================================================================
// THE INTERPRETER LOOP — environment -> field -> sound + visuals
// =====================================================================
function readEnvironment() {
  // the room's light is sensed independently of the mic
  if (video) {
    sampleLight();
    if (!Field.frozen) Field.light = lerp(Field.light, cameraLight, 0.05);
  }
  if (!analyser) return;
  analyser.getByteTimeDomainData(micData);
  let sum = 0;
  for (let i = 0; i < micData.length; i++) { const x = (micData[i]-128)/128; sum += x*x; }
  const rms = Math.sqrt(sum / micData.length);
  const dens = clamp((rms - 0.01) * (6 + Macro.sensitivity * 18), 0, 1);

  analyser.getByteFrequencyData(freqData);
  let num = 0, den = 0;
  for (let i = 0; i < freqData.length; i++) { num += i * freqData[i]; den += freqData[i]; }
  const centroid = den > 0 ? (num / den) / freqData.length : 0; // 0..1
  const bright = clamp(centroid * 2.2, 0, 1);

  if (!Field.frozen) {
    Field.density = lerp(Field.density, dens, 0.08);
    Field.brightness = lerp(Field.brightness, bright, 0.06);
    Field.motion = lerp(Field.motion, clamp(motionAccum * 0.5, 0, 1), 0.1);
  }
}

function applyToSynth() {
  if (!audio) return;
  const now = audio.ctx.currentTime;
  const tod = timeOfDayWarmth();

  // density -> intensity (voices presence)
  const intensity = lerp(0.32, 0.9, Field.density) * lerp(0.7, 1.1, Macro.body);
  audio.voices.gain.setTargetAtTime(intensity, now, 0.2);

  // brightness + time of day -> filter cutoff (night = darker ceiling)
  const ceiling = lerp(5200, 2400, tod);
  const cutoff = lerp(320, ceiling, Field.brightness);
  audio.filter.frequency.setTargetAtTime(cutoff, now, 0.15);

  // shimmer: mic brightness (softened at night) + a direct layer from room light
  const micShim = lerp(0, 0.12, Field.brightness) * lerp(1, 0.5, tod);
  const lightShim = lerp(0, 0.11, Field.light);   // cover the lens -> shimmer recedes
  audio.shim.gain.setTargetAtTime(micShim + lightShim, now, 0.3);

  // motion -> wow depth + a touch faster LFO; stillness -> stabilize
  const wow = lerp(1.5, 22, Field.motion);   // cents
  audio.lfoGain.gain.setTargetAtTime(Field.frozen ? 1.0 : wow, now, 0.4);
  audio.lfo.frequency.setTargetAtTime(lerp(0.35, 1.6, Field.motion), now, 0.5);

  // macros
  audio.warmth.curve = makeWarmthCurve(lerp(0.25, 0.95, Macro.warmth));
  audio.wet.gain.setTargetAtTime(lerp(0.2, 0.75, Macro.space), now, 0.3);
  audio.dry.gain.setTargetAtTime(lerp(0.75, 0.45, Macro.space), now, 0.3);
}

function fieldStatus() {
  if (Field.frozen) return 'frozen';
  if (Field.density > 0.6) return 'dense';
  if (Field.motion > 0.45) return 'moving';
  if (Field.brightness > 0.6) return 'luminous';
  if (Field.density < 0.12 && Field.motion < 0.12) return 'quiet';
  return 'listening';
}

// =====================================================================
// VISUAL FIELD (canvas aurora)
// =====================================================================
const canvas = document.getElementById('field');
const cx = canvas.getContext('2d');
let blobs = [];
function resize() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize); resize();
for (let i = 0; i < 7; i++) blobs.push({ x: Math.random(), y: Math.random(), r: 0.2 + Math.random() * 0.3, p: Math.random() * TAU, s: 0.2 + Math.random() * 0.5 });

function hueForMode(mode) {
  return { aeolian: 215, dorian: 190, lydian: 280, phrygian: 25, ionian: 45 }[mode] || 215;
}

let tps = 0;
function drawField(dt) {
  tps += dt;
  const W = canvas.width, H = canvas.height;
  const tod = timeOfDayWarmth();
  cx.globalCompositeOperation = 'source-over';
  cx.fillStyle = `rgba(${6+tod*4|0},${7},${10+ (1-tod)*6|0},0.18)`; // trailing dark
  cx.fillRect(0, 0, W, H);
  cx.globalCompositeOperation = 'lighter';
  const hue = hueForMode(Field.mode);
  const drift = 0.02 + Field.motion * 0.12;
  blobs.forEach((b, i) => {
    b.p += dt * (0.05 + b.s * drift);
    const px = (b.x + Math.cos(b.p) * 0.12 * (0.4 + Field.motion)) * W;
    const py = (b.y + Math.sin(b.p * 0.8) * 0.12 * (0.4 + Field.motion)) * H;
    const rad = b.r * Math.min(W, H) * (0.6 + Field.density * 0.9);
    const a = (0.05 + Field.density * 0.16) * (0.6 + (i % 2 ? Field.brightness : 1 - tod) * 0.7);
    const light = 38 + Field.brightness * 26 + Field.light * 16;
    const g = cx.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, `hsla(${hue + i * 6}, 55%, ${light}%, ${a})`);
    g.addColorStop(1, `hsla(${hue + i * 6}, 55%, ${light}%, 0)`);
    cx.fillStyle = g; cx.beginPath(); cx.arc(px, py, rad, 0, TAU); cx.fill();
  });
}

// =====================================================================
// UI + main loop
// =====================================================================
const $ = (id) => document.getElementById(id);
function updateIdentity() {
  $('identity').textContent = `${NOTE_NAMES[Field.root]} ${Field.mode}`;
}
function setStatus(t) { $('status').textContent = t; }

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (started) { readEnvironment(); applyToSynth(); setStatus(fieldStatus()); }
  drawField(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

async function start() {
  if (started) return;
  audio = buildSynth();
  if (audio.ctx.state === 'suspended') await audio.ctx.resume();
  const micOk = await startMic();
  await startCamera();
  startGeo();
  startMotion();
  started = true;
  updateIdentity();
  $('start').classList.add('hidden');
  $('panel').classList.remove('hidden');
  setStatus(micOk ? 'listening' : 'listening (no mic — drone only)');
}

$('start').addEventListener('click', start);
$('freeze').addEventListener('click', () => {
  Field.frozen = !Field.frozen;
  $('freeze').textContent = Field.frozen ? 'unfreeze field' : 'freeze field';
  $('freeze').classList.toggle('active', Field.frozen);
});
['body','warmth','space','sensitivity'].forEach((k) => {
  const el = $(k);
  el.addEventListener('input', () => { Macro[k] = el.value / 100; });
});
