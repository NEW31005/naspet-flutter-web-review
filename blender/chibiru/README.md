# Chibiru 3D (v1)

A procedural Blender model of Chibiru, NasPet's base-form child cat, built from the 2D art in `assets/assets/pets/chibiru/`.

| File | Contents |
| --- | --- |
| `build_chibiru.py` | Builds the whole model from code. Re-run it after changing any shape. |
| `chibiru.blend` | Blender scene with the model, lights, camera and shadow-catcher floor |
| `chibiru.glb` | Character only (no floor, lights or camera), ready for three.js or Flutter 3D viewers |
| `renders/` | Front and three-quarter preview renders (Cycles) |

## Rebuild

```bash
# With Blender installed
blender --background --python blender/chibiru/build_chibiru.py

# Or with the pip module (pip install bpy, Python 3.11)
python3 blender/chibiru/build_chibiru.py            # model + renders (~2 min on CPU)
python3 blender/chibiru/build_chibiru.py --no-render  # model only
```

## How it is built

- **Body**: the head, cheek ruff, torso, arms, legs and tail start as about 25 overlapping ellipsoids. A voxel remesh fuses them into one watertight mesh, and a Laplacian smooth rounds off the seams.
- **Face**: glossy dark-brown eyes with amber irises and two highlights each, blush, a pink nose, and a "ω" mouth drawn as a bezier curve.
- **Accessories**: a lavender collar with a bow at the back, and a pink heart pendant with a white nurse cross.
- Coordinates: Z is up, the model faces -Y, and it is about 2.3 units tall.

## Next steps

- Rigging: an armature and weight paint, so it can play the 2D motions (idle, blink, walk, eat).
- Fur: switch to hair curves or a fur texture.
- Evolved forms: branch off the same script into Hamuru, Kokoru, Mimiru and Rugaru.
