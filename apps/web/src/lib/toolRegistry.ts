/**
 * Frontend tool registry.
 *
 * Skills declare the tools they need in their SKILL.md frontmatter. When a
 * skill handler returns tool_calls in its SkillResponse, this registry:
 *   1. Looks up the executor for each tool id.
 *   2. Rejects any tool not in the skill's declared allowlist (console warn).
 *   3. Invokes the executor with the call's value + context.
 *
 * To add a new tool, register its id + executor here and add the id to the
 * relevant skill's SKILL.md `tools:` list so it's allowed to invoke it.
 */

import { useStore } from "@/store/useStore";
import type { ToolCall } from "@/lib/api";

type ToolExecutor = (
  args: unknown,
  ctx: { skillId: string; allowed: string[] }
) => void;

/**
 * Callbacks the Skill consumer (e.g. RightSidebar) provides so tool calls
 * can drive local component state like `view` (chat/code) and `currentScript`.
 * These are optional — if not provided, the tool executor logs a warning.
 */
export interface ToolSink {
  setCurrentScript?: (script: string) => void;
  setView?: (view: "chat" | "code") => void;
  setBottomPanelTab?: (tabId: string) => void;
  runScript?: () => void;
}

let _sink: ToolSink = {};

export function registerToolSink(sink: ToolSink) {
  _sink = { ..._sink, ...sink };
}

export function clearToolSink() {
  _sink = {};
}

// ─── Executors ─────────────────────────────────────────────────────────────
// Mirrors the backend's skills/tools.py::TOOL_CATALOG. Every tool id in the
// catalog should have an executor here — either a full implementation or a
// stub that console.warn()s so skills see predictable behaviour during
// development. Keep grouped by category for readability.

const executors: Record<string, ToolExecutor> = {
  // ─── script_editor.* ────────────────────────────────────────────────────
  "script_editor.load": (script, ctx) => {
    if (typeof script !== "string") {
      console.warn(`[skill:${ctx.skillId}] script_editor.load expected a string, got`, typeof script);
      return;
    }
    if (!_sink.setCurrentScript) {
      console.warn(`[skill:${ctx.skillId}] script_editor.load called but no sink registered`);
      return;
    }
    // Load script into editor. Do NOT force view="code" here — the consumer
    // (RightSidebar) has richer logic: first-time generation switches to
    // code view, but script EDITS intentionally stay in chat view so the
    // user can read the "Script updated" feedback inline.
    _sink.setCurrentScript(script);
  },

  "script_editor.run": (_args, ctx) => {
    if (!_sink.runScript) {
      console.warn(`[skill:${ctx.skillId}] script_editor.run called but no sink registered`);
      return;
    }
    _sink.runScript();
  },

  // ─── bottom_panel.* ─────────────────────────────────────────────────────
  "bottom_panel.activate_tab": (tabId, ctx) => {
    if (typeof tabId !== "string") {
      console.warn(`[skill:${ctx.skillId}] bottom_panel.activate_tab expected a string, got`, typeof tabId);
      return;
    }
    if (!_sink.setBottomPanelTab) {
      useStore.setState({ pendingBottomPanelTab: tabId } as Record<string, unknown>);
      return;
    }
    _sink.setBottomPanelTab(tabId);
  },

  "bottom_panel.set_data": (args, ctx) => {
    if (!args || typeof args !== "object") {
      console.warn(`[skill:${ctx.skillId}] bottom_panel.set_data expected {target, data}, got`, args);
      return;
    }
    const { target, data } = args as { target?: string; data?: unknown };
    if (!target) return;
    const store = useStore.getState() as unknown as Record<string, unknown>;
    const setter = store[`set${target.charAt(0).toUpperCase()}${target.slice(1)}`];
    if (typeof setter === "function") {
      (setter as (v: unknown) => void)(data);
    } else {
      console.warn(`[skill:${ctx.skillId}] bottom_panel.set_data: no setter for target "${target}"`);
    }
  },

  // ─── chart.* ────────────────────────────────────────────────────────────
  "chart.pattern_selector": (active, ctx) => {
    const isActive = Boolean(active);
    const setter = useStore.getState().setPatternSelectorActive;
    if (typeof setter === "function") setter(isActive);
    else console.warn(`[skill:${ctx.skillId}] setPatternSelectorActive unavailable`);
  },

  "chart.highlight_matches": (matches, ctx) => {
    if (!Array.isArray(matches)) {
      console.warn(`[skill:${ctx.skillId}] chart.highlight_matches expected an array`);
      return;
    }
    useStore.getState().setPatternMatches(matches as never);
  },

  "chart.draw_markers": (_markers, ctx) => {
    // v1: markers are rendered via patternMatches / plotted trades, so this
    // is a pass-through placeholder for future use.
    console.log(`[skill:${ctx.skillId}] chart.draw_markers invoked (no-op in v1)`);
  },

  "chart.focus_range": (args, ctx) => {
    if (!args || typeof args !== "object") {
      console.warn(`[skill:${ctx.skillId}] chart.focus_range expected {startTime, endTime}`);
      return;
    }
    const { startTime, endTime } = args as { startTime?: number; endTime?: number };
    if (typeof startTime !== "number" || typeof endTime !== "number") {
      console.warn(`[skill:${ctx.skillId}] chart.focus_range needs numeric startTime/endTime`);
      return;
    }
    useStore.getState().setChartFocus({ startTime, endTime });
  },

  "chart.set_timeframe": (tf, ctx) => {
    if (tf !== null && typeof tf !== "string") {
      console.warn(`[skill:${ctx.skillId}] chart.set_timeframe expected string|null, got`, typeof tf);
      return;
    }
    useStore.getState().setSelectedTimeframe(tf as string | null);
  },

  // ─── chart.drawing.* — activate specific drawing tool ──────────────────
  "chart.drawing.trendline":       (_a, _c) => useStore.getState().setActiveDrawingTool("trendline" as never),
  "chart.drawing.horizontal_line": (_a, _c) => useStore.getState().setActiveDrawingTool("horizontalLine" as never),
  "chart.drawing.vertical_line":   (_a, _c) => useStore.getState().setActiveDrawingTool("verticalLine" as never),
  "chart.drawing.rectangle":       (_a, _c) => useStore.getState().setActiveDrawingTool("rectangle" as never),
  "chart.drawing.fibonacci":       (_a, _c) => useStore.getState().setActiveDrawingTool("fibonacci" as never),
  "chart.drawing.long_position":   (_a, _c) => useStore.getState().setActiveDrawingTool("longPosition" as never),
  "chart.drawing.short_position":  (_a, _c) => useStore.getState().setActiveDrawingTool("shortPosition" as never),

  // ─── chatbox.card.* — inline cards in the chat ─────────────────────────
  "chatbox.card.strategy_builder": (_args, ctx) => {
    // The strategy form is auto-shown when activeMode === "strategy" and
    // currentScript is empty, so this tool just makes sure strategy is the
    // active skill and the script is cleared. Full "inject any card" is a
    // future extension.
    console.log(`[skill:${ctx.skillId}] chatbox.card.strategy_builder invoked — already auto-shown in strategy mode`);
  },

  "chatbox.card.generic": (args, ctx) => {
    // Stub — generic in-chat cards not yet implemented. Log the payload so
    // skills developing against this tool can see their output in devtools.
    console.log(`[skill:${ctx.skillId}] chatbox.card.generic payload:`, args);
  },

  // ─── data.* — application data ──────────────────────────────────────────
  "data.indicators.add": (args, ctx) => {
    if (!args || typeof args !== "object") {
      console.warn(`[skill:${ctx.skillId}] data.indicators.add expected an IndicatorConfig object`);
      return;
    }
    useStore.getState().addCustomIndicator(args as never);
  },

  "data.indicators.toggle": (name, ctx) => {
    if (typeof name !== "string") {
      console.warn(`[skill:${ctx.skillId}] data.indicators.toggle expected an indicator name string`);
      return;
    }
    useStore.getState().toggleIndicator(name);
  },

  "data.fetch_market": (_args, ctx) => {
    // Pure backend-side action — the processor calls fetchMarketData() during
    // dispatch. No frontend work needed beyond logging for visibility.
    console.log(`[skill:${ctx.skillId}] data.fetch_market dispatched (handled server-side)`);
  },

  "data.dataset.add": (payload, ctx) => {
    // The backend's data fetcher returns a FetchedDataset. Register it in
    // the store via addDataset() so it appears in the datasets modal and
    // becomes the active dataset on the chart.
    if (!payload || typeof payload !== "object") {
      console.warn(`[skill:${ctx.skillId}] data.dataset.add expected a FetchedDataset payload`);
      return;
    }
    const ds = payload as {
      symbol: string;
      source: string;
      interval: string;
      bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
      metadata: { rows: number; startDate: string; endDate: string; symbol: string; nativeTimeframe: string };
    };
    if (!Array.isArray(ds.bars) || ds.bars.length === 0) {
      console.warn(`[skill:${ctx.skillId}] data.dataset.add: bars array missing or empty`);
      return;
    }

    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `ds_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const dataset = {
      id,
      name: `${ds.symbol} (${ds.interval}) — ${ds.source}`,
      metadata: {
        rows: ds.metadata.rows,
        startDate: ds.metadata.startDate,
        endDate: ds.metadata.endDate,
        symbol: ds.symbol,
        nativeTimeframe: ds.metadata.nativeTimeframe,
      },
    };

    // The store's addDataset takes (dataset, chartData, rawData) and
    // immediately switches the active dataset to the new one.
    useStore.getState().addDataset(dataset as never, ds.bars as never, ds.bars as never);

    // Mark the dataset as already synced to the backend (it came FROM the
    // backend), so subsequent chat messages don't try to upload it again.
    useStore.getState().markSynced(id);

    // ALSO push the dataset to the backend's in-memory store so pattern
    // detection / backtesting against it can call /run-pattern, /run-backtest etc.
    // We import lazily to avoid a circular dependency with api.ts.
    import("@/lib/api").then(({ syncDatasetToBackend }) => {
      syncDatasetToBackend(id, ds.bars as never, {
        rows: ds.metadata.rows,
        startDate: ds.metadata.startDate,
        endDate: ds.metadata.endDate,
        filename: dataset.name,
      }).catch((e) => console.warn(`[skill:${ctx.skillId}] dataset backend sync failed:`, e));
    });
  },

  // ─── notify.* — user notifications ─────────────────────────────────────
  "notify.toast": (args, ctx) => {
    // Stub — no toast system yet. Log as a console message so skills can
    // iterate on their toast messages during development.
    const { level = "info", message = "" } = (args as { level?: string; message?: string }) || {};
    const style = level === "error" ? "color:#ff4d4d" : level === "warning" ? "color:#f59e0b" : "color:#26a69a";
    console.log(`%c[${ctx.skillId}] ${level.toUpperCase()}: ${message}`, style);
  },
};

// ─── Public API ────────────────────────────────────────────────────────────

export function runToolCalls(
  calls: ToolCall[] | undefined,
  skillId: string,
  allowed: string[]
): void {
  if (!calls || calls.length === 0) return;
  for (const call of calls) {
    const executor = executors[call.tool];
    if (!executor) {
      console.warn(`[skill:${skillId}] unknown tool: ${call.tool}`);
      continue;
    }
    if (!allowed.includes(call.tool)) {
      console.warn(
        `[skill:${skillId}] skill tried to invoke unauthorized tool: ${call.tool} ` +
        `(declared tools: ${allowed.join(", ") || "none"})`
      );
      continue;
    }
    try {
      // Convention: skills pass the main argument as `value`. Fall back to
      // the whole call for tools that want the full object.
      const arg = call.value !== undefined ? call.value : call;
      executor(arg, { skillId, allowed });
    } catch (err) {
      console.error(`[skill:${skillId}] tool ${call.tool} threw:`, err);
    }
  }
}

export function listRegisteredTools(): string[] {
  return Object.keys(executors);
}
