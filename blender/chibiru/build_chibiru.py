"""Chibiru (NasPet base form) — procedural 3D model builder for Blender 5.x.

Usage:
    blender --background --python blender/chibiru/build_chibiru.py
    # or, with the `bpy` pip module:
    python3 blender/chibiru/build_chibiru.py [--no-render]

Outputs (next to this script):
    chibiru.blend, chibiru.glb, renders/chibiru_front.png, renders/chibiru_three_quarter.png

Conventions: Z is up, the character faces -Y, total height is about 2.3 units.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = "--no-render" not in sys.argv


# ---------------------------------------------------------------- helpers ---

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_material(name, color, roughness=0.6, subsurface=0.0, emission=0.0,
                  sheen=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    if subsurface:
        bsdf.inputs["Subsurface Weight"].default_value = subsurface
        bsdf.inputs["Subsurface Radius"].default_value = (0.3, 0.15, 0.08)
    if sheen:
        bsdf.inputs["Sheen Weight"].default_value = sheen
        bsdf.inputs["Sheen Tint"].default_value = (1.0, 1.0, 1.0, 1.0)
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*color, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = (*color, 1.0)
    return mat


def link(obj, parent=None):
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def shade_smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


def add_subsurf(obj, levels=2):
    mod = obj.modifiers.new("Subdivision", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    return mod


def uv_sphere(name, location, scale, mat, segments=32, rings=16,
              rotation=(0, 0, 0), parent=None):
    import bmesh
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings,
                              radius=1.0)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.scale = scale
    obj.rotation_euler = rotation
    obj.data.materials.append(mat)
    shade_smooth(obj)
    return link(obj, parent)


def cone(name, location, radius, depth, mat, rotation=(0, 0, 0), scale=(1, 1, 1),
         parent=None, subsurf=2):
    import bmesh
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=radius,
                          radius2=radius * 0.08, depth=depth)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    obj.rotation_euler = rotation
    obj.scale = scale
    obj.data.materials.append(mat)
    shade_smooth(obj)
    if subsurf:
        add_subsurf(obj, subsurf)
    return link(obj, parent)


# ------------------------------------------------------------- materials ---

def build_materials():
    return {
        "fur": make_material("Fur_Cream", (0.98, 0.90, 0.76), roughness=0.85,
                             subsurface=0.15, sheen=0.6),
        "fur_light": make_material("Fur_Light", (1.0, 0.96, 0.88), roughness=0.9,
                                   sheen=0.8),
        "ear_inner": make_material("Ear_Pink", (0.98, 0.62, 0.62), roughness=0.7,
                                   subsurface=0.2),
        "eye": make_material("Eye_Brown", (0.10, 0.045, 0.02), roughness=0.15),
        "iris": make_material("Eye_Amber", (0.55, 0.30, 0.10), roughness=0.2),
        "highlight": make_material("Eye_Highlight", (1.0, 1.0, 1.0), roughness=0.3,
                                   emission=2.0),
        "nose": make_material("Nose_Pink", (0.92, 0.45, 0.50), roughness=0.4),
        "mouth": make_material("Mouth_Line", (0.35, 0.18, 0.12), roughness=0.6),
        "blush": make_material("Blush", (1.0, 0.66, 0.66), roughness=0.8),
        "collar": make_material("Collar_Lavender", (0.66, 0.56, 0.92), roughness=0.5),
        "heart": make_material("Heart_Pink", (0.96, 0.42, 0.55), roughness=0.25),
        "cross": make_material("Cross_White", (1.0, 0.98, 0.98), roughness=0.35),
        "gold": make_material("Ring_Gold", (0.95, 0.75, 0.35), roughness=0.3),
    }


# ------------------------------------------------------------ body parts ---

def build_body(mats):
    """Head, torso, cheeks, limbs and tail: overlapping ellipsoids fused into
    one watertight mesh with a voxel remesh, then smoothed so the seams read
    as soft fur instead of intersecting balls."""
    import bmesh
    from mathutils import Euler, Matrix

    # (center, radii, rotation in degrees)
    parts = [
        # Big chibi head + fluffy cheek ruff + tiny muzzle bump.
        ((0, 0, 1.50), (0.70, 0.60, 0.58), (0, 0, 0)),
        ((-0.54, -0.08, 1.28), (0.24, 0.22, 0.20), (0, 25, 0)),
        ((0.54, -0.08, 1.28), (0.24, 0.22, 0.20), (0, -25, 0)),
        ((-0.40, -0.18, 1.16), (0.20, 0.20, 0.17), (0, 0, 0)),
        ((0.40, -0.18, 1.16), (0.20, 0.20, 0.17), (0, 0, 0)),
        ((0, -0.46, 1.32), (0.20, 0.14, 0.12), (0, 0, 0)),
        # Neck blend, pear-shaped torso and chest fluff.
        ((0, 0.0, 1.02), (0.34, 0.32, 0.20), (0, 0, 0)),
        ((0, 0.02, 0.54), (0.44, 0.40, 0.50), (0, 0, 0)),
        ((0, -0.22, 0.80), (0.24, 0.16, 0.22), (0, 0, 0)),
        # Arms held together in front of the chest.
        ((-0.24, -0.30, 0.66), (0.11, 0.12, 0.22), (15, -20, 0)),
        ((0.24, -0.30, 0.66), (0.11, 0.12, 0.22), (15, 20, 0)),
        ((-0.13, -0.40, 0.50), (0.10, 0.10, 0.09), (0, 0, 0)),
        ((0.13, -0.40, 0.50), (0.10, 0.10, 0.09), (0, 0, 0)),
        # Haunches and feet.
        ((-0.26, -0.02, 0.24), (0.22, 0.26, 0.22), (0, 0, 0)),
        ((0.26, -0.02, 0.24), (0.22, 0.26, 0.22), (0, 0, 0)),
        ((-0.22, -0.26, 0.08), (0.13, 0.18, 0.09), (0, 0, -8)),
        ((0.22, -0.26, 0.08), (0.13, 0.18, 0.09), (0, 0, 8)),
    ]
    # Fluffy tail curling up from the back-right, thicker toward the tip.
    tail = [
        (0.10, 0.36, 0.26, 0.10), (0.24, 0.50, 0.30, 0.11),
        (0.38, 0.60, 0.40, 0.12), (0.48, 0.66, 0.54, 0.14),
        (0.54, 0.68, 0.70, 0.16), (0.54, 0.66, 0.86, 0.17),
        (0.48, 0.60, 0.98, 0.16), (0.40, 0.54, 1.04, 0.12),
    ]
    parts += [((x, y, z), (r, r, r), (0, 0, 0)) for x, y, z, r in tail]

    bm = bmesh.new()
    for center, radii, rot in parts:
        mat = (Matrix.Translation(center)
               @ Euler([math.radians(a) for a in rot]).to_matrix().to_4x4()
               @ Matrix.Diagonal((*radii, 1.0)))
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16,
                                  radius=1.0, matrix=mat)
    mesh = bpy.data.meshes.new("ChibiruBodyParts")
    bm.to_mesh(mesh)
    bm.free()
    raw = link(bpy.data.objects.new("ChibiruBodyParts", mesh))

    remesh = raw.modifiers.new("Remesh", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.018
    smooth = raw.modifiers.new("Smooth", "LAPLACIANSMOOTH")
    smooth.iterations = 12
    smooth.lambda_factor = 1.2
    smooth.use_volume_preserve = True

    # Bake the modifier stack into the final body mesh.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    body_mesh = bpy.data.meshes.new_from_object(raw.evaluated_get(depsgraph))
    body_mesh.name = "ChibiruBody"
    body = link(bpy.data.objects.new("ChibiruBody", body_mesh))
    bpy.data.objects.remove(raw)
    bpy.data.meshes.remove(mesh)

    body.data.materials.append(mats["fur"])
    shade_smooth(body)
    return body


def build_ears(mats, parent):
    for side in (-1, 1):
        tilt = math.radians(22) * side
        outer = cone(f"Ear_{'L' if side < 0 else 'R'}",
                     (0.40 * side, 0.02, 2.02), 0.24, 0.46, mats["fur"],
                     rotation=(math.radians(-6), tilt, 0),
                     scale=(1.0, 0.55, 1.0), parent=parent)
        inner = cone(f"EarInner_{'L' if side < 0 else 'R'}",
                     (0.395 * side, -0.07, 2.0), 0.15, 0.32, mats["ear_inner"],
                     rotation=(math.radians(-6), tilt, 0),
                     scale=(1.0, 0.35, 1.0), parent=parent)
        # Tuft of lighter fur inside the ear.
        cone(f"EarTuft_{'L' if side < 0 else 'R'}",
             (0.37 * side, -0.10, 1.92), 0.05, 0.22, mats["fur_light"],
             rotation=(math.radians(-10), -tilt * 1.5, 0), parent=parent)
        del outer, inner


def build_head_tuft(mats, parent):
    tufts = [
        ((0.00, -0.18, 2.06), 0.10, 0.22, (math.radians(-35), 0, 0)),
        ((-0.09, -0.12, 2.05), 0.08, 0.16, (math.radians(-25), math.radians(-35), 0)),
        ((0.09, -0.12, 2.05), 0.08, 0.16, (math.radians(-25), math.radians(35), 0)),
    ]
    for i, (loc, r, d, rot) in enumerate(tufts):
        cone(f"HeadTuft_{i}", loc, r, d, mats["fur_light"], rotation=rot,
             parent=parent)


def build_face(mats, parent):
    for side in (-1, 1):
        tag = "L" if side < 0 else "R"
        x = 0.27 * side
        # Big glossy eyes, pushed slightly into the head.
        uv_sphere(f"Eye_{tag}", (x, -0.545, 1.46), (0.135, 0.07, 0.165),
                  mats["eye"], rotation=(0, 0, math.radians(-14) * side),
                  parent=parent)
        uv_sphere(f"Iris_{tag}", (x, -0.605, 1.40), (0.085, 0.02, 0.065),
                  mats["iris"], rotation=(0, 0, math.radians(-14) * side),
                  parent=parent)
        uv_sphere(f"EyeHighlight_{tag}", (x - 0.045, -0.62, 1.52),
                  (0.045, 0.02, 0.05), mats["highlight"], parent=parent)
        uv_sphere(f"EyeHighlightSmall_{tag}", (x + 0.05, -0.625, 1.40),
                  (0.022, 0.012, 0.022), mats["highlight"], parent=parent)
        # Blush.
        uv_sphere(f"Blush_{tag}", (0.40 * side, -0.445, 1.30),
                  (0.09, 0.02, 0.05), mats["blush"],
                  rotation=(0, 0, math.radians(-38) * side), parent=parent)

    # Nose (small rounded triangle) and the little "w" mouth.
    uv_sphere("Nose", (0, -0.64, 1.335), (0.045, 0.025, 0.03), mats["nose"],
              parent=parent)
    build_mouth(mats, parent)


def build_mouth(mats, parent):
    curve = bpy.data.curves.new("Mouth", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.008
    curve.bevel_resolution = 3
    spline = curve.splines.new("BEZIER")
    pts = [(-0.08, -0.625, 1.285), (-0.04, -0.645, 1.265),
           (0.0, -0.648, 1.30), (0.04, -0.645, 1.265), (0.08, -0.625, 1.285)]
    spline.bezier_points.add(len(pts) - 1)
    for bp, co in zip(spline.bezier_points, pts):
        bp.co = co
        bp.handle_left_type = bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new("Mouth", curve)
    obj.data.materials.append(mats["mouth"])
    link(obj, parent)


def build_collar(mats, parent):
    # A beveled NURBS loop instead of a torus so it can follow the neck slope.
    curve = bpy.data.curves.new("Collar", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.055
    curve.bevel_resolution = 4
    spline = curve.splines.new("NURBS")
    n = 24
    spline.points.add(n - 1)
    for i, p in enumerate(spline.points):
        a = 2 * math.pi * i / n
        # Lower at the front so the pendant hangs on the chest.
        z = 1.00 - 0.06 * max(0.0, -math.sin(a)) + 0.02 * math.sin(a)
        p.co = (0.43 * math.cos(a), 0.40 * math.sin(a), z, 1.0)
    spline.use_cyclic_u = True
    spline.order_u = 4
    obj = bpy.data.objects.new("Collar", curve)
    obj.data.materials.append(mats["collar"])
    link(obj, parent)

    # Bow at the back-side like the 2D art's ribbon.
    for side in (-1, 1):
        uv_sphere(f"CollarBow_{'L' if side < 0 else 'R'}",
                  (0.16 * side, 0.43, 1.03), (0.13, 0.05, 0.08), mats["collar"],
                  rotation=(0, math.radians(20) * side, 0), parent=parent)
    uv_sphere("CollarBowKnot", (0, 0.45, 1.03), (0.05, 0.05, 0.05),
              mats["collar"], parent=parent)

    # Gold ring + heart pendant with a nurse cross.
    ring = bpy.data.curves.new("PendantRing", "CURVE")
    ring.dimensions = "3D"
    ring.bevel_depth = 0.012
    s = ring.splines.new("NURBS")
    s.points.add(11)
    for i, p in enumerate(s.points):
        a = 2 * math.pi * i / 12
        p.co = (0.035 * math.cos(a), -0.455, 0.905 + 0.035 * math.sin(a), 1.0)
    s.use_cyclic_u = True
    s.order_u = 4
    ring_obj = bpy.data.objects.new("PendantRing", ring)
    ring_obj.data.materials.append(mats["gold"])
    link(ring_obj, parent)

    build_heart(mats, parent, center=Vector((0, -0.47, 0.78)), size=0.13)


def build_heart(mats, parent, center, size):
    """Extruded heart made from a closed bezier outline in the XZ plane."""
    curve = bpy.data.curves.new("HeartPendant", "CURVE")
    curve.dimensions = "2D"
    curve.fill_mode = "BOTH"
    # Extrude/bevel are in the object's local (unscaled) space.
    curve.extrude = 0.18
    curve.bevel_depth = 0.12
    curve.bevel_resolution = 3
    spline = curve.splines.new("BEZIER")
    # (point, left handle, right handle) in unit space, heart pointing down.
    outline = [
        ((0.0, 0.55), (0.35, 1.05), (-0.35, 1.05)),
        ((-0.95, 0.45), (-0.95, 1.05), (-0.95, -0.05)),
        ((0.0, -0.95), (-0.35, -0.55), (0.35, -0.55)),
        ((0.95, 0.45), (0.95, -0.05), (0.95, 1.05)),
    ]
    spline.bezier_points.add(len(outline) - 1)
    for bp, (co, hl, hr) in zip(spline.bezier_points, outline):
        bp.co = (co[0], co[1], 0)
        bp.handle_left_type = bp.handle_right_type = "FREE"
        bp.handle_left = (hl[0], hl[1], 0)
        bp.handle_right = (hr[0], hr[1], 0)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new("HeartPendant", curve)
    obj.location = center
    obj.rotation_euler = (math.radians(90) + math.radians(-8), 0, 0)
    obj.scale = (size, size, size)
    obj.data.materials.append(mats["heart"])
    link(obj, parent)

    # White nurse cross on the front face (local +Z faces the viewer).
    for i, dims in enumerate(((0.62, 0.2), (0.2, 0.62))):
        bpy.ops.mesh.primitive_cube_add(size=1.0)
        bar = bpy.context.active_object
        bar.name = f"HeartCross_{i}"
        bar.data.materials.append(mats["cross"])
        bar.parent = obj
        bar.location = (0, 0.05, 0.28)
        bar.scale = (dims[0], dims[1], 0.08)
        bevel = bar.modifiers.new("Bevel", "BEVEL")
        bevel.width = 0.03
        bevel.segments = 3


# --------------------------------------------------------- scene / output ---

def setup_scene():
    scene = bpy.context.scene
    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    bg = nodes["Background"]
    bg.inputs["Color"].default_value = (0.9, 0.9, 0.92, 1.0)
    bg.inputs["Strength"].default_value = 0.6
    backdrop = nodes.new("ShaderNodeBackground")
    backdrop.inputs["Color"].default_value = (1.0, 0.90, 0.92, 1.0)
    light_path = nodes.new("ShaderNodeLightPath")
    mix = nodes.new("ShaderNodeMixShader")
    links.new(light_path.outputs["Is Camera Ray"], mix.inputs["Fac"])
    links.new(bg.outputs["Background"], mix.inputs[1])
    links.new(backdrop.outputs["Background"], mix.inputs[2])
    links.new(mix.outputs["Shader"], nodes["World Output"].inputs["Surface"])
    scene.world = world

    key = bpy.data.lights.new("Key", "AREA")
    key.energy = 320
    key.size = 3.0
    key_obj = bpy.data.objects.new("Key", key)
    key_obj.location = (-2.5, -3.5, 4.0)
    key_obj.rotation_euler = (math.radians(50), 0, math.radians(-35))
    link(key_obj)

    rim = bpy.data.lights.new("Rim", "AREA")
    rim.energy = 180
    rim.size = 2.0
    rim.color = (1.0, 0.9, 0.95)
    rim_obj = bpy.data.objects.new("Rim", rim)
    rim_obj.location = (2.5, 3.0, 3.0)
    rim_obj.rotation_euler = (math.radians(-55), 0, math.radians(140))
    link(rim_obj)

    # Soft floor shadow catcher.
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.03))
    floor = bpy.context.active_object
    floor.name = "Floor"
    floor.is_shadow_catcher = True
    floor.hide_viewport = False

    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = 60
    cam = bpy.data.objects.new("Camera", cam_data)
    link(cam)
    scene.camera = cam
    return cam, floor


def aim_camera(cam, location, target=(0, 0, 1.1)):
    cam.location = location
    direction = Vector(target) - Vector(location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render(cam, name, location):
    scene = bpy.context.scene
    aim_camera(cam, location)
    os.makedirs(os.path.join(HERE, "renders"), exist_ok=True)
    scene.render.filepath = os.path.join(HERE, "renders", name)
    bpy.ops.render.render(write_still=True)


def configure_render():
    import addon_utils
    addon_utils.enable("cycles", default_set=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 768
    scene.render.resolution_y = 896
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = -0.45


def main():
    reset_scene()
    mats = build_materials()
    body = build_body(mats)
    build_ears(mats, body)
    build_head_tuft(mats, body)
    build_face(mats, body)
    build_collar(mats, body)
    cam, floor = setup_scene()

    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "chibiru.blend"))

    # glTF: export only the character (no floor / lights / camera).
    bpy.ops.object.select_all(action="DESELECT")
    for obj in bpy.context.scene.objects:
        if obj.type in {"MESH", "CURVE"} and obj is not floor:
            obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(HERE, "chibiru.glb"),
                              export_format="GLB", use_selection=True,
                              export_apply=True)

    if RENDER:
        configure_render()
        render(cam, "chibiru_front.png", (0, -7.2, 1.6))
        render(cam, "chibiru_three_quarter.png", (4.8, -5.4, 2.1))


if __name__ == "__main__":
    main()
