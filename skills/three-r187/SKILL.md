---
name: three-r187
description: Write correct three.js r187 scenes for three_scene.
---

# three.js r187 scenes for `three_scene`

`three_scene` shows a live 3D scene in the chat. In Hermes Desktop it runs inside a sandboxed
card with orbit controls. Everywhere else the user gets a standalone HTML file. Your code is
one ES module. The card owns the renderer, canvas, camera controls, resizing and the animation
loop. You add content.

## The contract

```js
import * as THREE from 'three'              // = 'three/webgpu' (WebGPURenderer build)
import { color, time, sin, positionLocal } from 'three/tsl'

export default function (stage) {
  const { scene, camera, renderer, controls, onFrame } = stage

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(5, 8, 4)
  scene.add(sun)

  const mesh = new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 200, 32),
                              new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.4 }))
  mesh.material.colorNode = color(0x4f8cff).mul(sin(time).mul(0.25).add(0.75))
  scene.add(mesh)

  onFrame((dt, t) => { mesh.rotation.y += dt * 0.5 })

  return () => { mesh.geometry.dispose(); mesh.material.dispose() } // optional cleanup
}
```

`stage` gives you:

| Field | What it is |
|---|---|
| `THREE` | the `three/webgpu` namespace (same as `import * as THREE from 'three'`) |
| `TSL` | the `three/tsl` namespace |
| `scene` | an empty `Scene`. With no background the card's theme colour shows behind it. Set `scene.background` if you want your own. |
| `camera` | `PerspectiveCamera(50, aspect, 0.1, 2000)` at (4, 3, 6). If you leave the camera and `controls.target` untouched, the card frames the scene's bounding box for you after setup. |
| `renderer` | an initialised `WebGPURenderer`. Do not call `init()`, `setSize()` or `setAnimationLoop()`. |
| `controls` | `OrbitControls` with damping, already updated every frame |
| `canvas` | the canvas element |
| `backend` | `'WebGPU'` or `'WebGL2'` |
| `onFrame(fn)` | `fn(dt, t)` runs every frame before rendering (seconds) |
| `setRender(fn)` | replace the default `renderer.render(scene, camera)`, for post-processing |
| `width`, `height` | current size in CSS pixels |

`export default` may be `async` and has 20 s to finish. Throwing (or rejecting) shows an error
on the card.

## Showing a model file

To show a `.glb`, `.gltf`, `.stl` or `.obj` file, call `three_scene` with `model` set to its path.
No code is needed: the card loads it, lights it, frames it and plays its first animation. Prefer
an absolute path. `.bin`, `.mtl` and texture files beside the model are picked up automatically.

To customise a model, pass `code` as well. The default export then also gets:

| Field | What it is |
|---|---|
| `stage.model` | the loaded `Object3D`, already in the scene |
| `stage.animations` | its `AnimationClip`s |
| `stage.mixer` | an `AnimationMixer` playing the first clip, if the model has any |

```js
export default function (stage) {
  stage.model.traverse((o) => { if (o.isMesh) o.material.wireframe = true })
  stage.onFrame((dt) => { stage.model.rotation.y += dt * 0.3 })
}
```

To change a model scene later, reuse the stored model with `model: "scene:<scene_id>"` instead of
the original path. Models are limited to 50 MB. Draco, meshopt and KTX2/Basis compressed glTF files
are refused: ask the user for an uncompressed export. STL files are rotated from Z-up to Y-up.

## Backends: assume WebGL2

Desktop cards usually run `WebGPURenderer` on its **WebGL2 backend**, because the sandboxed
frame is not a secure context. Write scenes that work on both backends:

- Use regular materials (`MeshStandardMaterial`, `MeshPhysicalMaterial`, …) or node materials
  (`MeshStandardNodeMaterial` + TSL nodes such as `colorNode`, `positionNode`, `emissiveNode`).
- **Never** use `WebGLRenderer`, `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile` or
  GLSL strings. They do not work with `WebGPURenderer`.
- TSL compute with storage buffers (`instancedArray`, `Fn`, `instanceIndex`,
  `renderer.compute(node)` / `await renderer.computeAsync(node)`) works on both backends.
- **WebGPU only:** atomics (`atomicAdd`, `.toAtomic()`) silently return 0 on WebGL2.
  `StorageTexture` / `textureStore` throw on WebGL2. Guard them with
  `if (stage.backend === 'WebGPU')` and keep a WebGL2 path.
- `PostProcessing` was renamed `RenderPipeline` in r183. Use `RenderPipeline`.
- `LineLoop` is not supported by `WebGPURenderer`. Use `Line` and repeat the first point at the end.

## Imports

Only these resolve:

- `three` and `three/webgpu` (the same module), and `three/tsl`
- `three/addons/<path>`:
  `controls/OrbitControls.js`, `loaders/GLTFLoader.js`, `loaders/STLLoader.js`,
  `loaders/OBJLoader.js`, `loaders/MTLLoader.js`, `utils/BufferGeometryUtils.js`, `utils/SkeletonUtils.js`,
  `environments/RoomEnvironment.js`, `geometries/RoundedBoxGeometry.js`,
  `geometries/ParametricGeometry.js`, `geometries/ParametricFunctions.js`,
  `geometries/ConvexGeometry.js`, `geometries/TeapotGeometry.js`, `math/ImprovedNoise.js`,
  `math/SimplexNoise.js`, `math/ConvexHull.js`, `objects/SkyMesh.js`,
  `tsl/display/BloomNode.js`

`three/examples/jsm/...` is the old spelling. Use `three/addons/...`.

## Sandbox rules

- **No network (the card blocks it):** no `fetch`, no loading textures, models or fonts from URLs. Generate
  geometry and textures in code (`DataTexture`, `CanvasTexture` with an `OffscreenCanvas`, TSL
  noise such as `mx_noise_float`).
- **No storage:** `localStorage` and `indexedDB` throw. Do not touch `document.body` layout.
  Do not create canvases for display.
- **No `requestAnimationFrame` and no `setAnimationLoop`.** Use `onFrame`. The card pauses the
  loop when the card scrolls out of view.
- Keep `code` under 200 KB. Do not inline big arrays; compute them.

## Recipes

**Environment lighting (reflections on metals):**
```js
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
const pmrem = new THREE.PMREMGenerator(renderer)
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
```

**Shadows:**
```js
renderer.shadowMap.enabled = true
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048)
mesh.castShadow = true; ground.receiveShadow = true
```

**Many objects:** use `InstancedMesh`. Call `setMatrixAt` / `setColorAt`, then
`mesh.instanceMatrix.needsUpdate = true`.

**Bloom:**
```js
import { pass } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
const pipeline = new THREE.RenderPipeline(renderer)
const scenePass = pass(scene, camera)
pipeline.outputNode = scenePass.add(bloom(scenePass, 0.8, 0.4, 0.2))
stage.setRender(() => pipeline.render())
```
Bloom washes a scene out quickly. Keep strength around 0.3 to 0.5, threshold at 0.7 or higher, and
give only small accents an emissive colour. Don't bloom a large glowing object: the arguments
above are a starting point for a dark scene with small bright details.

**Animated TSL material:**
```js
import { time, positionLocal, normalLocal, sin, color, mix } from 'three/tsl'
const m = new THREE.MeshStandardNodeMaterial()
m.positionNode = positionLocal.add(normalLocal.mul(sin(time.add(positionLocal.y.mul(4))).mul(0.1)))
m.colorNode = mix(color(0x2244ff), color(0xff4422), sin(time).mul(0.5).add(0.5))
```

## The dry run

When Hermes Desktop is open, `three_scene` runs your scene for one simulated second in a hidden
frame before it returns:

- `success: false` with `runtime_errors`: the scene crashed and was not shown. Fix the cause and
  call `three_scene` again before you reply. After three failures in a row it is shown anyway with
  its error, so say plainly what is wrong.
- `verification.status: "passed"`: it ran. Read `verification.warnings`. They say when it drew
  nothing or came out almost black, which you should fix too.
- `"unverified"` or `"timeout"`: no dry run finished, for example in the CLI. Don't claim the scene
  was tested.

## When the card reports an error

The user may press **Fix with Hermes**. You then get the error kind (`syntax`, `setup`,
`runtime`, `load`, `model`, `console`), the message, and the failing line with its neighbours. Fix
the cause, don't wrap it in try/catch, and call `three_scene` again with the complete corrected
module. If `three_scene` itself returns `problems`, those come from static checks: fix every
item and call it again.
