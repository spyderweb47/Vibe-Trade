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

  // ─── simulation.* — multi-agent debate / swarm intelligence ────────────
  "simulation.run_debate": (_args, ctx) => {
    // Triggers the store's runDebate() which calls POST /debate and streams
    // results into currentDebate. The processor calls this backend-side, so
    // this executor is only needed if a frontend-triggered flow uses it.
    useStore.getState().runDebate();
  },

  "simulation.set_debate": (debate, ctx) => {
    if (!debate || typeof debate !== "object") {
      console.warn(`[skill:${ctx.skillId}] simulation.set_debate expected a debate object`);
      return;
    }
    // The backend returns the debate in the API format. The store's
    // setCurrentDebate expects the frontend SimulationDebate shape, so we
    // need to map it. If it's already in the right shape, pass through.
    const d = debate as Record<string, unknown>;

    // Build the SimulationDebate shape from the backend response
    const entities = ((d.entities || []) as Array<Record<string, unknown>>).map((e) => ({
      id: String(e.id || ""),
      name: String(e.name || ""),
      role: String(e.role || ""),
      background: String(e.background || ""),
      bias: String(e.bias || ""),
      personality: String(e.personality || ""),
      stance: e.stance ? String(e.stance) : undefined,
      influence: e.influence != null ? Number(e.influence) : undefined,
      specialization: e.specialization ? String(e.specialization) : undefined,
      tools: (e.tools || []) as string[],
    }));

    const thread = ((d.thread || []) as Array<Record<string, unknown>>).map((m) => ({
      id: String(m.id || ""),
      round: Number(m.round || 0),
      entityId: String(m.entity_id || m.entityId || ""),
      entityName: String(m.entity_name || m.entityName || ""),
      entityRole: String(m.entity_role || m.entityRole || ""),
      content: String(m.content || ""),
      sentiment: Number(m.sentiment || 0),
      pricePrediction: m.price_prediction ?? m.pricePrediction ?? null,
      agreedWith: (m.agreed_with || m.agreedWith || []) as string[],
      disagreedWith: (m.disagreed_with || m.disagreedWith || []) as string[],
      isChartSupport: Boolean(m.is_chart_support || m.isChartSupport),
      toolsUsed: (m.tools_used || m.toolsUsed || []) as string[],
      toolResults: (m.tool_results || m.toolResults || {}) as Record<string, string>,
    }));

    const summary = d.summary as Record<string, unknown> | null;
    const assetInfo = d.asset_info as Record<string, unknown> | undefined;

    // Map intelligence briefing (snake_case → camelCase)
    const intel = d.intel_briefing as Record<string, unknown> | undefined;
    const intelBriefing = intel ? {
      executiveSummary: String(intel.executive_summary || ""),
      bullCase: (intel.bull_case || []) as string[],
      bearCase: (intel.bear_case || []) as string[],
      keyEvents: (intel.key_events || []) as string[],
      sentimentReading: String(intel.sentiment_reading || ""),
      dataPoints: (intel.data_points || []) as string[],
      rawFindings: intel.raw_findings ? {
        recentNews: String((intel.raw_findings as Record<string, unknown>).recent_news || ""),
        marketAnalysis: String((intel.raw_findings as Record<string, unknown>).market_analysis || ""),
        regulatory: String((intel.raw_findings as Record<string, unknown>).regulatory || ""),
        technicalIndicators: String((intel.raw_findings as Record<string, unknown>).technical_indicators || ""),
        keyLevels: String((intel.raw_findings as Record<string, unknown>).key_levels || ""),
      } : undefined,
    } : undefined;

    // Map cross-examination results
    const crossExam = d.cross_exam_results as Array<Record<string, unknown>> | undefined;
    const crossExamResults = crossExam?.map((c) => ({
      entityId: String(c.entity_id || c.entityId || ""),
      entityName: String(c.entity_name || c.entityName || ""),
      entityRole: String(c.entity_role || c.entityRole || ""),
      question: String(c.question || ""),
      response: String(c.response || ""),
      convictionChange: String(c.conviction_change || c.convictionChange || "unchanged") as "unchanged" | "strengthened" | "weakened" | "reversed",
      newSentiment: c.new_sentiment ?? c.newSentiment ?? null,
    }));

    // Map market context (Stage 1 output)
    const mc = d.market_context as Record<string, unknown> | undefined;
    const marketContext = mc ? {
      marketRegime: mc.market_regime ? String(mc.market_regime) : undefined,
      keyPriceLevels: mc.key_price_levels ? {
        strongResistance: ((mc.key_price_levels as Record<string, unknown>).strong_resistance || []) as number[],
        strongSupport: ((mc.key_price_levels as Record<string, unknown>).strong_support || []) as number[],
        recentPivot: (mc.key_price_levels as Record<string, unknown>).recent_pivot as string | number | undefined,
      } : undefined,
      technicalSignals: (mc.technical_signals || []) as string[],
      volumeAnalysis: mc.volume_analysis ? String(mc.volume_analysis) : undefined,
      keyThemes: (mc.key_themes || []) as string[],
      riskEvents: (mc.risk_events || []) as string[],
    } : undefined;

    // Map agent research (per-agent iterative query findings)
    const rawResearch = (d.agent_research || {}) as Record<string, Array<Record<string, unknown>>>;
    const agentResearch: Record<string, Array<{iteration: number; query: string; reasoning: string; tool: string; result: string}>> = {};
    for (const [eid, findings] of Object.entries(rawResearch)) {
      agentResearch[eid] = (findings || []).map((f) => ({
        iteration: Number(f.iteration || 0),
        query: String(f.query || ""),
        reasoning: String(f.reasoning || ""),
        tool: String(f.tool || ""),
        result: String(f.result || ""),
      }));
    }

    // Map convergence timeline
    const timeline = ((d.convergence_timeline || []) as Array<Record<string, unknown>>).map((p) => ({
      round: Number(p.round || 0),
      sentiment: Number(p.sentiment || 0),
    }));

    const mapped = {
      id: String(d.debate_id || d.id || `debate_${Date.now()}`),
      datasetId: String(d.dataset_id || d.datasetId || ""),
      symbol: String(d.symbol || ""),
      assetClass: String(assetInfo?.asset_class || ""),
      assetName: String(assetInfo?.asset_name || d.symbol || ""),
      entities,
      thread,
      currentRound: Number(d.total_rounds || 0),
      totalRounds: Number(d.total_rounds || 0),
      summary: summary
        ? {
            consensusDirection: String(summary.consensus_direction || summary.consensusDirection || "NEUTRAL") as "BULLISH" | "BEARISH" | "NEUTRAL",
            confidence: Number(summary.confidence || 0),
            keyArguments: (summary.key_arguments || summary.keyArguments || []) as string[],
            dissentingViews: (summary.dissenting_views || summary.dissentingViews || []) as string[],
            priceTargets: (summary.price_targets || summary.priceTargets || { low: 0, mid: 0, high: 0 }) as { low: number; mid: number; high: number },
            riskFactors: (summary.risk_factors || summary.riskFactors || []) as string[],
            recommendation: (summary.recommendation || {}) as Record<string, unknown>,
            convictionShifts: (summary.conviction_shifts || summary.convictionShifts || []) as string[],
          }
        : null,
      status: "complete" as const,
      intelBriefing,
      crossExamResults,
      marketContext,
      dataFeeds: (d.data_feeds || {}) as Record<string, string>,
      agentResearch,
      convergenceTimeline: timeline,
    };

    useStore.getState().setCurrentDebate(mapped as never);
  },

  "simulation.reset": (_args, _ctx) => {
    useStore.getState().resetSimulation();
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
