# Feasibility probe: WebGPU inside `SandboxedFrame` (2026-11-05)

Setup: Hermes Desktop (Electron 44.9.3, Chrome 152), Windows 11, RTX 3070, three.js r187.
The probe was a throwaway desktop plugin that mounted `SandboxedFrame` and ran
checks plus a benchmark (20k instanced boxes, shadows, 640x400). Raw output is in `results/`.

## Answer

| Frame source | Secure context | `navigator.gpu` | What three r187 uses |
|---|---|---|---|
| `data:text/html` (the documented path) | **no** | **absent** | `WebGPURenderer` drops to its WebGL2 backend |
| `http://127.0.0.1:<port>/…` (or https) | yes | yes (NVIDIA Ampere adapter, not fallback) | real WebGPU backend |

So WebGPU **does not** run in a `data:` SandboxedFrame. It **does** run when the frame page
comes from a loopback or https URL. The gateway serves `/dashboard-plugins/<id>/<file>`
without auth (for .html/.js/.json and similar), so a unified package can host its own stage page.
That only works when the Python half is enabled and the backend is local or https.

## Benchmark (back-to-back frames, GPU-synced)

| Renderer | Backend | First frame (shader compile) | ms/frame |
|---|---|---|---|
| WebGPURenderer | WebGPU | 1545 ms | 1.04 |
| WebGPURenderer forceWebGL | WebGL2 | 218 ms | 0.53 |
| WebGLRenderer (classic) | WebGL2 | 79 ms | 1.17 |

This scene is too light to separate the backends on this GPU. The real difference is in
features and startup time: WebGPU's first frame was about 7x slower to compile.
The rAF fps test was throttled because the Hermes window was not visible, so there's no fps number.

## What the WebGL fallback loses (measured with TSL in r187)

- Compute with storage buffers: still works (WebGL backend emulates it).
- Compute atomics: **returns a wrong result (0) silently**, with no error.
- Storage textures (`textureStore`): **throws** ("Uniform storageTexture not implemented").
- Adapter features only exposed by WebGPU: subgroups, shader-f16, timestamp-query,
  indirect-first-instance, dual-source blending, BC-sliced-3D, etc.
- Classic `WebGLRenderer` cannot run TSL / node materials at all.

## Other frame constraints (both modes)

- `document.fullscreenEnabled` is false (no `allow="fullscreen"`), so the host must fullscreen the wrapper.
- `localStorage` / `indexedDB` throw `SecurityError` (opaque origin).
- Blob module imports and import maps work. Blob workers work but have no `navigator.gpu`.
- `canvas.toDataURL()` works (screenshots are possible on every backend).
- `SharedArrayBuffer` is unavailable (not cross-origin isolated).
- Hermes turns GPU acceleration off on remote displays and after certain Windows GPU crashes,
  so some users will get WebGL through SwiftShader regardless.
