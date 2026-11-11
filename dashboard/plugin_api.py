"""threejs-stage backend: what the Desktop scene card needs from the machine Hermes runs on.

Mounted at ``/api/plugins/threejs-stage/`` once the plugin is in ``plugins.enabled``. The Desktop card
never reads files itself (Desktop may be connected to a remote Hermes), so it asks here.

Routes:
    GET  /runtime          the vendored three.js r187 sources (build + bundled addons), read from
                           this package's ``vendor/three`` folder. Lets the sandboxed card run with
                           no network access.
    GET  /scene?id=        one scene record written by the ``three_scene`` tool
    GET  /model?id=        the files of a scene's stored model, base64-encoded. Served by scene id
                           only: this route never takes a path.
    POST /verify/next      claim the oldest scene waiting for a dry run, if any
    POST /verify/result    the outcome of a dry run: ``{"id", "status", ...}``
    POST /screenshot       save a PNG the card captured: ``{"id", "data_url"}``. It always goes to
                           this plugin's data folder; the route never takes a path.
"""

from __future__ import annotations

import base64
import binascii
import datetime
import importlib.util
import json
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

router = APIRouter()

_ROOT = Path(__file__).resolve().parents[1]
_VENDOR = _ROOT / "vendor" / "three"
_MAX_PNG_BYTES = 40 * 1024 * 1024
_runtime_cache: dict | None = None


def _load_scene_module():
    """``scene.py`` beside this folder; the plugin host imports this file standalone (no package)."""
    spec = importlib.util.spec_from_file_location("hermes_threejs_stage_scene", _ROOT / "scene.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_scene = _load_scene_module()


@router.get("/runtime")
def runtime() -> dict:
    global _runtime_cache
    if _runtime_cache is None:
        manifest = json.loads((_VENDOR / "manifest.json").read_text(encoding="utf-8"))
        build = {name: (_VENDOR / "build" / name).read_text(encoding="utf-8") for name in manifest["build"]}
        addons = {rel: (_VENDOR / "addons" / rel).read_text(encoding="utf-8") for rel in manifest["addons"]}
        _runtime_cache = {"revision": manifest["revision"], "build": build, "addons": addons}
    return _runtime_cache


@router.get("/scene")
def scene(id: str = Query(..., min_length=12, max_length=12)) -> dict:
    path = _scene.scene_record_path(id)
    if path is None:
        raise HTTPException(status_code=400, detail="bad scene id")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="scene not found")
    record = json.loads(path.read_text(encoding="utf-8"))
    return {"id": record["id"], "title": record["title"], "code": record["code"], "created": record["created"],
            "model": record.get("model")}


@router.get("/model")
def model(id: str = Query(..., min_length=12, max_length=12)) -> dict:
    path = _scene.scene_record_path(id)
    if path is None:
        raise HTTPException(status_code=400, detail="bad scene id")
    info = json.loads(path.read_text(encoding="utf-8")).get("model") if path.is_file() else None
    if not info:
        raise HTTPException(status_code=404, detail="scene has no model")
    try:
        return _scene.model_payload(id, info)
    except OSError as exc:
        raise HTTPException(status_code=404, detail="stored model is missing") from exc


@router.post("/verify/next")
def verify_next() -> dict:
    scene_id = _scene.claim_next_verify()
    if not scene_id:
        return {"id": None}
    path = _scene.scene_record_path(scene_id)
    record = json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else {}
    return {"id": scene_id, "code": record.get("code"), "hasModel": bool(record.get("model"))}


def _short(value, limit: int) -> str:
    return str(value or "")[:limit]


@router.post("/verify/result")
def verify_result(body: dict) -> dict:
    scene_id = str(body.get("id") or "")
    if _scene.scene_record_path(scene_id) is None:
        raise HTTPException(status_code=400, detail="bad scene id")
    status = body.get("status")
    if status not in ("passed", "failed", "timeout"):
        raise HTTPException(status_code=400, detail="bad status")
    errors = []
    for err in (body.get("errors") or [])[:6]:
        if isinstance(err, dict):
            errors.append({"kind": _short(err.get("kind"), 20), "name": _short(err.get("name"), 60),
                           "message": _short(err.get("message"), 800), "line": err.get("line"),
                           "code": _short(err.get("codeFrame"), 500)})
    pixels = body.get("pixels") if isinstance(body.get("pixels"), dict) else None
    stored = _scene.store_verify_result(scene_id, {
        "status": status, "backend": _short(body.get("backend"), 12), "frames": body.get("frames"),
        "drawCalls": body.get("drawCalls"), "triangles": body.get("triangles"), "pixels": pixels, "errors": errors,
    })
    if not stored:
        raise HTTPException(status_code=409, detail="no dry run was claimed for this scene")
    return {"ok": True}


@router.post("/screenshot")
def screenshot(body: dict) -> dict:
    data_url = str(body.get("data_url") or "")
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise HTTPException(status_code=400, detail="expected a PNG data URL")
    if len(data_url) > _MAX_PNG_BYTES * 4 // 3 + 64:
        raise HTTPException(status_code=400, detail="image too large")
    try:
        png = base64.b64decode(data_url[len(prefix):], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="not valid base64") from exc
    if len(png) > _MAX_PNG_BYTES or not png.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(status_code=400, detail="not a PNG, or too large")
    scene_id = re.sub(r"[^a-z0-9]", "", str(body.get("id") or ""))[:12] or "scene"
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
    folder = _scene._data_dir() / "screenshots"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{scene_id}_{stamp}.png"
    target.write_bytes(png)
    return {"ok": True, "path": str(target)}
