# CONVENTIONS.md — coordinate basis and orientation contract

> **Read this before touching any geometry, camera, or import code.**
>
> A silent mirror flip in an ultrasound teaching tool teaches the wrong thing
> convincingly. This file is the single authority on handedness. If code and this
> file disagree, the code is wrong until proven otherwise in this file.

## 1. Scene basis

Right-handed, Y-up (glTF compatible).

| Axis | Direction | Anatomical term |
|---|---|---|
| **+X** | patient's **left** | sinister |
| **+Y** | **superior** (toward head) | cranial |
| **+Z** | **anterior** (out of the chest) | ventral |

Handedness check: `X × Y = Z`, i.e. `left × superior = anterior`. This holds for a
right-handed basis and is asserted at runtime in `clients/viewer/src/scene.js`
(`assertHandedness()`), which throws on mismatch rather than rendering something
plausible-but-mirrored.

**Units: meters.** The torso spans ~0.6 m superior-inferior. Do not author anything
in centimeters and scale it later; convert at import.

## 2. Camera convention

The default viewer camera sits on **+Z** looking toward the origin, with **+Y up**.

That places the patient's left (**+X**) on the **viewer's right** — matching
radiological convention for axial images, where you view the patient from the foot
of the bed and their left appears on your right.

## 3. The `L` fiducial — do not remove

A distinctly colored marker (magenta) is fixed to the patient's **left flank** at
approximately `(+0.17, 0.0, 0.0)`, with a text label reading `L`. It renders in
**all modes** and is deliberately excluded from clipping.

**This is a permanent test instrument, not scaffolding.** If that marker ever appears
on the wrong side of the 2D panel relative to the 3D view, the pipeline is mirrored
and every downstream anatomical claim the tool makes is false.

A persistent axis triad renders at the origin alongside it: X red, Y green, Z blue.

## 4. Probe frame

The probe's **beam axis is its local −Y**, pointing into the patient.

The probe's local **+X is the transducer's orientation marker side** — the physical
notch/ridge/light on a real transducer. On the 2D panel, structures on the probe's
local +X side appear on the side of the panel where the orientation marker dot is
drawn (upper-left corner, mirroring real machine convention).

Placement is compositional, and the order matters:

```
probeWorld = surfaceFrame(u, v) · recenteredSensorQuaternion
```

`surfaceFrame(u,v)` positions the probe at a point on the torso shell and aligns its
local −Y to the **inward** surface normal. The streamed quaternion is then applied
*relative to that frame*, so phone rotation means "rotate the probe on the skin",
not "set the probe's absolute world orientation".

## 5. Source-asset correction — apply once, at import

BodyParts3D / Z-Anatomy source data does **not** match this basis. BodyParts3D is
Z-up with +Y posterior, in millimeters.

The correction is a **single named transform applied once**, in the Blender pipeline
at import time:

- `pipeline/bodyparts3d.py` → `SOURCE_TO_SCAHN`

It covers axis rotation, mm→m, and the superior-inferior recentring: BP3D is
authored with its origin at the feet, and the scene expects the torso centred on
the origin (the shell fit pins `yCenter` to 0).

**Never scatter axis fixes through runtime code.** If an organ loads mirrored, fix
`SOURCE_TO_SCAHN` and rebuild the GLB. Do not add a compensating flip in the viewer.
A second correction in a second place is how a pipeline ends up mirrored in only
some modes.

## 6. Quaternion conventions

- Wire format is **XYZW** order (three.js convention), as an array of 4 numbers.
- **Only quaternions cross the wire. Never Euler angles.** Euler over a socket
  gimbal-locks at exactly the steep angles a subxiphoid view requires.
- Euler angles exist in exactly one place: converting iOS `deviceorientation`
  alpha/beta/gamma to a quaternion, **on the phone**, in
  `clients/phone/src/orientation.js`. That conversion uses intrinsic `YXZ`
  composition plus a −90° X correction plus a screen-orientation twist. It is
  copied from three.js's deprecated `DeviceOrientationControls`. Do not "simplify"
  it.

## 7. Clipping plane convention

three.js defines a plane as `normal · x + constant = 0`, so a hand-computed constant
must be `−P·n`.

**Always use `Plane.setFromNormalAndCoplanarPoint(normal, probeWorldPosition)`.**
Never assign `.constant` by hand. The failure mode of a sign error is a plane offset
by *twice* the probe's distance from the origin, which reads as a positioning bug
and costs hours to find.

The kept half-space is the one the plane normal points **away** from. The clipping
normal is the probe's beam-plane normal, i.e. probe local **+Z** in world space.
