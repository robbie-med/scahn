# ROADMAP

Status (2026-10-01): **Part A is built** (freeze, calipers, image export,
tutorial links; probe models pending the asset conversion). **Part C ships as
a prototype** behind the Engine chip. **Parts B and D are planned, not
started.** This file exists so the first implementation session does not
re-derive the constraints the renderer imposes. Parts:

- **Part A — freeze, calipers, image export.** Small, no pipeline work, and
  the first thing a teacher asks for. Do this first.
- **Part B — dynamics: beating heart, pulsing vessels, Doppler.** Larger, and
  Part A's freeze is a prerequisite (you measure on a frozen frame).

The product rule still holds: there is no acoustic simulation. A beating heart
is geometry moving; colour Doppler is geometry coloured by a velocity it has
been assigned. Both are teaching aids about *where to put the probe and what
you will see*, not physics.

---

# Part A — freeze, calipers, image export — BUILT

What shipped differs from the plan below in small ways: the freeze key is
`F` on the display and a button on the phone (driver only); calipers are
placed on the display (click two points; `C` toggles placement, `X` clears)
and listed on the phone from the `state` echo; `S` saves the image. The
tutorial drawer is wide-layout only and opens a new tab on narrow screens.

## A1. Freeze (½ day)

A real machine's most-used key. Frozen means the display stops *applying*
orientation and placement frames (it keeps receiving them, so unfreezing
snaps to the live pose rather than to a stale one). Nothing else changes:
the learner can still orbit the 3D view, switch modes, toggle muscles.

- Wire: a new client message `freeze` `{ on: boolean }` from the driving phone
  (allowlisted and validated in `shared/index.js`, forwarded like `mode`), the
  `F` key on the display, and `frozen` echoed in the `state` frame so every
  phone shows it. The Node relay and the Worker both forward it; add the
  protocol test alongside the `mode` one.
- Display: a **FROZEN** badge in the top row of the 3D viewport and a small
  "FROZEN" tag drawn on the 2D panel's SVG dressing, the way machines do it.
- `main.js`: `onOrient` returns early when frozen except for `preset`,
  `probe` and `depth`, which still apply (changing depth on a frozen frame is
  normal machine behaviour; the plane does not move).

## A2. Calipers that exist in 3D (1 day)

The panel is an orthographic view of the scan plane, so a point on the panel
*is* a point in the body. That makes a caliper a 3D object, and ghost mode
(Mode 3) already shows the cut-away anatomy translucently — so a measurement
placed on the 2D image can be seen sitting inside the organ in 3D.

- Placement: on the display, click/tap two points on the panel (pointer
  events on the SVG overlay, which currently has `pointer-events: none` —
  enable it only while a caliper is being placed). From the phone, a
  "Caliper" chip puts the pad into caliper mode: drag moves the active
  endpoint. Up to four calipers (A–D, colour-coded as machines do).
- Mapping: `Panel2D._map` goes probe-local metres → panel pixels; add the
  inverse. A panel point (px, py) → probe-local (lx, ly) → world
  `P = probe.position + lx·X + ly·Y` with X, Y the probe's world axes, which
  `Panel2D.update` already computes. Store calipers in **world space**, so an
  unfrozen probe moving away leaves them where they were measured; show them
  on the panel only while the plane still passes within 2 mm of both ends.
- 3D rendering: a `THREE.Line` plus two small spheres on `LAYER_3D`, no depth
  test (always visible), no clipping planes (it is an instrument, like the
  beam). In Mode 3 the far half is ghosted, so the caliper reads as inside the
  liver, not floating in front of it.
- 2D rendering: the two crosses and the connecting dotted line in the SVG
  overlay, with the distance label `A: 4.3 cm` in the bottom-left readout
  under the transducer line. Distance is the world-space length, in cm to
  one decimal. Add an area/ellipse tool only if asked.
- Echo: calipers travel in the `state` frame (`calipers: [{id, a:[x,y,z],
  b:[x,y,z]}]`) so phones can list the readouts; the display owns them.
- Clear: a chip on the phone and `C` on the display.

## A3. Save image for a slide deck (½ day)

A **Save image** button (display; `S` key) that writes a PNG the teacher can
drop into PowerPoint.

- Composition, in an offscreen 2D canvas at 2× device pixels: both viewports
  copied from the WebGL canvas (`drawImage(canvas, …)` immediately after a
  `renderFrame()` in the same task, which avoids `preserveDrawingBuffer`),
  the SVG overlay rasterised on top of the panel (serialise the SVG, load as
  an `Image`, draw), then a burned-in footer: window name, transducer and
  depth, model and licence line (attribution is a licence obligation and a
  screenshot is a redistribution), date, and "Scahn — not clinically
  validated". Calipers, if any, are in the SVG so they come along.
- Options (Debug drawer, remembered in localStorage): panel only / both
  viewports; include the 3D chrome or not (default not — the chrome is DOM,
  not canvas, so by default it is simply absent).
- Download via a Blob URL and an `<a download>`; filename
  `scahn-<window>-<yyyymmdd-hhmm>.png`. No server round trip, nothing stored.
- iPad Safari: `a.download` works for Blob URLs in 15+; fall back to opening
  the image in a new tab for older versions.

## A4. Tutorial links per window (½ day)

Tap a window on the phone or the display and bring up the matching tutorial
from The POCUS Atlas or POCUS 101 beside the image. Checked 2026-10-01:
`thepocusatlas.com` and `pocus101.com` send no `X-Frame-Options` and no
`frame-ancestors`, so an in-page iframe side panel is possible; test the
specific article URLs, not just the home page, before relying on it, and
fall back to opening a new tab (which always works) when a page refuses.
`pocuscollective.com` denies framing (`X-Frame-Options: DENY`,
`frame-ancestors 'none'`): link out only.

- Data: a `TUTORIALS` table in `shared/index.js` keyed by preset id, each
  with `{ source: 'tpa' | 'pocus101', url }`. Display-side "Learn" button in
  the window badge; phone-side a small link under the window chips (opens
  on the phone itself, which is often where the learner wants to read).
- Display: a collapsible right-hand drawer (iframe, `sandbox` without
  `allow-same-origin`, `referrerpolicy=no-referrer`) that takes 30% of the
  width and triggers `layout()` so the viewports shrink rather than being
  covered. "Open in new tab" and "Split" buttons; the split uses
  `window.open` with a `popup` feature string, which modern browsers place
  as a side window.
- Attribution: both sites are credited in the About panel; the iframe shows
  their page unmodified.

## A5. Transducer models from POCUS Collective

Checked 2026-10-01: the site's Legal page licenses all hosted content
**CC BY-NC 4.0** unless otherwise noted; the "Ultrasound Probes STLs" entry
(Ben Smith, Core Ultrasound; phased, curvilinear and linear) is hosted in
full with no other note, so it is CC BY-NC 4.0 with credit to the author and
to The POCUS Collective. NonCommercial is already a project constraint
through the pelvis model, so this adds no new restriction; the probes ship
as their own GLBs, never merged with the BodyParts3D model (CC BY-SA).
Conversion: STL → Blender → metres, footprint at the origin, handle along
local +Y, marker side on local +X, Draco GLB per transducer; the parametric
probe stays as the fallback and the yellow notch is kept.

Order inside Part A: A1, then A3 (it needs nothing else), then A2, then A4.

---

# Part B — dynamics: beating heart, pulsing vessels, Doppler

## 0. The constraint everything else follows

The 2D panel is a stencil cap over the *same* meshes the 3D view draws, and
each organ is drawn in up to seven passes a frame (surface, ghost, two stencil
passes for each of the 3D, 2D and bone-mask cameras, cap). If a deformation is
applied to some passes and not others, the cut face and the 3D surface
disagree, which is the one failure this tool must never have.

So animation is **one vertex-shader chunk, injected into every material an
organ owns** (`CappedOrgan.surface`, `.ghost`, both `.stencilGroup` meshes)
through `onBeforeCompile`, driven by **one uniform clock**. The cap quads are
planes and never deform. Two bookkeeping consequences:

- The bounding-box guard in `capping.js` (`plane.intersectsBox`) must be
  inflated by the maximum displacement, or a chamber at end-diastole can be
  cut by a plane the guard says misses it and lose its cap for a few frames.
- `models.js` must carry per-organ deformation parameters out of the GLB
  (`asset.extras` or a `dynamics.json` sidecar written by the pipeline), never
  guessed in the viewer: centroid, long axis, kind (chamber / wall / artery /
  vein / none), amplitude.

CPU-side alternatives (updating `BufferAttribute` positions each frame) are
rejected: 460k triangles across the model, and the whole heart alone is ~35k
vertices to rewrite and re-upload at 60 Hz.

## 1. Clock

`clients/viewer/src/dynamics.js`: a single `Clock` with

- heart rate (default 70 bpm, slider in the Debug drawer, range 40–160),
- cardiac phase φ ∈ [0,1) with φ = 0 at end-diastole; systole occupies the
  first 35% at 70 bpm and shortens as rate rises (Bazett-ish: fixed ~300 ms),
- a respiratory clock (14/min) for the IVC and a faint diaphragm excursion,
- `pause` and a scrub for teaching stills.

The phone does not drive any of this; the display owns the clock exactly as it
owns the probe state, and it is echoed in the existing `state` frame (`bpm`,
`paused`) so phones can show it. Protocol change: two optional fields on
`state`, validated in `shared/index.js`.

Waveforms (normalised 0–1, piecewise-smooth, in `dynamics.js`):

- `ventricle(φ)`: cavity volume, EF 0.60: rapid fall through systole, early
  rapid fill, diastasis, atrial kick at φ ≈ 0.85.
- `atrium(φ)`: counter-phase, with the a-wave contraction at φ ≈ 0.85.
- `artery(φ, delay)`: pressure pulse with a dicrotic notch; delay = distance
  from the aortic root ÷ 6 m/s pulse-wave velocity (about 40 ms at the
  abdominal aorta — small, but it is what makes a distal pulse read as *later*).
- `ivc(ρ)`: diameter ∝ 1 − 0.4·inspiration(ρ); collapsibility is a core POCUS
  lesson and costs nothing extra.

## 2. Phase 1 — the heart (≈ 2 days)

Deformation field for every heart-group mesh, in the GLB's own frame:

```
t  = clamp(dot(p − apex, axis) / L, 0, 1)        // 0 at apex, 1 at base
ρ  = p − (apex + t·L·axis)                       // radial vector from the long axis
p' = p − s(φ)·( k_long·t·L·axis + k_rad·ρ )
```

- `s(φ)` = 1 − `ventricle(φ)` for ventricular chambers and the ventricular
  wall; the atrial curve for atrial chambers.
- `k_long` ≈ 0.12: the base descends toward a stationary apex (MAPSE
  12–15 mm on a 11 cm heart). This is why the apex, not the centroid, is the
  origin — the apex does not move on a real echo, and a centroid-scaled heart
  looks like a balloon.
- `k_rad` ≈ 0.25 for cavities, ≈ 0.08 for the wall's outer surface, so the
  wall *thickens* as the cavity shrinks. The fused `heart-wall` is one mesh,
  so the inner surface needs its own coefficient: tag vertices by distance
  to the nearest chamber mesh in the pipeline and export it as a vertex
  attribute (`_inner`, 0–1).
- Valves: leaflets as thin shells cannot be rotated without hinge data. Phase
  1 scales their opening by fading the leaflet cap grey between "open" (dark,
  in the flow) and "closed" (bright line) — the panel effect a learner sees —
  and leaves true leaflet motion to a later pass with per-valve hinge lines
  exported from the pipeline.
- Papillary muscles ride the wall field.

Acceptance: on the apical four-chamber preset, the LV cavity cap area at
φ = 0.35 over φ = 0 ≈ 0.4 ± 0.1 (`renderFrame` with `clock.phase` forced,
count cap pixels). The cardiac presets in `torso.js` were tuned at
end-diastole; re-run the tuning sweep with the clock paused at φ = 0.

## 3. Phase 2 — vessels and the "faint pulse" (≈ 1 day)

- Arteries (`Artery` class in `models.js`): radial displacement 4% of local
  radius × `artery(φ, delay)`. The radius comes from the pipeline's centreline
  fit (see §4), so the aortic root pulses more in absolute terms than the SMA.
- The IVC: `ivc(ρ)` radial, plus a 2% cardiac modulation.
- Portal and hepatic veins: 1% cardiac modulation; hepatic veins carry the
  triphasic pattern (visible only once spectral Doppler exists).
- 3D "faint pulse": the same vertex displacement is the pulse. No emissive
  flash — it reads as a cartoon. If a cue is wanted, a 2% brightness lift on
  the heart surface in systole, behind a Debug toggle, off by default.

## 4. Pipeline data (≈ 1 day, before Phase 2)

`pipeline/dynamics.py` (runs after `bodyparts3d.py`, reads the shipped GLB,
writes `clients/viewer/public/models/bodyparts3d.dynamics.json`):

- Heart: apex and long axis from the LV chamber (apex = the LV vertex
  farthest from the mitral valve centroid; axis = that direction).
- Every artery and vein: a centreline by the same principal-axis binning
  `kvh_repair.py` uses for tubes, with local radius per bin, plus a **flow
  sign** per vessel from a table in the script, because direction cannot be
  derived from geometry: arteries away from the aortic root (ascending aorta
  superior, descending/abdominal inferior, SMA anterior-inferior, pulmonary
  trunk superior-posterior), veins toward the heart (IVC and hepatic veins
  superior, portal vein into the liver, splenic vein to the right, SVC
  inferior). The table is reviewed, not inferred.
- Chambers: inflow and outflow directions (mitral inflow toward the apex,
  LVOT toward the aortic valve; the right side likewise).

## 5. Phase 3 — Doppler (≈ 3–4 days)

Colour Doppler is a per-fragment colour on **lumen caps only** (chambers,
arteries, veins), on in Mode 2/3 when the Doppler toggle is set, inside a
colour box the learner can size on the phone (default: the middle third of
the sector).

For a fragment at world position P on a lumen cap:

```
beam  = normalize(P − apexWorld)        // sector probes; probe −Y for linear
v     = V_peak(kind) · wave(φ, delay) · flowDir(P)
v_ax  = dot(v, beam)                    // signed: + away from the transducer
```

- Colour: BART (blue away, red toward), saturation ∝ |v_ax| / Nyquist,
  black at |v_ax| < wall-filter threshold. Rendered by the existing cap
  material with an extra uniform set; no new pass.
- `flowDir(P)`: the centreline tangent nearest P for vessels (uploaded as a
  small texture of bins per vessel), the inflow/outflow direction by phase for
  chambers.
- **Aliasing on purpose.** Nyquist = PRF/2 is a learner setting (scale):
  when |v_ax| exceeds it the colour wraps — the single most confusing thing
  on a first Doppler image, and the thing a geometric model can teach exactly.
- **Angle dependence is the lesson.** A vessel at 90° to the beam shows no
  colour; the learner heels the probe and it appears. This falls out of the
  dot product and must not be "helped".
- Power Doppler: a second toggle, colour by |v| only, angle-independent, to
  contrast with the above.
- Spectral (PW) Doppler: a gate at a fixed depth on the centre line; a
  scrolling strip below the panel plots `v_ax(t)` at the gate with the
  waveform of the kind under it (triphasic peripheral artery, monophasic
  portal vein, pulsatile hepatic vein, pulsed IVC). Drawn to a 2D canvas, not
  WebGL. Depends on §4 for the gate to know which vessel it sits in (nearest
  centreline bin within the lumen).

Not in scope: speckle, clutter, mirror artefact, tissue Doppler.

## 6. Order and dependencies

1. §1 clock and §2 heart (no pipeline change: apex/axis can be computed in
   the viewer from the LV chamber for the first pass).
2. §4 pipeline data.
3. §3 vessels.
4. §5 colour Doppler, then PW.
5. Re-tune the cardiac presets at φ = 0; add `bpm`/`paused` to the `state`
   frame; phone controls (rate, pause, Doppler on/off, scale).

Rough total: 8–9 working days. The two risks are the stencil/deformation
agreement across passes (mitigated by the single injected chunk) and the fused
heart wall needing an inner/outer vertex tag for realistic thickening
(pipeline work, and the reason the wall was fused as one mesh is also why it
needs the tag).

---

# Part C — a cheaper, more robust way to make the cross-section

Everything above assumes the current machinery: triangle meshes, stencil
capping, mesh repair so the stencil parity balances, a separate bone-mask pass
for shadows. That machinery is the source of most of the project's hard bugs
(leaky sheets, the heart painting into a pelvic view, seven passes per organ)
and it makes dynamics awkward. Stepping back, the cross-section does not need
to come from the meshes at all.

## The label-volume panel

Represent the anatomy once, offline, as a **labelled voxel volume**: one byte
per voxel naming the tissue class. A 1.5 mm grid over the trunk is about
270 × 200 × 470 voxels ≈ 25 MB raw and compresses to a few MB because labels
are long runs; a 2 mm grid is 10 MB raw. Upload it as a WebGL2 `sampler3D`
(`THREE.Data3DTexture`).

The whole 2D panel then becomes **one quad with one fragment shader**: each
panel pixel maps to a point on the scan plane (the inverse of `Panel2D._map`),
that point maps to a voxel, the voxel's label maps to a grey. Acoustic shadow
is the same shader marching toward the apex through the volume and stopping at
the bone label — the bone-mask render target, its camera and its composite
disappear. Cost: ~315k fragments × (1 + ~64) texture fetches per frame, far
below today's 436k triangles × up to seven passes, and independent of how many
organs there are or how clean their surfaces are.

What it fixes, in the order it matters:

1. **No watertightness requirement.** Voxelisation tolerates leaky meshes
   (fill by ray parity per axis and vote, then a morphological close), so the
   repair tiers, the wall-thickness-capped remesh, the 1M-triangle muscle
   intermediates and the "STILL LEAKY" lines all stop being load-bearing. Thin
   sheets (intercostals, valves) render exactly, at voxel resolution.
2. **No stencil, no caps, no bleed, no bounding-box guard.** The 3D cut face is
   the same quad drawn in the 3D scene at the scan plane with the same shader
   (colour palette instead of greys); the meshes are merely clipped on one
   side. The two views cannot disagree because they sample one volume at one
   plane.
3. **Dynamics become a coordinate warp.** A beating heart is `sample(p − d(p, φ))`
   in the shader, Doppler is a per-label kind lookup; Part B's hardest
   constraint (identical deformation across seven passes) vanishes.
4. **The pelvis is already a volume.** The Visible Korean data *is* a label
   stack; `kvh_pelvis.py` would export it directly, with no remesh, no tubes,
   no lumen derivation, and the ureters under a millimetre across survive.

What stays as meshes: the 3D surfaces (BodyParts3D meshes as now, or marching
cubes from the same volume so the silhouette and the cut agree exactly), the
skin raycast, the probe and beam.

Accuracy: a 1.5 mm voxel is coarser than a mesh edge but finer than anything a
curvilinear probe resolves at depth, and label boundaries can be smoothed in
the shader by sampling the eight neighbours and blending at the 50% crossing.
If sub-voxel edges ever matter, store a per-organ signed-distance grid in the
organ's own bounding box (liver ≈ 170 KB at 3 mm) and refine the boundary from
the label lookup — trilinear distance gives smooth surfaces at a quarter of the
memory of a fine label grid.

## Procedural anatomy

A fully procedural body (superquadrics and metaballs for organs, swept tubes
for vessels, all defined by a few dozen parameters) would be the cheapest
possible representation and trivially animatable, and it is what the
`primitives` set already is. It is not more accurate — the shapes a learner
has to recognise (the liver's segments, the kidney's hilum, the heart's
chambers) are exactly what parameters cannot capture — so it stays the capping
reference and a fallback, not the product. The useful procedural piece is
smaller: generate the *volume* from the meshes rather than the meshes from the
volume, and generate vessels as tubes from centrelines (as `kvh_repair.py`
now does for the ureters), which is both cheaper and more accurate than
repairing a scanned tube.

## Status (2026-10-01): prototype shipped behind the Engine chip

`pipeline/voxelize.py` voxelises a shipped GLB by casting one ray per (x, y)
column and filling runs between entering and exiting crossings; the whole
BodyParts3D model takes six seconds; the shipped 1.5 mm volume is 0.57 MB
gzipped (19.6 MB raw) against the 2.3 MB GLB, and a 2 mm one is 0.29 MB. `clients/viewer/src/volume.js` draws
the panel as one quad and the 3D cut face as a quad riding the probe, from
one shared fragment shader with the shadow march in it. Measured on the
same machine, mode 2, per frame with `gl.finish()`: mesh engine 9–12 ms,
volume engine 3–4 ms at 2 mm and ~7 ms at 1.5 mm. The Muscles toggle is
honoured in the shader.

What is still open before it can replace the mesh engine: edge quality
(voxel stair-steps are visible even at 1.5 mm; sub-voxel edges want the
per-organ distance-field refinement above), and the preset sweep has only
been run on the mesh engine.

## Plan for finishing the volume engine (≈ 3 days) — NOT STARTED

1. **Sub-voxel edges** (1½ days). Per organ, a signed-distance grid in the
   organ's own bounding box at 3 mm (`pipeline/voxelize.py --sdf`, computed
   from the same ray casts: distance to the nearest surface crossing along
   the three axes, then a Euclidean distance transform in numpy), packed
   into one 3D texture atlas with a per-label offset table. In the shader:
   look up the label as now, then refine the boundary by sampling the
   organ's SDF with trilinear filtering and treating the 0 crossing as the
   edge; where two labels meet, the one with the smaller distance wins.
   Acceptance: the mesh and volume panels agree to within one voxel on the
   organ silhouettes on all eight windows, measured as the symmetric
   difference of each organ's pixel mask.
2. **Re-run the window sweep on the volume engine** (½ day) with the id-grey
   harness from `torso.js`; keep the mesh engine's values unless a window
   moves by more than 0.02 in u or v, and record both.
3. **Retire capping** (1 day). Make Volume the default engine, keep Mesh
   selectable for one release, then delete `capping.js`, the stencil
   layers, the bone-mask pass and the repair tiers in the pipeline
   (`bodyparts3d.py` keeps weld + decimate + the heart fuse; `pipeline.py`
   shrinks to the lumen derivation). The pelvis pipeline stops needing
   `kvh_repair.py`'s tubes once the volume comes from the slice stack.
4. **Pelvis straight from the slices** (½ day, when the stack is available):
   `kvh_pelvis.py --volume` writes the label volume directly from the
   segmented BMPs at 1 mm, bypassing every mesh step.

## Plan for Part B on the volume engine — NOT STARTED

Everything in Part B above holds, with these substitutions once the volume
engine is the renderer:

- Deformation is `sample(p − d(p, φ))` in `volume.js`'s `labelAtWorld`,
  with `d` the heart field from §2 evaluated in world space. One place, both
  views, no stencil bookkeeping, no bounding-box inflation.
- The 3D surfaces still deform through `onBeforeCompile` on the mesh
  materials (forward field); the small inconsistency between forward and
  backward mapping is below a voxel at the amplitudes in §2.
- Doppler needs no per-fragment flow lookup machinery beyond what the
  label gives: `dynamics.json` carries a flow direction per label (or per
  centreline bin for long vessels, as a second small 3D texture of
  direction ids), and the colour-box shader samples it where it samples the
  label.
- Order: §1 clock and §2 heart (2 days), §4 pipeline data (1 day), §3
  vessels (1 day), §5 colour then PW Doppler (3–4 days), re-tune cardiac
  windows at φ = 0 (½ day). Roughly 8 days, the same as before; the saving
  is in risk, not calendar.

## Engine selector

If Part C holds up, both engines ship for a while behind an **Engine** chip in
the model picker (Mesh · Volume), echoed in the `state` frame like the model
is, with the same eight windows and the same panel dressing, so a learner can
flip between them on the same frozen plane and the difference is only what the
renderer does. The mesh engine is retired once the volume engine has passed
the same pixel checks on every window on both models.

---

# Part D — later: motion and pathology in the image

Requested, not yet designed. Noted here so the volume engine is built with
them in mind.

- **Scintillating bowel gas.** Gas is the one thing in the abdomen that is
  not a geometric cut: a bright, flickering reflector with dirty shadowing
  behind it. On the volume engine it is a label (`gas`) inside the bowel
  lumen whose grey is time-noise above a bright floor, and whose shadow march
  uses a partial, speckled attenuation instead of bone's clean floor. On the
  mesh engine it would be a cap material with the same noise; the shadow is
  the hard part there, which is another argument for the volume.
- **Moving bowel.** Peristalsis as a slow travelling radial wave along each
  bowel segment's centreline (the §4 centreline machinery), with the gas
  pockets moving with it. Amplitude a few millimetres, period ~10 s. Same
  coordinate-warp mechanism as the heart, different clock.
- **Pathologies.** Free fluid in Morison's pouch and the pelvis, a
  pericardial effusion, a distended bladder, hydronephrosis, gallstones with
  shadows, an aortic aneurysm, a pleural effusion. Each is a *variant* of a
  region of the volume, not a new model: a label edit (fluid where there was
  none), a local deformation (dilate the aorta), or an inserted reflector
  (a stone). Variants are authored as small volume patches or mesh edits by
  artists working against the normal model, selected from a "Pathology"
  chip, and echoed in `state` so the phone shows which case is loaded. The
  authoring format and the review step (someone who scans signs off each
  case) have to be decided before artists start.
