# Vibe Trade v0.4.0 — Production-ready Swarm Intelligence + reliability + exports

45 commits of new work across the Swarm Intelligence pipeline, run
observability, the Run Stats dashboard, drawing tools, and the CLI.

The headline is that the Swarm Intelligence debate now **finishes
reliably on real datasets**: it no longer hangs on slow LLM calls,
surfaces errors directly in the UI instead of hiding them in server
logs, exports proper text-based PDF reports, and has a richer
per-agent dashboard with live interviews.

## Highlights

### Swarm Intelligence now ships as a real product

- **MiroFish-inspired 5-stage pipeline** — Context → Intelligence
  Gathering → Persona Generation → Debate → Cross-Examination →
  ReACT Report
- **50 agents · 30 rounds · 450+ messages · 8 cross-exams** at max
  throughput. Configurable from the CLI.
- **Tool-augmented agents** — each persona can call `search_web`,
  `run_indicator`, `compute_levels`, `fetch_fundamentals`, etc.
  from a role-based tool catalog.
- **Iterative research phase** (Stage 2.5) — personas plan their
  own research queries, minimum 3 iterations per agent, up to 8.
  No more one-and-done single-query research.
- **Influence-weighted consensus** computed from the actual thread
  sentiment (previously always reported "BULLISH 72%" because the
  LLM copied example values from the prompt).
- **Per-agent research trail** recorded with query, reasoning, tool,
  and result — surfaced in the new Agent Detail panel.

### Reliability: no more silent hangs

Four layered timeouts prevent the debate from wedging on a stuck
LLM provider:

| Layer | Budget (default) | Env var |
|---|---|---|
| Individual LLM call | 90 s | `LLM_CALL_TIMEOUT_S` |
| LLM retries on failure | 2 | `LLM_MAX_RETRIES` |
| Per-speaker (speak()) | 180 s | — |
| Stage 4 cross-exam | 5 min | — |
| Stage 5 report | 10 min | — |
| Outer `/debate` endpoint | 45 min | `DEBATE_TIMEOUT_S` |

Each level degrades gracefully: speakers that time out become
no-shows for the round, a failed cross-exam continues without it,
a failed report falls back to a minimal summary computed from the
thread.

### Errors/warnings surfaced to the user

Every timeout and failure inside the pipeline is now recorded as a
structured `RunEvent` (`{timestamp, level, stage, message}`),
returned in the `/debate` response, and rendered as a prominent
red/amber banner at the top of the **Run Stats** tab — no more
reading server logs to find out why the output was thin.

The **CLI** gets the same diagnostics via a rich-styled panel after
the debate summary, matching the web UI exactly.

### Run Stats dashboard

A new per-run dashboard tab surfaces *all* the pipeline data that
was previously generated but never displayed:

- Pipeline Data Available checklist (19 indicators)
- Market Context (Stage 1 output)
- Sentiment Convergence chart (per-round)
- Iterative Research summary (queries per agent)
- Intelligence Briefing (executive summary, bull/bear cases,
  upcoming events, sentiment reading, data points)
- Cross-Examination full results
- Conviction Shifts timeline
- Trade Recommendation with entry / stop / target / size
- Raw Research Findings (collapsible — news, indicators, key
  levels, market analysis, regulatory)

### PDF export — proper text, not screenshots

Earlier attempts used `html2canvas` which produced a blurry viewport
screenshot. Replaced with a native `jsPDF` text-based report:

- **Dropdown with two variants**:
  - **Summary PDF** — analysis only: consensus, briefing, market
    context, data feeds, research trail, convergence timeline
  - **Full PDF** — Summary + Cross-Exams + all 50 Persona profiles
    + complete debate thread
- Real, selectable, searchable text (not pixels)
- Auto page breaks, rounded badges, page numbers, footer
- Run Warnings section so failures are documented in the export
  too

### Click-to-expand persona cards + live agent interviews

Click any persona card in the **Personalities** tab → expanded
view with:

- Full profile (name, role, stance, specialization, influence, tools)
- All messages this agent posted, grouped by round, with tool chips
- Cross-exam Q&A for this agent (if selected)
- Research trail — each query, reasoning, and result
- **Live chat box** to interview the agent after the debate
  (`/interview` endpoint keeps them in character)

### Drawing tools polished to pro-trader standard

Rectangle, Long Position, and Short Position tools now show the
industry-standard readouts every pro platform ships:

- **Rectangle**: measurement pill with `+2.35% +$1,250 · 24 bars`,
  color-coded by direction
- **Long / Short**: R:R ratio pill (`R:R 1:2.5`) computed live from
  TP/SL distances, color-graded (green ≥ 2, amber ≥ 1, red < 1)
- **Long / Short**: color-coded direction badges — green "LONG"
  vs red "SHORT", so the two are visually distinct at a glance
- **Pattern Select button**: stopped the permanent glow + ping
  animation that kept running after the tool was selected
- **Pattern snapshot** sent to chat is sharp now (fixed the
  viewport-only upscaling blur)

### CLI

- **`vibe-trade simulate`** has been rewritten to invoke the real
  `DebateOrchestrator` (the old version imported a function that
  didn't exist and crashed on start). Fetches bars through
  `core.data.fetcher`, streams the debate live, displays a Run
  Warnings panel at the end if anything fired.
- New flags: `--interval/-i`, `--bars/-b`.
- Help text documents the new env vars (`LLM_CALL_TIMEOUT_S`,
  `LLM_MAX_RETRIES`, `DEBATE_TIMEOUT_S`).
- Unicode-safe console output on Windows cp1252 (the `✕` glyph
  was crashing the console on some systems).

### Planner / Skills plumbing

- **Always run planner** — every request goes through the plan
  executor, so every skill invocation shows live trace progress
  instead of sometimes running silently.
- Detailed sub-plan labels per skill (no more misleading "Stage 3:
  Rounds 19-23 — consensus emerging" fake timer labels; clearer
  language + a note to check server logs for true progress).
- Fix: swarm debate not finding data after planner fetched it
  (race condition in dataset sync).
- Fix: swarm debate results not appearing after plan execution.
- Fix: planner writing vague step messages without ticker names.
- Fix: new conversation now clears chart + dataset state
  (previously stale data carried over).

## Breaking changes

- `DebateOrchestrator.run()` now returns `events: List[RunEvent]`
  in the result dict. Consumers that deserialize this with strict
  schemas need to allow the new field (`/debate` Pydantic model
  updated accordingly).
- `DiscussionMessage` now includes `tools_used` and `tool_results`
  (optional). Same caveat.
- CLI `vibe-trade simulate` now fetches real bars via
  `core.data.fetcher` before running, which means it requires
  network access and the same provider autodetect rules as
  `vibe-trade fetch` (previously it ran against a stub asset
  name with no bars).

## Install / upgrade

```bash
# First time
pipx install vibe-trade
vibe-trade setup
vibe-trade serve

# Upgrading from 0.3.0
vibe-trade update
# or:
pipx upgrade vibe-trade
```

## Env vars you might want to tune

```bash
# In ~/.config/vibe-trade/.env (or %APPDATA%\vibe-trade\.env on Windows)
LLM_CALL_TIMEOUT_S=90      # per-LLM-call timeout
LLM_MAX_RETRIES=2          # retries on transient failures
DEBATE_TIMEOUT_S=2700      # 45 min outer ceiling on a full debate run
```

## Links

- Source: <https://github.com/spyderweb47/Vibe-Trade>
- PyPI: <https://pypi.org/project/vibe-trade/>
- Issues: <https://github.com/spyderweb47/Vibe-Trade/issues>
