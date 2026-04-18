# Vibe Trade v0.4.2 — Empty-UI fix + Windows startup noise fix

Two user-reported bugs from v0.4.1 users.

## What this fixes

### Swarm Intelligence completed but UI showed empty tabs

Users running Swarm Intelligence saw the backend log complete successfully
but the Run Stats / Personalities / Debate Thread / Cross-Exam tabs
rendered with no data. Two independent bugs were both dropping fields.

**Bug 1 — Skill processor path** (`core/agents/processors.py`).

`_swarm_intelligence_processor` emitted `simulation.set_debate` with the
raw orchestrator dict as the value. That dict is missing three top-level
identity fields the frontend mapper expects: `debate_id`, `symbol`, and
`bars_analyzed`. The mapper didn't throw (everything has a defensive
fallback), but the resulting `SimulationDebate` got a `debate_${Date.now()}`
id and an empty symbol string — enough to blank the Run Stats header,
break the PDF export filename, and confuse the snapshot logic tying the
run to the active conversation.

Fix: wrap the orchestrator's result with those fields before emitting
the tool_call. Now matches the shape the `/debate` REST endpoint
produces via its Pydantic projection.

Also added `traceback.print_exc()` + accumulated events in the
processor's error path, so if a run crashes mid-pipeline you get useful
diagnostics instead of just an exception string.

**Bug 2 — Direct REST path** (`apps/web/src/store/useStore.ts::runDebate`).

The hand-rolled response handler only mapped `resp.entities`,
`resp.thread`, and `resp.summary` into the store. **Six** of the most
important fields v0.4.0 added were silently dropped:

- `intel_briefing`
- `cross_exam_results`
- `market_context`
- `data_feeds`
- `agent_research`
- `convergence_timeline`
- `events`

If you used the "Run Debate" button in Simulation mode, every one of
those corresponded to an empty tab in the UI.

Fix: route the response through the shared `toolRegistry` mapper via
`runToolCalls([{tool: "simulation.set_debate", value: resp}])`. One code
path, all fields handled, and any future backend additions automatically
flow through both the skill-based and direct-REST paths.

**Defensive logging**: `toolRegistry.simulation.set_debate` now logs a
warning with entity/thread counts and top-level keys when it receives a
thin payload (zero entities, zero thread, or no summary), so next time
something like this happens you see exactly what arrived instead of
debugging blind.

### Spurious uvicorn startup warnings on Windows

Starting `vibe-trade serve` on Windows + Python 3.12 printed two
scary-looking messages on every boot:

```
AttributeError: '_WindowsSelectorEventLoop' object has no attribute '_ssock'
RuntimeWarning: coroutine 'Server.serve' was never awaited
```

Root cause: `uvicorn.run(fastapi_app, ...)` was passing the app instance
instead of a module string. uvicorn's subprocess helper couldn't pickle
the instance across the subprocess boundary on Windows, creating a
half-initialized event loop that GC then cleaned up noisily. The server
always ran fine (uvicorn fell back to single-process mode), but the
warnings scared users into thinking something was broken.

Fixed in two pieces:

1. **Reload path** (`vibe-trade serve --reload`) now passes
   `"services.api.main:app"` as a string so uvicorn's reloader can
   spawn child processes cleanly. Added `reload_dirs=[services/,
   core/]` so source edits actually trigger reload. A new
   `VIBE_TRADE_FRONTEND_DIR` env-var hook in `services.api.main`
   re-applies the StaticFiles mount after reimport.
2. **Non-reload path** (default) installs a targeted `warnings.filter`
   and `sys.unraisablehook` filter that silence exactly these two
   known-benign messages on Windows only. Real bugs still surface —
   the filters match on specific strings (`'Server.serve' was never
   awaited`, `_ssock`) and `sys.platform == "win32"`.

## Upgrade

```bash
vibe-trade update
# or
pipx upgrade vibe-trade
```

## Links

- Source: <https://github.com/spyderweb47/Vibe-Trade>
- PyPI: <https://pypi.org/project/vibe-trade/>
- Issues: <https://github.com/spyderweb47/Vibe-Trade/issues>
