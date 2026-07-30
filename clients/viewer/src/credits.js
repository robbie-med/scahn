/**
 * Attribution and the how-it-works text.
 *
 * Every entry below is taken from metadata embedded in the asset file itself
 * (`asset.extras` in the GLB) or from the source archive, not from memory or
 * from a search. Where a file carries no metadata the licence is recorded as
 * UNKNOWN rather than guessed — a wrong attribution is worse than an absent
 * one, and spec section 11 asks that terms be verified at the source rather
 * than trusted from a summary.
 *
 * `status` drives the warning banner in the panel:
 *   'ok'      cleared for publication as used here
 *   'review'  a licence term conflicts with how the asset is being used
 *   'unknown' provenance not established
 */

export const MODELS_CREDITS = [
  {
    title: 'BodyParts3D (full body)',
    author: 'The Database Center for Life Science',
    source: 'https://dbarchive.biosciencedbc.jp/en/bodyparts3d/download.html',
    licence: 'CC BY 4.0',
    licenceUrl: 'http://creativecommons.org/licenses/by/4.0/',
    used: 'The anatomy, including the cardiac chambers and valves, the skin '
        + 'surface the probe rides on, and most of the muscle layer. Repaired '
        + 'and re-exported as a Draco-compressed GLB by the Blender asset '
        + 'pipeline.',
    status: 'ok',
    note: 'Attribution required; derivatives permitted. Note the raw OBJ files '
        + 'still carry a header naming CC BY-SA 2.1 Japan: that is the pre-2025 '
        + 'licence. The database README (updated 2025-02-25) relicensed it to '
        + 'CC BY 4.0, which is the grant relied on here.',
  },
  {
    title: 'Z-Anatomy',
    author: 'Gauthier Kervyn and contributors',
    source: 'https://www.z-anatomy.com/',
    licence: 'CC BY-SA 4.0',
    licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    used: 'Five muscles absent from BodyParts3D: rectus abdominis, internal '
        + 'oblique, transversus abdominis, latissimus dorsi and quadratus '
        + 'lumborum — the abdominal wall a learner scans through.',
    status: 'ok',
    note: 'ShareAlike. Because these meshes are combined with the BodyParts3D '
        + 'geometry in a single shipped model, the resulting model is a '
        + 'combined work distributed under CC BY-SA 4.0. Z-Anatomy is itself '
        + 'derived from BodyParts3D.',
  },
];

export const TOOLS_CREDITS = [
  { name: 'three.js', licence: 'MIT', url: 'https://threejs.org', used: 'WebGL rendering, clipping and stencil capping.' },
  { name: 'Draco', licence: 'Apache 2.0', url: 'https://google.github.io/draco/', used: 'Mesh compression; decoder runs in the browser.' },
  { name: 'Blender', licence: 'GPL', url: 'https://www.blender.org', used: 'Headless asset repair pipeline. Not redistributed.' },
  { name: 'Vite', licence: 'MIT', url: 'https://vite.dev', used: 'Build tooling for both clients.' },
  { name: 'Cloudflare Workers + Durable Objects', licence: 'Service', url: 'https://developers.cloudflare.com/durable-objects/', used: 'Room pairing and the WebSocket relay; one Durable Object per room.' },
  { name: 'ws', licence: 'MIT', url: 'https://github.com/websockets/ws', used: 'WebSocket server in the offline development relay.' },
  { name: 'qrcode-generator', licence: 'MIT', url: 'https://github.com/kazuhikoarase/qrcode-generator', used: 'Pairing QR code.' },
];

export const HOW_IT_WORKS = [
  {
    h: 'The phone is only a sensor',
    p: 'It reads device orientation, converts it to a quaternion on the handset, '
     + 'and streams it at 30 Hz. Quaternions rather than Euler angles, because '
     + 'Euler angles gimbal-lock at exactly the steep angles a subxiphoid view '
     + 'needs. Recentring is on the phone too, since magnetometer heading drifts '
     + 'badly near beds, metal furniture and monitors.',
  },
  {
    h: 'Pairing',
    p: 'The display asks the relay for a room and shows a QR code. The phone '
     + 'scans it with the native camera app, so the only permission prompt is the '
     + 'motion one. Several phones can join a room but exactly one drives at a '
     + 'time, and control is handed over explicitly — so you can demonstrate a '
     + 'window, pass it to a learner, and take it back without re-pairing.',
  },
  {
    h: 'Placing the probe',
    p: 'The probe is constrained to slide on the skin surface, so phone rotation '
     + 'means "rotate the probe on the body" rather than "set its absolute '
     + 'orientation". You can slide it with the touch pad, or physically move the '
     + 'phone through space — hold the Move button, move, release. Releasing '
     + 're-anchors, like lifting a mouse.',
  },
  {
    h: 'How the cross-section is made',
    p: 'The probe defines a plane. Each organ is clipped by it, and the open '
     + 'interior is filled using the stencil buffer: back faces increment, front '
     + 'faces decrement, and a quad on the plane paints wherever the count is '
     + 'nonzero. Without that a cut organ renders as a hollow bowl rather than a '
     + 'solid face. The 2D panel is a second, orthographic camera looking down '
     + 'the plane normal at the same geometry, so the two views cannot disagree.',
  },
  {
    h: 'Bone and acoustic shadowing',
    p: 'Bone behaves the way it does on a real machine: the near cortical '
     + 'surface is the brightest thing in the image and everything deep to it '
     + 'is shadow, because bone reflects nearly the whole beam. This is the one '
     + 'acoustic effect the tool simulates, and it is here because rib shadows '
     + 'are the reason the cardiac and right upper quadrant windows sit where '
     + 'they do. Slide onto a rib and the image disappears; slide into the '
     + 'interspace and it returns.',
  },
  {
    h: 'What this is not',
    p: 'There is no acoustic simulation. The 2D panel is a geometric '
     + 'cross-section with a flat grey assigned per tissue — no speckle, '
     + 'attenuation, artifact or shadowing. Fluid-filled structures are drawn '
     + 'near-black because anechoic blood, bile and urine is the one convention '
     + 'every learner expects, not because anything is being modelled.',
  },
];
