---
id: pattern
name: Pattern Skill
tagline: Pattern
description: Detects chart patterns in OHLC data from natural-language hypotheses or visual chart selections.
version: 1.0.0
author: Vibe Trade Core
category: analysis
icon: chart-line
color: "#ff6b00"

# Tools this skill is allowed to invoke. Each id must exist in the central
# tool catalog (skills/tools.py). The frontend enforces this allowlist — a
# skill that emits a tool_call for an id not listed here is rejected.
tools:
  - chart.pattern_selector
  - chart.highlight_matches
  - chart.draw_markers
  - chart.focus_range
  - script_editor.load
  - script_editor.run
  - bottom_panel.activate_tab
  - bottom_panel.set_data
  - notify.toast

# Bottom panel tabs this skill contributes. `component` must match a key in
# apps/web/src/components/BottomPanel.tsx::BOTTOM_PANEL_COMPONENTS.
output_tabs:
  - id: pattern_analysis
    label: Pattern Analysis
    component: PatternContent
  - id: pine_script
    label: Pine Script
    component: PineScriptPanel

# Store slots this skill writes to via tool_calls (documentation only).
store_slots:
  - patternMatches
  - currentScript

# Hints for the chat input when this skill is the only one selected.
input_hints:
  placeholder: "Describe a pattern to detect..."
  supports_fingerprint: true
---

# Pattern Skill

## Purpose

Turn a trader's pattern idea — either written in natural language or drawn
directly on the chart — into a **runnable JavaScript detection script** that
scans the active OHLC dataset and returns match regions. Vibe Trade loads the
script into the code editor, runs it against the data, and surfaces results
in the Pattern Analysis bottom-panel tab.

This skill is the go-to for any "find me X in the price history" question.

## When to use this skill

Vibe Trade should dispatch to the Pattern Skill when the user:

- Describes a **known technical pattern** by name — "bull flag", "double
  bottom", "head and shoulders", "ascending triangle", "breakout", etc.
- Has just **drawn a region on the chart** via the pattern selector (a
  serialized `SHAPE: [...]` fingerprint arrives as the user's message)
- Asks for a **custom indicator** — "RSI smoothed with a 20 EMA", "momentum
  oscillator with z-score normalization", etc.
- Pastes **Pine Script** code and asks for a JavaScript equivalent

## Instructions

1. **If the message is a fingerprint** (contains `SHAPE:` and `Sliding window`):
   - First analyze the shape — what pattern does it resemble, what's the
     trend, the volatility, the implied direction?
   - Ask the user for confirmation before generating a detection script.
   - The chat router stores the fingerprint as `context.pending_fingerprint`
     and waits for a `yes`/`proceed` before dispatching again.

2. **If the message confirms a pending fingerprint** (`context.pending_fingerprint`
   is set and the user said yes), generate a shape-matching script:
   - Use Pearson correlation with threshold `0.50` — NOT 0.85+. Strict
     thresholds silently produce zero matches, which looks like the skill is
     broken.
   - Fall back to returning the top 5 candidates regardless of threshold.
   - Emit `script_editor.load` with the generated JS.
   - Emit `bottom_panel.activate_tab` → `pattern_analysis`.

3. **If the message is a named pattern** ("bull flag", "double bottom"):
   - Generate a detection script using price-structure rules, not shape
     correlation.
   - Use forgiving thresholds (3–5% tolerance, not 1%).
   - Emit the same two tool_calls as above.

4. **If the message is an indicator request** ("custom RSI...", "ATR-based
   stop"):
   - Generate an indicator script that returns an array of values (or null
     for insufficient data).
   - Wrap the result as `script_type: "indicator"` so the frontend registers
     it in the Resources dropdown.

5. **If the user already has a script loaded and asks for a modification**
   (edit mode — `context.pattern_script` is non-empty):
   - Return the modified script in full.
   - Do NOT switch the view to Code — the user is iterating and wants the
     chat feedback inline.

## Inputs

| Key | Type | Meaning |
|---|---|---|
| `message` | string | Natural-language description **or** SHAPE fingerprint |
| `context.pending_fingerprint` | string | Previously-analyzed fingerprint awaiting confirmation |
| `context.pattern_script` | string | Existing script — triggers edit-mode |
| `context.dataset_id` | string | Active dataset id (used when running the script) |

## Outputs

Returns a `SkillResponse` with:

- `reply` — short plain-language explanation of the script
- `script` — the generated JavaScript source
- `script_type` — `"pattern"` / `"indicator"` / `"pine_convert"`
- `data.parameters` — parameter hints extracted from the script
- `data.indicators_used` — list of indicator helpers referenced
- `data.default_params` / `data.indicator_name` — indicator mode only
- `tool_calls` — see below

## Tools used

This skill may emit any of the following tool_calls:

| Tool | When | Payload |
|---|---|---|
| `chart.pattern_selector` | User asks to "mark a pattern" or similar | `true` to open, `false` to close |
| `chart.highlight_matches` | After a successful run with matches | `PatternMatch[]` |
| `chart.draw_markers` | To annotate specific bars | `Marker[]` |
| `chart.focus_range` | To zoom the chart to a match region | `{startTime, endTime}` |
| `script_editor.load` | Always, when a script is generated | The JS source string |
| `script_editor.run` | When the user asks "run it now" | — |
| `bottom_panel.activate_tab` | After generating a script | `"pattern_analysis"` |
| `bottom_panel.set_data` | To push results into a tab's store slot | `{target, data}` |
| `notify.toast` | Non-blocking status ("Found 7 matches") | `{level, message}` |

## Examples

**Natural-language input**
> "Find bull flags after a 5% rally."

→ Returns a script that scans for a strong uptrend followed by a
consolidation in a downward-sloping channel, with 3% tolerance on the flag
bounds. Script loads into the editor; bottom panel switches to Pattern
Analysis.

**Indicator input**
> "Custom RSI smoothed with a 20-period EMA."

→ Returns an indicator function with `default_params = {rsi_period: 14,
ema_period: 20}`. The frontend registers it in Resources and enables it on
the chart.

**Fingerprint input** *(from chart.pattern_selector)*
> `Find this 285-bar pattern (scale-free):`
> `SHAPE: [0.02, 0.25, 0.67, ...]`
> `Sliding window: 285 bars`

→ First pass: analyze the shape, ask for confirmation.
→ On confirmation: generate a correlation-based detector with threshold
0.50 and fallback-to-top-5 so the user always has something to look at.

## Underlying implementation

This skill is wired through `core/agents/processors.py::_pattern_processor`,
which calls `core/agents/pattern_agent.py::PatternAgent.generate`. The
agent owns `PATTERN_SYSTEM_PROMPT`, `INDICATOR_SYSTEM_PROMPT`, and
`PINE_CONVERT_PROMPT`.
