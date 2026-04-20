"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/store/useStore";
import { ScriptEditor } from "./ScriptEditor";
import { sendChat } from "@/lib/api";
import { executePatternScript } from "@/lib/scriptExecutor";
import { executeStrategy } from "@/lib/strategyExecutor";
import { StrategyForm } from "./StrategyForm";
import { TradingPanel } from "./playground/TradingPanel";
import { SimulationPanel } from "./simulation/SimulationPanel";
import { ChatInputBar } from "./ChatInputBar";
import { DatasetsModal } from "./DatasetsModal";
import { TraceMessage } from "./TraceMessage";
import { registerToolSink, runToolCalls } from "@/lib/toolRegistry";
import { executePlanInBrowser } from "@/lib/planExecutor";
import { getPlan } from "@/lib/api";
import type { StrategyConfig } from "@/types";

export function RightSidebar() {
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "code">("chat");
  const currentScript = useStore((s) => s.currentScript);
  const setCurrentScript = useStore((s) => s.setCurrentScript);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const loadingConversationIds = useStore((s) => s.loadingConversationIds);
  const setConversationLoading = useStore((s) => s.setConversationLoading);
  const addMessageToConversation = useStore((s) => s.addMessageToConversation);
  const loading = activeConversationId ? loadingConversationIds.has(activeConversationId) : false;
  const [runState, setRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [datasetsOpen, setDatasetsOpen] = useState(false);
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMode = useStore((s) => s.activeMode);
  const activeSkillIds = useStore((s) => s.activeSkillIds);
  const skills = useStore((s) => s.skills);
  const appMode = useStore((s) => s.appMode);
  const messages = useStore((s) => s.messages);
  const addMessage = useStore((s) => s.addMessage);
  const updateMessage = useStore((s) => s.updateMessage);
  const activeDataset = useStore((s) => s.activeDataset);
  const datasets = useStore((s) => s.datasets);
  const indicators = useStore((s) => s.indicators);
  const strategyConfig = useStore((s) => s.strategyConfig);
  const setStrategyConfig = useStore((s) => s.setStrategyConfig);
  const setBacktestResults = useStore((s) => s.setBacktestResults);
  const addScript = useStore((s) => s.addScript);
  const addCustomIndicator = useStore((s) => s.addCustomIndicator);
  const setPatternMatches = useStore((s) => s.setPatternMatches);
  const patternMatches = useStore((s) => s.patternMatches);
  const chatInputDraft = useStore((s) => s.chatInputDraft);
  const setChatInputDraft = useStore((s) => s.setChatInputDraft);

  // Register tool sink callbacks so skill tool_calls can drive local state.
  // The sink is re-registered on every render so setCurrentScript/setView
  // capture the latest closures.
  useEffect(() => {
    registerToolSink({
      setCurrentScript,
      setView,
      setBottomPanelTab: (tabId: string) => {
        useStore.setState({ pendingBottomPanelTab: tabId } as Record<string, unknown>);
      },
      runScript: () => {
        // Defer to handleRun / handleBacktest via DOM trigger; both rely on
        // currentScript from state which is already set by this point.
      },
    });
  });

  // Pick up prefilled chat input from the store (e.g. from "Send to Agent" on chart)
  useEffect(() => {
    if (chatInputDraft) {
      setInput(chatInputDraft);
      setChatInputDraft("");
      setView("chat");
    }
  }, [chatInputDraft, setChatInputDraft]);

  useEffect(() => {
    if (view !== "chat") return;
    // Defer to next frame so the chat container has actually mounted and
    // laid out its children after a tab switch.
    const id = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [messages, view]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const text = input.trim();
    const conversationId = activeConversationId;
    if (!conversationId) return;
    setInput("");
    addMessage({ role: "user", content: text });
    setConversationLoading(conversationId, true);

    // Helper: add a message to THIS conversation even if the user switched away
    const addMsg = (msg: { role: 'user' | 'agent' | 'trace'; content: string; trace?: import('@/types').TraceData }) => {
      const currentActive = useStore.getState().activeConversationId;
      if (currentActive === conversationId) {
        return addMessage(msg);
      }
      return addMessageToConversation(conversationId, msg);
    };

    try {
      // Always run through the planner so the trace UI shows progress for
      // every request — even single-skill tasks. The sub-planner trace
      // gives real-time insight into what each skill is doing. If the LLM
      // planner is slow or unavailable the backend has a keyword fallback
      // (see core/agents/planner._keyword_fallback) that guarantees common
      // intents ("fetch X", "run swarm", "find pattern") still produce a
      // one-step plan instead of silently falling through to plain chat.
      //
      // availableSkills is intentionally left `undefined` (= planner
      // considers all registered skills). We used to restrict it to the
      // user's activeSkillIds, but that backfired when chip selection
      // (e.g. default "pattern") didn't match the typed intent
      // (e.g. "run swarm intelligence") — the planner would either
      // return empty or try to stuff the request into a single wrong
      // skill. Typed intent always wins; chip selection stays as UI
      // organisation only.
      const skillCount = activeSkillIds.size;
      // Surface an interim trace message so the user sees immediate
      // feedback while the /plan call is in-flight. If the planner
      // returns a real plan, executePlanInBrowser replaces this trace;
      // if it fails, the catch block marks the trace as failed.
      const planningTraceId = addMsg({
        role: "trace",
        content: "",
        trace: {
          status: "planning",
          title: "Planning your request...",
          steps: [
            { skill: "planner", message: "Thinking about which skills to use", status: "running" },
          ],
        },
      });
      try {
        // Pass undefined → planner sees all registered skills. See
        // rationale comment above.
        void skillCount; // kept for any future "show-me-a-warning" logic
        const planResult = await getPlan(text, undefined, undefined);
        if (planResult.steps && planResult.steps.length > 0) {
          // Hand the interim planning trace off to the executor — it
          // will mutate the same trace card in place to show per-step
          // progress. Previously we used `updateMessage` to mark it
          // done and then called `executePlanInBrowser` which created
          // ANOTHER trace card, so users saw two stacked planner
          // cards for every request. Reusing avoids that.
          await executePlanInBrowser({
            steps: planResult.steps,
            existingTraceId: planningTraceId,
          });
          return;
        }
        // Empty plan — mark as skipped so the trace card doesn't sit
        // forever in 'running' state.
        updateMessage(planningTraceId, {
          trace: {
            status: "done",
            title: "No plan needed",
            steps: [
              { skill: "planner", message: "Routing directly to chat", status: "done" },
            ],
          },
        });
      } catch (err) {
        console.warn("Plan endpoint failed, falling back to general chat:", err);
        updateMessage(planningTraceId, {
          trace: {
            status: "failed",
            title: "Planning failed — using direct chat",
            steps: [
              { skill: "planner", message: String(err).slice(0, 160), status: "failed" },
            ],
          },
        });
      }

      // Auto-sync dataset to backend if needed
      if (activeDataset && !useStore.getState().syncedDatasets.has(activeDataset)) {
        try {
          const rawData = useStore.getState().datasetRawData[activeDataset] || useStore.getState().datasetChartData[activeDataset];
          const ds = datasets.find((d) => d.id === activeDataset);
          if (rawData?.length) {
            const { syncDatasetToBackend } = await import("@/lib/api");
            await syncDatasetToBackend(activeDataset, rawData, {
              rows: rawData.length,
              startDate: ds?.metadata?.startDate || "",
              endDate: ds?.metadata?.endDate || "",
              filename: ds?.name || "dataset",
            });
            useStore.getState().markSynced(activeDataset);
          }
        } catch { /* continue even if sync fails */ }
      }

      // If sending new pattern fingerprint data, don't pass old script (prevents edit mode)
      const isNewFingerprint = text.includes("TRIGGER SHAPE:") || text.includes("SHAPE:");
      // Multi-chart context: every request sees all loaded chart windows
      // on the Canvas, so skills can opt into multi-dataset behavior
      // (portfolio swarm debate, per-chart pattern detection, etc.).
      // Skills that only know about dataset_id fall back to the focused
      // window, same as before.
      const canvasDatasetIds = useStore
        .getState()
        .chartWindows.map((w) => w.datasetId)
        .filter((id): id is string => Boolean(id));
      const result = await sendChat(text, activeMode, {
        dataset_id: activeDataset,
        dataset_ids: canvasDatasetIds,
        pattern_script: isNewFingerprint ? "" : currentScript,
        strategy_config: strategyConfig || undefined,
        pending_fingerprint: isNewFingerprint ? undefined : (pendingFingerprint || undefined),
      });

      if (isNewFingerprint) setPendingFingerprint(null);

      addMsg({ role: "agent", content: result.reply });

      const newPending = (result.data as Record<string, unknown>)?.pending_fingerprint as string | undefined;
      setPendingFingerprint(newPending || null);

      // Only run tool_calls if the user is still on this conversation
      // (tool calls mutate live store state like chartData, patternMatches, etc.)
      if (result.tool_calls && result.tool_calls.length > 0) {
        if (useStore.getState().activeConversationId === conversationId) {
          const activeSkill = skills.find((s) => s.id === activeMode);
          runToolCalls(result.tool_calls, activeMode, activeSkill?.tools || []);
        }
      }

      if (activeMode === "strategy" && result.script) {
        if (useStore.getState().activeConversationId === conversationId) {
          setCurrentScript(result.script);
          setView("code");
        }
      } else if (result.script && result.script_type === "indicator") {
        const indName = (result.data as Record<string, unknown>)?.indicator_name as string || "Custom";
        const defaultParams = (result.data as Record<string, unknown>)?.default_params as Record<string, string> || {};
        const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
        addCustomIndicator({
          name: indName,
          backendName: indName.toLowerCase().replace(/\s+/g, "_"),
          active: true,
          params: defaultParams,
          script: result.script,
          custom: true,
          color: colors[indicators.length % colors.length],
        });
        addMsg({ role: "agent", content: `Custom indicator "${indName}" added to Resources and enabled on chart.` });
      } else if (result.script) {
        if (useStore.getState().activeConversationId === conversationId) {
          const isEdit = currentScript.length > 0;
          setCurrentScript(result.script);
          if (!isEdit) setView("code");
          if (isEdit) addMsg({ role: "agent", content: "Script updated. Switch to CODE tab to see changes, then click Run." });
        }
      }
    } catch (err) {
      addMsg({
        role: "agent",
        content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
      });
    } finally {
      setConversationLoading(conversationId, false);
    }
  };

  const datasetRawData = useStore((s) => s.datasetRawData);
  const chartData = useStore((s) => s.chartData);

  const setLastScriptResult = useStore((s) => s.setLastScriptResult);

  const handleRun = async () => {
    // Use currentScript state, or fall back to textarea DOM value
    const script = currentScript || (document.querySelector('textarea') as HTMLTextAreaElement)?.value || "";
    if (!script) return;
    if (!currentScript) setCurrentScript(script);

    // Multi-chart pattern detection: run the same script against every
    // loaded chart window on the canvas. Matches are stored per-dataset
    // so each ChartWindow renders only its own detections, AND the
    // bottom panel aggregates across all datasets for a unified list.
    // Falls back to the legacy single-chart path when the canvas has
    // no windows with data (older UI code paths).
    const state = useStore.getState();
    const windowsWithData = state.chartWindows
      .map((w) => {
        const dsid = w.datasetId;
        const bars = dsid ? state.datasetChartData[dsid] : undefined;
        return dsid && bars && bars.length > 0 ? { datasetId: dsid, bars } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const setPatternMatchesForDataset = state.setPatternMatchesForDataset;

    if (windowsWithData.length === 0) {
      // Legacy single-chart fallback
      const runData = chartData;
      if (!runData || runData.length === 0) {
        addMessage({ role: "agent", content: "No data available. Upload a dataset first." });
        return;
      }
      setRunState("running");
      try {
        const matches = await executePatternScript(script, runData);
        setPatternMatches(matches);
        setLastScriptResult({ ran: true });
        setRunState(matches.length > 0 ? "done" : "idle");
        addMessage({
          role: "agent",
          content: matches.length > 0
            ? `Found ${matches.length} pattern matches.`
            : `Script ran on ${runData.length} bars but found 0 matches. Try lowering the correlation threshold or adjusting the pattern.`,
        });
        if (matches.length > 0) setTimeout(() => setRunState("idle"), 2000);
      } catch (err) {
        setRunState("error");
        const errMsg = err instanceof Error ? err.message : "Failed";
        setPatternMatches([]);
        setLastScriptResult({ ran: true, error: errMsg });
        addMessage({ role: "agent", content: `Run error: ${errMsg}` });
        setTimeout(() => setRunState("idle"), 3000);
      }
      return;
    }

    // Multi-chart path: scan every loaded canvas window.
    setRunState("running");
    try {
      const perChart: Array<{ symbol: string; count: number }> = [];
      let totalMatches = 0;
      for (const { datasetId, bars } of windowsWithData) {
        const matches = await executePatternScript(script, bars);
        setPatternMatchesForDataset(datasetId, matches);
        totalMatches += matches.length;
        const ds = datasets.find((d) => d.id === datasetId);
        const sym = String(ds?.metadata?.symbol || ds?.name || "?");
        perChart.push({ symbol: sym, count: matches.length });
      }

      setLastScriptResult({ ran: true });
      setRunState(totalMatches > 0 ? "done" : "idle");

      const breakdown = perChart.map((p) => `${p.symbol}: ${p.count}`).join(", ");
      addMessage({
        role: "agent",
        content:
          perChart.length === 1
            ? (totalMatches > 0
                ? `Found ${totalMatches} pattern matches on ${perChart[0].symbol}.`
                : `Script ran on ${perChart[0].symbol} but found 0 matches.`)
            : (totalMatches > 0
                ? `Found ${totalMatches} total matches across ${perChart.length} charts (${breakdown}).`
                : `Script ran across ${perChart.length} charts (${breakdown}) but found 0 matches.`),
      });

      if (totalMatches > 0) setTimeout(() => setRunState("idle"), 2000);
    } catch (err) {
      setRunState("error");
      const errMsg = err instanceof Error ? err.message : "Failed";
      setPatternMatches([]);
      setLastScriptResult({ ran: true, error: errMsg });
      addMessage({ role: "agent", content: `Run error: ${errMsg}` });
      setTimeout(() => setRunState("idle"), 3000);
    }
  };

  const handleStrategySubmit = async (config: StrategyConfig) => {
    const convId = activeConversationId;
    setStrategyConfig(config);
    if (convId) setConversationLoading(convId, true);
    addMessage({ role: "user", content: `Strategy: Entry=${config.entryCondition}, Exit=${config.exitCondition || "TP/SL only"}, TP=${config.takeProfit.value}${config.takeProfit.type === "percentage" ? "%" : "$"}, SL=${config.stopLoss.value}${config.stopLoss.type === "percentage" ? "%" : ""}, Max DD=${config.maxDrawdown}%, Seed=$${config.seedAmount}${config.specialInstructions ? ", Special: " + config.specialInstructions : ""}` });

    try {
      const result = await sendChat("Generate strategy", activeMode, {
        strategy_config: config,
      });
      addMessage({ role: "agent", content: result.reply || "Strategy script generated." });

      if (result.script) {
        setCurrentScript(result.script);
        setView("code");
        addMessage({ role: "agent", content: "Script loaded in Code tab. Review and click Run Backtest when ready." });
      }
    } catch (err) {
      addMessage({ role: "agent", content: `Error: ${err instanceof Error ? err.message : "Failed"}` });
    } finally {
      if (convId) setConversationLoading(convId, false);
    }
  };

  const handleBacktest = async () => {
    const script = currentScript || (document.querySelector('textarea') as HTMLTextAreaElement)?.value || "";
    if (!script || !activeDataset) {
      addMessage({ role: "agent", content: !script ? "No strategy script. Generate one first." : "No dataset loaded." });
      return;
    }
    setRunState("running");

    const runData = chartData;
    if (!runData || runData.length === 0) {
      addMessage({ role: "agent", content: "No data. Upload a dataset first." });
      setRunState("idle");
      return;
    }

    try {
      const config = strategyConfig || {
        entryCondition: "", exitCondition: "",
        takeProfit: { type: "percentage" as const, value: 5 },
        stopLoss: { type: "percentage" as const, value: 2 },
        maxDrawdown: 20, seedAmount: 10000, specialInstructions: "",
      };
      const result = await executeStrategy(script, runData, config);
      setBacktestResults(result);
      setRunState("done");
      addMessage({
        role: "agent",
        content: `Backtest complete: ${result.totalTrades} trades, ${(result.winRate * 100).toFixed(1)}% win rate, ${(result.totalReturn * 100).toFixed(1)}% return, Sharpe ${result.sharpeRatio}.`,
      });

      // Get AI analysis
      try {
        const analysisResult = await sendChat("Analyze results", activeMode, {
          strategy_config: config,
          analyze_results: result.metrics || {},
        });
        const suggestions = (analysisResult.data as Record<string, unknown>)?.suggestions as string[] || [];
        setBacktestResults({ ...result, analysis: analysisResult.reply, suggestions });
        if (analysisResult.reply) addMessage({ role: "agent", content: analysisResult.reply });
      } catch { /* analysis optional */ }

      setTimeout(() => setRunState("idle"), 2000);
    } catch (err) {
      setRunState("error");
      addMessage({
        role: "agent",
        content: `Backtest error: ${err instanceof Error ? err.message : "Failed"}`,
      });
      setTimeout(() => setRunState("idle"), 3000);
    }
  };

  const handleSave = () => {
    if (!currentScript) return;
    addScript({
      id: crypto.randomUUID(),
      name: `${activeMode}_${Date.now()}`,
      code: currentScript,
      type: activeMode === "strategy" ? "strategy" : "pattern",
    });
    addMessage({ role: "agent", content: "Script saved." });
  };


  const placeholder: Record<string, string> = {
    pattern: "Describe a pattern to detect...",
    strategy: "Describe a trading strategy...",
  };

  return (
    <div className="flex w-full h-full flex-col" style={{ background: "var(--surface)" }}>

      {/* Strategy form is rendered inside the chat area as a floating card */}

      {/* ─── Trading Panel (Playground mode) ─── */}
      {appMode === "playground" && (
        <div className="flex flex-1 flex-col min-h-0">
          <TradingPanel />
        </div>
      )}

      {/* ─── Simulation Panel (Simulation mode) ─── */}
      {appMode === "simulation" && (
        <div className="flex flex-1 flex-col min-h-0">
          <SimulationPanel />
        </div>
      )}

      {/* ─── Agent Section (Building mode) ─── */}
      {appMode === "building" && (
      <div className="flex flex-1 flex-col min-h-0">
        {/* Minimal Chat/Code toggle */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-1.5 shrink-0">
          <div className="flex rounded-md p-[2px]" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            {(["chat", "code"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className="rounded px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors"
                style={{
                  background: view === v ? "var(--accent)" : "transparent",
                  color: view === v ? "#000" : "var(--text-tertiary)",
                }}
              >
                {v}
              </button>
            ))}
          </div>
          {view === "code" && currentScript && (
            <>
              <button
                onClick={activeMode === "strategy" ? handleBacktest : handleRun}
                disabled={loading || !activeDataset || runState === "running" || (activeMode === "strategy" && !currentScript)}
                className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-all disabled:opacity-40"
                style={{
                  background: runState === "running" ? "#f59e0b"
                    : runState === "done" ? "#10b981"
                    : runState === "error" ? "#ef4444"
                    : "var(--surface-2)",
                  color: runState !== "idle" ? "#fff" : "var(--text-primary)",
                  border: "1px solid var(--border)",
                }}
              >
                {runState === "running" ? "Running..." : runState === "done" ? "Done" : runState === "error" ? "Failed" : "Run"}
              </button>
              <button
                onClick={handleSave}
                className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors"
                style={{ background: "var(--surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)" }}
              >
                Save
              </button>
              {/* Clear chart visual output.
                  Scoped to JUST the visual outputs on chart windows —
                  pattern matches (global + per-dataset), chart focus
                  state, backtest plotted trades, pine drawings, pattern
                  highlights. Keeps the script, backtestResults, and
                  user-drawn drawings (trend lines, fibs) intact so users
                  can re-run without losing their own work. */}
              <button
                onClick={() => {
                  const state = useStore.getState();
                  // Global pattern matches
                  setPatternMatches([]);
                  // Per-dataset pattern matches — iterate all known datasets
                  for (const dsid of Object.keys(state.patternMatchesByDataset)) {
                    state.setPatternMatchesForDataset(dsid, []);
                  }
                  // Chart focus (global + per-dataset)
                  state.setChartFocus(null);
                  for (const dsid of Object.keys(state.chartFocusByDataset)) {
                    state.setChartFocusForDataset(dsid, null);
                  }
                  // Strategy backtest plotted-trades overlay
                  state.setPlottedTrades([]);
                  state.setHighlightedTradeId(null);
                  // Pine-script generated drawings (but NOT user drawings)
                  state.setPineDrawings(null);
                  // Pattern-selector state
                  state.setCapturedPattern(null);
                }}
                title="Clear visual output on the chart (pattern highlights, trade markers, zoom). Keeps your script, drawings, and backtest results intact."
                className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors"
                style={{ color: "var(--accent)", background: "transparent", border: "1px solid var(--border)" }}
              >
                Clear Chart
              </button>
              {(patternMatches.length > 0 || currentScript) && (
                <button
                  onClick={() => {
                    setPatternMatches([]);
                    setPendingFingerprint(null);
                    setCurrentScript("");
                    setBacktestResults(null);
                    setView("chat");
                  }}
                  title="Reset — clear script + backtest results + pattern matches and switch to chat view"
                  className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors"
                  style={{ color: "var(--danger)", background: "transparent", border: "1px solid var(--border)" }}
                >
                  Reset
                </button>
              )}
            </>
          )}
        </div>

        {/* Content — chat messages or code editor */}
        <div className="relative flex-1 overflow-y-auto">
          {view === "chat" ? (
            <div className="p-3 space-y-3">
              {/* Strategy form card (floating in chat) */}
              {activeMode === "strategy" && !currentScript && (
                <div className="mb-3">
                  <StrategyForm
                    onSubmit={handleStrategySubmit}
                    loading={loading}
                    initialConfig={strategyConfig || undefined}
                  />
                </div>
              )}

              {messages.length === 0 && (
                <div className="flex items-center justify-center h-full min-h-[200px]">
                  <div className="text-center space-y-2 px-6">
                    <div className="text-2xl" style={{ color: "var(--accent)" }}>⚡</div>
                    <p className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
                      Vibe Trade
                    </p>
                    <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {activeSkillIds.size === 0
                        ? "No skill selected — free-form chat mode. Add a skill to unlock pattern detection, backtesting, and more."
                        : activeSkillIds.size > 1
                          ? `${activeSkillIds.size} skills active — send a message to dispatch.`
                          : activeMode === "strategy"
                            ? "Fill the form above and click Generate & Run."
                            : "Describe a pattern hypothesis in natural language."}
                    </p>
                    <p className="text-[9px] mt-3" style={{ color: "var(--text-muted)" }}>
                      Tap <span className="font-bold" style={{ color: "var(--accent)" }}>+</span> below to upload a dataset or browse resources.
                    </p>
                  </div>
                </div>
              )}
              {messages.map((msg) => {
                // Trace messages render as a distinct collapsible agent-process box
                if (msg.role === "trace") {
                  return <TraceMessage key={msg.id} msg={msg} />;
                }
                return (
                <div
                  key={msg.id}
                  className={`text-[12px] leading-relaxed rounded-xl px-3 py-2.5 ${
                    msg.role === "user" ? "ml-6" : "mr-4"
                  }`}
                  style={{
                    background: msg.role === "user" ? "var(--chat-user-bg)" : "var(--chat-agent-bg)",
                    color: "var(--text-primary)",
                    border: msg.role === "agent" ? "1px solid var(--chat-agent-border)" : "none",
                  }}
                >
                  <span
                    className="font-semibold text-[9px] uppercase block mb-1"
                    style={{ color: msg.role === "user" ? "var(--accent)" : "var(--text-tertiary)" }}
                  >
                    {msg.role === "user" ? "You" : "Agent"}
                  </span>
                  {msg.image && (
                    <img
                      src={msg.image}
                      alt="Pattern snapshot"
                      className="max-w-full h-auto rounded mb-1.5 block"
                      style={{
                        border: "1px solid var(--border)",
                        maxHeight: 160,
                        // Browser-native smooth scaling — avoids nearest-neighbour
                        // blockiness when the image IS scaled. No upscaling past
                        // intrinsic size thanks to max-w-full + h-auto.
                        imageRendering: "auto",
                      }}
                    />
                  )}
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                </div>
                );
              })}
              {loading && (
                <div className="text-[12px] animate-pulse" style={{ color: "var(--text-tertiary)" }}>
                  Thinking...
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          ) : (
            <ScriptEditor value={currentScript} onChange={setCurrentScript} />
          )}
        </div>

        {/* Kimi-style chat input bar */}
        <ChatInputBar
          value={input}
          onChange={setInput}
          onSend={handleSend}
          disabled={loading}
          placeholder={placeholder[activeMode]}
          onOpenDatasets={() => setDatasetsOpen(true)}
        />
      </div>
      )}

      {/* Modals (available in all modes) */}
      <DatasetsModal open={datasetsOpen} onClose={() => setDatasetsOpen(false)} />
    </div>
  );
}
