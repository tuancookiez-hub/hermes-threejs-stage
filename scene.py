"""three_scene tool: checks a three.js r187 scene or 3D model, stores it, returns a MEDIA: line.

Every surface gets a standalone HTML file (it loads three.js from jsDelivr when opened). Hermes
Desktop draws the same scene live in a sandboxed chat card instead, with three.js served by this
plugin's own backend, so the card itself needs no network.
"""

from __future__ import annotations

import base64
import datetime
import json
import os
import re
import secrets
import shutil
import struct
import time
from pathlib import Path, PurePosixPath
from urllib.parse import unquote

PLUGIN = "three-stage"
TOOL = "three_scene"
MAX_CODE_BYTES = 200_000
MAX_TITLE = 80
CDN_BASE = "https://cdn.jsdelivr.net/npm/three@0.187.0/"
_ROOT = Path(__file__).resolve().parent
_ID_RE = re.compile(r"[a-z0-9]{12}")
MAX_MODEL_BYTES = 50_000_000
# Above this the exported HTML would be too big to send, so the model file itself is delivered.
MAX_EMBED_BYTES = 25_000_000
MODEL_KINDS = {".glb": "glb", ".gltf": "gltf", ".stl": "stl", ".obj": "obj"}
SIBLING_EXTS = {".bin", ".png", ".jpg", ".jpeg", ".webp", ".mtl"}
# These need decoder binaries (wasm), which this package does not ship.
UNSUPPORTED_EXTENSIONS = {
    "KHR_draco_mesh_compression": "Draco compression",
    "EXT_meshopt_compression": "meshopt compression",
    "KHR_meshopt_compression": "meshopt compression",
    "KHR_texture_basisu": "KTX2/Basis textures",
}
EMPTY_SCENE = "export default function () {}\n"
# Desktop has this long to claim a dry run; with no Desktop attached this is all the tool waits.
CLAIM_SECONDS = 2.5
# Once claimed, how long the dry run may take before the tool gives up and reports it as unverified.
RESULT_SECONDS = 16.0
PENDING_MAX_AGE = 30.0
STALE_VERIFY_AGE = 120.0
# After this many failed dry runs in a row, show the scene anyway so the user can see the problem.
MAX_FAILED_RUNS = 3
_failed_runs: dict[str, int] = {}


def _public_addons() -> list[str]:
    manifest = json.loads((_ROOT / "vendor" / "three" / "manifest.json").read_text(encoding="utf-8"))
    return list(manifest["public"])


SCHEMA = {
    "name": TOOL,
    "description": (
        "Show a live, interactive three.js r187 3D scene, or a GLB/GLTF/STL/OBJ model file, inline in "
        "the chat (Hermes Desktop draws it with orbit controls; other surfaces get a standalone HTML "
        "file). Use it whenever a 3D visual, simulation, model or diagram would help. To show a "
        "model file, pass `model` (no code needed). To customise it, also pass `code`: the loaded "
        "model is stage.model. Before writing code the first time in a "
        "session, load the skill `three-stage:three-r187` for the full contract. Contract: `code` is "
        "an ES module that does `export default function (stage) {...}`; `stage` gives THREE "
        "(three/webgpu), TSL, scene, camera, renderer (an initialised WebGPURenderer, which may run "
        "on its WebGL2 backend), controls (OrbitControls), canvas, backend ('WebGPU'|'WebGL2') and "
        "onFrame(fn(dt, t)). Do not create a renderer, canvas or animation loop, do not use "
        "WebGLRenderer, ShaderMaterial or GLSL, and do not use the network or storage. Add your own "
        "lights. Imports allowed: 'three', 'three/webgpu', 'three/tsl', and 'three/addons/<path>' "
        "for the bundled addons. When Hermes Desktop is attached the scene is dry-run before this "
        "tool returns: `success: false` with `runtime_errors` means it crashed, so fix it and call "
        "again before replying. `verification.warnings` means it ran but may look wrong (blank or "
        "too dark); fix that too. On success put the result's media_tag line on its own line in "
        "your reply. If the user reports an error from the card, fix the code and call this tool again."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Short scene title shown on the card (max 80 chars). Defaults to the model file name."},
            "code": {"type": "string", "description": "The scene ES module source (see the tool description). Optional when `model` is given."},
            "model": {"type": "string", "description": "Path to a .glb, .gltf, .stl or .obj file on this machine (absolute is safest). Its .bin, .mtl and texture files are picked up automatically. Use 'scene:<scene_id>' to reuse the model from an earlier three_scene call."},
        },
        "required": [],
    },
}

_IMPORT_RE = re.compile(r"""(?:^|[;\s])(?:import\s*(?:[\w*{}\s,$]+\s*from\s*)?|export\s*[\w*{}\s,$]+\s*from\s*)['"]([^'"]+)['"]""")
_DYNAMIC_IMPORT_RE = re.compile(r"""\bimport\s*\(""")
_EXPORT_DEFAULT_RE = re.compile(r"\bexport\s+default\b")

# (pattern, message, is_error)
_CHECKS = [
    (re.compile(r"\bnew\s+(?:THREE\.)?WebGLRenderer\b"), "Do not create a WebGLRenderer: use stage.renderer (a WebGPURenderer).", True),
    (re.compile(r"\bnew\s+(?:THREE\.)?WebGPURenderer\b"), "Do not create a renderer: use stage.renderer.", True),
    (re.compile(r"\b(?:ShaderMaterial|RawShaderMaterial)\b"), "ShaderMaterial/RawShaderMaterial (GLSL) do not work with WebGPURenderer: use node materials and TSL.", True),
    (re.compile(r"\bnew\s+(?:THREE\.)?LineLoop\b"), "LineLoop is not supported by WebGPURenderer: use THREE.Line and repeat the first point at the end.", True),
    (re.compile(r"\bonBeforeCompile\b"), "onBeforeCompile (GLSL patching) does not work with WebGPURenderer: use TSL node materials.", True),
    (re.compile(r"\b(?:localStorage|sessionStorage|indexedDB)\b"), "Storage APIs throw inside the sandboxed card.", True),
    (re.compile(r"\bdocument\.body\.appendChild\s*\(\s*renderer\.domElement"), "The canvas is already mounted: do not append renderer.domElement.", True),
    (re.compile(r"\brequestAnimationFrame\s*\("), "Use stage.onFrame(fn) instead of requestAnimationFrame; the card owns the loop (it pauses offscreen).", True),
    (re.compile(r"\bsetAnimationLoop\s*\("), "The card owns the animation loop: use stage.onFrame(fn).", True),
    (re.compile(r"\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b"), "Network access is blocked inside the card; generate data in code.", False),
    (re.compile(r"\b(?:atomicAdd|atomicSub|atomicMax|atomicMin|atomicStore|toAtomic)\b"), "Atomics only work on the WebGPU backend; on WebGL2 they silently return 0. Check stage.backend and provide a fallback.", False),
    (re.compile(r"\b(?:StorageTexture|textureStore)\b"), "Storage textures only work on the WebGPU backend (WebGL2 throws). Check stage.backend.", False),
    (re.compile(r"\bnew\s+(?:THREE\.)?(?:TextureLoader|GLTFLoader|FontLoader)\s*\([^)]*\)\s*\.load\s*\(\s*['\"]https?:"), "Scenes cannot load remote URLs; build geometry and textures in code.", False),
]


def check_code(code: str) -> tuple[list[str], list[str]]:
    """Static checks that catch the mistakes models make with r187. Returns (errors, warnings)."""
    errors: list[str] = []
    warnings: list[str] = []
    if not _EXPORT_DEFAULT_RE.search(code):
        errors.append("Missing `export default function (stage) { ... }`.")
    allowed = {"three", "three/webgpu", "three/tsl"} | {f"three/addons/{a}" for a in _public_addons()}
    for spec in _IMPORT_RE.findall(code):
        if spec not in allowed:
            hint = ""
            if spec.startswith("three/examples/jsm/"):
                hint = f" Use 'three/addons/{spec[len('three/examples/jsm/'):]}'."
            elif spec.startswith("three/addons/"):
                hint = " That addon is not bundled. Bundled addons: " + ", ".join(sorted(_public_addons())) + "."
            errors.append(f"Import '{spec}' is not available.{hint}")
    if _DYNAMIC_IMPORT_RE.search(code):
        warnings.append("Dynamic import() only resolves the same specifiers as static imports.")
    for pattern, message, is_error in _CHECKS:
        if pattern.search(code):
            (errors if is_error else warnings).append(message)
    return errors, warnings


def _data_dir() -> Path:
    from plugins.plugin_storage import plugin_data_dir

    return plugin_data_dir(PLUGIN)


def _media_dir() -> Path:
    """Delivered files go under cache/generated (a MEDIA: delivery root the gateway does not sweep)."""
    from hermes_constants import get_hermes_home

    directory = get_hermes_home() / "cache" / "generated" / PLUGIN
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def scene_record_path(scene_id: str) -> Path | None:
    if not isinstance(scene_id, str) or not _ID_RE.fullmatch(scene_id):
        return None
    return _data_dir() / "scenes" / f"{scene_id}.json"


class ModelError(ValueError):
    """A model that cannot be shown; the message goes back to the model as the tool error."""


def _models_dir() -> Path:
    return _data_dir() / "models"


def _glb_json(path: Path) -> dict:
    with path.open("rb") as fh:
        header = fh.read(20)
        if len(header) < 20 or header[:4] != b"glTF":
            raise ModelError(f"{path.name} is not a valid GLB file.")
        length, chunk_type = struct.unpack("<I4s", header[12:20])
        if chunk_type != b"JSON" or length > path.stat().st_size:
            raise ModelError(f"{path.name} is not a valid GLB file (no JSON chunk).")
        try:
            return json.loads(fh.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ModelError(f"{path.name} is not a valid GLB file (unreadable JSON chunk).") from exc


def _gltf_refs(doc: dict) -> list[str]:
    blocked = sorted({UNSUPPORTED_EXTENSIONS[e] for e in doc.get("extensionsRequired", []) if e in UNSUPPORTED_EXTENSIONS})
    if blocked:
        raise ModelError(f"This model needs {', '.join(blocked)}, which three-stage does not support. "
                         "Export it again without compression.")
    refs = []
    for entry in (doc.get("buffers") or []) + (doc.get("images") or []):
        uri = entry.get("uri") if isinstance(entry, dict) else None
        if isinstance(uri, str) and uri and not uri.startswith("data:"):
            refs.append(unquote(uri))
    return refs


def _clean_rel(base: Path, rel: str) -> tuple[str, Path] | None:
    """A sibling path that stays inside the model's folder and has an allowed type, else None."""
    rel = rel.replace("\\", "/")
    target = (base / rel).resolve()
    if not target.is_relative_to(base.resolve()) or target.suffix.lower() not in SIBLING_EXTS:
        return None
    return target.relative_to(base.resolve()).as_posix(), target


def _obj_refs(path: Path, base: Path) -> tuple[list[str], list[str]]:
    """OBJ sibling files (.mtl, then the textures they name) and warnings for any that are missing."""
    refs: list[str] = []
    warnings: list[str] = []
    text = path.read_text(encoding="utf-8", errors="replace")
    if not re.search(r"^\s*v\s", text, re.M):
        raise ModelError(f"{path.name} has no vertices, so it is not a usable OBJ file.")
    for name in re.findall(r"^\s*mtllib\s+(.+?)\s*$", text, re.M):
        cleaned = _clean_rel(base, name)
        if not cleaned or not cleaned[1].is_file():
            warnings.append(f"Material file '{name}' was not found; the model will use a default material.")
            continue
        refs.append(cleaned[0])
        mtl = cleaned[1].read_text(encoding="utf-8", errors="replace")
        for tex in re.findall(r"^\s*(?:map_\w+|bump|disp|norm)\s+(?:.*\s)?(\S+)\s*$", mtl, re.M | re.I):
            found = _clean_rel(base, tex)
            if found and found[1].is_file():
                refs.append(found[0])
            else:
                warnings.append(f"Texture '{tex}' was not found.")
    return refs, warnings


def _resolve_source(spec: str) -> Path:
    spec = spec.strip()
    match = re.fullmatch(r"scene:([a-z0-9]{12})", spec)
    if match:
        record = scene_record_path(match.group(1))
        info = json.loads(record.read_text(encoding="utf-8")).get("model") if record and record.is_file() else None
        if not info:
            raise ModelError(f"No stored model for {spec}.")
        return _models_dir() / match.group(1) / info["main"]
    path = Path(spec).expanduser()
    if not path.is_absolute():
        path = Path(os.environ.get("TERMINAL_CWD") or Path.cwd()) / path
    return path


def collect_model(spec: str) -> tuple[dict, list[Path], list[str]]:
    """Validate a model and list its files. Returns (info, source paths, warnings)."""
    path = _resolve_source(spec)
    kind = MODEL_KINDS.get(path.suffix.lower())
    if not kind:
        raise ModelError("`model` must be a .glb, .gltf, .stl or .obj file.")
    if not path.is_file():
        raise ModelError(f"Model file not found: {path}. Pass an absolute path.")
    path = path.resolve()
    if path.stat().st_size > MAX_MODEL_BYTES:
        raise ModelError(f"The model is {path.stat().st_size / 1e6:.1f} MB; the limit is {MAX_MODEL_BYTES // 1_000_000} MB.")
    base = path.parent
    refs: list[str] = []
    warnings: list[str] = []
    if kind == "glb":
        refs = _gltf_refs(_glb_json(path))
    elif kind == "gltf":
        try:
            refs = _gltf_refs(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ModelError(f"{path.name} is not valid glTF JSON: {exc}") from exc
    elif kind == "stl":
        with path.open("rb") as fh:
            head = fh.read(84)
        size = path.stat().st_size
        binary = len(head) == 84 and size == 84 + 50 * struct.unpack("<I", head[80:84])[0]
        if not binary and not head.lstrip().lower().startswith(b"solid"):
            raise ModelError(f"{path.name} is not a valid STL file.")
    else:
        refs, warnings = _obj_refs(path, base)

    sources = [path]
    rels = [path.name]
    for ref in dict.fromkeys(refs):
        cleaned = _clean_rel(base, ref)
        if not cleaned:
            raise ModelError(f"Model reference '{ref}' is outside the model's folder or an unsupported file type.")
        rel, target = cleaned
        if not target.is_file():
            raise ModelError(f"Model reference '{ref}' was not found next to {path.name}.")
        if rel not in rels:
            rels.append(rel)
            sources.append(target)
    total = sum(p.stat().st_size for p in sources)
    if total > MAX_MODEL_BYTES:
        raise ModelError(f"The model is {total / 1e6:.1f} MB; the limit is {MAX_MODEL_BYTES // 1_000_000} MB.")
    return {"kind": kind, "main": path.name, "files": rels, "bytes": total}, sources, warnings


def store_model(scene_id: str, info: dict, sources: list[Path]) -> None:
    folder = _models_dir() / scene_id
    for rel, source in zip(info["files"], sources):
        target = folder.joinpath(*PurePosixPath(rel).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)


def model_payload(scene_id: str, info: dict) -> dict:
    """The stored model as base64 strings, for the card and the exported HTML."""
    folder = _models_dir() / scene_id
    files = {rel: base64.b64encode(folder.joinpath(*PurePosixPath(rel).parts).read_bytes()).decode("ascii")
             for rel in info["files"]}
    return {"kind": info["kind"], "main": info["main"], "bytes": info["bytes"], "files": files}


def standalone_html(title: str, code: str, model: dict | None = None) -> str:
    guest = (_ROOT / "stage" / "guest.html").read_text(encoding="utf-8")
    boot = json.dumps({"title": title, "code": code, "cdn": CDN_BASE, "model": model}).replace("</", "<\\/")
    return guest.replace("<script>", f"<script>window.__THREE_STAGE__ = {boot};</script>\n<script>", 1)


def _verify_dir() -> Path:
    directory = _data_dir() / "verify"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _clear_verify(scene_id: str) -> None:
    for suffix in ("pending", "claim", "result"):
        (_verify_dir() / f"{scene_id}.{suffix}").unlink(missing_ok=True)


def request_verify(scene_id: str) -> None:
    path = _verify_dir() / f"{scene_id}.pending"
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"id": scene_id, "at": time.time()}), encoding="utf-8")
    os.replace(temp, path)


def claim_next_verify() -> str | None:
    """Claim the oldest waiting dry run for one Desktop window. Exclusive create decides races
    between windows. Returns the scene id, or None when nothing is waiting."""
    now = time.time()
    waiting = []
    for path in _verify_dir().iterdir():  # leftovers from a tool call or window that went away
        try:
            if path.suffix != ".pending" and now - path.stat().st_mtime > STALE_VERIFY_AGE:
                path.unlink(missing_ok=True)
        except OSError:
            pass
    for path in _verify_dir().glob("*.pending"):
        info = _read_json(path)
        if not info or now - float(info.get("at", 0)) > PENDING_MAX_AGE:
            path.unlink(missing_ok=True)
            continue
        waiting.append((info["at"], info["id"], path))
    for _, scene_id, path in sorted(waiting):
        try:
            with (_verify_dir() / f"{scene_id}.claim").open("x", encoding="utf-8") as fh:
                fh.write(str(now))
        except FileExistsError:
            continue
        path.unlink(missing_ok=True)
        return scene_id
    return None


def store_verify_result(scene_id: str, result: dict) -> bool:
    claim = _verify_dir() / f"{scene_id}.claim"
    if not claim.is_file():
        return False
    path = _verify_dir() / f"{scene_id}.result"
    temp = path.with_suffix(".tmptwo")
    temp.write_text(json.dumps(result), encoding="utf-8")
    os.replace(temp, path)
    return True


def wait_for_verify(scene_id: str, claim_seconds: float = CLAIM_SECONDS, result_seconds: float = RESULT_SECONDS) -> dict | None:
    """Wait for a Desktop dry run. None when no Desktop claimed it or the run did not finish."""
    folder = _verify_dir()
    deadline = time.monotonic() + claim_seconds
    claimed = False
    try:
        while time.monotonic() < deadline:
            if not claimed and (folder / f"{scene_id}.claim").is_file():
                claimed = True
                deadline = time.monotonic() + result_seconds
            result = _read_json(folder / f"{scene_id}.result") if claimed else None
            if result:
                return result
            time.sleep(0.1)
        return None
    finally:
        _clear_verify(scene_id)


def verify_warnings(result: dict) -> list[str]:
    """What a passing dry run can still say about how the scene looks."""
    pixels = result.get("pixels") or {}
    if not pixels:
        return []
    covered, luma, spread = pixels.get("covered", 0), pixels.get("meanLuma", 0), pixels.get("lumaRange", 0)
    if covered < 0.002 or (covered > 0.98 and spread < 4):
        return ["The scene ran but rendered nothing visible. Check that objects are in the scene and in front of the camera."]
    if luma < 6 and spread < 12:
        return ["The scene ran but is almost entirely black. Add lights, or use materials that do not need them."]
    return []


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "scene"


def _error(message: str, **extra) -> str:
    return json.dumps({"success": False, "error": message, **extra})


def as_bool(value, default: bool = True) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in ("false", "0", "no", "off", "")
    return default if value is None else bool(value)


def three_scene(args: dict, session_id: str = "", verify: bool = True, **_) -> str:
    try:
        code = args.get("code")
        model_spec = args.get("model")
        has_code = isinstance(code, str) and bool(code.strip())
        has_model = isinstance(model_spec, str) and bool(model_spec.strip())
        if not has_code and not has_model:
            return _error("Pass `code` (an ES module with `export default function (stage) {...}`), `model` (a file path), or both.")
        warnings: list[str] = []
        if has_code:
            if len(code.encode("utf-8")) > MAX_CODE_BYTES:
                return _error(f"`code` is larger than {MAX_CODE_BYTES // 1000} KB; generate geometry procedurally instead of inlining data.")
            errors, warnings = check_code(code)
            if errors:
                return _error("The scene did not pass the r187 checks. Fix these and call three_scene again.",
                              problems=errors, warnings=warnings)
        else:
            code = EMPTY_SCENE

        model_info = None
        sources: list[Path] = []
        if has_model:
            try:
                model_info, sources, model_warnings = collect_model(model_spec)
            except ModelError as exc:
                return _error(str(exc))
            warnings = warnings + model_warnings

        default_title = Path(model_info["main"]).stem if model_info else "3D scene"
        title = str(args.get("title") or "").strip()[:MAX_TITLE] or default_title
        scene_id = secrets.token_hex(6)
        created = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
        record = {"id": scene_id, "title": title, "code": code, "created": created, "session_id": session_id or ""}
        if model_info:
            store_model(scene_id, model_info, sources)
            record["model"] = model_info
        path = scene_record_path(scene_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding="utf-8")
        if verify:  # ask now: Desktop only polls for a few seconds after the tool starts
            request_verify(scene_id)

        stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"scene_{_slug(title)}_{stamp}_{scene_id}"
        if model_info and model_info["bytes"] > MAX_EMBED_BYTES:
            # Too big to embed: other surfaces get the model file; Desktop still draws the card.
            media_path = _media_dir() / f"{name}{Path(model_info['main']).suffix.lower()}"
            shutil.copyfile(_models_dir() / scene_id / model_info["main"], media_path)
        else:
            media_path = _media_dir() / f"{name}.html"
            payload = model_payload(scene_id, model_info) if model_info else None
            media_path.write_text(standalone_html(title, code, payload), encoding="utf-8")

        verification: dict = {"status": "skipped", "detail": "Dry runs are turned off in this plugin's settings."}
        note = ("Static checks passed, but the scene has not run yet. Hermes Desktop shows runtime "
                "errors on the card and the user can send them back to you.")
        if verify:
            outcome = wait_for_verify(scene_id)
            if outcome is None:
                verification = {"status": "unverified", "detail": "No Hermes Desktop window ran this scene in time."}
            elif outcome.get("status") == "failed":
                errors = outcome.get("errors") or []
                run_key = session_id or "default"
                _failed_runs[run_key] = _failed_runs.get(run_key, 0) + 1
                if _failed_runs[run_key] < MAX_FAILED_RUNS:
                    return _error("The scene crashed in a dry run in Hermes Desktop, so it was not shown. "
                                  "Fix the cause and call three_scene again.",
                                  scene_id=scene_id, backend=outcome.get("backend"),
                                  runtime_errors=errors, warnings=warnings)
                _failed_runs.pop(run_key, None)
                verification = {"status": "failed", "errors": errors}
                note = ("This scene still crashes, so it is being shown with its error on the card. "
                        "Tell the user what is wrong instead of claiming it works.")
            else:
                _failed_runs.pop(session_id or "default", None)
                verification = {key: outcome.get(key) for key in ("status", "backend", "frames", "drawCalls", "triangles")}
                verification["warnings"] = verify_warnings(outcome)
                logged = [e.get("message") for e in (outcome.get("errors") or []) if e.get("kind") == "console"][:3]
                if logged:
                    verification["console_errors"] = logged
                if outcome.get("status") == "passed":
                    note = "The scene ran without errors for one simulated second in Hermes Desktop."
                else:
                    note = "The dry run did not finish in time, so runtime errors are still possible."

        result_model = {k: model_info[k] for k in ("kind", "main", "bytes")} if model_info else None
        return json.dumps({
            "success": True,
            "scene_id": scene_id,
            "title": title,
            "file_path": str(media_path),
            "media_tag": f"MEDIA:{media_path}",
            "model": result_model,
            "warnings": warnings,
            "verification": verification,
            "note": note,
        })
    except Exception as exc:  # never raise into the agent loop
        return _error(f"three_scene failed: {type(exc).__name__}: {exc}")
