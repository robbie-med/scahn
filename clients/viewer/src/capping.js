/**
 * Stencil-buffer capping. Spec section 6.2 — the part that makes or breaks it.
 *
 * `side: DoubleSide` does NOT produce a solid cross-section: three.js clipping
 * discards fragments, so a clipped liver reads as a bowl, not a slice. The fix
 * is the stencil sequence, per mesh:
 *
 *   1. render back faces, INCREMENT stencil, colour write off
 *   2. render front faces, DECREMENT stencil, colour write off
 *   3. draw a quad on the clipping plane, masked by nonzero stencil
 *   4. CLEAR the stencil buffer
 *
 * Step 4 is per-mesh and is not optional. Skip it and cap colours bleed between
 * adjacent organs, which looks like a random anatomical mess and costs hours to
 * diagnose. It is implemented here via `onAfterRender` on the cap quad, which
 * fires at exactly the right point in the render order.
 *
 * Reference implementation: three.js example `webgl_clipping_stencil`.
 */

import * as THREE from 'three';

const CAP_GEOM = new THREE.PlaneGeometry(1, 1);

/**
 * Render layers. One WebGL context draws both panels, so the two cameras are
 * separated by layer rather than by scene:
 *   layer 0 — the 3D view: surfaces, ghosts, colour caps, fiducials, beam.
 *   layer 1 — the 2D panel: the stencil groups and the GREY caps only.
 * The 2D panel therefore shows cut faces and nothing else, which is what makes
 * it read as an ultrasound screen rather than a small copy of the 3D scene.
 */
export const LAYER_3D = 0;
export const LAYER_2D = 1;

/** Small push toward the camera so coplanar caps (a lumen inside its wall)
 *  resolve deterministically instead of z-fighting. 50 microns. */
const COPLANAR_NUDGE = 5e-5;

/**
 * Ghost pass triangle budget, per mesh.
 *
 * Mode 3 draws a second, transparent copy of every organ, and transparent
 * overdraw is fill-rate bound rather than vertex bound. On the imported abdomen
 * model that took a 12 ms frame to 67 ms — 15 fps, unusable — because 83% of
 * its triangles live in eight meshes: small bowel, large bowel, the heart and
 * the arterial and venous trees.
 *
 * Those are also the meshes that read as visual noise when rendered as
 * translucent context, so excluding them costs almost nothing pedagogically and
 * buys back the frame. The teaching targets (liver, kidneys, spleen, pancreas,
 * gallbladder, bladder, uterus) are all far below this and keep their ghost.
 */
const GHOST_TRI_BUDGET = 8000;

const triangleCount = (geom) =>
  (geom.index ? geom.index.count : geom.attributes.position.count) / 3;

export class CappedOrgan {
  /**
   * @param {{name:string, geometry:THREE.BufferGeometry, color:number,
   *          capColor:number, depthRank:number}} organ
   * @param {THREE.Plane} plane        live clipping plane (mutated each frame)
   * @param {THREE.Plane} ghostPlane   the same plane, negated
   * @param {number} index             for render-order allocation
   */
  constructor(organ, plane, ghostPlane, index) {
    this.name = organ.name;
    /** Classified tissue label, e.g. 'Liver'. Kept so the classification can be
     *  audited at runtime — a keyword classifier fails silently otherwise. */
    this.label = organ.label ?? organ.name;
    this.depthRank = organ.depthRank ?? 1;
    this.index = index;
    this.plane = plane;
    this.geometry = organ.geometry;

    // Any planar cross-section of a mesh lies inside the mesh's bounding
    // sphere, so a quad of side 2r centred on the projection of that sphere's
    // centre is guaranteed to cover the cut face at any angle. 2.2 for margin.
    const bs = organ.geometry.boundingSphere;
    this.capSize = (bs?.radius ?? 0.2) * 2.2;
    this.capCenter = (bs?.center ?? new THREE.Vector3()).clone();

    const base = 10 + index * 4;

    // --- the visible surface -------------------------------------------------
    this.surface = new THREE.Mesh(
      organ.geometry,
      new THREE.MeshStandardMaterial({
        color: organ.color,
        roughness: 0.72,
        metalness: 0.0,
        side: THREE.DoubleSide,
        clippingPlanes: [plane],
        clipShadows: false,
      }),
    );
    this.surface.name = organ.name;
    this.surface.renderOrder = 100 + index;

    // --- stencil pass --------------------------------------------------------
    this.stencilGroup = new THREE.Group();
    this.stencilGroup.name = `${organ.name}-stencil`;
    for (const [side, op] of [
      [THREE.BackSide, THREE.IncrementWrapStencilOp],
      [THREE.FrontSide, THREE.DecrementWrapStencilOp],
    ]) {
      const mat = new THREE.MeshBasicMaterial({
        side,
        depthWrite: false,
        depthTest: false,
        colorWrite: false,
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op,
        clippingPlanes: [plane],
      });
      const m = new THREE.Mesh(organ.geometry, mat);
      m.renderOrder = base;
      m.layers.enable(LAYER_2D); // stencil must be built in BOTH passes
      this.stencilGroup.add(m);
    }

    // --- cap quads -----------------------------------------------------------
    // Two of them over the same stencil: a colour cap for the 3D view and a
    // flat grey one for the 2D panel. Separated by layer, so exactly one draws
    // per pass and each carries its own stencil clear.
    this.cap = this._makeCap(organ.capColor, base + 1, LAYER_3D);
    this.cap.name = `${organ.name}-cap`;
    this.capGrey = this._makeCap(organ.greyColor ?? 0x808080, base + 2, LAYER_2D);
    this.capGrey.name = `${organ.name}-cap2d`;

    // --- ghost pass (Mode 3) -------------------------------------------------
    // Clipped by the INVERTED plane so this draws only the half that the opaque
    // pass discarded. Rendering it with clipping merely disabled would redraw
    // the kept half too, double-compositing it and muddying the cut face.
    this.ghost = new THREE.Mesh(
      organ.geometry,
      new THREE.MeshStandardMaterial({
        color: organ.color,
        roughness: 0.9,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        side: THREE.DoubleSide,
        clippingPlanes: [ghostPlane],
      }),
    );
    this.ghost.name = `${organ.name}-ghost`;
    this.ghost.renderOrder = 700 + index;
    this.ghost.visible = false;
    this.ghostEligible = triangleCount(organ.geometry) <= GHOST_TRI_BUDGET;

    this.stencilGroup.visible = false;
    this.cap.visible = false;
    this.capGrey.visible = false;
  }

  /**
   * A quad that paints wherever the stencil is nonzero — i.e. wherever the
   * clipped mesh has interior between the camera and the plane.
   *
   * The 2D cap is unlit: "flat per-organ greys" means flat. Shading a cut face
   * would imply surface relief that a geometric cross-section does not have.
   */
  _makeCap(color, renderOrder, layer) {
    const common = {
      color,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    };
    const material = layer === LAYER_2D
      ? new THREE.MeshBasicMaterial(common)
      : new THREE.MeshStandardMaterial({ ...common, roughness: 0.85, metalness: 0.0 });

    const mesh = new THREE.Mesh(CAP_GEOM, material);
    mesh.renderOrder = renderOrder;
    mesh.layers.set(layer);
    // Per-mesh stencil clear. Do not remove — without it, cap colours bleed
    // across adjacent organs.
    mesh.onAfterRender = (renderer) => renderer.clearStencil();
    return mesh;
  }

  addTo(scene) {
    scene.add(this.stencilGroup, this.cap, this.capGrey, this.surface, this.ghost);
    return this;
  }

  /** Re-seat the cap quad on the plane. Must run before every render pass,
   *  once per camera, because the coplanar nudge is camera-relative. */
  update(camera) {
    this._pos ??= new THREE.Vector3();
    this._look ??= new THREE.Vector3();
    this._toCam ??= new THREE.Vector3();

    // Centre the quad on THIS organ, not on the plane's closest point to the
    // world origin — otherwise anything far off-centre (a flank kidney, the
    // heart) drifts off the edge of its own cap and stops being capped at all.
    this.plane.projectPoint(this.capCenter, this._pos);
    this._look.copy(this._pos).add(this.plane.normal);

    // Every cap quad lies on the same plane, so without a per-organ offset the
    // solid organs all sit at *identical* depth and z-fight wherever they
    // overlap on screen — which reads as speckle that crawls as the probe
    // moves, worst in the abdomen where bowel and vessels overlap everything.
    //
    // The rank keeps lumens ahead of their enclosing wall (a chamber must win
    // against its myocardium); the index fraction then breaks ties between
    // organs of equal rank deterministically. Total spread stays under 150
    // microns, far below anything visible at organ scale but well above depth
    // buffer precision.
    this._toCam.copy(camera.position).sub(this._pos).normalize();
    const rank = this.depthRank + this.index / 64;
    this._pos.addScaledVector(this._toCam, COPLANAR_NUDGE * rank);

    for (const cap of [this.cap, this.capGrey]) {
      cap.position.copy(this._pos);
      cap.lookAt(this._look); // aligns the quad's +Z with the plane normal
      cap.scale.setScalar(this.capSize);
      cap.updateMatrixWorld();
    }
  }

  /** @param {1|2|3} mode */
  setMode(mode) {
    const clipping = mode !== 1;
    const mat = this.surface.material;
    const want = clipping ? [this.plane] : null;
    if (mat.clippingPlanes !== want) {
      mat.clippingPlanes = want;
      // Plane count is a shader define; the program must be rebuilt.
      mat.needsUpdate = true;
    }
    // Always on: the 2D pass needs the stencil built even in Mode 1, and these
    // meshes write neither colour nor depth, so leaving them enabled costs a
    // draw call and disturbs nothing. In Mode 1's 3D pass they scribble on a
    // stencil buffer that no cap reads, and each pass starts with a clear.
    this.stencilGroup.visible = true;
    this.cap.visible = clipping;
    // The 2D panel is always a cross-section, even while the 3D view is in
    // Mode 1 — the side-by-side mapping is the whole pedagogical payload, so
    // the panel must never go blank just because the 3D view is uncut.
    this.capGrey.visible = true;
    this.ghost.visible = mode === 3 && this.ghostEligible;
  }

  /** Remove from the scene and release everything. Switching anatomy models
   *  rebuilds every organ, so leaking here would cost tens of MB of GPU memory
   *  per toggle. `disposeGeometry` is false for the primitive set, whose
   *  geometry is owned by the builder and reused. */
  dispose(scene, disposeGeometry = true) {
    if (scene) {
      scene.remove(this.stencilGroup, this.cap, this.capGrey, this.surface, this.ghost);
    }
    this.surface.material.dispose();
    this.cap.material.dispose();
    this.capGrey.material.dispose();
    this.ghost.material.dispose();
    for (const m of this.stencilGroup.children) m.material.dispose();
    if (disposeGeometry) this.geometry.dispose();
  }
}

/**
 * Derive the scan plane from the probe's world transform.
 *
 * Always via setFromNormalAndCoplanarPoint — never by assigning `.constant`.
 * three.js defines the plane as `normal . x + constant = 0`, so a hand-rolled
 * constant must be -P.n, and the failure mode of getting that sign backwards is
 * a plane offset by twice the probe's distance from the origin. That reads as a
 * positioning bug, not a maths bug, and eats an afternoon.
 *
 * @param {THREE.Object3D} probe
 * @param {THREE.Plane} plane   mutated in place
 * @param {THREE.Plane} ghost   mutated in place, the negation of `plane`
 * @param {boolean} invert      debug toggle for which half is kept
 */
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

export function updateScanPlane(probe, plane, ghost, invert = false) {
  probe.updateMatrixWorld();
  // Scan-plane normal is the probe's local +Z (CONVENTIONS.md §7).
  _n.set(0, 0, 1).applyQuaternion(probe.getWorldQuaternion(new THREE.Quaternion()));
  if (invert) _n.negate();
  probe.getWorldPosition(_p);

  plane.setFromNormalAndCoplanarPoint(_n, _p);
  ghost.copy(plane).negate();
}
