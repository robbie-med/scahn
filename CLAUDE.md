# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Scahn is an ultrasound scanning-technique teaching tool. A phone acts purely as an inertial
sensor; a separate screen renders a 3D torso with positioned organs and, beside it, the flat
greyscale cross-section that the current scan plane corresponds to. **That side-by-side mapping
is the product.** Everything else serves it.

`README.md` is user-facing. `CONVENTIONS.md` is the authority on the coordinate basis — read it
before touching geometry, cameras or asset import. `ROADMAP.md` holds the designed-but-unbuilt
features (freeze, calipers, image export, beating heart, Doppler); read it before starting any
of them.

## Environment

Default `node` on PATH is **v12**. Wrangler needs **20+**. Start every session with:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24
```

Blender 5.2 lives at `~/.local/bin/blender` (tarball install, not apt).

Ports are claimed in `/home/user/Projects/PORTS.md`: **3105** relay / `wrangler dev`, 3902 and
3903 Vite HMR. Production is Cloudflare Workers, so nothing binds locally in prod.

GitHub is **robbie-med over SSH only** (`git@github.com:robbie-med/scahn.git`). Verify with
`ssh -T git@github.com`, not `gh auth status`.

## Commands

```bash
npm install                                   # npm workspaces: shared, relay, worker, clients/*

./scripts/build-site.sh                       # build both clients -> site/ (also copies the Draco decoder)
cd worker && npx wrangler dev --port 3105     # local Worker + Durable Object, serves site/
cd worker && npx wrangler deploy              # deploy to scahn.robbiemed.org

./scripts/build-assets.sh                     # Blender: BodyParts3D OBJ drop -> clients/viewer/public/models/bodyparts3d.glb
./scripts/repair-pelvis.sh                    # Blender: post-process the shipped pelvis GLB (lumen, tubes); refuses to run twice
# build-assets.sh drives pipeline/bodyparts3d.py, which also appends the five
# abdominal-wall muscles BodyParts3D lacks from the Z-Anatomy blend. ~10 min:
# the sheet muscles are remeshed through ~1M-triangle intermediates.
```

Tests: one unit test (the optical-flow matcher) and an **integration suite against a running
relay** that is transport-agnostic — the same suite passes against the Node relay and the Worker:

```bash
npm test                                                   # phone unit test + relay suite (needs a relay on 3105)
SCAHN_TEST_URL=ws://127.0.0.1:3105/ws        npm test --workspace @scahn/relay
SCAHN_TEST_URL=wss://scahn.robbiemed.org/ws  npm test --workspace @scahn/relay   # against prod

# One test. The flag MUST precede the file — placed after it, Node silently runs
# the whole suite and reports everything passing, which looks like a filter that worked.
node --test-name-pattern="rate-limits" relay/test/protocol.test.js
```

There is no linter configured.

### Gotchas that will waste your time

- **`wrangler dev` breaks if you rebuild `site/` under it.** `build-site.sh` deletes and recreates
  the directory, which invalidates its asset index and every request 500s. Restart it after a build.
- **Blender needs `LD_LIBRARY_PATH` for Draco**, on *import* as well as export. It ships
  `libdraco.so.9` in its own `lib/` but `dlopen()`s it by bare name.
  The scripts set it; ad-hoc scripts must too, or the failure surfaces deep inside ctypes.
- **`bpy.ops.object.modifier_apply` needs the object SELECTED**, not merely active. Otherwise it is
  a silent no-op.
- **Cloudflare asset propagation lags a deploy by tens of seconds.** A 404 or stale bundle
  immediately after `wrangler deploy` is usually not a bug — re-fetch, and compare the hashed JS
  filename in production's `index.html` against `site/index.html` before debugging.
- **A `javascript_tool`/console script that renders in a loop must yield** (`await` a
  `setTimeout(0)` every ~150 frames) and finish in well under a minute; the Browser tool times
  out at 45 s. Launch long sweeps un-awaited and poll a `window` flag.

## Architecture

Four workspaces plus a Python asset pipeline.

| Path | Role |
|---|---|
| `shared/index.js` | `@scahn/protocol` — the wire contract. Message allowlist, limits, presets, depth ranges, the byte-exact `PING_FRAME`. Imported by every other workspace so they cannot drift. |
| `shared/i18n.js` | Six-language string catalogue (en, ko, fr, zh, ru, ar) and the DOM helpers. |
| `clients/phone/` | Reads device orientation, converts to a quaternion **on the handset**, streams at 30 Hz (2 Hz while viewing-only). |
| `worker/` | Cloudflare Worker + Durable Object. Room pairing and fan-out. Also serves both clients. |
| `relay/` | Legacy Node implementation of the same protocol. Offline dev path only. |
| `clients/viewer/` | Three.js. The display. |
| `pipeline/*.py` | Headless Blender asset repair. `bodyparts3d.py` builds the shipped GLB; `kvh_repair.py` post-processes the pelvis. |

### Relay: one Durable Object per room

`env.ROOMS.idFromName(roomCode)` means **Cloudflare's routing *is* the room map** — cross-room
isolation is structural, not enforced in code. The DO is hibernation-safe, and that constrains it:
no `setInterval`/`setTimeout` anywhere, `setWebSocketAutoResponse` for the heartbeat,
Alarms for room TTL, `serializeAttachment` for per-socket identity. **Storage is written on
join, claim and close only, never per orientation frame** — at 30 Hz that is the one way to hit
a free-tier limit. A consequence: per-sensor RTT is unmeasurable, because the auto-pong never
wakes the DO.

- **The heartbeat is client-initiated.** The DO cannot send one. Both clients send `PING_FRAME`
  every `HEARTBEAT_MS` and close the socket after `MISSED_PONGS` silent intervals; the auto-
  response only matches that exact string, so build it from the constant.
- **The display echoes its state** (`state` frame: u, v, preset, probe, depth, mode) to every
  phone, on change and whenever the roster changes. Phones adopt it except for a value they
  changed themselves in the last 600 ms. Without the echo the phone's pad teleported the probe
  out of a window, and a phone taking control overwrote transducer and depth.
- **Handoff and pruning.** A phone joining while the recorded driver has no live socket takes
  control; identities socket-less for longer than `ROOM_GRACE_MS` are pruned on the next join;
  the per-room cap counts live sockets. All three match the Node relay.
- **Quota lives in the same DO class**, under the names `quota:<ip>` (creation window) and
  `quota:global` (live-room count, released from the room's expiry alarm). No second class, so
  no second migration.

Role and room ride in the WS **query string** (`/ws?role=display&room=418306`) because the Worker
must resolve the DO before the upgrade completes. The Node relay ignores those and reads the
`create`/`join` frame instead, which is why one client build drives either backend.

Both clients and `/ws` are served from **one origin**. That is what satisfies iOS's
secure-context requirement for `DeviceOrientationEvent.requestPermission()`.

### Viewer: two viewports, one WebGL context, separated by layer

`main.js` renders the 3D scene and the 2D panel as two scissored viewports of a single canvas.
The two are separated by **render layer, not by scene**, so the cut geometry is shared and the
panels can never disagree — the whole point of the tool.

- `LAYER_3D` (0) — surfaces, ghosts, colour caps, fiducials, beam
- `LAYER_2D` (1) — stencil groups and the flat-grey caps only, which is why the panel reads as an
  ultrasound screen rather than a small copy of the 3D view
- `LAYER_BONE` (2) — bone only, rendered to its own mask so `panel2d.js` can cast acoustic shadows

**Only bone may enable `LAYER_BONE` on its stencil group.** The stencil clear rides on the cap, and
in that pass only bone draws one, so any other organ enabled there writes stencil nothing clears —
the bone cap then paints over all the viscera.

**The panel's colour space.** The cap pass renders into a render target, where three.js applies
no output encoding; the shadow composite must `#include <colorspace_fragment>` or every grey
ships roughly squared (liver 133 → 60). The render target is cleared to black, not the page
colour, so the empty field is black whether or not the shadow mask crosses it.

**Chrome lives in the 3D viewport.** `layout()` reserves the disclaimer strip above both
viewports and confines badges, chips, pairing card and debug drawer to the 3D viewport's width,
so nothing is ever drawn over the panel. Below 900 px the chrome becomes a strip and the panels
stack. The fiducials are hidden by default (Debug drawer → Fiducials).

`setProbeType` is idempotent: the phone sends `probe` in every frame, and before the early
return the sector geometry was rebuilt thirty times a second.

### Capping is the part that makes or breaks it (`capping.js`)

`side: DoubleSide` does **not** produce a solid cross-section; clipping discards fragments, so
a clipped liver reads as a bowl. Per mesh: back faces increment stencil, front faces decrement,
a quad on the plane paints where the count is nonzero, then **the stencil is cleared per mesh**
(via `onAfterRender`). Skip that clear and cap colours bleed between organs.

Two invariants that were each paid for:

- Cap quads are placed in world space every frame from `surface.matrixWorld`, so they are attached
  to the **scene root**, never to a group node — inheriting a group transform would rotate and
  scale the quad rather than move it.
- A cap is skipped entirely unless the plane intersects the organ's bounding box. Stencil capping
  assumes closed manifold surfaces and **the source meshes are not all closed**; without this
  guard the heart painted 15,000 px of myocardium into a suprapubic view with the plane 50 cm
  away. The guard cannot fix a leaky mesh, only localise the failure.

Derive the clipping plane with `Plane.setFromNormalAndCoplanarPoint`. Never assign `.constant`
by hand — the sign error shows up as a plane offset by twice the probe's distance from the origin,
which reads as a positioning bug.

### Anatomy: registry, groups, windows

`models.js` holds `MODELS` (primitives / BodyParts3D / female pelvis). The Blender pipeline
bakes the source-axis correction into each GLB, so the viewer applies **no** import transform.
The primitive set paints first (instant, watertight); `main.js` swaps in `bodyparts3d` as soon
as the download finishes.

The groups (`organs`, `heart`, `bones`, `muscles`) hang off `THREE.Group` nodes in `main.js`.
They stay at identity — they exist so capping and the bone shadow pass can treat the classes
separately and so the muscle layer can be toggled.

**Windows are per model** (`torso.js`, `MODEL_WINDOWS` / `windowsFor`). The pelvis has only
`suprapubic`; any other preset reports itself unavailable instead of moving the probe to a spot
tuned against a different body. **Spin signs are chosen by convention, never by search** — the
comment block above `BODYPARTS3D_WINDOWS` is the authority. u, v and tilt were tuned by a sweep
that paints each organ a unique id grey, forces the shadow floor to 0, and scores per organ with
the shadow pass on; the harness is described there so it can be re-run after any anatomy change.

### Asset pipeline (`pipeline/*.py`)

Repair exists because capping needs closed surfaces. Deliberately **not** "voxel remesh
everything": on this data a blanket 2 mm remesh took the liver from 1,480 to 73,148 triangles while
fixing two bad edges. Tier 1 hole-fills in place; tier 2 remeshes at a voxel size solved from
surface area **and capped by wall thickness** (`2*volume/area`) — a voxel larger than the wall
deletes the wall, which is how a trachea came back as unrecognisable tube.

- **Weld before measuring.** glTF splits vertices at normal/UV seams, so a closed mesh imports
  looking torn — raw open-edge counts run ~9× the true value.
- **Dedupe signatures must include the bounding box.** Vertex+polygon counts alone collide for
  symmetric pairs and silently delete one side of the body (left/right kidney).
- **Appending from another .blend has four traps**, all of which shipped silently before the
  assertions caught them: `dst.objects = names` **aliases your list** and Blender rewrites it
  in place with datablocks; paired `.l`/`.r` objects **share one mesh datablock**, so baking
  `matrix_world` twice compounds; an appended object reports an **identity `matrix_world`**
  until `view_layer.update()`, so reading it early bakes raw local coordinates; and the `.r`
  side's matrix is a **mirror**, so baking it reverses winding — flip the faces back or that
  side ships inside-out (its volume exactly cancelled the other side's).
- **Budgets.** Bone is decimated per element to `BONE_TRI_BUDGET` before the join, every organ
  is capped at `ORGAN_TRI_CAP` (valves exempt), muscles share `MUSCLE_TRI_BUDGET`, and every
  decimation is followed by weld + hole-fill + `validate()` because collapse decimation reopens
  seams. The three heart-wall shells are joined and voxel-fused into one epicardial surface
  (`fuse_heart_wall`); the chambers stay separate meshes.
- **Valves must NOT be hole-filled.** Their boundary loops *are* the leaflet free edges; closing
  them seals the chambers and turns the heart back into a solid block.
- **Muscles remesh through very large intermediates** (`MUSCLE_REMESH_TRIS`): the external
  intercostal is a 1.6 mm sheet over most of the thorax and needs ~1M triangles at a voxel its
  walls survive. Build time, not payload — they decimate to budget afterwards.
- **The pelvis is post-processed, not rebuilt.** The Visible Korean slice stack is not on the
  build machine. `kvh_repair.py` derives the bladder lumen (inward offset, then a voxel remesh
  because the offset shell self-intersects at the neck) and replaces the blocky ureters and
  urethra with swept tubes along a binned principal-axis centreline. It refuses to run on a GLB
  that already has a lumen.
- Draco: the **decoder must be copied into the build output** (`build-site.sh` does this).
  `GLTFLoader` alone cannot decode it and the model silently falls back to primitives.

## Verifying changes

Rendering bugs here do not show up in unit tests. Drive the deployed or local page in a browser
and read pixels back. `window.scahn` exposes `THREE`, `state`, `organs`, `probe`, `scanPlane`,
`ghostPlane`, `panel`, `skin`, `beam`, `renderer`, `camera3d`, `controls`, `scene`, `fiducials`,
`torso()`, `windowsFor`, `rect2d()`/`rect3d()`, and `setModel` / `applyPreset` / `setMode` /
`setDepth` / `setProbeType` / `setMuscles` / `frameTorso` / `renderFrame`. Note `renderFrame()`
must be driven manually in a headless or backgrounded tab, where `requestAnimationFrame` is
paused. Established checks:

- **Laterality, every time geometry changes.** Assert against *anatomy*, never node names: spleen
  at greater X than liver and gallbladder; heart above liver above bladder; liver anterior to the
  retroperitoneal adrenals. A mislabelled mesh sails through a name check.
- **Marker side.** On `aorta-transverse` the liver's pixel centroid must sit in the LEFT half of
  the panel (patient's right on screen left). On `ruq-morison` the probe's world +X must point
  SUPERIOR (`probe.getWorldQuaternion` applied to (1,0,0)).
- **Capping and colour space**: sample panel pixels at known organ positions and compare to the
  assigned grey — with the shadow pass ON, a liver pixel reads back exactly 133.
- **Performance**: force `gl.finish()`. WebGL is pipelined, so timing render calls with
  `performance.now()` alone measures submit cost and swings 3× between runs.
- **Protocol**: run the relay suite against `wrangler dev` before deploying; it covers handoff
  after the driver leaves, state echo and the heartbeat as well as the original pairing tests.

## Known state

- The female pelvis is **CC BY-NC 4.0** (Visible Korean Human, Ajou University School of
  Medicine). **NonCommercial is a constraint on the project, not just on that file**: if Scahn
  is ever monetised, `kvh-female-pelvis.glb` has to come out first. It ships as its OWN GLB,
  separate from the BodyParts3D model, and that separation is load-bearing — NonCommercial
  here and ShareAlike there cannot both be satisfied inside one combined work, so the two
  models must never be merged into a single file.
- The shipped whole-body model is **CC BY-SA 4.0 as a combined work**: BodyParts3D (DBCLS, CC BY
  4.0) plus five abdominal-wall muscles from Z-Anatomy (CC BY-SA 4.0), which BodyParts3D does
  not contain at all. Both sources are credited in `credits.js`. BodyParts3D's raw OBJ headers
  still name the pre-2025 CC BY-SA 2.1 JP terms; the README (updated 2025-02-25) relicensed it
  to CC BY 4.0. Application code is MIT (`package.json`).
- BodyParts3D is an **adult male** model, and has no female reproductive anatomy. Z-Anatomy
  has none either — its female collections exist but contain zero meshes.
- The probe rides the **real skin mesh** (`torso.js` raycasts it); the analytic ellipse remains
  for the primitive set and for any (u, v) that misses the mesh (above or below the pelvis
  model's 25 cm). `TORSO.rx/rz` are measured from the mid-height ring, not the bounding box, so
  the arms on the BodyParts3D skin do not inflate them.
- Window presets are tuned by measurement, **not clinically reviewed**. The "not clinically
  validated" banner stays until they are.
- A six-digit code is the only room secret. Creation is quota-limited; join attempts are not.
