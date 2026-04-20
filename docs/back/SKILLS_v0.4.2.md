# Skills, Planner, Tools — how the 3-layer system actually routes

> **Baseline**: commit `653a51d`.
>
> This doc covers: how a user's chat message turns into one or more
> skill invocations, how skills communicate back to the UI via tool
> calls, and how to add a new skill.

## 1. The 3 layers, concretely

| Layer | Files | Responsibility |
|---|---|---|
| **Canvas** | `apps/web/src/components/canvas/` + `Chart.tsx` | Renders what the user sees — multiple chart windows, drawings, indicators, bottom-panel tabs |
| **Tools** | `apps/web/src/lib/toolRegistry.ts` | Registered handlers for **UI mutations** that skills can request. Each has a `(value, ctx) => void` signature. |
| **Skills** | `core/agents/processors.py` + `skills/<id>/` | Backend handlers for **capabilities**. Each takes `(message, context, tools) → SkillResponse` |

Skills produce `tool_calls`; the frontend tool registry executes them
against Canvas state. The planner decides which skill(s) to invoke and
in what order. The loop is entirely one-way: skill runs → tool_calls
land → UI updates.

## 2. The four registered skills

| Skill ID | Purpose | Processor | Backend output |
|---|---|---|---|
| `data_fetcher` | Pull bars from yfinance/ccxt | `_data_fetcher_processor` | Bars + dataset_id (persisted in store) |
| `pattern` | Generate pattern-detection JS script | `_pattern_processor` | Script + tool_call to load it |
| `strategy` | Generate strategy JS script | `_strategy_processor` | Script + strategy_config |
| `swarm_intelligence` | Multi-agent debate | `_swarm_intelligence_processor` | Full debate result |

Each has:
- `skills/<id>/SKILL.md` — human-readable description
- `skills/<id>/skill.yaml` — metadata (id, name, description, version,
  allowed tools)
- A Python processor in `core/agents/processors.py`

Skills are loaded into `skill_registry` at backend startup (from
`core/skill_registry.py`).

## 3. The planner

Every chat submission goes through `/plan` before the skill actually
runs. The planner returns an ordered list of skill invocations.

### Flow

```
User typed message
      │
      ▼
POST /plan { message, context, available_skills }
      │
      ▼
core/agents/planner.py :: plan()
      │
 ┌────┴─────────────────────────────────────┐
 ▼                                          ▼
LLM call via chat_completion                Keyword fallback
(temperature 0.2, max 900 tokens)           (if LLM returns nothing)
      │                                          │
 Returns JSON: {"steps": [...]}           Scans message for trigger
                                          phrases — "fetch"/"load"/…
                                          → data_fetcher
                                          "swarm"/"debate"/…
                                          → swarm_intelligence
                                          (etc.)
      │                                          │
      └──────────────┬───────────────────────────┘
                     ▼
        Validated steps, each:
        {skill, message, rationale, context}
```

### The LLM prompt
Lives in `core/agents/planner.py::PLAN_SYSTEM_PROMPT`. Key rules:
- Use ONLY skill ids from the provided registry
- Each step's `message` is SELF-CONTAINED (downstream skill won't see
  the original user message — so the ticker must be spelled out
  explicitly in every step that references it)
- `strategy` skill MUST include a structured `context.strategy_config`
- Return `{"steps": []}` if out of scope (routes to plain chat)

### Keyword fallback rules (`_keyword_fallback`)
Only fires when the LLM returns zero valid steps. Maps clear intents
to a single skill:

| Phrase contains | → Skill |
|---|---|
| `fetch`, `load`, `download`, `pull`, `get data`, `show chart` | `data_fetcher` |
| `swarm`, `committee`, `debate`, `multi-agent`, `panel debate` | `swarm_intelligence` |
| `detect pattern`, `engulfing`, `find pattern`, `scan for` | `pattern` |
| `backtest`, `build a strategy`, `profit factor`, `sharpe` | `strategy` |

Intentionally conservative — only clear matches. Trivial messages
("hi") get no fallback → empty plan → frontend falls through to plain chat.

### Skill restriction behavior (important design choice)

The frontend `/plan` caller passes `available_skills: undefined`
always — the planner sees the **full registered skill set** regardless
of which chips the user has toggled. Previous versions restricted by
`activeSkillIds`, which made typed intent ("run swarm") get squeezed
into whichever skill happened to be active. Typed intent always wins;
chip selection is UI-only (determines which bottom-panel tabs show).

## 4. The tool registry

Tools are the *verbs* a skill can request. Registered in
`apps/web/src/lib/toolRegistry.ts` as a `Record<toolName, handler>`.

### Current tool vocabulary

| Tool | Payload | Effect |
|---|---|---|
| `data.dataset.add` | `{dataset_id, bars, metadata, symbol, source, interval}` | `store.addDataset` + mark synced if backend already has it |
| `data.fetch_market` | no-op (logged) | — |
| `script_editor.load` | script string | Loads script into the code editor |
| `chart.set_timeframe` | `"1h" / "1d" / null` | Resample focused chart's data |
| `chart.focus_range` | `{startTime, endTime}` | Zoom focused chart to this range |
| `chart.drawing.activate` | drawing tool name | Switch the drawing toolbar |
| `bottom_panel.activate_tab` | tab id | Open a specific bottom tab |
| `bottom_panel.close` | — | Collapse the bottom panel |
| `simulation.set_debate` | full debate object | Map snake_case → camelCase + call `setCurrentDebate` |
| `simulation.run_debate` | — | Triggers `runDebate()` (direct REST fallback path) |
| `simulation.reset` | — | Clears `currentDebate` |
| `notify.toast` | `{level, message}` | Transient toast UI |

### Tool executor signature
```typescript
type ToolHandler = (value: unknown, ctx: { skillId: string }) => void;
```

No async (fire-and-forget); no result returned to the skill. This is
intentional — the skill's job finishes when it returns; tool_calls are
UI updates.

### Allowed-tools validation
Each skill's `skill.yaml` lists the tools it's allowed to emit. The
frontend's `runToolCalls(tool_calls, skillId, allowedTools)` silently
skips any tool_call outside the allowed list and logs a warning. This
prevents a misbehaving skill from e.g. opening random panels.

## 5. plan executor

**`apps/web/src/lib/planExecutor.ts :: executePlanInBrowser({steps})`**

What it does:
1. Posts a trace message to the chat (the "Planning..." card users see)
2. Seeds `accumulatedContext = {}` (state that flows between steps)
3. Before each step, updates `accumulatedContext.dataset_ids` to
   include every canvas window's dataset id — so every step sees the
   full workspace
4. For each step:
   - Merge `{...accumulatedContext, ...step.context}` into `stepContext`
   - If the skill has a known sub-plan (`SKILL_SUB_PLANS`), start the
     timer-driven sub-step ticker in the trace
   - `sendChat(step.message, step.skill, stepContext)` → backend
   - Run `runToolCalls(result.tool_calls, step.skill, allowedTools)`
   - Post-step: if `data_fetcher`, wait up to 5s for the dataset to
     appear in `syncedDatasets` (belt-and-braces; after the Phase 3
     fix the dataset is already in the backend store)
   - If `result.script` returned, auto-run it:
     - `pattern` → iterate over every canvas window with bars and call
       `executePatternScript(script, bars)` per-dataset; populate
       `patternMatchesByDataset`
     - `strategy` → `executeStrategy(script, chartData, config)`
       against the focused chart's data (multi-chart is Phase 3.5)
   - Carry forward: any `result.data` fields, `activeDataset`,
     `dataset_ids`

### Sub-plans (`SKILL_SUB_PLANS`)

For skills with known long-running phases, the executor ticks through
fake progress labels on a timer. This is **approximate** — not synced
to actual backend progress — but gives the user feedback during
multi-minute runs.

Example for `swarm_intelligence`:
```
Stage 1: Classifying asset...                    (4s)
Stage 1.5: Searching web for recent news...      (8s)
Stage 1.5: Computing indicators...               (2s)
Stage 2: Generating personas batch 1...          (8s)
... (5 batches)
Stage 2.5: Agents planning research queries...   (30s)
Stage 2.5: Executing web searches...             (60s)
Stage 3: Debate starting...                      (45s)
... (6 timeline markers)
Stage 4: Cross-examining extreme positions...    (20s)
Stage 5: ReACT analysis...                       (15s)
Stage 5: Synthesising final research note...     (15s)
```

If the real pipeline runs longer, the UI sticks on the last marker
(with a "check server logs for true progress" hint) until the step
actually returns.

## 6. Message flow between layers

### Frontend → Backend
```typescript
// apps/web/src/lib/api.ts
sendChat(text, mode, context)
  └─ POST /chat { message: text, mode, context }
      context = {
        dataset_id: focusedDatasetId,
        dataset_ids: allCanvasDatasetIds,
        pattern_script: currentScript,
        strategy_config: strategyConfig,
        pending_fingerprint: ...,
        // plus planner-supplied step.context
      }
```

### Backend dispatch (`services/api/routers/chat.py`)
```python
@router.post("/chat")
async def chat(req: ChatRequest):
    processor = get_processor(req.mode)
    if processor:
        response = await processor(req.message, req.context, tools_ctx)
        return ChatResponse(**response.model_dump())
    # Fallback: plain-chat LLM
    return await _plain_chat(req.message)
```

### Skill → SkillResponse (`core/skill_types.py`)
```python
@dataclass
class SkillResponse:
    reply: str                               # shown in chat
    data: Dict[str, Any] = None              # carried forward to next step
    script: str = None                       # auto-run if pattern/strategy
    script_type: str = "pattern"             # "pattern"|"strategy"|"indicator"
    tool_calls: List[Dict[str, Any]] = []    # [{tool, value}, ...]
```

### Backend → Frontend
```typescript
// on the frontend after await sendChat(...)
addMsg({ role: "agent", content: result.reply });
runToolCalls(result.tool_calls, step.skill, allowedTools);
if (result.script) { auto-run via Web Worker }
if (result.data) { carry forward into accumulatedContext }
```

## 7. Adding a new skill

1. **Create folder**: `skills/<my_skill>/`
2. **`skill.yaml`**:
   ```yaml
   id: my_skill
   name: "My New Skill"
   description: "What it does in one sentence"
   version: "0.1.0"
   tools:
     - script_editor.load
     - notify.toast
     # list only what this skill needs
   ```
3. **`SKILL.md`** — human description (shown in Skills modal)
4. **Add processor** to `core/agents/processors.py`:
   ```python
   async def _my_skill_processor(
       message: str, context: Dict[str, Any], tools: ToolContext,
   ) -> SkillResponse:
       # ... LLM calls, business logic ...
       return SkillResponse(
           reply="Did the thing.",
           tool_calls=[
               {"tool": "notify.toast", "value": {"level": "info", "message": "Done"}},
           ],
       )

   PROCESSORS["my_skill"] = _my_skill_processor
   ```
5. **(Optional) Update planner prompt** if the skill has a specific
   invocation pattern the LLM should know about
6. **(Optional) Add keyword fallback rule** in `_FALLBACK_RULES` if
   there are clear trigger phrases
7. **(Optional) Add sub-plan** in `SKILL_SUB_PLANS` for trace progress
8. **Restart backend** — skill is auto-discovered via
   `core/skill_registry.py`

### Adding a new tool

1. Register in `apps/web/src/lib/toolRegistry.ts`:
   ```typescript
   "my.new.tool": (value, ctx) => {
     // Mutate store
     useStore.getState().doSomething(value);
   },
   ```
2. Whitelist in the skill's `skill.yaml` under `tools:`
3. Skill emits `{tool: "my.new.tool", value: ...}` in its
   `SkillResponse.tool_calls`

No backend knowledge needed for new tools — tools are pure frontend.

## 8. Plain-chat fallback

When the planner returns `{steps: []}` (e.g. user said "hi"), the
frontend falls through to:
```typescript
const result = await sendChat(text, activeMode, stepContext);
```

which still hits `/chat`. The backend's `get_processor(mode)` returns
None for unknown modes → routes to `_plain_chat(message)` which is a
simple LLM call with no tool_calls.

This is the path for free-form questions that don't match any skill.
