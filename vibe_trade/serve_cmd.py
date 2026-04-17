"""
`vibe-trade serve` — start the FastAPI backend and (optionally) serve the
pre-built Next.js frontend static export from the same process.

The frontend is built once at release time via `npm run build` with
`next.config.ts` set to `output: "export"`, which produces a static site in
`apps/web/out/`. We bundle that directory as package data so the installed
CLI can serve it without requiring the end user to have Node.js.
"""

from __future__ import annotations

import os
import sys
import time
import warnings
import webbrowser
from pathlib import Path
from threading import Thread

from rich.console import Console
from rich.panel import Panel

console = Console()


def _silence_uvicorn_windows_noise() -> None:
    """
    Suppress known-benign startup noise from uvicorn on Windows + Python
    3.12. uvicorn's internal subprocess helper leaves a partially-
    initialized _WindowsSelectorEventLoop that Python's GC then cleans up
    noisily, producing:

      AttributeError: '_WindowsSelectorEventLoop' object has no attribute '_ssock'
      RuntimeWarning: coroutine 'Server.serve' was never awaited

    Both are harmless (the real server process starts and runs fine) but
    scare users into thinking something's broken. Filter them to keep the
    startup banner clean.
    """
    if sys.platform != "win32":
        return
    warnings.filterwarnings(
        "ignore",
        message=r"coroutine 'Server\.serve' was never awaited",
        category=RuntimeWarning,
    )
    # Silence the selector-event-loop cleanup AttributeError at interpreter
    # exit by swallowing it in sys.unraisablehook. We only filter this exact
    # class+attribute combo so real bugs still surface.
    prior_unraisable = sys.unraisablehook

    def _filter_unraisable(unraisable):  # type: ignore[no-untyped-def]
        exc = unraisable.exc_value
        if isinstance(exc, AttributeError) and "_ssock" in str(exc):
            return
        prior_unraisable(unraisable)

    sys.unraisablehook = _filter_unraisable


def _find_frontend_dir() -> Path | None:
    """
    Locate the pre-built Next.js static export directory.

    Looks in two places, in order:
      1. `<package>/web_static/` — bundled with the installed wheel (release mode)
      2. `<repo>/apps/web/out/` — a source checkout that's been built with
         `cd apps/web && npm run build`

    Returns None if neither exists — caller should fall back to
    backend-only mode.
    """
    import vibe_trade

    # 1. Bundled static assets inside the installed package
    pkg_dir = Path(vibe_trade.__file__).parent
    bundled = pkg_dir / "web_static"
    if bundled.is_dir() and (bundled / "index.html").exists():
        return bundled

    # 2. Source checkout — walk up from this file to find `apps/web/out`
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "apps" / "web" / "out"
        if candidate.is_dir() and (candidate / "index.html").exists():
            return candidate
        # Stop at the repo root marker
        if (parent / "pyproject.toml").exists() or (parent / ".git").exists():
            break

    return None


def run_server(
    host: str = "127.0.0.1",
    port: int = 8787,
    reload: bool = False,
    open_browser: bool = True,
    backend_only: bool = False,
) -> None:
    """Launch uvicorn with the FastAPI app + optional static mount."""
    import uvicorn

    _silence_uvicorn_windows_noise()

    # Work from the repo root so relative imports (core.*, skills, ...) resolve
    current = Path(__file__).resolve()
    repo_root = None
    for parent in current.parents:
        if (parent / "pyproject.toml").exists() or (parent / "services" / "api" / "main.py").exists():
            repo_root = parent
            break
    if repo_root is None:
        repo_root = current.parents[1]

    os.chdir(repo_root)
    sys.path.insert(0, str(repo_root))

    # Import the FastAPI app AFTER cwd/path setup so its own imports work
    from services.api.main import app as fastapi_app

    # Mount the frontend if we have it and the user didn't pass --backend-only.
    # If no bundle is found AND we're in a source checkout with apps/web/
    # available, AUTO-BUILD the frontend so the user gets the full web UI
    # without having to run a separate command. This is the "just works"
    # path for `vibe-trade serve` in dev/source-install mode.
    frontend_dir: Path | None = None
    if not backend_only:
        frontend_dir = _find_frontend_dir()
        if frontend_dir is None:
            # Try auto-building from source
            console.print("[yellow]No frontend bundle found — auto-building from source...[/yellow]")
            from vibe_trade.build_frontend import build_frontend

            built = build_frontend(force=False, quiet=False)
            if built is not None:
                frontend_dir = built

        if frontend_dir is not None:
            # Late import so we don't force the dependency when serving only the API
            from fastapi.staticfiles import StaticFiles

            # Mount at root LAST so API routes keep priority
            fastapi_app.mount(
                "/",
                StaticFiles(directory=str(frontend_dir), html=True),
                name="web-ui",
            )

    # Pretty banner
    url = f"http://{host}:{port}"
    mode_line = (
        "[green]Web UI[/green] + [cyan]API[/cyan]"
        if (frontend_dir and not backend_only)
        else "[cyan]API only[/cyan]"
    )
    body_lines = [
        f"  {mode_line}   [white]{url}[/white]",
        "",
        "  API endpoints:",
        f"    [dim]GET[/dim]  {url}/skills",
        f"    [dim]GET[/dim]  {url}/tools",
        f"    [dim]POST[/dim] {url}/chat",
        f"    [dim]POST[/dim] {url}/plan",
        f"    [dim]POST[/dim] {url}/fetch-data",
    ]
    if frontend_dir:
        body_lines.insert(2, f"  Serving frontend from [dim]{frontend_dir}[/dim]")
    else:
        body_lines.insert(2, "  [yellow]No frontend bundle found[/yellow] — running API-only")
    banner = "\n".join(body_lines)
    console.print(Panel(banner, title="[bold]Vibe Trade[/bold]", border_style="cyan", padding=(0, 2)))

    # Open the browser a beat after uvicorn starts (best-effort)
    if open_browser and frontend_dir and not backend_only:
        def _opener():
            time.sleep(1.0)
            try:
                webbrowser.open(url)
            except Exception:  # noqa: BLE001
                pass

        Thread(target=_opener, daemon=True).start()

    # uvicorn.run() with reload=True needs an IMPORT STRING (not an instance)
    # because the reloader spawns child processes that must re-import the app
    # after a file change. Passing an instance breaks on Windows: the child
    # can't pickle the app, the subprocess helper creates a half-initialized
    # event loop, and GC emits spurious _ssock AttributeErrors at exit.
    #
    # When reload=True we also pre-attach the static mount via an import-side
    # hook (setting a global flag in services.api.main) so the child process
    # re-mounts the frontend correctly. For the common reload=False path we
    # keep the in-process instance so the staticfiles mount above applies.
    if reload:
        # The child re-imports services.api.main:app from disk, so the
        # StaticFiles mount we added above doesn't carry over. Pass the
        # frontend dir through an env var so the module-level code there
        # can re-mount on re-import. Not set on this path yet — reload
        # currently skips the bundled frontend.
        if frontend_dir is not None:
            os.environ["VIBE_TRADE_FRONTEND_DIR"] = str(frontend_dir)
        uvicorn.run(
            "services.api.main:app",
            host=host,
            port=port,
            reload=reload,
            reload_dirs=[str(repo_root / "services"), str(repo_root / "core")],
            log_level="info",
        )
    else:
        uvicorn.run(
            fastapi_app,
            host=host,
            port=port,
            log_level="info",
        )
