# Scahn

A teaching tool for ultrasound scanning technique.

A phone acts purely as an inertial sensor. A separate screen renders a 3D torso
with positioned organs, a virtual transducer, and a bounded scan sector. Rotating
the phone rotates the virtual probe in near-real time, and the learner sees, side
by side, the 3D anatomy being cut and the flat greyscale cross-section that cut
corresponds to.

**Live:** https://scahn.robbiemed.org

---

## ⚠️ Pre-alpha — not anatomically accurate

Organs are currently **primitive ellipsoid stand-ins at plausible-but-not-correct
positions**. They exist so the orientation pipeline, clipping, capping and the 2D
panel could be built and verified before real anatomy landed.

**Do not use this for anatomy instruction or clinical teaching yet.** The
side-by-side geometry is real; the anatomy is not. Real meshes arrive with the
Blender asset pipeline (P3), which is blocked — see *Status* below.

There is also no acoustic simulation, by design. The 2D panel is a geometric
cross-section with flat per-organ greys, not a simulated B-mode image: no speckle,
attenuation, artifact, or tissue echogenicity.

## Running a session

1. Open https://scahn.robbiemed.org on the display (laptop, iPad, projector).
   It shows a QR code and a six-digit room code.
2. Scan the QR with the phone's **native camera app** — not an in-page scanner.
   The page opens already paired, so the only prompt is the motion permission.
   Typed entry of the six-digit code is the fallback.
3. Grant motion access, press **Recenter**, and scan.

Multiple phones can join one room, but exactly one drives at a time. Any phone
can press **Take control** for an explicit handoff, which is the point: demo the
window yourself, hand it to the learner, take it back, without re-pairing.

**Recenter is not optional.** Magnetometer heading drifts badly near hospital
beds, metal furniture and monitors. Press it whenever the probe feels off-axis.

## Architecture

| Component | Role |
|---|---|
| **Viewer** (`clients/viewer`) | Three.js. Receives orientation, renders the 3D scene and 2D panel. |
| **Phone** (`clients/phone`) | Reads device orientation, converts to quaternion, streams at 30 Hz. |
| **Worker** (`worker`) | Cloudflare Worker + Durable Object. Room pairing and fan-out. Serves both clients from the same origin. |
| **Relay** (`relay`) | Legacy Node implementation of the same protocol. Offline dev path. |
| **Protocol** (`shared`) | The wire contract, shared by all of the above. |

One Durable Object per room, resolved by room code, so Cloudflare's routing *is*
the room map and cross-room isolation is structural rather than enforced in code.

Serving the clients and the WebSocket endpoint from one origin is what satisfies
iOS's secure-context requirement for `DeviceOrientationEvent.requestPermission()`.

**[CONVENTIONS.md](CONVENTIONS.md) is the authority on the coordinate basis.**
Read it before touching geometry, cameras, or asset import. A silent mirror flip
in an ultrasound teaching tool teaches the wrong thing convincingly.

## Development

```bash
npm install
npm run build                      # build both clients
./scripts/build-site.sh            # assemble site/ for the Worker

cd worker && npx wrangler dev      # local Worker + DO (needs Node 20+)
npx wrangler deploy                # deploy
```

Tests are integration tests against a running relay, and are transport-agnostic —
they pass against both the Worker and the Node relay:

```bash
SCAHN_TEST_URL=wss://scahn.robbiemed.org/ws node --test relay/test/protocol.test.js
```

## Status

Verified working: room pairing and handoff, single-controller enforcement,
cross-room isolation, token-replay reconnect, coordinate conventions, stencil
capping (capped myocardium with open chambers, no bleed), inverted-plane ghost
pass, and 3D/2D laterality agreement.

Anatomy models are selectable at runtime (Primitives / BodyParts3D).
Imported meshes are repaired by the Blender pipeline before shipping — see
`scripts/build-assets.sh`. The BodyParts3D heart ships with separate cavity,
wall and valve meshes, so the cardiac chambers cap open with real interior
surfaces rather than being invented.

Known gaps:

- **Window preset positions are first-pass.** They were tuned by measuring how
  much target tissue each window returns, not by clinical review, and the
  heart's placement in the thorax is a chosen position rather than a measured
  one. Both want checking by someone who scans.
- **Per-sensor RTT is not reported.** The DO uses `setWebSocketAutoResponse` for
  the heartbeat so it can hibernate; the auto-pong never wakes the DO, so it
  cannot time a round trip. The roster shows no latency figure.
- **No per-IP room-creation cap.** Per-socket message rate, frame size, sensors
  per room and room TTL are all capped; per-IP creation limiting needs a
  Cloudflare rate-limiting binding.
- **245 non-manifold edges** remain across the imported meshes, from Draco
  position quantisation collapsing near-coincident vertices. Open edges — the
  defect that actually breaks capping — are eliminated.

## Licensing and attribution

Application code is MIT. The anatomy model is **BodyParts3D** (full body,
including cardiac chambers and valves), © The Database Center for Life Science,
licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). It is
repaired and re-exported as GLB by the Blender pipeline — a derivative work the
licence permits, with attribution given in the in-app About panel (the ⓘ
button) and in `clients/viewer/src/credits.js`.

Required attribution string:

> BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International

The model is an adult **male** — there is no uterus/ovaries mesh. The legacy
Sketchfab/FBX sources (including a CC BY-NC-ND abdomen and two files of unknown
provenance) are retired to `3d_models/_ARCHIVE_legacy_LICENSING-UNRESOLVED/`
and must not be redistributed.
