"""BodyParts3D ISA-tree selection for the scahn full-body model.

GENERATED from 3d_models/bodyparts3d/isa_element_parts.txt — edit the
generator (or this data) and keep mesh names in sync with classify()
in clients/viewer/src/models.js.
"""

# (mesh_name, [fj ids], merge_into_one_mesh)
ORGANS = [
    ('liver', ['FJ2816', 'FJ2819', 'FJ2820', 'FJ2821', 'FJ2823', 'FJ2824', 'FJ2409', 'FJ2822'], True),
    ('gallbladder', ['FJ2817'], False),
    ('spleen', ['FJ2561'], False),
    ('pancreas', ['FJ1895'], False),
    ('kidney-right', ['FJ3147'], False),
    ('kidney-left', ['FJ3145'], False),
    ('adrenal-right', ['FJ3130'], False),
    ('adrenal-left', ['FJ3129'], False),
    ('stomach', ['FJ2564'], False),
    ('intestine-duodenum', ['FJ2573'], False),
    ('intestine-small', ['FJ2606', 'FJ2607', 'FJ2608', 'FJ2609', 'FJ2610', 'FJ2611', 'FJ2612', 'FJ2613', 'FJ2614', 'FJ2615', 'FJ2616', 'FJ2617', 'FJ2618', 'FJ2619', 'FJ2620', 'FJ2621', 'FJ2622', 'FJ2623', 'FJ2624', 'FJ2625', 'FJ2626', 'FJ2627', 'FJ2628', 'FJ2574', 'FJ2575', 'FJ2576', 'FJ2577', 'FJ2578', 'FJ2579', 'FJ2580', 'FJ2581', 'FJ2582', 'FJ2583', 'FJ2584', 'FJ2585', 'FJ2586', 'FJ2587', 'FJ2588', 'FJ2589', 'FJ2590', 'FJ2591', 'FJ2592', 'FJ2593', 'FJ2594', 'FJ2595', 'FJ2596', 'FJ2597', 'FJ2598', 'FJ2600', 'FJ2601', 'FJ2602', 'FJ2603', 'FJ2604', 'FJ2605'], True),
    ('intestine-large', ['FJ2566', 'FJ2572', 'FJ2567', 'FJ2571', 'FJ2565'], True),
    ('bladder', ['FJ3149'], False),
    ('prostate', ['FJ3139'], False),
    ('aorta-ascending', ['FJ3413'], False),
    ('aorta-arch', ['FJ3411'], False),
    ('aorta-descending', ['FJ3427', 'FJ1931'], True),
    ('aorta-abdominal', ['FJ1932'], False),
    ('vena-cava-inferior', ['FJ3441', 'FJ3659'], True),
    ('vena-cava-superior', ['FJ3645'], False),
    ('vein-portal', ['FJ1853'], False),
    ('vein-hepatic', ['FJ2414', 'FJ2415', 'FJ2416'], True),
    ('vein-splenic', ['FJ3641'], False),
    ('artery-mesenteric-superior', ['FJ1928', 'FJ2011'], True),
    ('artery-pulmonary-trunk', ['FJ2966'], False),
    ('artery-pulmonary-right', ['FJ3019'], False),
    ('artery-pulmonary-left', ['FJ2924'], False),
    ('diaphragm', ['FJ3131'], False),
    ('trachea', ['FJ2541'], False),
    ('esophagus', ['FJ2563'], False),
    ('chamber-rv', ['FJ2423'], False),
    ('chamber-lv', ['FJ2422'], False),
    ('chamber-ra', ['FJ2424'], False),
    ('chamber-la', ['FJ2425'], False),
    ('heart-wall-ventricle', ['FJ2428'], False),
    ('heart-wall-atrium-left', ['FJ2438'], False),
    ('heart-wall-atrium-right', ['FJ2439'], False),
    ('heart-valve-mitral', ['FJ2420', 'FJ2432'], True),
    ('heart-valve-tricuspid', ['FJ2421', 'FJ2433', 'FJ2436'], True),
    ('heart-valve-aortic', ['FJ2426', 'FJ2431', 'FJ2435'], True),
    ('heart-valve-pulmonary', ['FJ2417', 'FJ2427', 'FJ2434'], True),
    ('heart-papillary-rv', ['FJ2419', 'FJ2430', 'FJ2437'], True),
    ('heart-papillary-lv', ['FJ2429'], True),
]

# The whole-body skin surface. ONE element, and it is the largest single mesh
# in the drop (102k verts / 203k faces, 14.5 MB), because it spans head to
# feet. The pipeline crops it to the trunk and decimates hard: it is only a
# surface for the probe to ride on and a translucent shell to look through,
# never something the scan plane cuts.
SKIN = ['FJ2810']

# Body-wall and trunk muscles, as an optional layer.
#
# GAPS, and they matter for this tool: BodyParts3D has NO rectus abdominis, no
# internal oblique, no transversus abdominis, no latissimus dorsi, no erector
# spinae and no quadratus lumborum. External oblique is the ONLY abdominal wall
# muscle in the drop — so the near-field layers a learner actually scans through
# on an abdominal view are only partly represented. The thoracic wall
# (intercostals, pectoralis, serratus) is well covered, which is where this
# layer earns its keep: those are the structures between the transducer and the
# heart on every parasternal window.
#
# Trapezius is deliberately ABSENT. It runs from the skull down the neck, well
# past the trunk the skin shell is cropped to, so it rendered as a slab
# protruding out the top of the body — and no window in this tool images
# through it.
#
# The `M` suffix is BodyParts3D's mirrored (left-side) element.
MUSCLES = [
    ('muscle-oblique-external', ['FJ1452', 'FJ1452M'], True),
    ('muscle-intercostal-external', ['FJ1451', 'FJ1451M'], True),
    ('muscle-intercostal-internal', ['FJ1455', 'FJ1455M'], True),
    ('muscle-transversus-thoracis', ['FJ1461', 'FJ1461M'], True),
    ('muscle-pectoralis-major', ['FJ1446', 'FJ1446M', 'FJ1447', 'FJ1447M'], True),
    ('muscle-pectoralis-minor', ['FJ1456', 'FJ1456M'], True),
    ('muscle-serratus-anterior', ['FJ1459', 'FJ1459M'], True),
    ('muscle-psoas-major', ['FJ1431', 'FJ1431M'], True),
    ('muscle-iliacus', ['FJ1422', 'FJ1422M'], True),
    ('muscle-linea-alba', ['FJ1448'], False),
]

# Element ids joined into the single bone-skeleton mesh
BONES = ['FJ3152', 'FJ3153', 'FJ3154', 'FJ3155', 'FJ3156', 'FJ3157', 'FJ3158', 'FJ3159', 'FJ3160', 'FJ3162', 'FJ3163', 'FJ3165', 'FJ3166', 'FJ3168', 'FJ3169', 'FJ3171', 'FJ3173', 'FJ3174', 'FJ3175', 'FJ3178', 'FJ3225', 'FJ3226', 'FJ3227', 'FJ3228', 'FJ3229', 'FJ3230', 'FJ3231', 'FJ3232', 'FJ3233', 'FJ3234', 'FJ3235', 'FJ3236', 'FJ3237', 'FJ3239', 'FJ3242', 'FJ3245', 'FJ3248', 'FJ3251', 'FJ3254', 'FJ3255', 'FJ3279', 'FJ3288', 'FJ3290', 'FJ3330', 'FJ3331', 'FJ3332', 'FJ3333', 'FJ3334', 'FJ3335', 'FJ3336', 'FJ3337', 'FJ3338', 'FJ3339', 'FJ3340', 'FJ3341', 'FJ3342', 'FJ3343', 'FJ3344', 'FJ3345', 'FJ3346', 'FJ3347', 'FJ3348', 'FJ3362', 'FJ3384', 'FJ3393']
