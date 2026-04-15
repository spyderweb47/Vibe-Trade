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
import { ResourcesModal } from "./ResourcesModal";
import type { StrategyConfig } from "@/types";

export function RightSidebar() {
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "code">("chat");
  const [currentScript, setCurrentScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [runState, setRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [datasetsOpen, setDatasetsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [pendingFingerprint, setPendingFingerprint] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMode = useStore((s) => s.activeMode);
  const appMode = useStore((s) => s.appMode);
  const messages = useStore((s) => s.messages);
  const addMessage = useStore((s) => s.addMessage);
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
    setInput("");
    addMessage({ role: "user", content: text });
    setLoading(true);

    try {
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
      const result = await sendChat(text, activeMode, {
        dataset_id: activeDataset,
        pattern_script: isNewFingerprint ? "" : currentScript,
        strategy_config: strategyConfig || undefined,
        pending_fingerprint: isNewFingerprint ? undefined : (pendingFingerprint || undefined),
      });

      // Clear pending fingerprint when new pattern data arrives
      if (isNewFingerprint) {
        setPendingFingerprint(null);
      }

      addMessage({ role: "agent", content: result.reply });

      // Store pending fingerprint if returned (pattern analysis step)
      const newPending = (result.data as Record<string, unknown>)?.pending_fingerprint as string | undefined;
      setPendingFingerprint(newPending || null);

      // Handle strategy mode responses
      if (activeMode === "strategy" && result.script) {
        setCurrentScript(result.script);
        setView("code");
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
        addMessage({ role: "agent", content: `Custom indicator "${indName}" added to Resources and enabled on chart.` });
      } else if (result.script) {
        const isEdit = currentScript.length > 0;
        setCurrentScript(result.script);
        if (!isEdit) setView("code");
        if (isEdit) addMessage({ role: "agent", content: "Script updated. Switch to CODE tab to see changes, then click Run." });
      }
    } catch (err) {
      addMessage({
        role: "agent",
        content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}`,
      });
    } finally {
      setLoading(false);
    }
  };

  const datasetRawData = useStore((s) => s.datasetRawData);
  const chartData = useStore((s) => s.chartData);

  const setLastScriptResult = useStore((s) => s.setLastScriptResult);

  const handleRun = async () => {
    // Use currentScript state, or fall back to textarea DOM value
    const script = currentScript || (document.querySelector('textarea') as HTMLTextAreaElement)?.value || "";
    if (!script || !activeDataset) return;
    if (!currentScript) setCurrentScript(script);

    // Use chart data (resampled) for pattern detection — much faster than raw 137k bars
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
      addMessage({
        role: "agent",
        content: `Run error: ${errMsg}`,
      });
      setTimeout(() => setRunState("idle"), 3000);
    }
  };

  const handleStrategySubmit = async (config: StrategyConfig) => {
    setStrategyConfig(config);
    setLoading(true);
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
      setLoading(false);
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
              {(patternMatches.length > 0 || activeMode === "strategy") && (
                <button
                  onClick={() => {
                    setPatternMatches([]);
                    setPendingFingerprint(null);
                    setCurrentScript("");
                    setBacktestResults(null);
                    setView("chat");
                  }}
                  className="rounded px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider transition-colors"
                  style={{ color: "var(--danger)", background: "transparent", border: "1px solid var(--border)" }}
                >
                  Clear
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
                      {activeMode === "pattern" ? "Pattern Agent" : "Strategy Agent"}
                    </p>
                    <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                      {activeMode === "strategy"
                        ? "Fill the form above and click Generate & Run."
                        : "Describe a pattern hypothesis in natural language."}
                    </p>
                    <p className="text-[9px] mt-3" style={{ color: "var(--text-muted)" }}>
                      Tap <span className="font-bold" style={{ color: "var(--accent)" }}>+</span> below to upload a dataset or browse resources.
                    </p>
                  </div>
                </div>
              )}
              {messages.map((msg) => (
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
                      className="w-full rounded mb-1.5"
                      style={{ border: "1px solid var(--border)", maxHeight: 120 }}
                    />
                  )}
                  <span className="whitespace-pre-wrap">{msg.content}</span>
                </div>
              ))}
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
          onOpenResources={() => setResourcesOpen(true)}
        />
      </div>
      )}

      {/* Modals (available in all modes) */}
      <DatasetsModal open={datasetsOpen} onClose={() => setDatasetsOpen(false)} />
      <ResourcesModal open={resourcesOpen} onClose={() => setResourcesOpen(false)} />
    </div>
  );
}
