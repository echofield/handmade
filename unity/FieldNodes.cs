// FieldNodes.cs — ASTROLAB archetypal Nodes, rendered in space (Phase 2 vision).
// ---------------------------------------------------------------------------
// A Node is generic. Its archetype (kind) decides the visual:
//   fire (0)   = a triangle, warm — flickers with activity
//   ocean (1)  = a soft ring, blue
//   saturn (2) = a ring with a flattened halo, gold
// Reach into a node (focus) and it brightens; play it and its level pulses.
// Sound is made in the browser; this is the Node made visible. Self-bootstraps.
// ---------------------------------------------------------------------------

using UnityEngine;

namespace Astrolab
{
    public sealed class FieldNodes : MonoBehaviour
    {
        const int Slots = 4;
        const float Depth = 10f;

        Camera _cam;
        LineRenderer[] _body = new LineRenderer[Slots];
        LineRenderer[] _halo = new LineRenderer[Slots];   // saturn's ring
        LineRenderer _obj;                                // the caught real object's box
        LineRenderer[] _loopRing = new LineRenderer[4];   // persistent loop rings
        LineRenderer[] _loopComet = new LineRenderer[4];  // each loop's orbital playhead

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindObjectOfType<FieldNodes>() != null) return;
            new GameObject("FieldNodes (auto)").AddComponent<FieldNodes>();
        }

        void Start()
        {
            _cam = Camera.main;
            for (int i = 0; i < Slots; i++) { _body[i] = MakeLR("node-" + i); _halo[i] = MakeLR("halo-" + i); }
            _obj = MakeLR("caught-object"); _obj.loop = true;
            for (int i = 0; i < 4; i++) { _loopRing[i] = MakeLR("loop-ring-" + i); _loopComet[i] = MakeLR("loop-comet-" + i); }
        }

        LineRenderer MakeLR(string name)
        {
            var go = new GameObject(name); go.transform.SetParent(transform, false);
            var lr = go.AddComponent<LineRenderer>();
            lr.material = new Material(Shader.Find("Sprites/Default"));
            lr.useWorldSpace = true; lr.loop = true; lr.numCapVertices = 2; lr.widthMultiplier = 0.05f; lr.positionCount = 0;
            return lr;
        }

        void Update()
        {
            var f = FieldOscReceiver.Instance != null ? FieldOscReceiver.Instance.field : null;
            if (f == null || _cam == null) return;

            for (int i = 0; i < Slots; i++)
            {
                GetSlot(f, i, out float x, out float y, out int kind, out int focus, out float lvl);
                bool live = f.ObjectsMode && i < f.nodeCount && kind >= 0;
                if (!live) { _body[i].positionCount = 0; _halo[i].positionCount = 0; continue; }

                Vector3 c = _cam.ViewportToWorldPoint(new Vector3(x, 1f - y, Depth));
                float hue = (kind < Field.ArchetypeHue.Length ? Field.ArchetypeHue[kind] : 200f) / 360f;
                Color col = Color.HSVToRGB(hue, 0.55f, Mathf.Clamp01(0.5f + 0.45f * focus + 0.5f * lvl));
                float r = 0.5f + 0.25f * focus + (kind == 0 ? 0.18f * lvl : 0.22f * lvl);
                int sides = kind == 0 ? 3 : 36;                       // fire = triangle, others = ring
                DrawPoly(_body[i], c, r, r, sides, col, 0.04f + 0.05f * focus);

                if (kind == 2) DrawPoly(_halo[i], c, r * 1.9f, r * 0.5f, 44, col, 0.03f);   // saturn's flattened halo
                else _halo[i].positionCount = 0;
            }

            // the caught real object — a glowing square box that brightens when sounding
            if (f.CatchMode && f.objPresent != 0)
            {
                Vector3 oc = _cam.ViewportToWorldPoint(new Vector3(f.objX, 1f - f.objY, Depth));
                float hw = f.objSize * 4f;                          // viewport width -> world half-extent (approx)
                Color oct = Color.HSVToRGB(170f / 360f, 0.5f, 0.55f + 0.45f * f.objFocus);
                _obj.positionCount = 4; _obj.widthMultiplier = 0.04f + 0.04f * f.objFocus; _obj.startColor = _obj.endColor = oct;
                _obj.SetPosition(0, new Vector3(oc.x - hw, oc.y - hw, oc.z));
                _obj.SetPosition(1, new Vector3(oc.x + hw, oc.y - hw, oc.z));
                _obj.SetPosition(2, new Vector3(oc.x + hw, oc.y + hw, oc.z));
                _obj.SetPosition(3, new Vector3(oc.x - hw, oc.y + hw, oc.z));
            }
            else _obj.positionCount = 0;

            // the spatial loops — persistent rings, each with an orbital playhead comet
            for (int i = 0; i < 4; i++)
            {
                GetLoop(f, i, out float lx, out float ly, out float level, out int lkind, out float prog);
                if (level < 0f) { _loopRing[i].positionCount = 0; _loopComet[i].positionCount = 0; continue; }
                Vector3 lc = _cam.ViewportToWorldPoint(new Vector3(lx, 1f - ly, Depth));
                float lhue = (lkind >= 0 && lkind < Field.ArchetypeHue.Length ? Field.ArchetypeHue[lkind] : 280f) / 360f;
                float lr = 0.55f + 0.2f * level;
                Color lcol = Color.HSVToRGB(lhue, 0.55f, 0.5f + 0.4f * level);
                DrawPoly(_loopRing[i], lc, lr, lr, 64, lcol, 0.03f);                          // a smooth high-res ring
                float th = -Mathf.PI / 2f + prog * Mathf.PI * 2f;                              // playhead angle (top = downbeat)
                Vector3 comet = new Vector3(lc.x + Mathf.Cos(th) * lr, lc.y + Mathf.Sin(th) * lr, lc.z);
                Color ccol = Color.HSVToRGB(lhue, 0.5f, 1f);
                DrawPoly(_loopComet[i], comet, 0.07f + 0.10f * level, 0.07f + 0.10f * level, 12, ccol, 0.05f + 0.06f * level);
            }
        }

        static void GetLoop(Field f, int i, out float x, out float y, out float level, out int kind, out float prog)
        {
            switch (i)
            {
                case 0: x = f.loop0x; y = f.loop0y; level = f.loop0level; kind = f.loop0kind; prog = f.loop0prog; break;
                case 1: x = f.loop1x; y = f.loop1y; level = f.loop1level; kind = f.loop1kind; prog = f.loop1prog; break;
                case 2: x = f.loop2x; y = f.loop2y; level = f.loop2level; kind = f.loop2kind; prog = f.loop2prog; break;
                default: x = f.loop3x; y = f.loop3y; level = f.loop3level; kind = f.loop3kind; prog = f.loop3prog; break;
            }
        }

        static void GetSlot(Field f, int i, out float x, out float y, out int kind, out int focus, out float lvl)
        {
            switch (i)
            {
                case 0: x = f.n0x; y = f.n0y; kind = f.n0kind; focus = f.n0focus; lvl = f.n0lvl; break;
                case 1: x = f.n1x; y = f.n1y; kind = f.n1kind; focus = f.n1focus; lvl = f.n1lvl; break;
                case 2: x = f.n2x; y = f.n2y; kind = f.n2kind; focus = f.n2focus; lvl = f.n2lvl; break;
                default: x = f.n3x; y = f.n3y; kind = f.n3kind; focus = f.n3focus; lvl = f.n3lvl; break;
            }
        }

        static void DrawPoly(LineRenderer lr, Vector3 c, float rx, float ry, int sides, Color col, float width)
        {
            lr.positionCount = sides; lr.widthMultiplier = width; lr.startColor = lr.endColor = col;
            float off = -Mathf.PI / 2f;
            for (int i = 0; i < sides; i++)
            {
                float a = off + i / (float)sides * Mathf.PI * 2f;
                lr.SetPosition(i, new Vector3(c.x + Mathf.Cos(a) * rx, c.y + Mathf.Sin(a) * ry, c.z));
            }
        }
    }
}
