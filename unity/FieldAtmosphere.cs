// FieldAtmosphere.cs — ASTROLAB "Living Field" particle atmosphere (Phase 1.5).
// ---------------------------------------------------------------------------
// A breathing cloud of soft light that READS the Field:
//   how many   = intensity + motion   (lean in / move -> the air fills)
//   hue        = mode
//   drift      = calm                 (stillness settles the swirl)
//   speed      = motion + bloom        (gestures push the cloud outward)
// Built on Unity's built-in ParticleSystem with a procedurally-generated soft
// dot — no external assets, no extra packages. Self-bootstraps on Play.
// ---------------------------------------------------------------------------

using UnityEngine;

namespace Astrolab
{
    public sealed class FieldAtmosphere : MonoBehaviour
    {
        ParticleSystem _ps;
        ParticleSystem.MainModule _main;
        ParticleSystem.EmissionModule _emit;
        ParticleSystem.NoiseModule _noise;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindObjectOfType<FieldAtmosphere>() != null) return;
            new GameObject("FieldAtmosphere (auto)").AddComponent<FieldAtmosphere>();
        }

        void Start()
        {
            var mat = new Material(Shader.Find("Sprites/Default")) { mainTexture = MakeDot(64) };

            var go = new GameObject("atmosphere");
            go.transform.SetParent(transform, false);
            _ps = go.AddComponent<ParticleSystem>();
            _ps.Stop();

            _main = _ps.main;
            _main.simulationSpace = ParticleSystemSimulationSpace.World;
            _main.startLifetime = 4.5f;
            _main.startSpeed = 0.4f;
            _main.startSize = 0.14f;
            _main.maxParticles = 3000;
            _main.gravityModifier = 0f;

            var shape = _ps.shape;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = 0.5f;

            _emit = _ps.emission;
            _emit.rateOverTime = 0f;

            var col = _ps.colorOverLifetime; col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(0.7f, 0.25f), new GradientAlphaKey(0f, 1f) });
            col.color = grad;

            var sol = _ps.sizeOverLifetime; sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.EaseInOut(0f, 0.2f, 1f, 1f));

            _noise = _ps.noise; _noise.enabled = true;
            _noise.strength = 0.5f; _noise.frequency = 0.3f; _noise.scrollSpeed = 0.2f;

            var psr = go.GetComponent<ParticleSystemRenderer>();
            psr.material = mat;
            psr.renderMode = ParticleSystemRenderMode.Billboard;
            psr.sortMode = ParticleSystemSortMode.None;

            _ps.Play();
        }

        void Update()
        {
            var f = FieldOscReceiver.Instance != null ? FieldOscReceiver.Instance.field : null;
            if (f == null) return;
            float hue = (f.ModeHueDeg % 360f) / 360f;
            _main.startColor = Color.HSVToRGB(hue, 0.5f, 1f);
            _emit.rateOverTime = Mathf.Lerp(10f, 260f, f.intensity) + f.motion * 140f;
            _main.startSpeed = 0.2f + 0.9f * f.motion + 0.7f * f.bloom;
            _noise.strength = Mathf.Lerp(0.9f, 0.1f, f.calm);   // calm settles the swirl
        }

        // a soft round glow texture so particles read as light, not squares
        static Texture2D MakeDot(int s)
        {
            var t = new Texture2D(s, s, TextureFormat.RGBA32, false) { wrapMode = TextureWrapMode.Clamp };
            float c = (s - 1) / 2f;
            for (int y = 0; y < s; y++)
                for (int x = 0; x < s; x++)
                {
                    float d = Mathf.Sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
                    float a = Mathf.Clamp01(1f - d); a *= a;   // soft falloff
                    t.SetPixel(x, y, new Color(1f, 1f, 1f, a));
                }
            t.Apply();
            return t;
        }
    }
}
