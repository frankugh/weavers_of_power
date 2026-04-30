from __future__ import annotations

import logging
from pathlib import Path

from fastapi.responses import FileResponse, HTMLResponse
from nicegui import app, ui
from nicegui import run as nicegui_run

from battle_api import register_battle_api
from battle_session import BattleSessionContext

ROOT = Path(__file__).parent
FRONTEND_DIST = ROOT / "frontend" / "dist"
FRONTEND_ASSETS = FRONTEND_DIST / "assets"

context = BattleSessionContext(root=ROOT)

_original_nicegui_setup = nicegui_run.setup


def _safe_nicegui_setup() -> None:
    try:
        _original_nicegui_setup()
    except (PermissionError, OSError):
        nicegui_run.process_pool = None
        logging.warning("NiceGUI process pool unavailable; continuing without cpu_bound support", exc_info=True)


nicegui_run.setup = _safe_nicegui_setup

app.add_static_files("/images", str(context.images_dir))
if FRONTEND_ASSETS.exists():
    app.add_static_files("/assets", str(FRONTEND_ASSETS))

register_battle_api(app, context)


@app.get("/", include_in_schema=False)
def react_root():
    index_path = FRONTEND_DIST / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return HTMLResponse(
        """
        <html>
          <head><title>Weavers of Power</title></head>
          <body style="font-family: Georgia, serif; padding: 32px; background: #0d0b08; color: #e5d7b8;">
            <h1>Frontend build missing</h1>
            <p>Run <code>npm install</code> and <code>npm run build</code> in <code>frontend/</code>, then refresh.</p>
          </body>
        </html>
        """
    )


ui.run(title="Weavers of Power", reload=False)
