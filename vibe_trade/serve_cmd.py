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
import webbrowser
from pathlib import Path
from threading import Thread

from rich.console import Console
from rich.panel import Panel

console = Console()


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

    # Mount the frontend if we have it and the user didn't pass --backend-only
    frontend_dir: Path | None = None
    if not backend_only:
        frontend_dir = _find_frontend_dir()
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

    uvicorn.run(
        fastapi_app,
        host=host,
        port=port,
        reload=reload,
        log_level="info",
    )
