// FieldKeys.cs — ASTROLAB air-piano visualizer (Phase 1.5).
// ---------------------------------------------------------------------------
// When the web instrument reports a finger strike (field.strike spikes on a
// rising edge), a glowing ring blooms outward at the strike's horizontal
// position (field.strikeX), colored by mode. The sound is made in the browser;
// this is purely the strike made visible. Self-bootstraps on Play.
// ---------------------------------------------------------------------------

using System.Collections.Generic;
using UnityEngine;

namespace Astrolab
{
    public sealed class FieldKeys : MonoBehaviour
    {
        const float Life = 0.6f;     // ring lifespan in seconds
        const int Segments = 40;

        readonly List<Ripple> _ripples = new List<Ripple>();
        float _prevStrike;

        class Ripple { public LineRenderer lr; public float age; public float x; public Color col; }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindObjectOfType<FieldKeys>() != null) return;
            new GameObject("FieldKeys (auto)").AddComponent<FieldKeys>();
        }

        void Update()
        {
            var f = FieldOscReceiver.Instance != null ? FieldOscReceiver.Instance.field : null;
            if (f == null) return;

            if (f.strike > 0.5f && _prevStrike <= 0.5f) Spawn(f);   // rising edge = a new strike
            _prevStrike = f.strike;

            for (int i = _ripples.Count - 1; i >= 0; i--)
            {
                var r = _ripples[i];
                r.age += Time.deltaTime;
                float life = r.age / Life;
                if (life >= 1f) { Destroy(r.lr.gameObject); _ripples.RemoveAt(i); continue; }
                float rad = Mathf.Lerp(0.05f, 1.7f, life);
                float a = 1f - life;                                 // fade out as it grows
                DrawRing(r.lr, r.x, rad, new Color(r.col.r, r.col.g, r.col.b, a));
            }
        }

        void Spawn(Field f)
        {
            float hue = (f.ModeHueDeg % 360f) / 360f;
            var go = new GameObject("ripple");
            go.transform.SetParent(transform, false);
            var lr = go.AddComponent<LineRenderer>();
            lr.material = new Material(Shader.Find("Sprites/Default"));
            lr.useWorldSpace = true;
            lr.loop = true;
            lr.numCapVertices = 2;
            lr.widthMultiplier = 0.07f;
            _ripples.Add(new Ripple
            {
                lr = lr,
                age = 0f,
                x = Mathf.Lerp(-3.5f, 3.5f, f.strikeX),
                col = Color.HSVToRGB(hue, 0.5f, 1f)
            });
        }

        static void DrawRing(LineRenderer lr, float x, float r, Color col)
        {
            lr.positionCount = Segments;
            lr.startColor = lr.endColor = col;
            for (int i = 0; i < Segments; i++)
            {
                float a = i / (float)Segments * Mathf.PI * 2f;
                lr.SetPosition(i, new Vector3(x + Mathf.Cos(a) * r, 0.5f + Mathf.Sin(a) * r, 0f));
            }
        }
    }
}
