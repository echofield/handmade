# ASTROLAB · sacred samples

Drop your own `.wav` files here and the **Sample engine** will recombine them —
transposing each to the Field's pitch, balancing by intensity / brightness /
harmony, sending them through filter + space. Until a file exists, ASTROLAB
plays a seamless-looping **synthesized fallback** for that layer, so the
instrument always sounds. Add real notes and it blooms.

## Files it looks for

| file       | role        | recorded at | notes                                            |
|------------|-------------|-------------|--------------------------------------------------|
| `sub.wav`  | sub drone   | **A1**      | deep, simple, sustained. The floor.              |
| `pad.wav`  | pad         | **A3**      | the main voice — Juno-style pad / bowed / tape.  |
| `air.wav`  | tape / air  | **A5**      | high shimmer, opens up with brightness.          |

`harmony` reuses `pad.wav` at the harmony interval (second hand).

## What makes a good sample

- **Sustained and loopable** — a held note or evolving texture, not a one-shot.
  The engine loops it continuously while you play.
- **Recorded at the pitch named above** (or edit the `root` in the `MANIFEST`
  in `../hands.js` to match). Tuning is ratio-based from that root, so an
  honest root = honest tuning. A=432.
- Clean, mono or stereo, any sample rate the browser can decode.

## Ideas for the six sacred sources

one Juno-style pad · one piano note · one cello / bowed note · one tape
texture · one noise bed · one sub drone. The app doesn't need infinite synth
quality — it needs to recombine *this* material beautifully.
