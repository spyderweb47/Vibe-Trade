"""
Frontend builder — compiles the Next.js app into a static export and copies
the result to `vibe_trade/web_static/` so `vibe-trade serve` can mount it as
the web UI without requiring Node.js at runtime.

Used by two callers:
  1. `vibe-trade build-frontend` — explicit manual rebuild
  2. `vibe-trade serve` — auto-triggers this on first run if no bundle exists
     and the repo checkout has `apps/web/package.json` available

The build is idempotent: if `vibe_trade/web_static/index.html` already exists
and is newer than every file under `apps/web/src/`, we skip the rebuild and
print "Bundle up to date."
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel

console = Console()


def _find_repo_root() -> Path | None:
    """Walk up from this file looking for a dir containing `apps/web/package.json`."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "apps" / "web" / "package.json").exists():
            return parent
    return None


def _find_package_dir() -> Path:
    """Return the installed `vibe_trade/` package directory."""
    import vibe_trade

    return Path(vibe_trade.__file__).parent


def _has_node() -> tuple[bool, str]:
    """Check if `node` is on PATH and return its version string."""
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True,
            text=True,
            check=False,
            shell=(os.name == "nt"),
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
    except FileNotFoundError:
        pass
    return False, ""


def _has_npm() -> tuple[bool, str]:
    """Check if `npm` is on PATH and return its version string."""
    try:
        result = subprocess.run(
            ["npm", "--version"],
            capture_output=True,
            text=True,
            check=False,
            shell=(os.name == "nt"),
        )
        if result.returncode == 0:
            return True, result.stdout.strip()
    except FileNotFoundError:
        pass
    return False, ""


def _is_bundle_up_to_date(bundle_dir: Path, src_dir: Path) -> bool:
    """
    Heuristic: bundle is up to date if index.html is newer than every
    file under `apps/web/src/`. Not perfect but catches the common case
    where the user edited a component and needs a rebuild.
    """
    index_html = bundle_dir / "index.html"
    if not index_html.exists():
        return False
    bundle_mtime = index_html.stat().st_mtime
    for src_file in src_dir.rglob("*"):
        if src_file.is_file() and src_file.stat().st_mtime > bundle_mtime:
            return False
    return True


def _run(cmd: list[str], cwd: Path, desc: str) -> None:
    """Run a subprocess and stream its output, raising on failure."""
    console.print(f"[dim]$ {' '.join(cmd)}[/dim]  [cyan]({desc})[/cyan]")
    result = subprocess.run(
        cmd,
        cwd=str(cwd),
        shell=(os.name == "nt"),
    )
    if result.returncode != 0:
        console.print(f"[red]✕ {desc} failed (exit code {result.returncode})[/red]")
        raise SystemExit(result.returncode)


def build_frontend(force: bool = False, quiet: bool = False) -> Path | None:
    """
    Build the Next.js static export and copy it into `vibe_trade/web_static/`.

    Returns the path to the bundled directory on success, or None if:
      - no repo checkout is available (installed wheel without source)
      - Node.js / npm aren't installed
      - the user declined an interactive rebuild prompt

    Args:
        force: rebuild even if the bundle looks up to date
        quiet: don't print the banner (used when called from `serve` auto-build)
    """
    repo_root = _find_repo_root()
    if repo_root is None:
        if not quiet:
            console.print(
                "[yellow]No repo checkout found[/yellow] — this looks like an installed wheel "
                "without the source tree. The frontend bundle should already be present inside "
                "the package; if it's missing, reinstall with a freshly-built wheel."
            )
        return None

    web_dir = repo_root / "apps" / "web"
    out_dir = web_dir / "out"
    src_dir = web_dir / "src"
    pkg_dir = _find_package_dir()
    web_static = pkg_dir / "web_static"

    # Fast path: bundle already up to date
    if not force and _is_bundle_up_to_date(web_static, src_dir):
        if not quiet:
            console.print(f"[green]✓ Frontend bundle up to date[/green] [dim]({web_static})[/dim]")
        return web_static

    if not quiet:
        console.print(
            Panel(
                f"Building the Vibe Trade web UI from source.\n"
                f"[dim]Source:[/dim] {web_dir}\n"
                f"[dim]Output:[/dim] {web_static}\n\n"
                f"First build takes [yellow]~1-2 minutes[/yellow] (npm install + Next.js build).\n"
                f"Subsequent runs skip if the bundle is up to date.",
                title="[bold]vibe-trade · build-frontend[/bold]",
                border_style="cyan",
                padding=(0, 2),
            )
        )

    # Check for Node.js + npm
    has_node, node_ver = _has_node()
    has_npm, npm_ver = _has_npm()
    if not has_node or not has_npm:
        console.print(
            Panel(
                "[red]Node.js + npm are required to build the frontend from source.[/red]\n\n"
                "Install Node.js 20+ from [cyan]https://nodejs.org/[/cyan] and retry.\n\n"
                "Alternatively, run the backend-only API (no web UI):\n"
                "  [dim]vibe-trade serve --backend-only[/dim]\n\n"
                "Or install a pre-built release wheel that ships with the frontend bundled.",
                title="[bold red]Missing Node.js[/bold red]",
                border_style="red",
            )
        )
        return None

    if not quiet:
        console.print(f"[dim]Using[/dim] node [cyan]{node_ver}[/cyan] · npm [cyan]{npm_ver}[/cyan]")

    # Step 1: npm install (skip if node_modules already exists and looks sane)
    node_modules = web_dir / "node_modules"
    if not node_modules.exists() or not (node_modules / ".package-lock.json").exists():
        _run(["npm", "install"], cwd=web_dir, desc="installing frontend dependencies")
    else:
        if not quiet:
            console.print(f"[dim]✓ node_modules already present, skipping npm install[/dim]")

    # Step 2: next build in export mode
    # We set EXPORT=1 so next.config.ts flips to `output: "export"`
    env_export_cmd = (
        ["cmd", "/c", "set", "EXPORT=1", "&&", "npx", "next", "build"]
        if os.name == "nt"
        else ["env", "EXPORT=1", "npx", "next", "build"]
    )
    # Simpler: use npm script which handles the env var cross-platform via cross-env
    # But we don't want to force a cross-env dependency — just set env via Python
    env = os.environ.copy()
    env["EXPORT"] = "1"
    console.print("[dim]$ EXPORT=1 npx next build[/dim]  [cyan](building static export)[/cyan]")
    build_result = subprocess.run(
        ["npx", "next", "build"],
        cwd=str(web_dir),
        env=env,
        shell=(os.name == "nt"),
    )
    if build_result.returncode != 0:
        console.print(f"[red]✕ Next.js build failed (exit code {build_result.returncode})[/red]")
        raise SystemExit(build_result.returncode)

    if not out_dir.exists():
        console.print(
            f"[red]✕ Build succeeded but output dir missing:[/red] {out_dir}\n"
            f"Check that next.config.ts has `output: 'export'` when EXPORT=1 is set."
        )
        return None

    # Step 3: sync out_dir → web_static
    if web_static.exists():
        shutil.rmtree(web_static)
    shutil.copytree(out_dir, web_static)

    file_count = sum(1 for _ in web_static.rglob("*") if _.is_file())
    console.print(
        f"[green]✓ Bundled {file_count} files[/green] into [cyan]{web_static}[/cyan]\n"
        f"[dim]The next `vibe-trade serve` will mount this as the web UI.[/dim]"
    )
    return web_static
