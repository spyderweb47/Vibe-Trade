"""
Central tool catalog — Layer 2 of the Vibe Trade architecture.

A **tool** is any product feature that a skill can invoke to affect the
Canvas (UI), read data, or trigger an action. Tools are the bridge between
the AI agent's decisions and the user-visible product.

  Layer 1 — Canvas:  UI components, store, chart        (apps/web/src/)
  Layer 2 — Tools:   this file + toolRegistry.ts         (core/tool_catalog.py)
  Layer 3 — Skills:  SKILL.md instruction files          (skills/{name}/SKILL.md)

Skills declare which tools they need in their SKILL.md `tools:` frontmatter.
The SkillRegistry validates those ids against this catalog on load. The
frontend mirror registry (`apps/web/src/lib/toolRegistry.ts`) implements
each executor and enforces the declared allowlist at runtime.

**Adding a new tool:**
  1. Add a `ToolDef(...)` entry here in the right category
  2. Add a matching executor in `toolRegistry.ts`
  3. Reference the tool id from any `SKILL.md` that should be able to call it

Categories (prefixes):
  chart            — chart interactions (draw, highlight, focus, timeframe)
  chart.drawing    — specific drawing-tool activations
  chatbox.card     — inline cards injected into the chat flow
  bottom_panel     — bottom panel tab + data control
  script_editor    — code editor load/run
  data             — read/write application data (indicators, datasets)
  simulation       — multi-agent debate / swarm intelligence
  news             — historic news events (markers + bottom panel)
  notify           — user-facing notifications
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ToolDef:
    """A tool that skills can declare + invoke via `tool_calls`."""

    id: str
    name: str
    category: str
    description: str
    # Informal JSON-Schema-ish description of the expected argument shape.
    # Not enforced at runtime — the frontend executor decides how to parse it.
    input_schema: Dict[str, Any] = field(default_factory=dict)
    # How the argument is passed in a tool_call dict. "value" means the
    # handler sends {"tool": id, "value": X}; "object" means the handler
    # sends {"tool": id, ...fields}.
    arg_style: str = "value"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "input_schema": self.input_schema,
            "arg_style": self.arg_style,
        }


# ─── Tool catalog ─────────────────────────────────────────────────────────
# Ordered by category for readability. Add new tools to the right section.

TOOL_CATALOG: List[ToolDef] = [
    # ─── chart.drawing.* — drawing tool activations ──────────────────────
    ToolDef(
        id="chart.drawing.trendline",
        name="Trendline",
        category="chart.drawing",
        description="Activate the trendline drawing tool so the user can draw a trend line on the chart.",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.horizontal_line",
        name="Horizontal Line",
        category="chart.drawing",
        description="Activate the horizontal line drawing tool (for support/resistance levels).",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.vertical_line",
        name="Vertical Line",
        category="chart.drawing",
        description="Activate the vertical line drawing tool (for time-based markers).",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.rectangle",
        name="Rectangle",
        category="chart.drawing",
        description="Activate the rectangle drawing tool for boxing ranges.",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.fibonacci",
        name="Fibonacci Retracement",
        category="chart.drawing",
        description="Activate the Fibonacci retracement drawing tool.",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.long_position",
        name="Long Position",
        category="chart.drawing",
        description="Activate the long-position box drawing tool (entry, target, stop).",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chart.drawing.short_position",
        name="Short Position",
        category="chart.drawing",
        description="Activate the short-position box drawing tool.",
        input_schema={"type": "null"},
    ),

    # ─── chart.* — chart interactions ─────────────────────────────────────
    ToolDef(
        id="chart.pattern_selector",
        name="Pattern Selector",
        category="chart",
        description="Open the chart pattern selector so the user can drag a region; on release "
                    "a serialized SHAPE fingerprint is sent back to this skill.",
        input_schema={"type": "boolean", "description": "true to activate, false to close"},
    ),
    ToolDef(
        id="chart.highlight_matches",
        name="Highlight Pattern Matches",
        category="chart",
        description="Render pattern-match regions as overlays on the chart. Replaces any prior matches.",
        input_schema={"type": "array", "items": {"type": "object"}, "description": "PatternMatch[] with {id,name,startTime,endTime,direction,confidence}"},
    ),
    ToolDef(
        id="chart.draw_markers",
        name="Chart Markers",
        category="chart",
        description="Place annotation markers at specific bar indices on the chart.",
        input_schema={"type": "array", "items": {"type": "object"}},
    ),
    ToolDef(
        id="chart.focus_range",
        name="Focus Time Range",
        category="chart",
        description="Pan/zoom the chart to a specific time range so the user sees the region of interest.",
        input_schema={"type": "object", "properties": {"startTime": "number", "endTime": "number"}},
        arg_style="object",
    ),
    ToolDef(
        id="chart.set_timeframe",
        name="Set Timeframe",
        category="chart",
        description="Change the chart's active timeframe (e.g. '1h', '4h', '1D'). Null means auto.",
        input_schema={"type": ["string", "null"]},
    ),

    # ─── chatbox.card.* — inline cards inside the chat ───────────────────
    ToolDef(
        id="chatbox.card.strategy_builder",
        name="Strategy Builder Card",
        category="chatbox.card",
        description="Inject the strategy builder form into the chat flow. The user fills it in and submits.",
        input_schema={"type": "null"},
    ),
    ToolDef(
        id="chatbox.card.generic",
        name="Generic Card",
        category="chatbox.card",
        description="Inject a generic card with a title, body, and optional action buttons into the chat.",
        input_schema={
            "type": "object",
            "properties": {
                "title": "string",
                "body": "string",
                "actions": "array<{label:string, tool_call:ToolCall}>",
            },
        },
        arg_style="object",
    ),

    # ─── bottom_panel.* — bottom panel tab control ──────────────────────
    ToolDef(
        id="bottom_panel.activate_tab",
        name="Activate Bottom Tab",
        category="bottom_panel",
        description="Switch the bottom panel to a specific tab id (must be contributed by an active skill).",
        input_schema={"type": "string"},
    ),
    ToolDef(
        id="bottom_panel.set_data",
        name="Set Bottom Panel Data",
        category="bottom_panel",
        description="Push data into a named store slot so a bottom panel tab can read it.",
        input_schema={"type": "object", "properties": {"target": "string", "data": "any"}},
        arg_style="object",
    ),

    # ─── script_editor.* — code editor ──────────────────────────────────
    ToolDef(
        id="script_editor.load",
        name="Load Script",
        category="script_editor",
        description="Load a JavaScript source string into the code editor. "
                    "Does NOT force the view — that's RightSidebar's job based on first-time-vs-edit.",
        input_schema={"type": "string"},
    ),
    ToolDef(
        id="script_editor.run",
        name="Run Script",
        category="script_editor",
        description="Trigger a run of the currently loaded script.",
        input_schema={"type": "null"},
    ),

    # ─── data.* — application data access ────────────────────────────────
    ToolDef(
        id="data.indicators.add",
        name="Register Indicator",
        category="data",
        description="Register a custom indicator in the Resources dropdown.",
        input_schema={"type": "object"},
        arg_style="object",
    ),
    ToolDef(
        id="data.indicators.toggle",
        name="Toggle Indicator",
        category="data",
        description="Toggle an existing indicator's active state by name.",
        input_schema={"type": "string"},
    ),
    ToolDef(
        id="data.fetch_market",
        name="Fetch Market Data",
        category="data",
        description="Fetch historical OHLCV bars from yfinance (stocks) or ccxt (crypto). "
                    "Returns a dataset that can be loaded onto the chart via data.dataset.add.",
        input_schema={
            "type": "object",
            "properties": {
                "symbol": "string",
                "source": "auto|yfinance|ccxt",
                "interval": "1m|5m|15m|30m|1h|4h|1d|1w|1mo",
                "limit": "number",
                "exchange": "binance|coinbase|kraken|okx (ccxt only)",
            },
        },
        arg_style="object",
    ),
    ToolDef(
        id="data.dataset.add",
        name="Add Dataset",
        category="data",
        description="Register a fetched dataset in the platform — adds it to the datasets list, "
                    "stores its bars, and switches the chart to it. The fetched payload from "
                    "data.fetch_market is the expected input shape.",
        input_schema={
            "type": "object",
            "properties": {
                "symbol": "string",
                "source": "string",
                "interval": "string",
                "bars": "OHLCBar[]",
                "metadata": "object",
            },
        },
        arg_style="object",
    ),

    # ─── simulation.* — multi-agent debate / swarm intelligence ────────
    ToolDef(
        id="simulation.run_debate",
        name="Run Debate",
        category="simulation",
        description="Execute a multi-agent debate on the active dataset. "
                    "AI personas argue the asset across multiple rounds and converge on a consensus.",
        input_schema={
            "type": "object",
            "properties": {
                "bars_count": "number (10-500, default 500)",
                "context": "string — optional market context or news report to seed the debate",
            },
        },
        arg_style="object",
    ),
    ToolDef(
        id="simulation.set_debate",
        name="Set Debate Data",
        category="simulation",
        description="Push a full SimulationDebate object into the store so bottom-panel tabs can render it.",
        input_schema={"type": "object", "description": "SimulationDebate"},
    ),
    ToolDef(
        id="simulation.reset",
        name="Reset Debate",
        category="simulation",
        description="Clear the current debate and history from the store.",
        input_schema={"type": "null"},
    ),

    # ─── news.* — historic news events ──────────────────────────────────
    ToolDef(
        id="news.events.set",
        name="Set News Events",
        category="news",
        description="Push a list of historic news events into the store. The chart primitive "
                    "renders them as markers, and the Historic News tab lists them. The payload "
                    "is {symbol, events[]} where each event has timestamp (unix seconds), "
                    "headline, summary, source, url, category, impact, direction.",
        input_schema={
            "type": "object",
            "properties": {
                "symbol": "string",
                "events": "array<NewsEvent>",
            },
        },
        arg_style="object",
    ),

    # ─── notify.* — notifications ───────────────────────────────────────
    ToolDef(
        id="notify.toast",
        name="Toast Notification",
        category="notify",
        description="Show a transient toast notification to the user.",
        input_schema={
            "type": "object",
            "properties": {"level": "info|warning|error", "message": "string"},
        },
        arg_style="object",
    ),
]


def get_tool(tool_id: str) -> Optional[ToolDef]:
    """Look up a tool by id."""
    for tool in TOOL_CATALOG:
        if tool.id == tool_id:
            return tool
    return None


def catalog_to_json() -> List[Dict[str, Any]]:
    """Serialize the full catalog for the `/tools` endpoint."""
    return [t.to_dict() for t in TOOL_CATALOG]


def validate_tools(tool_ids: List[str], skill_id: str = "<unknown>") -> List[str]:
    """
    Check that every id is in the catalog. Returns the list of unknown ids.
    Called by SkillRegistry at skill-load time; unknown ids get a warning
    printed but don't block loading (so skills can reference not-yet-added
    tools during development).
    """
    unknown = []
    for tid in tool_ids:
        if get_tool(tid) is None:
            unknown.append(tid)
    if unknown:
        print(
            f"[tools] skill '{skill_id}' declares unknown tools: {unknown}. "
            f"Add them to TOOL_CATALOG in skills/tools.py or fix the SKILL.md."
        )
    return unknown
