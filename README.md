# Scahn

A teaching tool for ultrasound scanning technique.

A phone acts purely as an inertial sensor. A separate screen renders a 3D torso
with real anatomy, a virtual transducer, and a bounded scan sector. Rotating
the phone rotates the virtual probe in near-real time, and the learner sees, side
by side, the 3D anatomy being cut and the flat greyscale cross-section that cut
corresponds to.

**Live:** https://scahn.robbiemed.org

---

## ⚠️ Pre-alpha — not clinically validated

The anatomy is real: a whole-body adult male from **BodyParts3D** with an
abdominal-wall muscle layer from **Z-Anatomy**, and a standalone **female
pelvis** reconstructed from the Visible Korean Human sectioned images. The
**named window positions are approximations** placed by measuring how much of
each target organ a position returns, with the orientation-marker direction
fixed by convention; they have not been reviewed by anyone who scans.

**Do not use this for clinical instruction yet.** The side-by-side geometry is
real and the laterality is asserted at build time; the windows are not
validated.

There is also no acoustic simulation, by design. The 2D panel is a geometric
cross-section with flat per-organ greys and one acoustic effect — shadowing
behind bone — not a simulated B-mode image: no speckle, attenuation or
artefact. See `ROADMAP.md` for what is planned (freeze and calipers, image
export, a beating heart, pulsing vessels, Doppler).

## Running a session

1. Open https://scahn.robbiemed.org on the display (laptop, iPad, projector).
   It shows a QR code and a six-digit room code.
2. Scan the QR with the phone's **native camera app** — not an in-page scanner.
   The page opens already paired, so the only prompt is the motion permission.
   Typed entry of the six-digit code is the fallback.
3. Grant motion access, press **Recenter**, and scan.

Multiple phones can join one room, but exactly one drives at a time. Any phone
can press **Take control** for an explicit handoff, which is the point: demo the
window yourself, hand it to the learner, take it back, without re-pairing. If
the driving phone leaves for good, the next phone to join takes over.

On the display: **Freeze** (or `F`) holds the frame; **Caliper** (`C`) then
two clicks on the image measures a distance, which also appears as a segment
inside the anatomy in ghost mode (`X` clears); **Save image** (`S`) writes a
PNG with the window, transducer, depth and attribution burned in; **Learn**
opens the POCUS 101 or POCUS Atlas tutorial for the current window beside
the image. The phone can freeze, lists the caliper readouts, and links the
tutorial. An **Engine** chip switches the cross-section between stencil
capping of the meshes and a sampled label volume (faster, no watertightness
requirement, voxel edges).

**Recenter is not optional.** Magnetometer heading drifts badly near hospital
beds, metal furniture and monitors. Press it whenever the probe feels off-axis.

The display is the authority on where the probe is. It echoes the window,
transducer, depth, mode and position to every phone, so a phone's controls
always show what is on screen, and sliding the pad continues from where the
probe actually is.

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
Two more instances of the same class, named `quota:<ip>` and `quota:global`,
hold the per-IP room-creation window and the live-room count.

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

cd worker && npx wrangler dev --port 3105   # local Worker + DO (needs Node 20+)
npx wrangler deploy                # deploy

./scripts/build-assets.sh          # rebuild the BodyParts3D GLB (Blender)
./scripts/repair-pelvis.sh         # post-process the pelvis GLB (Blender)
```

Tests are integration tests against a running relay, and are transport-agnostic —
they pass against both the Worker and the Node relay — plus one unit test for
the optical-flow matcher:

```bash
SCAHN_TEST_URL=ws://127.0.0.1:3105/ws node --test relay/test/protocol.test.js
npm test                           # phone unit test + relay suite
```

## Status

Verified working: room pairing and handoff, single-controller enforcement,
cross-room isolation, token-replay reconnect, handoff after the driver leaves,
display-to-phone state echo, client heartbeat, coordinate conventions, stencil
capping, acoustic shadowing behind bone, and 3D/2D laterality agreement.

Three anatomy models are selectable at runtime: Primitives (watertight
ellipsoids, the capping reference), BodyParts3D (whole body, with cardiac
chambers and valves, one fused heart wall, and an optional muscle layer), and
the female pelvis. Windows are defined per model; a window the loaded model has
no placement for says so instead of moving the probe.

Known gaps:

- **Window positions are not clinically reviewed.** They were tuned by a
  pixel-count sweep with the marker direction fixed by convention
  (`clients/viewer/src/torso.js` explains the scoring).
- **Per-sensor RTT is not reported.** The DO answers the heartbeat with
  `setWebSocketAutoResponse`, which never wakes it, so it cannot time a round
  trip. The roster shows no latency figure.
- **A six-digit code is the only room secret.** Creation is rate-limited per
  IP and globally; join attempts are not, so a guessed code can join a session.
- **Sheet muscles.** The thin BodyParts3D sheets (external intercostal,
  external oblique) are the hardest meshes to close; check the build log's
  `STILL LEAKY` lines after any pipeline change.

## Licensing and attribution

Application code is **MIT**. The models are separately licensed and the
About panel (ⓘ) and `clients/viewer/src/credits.js` carry the required
attributions:

- **BodyParts3D**, © The Database Center for Life Science, [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/).
  Required attribution: *BodyParts3D, © The Database Center for Life Science
  licensed under CC Attribution 4.0 International.* The raw OBJ headers still
  name the pre-2025 CC BY-SA 2.1 JP terms; the database README (2025-02-25)
  relicensed it to CC BY 4.0.
- **Z-Anatomy** (Gauthier Kervyn and contributors), CC BY-SA 4.0: five
  abdominal-wall muscles BodyParts3D lacks. Because they are combined with
  BodyParts3D geometry in one GLB, **the shipped whole-body model is
  CC BY-SA 4.0 as a combined work.**
- **Visible Korean Human** female pelvis (Ajou University School of Medicine),
  **CC BY-NC 4.0**. NonCommercial is a constraint on the project, not just on
  that file: if Scahn is ever monetised, `kvh-female-pelvis.glb` has to come
  out first. It ships as its own GLB and must never be merged with the
  BodyParts3D model, because NonCommercial and ShareAlike cannot both be
  satisfied inside one combined work.

BodyParts3D is an adult **male** and has no female reproductive anatomy, which
is why the pelvis is a separate model. The legacy Sketchfab/FBX sources that
preceded BodyParts3D are retired under `3d_models/` (gitignored) and must not be
redistributed; their licences were never resolved.
