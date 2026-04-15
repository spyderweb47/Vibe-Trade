---
# ─── Identity ────────────────────────────────────────────────────────────
id: mytemplate
name: My Template Skill
tagline: Template
description: One-sentence description of what this skill does. Shown as a tooltip on the chip.
version: 0.0.1
author: Your Name
category: general
icon: sparkles
color: "#ff6b00"

# ─── Tools ───────────────────────────────────────────────────────────────
# Every id here MUST exist in skills/tools.py::TOOL_CATALOG. Unknown ids
# print a warning at registry load time. The frontend tool registry
# enforces this allowlist — a skill that emits a tool_call for an id not
# declared here will be rejected with a console warning.
tools:
  - script_editor.load
  - bottom_panel.activate_tab
  - notify.toast

# ─── Bottom panel tabs ───────────────────────────────────────────────────
# Tabs this skill contributes. `component` must match a key in
# apps/web/src/components/BottomPanel.tsx::BOTTOM_PANEL_COMPONENTS.
output_tabs:
  - id: mytemplate_output
    label: My Output
    component: PatternContent

# ─── Store slots (documentation only) ────────────────────────────────────
store_slots: []

# ─── Chat input hints ────────────────────────────────────────────────────
# When this is the only active skill, these override the chatbox UI.
input_hints:
  placeholder: "Describe what you want the template skill to do..."
  supports_fingerprint: false
---

# My Template Skill

## Purpose

Replace this paragraph with one or two sentences describing what this skill
does and the user-facing outcome it produces. Keep it concrete — "generates
an equity curve from fundamental data" is better than "does financial stuff".

## When to use this skill

Bullet list of situations where Vibe Trade should dispatch to this skill:

- When the user asks for ...
- When context contains ...
- When the chart panel provides ...

Be specific. If two skills could plausibly handle the same message, the
"when to use" sections decide which one Vibe Trade picks.

## Instructions

Numbered, imperative steps that describe exactly what the skill's processor
should do for each input shape:

1. **If the message is type A:** do X, emit tool Y, return Z.
2. **If `context.foo` is present:** branch into the Y workflow.
3. **Otherwise:** default behavior.

Keep each step testable and concrete. The less ambiguity, the less
LLM-induced drift.

## Inputs

| Key | Type | Meaning |
|---|---|---|
| `message` | string | The user's chat message |
| `context.<key>` | *type* | Whatever your skill cares about from the router |

## Outputs

Describe what the `SkillResponse` will contain:

- `reply` — ...
- `script` — optional ...
- `data.*` — optional ...

## Tools used

| Tool | When | Payload |
|---|---|---|
| `script_editor.load` | When a script is generated | The JS source string |
| `bottom_panel.activate_tab` | After generating output | The target tab id |
| `notify.toast` | For transient status messages | `{level, message}` |

## Examples

**Example 1**
> User input: "Do the thing with the stuff."

→ What the skill returns and why.

**Example 2**
> User input: (a more complex variant)

→ How the skill handles it differently.

## Underlying implementation

This template has no Python processor yet. To wire it up:

1. Add an `async def _mytemplate_processor(message, context, tools)` in
   `core/agents/processors.py`
2. Register it in the `PROCESSORS` dict:
   ```python
   PROCESSORS = {
       ...,
       "mytemplate": _mytemplate_processor,
   }
   ```
3. Restart the backend. The `VibeTrade.dispatch("mytemplate", ...)` call
   will now route here.

## Frontmatter reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique kebab-case identifier (also the folder name) |
| `name` | string | Full display name shown in the chip row |
| `tagline` | string | Short label (1 word) for compact UI |
| `description` | string | One-sentence description; shown as a tooltip |
| `version`, `author` | string | Informational, surfaced in a future "skill info" UI |
| `category` | string | `analysis`, `generation`, `simulation`, etc. (free-form) |
| `icon` | string | Icon name; resolved on the frontend. Unknown icons fall back to sparkle |
| `color` | string | Hex color used for the chip accent |
| `tools` | string[] | Allowlist of tool ids from `skills/tools.py::TOOL_CATALOG` |
| `output_tabs` | object[] | Bottom-panel tabs this skill contributes |
| `store_slots` | string[] | Documentation-only: store keys this skill writes |
| `input_hints.placeholder` | string | Chat textarea placeholder when this is the only active skill |
| `input_hints.supports_fingerprint` | bool | `true` if your skill accepts SHAPE fingerprints from the chart selector |

## Available tools

See `skills/tools.py::TOOL_CATALOG` for the full list. The tool categories
are:

- **`chart.drawing.*`** — activate a drawing tool (trendline, rectangle, fib, etc.)
- **`chart.pattern_selector`** — open the pattern selector to capture a fingerprint
- **`chart.highlight_matches`** / **`chart.draw_markers`** — chart overlays
- **`chart.focus_range`** / **`chart.set_timeframe`** — chart navigation
- **`chatbox.card.strategy_builder`** — inject the strategy builder form in chat
- **`chatbox.card.generic`** — inject a generic card with title/body/actions
- **`bottom_panel.activate_tab`** / **`bottom_panel.set_data`** — bottom panel control
- **`script_editor.load`** / **`script_editor.run`** — code editor control
- **`data.indicators.add`** / **`data.indicators.toggle`** — indicator registry
- **`notify.toast`** — user notifications

Only declare tools in the frontmatter that your processor actually uses.
The frontend tool registry rejects any tool_call whose id isn't in the
skill's declared list.
