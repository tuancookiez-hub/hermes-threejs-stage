"""threejs-stage: live three.js r187 scenes in Hermes chat.

Registers one tool (``three_scene``) and one skill (``three-r187``) through the public plugin API.
The Desktop half (``desktop/plugin.js``) draws the tool's ``MEDIA:`` file as a live scene card.
"""

from __future__ import annotations

from pathlib import Path

from . import scene as _scene

TOOLSET = "threejs_stage"
SKILL = "three-r187"
SKILL_DESCRIPTION = "Write correct three.js r187 scenes for three_scene."


def register(ctx) -> None:
    ctx.register_tool(
        name=_scene.TOOL,
        toolset=TOOLSET,
        schema=_scene.SCHEMA,
        handler=lambda args, session_id="", **_: _scene.three_scene(
            args, session_id=session_id or "", verify=_scene.as_bool(ctx.get_config("verify_scenes", default=True))),
        emoji="🧊",
    )
    ctx.register_skill(
        name=SKILL,
        path=Path(__file__).resolve().parent / "skills" / SKILL / "SKILL.md",
        description=SKILL_DESCRIPTION,
    )


__all__ = ["register"]
