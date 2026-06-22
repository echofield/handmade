# ASTROLAB · Unity reader (Phase 0)

Unity becomes a **reader of the Field** — the same control surface the browser instrument
already produces. Nothing about the web version changes: the browser still plays on its
own. Unity just listens.

```
hands.js  ──WebSocket──►  td-bridge.js  ──OSC /field/<name>──►  ┌─ TouchDesigner (UDP 7000)
(the brain)               (the relay)                          └─ Unity / OscJack (UDP 9000)
```

The contract is **`field-spec.json`** (repo root, schema v1). The Unity side of it is
**`Field.cs`** (this folder). Keep the two in lockstep.

---

## Phase 0 is done in this repo
- `field-spec.json` — the versioned contract (every channel, range, OSC address).
- `unity/Field.cs` — drop-in C# mirror with `Apply("/field/<name>", value)`.
- `td-bridge.js` — now fans the Field out to **both** TouchDesigner (7000) **and** Unity (9000).
- `hands.js` — the bridge now streams the **complete** Field (tagged `v: 1`). Localhost-only,
  silent-fail — the deployed browser instrument is untouched.

## Phase 1 — first light (your move, in Unity)

1. **Create the project**: Unity Hub → New Project → **3D (URP)**. Unity 2022.3 LTS or Unity 6.
2. **Add OscJack** (receives the Field over UDP):
   - Edit → Project Settings → **Package Manager** → add a **Scoped Registry**:
     - Name: `Keijiro`
     - URL: `https://registry.npmjs.com`
     - Scope: `jp.keijiro`
   - Window → Package Manager → *My Registries* → install **OSC Jack**
     (package id `jp.keijiro.osc-jack`).
3. **Drop in the contract**: copy `unity/Field.cs` into `Assets/Astrolab/`.
4. **Receive**: add an OscJack connection/receiver on **UDP port 9000**, address pattern
   `/field/*`, and in the callback call `field.Apply(address, value)` on a shared `Field`
   instance. (A ready-made `FieldOscReceiver.cs` is the next thing to add — ask for it.)
5. **Run it live**: in the repo, `node td-bridge.js`, open the web instrument on
   `localhost`, press Begin, move your hands → the `Field` values update in Unity.

Once a value moves in Unity, Phase 1 visuals (chord glyph in 3D, fingertip particle field)
bind straight to `field.*`.

## Later phases (not now)
- **Phase 2** — port `interpret()` to C# + MediaPipeUnityPlugin (`homuler`) so Unity tracks
  hands from a webcam itself, writing the same Field. No web app needed.
- **Phase 3** — worlds (scenes the Field modulates) + Quest via **XR Hands**
  (`com.unity.xr.hands`) + OpenXR. Same Field, conducted in the room.

## Reading the Field (quick reference)
- Continuous 0..1: `pitch, brightness, intensity, proximity, openness, motion, stillness,
  calm, breath, union, grasp, pinch, twist, accent, bloom, body`.
- Harmony/key: `root` (0..11, `field.RootName`), `modeIdx` (`field.ModeName`, `field.ModeHueDeg`),
  `gestureIdx` (`field.Pose`), `chordVoices` (1..4 = sides of the chord glyph).
- States (0/1): `melody, chordMode, temple, frozen`; `hands` (0..2).
