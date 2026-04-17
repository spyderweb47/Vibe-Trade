"""
FastAPI application entry point for the trading platform API.

Configures CORS middleware, includes all routers, and sets up the
in-memory data store on startup.
"""

from __future__ import annotations

import os
import sys

# Add the project root to sys.path so that `core.*` and `services.*`
# imports resolve correctly regardless of where the server is started.
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

# Load .env BEFORE any other imports so OPENAI_API_KEY is available
# when agent modules check os.environ at import time.
#
# Two-layer load, repo .env wins over user config so a dev checkout with
# its own .env still works:
#   1. User config (~/.config/vibe-trade/.env on Linux/Mac,
#      %APPDATA%\vibe-trade\.env on Windows) — written by `vibe-trade setup`
#   2. Repo .env — found next to this file's project root for source checkouts
from pathlib import Path
from dotenv import load_dotenv

# Layer 1: user config (non-override so layer 2 can still shadow)
try:
    from vibe_trade.user_config import load_user_env as _load_user_env
    _load_user_env(override=False)
except ImportError:
    pass  # vibe_trade package not installed — dev mode without the CLI

# Layer 2: repo .env
_env_file = Path(_PROJECT_ROOT) / ".env"
if not _env_file.exists():
    # Uvicorn --reload on Windows may change CWD; walk up to find .env
    _search = Path(__file__).resolve().parent
    for _ in range(5):
        _search = _search.parent
        if (_search / ".env").exists():
            _env_file = _search / ".env"
            break
if _env_file.exists():
    load_dotenv(str(_env_file), override=True)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from services.api.routers import upload, patterns, strategies, backtest, simulation, analysis, indicators, chat
from services.api.store import store

app = FastAPI(
    title="Trading Platform API",
    description="Backend API for the AI-powered trading platform. "
                "Upload OHLC data, detect patterns, generate strategies, "
                "run backtests, and analyse markets.",
    version="0.1.0",
)

# ---------------------------------------------------------------------------
# CORS middleware -- allow all origins for development.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Include routers
# ---------------------------------------------------------------------------
app.include_router(upload.router)
app.include_router(patterns.router)
app.include_router(strategies.router)
app.include_router(backtest.router)
app.include_router(simulation.router)
app.include_router(analysis.router)
app.include_router(indicators.router)
app.include_router(chat.router)


# ---------------------------------------------------------------------------
# Optional static frontend mount — used by `vibe-trade serve --reload`.
#
# The non-reload path in serve_cmd.py adds this mount directly on the app
# instance before calling uvicorn.run(app_instance, ...). The reload path
# can't do that because uvicorn re-imports the app from this module, so the
# in-process mount is lost. We bridge the gap with VIBE_TRADE_FRONTEND_DIR:
# serve_cmd sets it before invoking uvicorn.run("services.api.main:app"),
# and the re-imported module picks it up here.
# ---------------------------------------------------------------------------
import os as _os  # noqa: E402 — kept local so it doesn't leak into the public API
_frontend_dir = _os.environ.get("VIBE_TRADE_FRONTEND_DIR", "").strip()
if _frontend_dir:
    from pathlib import Path as _Path  # noqa: E402
    _fd = _Path(_frontend_dir)
    if _fd.is_dir() and (_fd / "index.html").exists():
        from fastapi.staticfiles import StaticFiles  # noqa: E402
        app.mount("/", StaticFiles(directory=str(_fd), html=True), name="web-ui")


# ---------------------------------------------------------------------------
# Startup event
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup_event() -> None:
    """Initialize the data store and any other resources on startup."""
    # The store is already initialised as a module-level singleton.
    # This hook is available for future setup (e.g. loading sample data,
    # connecting to external services, warming caches).
    pass


# ---------------------------------------------------------------------------
# Status endpoint — moved off `/` so the `vibe-trade serve` StaticFiles mount
# can own the root path and serve the bundled web UI's index.html.
# ---------------------------------------------------------------------------
@app.get("/api/status")
async def api_status() -> dict:
    """API metadata endpoint."""
    return {"name": "Trading Platform API", "version": "0.1.0", "status": "ok"}


@app.get("/health")
async def health_check() -> dict:
    """Health check endpoint."""
    return {
        "status": "ok",
        "datasets_loaded": len(store.list_datasets()),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )
