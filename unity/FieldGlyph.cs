// FieldGlyph.cs — ASTROLAB first visual reader (Phase 1).
// ---------------------------------------------------------------------------
// The chord as a glowing glyph. It READS the live Field (via
// FieldOscReceiver.Instance.field) and never writes it — the contract in motion.
//
//   sides     = chordVoices   (1 = point/ring, 2 = line, 3 = triangle, 4 = square)
//   hue       = mode          (aeolian blue .. ionian gold)
//   spin      = twist         (wrist rotation)
//   size      = intensity     (lean in -> bigger)  + bloom swell on chord change
//   position  = pitch (x) / brightness (y)
//   width     = intensity + pinch
//   the void  = a dark, mode-tinted background + URP Bloom so the line glows
//
// Self-bootstraps on Play. No GameObject to create, no wiring.
// ---------------------------------------------------------------------------

using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Astrolab
{
    public sealed class FieldGlyph : MonoBehaviour
    {
        LineRenderer _lr;
        TrailRenderer _trail;
        Bloom _bloom;
        Transform _t;
        Camera _cam;
        float _spin;
        const float Depth = 10f;   // distance in front of the camera the glyph lives at

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindObjectOfType<FieldGlyph>() != null) return;
            new GameObject("FieldGlyph (auto)").AddComponent<FieldGlyph>();
        }

        void Start()
        {
            _cam = Camera.main;

            // a dedicated post-fx volume so the glyph blooms (doesn't touch the scene's own volume)
            var vgo = new GameObject("FieldPostFX");
            vgo.transform.SetParent(transform, false);
            var vol = vgo.AddComponent<Volume>();
            vol.isGlobal = true; vol.priority = 100f;
            var prof = ScriptableObject.CreateInstance<VolumeProfile>();
            vol.profile = prof;
            _bloom = prof.Add<Bloom>(true);
            _bloom.intensity.Override(1.4f);
            _bloom.threshold.Override(0.5f);
            _bloom.scatter.Override(0.72f);

            // the glyph itself — a line-drawn polygon in local space
            var go = new GameObject("glyph-line");
            _t = go.transform; _t.SetParent(transform, false);
            _lr = go.AddComponent<LineRenderer>();
            _lr.material = new Material(Shader.Find("Sprites/Default"));
            _lr.useWorldSpace = false;
            _lr.loop = true;
            _lr.numCornerVertices = 6;
            _lr.numCapVertices = 6;
            _lr.widthMultiplier = 0.06f;
            _lr.positionCount = 0;
            _lr.textureMode = LineTextureMode.Stretch;

            // a comet trail from the glyph's center, so movement leaves light behind
            var tgo = new GameObject("glyph-trail");
            tgo.transform.SetParent(_t, false);
            _trail = tgo.AddComponent<TrailRenderer>();
            _trail.material = new Material(Shader.Find("Sprites/Default"));
            _trail.time = 0.7f;
            _trail.startWidth = 0.14f;
            _trail.endWidth = 0f;
            _trail.numCapVertices = 4;
            _trail.minVertexDistance = 0.02f;
        }

        void Update()
        {
            var f = FieldOscReceiver.Instance != null ? FieldOscReceiver.Instance.field : null;
            if (f == null || _lr == null) return;

            float hue = (f.ModeHueDeg % 360f) / 360f;
            Color col = Color.HSVToRGB(hue, 0.55f, 1f);

            // the void: ease toward a dark, mode-tinted background; calm lifts it a touch
            if (_cam != null)
            {
                _cam.clearFlags = CameraClearFlags.SolidColor;
                Color bg = Color.HSVToRGB(hue, 0.5f, 0.04f + 0.05f * f.calm);
                _cam.backgroundColor = Color.Lerp(_cam.backgroundColor, bg, 0.04f);
            }

            int n = Mathf.Clamp(f.chordVoices <= 0 ? 1 : f.chordVoices, 1, 4);
            // held between two hands -> scale by their distance; one hand -> scale by intensity
            float R = (f.hands >= 2)
                ? Mathf.Clamp(f.span * 9f, 0.4f, 4f) + 0.5f * f.bloom
                : 0.6f + 1.7f * f.intensity + 0.6f * f.bloom;

            // pin to the hands: place the glyph at the midpoint of the two hand anchors,
            // mapped through the camera so it sits exactly where your hands are on screen
            if (f.hands >= 1 && _cam != null)
            {
                Vector3 v0 = new Vector3(f.h0x, 1f - f.h0y, Depth);   // screen-space y is top-down; viewport is bottom-up
                Vector3 v1 = new Vector3(f.h1x, 1f - f.h1y, Depth);
                Vector3 world = _cam.ViewportToWorldPoint((v0 + v1) * 0.5f);
                _t.position = Vector3.Lerp(_t.position, world, 0.3f);
            }

            // spin: a slow drift plus the wrist
            _spin += (12f + (f.twist - 0.5f) * 200f) * Time.deltaTime;
            _t.localRotation = Quaternion.Euler(0, 0, _spin);

            // the glyph breathes with the Field's breath; bloom swells on union + chord-change
            float pulse = 1f + 0.06f * (f.breath - 0.5f) * 2f + 0.15f * f.bloom;
            _t.localScale = Vector3.Lerp(_t.localScale, Vector3.one * pulse, 0.2f);
            if (_bloom != null)
                _bloom.intensity.Override(Mathf.Lerp(_bloom.intensity.value, 1.1f + 2.4f * f.union + 1.2f * f.bloom, 0.1f));

            if (n == 1) BuildPolygon(20, 0.12f + 0.30f * f.intensity);   // root -> a small ring
            else        BuildPolygon(n, R);
            _lr.loop = n != 2;                                            // 2 voices stay an open line
            _lr.startColor = _lr.endColor = col;
            _lr.widthMultiplier = 0.04f + 0.12f * f.intensity + 0.06f * f.pinch;
            if (_trail != null) { _trail.startColor = col; _trail.endColor = new Color(col.r, col.g, col.b, 0f); }
        }

        void BuildPolygon(int n, float r)
        {
            _lr.positionCount = n;
            float off = -Mathf.PI / 2f;                                  // point a vertex up
            for (int i = 0; i < n; i++)
            {
                float a = off + i / (float)n * Mathf.PI * 2f;
                _lr.SetPosition(i, new Vector3(Mathf.Cos(a) * r, Mathf.Sin(a) * r, 0f));
            }
        }
    }
}
