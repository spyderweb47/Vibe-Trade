# Vibe Trade Architecture

Vibe Trade is a 3-layer system. Each layer has a clear responsibility, clean
boundaries, and a well-defined interface to the layers above and below it.

```
                    User
                      |
                      v
  +-------------------------------------------+
  |              Layer 1: CANVAS               |
  |   React components, Zustand store, chart   |
  |          (apps/web/src/)                   |
  +-------------------+--+--------------------+
                      |  ^
            tool_calls|  |store updates
                      v  |
  +-------------------------------------------+
  |              Layer 2: TOOLS                |
  |   Product features skills can invoke       |
  |   (core/tool_catalog.py + toolRegistry.ts) |
  +-------------------+--+--------------------+
                      |  ^
        skill dispatch|  |SkillResponse
                      v  |
  +-------------------------------------------+
  |              Layer 3: SKILLS               |
  |   SKILL.md instruction files               |
  |          (skills/{name}/SKILL.md)          |
  +-------------------------------------------+
```


## Layer 1: Canvas

**Where:** `apps/web/src/`

The Canvas is everything the user sees and interacts with. It renders data,
accepts input, and executes tool calls from the agent.

| Component | File | Responsibility |
|-----------|------|----------------|
| Page layout | `app/page.tsx` | Orchestrates sidebar, chart, panels, right sidebar |
| Zustand store | `store/useStore.ts` | Global state: datasets, messages, skills, debates |
| Chart | `components/Chart.tsx` | Candlestick chart via lightweight-charts |
| Drawing toolbar | `components/DrawingToolbar.tsx` | Pattern selector, trendlines, fib, etc. |
| Bottom panel | `components/BottomPanel.tsx` | Tab container, renders skill output_tabs |
| Chat input | `components/ChatInputBar.tsx` | Skill chip row, message input, send button |
| Right sidebar | `components/RightSidebar.tsx` | Chat thread, code editor toggle |
| Left sidebar | `components/LeftSidebar.tsx` | Mode toggle, chat history, new chat |
| Tool registry | `lib/toolRegistry.ts` | Executes tool_calls within declared allowlists |

**Key rule:** The Canvas never calls agent logic directly. It sends a chat
message to the backend, receives a `SkillResponse` with `tool_calls`, and
the tool registry executes them. The Canvas is a dumb terminal.


## Layer 2: Tools

**Where:** `core/tool_catalog.py` (definitions) + `apps/web/src/lib/toolRegistry.ts` (executors)

Tools are reusable product features that any skill can invoke. A tool is a
named capability with a defined interface. Skills declare which tools they
need; the system enforces those declarations.

### Tool categories

| Category | Prefix | Examples |
|----------|--------|----------|
| Chart interactions | `chart.*` | pattern_selector, highlight_matches, focus_range |
| Drawing tools | `chart.drawing.*` | trendline, fibonacci, rectangle, long/short |
| Script editor | `script_editor.*` | load, run |
| Bottom panel | `bottom_panel.*` | activate_tab, set_data |
| Inline cards | `chatbox.card.*` | strategy_builder, generic |
| Data | `data.*` | fetch_market, dataset.add, indicators.toggle |
| Simulation | `simulation.*` | run_debate, set_debate, reset |
| Notifications | `notify.*` | toast |

### How tools work

1. **Definitions** live in `core/tool_catalog.py` as `ToolDef` dataclasses.
   Each has an `id`, `name`, `category`, `description`, and `input_schema`.

2. **Executors** live in `apps/web/src/lib/toolRegistry.ts`. Each tool id
   maps to a function that updates the Zustand store, calls an API, or
   manipulates the Canvas.

3. **Skills declare tools** in their SKILL.md `tools:` frontmatter. The
   skill registry validates these against the catalog on load.

4. **Enforcement** happens in `toolRegistry.ts::runToolCalls()` — if a
   skill tries to invoke a tool it didn't declare, the call is blocked
   with a console warning.

### Adding a new tool

1. Add a `ToolDef(...)` to `core/tool_catalog.py` in the right category
2. Add a matching executor in `apps/web/src/lib/toolRegistry.ts`
3. Reference the tool id in any SKILL.md that should use it


## Layer 3: Skills

**Where:** `skills/{name}/SKILL.md`

A skill is a **natural-language instruction file** for the AI agent. Think
of each SKILL.md as a program written in English instead of Python. It tells
the agent:

- What it can do (metadata, description)
- Which tools it has access to (tools allowlist)
- What UI it contributes (output_tabs for bottom panel)
- How to process user requests (instructions in the markdown body)
- What inputs it accepts and outputs it produces

### SKILL.md structure

```yaml
---
id: pattern                              # unique identifier
name: Pattern Skill                      # display name
tagline: Pattern                         # chip label in the UI
description: Detects chart patterns...   # full description
version: 1.0.0
author: Vibe Trade Core
category: analysis                       # analysis | generation | data | simulation
icon: chart-line                         # icon hint for the Canvas
color: "#ff6b00"                         # accent color for the Canvas

tools:                                   # tools this skill can invoke
  - chart.pattern_selector
  - chart.highlight_matches
  - script_editor.load
  - bottom_panel.activate_tab
  - notify.toast

output_tabs:                             # bottom-panel tabs this skill contributes
  - id: pattern_analysis
    label: Pattern Analysis
    component: PatternContent            # React component name in BOTTOM_PANEL_COMPONENTS

store_slots:                             # store keys this skill writes to
  - patternMatches
  - currentScript

input_hints:
  placeholder: "Describe a pattern..."   # chat input placeholder
  supports_fingerprint: true             # accepts chart selection fingerprints
---

# Pattern Skill

[Instructions, examples, IO contracts, tool usage documentation...]
```

### Skill lifecycle

1. **Discovery:** `core/skill_registry.py` scans `skills/` at import time
2. **Registration:** Each SKILL.md is parsed into `SkillMetadata` + body
3. **Serving:** `GET /skills` returns all skills as JSON for the Canvas
4. **Selection:** User clicks a skill chip in `ChatInputBar`
5. **Dispatch:** Chat message routes to `VibeTrade.dispatch(skill_id, ...)`
6. **Processing:** `core/agents/processors.py` has one processor per skill
7. **Response:** Processor returns `SkillResponse` with reply + tool_calls
8. **Execution:** Canvas executes tool_calls via `toolRegistry.ts`

### Adding a new skill

1. Create `skills/{name}/SKILL.md` with YAML frontmatter + instructions
2. Add a processor function in `core/agents/processors.py`
3. Register it in the `PROCESSORS` dict at the bottom of that file
4. (If new tools are needed) Add them to `core/tool_catalog.py` + `toolRegistry.ts`
5. Restart the backend. The Canvas picks up the new skill automatically.

No frontend code changes needed unless the skill introduces new bottom-panel
tab components (which go in `apps/web/src/components/tabs/`).


## Directory map

```
trading-platform/
|
+-- core/                          # Python backend logic
|   +-- agents/
|   |   +-- processors.py          # Skill processors (one per skill)
|   |   +-- vibe_trade_agent.py    # Dispatcher + multi-step planner
|   |   +-- planner.py             # LLM-based plan decomposition
|   |   +-- llm_client.py          # Multi-provider LLM client (9 providers)
|   |   +-- pattern_agent.py       # Pattern detection prompts + logic
|   |   +-- strategy_agent.py      # Strategy generation prompts + logic
|   |   +-- simulation_agents.py   # Debate personas + discussion agents
|   |
|   +-- engine/
|   |   +-- dag_orchestrator.py    # 6-stage debate pipeline
|   |   +-- simulation_engine.py   # Bar-by-bar trading simulation
|   |
|   +-- data/
|   |   +-- fetcher.py             # yfinance + ccxt data fetcher
|   |
|   +-- skill_registry.py          # SkillRegistry — discovers SKILL.md files
|   +-- skill_types.py             # Skill, SkillResponse, ToolContext types
|   +-- tool_catalog.py            # TOOL_CATALOG — 28 tools across 8 categories
|
+-- skills/                        # SKILL.md files ONLY (no Python)
|   +-- pattern/SKILL.md
|   +-- strategy/SKILL.md
|   +-- data_fetcher/SKILL.md
|   +-- swarm_intelligence/SKILL.md
|   +-- _template/SKILL.md         # Copy this to create a new skill
|
+-- services/api/                  # FastAPI backend
|   +-- main.py                    # App entry point
|   +-- routers/                   # HTTP endpoints
|
+-- apps/web/src/                  # Next.js frontend (Canvas)
|   +-- app/page.tsx               # Main layout
|   +-- store/useStore.ts          # Zustand global state
|   +-- lib/toolRegistry.ts        # Tool executors
|   +-- lib/api.ts                 # Backend API client
|   +-- components/                # React components
|       +-- tabs/                  # Bottom-panel tab components
|
+-- vibe_trade/                    # CLI package (pipx install vibe-trade)
|   +-- cli.py                     # Typer commands
|   +-- serve_cmd.py               # vibe-trade serve
|   +-- setup_cmd.py               # vibe-trade setup
|   +-- updater.py                 # Update checker + vibe-trade update
|
+-- docs/
    +-- ARCHITECTURE.md            # This file
```


## Data flow

```
User types: "fetch BTC 1h and find triple tops"
                        |
                        v
              [ChatInputBar] sends POST /chat
                        |
                        v
           [chat.py] routes to VibeTrade.dispatch()
                        |
                        v
     [vibe_trade_agent.py] detects multi-step request
        calls planner → decomposes into 2 steps:
          Step 1: data_fetcher → "fetch BTC 1h"
          Step 2: pattern → "find triple tops"
                        |
                        v
        [processors.py] runs _data_fetcher_processor()
          → calls core.data.fetcher.fetch()
          → returns SkillResponse with tool_calls:
              data.dataset.add, chart.set_timeframe, notify.toast
                        |
                        v
        [processors.py] runs _pattern_processor()
          → calls PatternAgent.generate()
          → returns SkillResponse with tool_calls:
              script_editor.load, bottom_panel.activate_tab
                        |
                        v
              [RightSidebar] receives combined response
                        |
                        v
        [toolRegistry.ts] executes all tool_calls:
          1. data.dataset.add → store.addDataset()
          2. chart.set_timeframe → store.setSelectedTimeframe()
          3. notify.toast → console.log (stub)
          4. script_editor.load → sink.setCurrentScript()
          5. bottom_panel.activate_tab → sink.setBottomPanelTab()
                        |
                        v
              Canvas updates: chart shows BTC, script loads,
              bottom panel switches to Pattern Analysis tab
```
