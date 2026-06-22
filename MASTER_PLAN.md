# ASTROLAB — Master Plan

*The body as an instrument. One soul (the Field) across a zero-friction web demo and a
deep native/Unity experience. Space is the interface; sound is one of its faces.*

**UVP.** Open a URL, move your body, and you're making *music* (in-key, beautiful) in 5
seconds — and it's the *same instrument* an artist can perform with on a headset, because
both are driven by one shared **Field**. Not "hand-tracking visuals" (a crowded toy) — a
**spatial grammar** where archetypal Nodes are at once instrument, teacher, symbol, world.

---

## 0. What "showable product" means
The bar we're building toward — a person who has never seen it can:
1. Open the web app, understand it in 10 seconds with no menu.
2. Play the archetypal room (Fire / Ocean / Saturn …) and it *sounds great*.
3. **Make something** — layer a few loops into a short piece.
4. **Keep it** — save / export / share the result.
5. See the premium version (Unity/desktop, eventually Quest) that is visibly deeper.

If those five are true, it's a product, not a tech demo.

---

## 1. Where we are now (honest inventory)
**Built & working**
- The **Field** — engine-agnostic contract (`field-spec.json`, schema v5), the keystone.
- **Web instrument** (`hands.js`) — MediaPipe hands → Field → WebAudio. Modes: pad/drone,
  Smart Conductor, melody, chords + chord glyphs, **air-piano (Keys)**, **archetypal Nodes
  (Objects: Fire/Ocean/Saturn)**, **Catch (real object → instrument)**, Temple/binaural,
  Pulse, Record (10 min), A=432.
- **OSC bridge** (`td-bridge.js`) — full Field → TouchDesigner (7000) **and** Unity (9000).
- **Unity reader** (`astrolab-unity`) — OscJack receiver, glyph pinned to hands, particle
  atmosphere, ripples, archetypal Node visuals, caught-object box. URP, self-bootstrapping.
- Two git repos, both committed.

**Known gaps / honest problems**
- **Web lag** with two MediaPipe models — the browser ceiling (native fixes this).
- **Object flow is broken**: holding the object occupies the hand that should play it.
- **One shared synth voice** for Ocean/Saturn/Catch — they collide if used at once.
- **No persistence** — nothing saves; sessions evaporate.
- **Sound is synth-only** — no curated samples yet, so it's not yet "great."
- **No capture-to-track** — Record dumps raw audio; you can't *build* a piece.

---

## 2. Architecture (the spine — don't break it)
```
INPUT (writes the Field)        THE FIELD            READERS (read the Field)
hands / object / surface  ──►  one contract  ──►  sound · web visuals · Unity · worlds
(later: voice, gaze, body)     (versioned)         (web now; Faust + Unity later)
```
- **One source of truth.** Inputs write the Field; everything else reads it.
- **Two bodies.** Web = the open door (reach, demo). Native/Unity = the destination (depth, Quest).
- **The bridge is disposable.** It carries meaning today; when Unity grows its own senses it falls away, readers unchanged.
- **The grammar.** A `Node` is generic: `sound · visual · meaning · behavior`. Archetypes, not "drum/synth".

---

## 3. The work, by track

### A. Interaction & flow (make it intuitive, fix what's broken)
- [ ] **Node anchoring modes** — unify how a Node is placed:
  - `hand` (follows a hand) · `fixed` (a spot in space) · `object` (a real thing) · `surface` (the table).
- [ ] **Fix the object flow → "bind & place."** Pinch to bind → the object becomes a *placed*
      Node anchored where it sits; **set it down, hands free to play it**; if it leaves frame,
      keep a "ghost" at its last spot. (Solves "if I hold it I can't play it.")
- [ ] **Table MIDI pad** — drop a **square on the table** = a `surface` Node: a tap-grid you
      drum/play like an MPC. No object detection — just fingertips on a defined region.
- [ ] **Spawn menu** — open hand → a radial of archetypes → pick one (later: say its name, Web Speech).
- [ ] **`behavior` facet** — a Node changes the *world*: Saturn slows tempo, Fire raises intensity, Ocean smooths.
- [ ] **Onboarding** — a 10-second wordless first-run that teaches "reach in."

### B. Sound (make it *great*, then make *tracks*)
- [ ] **Sample engine pass** — drop curated `samples/*.wav`; each archetype gets a signature timbre. *(biggest quality jump, no new tech)*
- [ ] **Polyphony fix** — per-Node voices so Ocean + Saturn + Catch don't collide.
- [ ] **Live looper** — reach in → record a loop → layer another; build a piece in the air (no timeline). *(the "make a track" answer)*
- [ ] **Master bus polish** — gentle bus EQ/limiter so the mix always sounds finished.
- [ ] **MIDI-out polish** — Field → any DAW/VST = instant pro sound (already half-built).
- [ ] *(Later)* **Faust DSP** — one engine compiled to **both** WebAssembly (web) and C++ (Unity). The audio version of the Field. Adopt when quality + Unity sound both matter.

### C. Visual (the body people see)
- [ ] **Web polish** — readability, the Node glyphs, a calm first frame, mobile layout.
- [ ] **Unity rich body** — VFX Graph particles, archetypes as real 3D, depth, bloom, a sense of place.
- [ ] *(Later)* **A "world"** — a floor/horizon the Field sculpts (calm warms it, union blooms it).
- [ ] *(Asset tool)* **Blender** — only to author signature 3D meshes for archetypes; never in the runtime loop.

### D. Persistence (the north star: collect sound → keep it → land it)
- [ ] **Scene format (JSON)** — a session = frozen Field (Nodes, modes, loops). Travels web → Unity → city. *No backend.*
- [ ] **IndexedDB** — save scenes + user-recorded samples locally.
- [ ] *(Later)* **Backend (Supabase)** — accounts, sharing, a cloud sound library. Only when sharing is real.

### E. Distribution (so it's *showable*)
- [ ] **Hosted web** — a clean public URL (Vercel) — the shareable demo.
- [ ] **Unity desktop build** — a downloadable `.exe`/app — the premium body.
- [ ] *(Later)* **Quest build** — XR Hands + OpenXR — conduct it in the room.
- [ ] *(Later, heaviest)* **Multiplayer "in sync"** — realtime server; people share one Field. Park until solo is undeniable.

---

## 4. Milestones (the path)
- **M0 — Foundations** ✅ Field, web instrument, bridge, Unity reader, two repos.
- **M1 — Playable & intuitive** → fix object flow, table pad, anchoring modes, `behavior` facet, polyphony. *The room plays right.*
- **M2 — Sounds great** → sample pass + master bus. *You'd want to listen.*
- **M3 — Make & keep** → live looper + scene save (JSON) + IndexedDB. *Sessions become tracks you keep.*
- **M4 — Showable** → web polish + hosted URL + a first Unity build. **← the real product to show.**
- **M5 — Premium / social** → Unity rich visuals → Quest → sharing → multiplayer.

## 5. Critical path to "showable" (the minimum that matters)
**M1 (object flow + table pad + behavior) → M2 (samples) → M3 (looper + save) → M4 (host + Unity build).**
Everything else is later. Wedge decision (who it's *for* — creative tool / learning / calm)
sharpens M4's framing but doesn't block the build.

## 6. The key open decisions (yours)
1. **Wedge** — creative instrument · learning/children/symbols · calm/coherence. (Sharpens the demo.)
2. **Showable target** — polished *web* first, or push a *Unity build* in parallel?
3. **Looper vs object-flow** — which M1 piece first? (Recommend: object-flow fix, it's blocking the magic you just felt.)
