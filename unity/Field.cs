// Field.cs — ASTROLAB Field contract, Unity side.
// ---------------------------------------------------------------------------
// This MIRRORS field-spec.json (schema v1). The web instrument (hands.js) writes
// the Field; the relay (td-bridge.js) forwards every channel as an OSC float to
// /field/<name>. Here a reader feeds those messages into Apply() and reads the
// fields. No engine logic lives here — this is pure data, the same contract the
// browser uses. Keep this file and field-spec.json in lockstep; bump Version on
// any breaking change.
//
// Typical wiring with OscJack (jp.keijiro.osc-jack):
//     var field = new Field();
//     // in your OSC message callback:  field.Apply(address, (float)value);
//     // then any reader (VFX, audio, worlds) reads field.intensity, field.calm, ...
// ---------------------------------------------------------------------------

using System;

namespace Astrolab
{
    [Serializable]
    public class Field
    {
        public const int Schema = 1;

        // schema version of the last frame received (should equal Schema)
        public int v;

        // --- continuous expression (0..1) ---
        public float pitch, brightness, intensity, proximity, openness;
        public float motion, stillness, calm, breath, union;
        public float grasp, pinch, twist, accent, bloom, body;

        // --- shaped scalars ---
        public int   register;   // semitones, e.g. 0 or +12
        public float beat;       // binaural beat Hz (4..14)
        public float tempo;      // seconds between onsets (0.15..2.0)

        // --- harmony / key (numeric encodings; decode via the tables below) ---
        public int root;         // pitch class 0..11
        public int modeIdx;      // index into Modes
        public int gestureIdx;   // index into Poses (-1 = unknown)
        public int chordVoices;  // 1..4 -> sides of the chord glyph

        // --- discrete states (0/1) ---
        public int melody, chordMode, temple, frozen, hands;

        // --- decode tables (match field-spec.json) ---
        public static readonly string[] Modes     = { "aeolian", "dorian", "lydian", "phrygian", "ionian" };
        public static readonly float[]  ModeHue   = { 215f, 190f, 280f, 25f, 45f };
        public static readonly string[] Poses     = { "fist", "point", "peace", "three", "open", "thumb", "claw", "L" };
        public static readonly string[] NoteNames = { "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B" };

        public string ModeName => (modeIdx >= 0 && modeIdx < Modes.Length) ? Modes[modeIdx] : "aeolian";
        public float  ModeHueDeg => (modeIdx >= 0 && modeIdx < ModeHue.Length) ? ModeHue[modeIdx] : 215f;
        public string Pose => (gestureIdx >= 0 && gestureIdx < Poses.Length) ? Poses[gestureIdx] : "open";
        public string RootName => NoteNames[((root % 12) + 12) % 12];
        public bool   ChordMode => chordMode != 0;
        public bool   Temple => temple != 0;
        public bool   Frozen => frozen != 0;
        public bool   Melody => melody != 0;

        /// <summary>
        /// Route one OSC message ("/field/&lt;name&gt;", float) into the matching field.
        /// Unknown addresses are ignored, so adding channels never breaks an old reader.
        /// </summary>
        public void Apply(string address, float value)
        {
            if (string.IsNullOrEmpty(address)) return;
            int slash = address.LastIndexOf('/');
            string name = slash >= 0 ? address.Substring(slash + 1) : address;
            ApplyChannel(name, value);
        }

        /// <summary>Route a bare channel name (no "/field/" prefix) and its float value.</summary>
        public void ApplyChannel(string name, float value)
        {
            switch (name)
            {
                case "v": v = (int)value; break;

                case "pitch": pitch = value; break;
                case "brightness": brightness = value; break;
                case "intensity": intensity = value; break;
                case "proximity": proximity = value; break;
                case "openness": openness = value; break;
                case "motion": motion = value; break;
                case "stillness": stillness = value; break;
                case "calm": calm = value; break;
                case "breath": breath = value; break;
                case "union": union = value; break;
                case "grasp": grasp = value; break;
                case "pinch": pinch = value; break;
                case "twist": twist = value; break;
                case "accent": accent = value; break;
                case "bloom": bloom = value; break;
                case "body": body = value; break;

                case "register": register = (int)value; break;
                case "beat": beat = value; break;
                case "tempo": tempo = value; break;

                case "root": root = (int)value; break;
                case "modeIdx": modeIdx = (int)value; break;
                case "gestureIdx": gestureIdx = (int)value; break;
                case "chordVoices": chordVoices = (int)value; break;

                case "melody": melody = (int)value; break;
                case "chordMode": chordMode = (int)value; break;
                case "temple": temple = (int)value; break;
                case "frozen": frozen = (int)value; break;
                case "hands": hands = (int)value; break;

                // unknown channel: ignore (forward-compatible)
                default: break;
            }
        }
    }
}
