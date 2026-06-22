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
        Transform _t;
        Camera _cam;
        float _spin;

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
            var bloom = prof.Add<Bloom>(true);
            bloom.intensity.Override(1.4f);
            bloom.threshold.Override(0.5f);
            bloom.scatter.Override(0.72f);

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
            float R = 0.6f + 1.7f * f.intensity + 0.6f * f.bloom;

            // glide to the position the hand names
            Vector3 home = new Vector3(Mathf.Lerp(-3.5f, 3.5f, f.pitch),
                                       Mathf.Lerp(-1.5f, 2.5f, f.brightness), 0f);
            _t.localPosition = Vector3.Lerp(_t.localPosition, home, 0.15f);

            // spin: a slow drift plus the wrist
            _spin += (12f + (f.twist - 0.5f) * 200f) * Time.deltaTime;
            _t.localRotation = Quaternion.Euler(0, 0, _spin);

            if (n == 1) BuildPolygon(20, 0.12f + 0.30f * f.intensity);   // root -> a small ring
            else        BuildPolygon(n, R);
            _lr.loop = n != 2;                                            // 2 voices stay an open line
            _lr.startColor = _lr.endColor = col;
            _lr.widthMultiplier = 0.04f + 0.12f * f.intensity + 0.06f * f.pinch;
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
