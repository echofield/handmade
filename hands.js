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
import { HandLandmarker, ObjectDetector, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

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
  melody:0,        // left fist anchors a pedal -> the right hand strikes notes in-key
  chordMode:0,     // hand position plays a full diatonic chord; left pose = the quality
  keysMode:0,      // air-piano: each fingertip strikes a note on a downward jab
  strike:0.0,      // transient: a finger struck a note (decays) -> visual flash
  strikeX:0.5,     // horizontal position (0..1) of the last strike -> where to flash
  h0x:0.5, h0y:0.5, h1x:0.5, h1y:0.5,   // two hand anchors in screen space (mirrored to match the view) -> pin objects
  span:0.0,        // distance between the two hands (0..1) -> scale an object held between them
  objectsMode:0,   // the room is the instrument: archetypal Nodes you reach into to play
  catchMode:0,     // catch a REAL object (webcam object detection) -> it becomes an instrument
  objPresent:0, objX:0.5, objY:0.5, objSize:0.2, objFocus:0,   // the caught real object's anchor + state
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
// SMART MODE — an autonomous conductor. On a slow clock it walks the key
// through a curated progression of "worlds" (root + mode), rebuilding the
// scale so the drone bends inevitably into each new harmony. The cure for
// monotony: the music is always going somewhere, even while your hands rest.
// (after grammar.py's transposition_event — a modulation that feels inevitable)
// =====================================================================
const SmartConductor = (() => {
  let on = false, home = 9, step = 0, nextAt = 0;
  const WORLDS = [
    { dr: 0,  mode: 'aeolian' },   // home — minor gravity
    { dr: 5,  mode: 'aeolian' },   // up a fourth, still minor
    { dr: 5,  mode: 'dorian'  },   // same root, brightened
    { dr: 10, mode: 'ionian'  },   // a major sunrise
    { dr: 3,  mode: 'lydian'  },   // floating, weightless
    { dr: 7,  mode: 'aeolian' },   // the dominant pull home
  ];
  function enable(v) { on = v; if (on) { home = Field.root; step = 0; nextAt = 0; } }
  function isOn() { return on; }
  function tick(now) {                                   // now in seconds
    if (!on || now < nextAt) return;
    const w = WORLDS[step % WORLDS.length]; step++;
    Field.root = ((home + w.dr) % 12 + 12) % 12;
    Field.mode = w.mode;
    SCALE = scaleNotes(Field.root, Field.mode);          // the drone bends into the new world
    nextAt = now + 16 + Math.random() * 8;               // dwell 16-24s in each world
  }
  return { enable, isOn, tick };
})();

// SPATIAL LOOPER — capture a short performance of struck notes and place it as a
// persistent LoopNode that keeps playing and gently orbits. Event-based (re-triggers the
// synth, not audio buffers), bar-quantized, up to 4 layers, all aligned to ONE epoch so
// they stay in sync. This is a spatial looper, NOT a timeline DAW.
const Loops = (() => {
  const MAX = 4;
  const sessionId = Math.random().toString(36).slice(2, 10);            // for future persistence ("land it in the city")
  let masterLen = 0, epoch = 0, rec = null, loops = [];
  // RULE 1 — bind the playhead to the AUDIO hardware clock, never a JS timer; a vision-model
  // stall can't drift phase because every frame recomputes position by modulo from the epoch.
  const aclock = () => (SoftSynth.ready ? SoftSynth.now() : performance.now() / 1000);
  function isRec() { return !!rec; }
  function start(hx, hy, kind) { if (!epoch) epoch = aclock(); rec = { hx, hy, kind, t0: aclock(), events: [] }; }
  function note(midi) { if (rec) rec.events.push({ at: aclock(), midi }); }   // a struck note captured while recording
  function stop() {
    if (!rec) return;
    const raw = Math.max(0.25, aclock() - rec.t0);
    const len = masterLen ? Math.max(1, Math.round(raw / masterLen)) * masterLen : (masterLen = raw);   // FIRST loop sets the tempo
    const events = rec.events.map((e) => ({ t: ((e.at - epoch) % len + len) % len, midi: e.midi }));    // events are simple {t,midi} — serializable
    if (events.length) {
      if (loops.length >= MAX) loops.shift();
      loops.push({ hx: rec.hx, hy: rec.hy, kind: rec.kind, len, events, level: 0, active: 1, last: null, prog: 0, phase: Math.random() * TAU, createdAt: Date.now(), sessionId });
    }
    rec = null;
  }
  function tick() {                                                      // fire due events; phase from the audio clock
    if (!epoch) return; const n = aclock();
    for (const lp of loops) {
      lp.level *= 0.90;                                                  // visual pulse decays
      if (!lp.active) { lp.prog = 0; continue; }
      const local = ((n - epoch) % lp.len + lp.len) % lp.len, prev = lp.last == null ? local : lp.last;
      const fire = (e) => { SoftSynth.strike(e.midi); lp.level = 1; };
      if (local >= prev) { for (const e of lp.events) if (e.t > prev && e.t <= local) fire(e); }
      else { for (const e of lp.events) if (e.t > prev || e.t <= local) fire(e); }   // wrapped past the loop point
      lp.last = local; lp.prog = local / lp.len;                        // 0..1 playhead for the orbital comet
    }
  }
  function influence(present) {                                          // a hand near a loop emphasizes it
    for (const lp of loops) for (let hi = 0; hi < present.length && hi < 2; hi++) {
      const m = present[hi].m; if (Math.hypot((1 - m.px) - lp.hx, m.py - lp.hy) < 0.13) lp.level = Math.max(lp.level, 0.85);
    }
  }
  // RULE 2 — flat fixed-width proxy: per loop only x, y, level (-1 = empty), kind, progress.
  // The browser keeps the tape; Unity only ever sees the playhead.
  function writeField() {
    const n = aclock(); Field.loopCount = loops.length;
    for (let i = 0; i < MAX; i++) {
      const lp = loops[i];
      Field['loop' + i + 'x'] = lp ? lp.hx + Math.cos(n * 0.3 + lp.phase) * 0.025 : 0.5;
      Field['loop' + i + 'y'] = lp ? lp.hy + Math.sin(n * 0.3 + lp.phase) * 0.025 : 0.5;
      Field['loop' + i + 'level'] = lp ? lp.level : -1;                 // -1 = inactive/empty slot
      Field['loop' + i + 'kind'] = lp ? lp.kind : -1;
      Field['loop' + i + 'prog'] = lp ? lp.prog : 0;
    }
  }
  function snapshot() { return { sessionId, masterLen, loops: loops.map((l) => ({ hx: l.hx, hy: l.hy, kind: l.kind, len: l.len, events: l.events, createdAt: l.createdAt })) }; }   // portable JSON (future save)
  return { isRec, start, note, stop, tick, influence, writeField, snapshot };
})();

// CHORD MODE — play full diatonic chords by hand position; the left-hand pose picks the
// quality. Built from the live SCALE so chords stay in-key and follow Smart Mode's key.
function diatonicChord(idx, pose) {
  const n = SCALE.length, root = SCALE[clamp(idx, 0, n - 1)];
  const at = (k) => SCALE[clamp(idx + k, 0, n - 1)] - root;   // diatonic interval, in semitones
  const third = at(2), fifth = at(4), seventh = at(6);
  switch (pose) {
    case 'open':  return [third, fifth, seventh];   // four fingers -> a lush 7th
    case 'three': return [third, fifth];            // three -> a clean triad
    case 'peace': return [5, fifth];                // two -> suspended (sus4)
    case 'point': return [fifth];                   // one -> a bare fifth (power)
    case 'fist':  return [];                         // fist -> the root alone
    default:      return [third, fifth];            // triad
  }
}

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
  let ctx, master, filt, warm, dry, wet, voices, lfo, lfoG, hf, ho, gh, curMidi, frozen = [], frozenPtr = 0, dlyFb, dlyMix, leadPtr = 0, lastLeadIdx = -1, recDest = null, pulseOn = false, pulseNext = 0, pulseStep = 0, pulseBPM = 58;
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
    warm = ctx.createWaveShaper(); warm.curve = warmCurve(0.42); warm.oversample = '2x';
    dry = ctx.createGain(); dry.gain.value = 0.62;
    wet = ctx.createGain(); wet.gain.value = 0.4;
    const rev = ctx.createConvolver(); rev.buffer = makeIR(5.0);
    voices = ctx.createGain(); voices.gain.value = 0;
    voices.connect(filt); filt.connect(warm);
    warm.connect(dry); warm.connect(rev);
    dry.connect(master); rev.connect(wet); wet.connect(master);
    const limiter = ctx.createDynamicsCompressor();   // brick-wall: stacked voices can never hard-clip the output
    limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.003; limiter.release.value = 0.25;
    master.connect(comp); comp.connect(limiter); limiter.connect(ctx.destination);
    recDest = ctx.createMediaStreamDestination(); limiter.connect(recDest);   // a (limited) tap for the Record button
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
    osc.gSub = ctx.createGain(); osc.gSub.gain.value = 0.5; osc.sub.connect(osc.gSub); osc.gSub.connect(voices);
    osc.low.connect(g(0.45)); osc.fund.connect(g(0.6)); osc.high.connect(g(0.45));
    osc.gShim = ctx.createGain(); osc.gShim.gain.value = 0; osc.shim.connect(osc.gShim); osc.gShim.connect(voices);
    // a deep tonic PEDAL — grounds melody mode without freezing the pad's gliding wave
    osc.pedal = mkOsc(); osc.gPedal = ctx.createGain(); osc.gPedal.gain.value = 0;
    osc.pedal.connect(osc.gPedal); osc.gPedal.connect(voices);
    // PULSE kick — a soft sub heartbeat for the ambient pulse (created here, after lfoG, so mkOsc is safe)
    osc.kick = mkOsc(); osc.gKick = ctx.createGain(); osc.gKick.gain.value = 0;
    osc.kick.connect(osc.gKick); osc.gKick.connect(master); osc.gKick.connect(rev);

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
      const fg = ctx.createGain(); fg.gain.value = 0;        // capture level (set on freeze)
      const lifeG = ctx.createGain(); lifeG.gain.value = 1;  // slow amplitude breath, independent per layer
      const pan = ctx.createStereoPanner();                  // slow stereo wander, independent per layer
      a.connect(fg); b.connect(fg); fg.connect(lifeG); lifeG.connect(pan); pan.connect(master); pan.connect(rev);
      frozen.push({ a, b, fg, lifeG, pan,
        aRate: 0.03 + Math.random() * 0.06, aPhase: Math.random() * TAU,    // amplitude drift (period ~11-33s)
        pRate: 0.02 + Math.random() * 0.05, pPhase: Math.random() * TAU }); // pan drift
    }
    frozenPtr = 0;

    // MELODY LEAD — a small plucked-voice pool; overlapping tails = an ambient cascade.
    // Left-fist pedals the drone to the tonic; the right hand strikes these, quantized in-key.
    osc.lead = [];
    for (let k = 0; k < 4; k++) {
      const o = mkOsc(); o.type = 'triangle';
      const lf = ctx.createBiquadFilter(); lf.type = 'lowpass'; lf.frequency.value = 2800; lf.Q.value = 0.5;
      const lg = ctx.createGain(); lg.gain.value = 0;
      o.connect(lf); lf.connect(lg); lg.connect(master); lg.connect(rev);
      osc.lead.push({ o, lg });
    }
    leadPtr = 0; lastLeadIdx = -1;

    // GRABBED SYNTH — the synth node's voice (a filtered saw), gated by reaching into the node
    osc.gsyn = mkOsc(); osc.gsyn.type = 'sawtooth';
    osc.gsynF = ctx.createBiquadFilter(); osc.gsynF.type = 'lowpass'; osc.gsynF.frequency.value = 1200; osc.gsynF.Q.value = 0.7;
    osc.gGsyn = ctx.createGain(); osc.gGsyn.gain.value = 0;
    osc.gsyn.connect(osc.gsynF); osc.gsynF.connect(osc.gGsyn); osc.gGsyn.connect(master); osc.gGsyn.connect(rev);

    // SATURN'S DRONE — two detuned sines, a low structural hum held while you reach into the node
    osc.gdrA = mkOsc(); osc.gdrB = mkOsc(); osc.gdrB.detune.value = 8;
    osc.gGdr = ctx.createGain(); osc.gGdr.gain.value = 0;
    osc.gdrA.connect(osc.gGdr); osc.gdrB.connect(osc.gGdr); osc.gGdr.connect(master); osc.gGdr.connect(rev);

    curMidi = SCALE[(SCALE.length / 2) | 0];
    if (ctx.state === 'suspended') ctx.resume();
    master.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 3);
  }

  function update(F) {
    if (!ctx) return; const now = ctx.currentTime;
    const idx = clamp((F.pitch * SCALE.length) | 0, 0, SCALE.length - 1);
    const reg = F.register | 0;
    curMidi += (SCALE[idx] - curMidi) * (F.frozen ? 0.02 : 0.16);             // the PAD WAVE keeps gliding in every mode (preserved)
    if (F.melody) {
      if (idx !== lastLeadIdx) { pluckLead(SCALE[idx] + reg); lastLeadIdx = idx; }   // melody: each new degree strikes the pad's note over a deep tonic pedal
    } else { lastLeadIdx = -1; }
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
    const lowTilt = 1 - F.brightness, highTilt = F.brightness;               // VERTICAL THEREMIN: hand low -> sub/dark, high -> air/fx
    const amp = F.frozen ? Math.max(F.intensity, 0.5) : F.intensity;          // closer to camera = more sound
    voices.gain.setTargetAtTime(lerp(0.0, 0.95, amp) * lerp(1, 0.5, F.grasp) * (1 + F.accent * 0.25) * breathSwell * (F.objectsMode ? 0.12 : 1), now, 0.12);   // node mode: the drone recedes, the objects speak
    filt.frequency.setTargetAtTime((lerp(340, 6500, F.brightness * 0.85 + F.proximity * 0.15) * calmDark * lerp(1, 1.12, F.breath) + F.accent * 3000) * lerp(1, 0.3, F.grasp), now, 0.06);
    osc.gShim.gain.setTargetAtTime((lerp(0, 0.28, highTilt) + F.bloom * 0.15) * calmPure, now, 0.25);
    if (osc.gSub) osc.gSub.gain.setTargetAtTime(lerp(0.5, 0.95, lowTilt) * lerp(1, 0.6, F.grasp), now, 0.12);  // hand drops -> the sub swells up
    if (osc.pedal) { osc.pedal.frequency.setTargetAtTime(midiToFreq(SCALE[0]), now, 0.1); osc.gPedal.gain.setTargetAtTime(F.melody ? 0.4 : 0, now, 0.3); }  // tonic pedal only while melody mode grounds the pad
    osc.low.detune.setTargetAtTime((-7 - (F.twist - 0.5) * 26) * calmPure, now, 0.2);   // calm narrows the chorus -> purer
    osc.high.detune.setTargetAtTime((7 + (F.twist - 0.5) * 26) * calmPure, now, 0.2);
    if (dlyFb) dlyFb.gain.setTargetAtTime(lerp(0.4, 0.6, F.calm), now, 0.5);            // calm opens the space
    if (dlyMix) dlyMix.gain.setTargetAtTime(lerp(0.5, 0.8, F.calm) + highTilt * 0.15, now, 0.5);  // hand high -> more echo/space

    // the pose names a chord; in CHORD MODE the hand position plays a full diatonic chord
    const ch = F.chordMode ? diatonicChord(idx, F.gesture) : (F.chord || []);
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

    // openness -> space ; proximity -> drier & more intimate ; hand-height -> reverb bloom
    wet.gain.setTargetAtTime((lerp(0.15, 0.8, F.openness) + highTilt * 0.35) * lerp(1, 0.65, F.proximity) * lerp(1, 0.4, F.grasp) + F.bloom * 0.3, now, 0.3);
    dry.gain.setTargetAtTime(lerp(0.5, 0.78, F.proximity), now, 0.3);

    // PER-LAYER LIFE — each frozen layer breathes and wanders the stereo field on its own,
    // so a held drone keeps moving even when the hands rest (after schollz/conductor).
    for (const v of frozen) {
      if (!v.lifeG) continue;
      v.lifeG.gain.setTargetAtTime(0.7 + 0.3 * Math.sin(now * v.aRate * TAU + v.aPhase), now, 0.3);
      v.pan.pan.setTargetAtTime(0.6 * Math.sin(now * v.pRate * TAU + v.pPhase), now, 0.4);
    }

    // AMBIENT PULSE — a gesture-driven, probabilistic heartbeat that stays in-key.
    if (pulseOn) {
      const stepDur = 60 / pulseBPM / 4;                                      // 16th-note grid
      const dens = clamp(0.25 + F.intensity * 0.7 + F.motion * 0.25, 0, 1);   // closer & more motion -> fuller
      let guard = 0;
      while (now >= pulseNext && guard++ < 8) {
        firePulseStep(pulseStep % 16, dens, pulseNext + ((pulseStep % 2) ? stepDur * 0.12 : 0));   // gentle swing on odd steps
        pulseStep++; pulseNext += stepDur;
      }
    }
  }

  function firePulseStep(s, dens, when) {
    // a soft sub heartbeat on the strong beats (always 0 & 8; 4 & 12 as density rises)
    const strong = s === 0 || s === 8 || ((s === 4 || s === 12) && dens > 0.4);
    if (strong) {
      const f0 = midiToFreq(SCALE[0]) * 0.5;
      osc.kick.frequency.cancelScheduledValues(when);
      osc.kick.frequency.setValueAtTime(f0, when);
      osc.kick.frequency.exponentialRampToValueAtTime(f0 * 0.5, when + 0.12);   // a soft pitch-drop thump
      osc.gKick.gain.cancelScheduledValues(when);
      osc.gKick.gain.setValueAtTime(0.0001, when);
      osc.gKick.gain.linearRampToValueAtTime(0.4, when + 0.006);
      osc.gKick.gain.setTargetAtTime(0.0001, when + 0.02, 0.13);
    }
    // probabilistic in-key plucks weave an ambient arpeggio (follows Smart Mode's key)
    if (Math.random() < dens * (strong ? 0.18 : 0.6)) {
      const deg = [0, 4, 2, 6, 1, 5, 3, 6][s % 8];
      pluckLead(SCALE[clamp(deg + 7, 0, SCALE.length - 1)]);
    }
  }
  function setPulse(v) { pulseOn = v; if (pulseOn && ctx) { pulseNext = ctx.currentTime + 0.08; pulseStep = 0; } }
  function setBPM(b) { pulseBPM = clamp(b | 0, 30, 140); }
  function recStream() { return recDest ? recDest.stream : null; }

  function strike(midi) { pluckLead(midi); }     // air-piano: a fingertip strikes a plucked note

  function pluckLead(midi) {
    if (!osc.lead || !osc.lead.length) return;
    const v = osc.lead[leadPtr % osc.lead.length]; leadPtr++;
    const now = ctx.currentTime, hz = midiToFreq(midi);
    v.o.frequency.setTargetAtTime(hz, now, 0.004);
    v.lg.gain.cancelScheduledValues(now);
    v.lg.gain.setValueAtTime(Math.max(v.lg.gain.value, 0.0001), now);
    v.lg.gain.linearRampToValueAtTime(0.32, now + 0.012);          // the strike
    v.lg.gain.setTargetAtTime(0.0001, now + 0.02, 0.5);            // ring out -> an ambient tail
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
  // a one-shot white-noise source (for snare/hat transients)
  function noiseBurst(dur) {
    const len = (ctx.sampleRate * dur) | 0, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = b; return s;
  }
  // DRUM NODE — synthesized percussion; the hand's height picks the piece
  function hit(kind) {
    if (!ctx) return; const now = ctx.currentTime;
    if (kind === 'kick') {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(150, now); o.frequency.exponentialRampToValueAtTime(48, now + 0.12);
      g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.95, now + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
      o.connect(g); g.connect(master); g.connect(rev); o.start(now); o.stop(now + 0.32);
    } else if (kind === 'snare') {
      const nb = noiseBurst(0.2), bp = ctx.createBiquadFilter(), g = ctx.createGain();
      bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
      g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.6, now + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      nb.connect(bp); bp.connect(g); g.connect(master); g.connect(rev); nb.start(now); nb.stop(now + 0.2);
      const o = ctx.createOscillator(), og = ctx.createGain();
      o.frequency.value = 190; og.gain.setValueAtTime(0.3, now); og.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
      o.connect(og); og.connect(master); o.start(now); o.stop(now + 0.13);
    } else {                                                       // hat
      const nb = noiseBurst(0.05), hp = ctx.createBiquadFilter(), g = ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 7000;
      g.gain.setValueAtTime(0.0001, now); g.gain.exponentialRampToValueAtTime(0.3, now + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      nb.connect(hp); hp.connect(g); g.connect(master); nb.start(now); nb.stop(now + 0.06);
    }
  }
  // OCEAN's voice — a sustained nappe held while you reach into the node
  function grabSynth(on, midi, bright, level) {
    if (!ctx) return; const now = ctx.currentTime;
    if (on) { osc.gsyn.frequency.setTargetAtTime(midiToFreq(midi), now, 0.04); osc.gsynF.frequency.setTargetAtTime(lerp(400, 4200, bright), now, 0.06); }
    osc.gGsyn.gain.setTargetAtTime(on ? 0.2 * level : 0, now, 0.06);
  }
  // SATURN's voice — a low structural drone
  function nodeDrone(on, midi, level) {
    if (!ctx) return; const now = ctx.currentTime;
    if (on) { osc.gdrA.frequency.setTargetAtTime(midiToFreq(midi), now, 0.12); osc.gdrB.frequency.setTargetAtTime(midiToFreq(midi), now, 0.12); }
    osc.gGdr.gain.setTargetAtTime(on ? 0.18 * level : 0, now, 0.2);
  }

  function stop() {
    if (!ctx) return; const c = ctx;
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setTargetAtTime(0, c.currentTime, 0.15);
    setTimeout(() => c.close(), 500); ctx = null;
  }
  return { start, update, stop, clearFrozen, setPulse, setBPM, recStream, strike, hit, grabSynth, nodeDrone, now: () => (ctx ? ctx.currentTime : 0), get pulseOn() { return pulseOn; }, get ready() { return !!ctx; } };
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
    master.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 3);
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
    if (Field.chordMode) Field.bloom = 1;            // chord mode: each new chord blooms the space (reward the change)
    const sc = MODES[Field.mode];
    const M = {
      fist: [[], 0], point: [[], 0], peace: [[7], 0], three: [[sc[2], 7], 0],
      open: [[sc[2], 7, sc[6]], 0], thumb: [[7], 12], claw: [[2, 7], 0], L: [[7, 12], 0],
    };
    const g = M[_posePending] || M.open;
    Field.chord = g[0]; Field.register = g[1];
  }
}

// AIR PIANO — each fingertip is a striker. A quick downward jab plays a pluck at
// the scale-note under that fingertip; polyphonic across both hands. Velocity +
// per-finger debounce so only a deliberate tap fires, never a slow drift.
const KEY_TIPS = [8, 12, 16, 20];                 // index · middle · ring · pinky
let _keyState = [], _lastKeyT = 0;
function detectKeys(present, t) {
  const dt = Math.max(1e-3, t - _lastKeyT); _lastKeyT = t;
  for (let hi = 0; hi < present.length && hi < 2; hi++) {
    if (!_keyState[hi]) _keyState[hi] = KEY_TIPS.map(() => ({ y: null, last: 0 }));
    const lm = present[hi].lm;
    for (let fi = 0; fi < KEY_TIPS.length; fi++) {
      const tip = KEY_TIPS[fi], ty = lm[tip].y, st = _keyState[hi][fi];
      if (st.y !== null) {
        const vy = (ty - st.y) / dt;                                   // +y points down the screen
        if (vy > 2.2 && t - st.last > 0.16) {                          // a downward jab = a key strike
          st.last = t;
          const tx = lm[tip].x, idx = clamp(((1 - tx) * SCALE.length) | 0, 0, SCALE.length - 1), midi = SCALE[idx] + (Field.register | 0);
          SoftSynth.strike(midi); Loops.note(midi);                    // sound the note + feed the looper
          Field.strike = 1; Field.strikeX = 1 - tx;                    // flag the event for the bridge / visuals
        }
      }
      st.y = ty;
    }
  }
}

// THE GRAMMAR — a Node is generic: it exposes sound · visual · meaning · behavior.
// We instantiate ARCHETYPES, never "drum/synth". Sound is one manifestation among four;
// the others (visual in Unity, meaning, behavior) hang off the same key. Space is the interface.
const ARCHETYPES = ['fire', 'ocean', 'saturn', 'sun', 'moon', 'tree', 'wind', 'memory'];
const ARCH_HUE = [18, 200, 45, 50, 230, 130, 170, 280];   // shared with Unity (field-spec archetypeHue)
const NODES = [
  { key: 'fire',   kind: 0, x: 0.30, y: 0.56, sound: 'perc',  reach: 0.20 },   // action
  { key: 'ocean',  kind: 1, x: 0.70, y: 0.56, sound: 'pad',   reach: 0.20 },   // calm
  { key: 'saturn', kind: 2, x: 0.50, y: 0.30, sound: 'drone', reach: 0.20 },   // structure
];
let _nodeFx = NODES.map(() => ({ focus: 0, level: 0 })), _nodeTap = [], _lastNodeT = 0;

function updateNodes(present, t) {
  const dt = Math.max(1e-3, t - _lastNodeT); _lastNodeT = t;
  const focus = NODES.map(() => 0);
  let padOn = false, padMidi = 60, padBright = 0.5, padLvl = 0, droOn = false, droMidi = 33, droLvl = 0;

  for (let hi = 0; hi < present.length && hi < 2; hi++) {
    const m = present[hi].m, hx = 1 - m.px, hy = m.py;            // hand in mirrored screen space (matches node coords)
    let best = -1, bd = 1e9;
    for (let ni = 0; ni < NODES.length; ni++) {
      const d = Math.hypot(hx - NODES[ni].x, hy - NODES[ni].y);
      if (d < NODES[ni].reach && d < bd) { bd = d; best = ni; }
    }
    if (best < 0) continue;
    focus[best] = 1;
    const node = NODES[best], near = clamp(1 - bd / node.reach, 0.15, 1);
    if (node.sound === 'perc') {                                  // FIRE — taps strike percussion; height picks the piece
      if (!_nodeTap[hi]) _nodeTap[hi] = { y: null, last: 0 };
      const ty = present[hi].lm[8].y, st = _nodeTap[hi];
      if (st.y !== null) {
        const vy = (ty - st.y) / dt;
        if (vy > 2.0 && t - st.last > 0.13) { st.last = t; SoftSynth.hit(hy > 0.62 ? 'kick' : hy > 0.42 ? 'snare' : 'hat'); _nodeFx[best].level = 1; }
      }
      st.y = ty;
    } else if (node.sound === 'pad') {                            // OCEAN — reach sings a nappe; x=pitch, height=brightness
      const idx = clamp((hx * SCALE.length) | 0, 0, SCALE.length - 1);
      padOn = true; padMidi = SCALE[idx] + (Field.register | 0); padBright = clamp(1 - hy, 0, 1); padLvl = near; _nodeFx[best].level = near;
    } else if (node.sound === 'drone') {                          // SATURN — a low structural hum, an octave down
      const idx = clamp((hx * SCALE.length) | 0, 0, SCALE.length - 1);
      droOn = true; droMidi = SCALE[idx] - 12; droLvl = near; _nodeFx[best].level = near;
    }
  }

  SoftSynth.grabSynth(padOn, padMidi, padBright, padLvl);
  SoftSynth.nodeDrone(droOn, droMidi, droLvl);
  for (let ni = 0; ni < NODES.length; ni++) {
    _nodeFx[ni].focus = focus[ni];
    if (NODES[ni].sound === 'perc') _nodeFx[ni].level *= 0.82;    // a decaying flash
    else if (!focus[ni]) _nodeFx[ni].level *= 0.85;              // sustained levels ease off on release
  }
  writeNodeField();
}

// publish node state to the Field so Unity can render each archetype (up to 4 slots)
function writeNodeField() {
  Field.nodeCount = NODES.length;
  for (let i = 0; i < 4; i++) {
    const n = NODES[i], fx = _nodeFx[i];
    Field['n' + i + 'x'] = n ? n.x : 0.5; Field['n' + i + 'y'] = n ? n.y : 0.5;
    Field['n' + i + 'kind'] = n ? n.kind : -1;
    Field['n' + i + 'focus'] = fx ? fx.focus : 0; Field['n' + i + 'lvl'] = fx ? fx.level : 0;
  }
}
writeNodeField();

// CATCH — a REAL object becomes a Node. MediaPipe's Object Detector finds common
// things (cup, bottle, book, phone…); we ignore 'person' so it locks onto what you
// hold. Reach your hand onto the object and it sings — the world itself is the rack.
let _caught = null, detector = null, detections = [], _lastDetT = 0, _bound = null, _prevPinchC = 0, _lastCatchT = 0, _catchTap = [];

// the detected object (ignoring 'person') nearest a point, in mirrored screen space
function nearestDetection(hx, hy) {
  let best = null, bd = 1e9, vw = video.videoWidth, vh = video.videoHeight;
  for (const d of detections) {
    const c = d.categories && d.categories[0]; if (!c || c.categoryName === 'person') continue;
    const bb = d.boundingBox, cx = 1 - (bb.originX + bb.width / 2) / vw, cy = (bb.originY + bb.height / 2) / vh;
    const dist = Math.hypot(hx - cx, hy - cy);
    if (dist < bd) { bd = dist; best = { cx, cy, w: bb.width / vw, h: bb.height / vh, label: c.categoryName || 'object', dist }; }
  }
  return best;
}

// PLACE & PLAY — pinch to DROP a pad where your hand is (themed by a real object if one's
// there, else a plain pad). It STAYS PUT, so your hands are free to play it: tap near it to
// strike a note (pitch by its position). Pinch the pad again to remove it. This is both the
// fix for "if I hold it I can't play it" and the table-MIDI-pad — one mechanism.
function updateCatch(present, t) {
  if (!video.videoWidth) return;
  const pinching = Field.pinch > 0.6;
  if (pinching && _prevPinchC <= 0.6 && present.length) {                 // a pinch = place / re-theme / remove
    const m = present[0].m, hx = 1 - m.px, hy = m.py;
    if (_bound && Math.hypot(hx - _bound.cx, hy - _bound.cy) < 0.12) { _bound = null; }   // pinch the pad -> remove it
    else {
      const c = nearestDetection(hx, hy), near = c && c.dist < 0.22;
      _bound = { cx: hx, cy: hy, label: near ? c.label : 'pad', w: near ? c.w : 0.16, h: near ? c.h : 0.16 };   // place a pad here
    }
  }
  _prevPinchC = Field.pinch;
  if (!_bound) { _caught = null; Field.objPresent = 0; return; }

  _caught = _bound; Field.objPresent = 1; Field.objX = _bound.cx; Field.objY = _bound.cy; Field.objSize = _bound.w;
  const dt = Math.max(1e-3, t - _lastCatchT); _lastCatchT = t;
  let focus = 0;
  for (let hi = 0; hi < present.length && hi < 2; hi++) {
    const m = present[hi].m, hx = 1 - m.px, hy = m.py;
    if (Math.hypot(hx - _bound.cx, hy - _bound.cy) < 0.17) {
      focus = 1;
      if (!_catchTap[hi]) _catchTap[hi] = { y: null, last: 0 };
      const ty = present[hi].lm[8].y, st = _catchTap[hi];                  // index fingertip
      if (st.y !== null) {
        const vy = (ty - st.y) / dt;
        if (vy > 2.0 && t - st.last > 0.13) {                             // a downward tap -> a note
          st.last = t;
          const idx = clamp((_bound.cx * SCALE.length) | 0, 0, SCALE.length - 1), midi = SCALE[idx] + (Field.register | 0);
          SoftSynth.strike(midi); Loops.note(midi);                      // sound the note + feed the looper
          Field.strike = 1; Field.strikeX = _bound.cx;                    // reuse the strike flash (web ripple + Unity)
        }
      }
      st.y = ty;
    }
  }
  Field.objFocus = focus;
}

function interpret(results, t) {
  const hands = (results && results.landmarks) || [];
  Field.hands = hands.length;
  Field.accent *= 0.88; Field.bloom *= 0.92; Field.body *= 0.82; Field.strike *= 0.80;  // transients fade every frame
  if (hands.length === 0) {
    Field.intensity = lerp(Field.intensity, 0, 0.05);
    Field.motion = lerp(Field.motion, 0, 0.06);
    Field.stillness = lerp(Field.stillness, 1, 0.05);
    Field.grasp = lerp(Field.grasp, 0, 0.08);
    Field.pinch = lerp(Field.pinch, 0, 0.1);
    Field.calm = lerp(Field.calm, 0.85, 0.008);                   // rest -> coherence rises
    if (Field.objectsMode || Field.catchMode) { SoftSynth.grabSynth(false); SoftSynth.nodeDrone(false); }   // hands gone -> node voices release
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
  Field.melody = (hands.length >= 2 && Field.gesture === 'fist') ? 1 : 0;   // left fist anchors -> the right hand plays melody
  if (Field.keysMode) detectKeys(present, t); else _lastKeyT = t;          // air-piano runs on raw fingertip velocity

  // hand anchors (normalized screen space, mirrored to match the view) so Unity can pin objects to the hands
  if (present.length >= 2) {
    Field.h0x = 1 - present[0].m.px; Field.h0y = present[0].m.py;
    Field.h1x = 1 - present[1].m.px; Field.h1y = present[1].m.py;
    Field.span = clamp(Math.hypot(present[0].m.px - present[1].m.px, present[0].m.py - present[1].m.py), 0, 1);
  } else {
    Field.h0x = Field.h1x = 1 - voice.m.px; Field.h0y = Field.h1y = voice.m.py; Field.span = 0;
  }

  if (Field.objectsMode) updateNodes(present, t); else _lastNodeT = t;   // the room is the instrument
  if (Field.catchMode) updateCatch(present, t);                          // a real object becomes the instrument
  Loops.influence(present);                                              // hands emphasize nearby loops
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
// CHORD GLYPH — in chord mode the chord becomes a shape: a polygon whose number of
// sides equals the number of voices. Root = a point, fifth = a line, triad = a
// triangle, seventh = a square. It turns with your wrist (twist) and brightens as
// you lean in (intensity). The shape IS the chord — you learn harmony by its form.
const CHORD_QUALITY = { open: '7th', three: 'triad', peace: 'sus4', point: '5th', fist: 'root' };
function chordVoices(F) {
  const idx = clamp((F.pitch * SCALE.length) | 0, 0, SCALE.length - 1);
  return diatonicChord(idx, F.gesture).length + 1;   // root + offsets = total voices
}
function drawChordGlyph(cx, cy, F) {
  const n = chordVoices(F), hue = HUE[F.mode] || 215;
  const R = Math.min(W, H) * (0.06 + 0.10 * F.intensity);
  const rot = F.twist * TAU - Math.PI / 2;            // a vertex points up; the wrist spins it
  ctx2.globalCompositeOperation = 'lighter';
  const g = ctx2.createRadialGradient(cx, cy, 0, cx, cy, R * 1.7);   // a soft aura behind the glyph
  g.addColorStop(0, `hsla(${hue},60%,68%,${0.10 + 0.26 * F.intensity})`);
  g.addColorStop(1, `hsla(${hue},60%,60%,0)`);
  ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(cx, cy, R * 1.7, 0, TAU); ctx2.fill();

  if (n <= 1) {                                       // root alone — a single point
    ctx2.fillStyle = `hsla(${hue},70%,82%,${0.7 + 0.3 * F.intensity})`;
    ctx2.beginPath(); ctx2.arc(cx, cy, 5 + 5 * F.intensity, 0, TAU); ctx2.fill();
  } else {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * TAU; pts.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
    ctx2.lineWidth = 2 + 3 * F.intensity;
    ctx2.strokeStyle = `hsla(${hue},65%,80%,${0.45 + 0.45 * F.intensity})`;
    ctx2.shadowColor = `hsla(${hue},70%,60%,0.85)`; ctx2.shadowBlur = 18;
    ctx2.beginPath(); ctx2.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n; i++) ctx2.lineTo(pts[i][0], pts[i][1]);
    if (n > 2) ctx2.closePath();                      // 2 voices stay an open line; 3+ close into a polygon
    ctx2.stroke(); ctx2.shadowBlur = 0;
    ctx2.fillStyle = 'rgba(236,231,218,.95)';
    for (const [x, y] of pts) { ctx2.beginPath(); ctx2.arc(x, y, 3.2 + 2 * F.intensity, 0, TAU); ctx2.fill(); }   // a node per voice
  }
  ctx2.globalCompositeOperation = 'source-over';
}
// THE NODES, drawn — each archetype as a glowing glyph at its place in the room.
// fire = a triangle, saturn = a ringed planet, the rest = a soft ring; brighten on reach.
function drawNodes() {
  for (let i = 0; i < NODES.length; i++) {
    const n = NODES[i], fx = _nodeFx[i], x = n.x * W, y = n.y * H;
    const hue = ARCH_HUE[n.kind] != null ? ARCH_HUE[n.kind] : 200;
    const r = Math.min(W, H) * (0.07 + 0.03 * fx.focus + 0.05 * fx.level);
    ctx2.globalCompositeOperation = 'lighter';
    const g = ctx2.createRadialGradient(x, y, 0, x, y, r * 1.9);
    g.addColorStop(0, `hsla(${hue},60%,66%,${0.10 + 0.30 * fx.focus + 0.30 * fx.level})`);
    g.addColorStop(1, `hsla(${hue},60%,60%,0)`);
    ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(x, y, r * 1.9, 0, TAU); ctx2.fill();
    ctx2.strokeStyle = `hsla(${hue},65%,80%,${0.45 + 0.45 * fx.focus})`;
    ctx2.lineWidth = 2 + 3 * fx.focus;
    const sides = n.kind === 0 ? 3 : 36;                       // fire = triangle, others = ring
    ctx2.beginPath();
    for (let k = 0; k <= sides; k++) { const a = -Math.PI / 2 + k / sides * TAU, xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * r; k ? ctx2.lineTo(xx, yy) : ctx2.moveTo(xx, yy); }
    ctx2.stroke();
    if (n.kind === 2) {                                        // saturn's flattened halo
      ctx2.beginPath();
      for (let k = 0; k <= 44; k++) { const a = k / 44 * TAU, xx = x + Math.cos(a) * r * 1.9, yy = y + Math.sin(a) * r * 0.5; k ? ctx2.lineTo(xx, yy) : ctx2.moveTo(xx, yy); }
      ctx2.stroke();
    }
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.fillStyle = `hsla(${hue},40%,86%,${0.45 + 0.45 * fx.focus})`;
    ctx2.font = '11px Georgia'; ctx2.textAlign = 'center'; ctx2.letterSpacing = '2px';
    ctx2.fillText(n.key.toUpperCase(), x, y + r + 18);
    ctx2.letterSpacing = '0px';
  }
}
// THE CAUGHT OBJECT — a reticle + label around the real thing you're holding;
// it glows when a hand is on it (the object is sounding).
function drawCaught() {
  if (!_bound) {                                          // idle: invite a deliberate bind
    ctx2.fillStyle = 'rgba(236,231,218,.5)'; ctx2.font = 'italic 16px Georgia'; ctx2.textAlign = 'center';
    ctx2.fillText('hold an object · pinch to bind it', W / 2, H * 0.82);
    return;
  }
  if (!_caught) return;
  const x = _caught.cx * W, y = _caught.cy * H, w = _caught.w * W, h = _caught.h * H, hue = 170;
  const lit = Field.objFocus ? 1 : 0;
  ctx2.globalCompositeOperation = 'lighter';
  const g = ctx2.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.8);
  g.addColorStop(0, `hsla(${hue},60%,65%,${0.06 + 0.28 * lit})`);
  g.addColorStop(1, `hsla(${hue},60%,60%,0)`);
  ctx2.fillStyle = g; ctx2.beginPath(); ctx2.arc(x, y, Math.max(w, h) * 0.8, 0, TAU); ctx2.fill();
  ctx2.globalCompositeOperation = 'source-over';
  ctx2.strokeStyle = `hsla(${hue},70%,82%,${0.5 + 0.4 * lit})`; ctx2.lineWidth = 2 + 2 * lit;
  ctx2.strokeRect(x - w / 2, y - h / 2, w, h);
  ctx2.fillStyle = `hsla(${hue},45%,88%,${0.6 + 0.4 * lit})`;
  ctx2.font = '12px Georgia'; ctx2.textAlign = 'center'; ctx2.letterSpacing = '2px';
  ctx2.fillText(_caught.label.toUpperCase(), x, y - h / 2 - 8);
  ctx2.letterSpacing = '0px';
}
// THE LOOPS — persistent rings on the desk; a comet orbits each at its playhead. A loop
// is a "memory" placed in space; the comet hitting the top is the downbeat. (Reads the flat
// proxy in Field, the same data Unity gets.)
function drawLoops() {
  for (let i = 0; i < (Field.loopCount || 0); i++) {
    const lv = Field['loop' + i + 'level']; if (lv == null || lv < 0) continue;
    const x = Field['loop' + i + 'x'] * W, y = Field['loop' + i + 'y'] * H;
    const kind = Field['loop' + i + 'kind'], prog = Field['loop' + i + 'prog'] || 0;
    const hue = ARCH_HUE[kind] != null ? ARCH_HUE[kind] : 280, r = Math.min(W, H) * (0.06 + 0.04 * lv);
    ctx2.globalCompositeOperation = 'lighter';
    ctx2.strokeStyle = `hsla(${hue},65%,78%,${0.35 + 0.45 * lv})`; ctx2.lineWidth = 2;
    ctx2.beginPath();
    for (let k = 0; k <= 48; k++) { const a = k / 48 * TAU, xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * r; k ? ctx2.lineTo(xx, yy) : ctx2.moveTo(xx, yy); }
    ctx2.stroke();
    const pa = -Math.PI / 2 + prog * TAU, px = x + Math.cos(pa) * r, py = y + Math.sin(pa) * r, cr = 8 + 12 * lv;   // orbital playhead
    const cg = ctx2.createRadialGradient(px, py, 0, px, py, cr);
    cg.addColorStop(0, `hsla(${hue},90%,86%,0.95)`); cg.addColorStop(1, `hsla(${hue},90%,70%,0)`);
    ctx2.fillStyle = cg; ctx2.beginPath(); ctx2.arc(px, py, cr, 0, TAU); ctx2.fill();
    ctx2.globalCompositeOperation = 'source-over';
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
  if (Field.chordMode) {                                     // chord mode names the chord: root + quality
    const note = NOTE_NAMES[SCALE[clamp((Field.pitch * SCALE.length) | 0, 0, SCALE.length - 1)] % 12];
    return note + ' ' + (CHORD_QUALITY[Field.gesture] || 'triad');
  }
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
  if (Field.melody || Field.chordMode) drawGrid();                  // melody/chord mode: reveal the in-key zones to aim at
  if (Field.objectsMode) drawNodes();                               // node mode: draw the archetypal objects in the room
  if (Field.catchMode) drawCaught();                                // catch mode: draw the real object that's become an instrument
  drawLoops();                                                      // loops persist in any mode — the room's memory

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

  if (Field.chordMode) {                                            // chord mode: draw the chord as a glyph on the playing hand
    let cx = W / 2, cy = H * 0.42;
    if (hands.length) {                                             // the voice hand is the rightmost on screen (where pitch is played)
      let bx = -1;
      for (const lm of hands) { const m = metrics(lm), sx = (1 - m.px) * W; if (sx > bx) { bx = sx; cx = sx; cy = m.py * H; } }
    }
    drawChordGlyph(cx, cy, Field);
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
// TouchDesigner / OSC bridge — streams the whole Field to a local relay (td-bridge.js)
// which forwards it as OSC. Localhost-only and silent-fail: prod and a missing
// bridge change nothing about the instrument.
// Field contract (see field-spec.json) — stable encodings so the whole Field
// travels as OSC floats. Bump SCHEMA_V with any breaking change to the channels.
const SCHEMA_V = 6;
const POSE_ORDER = ['fist', 'point', 'peace', 'three', 'open', 'thumb', 'claw', 'L'];
const TDBridge = (() => {
  let ws = null, lastTry = 0;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  function ensure() {
    if (!local || (ws && ws.readyState <= 1)) return;          // connecting or open
    const now = performance.now();
    if (now - lastTry < 3000) return; lastTry = now;           // retry at most every 3s
    try { ws = new WebSocket('ws://127.0.0.1:8765'); ws.onerror = () => {}; ws.onclose = () => { ws = null; }; }
    catch (e) { ws = null; }
  }
  function send(F) {
    ensure();
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        v: SCHEMA_V,
        // continuous expression (0..1)
        pitch: F.pitch, brightness: F.brightness, intensity: F.intensity, proximity: F.proximity,
        openness: F.openness, motion: F.motion, stillness: F.stillness, calm: F.calm,
        breath: F.breath, union: F.union, grasp: F.grasp, pinch: F.pinch, twist: F.twist,
        accent: F.accent, bloom: F.bloom, body: F.body,
        // shaped scalars
        register: F.register, beat: F.beat, tempo: F.tempo,
        // harmony / key — numeric encodings so the contract stays float-only over OSC
        root: F.root, modeIdx: MODE_NAMES.indexOf(F.mode),
        gestureIdx: POSE_ORDER.indexOf(F.gesture), chordVoices: chordVoices(F),
        // discrete states (0/1) + the air-piano event
        melody: F.melody, chordMode: F.chordMode, keysMode: F.keysMode,
        strike: F.strike, strikeX: F.strikeX,
        // hand anchors -> pin objects to / between the hands
        h0x: F.h0x, h0y: F.h0y, h1x: F.h1x, h1y: F.h1y, span: F.span,
        // the Nodes (archetypal objects in space) — up to 4 slots
        objectsMode: F.objectsMode, nodeCount: F.nodeCount,
        n0x: F.n0x, n0y: F.n0y, n0kind: F.n0kind, n0focus: F.n0focus, n0lvl: F.n0lvl,
        n1x: F.n1x, n1y: F.n1y, n1kind: F.n1kind, n1focus: F.n1focus, n1lvl: F.n1lvl,
        n2x: F.n2x, n2y: F.n2y, n2kind: F.n2kind, n2focus: F.n2focus, n2lvl: F.n2lvl,
        n3x: F.n3x, n3y: F.n3y, n3kind: F.n3kind, n3focus: F.n3focus, n3lvl: F.n3lvl,
        // a caught real object (webcam object detection)
        catchMode: F.catchMode, objPresent: F.objPresent, objX: F.objX, objY: F.objY, objSize: F.objSize, objFocus: F.objFocus,
        // the spatial looper — flat proxy: per loop only x,y,level(-1=empty),kind,progress (the browser keeps the tape)
        loopCount: F.loopCount,
        loop0x: F.loop0x, loop0y: F.loop0y, loop0level: F.loop0level, loop0kind: F.loop0kind, loop0prog: F.loop0prog,
        loop1x: F.loop1x, loop1y: F.loop1y, loop1level: F.loop1level, loop1kind: F.loop1kind, loop1prog: F.loop1prog,
        loop2x: F.loop2x, loop2y: F.loop2y, loop2level: F.loop2level, loop2kind: F.loop2kind, loop2prog: F.loop2prog,
        loop3x: F.loop3x, loop3y: F.loop3y, loop3level: F.loop3level, loop3kind: F.loop3kind, loop3prog: F.loop3prog,
        temple: F.temple ? 1 : 0, frozen: F.frozen ? 1 : 0, hands: F.hands,
      }));
    } catch (e) {}
  }
  return { send };
})();

const video = document.getElementById('cam');
let landmarker = null, results = null, lastVT = -1, running = false, last = performance.now();

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (running && landmarker && video.readyState >= 2 && video.currentTime !== lastVT) {
    lastVT = video.currentTime;
    try { results = landmarker.detectForVideo(video, now); } catch (e) { /* timestamp race — skip */ }
    if (results) interpret(results, now / 1000);
  }
  if (running && detector && Field.catchMode && video.readyState >= 2 && now - _lastDetT > 120) {   // object detection, throttled (~8fps) to keep hands smooth
    _lastDetT = now;
    try { const r = detector.detectForVideo(video, now); detections = (r && r.detections) || []; } catch (e) { /* skip */ }
  }
  Field.breath = 0.5 + 0.5 * Math.sin((now / 1000) * 0.092 * TAU);   // the temple breathes ~5.5/min (coherence)
  if (running) SmartConductor.tick(now / 1000);                       // the conductor drifts the harmony onward
  if (running) { Loops.tick(); Loops.writeField(); }                  // spatial looper: fire due events + publish playheads
  if (running) for (const k of activeEngines) ENGINES[k].update(Field);
  if (running) TDBridge.send(Field);                                 // stream the Field to TouchDesigner (localhost only)
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

// loaded lazily the first time Catch is enabled (so it costs nothing otherwise)
async function makeDetector() {
  try {
    const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    const build = (delegate) => ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite", delegate },
      scoreThreshold: 0.4, maxResults: 5, runningMode: "VIDEO",
    });
    try { detector = await build("GPU"); } catch (e) { detector = await build("CPU"); }
  } catch (e) { console.warn('object detector unavailable', e); }
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
      video: { facingMode: camMode === 'user' ? 'user' : { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } }, audio: false });   // lighter capture -> ~half the inference load, much less lag (tune up for quality)
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
$('smart').addEventListener('click', () => { SmartConductor.enable(!SmartConductor.isOn()); $('smart').classList.toggle('active', SmartConductor.isOn()); });
$('pulse').addEventListener('click', () => { const on = !SoftSynth.pulseOn; SoftSynth.setPulse(on); $('pulse').classList.toggle('active', on); });
$('chords').addEventListener('click', () => { Field.chordMode = Field.chordMode ? 0 : 1; $('chords').classList.toggle('active', !!Field.chordMode); });
$('keys').addEventListener('click', () => { Field.keysMode = Field.keysMode ? 0 : 1; $('keys').classList.toggle('active', !!Field.keysMode); });
$('objects').addEventListener('click', () => { Field.objectsMode = Field.objectsMode ? 0 : 1; $('objects').classList.toggle('active', !!Field.objectsMode); });
$('catch').addEventListener('click', async () => {
  Field.catchMode = Field.catchMode ? 0 : 1; $('catch').classList.toggle('active', !!Field.catchMode);
  if (Field.catchMode && !detector) { $('catch').textContent = 'loading…'; await makeDetector(); $('catch').textContent = 'Catch'; }   // lazy-load the model on first use
});
$('loop').addEventListener('click', () => {                              // deliberate commit — no phantom-release jitter
  if (Loops.isRec()) { Loops.stop(); $('loop').classList.remove('active'); $('loop').textContent = 'Loop'; }
  else {
    const hx = (Field.catchMode && _bound) ? _bound.cx : Field.h1x;      // place the loop where you're playing
    const hy = (Field.catchMode && _bound) ? _bound.cy : Field.h1y;
    Loops.start(hx, hy, 7);                                              // kind 7 = "memory" — a captured loop (V27 grammar)
    $('loop').classList.add('active'); $('loop').textContent = 'Rec ●';
  }
});
$('bpm').addEventListener('input', (e) => SoftSynth.setBPM(+e.target.value));
$('rec').addEventListener('click', toggleRecord);

// RECORD — tap the synth output and save a .webm (no library, no Ableton). Auto-stops at 30s.
let mediaRec = null, recTimer = null, recCount = null;
function toggleRecord() {
  const btn = $('rec');
  if (mediaRec && mediaRec.state === 'recording') { mediaRec.stop(); return; }
  const stream = SoftSynth.recStream && SoftSynth.recStream();
  if (!stream) { btn.textContent = 'Press Begin first'; setTimeout(() => (btn.textContent = 'Record'), 1500); return; }
  const chunks = [];
  mediaRec = new MediaRecorder(stream);
  mediaRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mediaRec.onstop = () => {
    clearTimeout(recTimer); clearInterval(recCount);
    btn.classList.remove('active'); btn.textContent = 'Record';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(chunks, { type: 'audio/webm' }));
    a.download = 'astrolab-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.webm';
    a.click();
  };
  mediaRec.start();
  btn.classList.add('active');
  const MAX = 600;                                              // up to 10 minutes per take
  let left = MAX;
  const fmt = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  btn.textContent = 'Stop · ' + fmt(left);
  recCount = setInterval(() => { left--; if (left > 0) btn.textContent = 'Stop · ' + fmt(left); }, 1000);
  recTimer = setTimeout(() => { if (mediaRec && mediaRec.state === 'recording') mediaRec.stop(); }, MAX * 1000);
}
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
