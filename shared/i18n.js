/**
 * Bilingual string catalogue and language state — Korean and English.
 *
 * Lives in `shared` rather than in either client because the window names, the
 * transducer names and the imaging modes are part of the wire vocabulary: the
 * phone shows the window it is selecting and the viewer shows the window it is
 * displaying, and those two must never disagree about what a window is called
 * in either language.
 *
 * Imported as `@scahn/protocol/i18n`. Kept in its own module so the Worker and
 * the Node relay, which import `@scahn/protocol` but have no DOM, never pull in
 * the browser-only helpers at the bottom.
 *
 * Translation notes, since a wrong term here teaches the wrong word:
 *   - The window names use the standard Korean clinical terms
 *     (흉골연 장축 for parasternal long axis, 검상돌기하 for subxiphoid), not
 *     transliterations of the English.
 *   - Licence names, the required CC attribution strings and author names are
 *     NOT translated anywhere. Attribution is a licence obligation to reproduce
 *     a specific string, so translating it would break the grant being relied on.
 */

export const LANGS = Object.freeze({
  en: 'EN',
  ko: '한국어',
  fr: 'FR',
  zh: '中文',
  ru: 'RU',
});

const STORAGE_KEY = 'scahn.lang';

const STRINGS = Object.freeze({
  en: {
    'lang.switch': 'Language',

    // --- windows -----------------------------------------------------------
    'preset.subxiphoid': 'Subxiphoid',
    'preset.parasternal-long': 'Parasternal Long Axis',
    'preset.parasternal-short': 'Parasternal Short Axis',
    'preset.apical-four-chamber': 'Apical 4-Chamber',
    'preset.ruq-morison': "RUQ / Morison's Pouch",
    'preset.luq-splenorenal': 'LUQ / Splenorenal',
    'preset.suprapubic': 'Suprapubic',
    'preset.aorta-transverse': 'Aorta (Transverse)',

    // --- transducers and modes --------------------------------------------
    'probe.curvilinear': 'Curvilinear',
    'probe.phased': 'Phased array',
    'probe.linear': 'Linear',
    'mode.short.1': '1 · Ray',
    'mode.short.2': '2 · Cut',
    'mode.short.3': '3 · Ghost',
    'mode.1': 'Mode 1 — Ray',
    'mode.2': 'Mode 2 — Cut',
    'mode.3': 'Mode 3 — Ghost',

    // --- organ labels ------------------------------------------------------
    'organ.Bone': 'Bone',
    'organ.Muscle': 'Muscle',
    'organ.Gallbladder lumen': 'Gallbladder lumen',
    'organ.Bladder lumen': 'Bladder lumen',
    'organ.Gallbladder wall': 'Gallbladder wall',
    'organ.Bladder wall': 'Bladder wall',
    'organ.Cardiac chamber': 'Cardiac chamber',
    'organ.Valve': 'Valve',
    'organ.Heart': 'Heart',
    'organ.Liver': 'Liver',
    'organ.Spleen': 'Spleen',
    'organ.Kidney': 'Kidney',
    'organ.Adrenal': 'Adrenal',
    'organ.Pancreas': 'Pancreas',
    'organ.Uterus': 'Uterus',
    'organ.Ovary': 'Ovary',
    'organ.Ureter': 'Ureter',
    'organ.Artery': 'Artery',
    'organ.Vein': 'Vein',
    'organ.Bowel': 'Bowel',
    'organ.Airway': 'Airway',
    'organ.Tissue': 'Tissue',

    // --- viewer ------------------------------------------------------------
    'viewer.title': 'Scahn — Viewer',
    'viewer.muscles': 'Muscles',
    'viewer.musclesTitle': 'Show the body-wall muscle layer',
    'viewer.noWindow': 'No window',
    'viewer.freePlacement': 'Free placement',
    'viewer.prealphaBold': 'Pre-alpha — not anatomically accurate.',
    'viewer.prealpha': 'Organ shapes and positions are for practising probe '
      + 'placement, not for diagnosis.',
    'viewer.aboutTitle': 'About Scahn, credits and licences',
    'viewer.scanQr': "Scan this with your phone's camera app.",
    'viewer.orOpen': 'Or open',
    'viewer.andType': 'and type the code.',
    'viewer.prealphaBody': 'Organ shapes and positions are geometric placeholders '
      + 'for testing probe handling only. Do not use for anatomy or clinical '
      + 'instruction.',
    'viewer.invertClip': 'Invert clip side',
    'viewer.beamSector': 'Beam sector',
    'viewer.debug': 'Debug',
    'viewer.smoothing': 'Smoothing',
    'viewer.moveGain': 'Move gain',
    'viewer.waitingPhone': 'Waiting for a phone…',
    'viewer.driving': 'driving',
    'viewer.loading': 'Loading {model}…',
    'viewer.loadingPct': 'Loading {model}… {pct}%',
    'viewer.loadFailed': 'Could not load {model}. Still showing {current}.',
    'viewer.model.primitives': 'Primitives',
    'viewer.model.bodyparts3d': 'BodyParts3D',

    // --- phone -------------------------------------------------------------
    'phone.title': 'Scahn — Probe',
    'phone.tagline': 'Your phone becomes the ultrasound probe.',
    'phone.prealpha': 'Pre-alpha.',
    'phone.roomCode': 'Room code',
    'phone.connect': 'Connect & enable motion',
    'phone.viewingOnly': 'Viewing only',
    'phone.youAreDriving': 'You are driving',
    'phone.recenter': 'Recenter',
    'phone.takeControl': 'Take control',
    'phone.placement': 'Placement',
    'phone.dragHint': 'Drag to slide the probe on the skin.',
    'phone.drag': 'drag',
    'phone.dragPad': 'Drag pad',
    'phone.moveInSpace': 'Move in space',
    'phone.holdMove': 'Hold & move the phone',
    'phone.window': 'Window',
    'phone.transducer': 'Transducer',
    'phone.depth': 'Depth',
    'phone.viewMode': 'View mode',
    'phone.enterCode': 'Enter the six-digit code shown on the display.',
    'phone.httpsRequired': 'This page must be served over HTTPS for motion '
      + 'access. Open the tunnelled URL, not a LAN address.',
    'phone.requestingMotion': 'Requesting motion access…',
    'phone.motionUnavailable': 'Physical movement unavailable on this device — '
      + 'use the drag pad.',
    'phone.motionFailed': 'Could not start motion sensors.',
    'phone.recentred': 'Recentred.',

    // --- about -------------------------------------------------------------
    'about.intro': 'A teaching tool for ultrasound scanning technique. A phone '
      + 'acts as the probe; this screen shows the anatomy being cut and the '
      + 'cross-section that cut corresponds to, side by side.',
    'about.how': 'How it works',
    'about.models': 'Models',
    'about.tools': 'Tools and libraries',
    'about.by': 'by',
    'about.prealphaWarn': 'Pre-alpha.',
    'about.prealphaWarnBody': 'Organ shapes and positions are approximate, window '
      + 'presets have not been clinically reviewed, and there is no acoustic '
      + 'simulation. Not for anatomy or clinical instruction.',
    'about.models3d': '3D models',
    'about.software': 'Software',
    'about.source': 'Source',
    'about.sourceNote': '— application code is MIT. Model licences are listed '
      + 'above and are separate.',
    'about.licenceReview': 'Licence review outstanding.',
    'about.licenceReviewBody': '{n} of {total} models are not cleared for '
      + 'publication in the form used here — see the notes above.',
  },

  ko: {
    'lang.switch': '언어',

    'preset.subxiphoid': '검상돌기하',
    'preset.parasternal-long': '흉골연 장축',
    'preset.parasternal-short': '흉골연 단축',
    'preset.apical-four-chamber': '심첨부 4방',
    'preset.ruq-morison': '우상복부 / 모리슨 주머니',
    'preset.luq-splenorenal': '좌상복부 / 비장-신장',
    'preset.suprapubic': '치골상부',
    'preset.aorta-transverse': '대동맥 (횡단면)',

    'probe.curvilinear': '곡선형',
    'probe.phased': '위상배열',
    'probe.linear': '선형',
    'mode.short.1': '1 · 광선',
    'mode.short.2': '2 · 절단',
    'mode.short.3': '3 · 고스트',
    'mode.1': '모드 1 — 광선',
    'mode.2': '모드 2 — 절단',
    'mode.3': '모드 3 — 고스트',

    'organ.Bone': '뼈',
    'organ.Muscle': '근육',
    'organ.Gallbladder lumen': '담낭 내강',
    'organ.Bladder lumen': '방광 내강',
    'organ.Gallbladder wall': '담낭벽',
    'organ.Bladder wall': '방광벽',
    'organ.Cardiac chamber': '심장 내강',
    'organ.Valve': '판막',
    'organ.Heart': '심장',
    'organ.Liver': '간',
    'organ.Spleen': '비장',
    'organ.Kidney': '신장',
    'organ.Adrenal': '부신',
    'organ.Pancreas': '췌장',
    'organ.Uterus': '자궁',
    'organ.Ovary': '난소',
    'organ.Ureter': '요관',
    'organ.Artery': '동맥',
    'organ.Vein': '정맥',
    'organ.Bowel': '장',
    'organ.Airway': '기도',
    'organ.Tissue': '조직',

    'viewer.title': 'Scahn — 뷰어',
    'viewer.muscles': '근육',
    'viewer.musclesTitle': '체벽 근육층 표시',
    'viewer.noWindow': '선택된 창 없음',
    'viewer.freePlacement': '자유 배치',
    'viewer.prealphaBold': '프리알파 — 해부학적으로 정확하지 않습니다.',
    'viewer.prealpha': '장기의 모양과 위치는 탐촉자 배치 연습용이며 진단용이 아닙니다.',
    'viewer.aboutTitle': 'Scahn 소개, 제작 정보 및 라이선스',
    'viewer.scanQr': '휴대폰 카메라 앱으로 스캔하세요.',
    'viewer.orOpen': '또는 다음 주소를 열어',
    'viewer.andType': '코드를 입력하세요.',
    'viewer.prealphaBody': '장기의 모양과 위치는 탐촉자 조작 연습을 위한 '
      + '기하학적 대체물일 뿐입니다. 해부학 학습이나 임상 교육에 사용하지 마세요.',
    'viewer.invertClip': '절단면 반전',
    'viewer.beamSector': '빔 섹터',
    'viewer.debug': '디버그',
    'viewer.smoothing': '평활화',
    'viewer.moveGain': '이동 감도',
    'viewer.waitingPhone': '휴대폰 연결을 기다리는 중…',
    'viewer.driving': '조작 중',
    'viewer.loading': '{model} 불러오는 중…',
    'viewer.loadingPct': '{model} 불러오는 중… {pct}%',
    'viewer.loadFailed': '{model}을(를) 불러오지 못했습니다. 계속 {current}을(를) 표시합니다.',
    'viewer.model.primitives': '기본 도형',
    'viewer.model.bodyparts3d': 'BodyParts3D',

    'phone.title': 'Scahn — 탐촉자',
    'phone.tagline': '휴대폰이 초음파 탐촉자가 됩니다.',
    'phone.prealpha': '프리알파.',
    'phone.roomCode': '방 코드',
    'phone.connect': '연결하고 모션 사용 허용',
    'phone.viewingOnly': '보기 전용',
    'phone.youAreDriving': '조작 중입니다',
    'phone.recenter': '중심 재설정',
    'phone.takeControl': '제어 권한 가져오기',
    'phone.placement': '배치',
    'phone.dragHint': '드래그하여 피부 위에서 탐촉자를 움직입니다.',
    'phone.drag': '드래그',
    'phone.dragPad': '드래그 패드',
    'phone.moveInSpace': '공간에서 이동',
    'phone.holdMove': '누른 채 휴대폰을 움직이세요',
    'phone.window': '창',
    'phone.transducer': '탐촉자',
    'phone.depth': '깊이',
    'phone.viewMode': '보기 모드',
    'phone.enterCode': '화면에 표시된 여섯 자리 코드를 입력하세요.',
    'phone.httpsRequired': '모션 센서를 사용하려면 이 페이지가 HTTPS로 제공되어야 '
      + '합니다. LAN 주소가 아니라 터널링된 주소로 여세요.',
    'phone.requestingMotion': '모션 접근 권한을 요청하는 중…',
    'phone.motionUnavailable': '이 기기에서는 물리적 이동을 사용할 수 없습니다 — '
      + '드래그 패드를 사용하세요.',
    'phone.motionFailed': '모션 센서를 시작할 수 없습니다.',
    'phone.recentred': '중심을 재설정했습니다.',

    'about.intro': '초음파 검사 술기를 배우기 위한 교육 도구입니다. 휴대폰이 '
      + '탐촉자 역할을 하고, 이 화면은 잘리는 해부 구조와 그 단면을 나란히 '
      + '보여줍니다.',
    'about.how': '작동 방식',
    'about.models': '모델',
    'about.tools': '도구 및 라이브러리',
    'about.by': '제작:',
    'about.prealphaWarn': '프리알파.',
    'about.prealphaWarnBody': '장기의 모양과 위치는 근사값이며, 창 프리셋은 임상적으로 '
      + '검토되지 않았고, 음향 시뮬레이션은 없습니다. 해부학 학습이나 임상 교육에 '
      + '사용하지 마세요.',
    'about.models3d': '3D 모델',
    'about.software': '소프트웨어',
    'about.source': '소스 코드',
    'about.sourceNote': '— 애플리케이션 코드는 MIT 라이선스입니다. 모델 라이선스는 '
      + '위에 별도로 표시되어 있습니다.',
    'about.licenceReview': '라이선스 검토 필요.',
    'about.licenceReviewBody': '{total}개 모델 중 {n}개가 현재 사용 형태로 공개하기에 '
      + '적합한지 확인되지 않았습니다 — 위 주석을 참고하세요.',
  },
  fr: {
    'lang.switch': 'Langue',
    'preset.subxiphoid': 'Sous-xiphoïdien',
    'preset.parasternal-long': 'Parasternal grand axe',
    'preset.parasternal-short': 'Parasternal petit axe',
    'preset.apical-four-chamber': 'Apical 4 cavités',
    'preset.ruq-morison': 'QSD / Poche de Morison',
    'preset.luq-splenorenal': 'QSG / Splénorénal',
    'preset.suprapubic': 'Sus-pubien',
    'preset.aorta-transverse': 'Aorte (transversale)',
    'probe.curvilinear': 'Convexe',
    'probe.phased': 'Sectoriel',
    'probe.linear': 'Linéaire',
    'mode.short.1': '1 · Rayon',
    'mode.short.2': '2 · Coupe',
    'mode.short.3': '3 · Fantôme',
    'mode.1': 'Mode 1 — Rayon',
    'mode.2': 'Mode 2 — Coupe',
    'mode.3': 'Mode 3 — Fantôme',
    'organ.Bone': 'Os',
    'organ.Muscle': 'Muscle',
    'organ.Gallbladder lumen': 'Lumière vésiculaire',
    'organ.Bladder lumen': 'Lumière vésicale',
    'organ.Gallbladder wall': 'Paroi vésiculaire',
    'organ.Bladder wall': 'Paroi vésicale',
    'organ.Cardiac chamber': 'Cavité cardiaque',
    'organ.Valve': 'Valve',
    'organ.Heart': 'Cœur',
    'organ.Liver': 'Foie',
    'organ.Spleen': 'Rate',
    'organ.Kidney': 'Rein',
    'organ.Adrenal': 'Surrénale',
    'organ.Pancreas': 'Pancréas',
    'organ.Uterus': 'Utérus',
    'organ.Ovary': 'Ovaire',
    'organ.Ureter': 'Uretère',
    'organ.Artery': 'Artère',
    'organ.Vein': 'Veine',
    'organ.Bowel': 'Intestin',
    'organ.Airway': 'Voies aériennes',
    'organ.Tissue': 'Tissu',
    'viewer.title': 'Scahn — Visualiseur',
    'viewer.muscles': 'Muscles',
    'viewer.musclesTitle': 'Afficher la couche musculaire de la paroi',
    'viewer.noWindow': 'Aucune fenêtre',
    'viewer.freePlacement': 'Placement libre',
    'viewer.prealphaBold': 'Pré-alpha — anatomiquement inexact.',
    'viewer.prealphaBody': "Les formes et positions des organes sont des substituts géométriques destinés uniquement à s'exercer au maniement de la sonde. Ne pas utiliser pour l'enseignement anatomique ou clinique.",
    'viewer.prealpha': "Les formes et positions des organes servent à s'exercer au placement de la sonde, pas au diagnostic.",
    'viewer.aboutTitle': 'À propos de Scahn, crédits et licences',
    'viewer.scanQr': "Scannez ceci avec l'appareil photo de votre téléphone.",
    'viewer.orOpen': 'Ou ouvrez',
    'viewer.andType': 'et saisissez le code.',
    'viewer.debug': 'Débogage',
    'viewer.smoothing': 'Lissage',
    'viewer.moveGain': 'Gain de déplacement',
    'viewer.invertClip': 'Inverser le côté de coupe',
    'viewer.beamSector': 'Secteur du faisceau',
    'viewer.waitingPhone': 'En attente d’un téléphone…',
    'viewer.driving': 'aux commandes',
    'viewer.loading': 'Chargement de {model}…',
    'viewer.loadingPct': 'Chargement de {model}… {pct} %',
    'viewer.loadFailed': 'Impossible de charger {model}. Affichage de {current} maintenu.',
    'viewer.model.primitives': 'Primitives',
    'viewer.model.bodyparts3d': 'BodyParts3D',
    'phone.title': 'Scahn — Sonde',
    'phone.tagline': 'Votre téléphone devient la sonde échographique.',
    'phone.prealpha': 'Pré-alpha.',
    'phone.roomCode': 'Code de salle',
    'phone.connect': 'Connecter et activer le mouvement',
    'phone.viewingOnly': 'Observation seule',
    'phone.youAreDriving': 'Vous êtes aux commandes',
    'phone.recenter': 'Recentrer',
    'phone.takeControl': 'Prendre le contrôle',
    'phone.placement': 'Placement',
    'phone.dragHint': 'Faites glisser pour déplacer la sonde sur la peau.',
    'phone.drag': 'glisser',
    'phone.dragPad': 'Pavé tactile',
    'phone.moveInSpace': 'Déplacer dans l’espace',
    'phone.holdMove': 'Maintenez et déplacez le téléphone',
    'phone.window': 'Fenêtre',
    'phone.transducer': 'Sonde',
    'phone.depth': 'Profondeur',
    'phone.viewMode': 'Mode d’affichage',
    'phone.enterCode': 'Saisissez le code à six chiffres affiché à l’écran.',
    'phone.httpsRequired': 'Cette page doit être servie en HTTPS pour accéder aux capteurs de mouvement. Ouvrez l’URL tunnelisée, pas une adresse LAN.',
    'phone.requestingMotion': 'Demande d’accès aux capteurs…',
    'phone.motionUnavailable': 'Déplacement physique indisponible sur cet appareil — utilisez le pavé tactile.',
    'phone.motionFailed': 'Impossible de démarrer les capteurs de mouvement.',
    'phone.recentred': 'Recentré.',
    'about.intro': "Un outil pédagogique pour la technique d'échographie. Un téléphone sert de sonde ; cet écran montre côte à côte l'anatomie coupée et la coupe correspondante.",
    'about.how': 'Fonctionnement',
    'about.models': 'Modèles',
    'about.tools': 'Outils et bibliothèques',
    'about.by': 'par',
    'about.prealphaWarn': 'Pré-alpha.',
    'about.prealphaWarnBody': "Les formes et positions des organes sont approximatives, les fenêtres prédéfinies n'ont pas été validées cliniquement, et il n'y a aucune simulation acoustique. Ne pas utiliser pour l'enseignement anatomique ou clinique.",
    'about.models3d': 'Modèles 3D',
    'about.software': 'Logiciels',
    'about.source': 'Code source',
    'about.sourceNote': '— le code applicatif est sous licence MIT. Les licences des modèles sont listées ci-dessus et sont distinctes.',
    'about.licenceReview': 'Vérification de licence en attente.',
    'about.licenceReviewBody': '{n} modèles sur {total} ne sont pas validés pour la publication sous la forme utilisée ici — voir les notes ci-dessus.',
  },

  zh: {
    'lang.switch': '语言',
    'preset.subxiphoid': '剑突下',
    'preset.parasternal-long': '胸骨旁长轴',
    'preset.parasternal-short': '胸骨旁短轴',
    'preset.apical-four-chamber': '心尖四腔',
    'preset.ruq-morison': '右上腹 / 莫里森陷凹',
    'preset.luq-splenorenal': '左上腹 / 脾肾间隙',
    'preset.suprapubic': '耻骨上',
    'preset.aorta-transverse': '主动脉（横切）',
    'probe.curvilinear': '凸阵',
    'probe.phased': '相控阵',
    'probe.linear': '线阵',
    'mode.short.1': '1 · 射线',
    'mode.short.2': '2 · 切面',
    'mode.short.3': '3 · 透视',
    'mode.1': '模式 1 — 射线',
    'mode.2': '模式 2 — 切面',
    'mode.3': '模式 3 — 透视',
    'organ.Bone': '骨',
    'organ.Muscle': '肌肉',
    'organ.Gallbladder lumen': '胆囊腔',
    'organ.Bladder lumen': '膀胱腔',
    'organ.Gallbladder wall': '胆囊壁',
    'organ.Bladder wall': '膀胱壁',
    'organ.Cardiac chamber': '心腔',
    'organ.Valve': '瓣膜',
    'organ.Heart': '心脏',
    'organ.Liver': '肝',
    'organ.Spleen': '脾',
    'organ.Kidney': '肾',
    'organ.Adrenal': '肾上腺',
    'organ.Pancreas': '胰腺',
    'organ.Uterus': '子宫',
    'organ.Ovary': '卵巢',
    'organ.Ureter': '输尿管',
    'organ.Artery': '动脉',
    'organ.Vein': '静脉',
    'organ.Bowel': '肠',
    'organ.Airway': '气道',
    'organ.Tissue': '组织',
    'viewer.title': 'Scahn — 显示端',
    'viewer.muscles': '肌肉',
    'viewer.musclesTitle': '显示体壁肌肉层',
    'viewer.noWindow': '未选择切面',
    'viewer.freePlacement': '自由放置',
    'viewer.prealphaBold': '预览版 — 解剖结构并不准确。',
    'viewer.prealphaBody': '器官的形状和位置仅为练习探头操作的几何替代物。请勿用于解剖学或临床教学。',
    'viewer.prealpha': '器官形状与位置用于练习探头放置，不能用于诊断。',
    'viewer.aboutTitle': '关于 Scahn、致谢与许可',
    'viewer.scanQr': '请用手机相机应用扫描。',
    'viewer.orOpen': '或打开',
    'viewer.andType': '并输入代码。',
    'viewer.debug': '调试',
    'viewer.smoothing': '平滑',
    'viewer.moveGain': '移动增益',
    'viewer.invertClip': '反转剖切面',
    'viewer.beamSector': '声束扇区',
    'viewer.waitingPhone': '等待手机连接…',
    'viewer.driving': '操作中',
    'viewer.loading': '正在加载 {model}…',
    'viewer.loadingPct': '正在加载 {model}… {pct}%',
    'viewer.loadFailed': '无法加载 {model}。仍显示 {current}。',
    'viewer.model.primitives': '基本图元',
    'viewer.model.bodyparts3d': 'BodyParts3D',
    'phone.title': 'Scahn — 探头',
    'phone.tagline': '您的手机就是超声探头。',
    'phone.prealpha': '预览版。',
    'phone.roomCode': '房间代码',
    'phone.connect': '连接并启用运动传感器',
    'phone.viewingOnly': '仅查看',
    'phone.youAreDriving': '您正在操作',
    'phone.recenter': '重新居中',
    'phone.takeControl': '取得控制权',
    'phone.placement': '放置',
    'phone.dragHint': '拖动以在皮肤上移动探头。',
    'phone.drag': '拖动',
    'phone.dragPad': '拖动板',
    'phone.moveInSpace': '空间移动',
    'phone.holdMove': '按住并移动手机',
    'phone.window': '切面',
    'phone.transducer': '探头',
    'phone.depth': '深度',
    'phone.viewMode': '显示模式',
    'phone.enterCode': '请输入显示端上的六位代码。',
    'phone.httpsRequired': '此页面必须通过 HTTPS 提供才能访问运动传感器。请打开隧道地址，而不是局域网地址。',
    'phone.requestingMotion': '正在请求运动传感器权限…',
    'phone.motionUnavailable': '此设备不支持物理移动 — 请使用拖动板。',
    'phone.motionFailed': '无法启动运动传感器。',
    'phone.recentred': '已重新居中。',
    'about.intro': '一个用于学习超声扫查手法的教学工具。手机充当探头；本屏幕并排显示被切割的解剖结构和对应的断面。',
    'about.how': '工作原理',
    'about.models': '模型',
    'about.tools': '工具与库',
    'about.by': '作者：',
    'about.prealphaWarn': '预览版。',
    'about.prealphaWarnBody': '器官形状与位置为近似值，切面预设未经临床审核，且没有声学模拟。请勿用于解剖学或临床教学。',
    'about.models3d': '3D 模型',
    'about.software': '软件',
    'about.source': '源代码',
    'about.sourceNote': '— 应用程序代码采用 MIT 许可。模型许可如上所列，且相互独立。',
    'about.licenceReview': '许可审核待完成。',
    'about.licenceReviewBody': '{total} 个模型中有 {n} 个尚未确认可按当前使用形式发布 — 请参阅上述说明。',
  },

  ru: {
    'lang.switch': 'Язык',
    'preset.subxiphoid': 'Субксифоидальный',
    'preset.parasternal-long': 'Парастернальная длинная ось',
    'preset.parasternal-short': 'Парастернальная короткая ось',
    'preset.apical-four-chamber': 'Апикальная четырёхкамерная',
    'preset.ruq-morison': 'ПВК / карман Моррисона',
    'preset.luq-splenorenal': 'ЛВК / спленоренальный',
    'preset.suprapubic': 'Надлобковый',
    'preset.aorta-transverse': 'Аорта (поперечно)',
    'probe.curvilinear': 'Конвексный',
    'probe.phased': 'Секторный',
    'probe.linear': 'Линейный',
    'mode.short.1': '1 · Луч',
    'mode.short.2': '2 · Срез',
    'mode.short.3': '3 · Призрак',
    'mode.1': 'Режим 1 — Луч',
    'mode.2': 'Режим 2 — Срез',
    'mode.3': 'Режим 3 — Призрак',
    'organ.Bone': 'Кость',
    'organ.Muscle': 'Мышца',
    'organ.Gallbladder lumen': 'Просвет жёлчного пузыря',
    'organ.Bladder lumen': 'Просвет мочевого пузыря',
    'organ.Gallbladder wall': 'Стенка жёлчного пузыря',
    'organ.Bladder wall': 'Стенка мочевого пузыря',
    'organ.Cardiac chamber': 'Камера сердца',
    'organ.Valve': 'Клапан',
    'organ.Heart': 'Сердце',
    'organ.Liver': 'Печень',
    'organ.Spleen': 'Селезёнка',
    'organ.Kidney': 'Почка',
    'organ.Adrenal': 'Надпочечник',
    'organ.Pancreas': 'Поджелудочная железа',
    'organ.Uterus': 'Матка',
    'organ.Ovary': 'Яичник',
    'organ.Ureter': 'Мочеточник',
    'organ.Artery': 'Артерия',
    'organ.Vein': 'Вена',
    'organ.Bowel': 'Кишечник',
    'organ.Airway': 'Дыхательные пути',
    'organ.Tissue': 'Ткань',
    'viewer.title': 'Scahn — Экран',
    'viewer.muscles': 'Мышцы',
    'viewer.musclesTitle': 'Показать мышечный слой брюшной стенки',
    'viewer.noWindow': 'Доступ не выбран',
    'viewer.freePlacement': 'Свободное размещение',
    'viewer.prealphaBold': 'Пре-альфа — анатомически неточно.',
    'viewer.prealphaBody': 'Формы и положения органов — геометрические заглушки только для отработки обращения с датчиком. Не использовать для изучения анатомии или клинического обучения.',
    'viewer.prealpha': 'Формы и положения органов предназначены для отработки установки датчика, а не для диагностики.',
    'viewer.aboutTitle': 'О Scahn, благодарности и лицензии',
    'viewer.scanQr': 'Отсканируйте это камерой телефона.',
    'viewer.orOpen': 'Или откройте',
    'viewer.andType': 'и введите код.',
    'viewer.debug': 'Отладка',
    'viewer.smoothing': 'Сглаживание',
    'viewer.moveGain': 'Усиление перемещения',
    'viewer.invertClip': 'Инвертировать сторону среза',
    'viewer.beamSector': 'Сектор луча',
    'viewer.waitingPhone': 'Ожидание телефона…',
    'viewer.driving': 'управляет',
    'viewer.loading': 'Загрузка {model}…',
    'viewer.loadingPct': 'Загрузка {model}… {pct} %',
    'viewer.loadFailed': 'Не удалось загрузить {model}. По-прежнему показывается {current}.',
    'viewer.model.primitives': 'Примитивы',
    'viewer.model.bodyparts3d': 'BodyParts3D',
    'phone.title': 'Scahn — Датчик',
    'phone.tagline': 'Ваш телефон становится ультразвуковым датчиком.',
    'phone.prealpha': 'Пре-альфа.',
    'phone.roomCode': 'Код комнаты',
    'phone.connect': 'Подключить и включить датчики движения',
    'phone.viewingOnly': 'Только просмотр',
    'phone.youAreDriving': 'Вы управляете',
    'phone.recenter': 'Отцентрировать',
    'phone.takeControl': 'Взять управление',
    'phone.placement': 'Размещение',
    'phone.dragHint': 'Проведите пальцем, чтобы двигать датчик по коже.',
    'phone.drag': 'ведите',
    'phone.dragPad': 'Сенсорная область',
    'phone.moveInSpace': 'Движение в пространстве',
    'phone.holdMove': 'Удерживайте и перемещайте телефон',
    'phone.window': 'Доступ',
    'phone.transducer': 'Датчик',
    'phone.depth': 'Глубина',
    'phone.viewMode': 'Режим отображения',
    'phone.enterCode': 'Введите шестизначный код, показанный на экране.',
    'phone.httpsRequired': 'Эта страница должна открываться по HTTPS для доступа к датчикам движения. Откройте туннелированный адрес, а не адрес локальной сети.',
    'phone.requestingMotion': 'Запрос доступа к датчикам движения…',
    'phone.motionUnavailable': 'Физическое перемещение недоступно на этом устройстве — используйте сенсорную область.',
    'phone.motionFailed': 'Не удалось запустить датчики движения.',
    'phone.recentred': 'Отцентрировано.',
    'about.intro': 'Учебный инструмент для отработки техники ультразвукового сканирования. Телефон выступает датчиком; на этом экране рядом показаны рассекаемая анатомия и соответствующий срез.',
    'about.how': 'Как это работает',
    'about.models': 'Модели',
    'about.tools': 'Инструменты и библиотеки',
    'about.by': 'автор:',
    'about.prealphaWarn': 'Пре-альфа.',
    'about.prealphaWarnBody': 'Формы и положения органов приблизительны, предустановки доступов не проходили клиническую проверку, акустическое моделирование отсутствует. Не использовать для изучения анатомии или клинического обучения.',
    'about.models3d': '3D-модели',
    'about.software': 'Программное обеспечение',
    'about.source': 'Исходный код',
    'about.sourceNote': '— код приложения под лицензией MIT. Лицензии моделей перечислены выше и являются отдельными.',
    'about.licenceReview': 'Проверка лицензии не завершена.',
    'about.licenceReviewBody': '{n} из {total} моделей не подтверждены для публикации в используемом здесь виде — см. примечания выше.',
  },
});

function detect() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved && STRINGS[saved]) return saved;
  } catch { /* private mode: fall through to the browser preference */ }
  const nav = globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? '';
  const code = String(nav).slice(0, 2).toLowerCase();
  return STRINGS[code] ? code : 'en';
}

let lang = detect();
const listeners = new Set();

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (!STRINGS[next] || next === lang) return lang;
  lang = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, lang);
  } catch { /* not fatal: the choice just will not survive a reload */ }
  if (globalThis.document) globalThis.document.documentElement.lang = lang;
  for (const fn of listeners) fn(lang);
  return lang;
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Look up a string, interpolating {placeholders}.
 *
 * Falls back to English, then to the key itself, rather than rendering blank:
 * a visible untranslated key is a bug report, an empty label is a mystery.
 */
export function t(key, vars) {
  const s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Translate an organ label produced by the model classifier. */
export const tOrgan = (label) => t(`organ.${label}`);
/** Translate a window name. */
export const tPreset = (name) => t(`preset.${name}`);

// ---------------------------------------------------------------------------
// DOM helpers (browser only)
// ---------------------------------------------------------------------------

/**
 * Apply translations to static markup.
 *
 * `data-i18n` sets textContent; `data-i18n-title` and `data-i18n-placeholder`
 * set those attributes. Driving the markup from attributes rather than
 * rebuilding it in JS keeps the HTML readable and means a missed string shows
 * up as untranslated text rather than as a hole in the layout.
 */
export function applyStatic(root = globalThis.document) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.getAttribute('data-i18n'));
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder')));
  }
  const titleKey = root.querySelector?.('title')?.getAttribute('data-i18n');
  if (titleKey) globalThis.document.title = t(titleKey);
}

/**
 * Build the EN / 한국어 toggle into `host`.
 *
 * Each language is labelled in its own script, never translated — someone who
 * cannot read the current language still has to be able to find their way out.
 */
export function initLangToggle(host, onChange) {
  if (!host) return;
  host.innerHTML = '';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Language / 언어');
  const buttons = [];
  for (const [code, label] of Object.entries(LANGS)) {
    const b = globalThis.document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.lang = code;
    b.addEventListener('click', () => setLang(code));
    host.appendChild(b);
    buttons.push([code, b]);
  }
  const paint = () => {
    for (const [code, b] of buttons) {
      b.classList.toggle('on', code === getLang());
      b.setAttribute('aria-pressed', String(code === getLang()));
    }
  };
  paint();
  onLangChange(() => {
    paint();
    applyStatic();
    onChange?.();
  });
  if (globalThis.document) globalThis.document.documentElement.lang = getLang();
}
