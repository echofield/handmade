/*
  ASTROLAB · HandSynth (web) v0
  ------------------------------------------------------------------
  ASTROLAB is the CONDUCTOR, not the synth. The chain is:

      hands (and later: day / place / weather / light / noise)
                          │
                          ▼
             ASTROLAB INTERPRETER  →  the Field  (musical parameters)
                          │
                          ▼
                    SOUND ENGINE (swappable)

  The Interpreter only WRITES the Field. Engines + visuals only READ it.
  v0 ships a built-in soft synth; the same Field can later feed a sample
  library, a neural synth (DDSP/RAVE), or MIDI/OSC out to Ableton — and
  it could just as easily drive light or video. Sound is the first reader,
  not the only one.

  No build step. Secure context (https / localhost) required for camera.
*/
import { HandLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const A4 = 432, TAU = Math.PI * 2;
const midiToFreq = (m) => A4 * Math.pow(2, (m - 69) / 12);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ---- modes ----
const MODES = {
  aeolian:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10], lydian:[0,2,4,6,7,9,11],
  phrygian:[0,1,3,5,7,8,10], ionian:[0,2,4,5,7,9,11],
};
const MODE_NAMES = Object.keys(MODES);
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const HUE = { aeolian:215, dorian:190, lydian:280, phrygian:25, ionian:45 };

// =====================================================================
// THE FIELD — semantic, engine-agnostic control surface.
// Musical params (not synth knobs) so any reader can interpret them.
// =====================================================================
const Field = {
  pitch:0.5,       // position within the active scale
  brightness:0.5,  // spectral openness / filter
  intensity:0.0,   // body / presence / loudness
  motion:0.0,      // movement -> vibrato / drift
  openness:0.4,    // reverb / space
  proximity:0.0,   // closeness -> intimacy
  harmony:0.0,     // second-voice presence
  interval:7,      // semitones of the harmony voice
  stillness:1.0,   // derived: how settled the hand is
  grasp:0.0,       // fist: fingers curled -> choke / intimacy
  voicing:0.0,     // (legacy) finger count
  pinch:0.0,       // thumb + index together -> a summoned star
  chord:[],        // semitone offsets from the base note, named by the recognized pose
  register:0,      // octave shift (semitones) from a pose (e.g. thumb-up = +12)
  gesture:'open',  // the recognized hand-pose intent (debounced)
  accent:0.0,      // transient: a swipe / grasp stroke (decays) -> filter + gain bump
  bloom:0.0,       // transient: a release (fist -> open) -> reverb / shimmer swell
  twist:0.5,       // wrist rotation (in-plane) -> timbre / chorus width
  body:0.0,        // transient: a rhythmic onset -> a low body thump (pulse)
  tempo:0.6,       // seconds between onsets -> the hand's rhythm
  freezeNow:false, // one-shot: close-hand edge -> capture a frozen layer
  breath:0.5,      // the temple's slow breath (~5.5/min) -> swell; breathe with it
  calm:0.4,        // sustained stillness -> coherence, rewarded with resolution
  temple:false,    // healing mode: deepen breath + resolution, dim and warm
  union:0.0,       // two hands brought together -> a binaural entrainment beat
  beat:8.0,        // binaural beat frequency (Hz), set by the hand-gap
  root:9, mode:'aeolian', hands:0, frozen:false,
};
const scaleNotes = (root, mode) => {                 // three octaves -> smooth, continuous glide
  const iv = MODES[mode], base = 33 + root, out = [];
  for (let k = 0; k < 3; k++) for (const s of iv) out.push(base + 12 * k + s);
  return out;
};
let SCALE = scaleNotes(Field.root, Field.mode);

// =====================================================================
// ONE-EURO FILTER — adaptive de-noiser. Steady when you hold still,
// snappy when you move fast. This is what makes the Field feel alive
// instead of jittery or laggy. (Casiez, Roussel & Vogel, 2012.)
// =====================================================================
class OneEuro {
  constructor(minCut = 1.0, beta = 0.015, dCut = 1.0) {
    this.mc = minCut; this.beta = beta; this.dc = dCut; this.x = null; this.dx = 0; this.t = null;
  }
  _a(cut, dt) { const tau = 1 / (TAU * cut); return 1 / (1 + tau / dt); }
  filter(v, t) {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    const dxr = (v - this.x) / dt;
    this.dx += this._a(this.dc, dt) * (dxr - this.dx);
    const cut = this.mc + this.beta * Math.abs(this.dx);
    this.x += this._a(cut, dt) * (v - this.x);
    return this.x;
  }
  get speed() { return Math.abs(this.dx); }   // units / second
}

// =====================================================================
// SOUND ENGINE (swappable).  v0 = built-in soft synth.
// Contract any engine implements:  start() · update(Field)
// Future drop-ins, same contract:
//   • SampleEngine — stretch / layer / transpose your own sacred notes
//   • MidiEngine   — WebMIDI / OSC out to Ableton, Logic, hardware
//   • NeuralEngine — DDSP / RAVE timbre conditioned on the Field
// =====================================================================
const SoftSynth = (() => {
  let ctx, master, filt, warm, dry, wet, voices, lfo, lfoG, hf, ho, gh, curMidi, frozen = [], frozenPtr = 0, dlyFb, dlyMix;
  const osc = {};
  const warmCurve = (d) => {
    const n = 1024, c = new Float32Array(n), k = 1 + d * 3;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  };
  const makeIR = (sec) => {
    const len = (ctx.sampleRate * sec) | 0, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) { const t = i / len, env = Math.exp(-3 * t) + 0.4 * Math.exp(-t); d[i] = (Math.random() * 2 - 1) * env * (i > 700 ? 1 : 0.4); }
    }
    return b;
  };
  const mkOsc = () => { const o = ctx.createOscillator(); o.type = 'sine'; lfoG.connect(o.detune); o.start(); return o; };

  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 3; comp.attack.value = 0.05; comp.release.value = 0.4;
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1200; filt.Q.value = 0.7;
    warm = ctx.createWaveShaper(); warm.curve = warmCurve(0.6); warm.oversample = '2x';
    dry = ctx.createGain(); dry.gain.value = 0.62;
    wet = ctx.createGain(); wet.gain.value = 0.4;
    const rev = ctx.createConvolver(); rev.buffer = makeIR(5.0);
    voices = ctx.createGain(); voices.gain.value = 0;
    voices.connect(filt); filt.connect(warm);
    warm.connect(dry); warm.connect(rev);
    dry.connect(master); rev.connect(wet); wet.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    // a feedback delay ties everything into continuity — echoes, spark tails, space
    const delay = ctx.createDelay(1.0); delay.delayTime.value = 0.38;
    dlyFb = ctx.createGain(); dlyFb.gain.value = 0.4;
    dlyMix = ctx.createGain(); dlyMix.gain.value = 0.5;
    master.connect(delay); delay.connect(dlyFb); dlyFb.connect(delay); delay.connect(dlyMix); dlyMix.connect(comp);

    lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 5.2;
    lfoG = ctx.createGain(); lfoG.gain.value = 0; lfo.connect(lfoG); lfo.start();

    // drone partials around one gliding fundamental
    osc.sub = mkOsc(); osc.low = mkOsc(); osc.fund = mkOsc(); osc.high = mkOsc(); osc.shim = mkOsc();
    osc.low.detune.value = -7; osc.high.detune.value = 7;
    const g = (v) => { const x = ctx.createGain(); x.gain.value = v; x.connect(voices); return x; };
    osc.sub.connect(g(0.5)); osc.low.connect(g(0.45)); osc.fund.connect(g(0.6)); osc.high.connect(g(0.45));
    osc.gShim = ctx.createGain(); osc.gShim.gain.value = 0; osc.shim.connect(osc.gShim); osc.gShim.connect(voices);

    // harmony voice (second fundamental + its octave), gated by Field.harmony
    hf = mkOsc(); ho = mkOsc(); gh = ctx.createGain(); gh.gain.value = 0;
    hf.connect(gh); ho.connect(gh); gh.connect(voices);

    // chord voices revealed by finger-voicing: a modal third, a fifth, an octave
    osc.v3 = mkOsc(); osc.v5 = mkOsc(); osc.v8 = mkOsc();
    osc.g3 = ctx.createGain(); osc.g3.gain.value = 0; osc.v3.connect(osc.g3); osc.g3.connect(voices);
    osc.g5 = ctx.createGain(); osc.g5.gain.value = 0; osc.v5.connect(osc.g5); osc.g5.connect(voices);
    osc.g8 = ctx.createGain(); osc.g8.gain.value = 0; osc.v8.connect(osc.g8); osc.g8.connect(voices);
    // a high "star" summoned by a pinch
    osc.star = mkOsc(); osc.gStar = ctx.createGain(); osc.gStar.gain.value = 0;
    osc.star.connect(osc.gStar); osc.gStar.connect(voices);
    // a low "body" thump on each rhythmic onset (the hand's pulse / heartbeat)
    osc.body = mkOsc(); osc.gBody = ctx.createGain(); osc.gBody.gain.value = 0;
    osc.body.connect(osc.gBody); osc.gBody.connect(voices);
    // BINAURAL PAIR — bring the two hands together to bloom an entrainment beat.
    // Hard-panned L/R (needs headphones), routed clean to master so the channels stay pure.
    const panL = ctx.createStereoPanner(); panL.pan.value = -1;
    const panR = ctx.createStereoPanner(); panR.pan.value = 1;
    osc.bl = mkOsc(); osc.br = mkOsc(); osc.gBin = ctx.createGain(); osc.gBin.gain.value = 0;
    osc.bl.connect(panL); osc.br.connect(panR); panL.connect(osc.gBin); panR.connect(osc.gBin); osc.gBin.connect(master);

    // FROZEN LAYERS — close the hand to capture the live note into a sustained voice;
    // layers stack into an evolving polyphonic drone (round-robin pool of 6)
    frozen = [];
    for (let k = 0; k < 6; k++) {
      const a = mkOsc(), b = mkOsc(); b.detune.value = 6;
      const fg = ctx.createGain(); fg.gain.value = 0;
      a.connect(fg); b.connect(fg); fg.connect(master); fg.connect(rev);
      frozen.push({ a, b, fg });
    }
    frozenPtr = 0;

    curMidi = SCALE[(SCALE.length / 2) | 0];
    if (ctx.state === 'suspended') ctx.resume();
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 3);
  }

  function update(F) {
    if (!ctx) return; const now = ctx.currentTime;
    const idx = clamp((F.pitch * SCALE.length) | 0, 0, SCALE.length - 1);
    curMidi += (SCALE[idx] - curMidi) * (F.frozen ? 0.02 : 0.16);   // glide
    const reg = F.register | 0;
    const f = midiToFreq(curMidi + reg);
    if (F.freezeNow) { freezeVoice(curMidi + reg); F.freezeNow = false; }   // close-hand captured a layer
    osc.sub.frequency.setTargetAtTime(f * 0.5, now, 0.05);
    osc.low.frequency.setTargetAtTime(f, now, 0.05);
    osc.fund.frequency.setTargetAtTime(f, now, 0.05);
    osc.high.frequency.setTargetAtTime(f, now, 0.05);
    osc.shim.frequency.setTargetAtTime(f * 2, now, 0.05);
    gh.gain.setTargetAtTime(0, now, 0.3);                          // (legacy harmony voice retired)

    const breathSwell = 1 + (F.temple ? 0.4 : 0.14) * (F.breath - 0.5) * 2;   // inhale rises, exhale settles
    const calmDark = lerp(1, F.temple ? 0.5 : 0.72, F.calm);                  // stillness -> warmer, darker
    const calmPure = lerp(1, 0.4, F.calm);                                    // stillness -> purer (less beating/shimmer)
    const amp = F.frozen ? Math.max(F.intensity, 0.5) : F.intensity;          // closer to camera = more sound
    voices.gain.setTargetAtTime(lerp(0.0, 0.95, amp) * lerp(1, 0.5, F.grasp) * (1 + F.accent * 0.25) * breathSwell, now, 0.12);
    filt.frequency.setTargetAtTime((lerp(340, 6500, F.brightness * 0.85 + F.proximity * 0.15) * calmDark * lerp(1, 1.12, F.breath) + F.accent * 3000) * lerp(1, 0.3, F.grasp), now, 0.06);
    osc.gShim.gain.setTargetAtTime((lerp(0, 0.18, F.brightness) + F.bloom * 0.15) * calmPure, now, 0.25);
    osc.low.detune.setTargetAtTime((-7 - (F.twist - 0.5) * 26) * calmPure, now, 0.2);   // calm narrows the chorus -> purer
    osc.high.detune.setTargetAtTime((7 + (F.twist - 0.5) * 26) * calmPure, now, 0.2);
    if (dlyFb) dlyFb.gain.setTargetAtTime(lerp(0.4, 0.6, F.calm), now, 0.5);            // calm opens the space
    if (dlyMix) dlyMix.gain.setTargetAtTime(lerp(0.5, 0.8, F.calm), now, 0.5);

    // the recognized pose names a chord; each offset fills one voice slot
    const ch = F.chord || [];
    const slot = [[osc.v3, osc.g3], [osc.v5, osc.g5], [osc.v8, osc.g8]];
    for (let i = 0; i < slot.length; i++) {
      const [o, gg] = slot[i];
      if (i < ch.length) { o.frequency.setTargetAtTime(midiToFreq(curMidi + reg + ch[i]), now, 0.06); gg.gain.setTargetAtTime(0.26, now, 0.25); }
      else gg.gain.setTargetAtTime(0, now, 0.25);
    }
    osc.star.frequency.setTargetAtTime(f * 4, now, 0.05);          // pinch summons a star
    osc.gStar.gain.setTargetAtTime(lerp(0, 0.22, F.pinch), now, 0.15);
    osc.body.frequency.setTargetAtTime(f * 0.5, now, 0.03);        // rhythmic body thump (pulse)
    osc.gBody.gain.setTargetAtTime(F.body * 0.45, now, 0.04);
    const cHz = clamp(midiToFreq(curMidi + reg), 110, 480);        // binaural carrier (<1000 Hz)
    osc.bl.frequency.setTargetAtTime(cHz - F.beat / 2, now, 0.1);  // hands together -> a beat inside the skull
    osc.br.frequency.setTargetAtTime(cHz + F.beat / 2, now, 0.1);
    osc.gBin.gain.setTargetAtTime(lerp(0, 0.4, F.union), now, 0.4);

    // motion -> vibrato; stillness settles it back toward rest
    const vib = F.frozen ? 1.0 : lerp(1.5, 26, F.motion) * lerp(1, 0.3, F.stillness);
    lfoG.gain.setTargetAtTime(vib, now, 0.3);
    lfo.frequency.setTargetAtTime(lerp(4.6, 6.2, F.motion), now, 0.4);

    // openness -> space ; proximity -> drier & more intimate
    wet.gain.setTargetAtTime(lerp(0.15, 0.8, F.openness) * lerp(1, 0.65, F.proximity) * lerp(1, 0.4, F.grasp) + F.bloom * 0.3, now, 0.3);
    dry.gain.setTargetAtTime(lerp(0.5, 0.78, F.proximity), now, 0.3);
  }

  function freezeVoice(midi) {
    if (!frozen.length) return;
    const v = frozen[frozenPtr % frozen.length]; frozenPtr++;
    const now = ctx.currentTime, hz = midiToFreq(midi);
    v.a.frequency.setTargetAtTime(hz, now, 0.05);
    v.b.frequency.setTargetAtTime(hz, now, 0.05);
    v.fg.gain.cancelScheduledValues(now);
    v.fg.gain.setTargetAtTime(0.14, now, 0.6);   // capture the note, fade it in, hold it
  }
  function clearFrozen() {
    if (!ctx) return; const now = ctx.currentTime;
    for (const v of frozen) v.fg.gain.setTargetAtTime(0, now, 0.8);
  }
  function stop() {
    if (!ctx) return; const c = ctx;
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setTargetAtTime(0, c.currentTime, 0.15);
    setTimeout(() => c.close(), 500); ctx = null;
  }
  return { start, update, stop, clearFrozen, get ready() { return !!ctx; } };
})();

// =====================================================================
// SAMPLE ENGINE (swappable) — "the most beautiful route."
// Reads field/samples/*.wav and recombines your own sacred material:
// each layer is transposed to the Field's pitch, balanced by intensity /
// brightness / harmony, sent to filter + space. Any missing file falls
// back to a seamless-looping synthesized tone, so it plays immediately
// and improves the instant you record real notes. Same contract as above.
// =====================================================================
const SampleEngine = (() => {
  let ctx, master, filt, warm, dry, wet, voices, curMidi, loaded = false;
  const L = {};   // name -> { src, gain, baseFreq, octave, role }

  // what ASTROLAB looks for in field/samples/ — see samples/README.md
  const MANIFEST = [
    { name: 'sub', file: 'sub.wav', root: 33, octave: -1, role: 'sub' },   // A1 sub drone
    { name: 'pad', file: 'pad.wav', root: 57, octave: 0,  role: 'pad' },   // A3 pad
    { name: 'air', file: 'air.wav', root: 81, octave: 1,  role: 'air' },   // A5 tape/air
    { name: 'harmony', file: 'pad.wav', root: 57, octave: 0, role: 'pad' },
  ];

  const warmCurve = (d) => {
    const n = 1024, c = new Float32Array(n), k = 1 + d * 3;
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  };
  const makeIR = (sec) => {
    const len = (ctx.sampleRate * sec) | 0, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < len; i++) { const t = i / len, env = Math.exp(-3 * t) + 0.4 * Math.exp(-t); d[i] = (Math.random() * 2 - 1) * env * (i > 700 ? 1 : 0.4); }
    }
    return b;
  };

  // a perfectly periodic (click-free looping) fallback tone for a role
  function synthBuffer(role, desiredFreq) {
    const sr = ctx.sampleRate, len = Math.round(sr * 2.0);
    const n0 = Math.max(1, Math.round(desiredFreq * len / sr));   // integer cycles -> seamless loop
    const baseFreq = n0 * sr / len;
    const parts = role === 'sub' ? [[1, 1.0], [2, 0.12]]
      : role === 'air' ? [[1, 0.5], [2, 0.5], [4, 0.28], [6, 0.14]]
      : [[1, 0.7], [2, 0.4], [3, 0.22], [4, 0.16], [5, 0.10]];
    const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const ph = TAU * i / len; let s = 0;
      for (const [m, a] of parts) s += a * Math.sin(ph * n0 * m + m);
      d[i] = s * (1 + 0.15 * Math.sin(ph));                       // gentle 1-cycle breath
    }
    let peak = 0; for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0) for (let i = 0; i < len; i++) d[i] = d[i] / peak * 0.9;
    return { buf, baseFreq };
  }

  async function loadLayer(m) {
    try {
      const res = await fetch('samples/' + m.file);
      if (res.ok) { const buf = await ctx.decodeAudioData(await res.arrayBuffer()); return { buf, baseFreq: midiToFreq(m.root) }; }
    } catch (e) { /* fall through to synthesized tone */ }
    return synthBuffer(m.role, midiToFreq(m.root));
  }

  function start() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 3; comp.attack.value = 0.05; comp.release.value = 0.4;
    filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 1200; filt.Q.value = 0.7;
    warm = ctx.createWaveShaper(); warm.curve = warmCurve(0.55); warm.oversample = '2x';
    dry = ctx.createGain(); dry.gain.value = 0.62; wet = ctx.createGain(); wet.gain.value = 0.4;
    const rev = ctx.createConvolver(); rev.buffer = makeIR(5.0);
    voices = ctx.createGain(); voices.gain.value = 0;
    voices.connect(filt); filt.connect(warm); warm.connect(dry); warm.connect(rev);
    dry.connect(master); rev.connect(wet); wet.connect(master); master.connect(comp); comp.connect(ctx.destination);
    curMidi = SCALE[(SCALE.length / 2) | 0];
    if (ctx.state === 'suspended') ctx.resume();
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 3);
    (async () => {
      for (const m of MANIFEST) {
        const { buf, baseFreq } = await loadLayer(m);
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        const gain = ctx.createGain(); gain.gain.value = 0;
        src.connect(gain); gain.connect(voices); src.start();
        L[m.name] = { src, gain, baseFreq, octave: m.octave, role: m.role };
      }
      loaded = true;
    })();
  }

  const setRate = (layer, midi) =>
    layer.src.playbackRate.setTargetAtTime(midiToFreq(midi + 12 * layer.octave) / layer.baseFreq, ctx.currentTime, 0.06);

  function update(F) {
    if (!ctx || !loaded) return; const now = ctx.currentTime;
    const idx = clamp((F.pitch * SCALE.length) | 0, 0, SCALE.length - 1);
    curMidi += (SCALE[idx] - curMidi) * (F.frozen ? 0.02 : 0.16);
    const reg = F.register | 0;
    const ch = F.chord || [];
    const top = ch.length ? ch[ch.length - 1] : 0;                // sample chord uses the top tone (v1)
    for (const k in L) setRate(L[k], curMidi + reg);
    if (L.harmony) setRate(L.harmony, curMidi + reg + top);
    const amp = F.frozen ? Math.max(F.intensity, 0.5) : F.intensity;   // closer to camera = more sound
    voices.gain.setTargetAtTime(lerp(0.0, 0.95, amp) * lerp(1, 0.5, F.grasp), now, 0.12);   // fist chokes
    if (L.sub) L.sub.gain.gain.setTargetAtTime(0.55, now, 0.3);
    if (L.pad) L.pad.gain.gain.setTargetAtTime(0.6, now, 0.3);
    if (L.air) L.air.gain.gain.setTargetAtTime(lerp(0.0, 0.5, F.brightness) + 0.3 * F.pinch, now, 0.25);
    if (L.harmony) L.harmony.gain.gain.setTargetAtTime(ch.length ? 0.5 : 0.0, now, 0.3);
    filt.frequency.setTargetAtTime(lerp(340, 6500, F.brightness * 0.85 + F.proximity * 0.15) * lerp(1, 0.3, F.grasp), now, 0.08);
    wet.gain.setTargetAtTime(lerp(0.15, 0.8, F.openness) * lerp(1, 0.65, F.proximity) * lerp(1, 0.4, F.grasp) + F.bloom * 0.3, now, 0.3);
    dry.gain.setTargetAtTime(lerp(0.5, 0.78, F.proximity), now, 0.3);
  }

  function stop() {
    if (!ctx) return; const c = ctx;
    master.gain.setTargetAtTime(0, c.currentTime, 0.15);
    setTimeout(() => c.close(), 500); ctx = null; loaded = false;
    for (const k in L) delete L[k];
  }
  return { start, update, stop };
})();

// engines share one contract; swap them live (the whole point of the Field)
// =====================================================================
// MIDI ENGINE (swappable) — the Field plays a real DAW.
// WebMIDI out: a chord from finger-voicing, velocity from intensity,
// CC1=motion · CC74=brightness · CC11=intensity (fist softens) · CC91=space.
// Route through a virtual port (loopMIDI on Windows, IAC on Mac) into
// Ableton / Vital / Serum. Chromium + secure context. It makes no sound of
// its own — the DAW does. Same start()/update(Field) contract as the rest.
// =====================================================================
const MidiEngine = (() => {
  let access = null, out = null, ready = false;
  const CH = 0, held = new Set(), ccLast = {};
  const send = (a) => { if (out) out.send(a); };
  const noteOn = (n, v) => send([0x90 | CH, n & 127, v & 127]);
  const noteOff = (n) => send([0x80 | CH, n & 127, 0]);
  const cc = (num, val) => { const v = clamp(val | 0, 0, 127); if (out && ccLast[num] !== v) { send([0xB0 | CH, num, v]); ccLast[num] = v; } };

  function pickOutput() { out = access ? [...access.outputs.values()][0] || null : null; updateSoundLabel(); }
  async function start() {
    held.clear();
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
      access.onstatechange = pickOutput; pickOutput(); ready = true;
    } catch (e) { console.warn('WebMIDI unavailable/denied', e); ready = false; updateSoundLabel(); }
  }
  function update(F) {
    if (!ready || !out) return;
    const base = SCALE[clamp((F.pitch * SCALE.length) | 0, 0, SCALE.length - 1)] + (F.register | 0);
    const want = new Set();
    if (F.frozen || F.intensity > 0.06) {           // closer to camera = sounding
      want.add(base);
      for (const off of (F.chord || [])) want.add(base + off);
    }
    const vel = clamp((20 + F.intensity * 107) | 0, 1, 127);
    for (const n of held) if (!want.has(n)) { noteOff(n); held.delete(n); }
    for (const n of want) if (!held.has(n)) { noteOn(n, vel); held.add(n); }
    cc(1, F.motion * 127);
    cc(74, F.brightness * 127);
    cc(11, F.intensity * (1 - 0.5 * F.grasp) * 127);
    cc(91, F.openness * 127);
  }
  function stop() { for (const n of held) noteOff(n); held.clear(); ready = false; out = null; }
  return { start, update, stop, get portName() { return out ? out.name : ''; } };
})();

const ENGINES = { synth: SoftSynth, samples: SampleEngine, midi: MidiEngine };
// engines STACK — synth + samples layer together (a fuller body); midi sends out
const COMBOS = [['synth'], ['synth', 'samples'], ['samples'], ['synth', 'midi'], ['midi']];
let comboIdx = 0;
const activeEngines = new Set();                 // engine keys currently started
function setCombo(idx) {
  comboIdx = ((idx % COMBOS.length) + COMBOS.length) % COMBOS.length;
  const target = new Set(COMBOS[comboIdx]);
  for (const k of [...activeEngines]) if (!target.has(k)) { ENGINES[k].stop?.(); activeEngines.delete(k); }
  for (const k of target) if (!activeEngines.has(k)) { ENGINES[k].start(); activeEngines.add(k); }
  updateSoundLabel();
}
function updateSoundLabel() {
  const b = document.getElementById('sound'); if (!b) return;
  const NM = { synth: 'Synth', samples: 'Samples', midi: 'MIDI' };
  let t = 'Sound · ' + COMBOS[comboIdx].map((k) => NM[k]).join(' + ');
  if (activeEngines.has('midi')) t += MidiEngine.portName ? ' · ' + MidiEngine.portName : ' · no port';
  b.textContent = t;
}

// =====================================================================
// INTERPRETER — hands -> Field. Engine-agnostic.
// =====================================================================
const PALM = [0, 5, 9, 13, 17], TIPS = [8, 12, 16, 20];
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17],
];
const INTERVALS = [7, 12, 5, 3];   // fifth / octave / fourth / minor third

const fPitch = new OneEuro(1.2, 0.02), fBright = new OneEuro(1.0, 0.02),
      fBody = new OneEuro(1.0, 0.015), fOpen = new OneEuro(0.8, 0.01),
      fPx = new OneEuro(1.4, 0.03), fPy = new OneEuro(1.4, 0.03);

function metrics(lm) {
  let px = 0, py = 0; for (const i of PALM) { px += lm[i].x; py += lm[i].y; } px /= PALM.length; py /= PALM.length;
  const size = Math.hypot(lm[9].x - lm[0].x, lm[9].y - lm[0].y) + 1e-6;
  let o = 0; for (const i of TIPS) o += Math.hypot(lm[i].x - px, lm[i].y - py);
  return { px, py, size, open: (o / TIPS.length) / size };
}

// pose classifier — finger extension ratios -> a named hand shape (a small
// grasp taxonomy: power / precision / intermediate, after Feix et al.)
function fingerExt(lm, m) {
  const ext = (tip) => Math.hypot(lm[tip].x - m.px, lm[tip].y - m.py) / m.size;
  return [ext(4), ext(8), ext(12), ext(16), ext(20)];            // [thumb, index, middle, ring, pinky]
}
function classifyPose(e) {
  const TH = 1.05, th = e[0] > 0.95;
  const up = [e[1] > TH, e[2] > TH, e[3] > TH, e[4] > TH];
  const n = up.filter(Boolean).length;
  if ([1, 2, 3, 4].every((k) => e[k] > 0.80 && e[k] <= TH)) return 'claw';   // all four half-curled = spherical
  if (n === 0) return th ? 'thumb' : 'fist';
  if (n === 1 && up[0]) return th ? 'L' : 'point';
  if (n === 2 && up[0] && up[1]) return 'peace';
  if (n === 3 && up[0] && up[1] && up[2]) return 'three';
  if (n === 4) return 'open';
  return n === 1 ? 'point' : n === 2 ? 'peace' : n === 3 ? 'three' : 'open';
}
// each pose names a chord (semitone offsets) + a register; debounced so only a
// DELIBERATE, held shape becomes an intent (no flicker on the way to it)
let _posePending = 'open', _poseStable = 0, _lastOnset = 0, _prevGrasp = 0, _prevUnion = 0;
function poseHold(raw) {
  if (raw === _posePending) _poseStable++; else { _posePending = raw; _poseStable = 0; }
  if (_poseStable >= 5 && Field.gesture !== _posePending) {
    Field.gesture = _posePending;
    const sc = MODES[Field.mode];
    const M = {
      fist: [[], 0], point: [[], 0], peace: [[7], 0], three: [[sc[2], 7], 0],
      open: [[sc[2], 7, sc[6]], 0], thumb: [[7], 12], claw: [[2, 7], 0], L: [[7, 12], 0],
    };
    const g = M[_posePending] || M.open;
    Field.chord = g[0]; Field.register = g[1];
  }
}

function interpret(results, t) {
  const hands = (results && results.landmarks) || [];
  Field.hands = hands.length;
  Field.accent *= 0.88; Field.bloom *= 0.92; Field.body *= 0.82;  // transients fade every frame
  if (hands.length === 0) {
    Field.intensity = lerp(Field.intensity, 0, 0.05);
    Field.motion = lerp(Field.motion, 0, 0.06);
    Field.stillness = lerp(Field.stillness, 1, 0.05);
    Field.grasp = lerp(Field.grasp, 0, 0.08);
    Field.pinch = lerp(Field.pinch, 0, 0.1);
    Field.calm = lerp(Field.calm, 0.85, 0.008);                   // rest -> coherence rises
    poseHold('open');
    return;                                   // pitch & co. hold where they were
  }
  // roles: the right-of-screen hand PLAYS (pitch/dynamics); the left-of-screen hand SHAPES the chord
  const present = hands.map((h) => ({ lm: h, m: metrics(h) }));
  let voice, chord;
  if (present.length >= 2) {
    present.sort((a, b) => (1 - a.m.px) - (1 - b.m.px));
    chord = present[0]; voice = present[present.length - 1];
  } else { voice = present[0]; chord = present[0]; }

  // hands brought together -> a binaural entrainment beat (the gap sets the beat)
  if (present.length >= 2) {
    const d = Math.hypot(present[0].m.px - present[1].m.px, present[0].m.py - present[1].m.py);
    Field.union = clamp(1 - (d - 0.12) / 0.5, 0, 1);              // 1 when the palms nearly meet
  } else Field.union = lerp(Field.union, 0, 0.12);
  Field.beat = lerp(14, 4, Field.union);                          // apart = fast · together = theta
  if (_prevUnion < 0.85 && Field.union >= 0.85) { Field.bloom = 1; Field.calm = Math.min(1, Field.calm + 0.2); }   // the meeting
  _prevUnion = Field.union;

  const m = voice.m, lm = voice.lm;                               // continuous expression
  Field.pitch = clamp(fPitch.filter(1 - m.px, t), 0, 1);
  Field.brightness = clamp(fBright.filter(1 - m.py, t), 0, 1);
  Field.intensity = clamp(fBody.filter(clamp((m.size - 0.10) / 0.26, 0, 1), t), 0, 1);
  Field.proximity = Field.intensity;
  Field.openness = clamp(fOpen.filter(clamp((m.open - 0.7) / 1.0, 0, 1), t), 0, 1);
  Field.grasp = lerp(Field.grasp, clamp((1.0 - m.open) / 0.5, 0, 1), 0.2);
  const pinchD = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / m.size;
  Field.pinch = lerp(Field.pinch, clamp((0.45 - pinchD) / 0.35, 0, 1), 0.25);
  fPx.filter(m.px, t); fPy.filter(m.py, t);
  const mot = clamp((fPx.speed + fPy.speed) * 0.6, 0, 1);
  Field.motion = lerp(Field.motion, mot, 0.3);
  Field.stillness = lerp(Field.stillness, 1 - clamp(mot * 1.4, 0, 1), 0.1);
  Field.calm = lerp(Field.calm, Field.stillness, 0.012);          // coherence builds slowly from stillness

  // ---- MOVEMENT EVENTS (the verbs): twist · swipe-stroke · grasp · release ----
  const ang = Math.atan2(lm[9].y - lm[0].y, lm[9].x - lm[0].x);
  Field.twist = lerp(Field.twist, (ang + Math.PI) / (2 * Math.PI), 0.15);                   // wrist rotation
  const vmag = Math.hypot(fPx.dx, fPy.dx);
  if (vmag > 1.3 && t - _lastOnset > 0.16) {                                                  // a rhythmic onset
    Field.body = 1; const per = t - _lastOnset;                                               // -> body thump + tempo
    if (per > 0.15 && per < 2.0) Field.tempo = lerp(Field.tempo, per, 0.4);
    _lastOnset = t; if (vmag > 2.2) Field.accent = 1;                                          // a hard swipe also accents
  }
  if (_prevGrasp < 0.5 && Field.grasp >= 0.5) { Field.accent = Math.max(Field.accent, 0.6); Field.freezeNow = true; }   // close hand -> freeze a layer
  if (_prevGrasp >= 0.5 && Field.grasp < 0.5) Field.bloom = 1;                               // release bloom
  _prevGrasp = Field.grasp;

  poseHold(classifyPose(fingerExt(chord.lm, chord.m)));           // discrete shape from the chord hand
}

// =====================================================================
// VISUAL FIELD — the camera dimmed, recursive fingertip trails, the
// hand drawn as glowing lines, a palm aura. Mode-hued. Quiet, not noisy.
// =====================================================================
const cv = document.getElementById('stage'), ctx2 = cv.getContext('2d');
let W = 0, H = 0, dpr = 1;
function resize() { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; cv.width = W * dpr; cv.height = H * dpr; ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); }
addEventListener('resize', resize); resize();

let trail = [];
function drawSkeleton(lm, hue) {
  ctx2.lineWidth = 2.0; ctx2.strokeStyle = `hsla(${hue},55%,72%,0.75)`;
  ctx2.shadowColor = `hsla(${hue},70%,60%,0.8)`; ctx2.shadowBlur = 14;
  for (const [a, b] of HAND_CONNECTIONS) { ctx2.beginPath(); ctx2.moveTo((1 - lm[a].x) * W, lm[a].y * H); ctx2.lineTo((1 - lm[b].x) * W, lm[b].y * H); ctx2.stroke(); }
  ctx2.shadowBlur = 0; ctx2.fillStyle = 'rgba(236,231,218,.92)';
  for (const p of lm) { ctx2.beginPath(); ctx2.arc((1 - p.x) * W, p.y * H, 3.0, 0, TAU); ctx2.fill(); }
}

// the playable scale as visible vertical zones — aim at a note, see where you are
function drawGrid() {
  const n = SCALE.length, bw = W / n, idx = clamp((Field.pitch * n) | 0, 0, n - 1), hue = HUE[Field.mode] || 215;
  for (let i = 0; i < n; i++) {
    const x = i * bw, on = i === idx && Field.hands > 0;
    ctx2.fillStyle = on ? `hsla(${hue},60%,60%,${0.10 + 0.22 * Field.pinch})` : 'rgba(236,231,218,0.025)';
    ctx2.fillRect(x + 1, 0, bw - 2, H);
    ctx2.fillStyle = on ? 'rgba(236,231,218,.95)' : 'rgba(236,231,218,.32)';
    ctx2.font = (on ? 'bold ' : '') + '12px Georgia'; ctx2.textAlign = 'center';
    ctx2.fillText(NOTE_NAMES[SCALE[i] % 12], x + bw / 2, H - 28);
  }
}
// the temple's breath — a slow halo to breathe with; warms gold as coherence rises
function drawBreath() {
  const cx = W / 2, cy = H / 2, base = Math.min(W, H) * 0.16;
  const r = base * (0.7 + 0.5 * Field.breath) * (1 + 0.4 * Field.calm);
  const warm = lerp(210, 45, Field.calm);            // agitated = cool blue · calm = warm gold
  const a = (Field.temple ? 0.16 : 0.06) + 0.10 * Field.calm;
  ctx2.globalCompositeOperation = 'lighter';
  const g = ctx2.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `hsla(${warm}, 70%, 70%, ${a})`);
  g.addColorStop(1, `hsla(${warm}, 70%, 60%, 0)`);
  ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(cx, cy, r, 0, TAU); ctx2.fill();
  ctx2.globalCompositeOperation = 'source-over';
}
const GESTURE_WORD = { fist: 'muted', point: 'a single voice', peace: 'a fifth', three: 'a triad', open: 'open seventh', thumb: 'lifted', claw: 'suspended', L: 'wide' };
function statusWord() {
  if (Field.frozen) return 'held';
  if (Field.hands === 0) return Field.temple ? 'breathe' : 'waiting';
  if (Field.union > 0.7) return 'union';
  if (Field.bloom > 0.5) return 'bloom';
  const note = NOTE_NAMES[SCALE[clamp((Field.pitch * SCALE.length) | 0, 0, SCALE.length - 1)] % 12];
  const g = GESTURE_WORD[Field.gesture] || Field.gesture;
  return note + ' · ' + g;                                  // the note flowing + the chord shape
}

function render(video, results, dt) {
  if (video && video.readyState >= 2) {
    ctx2.save(); ctx2.translate(W, 0); ctx2.scale(-1, 1); ctx2.globalAlpha = 0.5; ctx2.drawImage(video, 0, 0, W, H); ctx2.restore(); ctx2.globalAlpha = 1;
  } else { ctx2.fillStyle = '#06070a'; ctx2.fillRect(0, 0, W, H); }
  ctx2.fillStyle = 'rgba(6,7,10,0.5)'; ctx2.fillRect(0, 0, W, H);   // veil
  drawBreath();

  const hue = HUE[Field.mode] || 215;
  const hands = (results && results.landmarks) || [];
  ctx2.globalCompositeOperation = 'lighter';
  for (const lm of hands) {                                        // palm aura
    const m = metrics(lm), x = (1 - m.px) * W, y = m.py * H, r = Math.min(W, H) * (0.12 + Field.intensity * 0.33) * lerp(1, 0.55, Field.grasp);
    const grd = ctx2.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `hsla(${hue},55%,${42 + Field.brightness * 28}%,${0.05 + Field.intensity * 0.16})`);
    grd.addColorStop(1, `hsla(${hue},55%,45%,0)`);
    ctx2.fillStyle = grd; ctx2.beginPath(); ctx2.arc(x, y, r, 0, TAU); ctx2.fill();
    for (const i of TIPS) trail.push({ x: (1 - lm[i].x) * W, y: lm[i].y * H, life: 1, hue });
  }
  for (const p of trail) { ctx2.fillStyle = `hsla(${p.hue},60%,70%,${p.life * 0.5})`; ctx2.beginPath(); ctx2.arc(p.x, p.y, 2 + p.life * 3, 0, TAU); ctx2.fill(); }
  trail = trail.filter((p) => (p.life -= dt * 0.9) > 0);

  ctx2.globalCompositeOperation = 'source-over';
  for (const lm of hands) drawSkeleton(lm, hue);

  if (hands.length >= 2 && Field.union > 0.05) {                   // a light bridge as the hands meet
    const a = metrics(hands[0]), b = metrics(hands[1]);
    const ax = (1 - a.px) * W, ay = a.py * H, bx = (1 - b.px) * W, by = b.py * H;
    ctx2.globalCompositeOperation = 'lighter';
    ctx2.strokeStyle = `hsla(45, 80%, 75%, ${0.2 + 0.5 * Field.union})`;
    ctx2.lineWidth = 1 + 5 * Field.union; ctx2.beginPath(); ctx2.moveTo(ax, ay); ctx2.lineTo(bx, by); ctx2.stroke();
    const mx = (ax + bx) / 2, my = (ay + by) / 2, rr = 20 + 90 * Field.union;
    const ug = ctx2.createRadialGradient(mx, my, 0, mx, my, rr);
    ug.addColorStop(0, `hsla(45, 90%, 80%, ${0.5 * Field.union})`); ug.addColorStop(1, 'hsla(45,90%,70%,0)');
    ctx2.fillStyle = ug; ctx2.beginPath(); ctx2.arc(mx, my, rr, 0, TAU); ctx2.fill();
    ctx2.globalCompositeOperation = 'source-over';
  }

  if (Field.pinch > 0.15 && hands[0]) {                            // a summoned star at the pinch
    const h0 = hands[0], sx = (1 - (h0[4].x + h0[8].x) / 2) * W, sy = ((h0[4].y + h0[8].y) / 2) * H, rr = 6 + Field.pinch * 26;
    ctx2.globalCompositeOperation = 'lighter';
    const sg = ctx2.createRadialGradient(sx, sy, 0, sx, sy, rr);
    sg.addColorStop(0, `hsla(48, 90%, 82%, ${0.5 * Field.pinch})`);
    sg.addColorStop(1, 'hsla(48,90%,70%,0)');
    ctx2.fillStyle = sg; ctx2.beginPath(); ctx2.arc(sx, sy, rr, 0, TAU); ctx2.fill();
    ctx2.globalCompositeOperation = 'source-over';
  }

  ctx2.textAlign = 'center';
  ctx2.fillStyle = 'rgba(236,231,218,.92)'; ctx2.font = 'italic 30px Georgia';
  ctx2.fillText(statusWord(), W / 2, H * 0.5 - 4);
  ctx2.fillStyle = 'rgba(124,127,136,.95)'; ctx2.font = '13px Georgia';
  ctx2.fillText(`${NOTE_NAMES[Field.root]} ${Field.mode}`.toUpperCase(), W / 2, H * 0.5 + 22);
}

// =====================================================================
// MAIN LOOP + UI
// =====================================================================
const video = document.getElementById('cam');
let landmarker = null, results = null, lastVT = -1, running = false, last = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (running && landmarker && video.readyState >= 2 && video.currentTime !== lastVT) {
    lastVT = video.currentTime;
    try { results = landmarker.detectForVideo(video, now); } catch (e) { /* timestamp race — skip */ }
    if (results) interpret(results, now / 1000);
  }
  Field.breath = 0.5 + 0.5 * Math.sin((now / 1000) * 0.092 * TAU);   // the temple breathes ~5.5/min (coherence)
  if (running) for (const k of activeEngines) ENGINES[k].update(Field);
  render(video, results, dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

async function makeLandmarker() {
  const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
  const build = (delegate) => HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task", delegate },
    runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: 0.6, minTrackingConfidence: 0.5,
  });
  try { return await build("GPU"); } catch (e) { return await build("CPU"); }
}

const $ = (id) => document.getElementById(id);
let camMode = new URLSearchParams(location.search).get('cam') === 'user' ? 'user' : 'environment';
function camLabel() { const b = $('cam-toggle'); if (b) b.textContent = 'Camera · ' + (camMode === 'user' ? 'Front' : 'Rear'); }
async function begin() {
  if (running) return;
  $('start').disabled = true;
  $('loading').classList.remove('hidden'); $('loading').textContent = 'waking the field…';
  try {
    setCombo(comboIdx);                                          // start the chosen engine stack (in the gesture)
    landmarker = await makeLandmarker();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: camMode === 'user' ? 'user' : { ideal: 'environment' }, width: 1280, height: 720, frameRate: { ideal: 60 } }, audio: false });
    video.srcObject = stream; await video.play();
    running = true;
    $('loading').classList.add('hidden');
    $('startRow').classList.add('hidden');
    $('ctrlRow').classList.remove('hidden');
  } catch (e) {
    $('loading').textContent = 'could not start: ' + ((e && e.message) || e);
    $('start').disabled = false;
  }
}

function cycleMode() {
  Field.mode = MODE_NAMES[(MODE_NAMES.indexOf(Field.mode) + 1) % MODE_NAMES.length];
  SCALE = scaleNotes(Field.root, Field.mode);
}
function toggleFs() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

$('start').addEventListener('click', begin);
$('sound').addEventListener('click', () => setCombo(comboIdx + 1));
$('clear').addEventListener('click', () => SoftSynth.clearFrozen());
$('cam-toggle').addEventListener('click', () => { camMode = camMode === 'user' ? 'environment' : 'user'; camLabel(); });
camLabel();
$('temple').addEventListener('click', () => { Field.temple = !Field.temple; $('temple').classList.toggle('active', Field.temple); });
$('mode').addEventListener('click', cycleMode);
$('fs').addEventListener('click', toggleFs);
$('freeze').addEventListener('click', () => { Field.frozen = !Field.frozen; $('freeze').classList.toggle('active', Field.frozen); });
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFs();
  else if (e.key === 'm' || e.key === 'M') cycleMode();
  else if (e.key === 's' || e.key === 'S') $('sound').click();
  else if (e.key === 'c' || e.key === 'C') SoftSynth.clearFrozen();
  else if (e.key === 't' || e.key === 'T') $('temple').click();
  else if (e.key === ' ') { e.preventDefault(); $('freeze').click(); }
});
