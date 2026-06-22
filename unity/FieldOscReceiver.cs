// FieldOscReceiver.cs — ASTROLAB Field reader for Unity (Phase 1, first light).
// ---------------------------------------------------------------------------
// Listens for the Field on UDP (default 9000, matching td-bridge.js) using
// OscJack, and applies every /field/<name> message to a shared Field. Other
// scripts (visuals, audio, worlds) read `receiver.field.*`.
//
// OscJack delivers OSC on a background thread, so we only ENQUEUE there and
// drain on the main thread in Update() — safe, and the Field updates in step
// with the frame.
//
// SETUP
//   1. Put this + Field.cs in Assets/Astrolab/.
//   2. Create an empty GameObject, name it "FieldReceiver", add this component.
//   3. Leave Port = 9000. Press Play.
//   4. In the `handmade` repo:  node td-bridge.js
//   5. Open the web instrument on localhost, press Begin, move your hands.
//   6. Watch the `field` values tick in this component's Inspector. That's first light.
// ---------------------------------------------------------------------------

using System.Collections.Concurrent;
using UnityEngine;
using OscJack;

namespace Astrolab
{
    public sealed class FieldOscReceiver : MonoBehaviour
    {
        [Tooltip("UDP port to listen on. Must match td-bridge.js (Unity = 9000).")]
        public int port = 9000;

        [Tooltip("The live Field. Every other script reads from here.")]
        public Field field = new Field();

        OscServer _server;
        readonly ConcurrentQueue<Msg> _queue = new ConcurrentQueue<Msg>();

        struct Msg { public string addr; public float val; }

        void OnEnable()
        {
            _server = new OscServer(port);
            _server.MessageDispatcher.AddRootCallback(OnOsc);   // catch every /field/* address
            Debug.Log($"[ASTROLAB] Field receiver listening on UDP {port}");
        }

        void OnDisable()
        {
            if (_server != null) { _server.Dispose(); _server = null; }
        }

        // --- BACKGROUND THREAD: only enqueue, never touch Unity APIs here ---
        void OnOsc(string address, OscDataHandle data)
        {
            if (data.GetElementCount() < 1) return;
            _queue.Enqueue(new Msg { addr = address, val = data.GetElementAsFloat(0) });
        }

        // --- MAIN THREAD: drain into the Field once per frame ---
        void Update()
        {
            while (_queue.TryDequeue(out var m))
                field.Apply(m.addr, m.val);
        }
    }
}
