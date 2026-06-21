/*
  ASTROLAB · Pulse — bio-reactive rest room.
  Front camera -> face ROI -> rPPG (POS projection) -> your heartbeat & coherence
  -> a healing drone (A=432) that pulses with your heart and resolves as you settle.

  Honest v0: rPPG is finicky — it wants soft, steady light, a fairly still face,
  and ~10s to lock. Treat the BPM as a living estimate, not a medical reading.
  POS after Wang et al.; the report's recommended projection for lighting robustness.
*/
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const midiToFreq = (m) => 432 * Math.pow(2, (m - 69) / 12);

// the body's read-out (the Field, pulse edition)
const Body = { bpm: 0, coherence: 0.4, breath: 0.5, beat: 0, signal: 0, present: false };

// =====================================================================
// rPPG — POS projection on a forehead ROI, time-domain beat detection
// =====================================================================
const N = 256;
const Rb = [], Gb = [], Bb = [];
const mean = (a) => { let s = 0; for (const x of a) s += x; return s / a.length; };
const std = (a) => { const m = mean(a); let s = 0; for (const x of a) s += (x - m) ** 2; return Math.sqrt(s / a.length); };

function pushRGB(r, g, b) {
  Rb.push(r); Gb.push(g); Bb.push(b);
  if (Rb.length > N) { Rb.shift(); Gb.shift(); Bb.shift(); }
}
function posSignal() {
  if (Rb.length < 48) return null;
  const mr = mean(Rb), mg = mean(Gb), mb = mean(Bb);
  const n = Rb.length, s1 = new Float64Array(n), s2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rn = Rb[i] / mr - 1, gn = Gb[i] / mg - 1, bn = Bb[i] / mb - 1;
    s1[i] = gn - bn; s2[i] = gn + bn - 2 * rn;
  }
  const a = std(s1) / (std(s2) + 1e-9);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = s1[i] + a * s2[i];
  return out;
}

let emaS = 0, emaL = 0, lastBp = 0, lastBeatT = 0, recentMax = 1e-3;
const intervals = [];
function processPulse(t) {
  const S = posSignal(); if (!S) return;
  const cur = S[S.length - 1];
  emaS += (cur - emaS) * 0.45;            // short EMA
  emaL += (cur - emaL) * 0.06;            // long EMA  -> their difference ≈ bandpass 0.7–4 Hz
  const bp = emaS - emaL;
  recentMax = Math.max(recentMax * 0.995, Math.abs(bp));
  Body.signal = clamp(Math.abs(bp) / (recentMax + 1e-9), 0, 1);
  if (lastBp <= 0 && bp > 0 && bp > 0.4 * recentMax && Body.signal > 0.22) {       // a rising beat candidate
    if (lastBeatT === 0) { lastBeatT = t; }                                        // seed the clock
    else if (t - lastBeatT > 0.35) {                                               // refractory (<180 bpm)
      const iv = t - lastBeatT;
      const med = intervals.length ? [...intervals].sort((a, b) => a - b)[intervals.length >> 1] : iv;
      if (iv > 0.33 && iv < 1.6 && (intervals.length < 3 || Math.abs(iv - med) / med < 0.4)) {   // plausible + in-rhythm
        lastBeatT = t;
        Body.bpm = Body.bpm ? lerp(Body.bpm, 60 / iv, 0.3) : 60 / iv;
        Body.beat = 1;
        intervals.push(iv); if (intervals.length > 10) intervals.shift();
        if (intervals.length >= 4) {                                               // coherence = beat steadiness
          const m = mean(intervals), sd = std(intervals);
          Body.coherence = lerp(Body.coherence, clamp(1 - (sd / m) / 0.18, 0, 1), 0.3);
        }
      } else if (iv >= 1.6) { lastBeatT = t; }                                      // long dropout -> resync
    }
  }
  lastBp = bp;
}

// ---- ROI sampling ----
const sampleCv = document.createElement('canvas'); sampleCv.width = 24; sampleCv.height = 14;
const sampleCtx = sampleCv.getContext('2d', { willReadFrequently: true });
let roi = null;   // {x,y,w,h} in video pixels, for drawing
function sampleForehead(video, lm) {
  const vw = video.videoWidth, vh = video.videoHeight;
  // forehead box: hairline (10) down toward the brows (9), spanning the brow corners (67,297)
  const top = lm[10].y, bot = lm[9].y, lx = lm[67].x, rx = lm[297].x;
  const x = Math.min(lx, rx) * vw, w = Math.abs(rx - lx) * vw;
  const y = top * vh, h = Math.max(8, (bot - top) * vh * 0.6);
  if (w < 8 || h < 8) return;
  roi = { x, y, w, h };
  sampleCtx.drawImage(video, x, y, w, h, 0, 0, 24, 14);
  const d = sampleCtx.getImageData(0, 0, 24, 14).data;
  let r = 0, g = 0, b = 0; const px = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  pushRGB(r / px, g / px, b / px);
}

// =====================================================================
// HEALING DRONE — A=432; breathes with the breath guide, pulses with the
// heart, resolves (528 shimmer + warmth + space) as coherence rises.
// =====================================================================
let audio = null;
function buildSynth() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const master = ctx.createGain(); master.gain.value = 0;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3;
  const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 0.6;
  const wet = ctx.createGain(); wet.gain.value = 0.45; const dry = ctx.createGain(); dry.gain.value = 0.6;
  const rev = ctx.createConvolver();
  const len = ctx.sampleRate * 5 | 0, ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const a = ir.getChannelData(ch); for (let i = 0; i < len; i++) { const x = i / len; a[i] = (Math.random() * 2 - 1) * (Math.exp(-3 * x) + 0.4 * Math.exp(-x)) * (i > 700 ? 1 : 0.4); } }
  rev.buffer = ir;
  const pad = ctx.createGain(); pad.gain.value = 0.0;
  pad.connect(filt); filt.connect(dry); filt.connect(rev); dry.connect(master); rev.connect(wet); wet.connect(master);
  master.connect(comp); comp.connect(ctx.destination);

  const mk = (midi, g, type = 'sine', det = 0) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = midiToFreq(midi); o.detune.value = det; const gn = ctx.createGain(); gn.gain.value = g; o.connect(gn); gn.connect(pad); o.start(); return o; };
  mk(45, 0.5); mk(45, 0.4, 'sine', -6); mk(52, 0.34); mk(57, 0.3, 'sine', 6); mk(64, 0.16);   // A2 drone (A=432)

  const shimOsc = ctx.createOscillator(); shimOsc.type = 'sine'; shimOsc.frequency.value = 528;   // the 528 Solfeggio tone
  const shim = ctx.createGain(); shim.gain.value = 0; shimOsc.connect(shim); shim.connect(pad); shimOsc.start();

  const heartOsc = ctx.createOscillator(); heartOsc.type = 'sine'; heartOsc.frequency.value = 58;  // the heartbeat thump
  const heart = ctx.createGain(); heart.gain.value = 0; heartOsc.connect(heart); heart.connect(master); heartOsc.start();

  master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);
  return { ctx, master, filt, wet, dry, pad, shim, heart };
}
function updateSynth() {
  if (!audio) return; const now = audio.ctx.currentTime, c = Body.coherence;
  audio.pad.gain.setTargetAtTime(lerp(0.18, 0.5, Body.breath) * (Body.present ? 1 : 0.6), now, 0.4);   // breathe
  audio.filt.frequency.setTargetAtTime(lerp(600, 2600, c) * lerp(0.9, 1.12, Body.breath), now, 0.3);    // coherence opens
  audio.shim.gain.setTargetAtTime(lerp(0.0, 0.13, c), now, 0.5);                                         // 528 blooms when coherent
  audio.wet.gain.setTargetAtTime(lerp(0.35, 0.7, c), now, 0.5);                                          // more space when coherent
  audio.heart.gain.setTargetAtTime(Body.beat * 0.4, now, 0.04);                                          // the thump
}

// =====================================================================
// VISUALS — a heart that flashes on each beat, a breath halo, the BPM
// =====================================================================
const cv = document.getElementById('stage'), ctx2 = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
function resize() { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); }
addEventListener('resize', resize); resize();

function render(video) {
  if (video && video.readyState >= 2) {                                  // mirrored, dim — to frame your face
    ctx2.save(); ctx2.translate(W, 0); ctx2.scale(-1, 1); ctx2.globalAlpha = 0.32; ctx2.drawImage(video, 0, 0, W, H); ctx2.restore(); ctx2.globalAlpha = 1;
  } else { ctx2.fillStyle = '#06070a'; ctx2.fillRect(0, 0, W, H); }
  ctx2.fillStyle = 'rgba(6,7,10,0.45)'; ctx2.fillRect(0, 0, W, H);

  if (roi && Body.present && video.videoWidth) {                         // show where it reads your pulse
    const vw = video.videoWidth, vh = video.videoHeight;
    const sx = (1 - (roi.x + roi.w) / vw) * W, sy = (roi.y / vh) * H, sw = (roi.w / vw) * W, sh = (roi.h / vh) * H;
    ctx2.strokeStyle = `rgba(236,231,218,${0.25 + 0.4 * Body.signal})`; ctx2.lineWidth = 1.5; ctx2.strokeRect(sx, sy, sw, sh);
  }

  const cx = W / 2, cy = H / 2;
  const warm = lerp(210, 45, Body.coherence);                            // cool -> warm gold as coherence rises
  ctx2.globalCompositeOperation = 'lighter';
  const hr = Math.min(W, H) * (0.18 + 0.07 * Body.breath) * (1 + 0.5 * Body.coherence);   // breath halo
  let g = ctx2.createRadialGradient(cx, cy, 0, cx, cy, hr);
  g.addColorStop(0, `hsla(${warm},70%,68%,${0.10 + 0.12 * Body.coherence})`); g.addColorStop(1, `hsla(${warm},70%,60%,0)`);
  ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(cx, cy, hr, 0, TAU); ctx2.fill();

  const beatR = Math.min(W, H) * (0.05 + 0.06 * Body.beat);              // the heart flashes on each beat
  g = ctx2.createRadialGradient(cx, cy, 0, cx, cy, beatR);
  g.addColorStop(0, `hsla(0,75%,70%,${0.3 + 0.5 * Body.beat})`); g.addColorStop(1, 'hsla(0,75%,60%,0)');
  ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(cx, cy, beatR, 0, TAU); ctx2.fill();
  ctx2.globalCompositeOperation = 'source-over';
}

// =====================================================================
// LOOP + UI
// =====================================================================
const video = document.getElementById('cam');
const $ = (id) => document.getElementById(id);
let detector = null, running = false, lastVT = -1, last = performance.now(), lostT = 0;

function loop(now) {
  Body.breath = 0.5 + 0.5 * Math.sin((now / 1000) * 0.092 * TAU);        // ~5.5/min coherence breath
  if (running && detector && video.readyState >= 2 && video.currentTime !== lastVT) {
    lastVT = video.currentTime;
    let lm = null;
    try { const r = detector.detectForVideo(video, now); lm = r.faceLandmarks && r.faceLandmarks[0]; } catch (e) { /* skip */ }
    if (lm) { Body.present = true; lostT = now; sampleForehead(video, lm); processPulse(now / 1000); }
    else if (now - lostT > 1500) { Body.present = false; }
  }
  Body.beat *= 0.82;
  if (running && now / 1000 - lastBeatT > 4) { Body.bpm = lerp(Body.bpm, 0, 0.02); Body.coherence = lerp(Body.coherence, 0.4, 0.01); }
  updateSynth();
  render(video);
  $('bpm').innerHTML = (Body.bpm > 30 ? Math.round(Body.bpm) : '--') + '<small> bpm</small>';
  $('state').textContent = !running ? '' : !Body.present ? 'find your face in soft light' : Body.bpm < 30 ? 'listening for your pulse…' : Body.coherence > 0.66 ? 'coherence' : 'settling';
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

async function makeDetector() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const build = (delegate) => FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task", delegate },
    runningMode: "VIDEO", numFaces: 1,
  });
  try { return await build("GPU"); } catch (e) { return await build("CPU"); }
}

async function begin() {
  if (running) return;
  $('start').disabled = true; $('loading').classList.remove('hidden');
  try {
    audio = buildSynth();
    detector = await makeDetector();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
    video.srcObject = stream; await video.play();
    running = true;
    $('loading').classList.add('hidden'); $('bpm').classList.remove('hidden');
    $('start').parentElement.classList.add('hidden');
  } catch (e) { $('loading').textContent = 'could not start: ' + ((e && e.message) || e); $('start').disabled = false; }
}
$('start').addEventListener('click', begin);
