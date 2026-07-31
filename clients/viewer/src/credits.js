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
    usedKo: '심장의 방과 판막을 포함한 해부 구조, 탐촉자가 따라 움직이는 피부 표면, '
          + '그리고 근육층 대부분에 사용했습니다. Blender 자산 파이프라인에서 복구 후 '
          + 'Draco 압축 GLB로 다시 내보냈습니다.',
    noteKo: '출처 표시가 필요하며 2차 저작물이 허용됩니다. 원본 OBJ 파일 헤더에는 아직 '
          + '2025년 이전 라이선스인 CC BY-SA 2.1 Japan이 적혀 있습니다. 데이터베이스 '
          + 'README(2025-02-25 갱신)에서 CC BY 4.0으로 재라이선스되었고, 이 프로젝트는 '
          + '그 허가에 근거합니다.',
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
    usedKo: 'BodyParts3D에 없는 다섯 개의 근육 — 복직근, 내복사근, 복횡근, 광배근, '
          + '요방형근 — 즉 학습자가 실제로 통과해 스캔하는 복벽에 사용했습니다.',
    noteKo: '동일조건변경허락(ShareAlike). 이 메시들이 하나의 배포 모델 안에서 '
          + 'BodyParts3D 지오메트리와 결합되므로, 결과물은 CC BY-SA 4.0으로 배포되는 '
          + '결합 저작물이 됩니다. Z-Anatomy 자체도 BodyParts3D에서 파생되었습니다.',
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
    hKo: '휴대폰은 센서일 뿐입니다',
    pKo: '휴대폰은 기기의 방향을 읽어 단말기에서 사원수(quaternion)로 변환한 뒤 30Hz로 전송합니다. 오일러 각이 아니라 사원수를 쓰는 이유는, 오일러 각이 검상돌기하 단면에 필요한 바로 그 가파른 각도에서 짐벌 락에 걸리기 때문입니다. 중심 재설정도 휴대폰에서 처리합니다. 침대나 금속 가구, 모니터 근처에서는 지자기 방위가 크게 흔들리기 때문입니다.',
  },
  {
    h: 'Pairing',
    p: 'The display asks the relay for a room and shows a QR code. The phone '
     + 'scans it with the native camera app, so the only permission prompt is the '
     + 'motion one. Several phones can join a room but exactly one drives at a '
     + 'time, and control is handed over explicitly — so you can demonstrate a '
     + 'window, pass it to a learner, and take it back without re-pairing.',
    hKo: '페어링',
    pKo: '디스플레이가 릴레이에 방을 요청하고 QR 코드를 표시합니다. 휴대폰은 기본 카메라 앱으로 이를 스캔하므로 권한 요청은 모션 하나뿐입니다. 여러 대의 휴대폰이 한 방에 참여할 수 있지만 조작은 한 번에 한 대만 가능하며, 제어권은 명시적으로 넘깁니다. 그래서 술기를 시연하고 학습자에게 넘겼다가 다시 가져오는 동안 재페어링이 필요 없습니다.',
  },
  {
    h: 'Placing the probe',
    p: 'The probe is constrained to slide on the skin surface, so phone rotation '
     + 'means "rotate the probe on the body" rather than "set its absolute '
     + 'orientation". You can slide it with the touch pad, or physically move the '
     + 'phone through space — hold the Move button, move, release. Releasing '
     + 're-anchors, like lifting a mouse.',
    hKo: '탐촉자 배치',
    pKo: '탐촉자는 피부 표면 위를 미끄러지도록 제한됩니다. 따라서 휴대폰을 회전하면 "절대 방향을 설정"하는 것이 아니라 "몸 위에서 탐촉자를 돌리는" 동작이 됩니다. 터치 패드로 밀거나, 휴대폰을 실제로 공간에서 움직일 수도 있습니다 — 이동 버튼을 누른 채 움직이고 놓으면 됩니다. 손을 떼면 마우스를 들었다 놓는 것처럼 기준점이 다시 잡힙니다.',
  },
  {
    h: 'How the cross-section is made',
    p: 'The probe defines a plane. Each organ is clipped by it, and the open '
     + 'interior is filled using the stencil buffer: back faces increment, front '
     + 'faces decrement, and a quad on the plane paints wherever the count is '
     + 'nonzero. Without that a cut organ renders as a hollow bowl rather than a '
     + 'solid face. The 2D panel is a second, orthographic camera looking down '
     + 'the plane normal at the same geometry, so the two views cannot disagree.',
    hKo: '단면이 만들어지는 방식',
    pKo: '탐촉자가 평면을 정의합니다. 각 장기는 그 평면으로 잘리고, 열린 내부는 스텐실 버퍼로 채웁니다. 뒷면은 카운트를 올리고 앞면은 내린 뒤, 카운트가 0이 아닌 곳에 평면 위의 사각형을 칠하는 방식입니다.',
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
    hKo: '뼈와 음향 음영',
    pKo: '피질골은 빔의 대부분을 반사합니다. 그래서 뼈의 앞면은 화면에서 가장 밝게 나타나고, 그 뒤쪽은 음영이 됩니다.',
  },
  {
    h: 'What this is not',
    p: 'There is no acoustic simulation. The 2D panel is a geometric '
     + 'cross-section with a flat grey assigned per tissue — no speckle, '
     + 'attenuation, artifact or shadowing. Fluid-filled structures are drawn '
     + 'near-black because anechoic blood, bile and urine is the one convention '
     + 'every learner expects, not because anything is being modelled.',
    hKo: '이 도구가 아닌 것',
    pKo: '음향 시뮬레이션이 아닙니다. 2D 패널은 장기별로 정해진 균일한 회색값을 가진 기하학적 단면이며, 실제 B-모드 영상이 아닙니다.',
  },
];
