# AGENTS.md

Guidance for AI coding agents working in this repository. Assumes no prior knowledge of the
project.

## Project overview

Scahn is an ultrasound scanning-technique teaching tool, live at
https://scahn.robbiemed.org. A phone acts purely as an inertial sensor; a separate screen
renders a 3D torso with positioned organs and, beside it, the flat greyscale cross-section
that the current scan plane corresponds to. **That side-by-side mapping is the product.**
Everything else serves it.

Status: **pre-alpha, not anatomically accurate.** Window presets in `clients/viewer/src/torso.js`
were tuned by measuring tissue returned per window, not clinically reviewed. The "not
anatomically accurate" banner stays until the anatomy is validated. There is deliberately no
acoustic simulation — the 2D panel is a geometric cross-section with flat per-organ greys,
not a simulated B-mode image.

`README.md` is user-facing. `CLAUDE.md` contains the same operational guidance as this file.
**`CONVENTIONS.md` is the single authority on the coordinate basis — read it before touching
geometry, cameras or asset import.** A silent mirror flip in an ultrasound teaching tool
teaches the wrong thing convincingly; if code and `CONVENTIONS.md` disagree, the code is
wrong.

## Environment

- Default `node` on PATH is **v12**; Wrangler needs **20+**. Start every session with:

  ```bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
  ```

- Blender 5.2 lives at `~/.local/bin/blender` (tarball install, not apt).
- Ports are claimed in `/home/user/Projects/PORTS.md`: **3105** relay / `wrangler dev`,
  **3902** viewer Vite HMR, **3903** phone Vite HMR. Tests and dev servers do not get to
  invent other ports. Production is Cloudflare Workers, so nothing binds locally in prod.
- GitHub is **robbie-med over SSH only** (`git@github.com:robbie-med/scahn.git`). Verify with
  `ssh -T git@github.com`, not `gh auth status`.
- Node >= 18.18 required (`engines` in root `package.json`). All packages are ESM
  (`"type": "module"`).

## Build and test commands

```bash
npm install                                   # npm workspaces: shared, relay, worker, clients/*

npm run dev                                   # relay + both Vite dev servers (scripts/dev.sh)
npm run build                                 # build both clients (Vite)
./scripts/build-site.sh                       # build both clients -> site/ (also copies the Draco decoder)
cd worker && npx wrangler dev --port 3105     # local Worker + Durable Object, serves site/
cd worker && npx wrangler deploy              # deploy to scahn.robbiemed.org
npm start                                     # legacy Node relay on 127.0.0.1:3105
npm run tunnel                                # cloudflared HTTPS tunnel so a real phone can grant motion access

./scripts/build-assets.sh                     # Blender: repair 3d_models/*.glb -> clients/viewer/public/models/
# build-assets.sh drives pipeline/bodyparts3d.py, which also appends the five
# abdominal-wall muscles BodyParts3D lacks from the Z-Anatomy blend.
blender --background --factory-startup --python pipeline/bodyparts3d.py -- ISA_OBJ_DIR OUT.glb
```

Tests are **integration tests against a running relay** and are transport-agnostic — the same
suite passes against the Node relay and the Worker:

```bash
SCAHN_TEST_URL=ws://127.0.0.1:3105/ws        npm test --workspace @scahn/relay
SCAHN_TEST_URL=wss://scahn.robbiemed.org/ws  npm test --workspace @scahn/relay   # against prod

# One test. The flag MUST precede the file — placed after it, Node silently runs
# the whole suite and reports 9 passing, which looks like a filter that worked.
node --test-name-pattern="rate-limits" relay/test/protocol.test.js
```

There is no linter configured.

### Gotchas that will waste your time

- **`wrangler dev` breaks if you rebuild `site/` under it.** `build-site.sh` deletes and
  recreates the directory, which invalidates its asset index and every request 500s. Restart
  it after a build.
- **Blender needs `LD_LIBRARY_PATH` for Draco**, on *import* as well as export. It ships
  `libdraco.so.9` in its own `lib/` but `dlopen()`s it by bare name. `build-assets.sh` sets
  it; ad-hoc scripts must too, or the failure surfaces deep inside ctypes.
- **`bpy.ops.object.modifier_apply` needs the object SELECTED**, not merely active. Otherwise
  it is a silent no-op.
- **Cloudflare asset propagation lags a deploy by tens of seconds.** A 404 or stale bundle
  immediately after `wrangler deploy` is usually not a bug — re-fetch, and compare the hashed
  JS filename in production's `index.html` against `site/index.html` before debugging.
- iOS will not grant motion access against the plain-HTTP dev servers (secure-context
  requirement, and the localhost exemption does not apply from another host). Use
  `scripts/tunnel.sh` for anything involving a real phone.

## Repository layout

Four npm workspaces plus a Python/Blender asset pipeline.

| Path | Role |
|---|---|
| `shared/index.js` | `@scahn/protocol` — the wire contract. Message allowlist, limits, presets, depth ranges, frame validation. Imported by every other workspace so they cannot drift. |
| `clients/phone/` | `@scahn/phone` — reads device orientation, converts to a quaternion **on the handset**, streams at 30 Hz. Vite. |
| `clients/viewer/` | `@scahn/viewer` — Three.js display. The 3D scene and 2D panel. Vite. |
| `worker/` | `@scahn/worker` — Cloudflare Worker + Durable Object. Room pairing and fan-out; also serves both clients and `/ws` from one origin via Workers Static Assets (`site/`). |
| `relay/` | `@scahn/relay` — legacy Node (`ws`) implementation of the same protocol. Offline dev path only. |
| `pipeline/*.py` | Headless Blender asset repair. `bodyparts3d.py` builds the shipped GLB. |
| `scripts/` | `dev.sh`, `build-site.sh`, `build-assets.sh`, `tunnel.sh`. |
| `site/` | Build output assembled by `build-site.sh`; served by the Worker. Do not edit by hand. |
| `3d_models/` | Raw source model drops (GLB/FBX + zips). |

## Architecture

### Relay: one Durable Object per room

`env.ROOMS.idFromName(roomCode)` means **Cloudflare's routing *is* the room map** — cross-room
isolation is structural, not enforced in code. The DO (`worker/src/room.js`) is
hibernation-safe, and that constrains it: no `setInterval`/`setTimeout` anywhere,
`setWebSocketAutoResponse` for the heartbeat, Alarms for room TTL, `serializeAttachment` for
per-socket identity. Sockets are accepted via `state.acceptWebSocket`, never `server.accept()`.
**Storage is written on join and claim only, never per orientation frame** — at 30 Hz that is
the one way to hit a free-tier limit. A consequence: per-sensor RTT is unmeasurable, because
the auto-pong never wakes the DO.

Role and room ride in the WS **query string** (`/ws?role=display&room=418306`) because the
Worker must resolve the DO before the upgrade completes. The Node relay ignores those and
reads the `create`/`join` frame instead, which is why one client build drives either backend.

Both clients and `/ws` are served from **one origin**. That is what satisfies iOS's
secure-context requirement for `DeviceOrientationEvent.requestPermission()`. Clients derive
the relay URL from `location.host`; `VITE_SCAHN_WS` is an escape hatch for split-origin
hosting.

### Viewer: two viewports, one WebGL context, separated by layer

`clients/viewer/src/main.js` renders the 3D scene and the 2D panel as two scissored viewports
of a single canvas. The two are separated by **render layer, not by scene**, so the cut
geometry is shared and the panels can never disagree — the whole point of the tool.

- `LAYER_3D` (0) — surfaces, ghosts, colour caps, fiducials, beam
- `LAYER_2D` (1) — stencil groups and the flat-grey caps only, which is why the panel reads as
  an ultrasound screen rather than a small copy of the 3D view
- `LAYER_BONE` (2) — bone only, rendered to its own mask so `panel2d.js` can cast acoustic
  shadows

**Only bone may enable `LAYER_BONE` on its stencil group.** The stencil clear rides on the
cap, and in that pass only bone draws one, so any other organ enabled there writes stencil
nothing clears — the bone cap then paints over all the viscera.

### Capping is the part that makes or breaks it (`clients/viewer/src/capping.js`)

`side: DoubleSide` does **not** produce a solid cross-section; clipping discards fragments, so
a clipped liver reads as a bowl. Per mesh: back faces increment stencil, front faces
decrement, a quad on the plane paints where the count is nonzero, then **the stencil is
cleared per mesh** (via `onAfterRender`). Skip that clear and cap colours bleed between
organs.

Two invariants that were each paid for:

- Cap quads are placed in world space every frame from `surface.matrixWorld`, so they are
  attached to the **scene root**, never to a group node — inheriting a group transform would
  rotate and scale the quad rather than move it.
- A cap is skipped entirely unless the plane intersects the organ's bounding box. Stencil
  capping assumes closed manifold surfaces and **the source meshes are not**; without this
  guard the heart painted 15,000 px of myocardium into a suprapubic view with the plane 50 cm
  away. The guard cannot fix a leaky mesh, only localise the failure.

Derive the clipping plane with `Plane.setFromNormalAndCoplanarPoint`. Never assign
`.constant` by hand — the sign error shows up as a plane offset by twice the probe's distance
from the origin, which reads as a positioning bug.

### Anatomy: registry and groups

`clients/viewer/src/models.js` holds `MODELS` (primitives / BodyParts3D). The
BodyParts3D model is a single self-consistent source and the Blender pipeline
bakes the source-axis correction into the GLB, so the viewer applies **no**
import transform — no per-organ overrides, additions, aspect corrections or
runtime scene layout. The primitive set paints first (instant, watertight);
`main.js` swaps in `bodyparts3d` as soon as the download finishes.

The three groups (`organs`, `heart`, `bones`) hang off `THREE.Group` nodes in
`main.js`. They stay at identity — they exist so capping and the bone shadow
pass can treat the three anatomy classes separately.

### Asset pipeline (`pipeline/*.py`)

Repair exists because capping needs closed surfaces. Deliberately **not** "voxel remesh
everything": on this data a blanket 2 mm remesh took the liver from 1,480 to 73,148 triangles
while fixing two bad edges. Tier 1 hole-fills in place; tier 2 remeshes at a voxel size
solved from surface area **and capped by wall thickness** (`2*volume/area`) — a voxel larger
than the wall deletes the wall, which is how a trachea came back as an unrecognisable tube.

- **Weld before measuring.** glTF splits vertices at normal/UV seams, so a closed mesh
  imports looking torn — raw open-edge counts run ~9× the true value.
- **Dedupe signatures must include the bounding box.** Vertex+polygon counts alone collide
  for symmetric pairs and silently delete one side of the body (left/right kidney).
- **`heart.py` must NOT hole-fill.** Its boundary loops *are* the valve annuli; closing them
  seals the chambers and turns the heart back into the solid block that replacing it was
  meant to fix.
- Voxel remesh cannot close an open shell — it derives inside from outside and needs closed
  input. ~263 bone edges and the heart's remain open; the renderer guard covers them.
- The source→scene correction **is baked into the GLB by the pipeline**
  (`SOURCE_TO_SCAHN` in `pipeline/bodyparts3d.py`: axis rotation + mm→m + the
  SI recentring that moves BP3D's feet-origin torso to the scene origin). The
  viewer deliberately applies no import transform (CONVENTIONS.md §5).
- **Viewer dedupe signatures need millimetre precision.** `models.js` rounds the
  bounding box to 4 decimals: a hollow organ and its derived lumen differ by a
  1.5-2 mm inset, so centimetre rounding collided their signatures and the
  dedupe silently discarded the gallbladder/bladder WALL, keeping the lumen.
- Draco: the **decoder must be copied into the build output** (`build-site.sh` does this).
  `GLTFLoader` alone cannot decode it and the model silently falls back to primitives.

## Code style guidelines

- All JavaScript is ESM, plain (no TypeScript, no framework, no linter). Match the existing
  style of each file; comments explain *why*, often with the failure mode that motivated the
  code — keep that convention.
- The wire contract lives only in `shared/index.js` (`@scahn/protocol`): message allowlists,
  limits, presets, depth ranges, validation. Every workspace imports it; never duplicate
  constants per side.
- **Coordinate basis** (CONVENTIONS.md): right-handed, Y-up, metres. +X = patient left,
  +Y = superior, +Z = anterior. `scene.js` asserts handedness at runtime
  (`assertHandedness()`). The magenta `L` fiducial on the patient's left flank is a permanent
  test instrument — do not remove it.
- **Source-asset axis fixes happen exactly once**, in the named import transform
  (`SOURCE_TO_SCAHN` / the models.js import transform). Never scatter compensating flips
  through runtime code; if an organ loads mirrored, fix the named transform and rebuild the
  GLB.
- **Only quaternions cross the wire, XYZW order, never Euler angles.** Euler exists in
  exactly one place: `clients/phone/src/orientation.js` converting iOS `deviceorientation` to
  a quaternion (intrinsic `YXZ` + −90° X correction + screen-orientation twist, copied from
  three.js's deprecated `DeviceOrientationControls`). Do not "simplify" it.
- Probe frame: beam axis is probe local **−Y** (into the patient); local +X is the transducer
  orientation-marker side. Placement is compositional:
  `probeWorld = surfaceFrame(u, v) · recenteredSensorQuaternion` — phone rotation means
  "rotate the probe on the skin", not "set absolute world orientation".

## Testing instructions

- Unit-test coverage is intentionally thin; the meaningful suite is
  `relay/test/protocol.test.js`, an integration test that talks to a **running** relay on the
  claimed port (3105) via `SCAHN_TEST_URL`. It is transport-agnostic: the same suite passes
  against the Node relay, the local Worker, and production.
- **Rendering bugs do not show up in unit tests.** Drive the deployed or local page in a
  browser and read pixels back. `window.scahn` (set in `clients/viewer/src/main.js`) exposes
  `THREE`, `state`, `organs`, `probe`, `scanPlane`, `ghostPlane`, `panel`, `skin`, `beam`,
  `renderer`, `camera3d`, `scene`, `torso()`, `rect2d()`/`rect3d()`, and
  `setModel` / `applyPreset` / `setMode` / `setDepth` / `setProbeType` /
  `renderFrame`. `renderFrame()` must be driven manually in a headless or backgrounded tab,
  where `requestAnimationFrame` is paused.
- Established checks:
  - **Laterality, every time geometry changes.** Assert against *anatomy*, never node names:
    spleen at greater X than liver and gallbladder; heart above liver above bladder; liver
    anterior to the retroperitoneal adrenals. A mislabelled mesh sails through a name check.
  - **Capping**: sample panel pixels at known organ positions and compare to the assigned
    grey.
  - **Performance**: force `gl.finish()`. WebGL is pipelined, so timing render calls with
    `performance.now()` alone measures submit cost and swings 3× between runs — that
    mismeasurement once produced a wrong diagnosis of ghost-mode cost.

## Security and deployment considerations

- Deployment: `./scripts/build-site.sh`, then `cd worker && npx wrangler deploy`. Custom
  domain `scahn.robbiemed.org` via `worker/wrangler.toml`; assets are Workers Static Assets
  from `site/` with `not_found_handling = "none"` (deliberately not SPA mode, so a mistyped
  phone URL fails visibly instead of loading the wrong client).
- The WS endpoint is public, so the caps in `shared/index.js` (`LIMITS`) are not optional:
  per-socket message rate (60 fps), frame size (4096 B), sensors per room (16), room TTL, and
  global room count (200). Known gap: **no per-IP room-creation cap** on the Worker — that
  needs a Cloudflare rate-limiting binding (the Node relay's `ROOMS_PER_IP_PER_HOUR` limit
  does not exist there).
- The Node relay binds 127.0.0.1 by design; public reach in dev comes from the Cloudflare
  Tunnel (`scripts/tunnel.sh`), not from binding 0.0.0.0.
- Room codes are server-assigned six digits; uniqueness is guaranteed because the DO itself
  rejects a colliding claim.
- The female pelvis is **CC BY-NC 4.0** (Visible Korean Human, Ajou University School of
  Medicine). **NonCommercial is a constraint on the project, not just on that file**: if Scahn
  is ever monetised, `kvh-female-pelvis.glb` has to come out first. It ships as its OWN GLB,
  separate from the BodyParts3D model, and that separation is load-bearing — NonCommercial
  here and ShareAlike there cannot both be satisfied inside one combined work, so the two
  models must never be merged into a single file.
- The shipped model is **CC BY-SA 4.0 as a combined work**: BodyParts3D (DBCLS, CC BY 4.0)
  plus five abdominal-wall muscles from Z-Anatomy (CC BY-SA 4.0), which BodyParts3D does not
  contain at all. The share-alike rides on the combination. Both sources are credited in
  `credits.js`. Note BodyParts3D's raw OBJ headers still name the pre-2025 CC BY-SA 2.1 JP
  terms; the README (updated 2025-02-25) relicensed it to CC BY 4.0.
- BodyParts3D is an **adult male** model, and has no female reproductive anatomy. Z-Anatomy
  has none either — its female collections exist but contain zero meshes.
- The probe rides the **real skin mesh** (`torso.js` raycasts it); the analytic capsule
  remains only for the primitive set. Window presets are parameterised against that
  surface, so changing the shell means re-tuning all eight.
- The earlier per-model note: BodyParts3D — attribution
  required, derivatives permitted, so the pipeline's repaired GLB is covered. Per-model
  status lives in the in-app ⓘ About panel and `clients/viewer/src/credits.js`. Record
  `UNKNOWN` rather than guessing, and verify licences from `asset.extras` in the files
  themselves, not from memory. The earlier Sketchfab abdomen, heart and skeleton sources
  under `3d_models/` are no longer shipped; their licences were never resolved.
