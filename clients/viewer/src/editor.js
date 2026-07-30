/**
 * Scene editor — position, rotate and scale the three anatomy groups live.
 *
 * The heart, the abdominal viscera and the skeleton come from three unrelated
 * sources with different scales, proportions and orientations. Reconciling them
 * is an anatomical judgement, not a geometric one, so this exists to let someone
 * who scans set the scene directly instead of having the values guessed at.
 *
 * Opt in with ?edit=1 — it is not part of the product a learner sees.
 *
 * Workflow: adjust, then "Log transforms" and paste the output back into
 * models.js so the arrangement ships baked in.
 */

import * as THREE from 'three';

const DEG = 180 / Math.PI;

const GROUP_LABELS = {
  heart: 'Heart',
  organs: 'Abdominal organs',
  bones: 'Bones / skeleton',
};

/** [min, max, step] per channel. Ranges are generous enough to fix a model that
 *  arrived at the wrong scale entirely, not just to nudge one. */
const CHANNELS = [
  ['posX', 'Move ←→ (L/R)', -0.25, 0.25, 0.001, 'm'],
  ['posY', 'Move ↑↓ (sup/inf)', -0.40, 0.40, 0.001, 'm'],
  ['posZ', 'Move ⊙ (ant/post)', -0.25, 0.25, 0.001, 'm'],
  ['rotX', 'Rotate about L/R axis', -180, 180, 0.5, '°'],
  ['rotY', 'Rotate about sup/inf axis', -180, 180, 0.5, '°'],
  ['rotZ', 'Rotate about ant/post axis', -180, 180, 0.5, '°'],
  ['sclU', 'Scale — uniform', 0.20, 3.00, 0.005, '×'],
  ['sclX', 'Scale X (L/R)', 0.20, 3.00, 0.005, '×'],
  ['sclY', 'Scale Y (sup/inf)', 0.20, 3.00, 0.005, '×'],
  ['sclZ', 'Scale Z (ant/post)', 0.20, 3.00, 0.005, '×'],
];

const read = (g) => ({
  posX: g.position.x, posY: g.position.y, posZ: g.position.z,
  rotX: g.rotation.x * DEG, rotY: g.rotation.y * DEG, rotZ: g.rotation.z * DEG,
  sclX: g.scale.x, sclY: g.scale.y, sclZ: g.scale.z,
  sclU: (g.scale.x + g.scale.y + g.scale.z) / 3,
});

function write(g, key, value) {
  switch (key) {
    case 'posX': g.position.x = value; break;
    case 'posY': g.position.y = value; break;
    case 'posZ': g.position.z = value; break;
    case 'rotX': g.rotation.x = value / DEG; break;
    case 'rotY': g.rotation.y = value / DEG; break;
    case 'rotZ': g.rotation.z = value / DEG; break;
    case 'sclX': g.scale.x = value; break;
    case 'sclY': g.scale.y = value; break;
    case 'sclZ': g.scale.z = value; break;
    // Uniform drives all three at once, which is what "resize in all
    // directions" means; the per-axis sliders then stay available for a model
    // that is distorted rather than merely mis-sized.
    case 'sclU': g.scale.set(value, value, value); break;
  }
  g.updateMatrixWorld(true);
}

/**
 * @param {{GROUPS: Record<string, THREE.Group>, refitTorso: () => void,
 *          organs: () => any[], renderFrame: () => void}} api
 */
export function initEditor(api) {
  if (!new URLSearchParams(location.search).has('edit')) return;

  const root = document.createElement('div');
  root.id = 'editor';
  root.innerHTML = `
    <div class="ed-head">
      <b>Scene editor</b>
      <button id="ed-min" type="button" title="Collapse">–</button>
    </div>
    <div class="ed-body">
      <div id="ed-groups" class="chips"></div>
      <div id="ed-sliders"></div>
      <div class="ed-actions">
        <button id="ed-reset" type="button">Reset group</button>
        <button id="ed-refit" type="button" title="Re-fit the skin shell to the organs">Refit skin</button>
        <button id="ed-log" type="button" class="primary">Log transforms</button>
      </div>
      <div id="ed-measure" class="ed-measure"></div>
      <textarea id="ed-out" rows="9" readonly placeholder="Log transforms writes the values here, ready to paste into models.js"></textarea>
    </div>`;
  document.getElementById('app').appendChild(root);

  let active = 'heart';
  const initial = {};
  for (const [k, g] of Object.entries(api.GROUPS)) initial[k] = read(g);

  const groupsHost = root.querySelector('#ed-groups');
  const slidersHost = root.querySelector('#ed-sliders');
  const out = root.querySelector('#ed-out');
  const measure = root.querySelector('#ed-measure');

  function renderGroups() {
    groupsHost.innerHTML = '';
    for (const [k, label] of Object.entries(GROUP_LABELS)) {
      if (!api.GROUPS[k]) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.className = k === active ? 'on' : '';
      b.addEventListener('click', () => { active = k; renderGroups(); renderSliders(); });
      groupsHost.appendChild(b);
    }
  }

  function renderSliders() {
    const g = api.GROUPS[active];
    const v = read(g);
    slidersHost.innerHTML = '';
    for (const [key, label, min, max, step, unit] of CHANNELS) {
      const row = document.createElement('div');
      row.className = 'ed-row';
      row.innerHTML = `
        <label>${label}</label>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${v[key]}">
        <input type="number" min="${min}" max="${max}" step="${step}" value="${v[key].toFixed(3)}">
        <span class="ed-unit">${unit}</span>`;
      const [range, num] = row.querySelectorAll('input');
      const apply = (val) => {
        const n = Number(val);
        if (!Number.isFinite(n)) return;
        write(api.GROUPS[active], key, n);
        range.value = n;
        num.value = n.toFixed(3);
        // A uniform scale change moves the other three sliders too.
        if (key === 'sclU') renderSliders();
        updateMeasure();
      };
      range.addEventListener('input', (e) => apply(e.target.value));
      num.addEventListener('change', (e) => apply(e.target.value));
      slidersHost.appendChild(row);
    }
    updateMeasure();
  }

  /** Live dimensions, so sizing is judged against real numbers not just by eye. */
  function updateMeasure() {
    const organs = api.organs();
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    let n = 0;
    for (const o of organs) {
      if ((o.group ?? 'organs') !== active) continue;
      o.geometry.computeBoundingBox();
      tmp.copy(o.geometry.boundingBox).applyMatrix4(o.surface.matrixWorld);
      box.union(tmp);
      n++;
    }
    if (!n) { measure.textContent = 'no meshes in this group'; return; }
    const s = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const cm = (x) => (x * 100).toFixed(1);
    measure.textContent =
      `${n} meshes · size ${cm(s.x)} × ${cm(s.y)} × ${cm(s.z)} cm (L/R × sup/inf × ant/post)`
      + ` · centre ${cm(c.x)}, ${cm(c.y)}, ${cm(c.z)} cm`;
  }

  root.querySelector('#ed-reset').addEventListener('click', () => {
    const g = api.GROUPS[active];
    const i = initial[active];
    g.position.set(i.posX, i.posY, i.posZ);
    g.rotation.set(i.rotX / DEG, i.rotY / DEG, i.rotZ / DEG);
    g.scale.set(i.sclX, i.sclY, i.sclZ);
    g.updateMatrixWorld(true);
    renderSliders();
  });

  root.querySelector('#ed-refit').addEventListener('click', () => {
    api.refitTorso();
    updateMeasure();
  });

  root.querySelector('#ed-log').addEventListener('click', () => {
    const lines = ['// Scene editor output — paste into clients/viewer/src/models.js', ''];
    for (const [k, g] of Object.entries(api.GROUPS)) {
      const v = read(g);
      const same = Math.abs(v.sclX - v.sclY) < 1e-6 && Math.abs(v.sclY - v.sclZ) < 1e-6;
      lines.push(`// ${GROUP_LABELS[k] ?? k}`);
      lines.push(`${k}: {`);
      lines.push(`  position: [${v.posX.toFixed(4)}, ${v.posY.toFixed(4)}, ${v.posZ.toFixed(4)}],`);
      lines.push(`  rotationDeg: [${v.rotX.toFixed(2)}, ${v.rotY.toFixed(2)}, ${v.rotZ.toFixed(2)}],`);
      lines.push(same
        ? `  scale: ${v.sclX.toFixed(4)},`
        : `  scale: [${v.sclX.toFixed(4)}, ${v.sclY.toFixed(4)}, ${v.sclZ.toFixed(4)}],`);
      lines.push('},');
      lines.push('');
    }
    const organs = api.organs();
    lines.push('/* measured world sizes, cm (L/R x sup/inf x ant/post):');
    for (const k of Object.keys(api.GROUPS)) {
      const box = new THREE.Box3(); const tmp = new THREE.Box3(); let n = 0;
      for (const o of organs) {
        if ((o.group ?? 'organs') !== k) continue;
        o.geometry.computeBoundingBox();
        tmp.copy(o.geometry.boundingBox).applyMatrix4(o.surface.matrixWorld);
        box.union(tmp); n++;
      }
      if (!n) continue;
      const s = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      const f = (x) => (x * 100).toFixed(1);
      lines.push(`   ${k}: ${f(s.x)} x ${f(s.y)} x ${f(s.z)}  centre ${f(c.x)}, ${f(c.y)}, ${f(c.z)}`);
    }
    lines.push('*/');
    out.value = lines.join('\n');
    out.select();
    console.info(out.value);
  });

  root.querySelector('#ed-min').addEventListener('click', () => {
    root.classList.toggle('collapsed');
  });

  renderGroups();
  renderSliders();
  console.info('[scahn] scene editor active (?edit=1)');
}
