"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/store/useStore";
import { ScriptEditor } from "./ScriptEditor";
import { FileUpload } from "./FileUpload";
import { sendChat } from "@/lib/api";
import { executePatternScript } from "@/lib/scriptExecutor";
import { executeStrategy } from "@/lib/strategyExecutor";
import { runPineScript } from "@/lib/pine/runPineScript";
import { StrategySummary } from "./StrategySummary";

const TAG_STYLES: Record<string, { bg: string; color: string }> = {
  indicator: { bg: "rgba(41,98,255,0.15)", color: "#2962ff" },
  pattern: { bg: "rgba(255,152,0,0.15)", color: "#ff9800" },
  strategy: { bg: "rgba(38,166,154,0.15)", color: "#26a69a" },
};

function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ borderBottom: "1px solid var(--border-subtle)" }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider hover:opacity-80"
        style={{ color: "var(--text-tertiary)" }}
      >
        {title}
        <svg
          className={`h-3 w-3 transition-transform ${open ? "rotate-0" : "-rotate-90"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export function RightSidebar() {
  const [input, setInput] = useState("");
  const [view, setView] = useState<"chat" | "code">("chat");
  const [currentScript, setCurrentScript] = useState("");
  const [loading, setLoading] = useState(false);
  const [runState, setRunState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [showUpload, setShowUpload] = useState(false);
  const [showPineImport, setShowPineImport] = useState(false);
  const [pineInput, setPineInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeMode = useStore((s) => s.activeMode);
  const messages = useStore((s) => s.messages);
  const addMessage = useStore((s) => s.addMessage);
  const activeDataset = useStore((s) => s.activeDataset);
  const setActiveDataset = useStore((s) => s.setActiveDataset);
  const datasets = useStore((s) => s.datasets);
  const scripts = useStore((s) => s.scripts);
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const updateIndicatorParams = useStore((s) => s.updateIndicatorParams);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const strategyDraft = useStore((s) => s.strategyDraft);
  const updateStrategyDraft = useStore((s) => s.updateStrategyDraft);
  const setBacktestResults = useStore((s) => s.setBacktestResults);
  const addScript = useStore((s) => s.addScript);
  const removeScript = useStore((s) => s.removeScript);
  const addCustomIndicator = useStore((s) => s.addCustomIndicator);
  const setPatternMatches = useStore((s) => s.setPatternMatches);
  const patternMatches = useStore((s) => s.patternMatches);
  const chatInputDraft = useStore((s) => s.chatInputDraft);
  const setChatInputDraft = useStore((s) => s.setChatInputDraft);
  const [editingIndicator, setEditingIndicator] = useState<string | null>(null);

  // Pick up prefilled chat input from the store (e.g. from "Send to Agent" on chart)
  useEffect(() => {
    if (chatInputDraft) {
      setInput(chatInputDraft);
      setChatInputDraft("");
      setView("chat");
    }
  }, [chatInputDraft, setChatInputDraft]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || loading) return;
    const text = input.trim();
    setInput("");
    addMessage({ role: "user", content: text });
    setLoading(true);

    try {
      const result = await sendChat(text, activeMode, {
        dataset_id: activeDataset,
        pattern_script: currentScript,
        strategy_draft: strategyDraft || undefined,
      });

      addMessage({ role: "agent", content: result.reply });

      // Handle strategy mode responses
      if (activeMode === "strategy" && result.data) {
        const d = result.data as Record<string, unknown>;
        updateStrategyDraft({
          state: (d.strategy_state as string) || strategyDraft?.state || "needs_entry",
          entryRules: (d.entry_rules as string[]) || strategyDraft?.entryRules || [],
          exitRules: (d.exit_rules as string[]) || strategyDraft?.exitRules || [],
          stopLoss: (d.stop_loss as number) ?? strategyDraft?.stopLoss ?? null,
          takeProfit: (d.take_profit as number) ?? strategyDraft?.takeProfit ?? null,
          script: result.script || strategyDraft?.script || null,
        });
        if (result.script) {
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
      addMessage({
        role: "agent",
        content: `Run error: ${err instanceof Error ? err.message : "Failed"}`,
      });
      setTimeout(() => setRunState("idle"), 3000);
    }
  };

  const handleBacktest = async () => {
    const script = currentScript || strategyDraft?.script || (document.querySelector('textarea') as HTMLTextAreaElement)?.value || "";
    if (!script || !activeDataset) return;
    if (!script.includes("return") || !script.includes("trades")) {
      addMessage({ role: "agent", content: "Strategy script looks incomplete. Finish building the strategy first — define entry, exit, and risk management." });
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
      const config = {
        stopLoss: strategyDraft?.stopLoss ?? 2,
        takeProfit: strategyDraft?.takeProfit ?? 5,
      };
      const result = await executeStrategy(script, runData, config);
      setBacktestResults(result);
      setRunState("done");
      addMessage({
        role: "agent",
        content: `Backtest complete: ${result.totalTrades} trades, ${(result.winRate * 100).toFixed(1)}% win rate, ${(result.totalReturn * 100).toFixed(1)}% return, Sharpe ${result.sharpeRatio}.`,
      });
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

  const handlePineImport = async () => {
    if (!pineInput.trim() || loading) return;
    setLoading(true);

    // Extract indicator name from Pine Script
    const nameMatch = pineInput.match(/(?:indicator|strategy|study)\s*\(\s*["']([^"']+)["']/);
    const indName = nameMatch ? nameMatch[1] : "Pine Import";

    addMessage({ role: "user", content: `[Pine Script Import] ${indName}` });

    // Check Pine Script version — PineTS only supports v5+
    const versionMatch = pineInput.match(/@version=(\d+)/);
    const pineVersion = versionMatch ? parseInt(versionMatch[1]) : 5;

    if (pineVersion < 5) {
      // Fall back to LLM conversion for older Pine Script versions
      addMessage({ role: "agent", content: `Pine Script v${pineVersion} detected — converting to JavaScript via AI (PineTS requires v5+)...` });
      try {
        const result = await sendChat(pineInput, activeMode, {});
        addMessage({ role: "agent", content: result.reply });
        if (result.script) {
          const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
          addCustomIndicator({
            name: indName,
            backendName: indName.toLowerCase().replace(/\s+/g, "_"),
            active: true,
            params: (result.data as Record<string, unknown>)?.default_params as Record<string, string> || {},
            script: result.script,
            custom: true,
            color: colors[indicators.length % colors.length],
          });
          addMessage({ role: "agent", content: `"${indName}" converted and added to chart.` });
        }
        setShowPineImport(false);
        setPineInput("");
      } catch (err) {
        addMessage({ role: "agent", content: `Conversion failed: ${err instanceof Error ? err.message : "Unknown error"}` });
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      // Run Pine Script v5+ directly using PineTS — no LLM needed
      const runData = chartData.length > 0 ? chartData : [];
      if (runData.length === 0) {
        addMessage({ role: "agent", content: "Upload a dataset first before importing Pine Script." });
        return;
      }

      // Detect timeframe from active dataset
      const ds = datasets.find((d) => d.id === activeDataset);
      const tf = ds?.metadata.chartTimeframe || "D";

      const result = await runPineScript(pineInput, runData, ds?.name || "LOCAL", tf);

      const hasDrawings = result.drawings && (result.drawings.boxes.length > 0 || result.drawings.lines.length > 0 || result.drawings.labels.length > 0 || (result.drawings.fills?.length || 0) > 0);

      // Store drawings + plots on chart
      if (hasDrawings || result.plotNames.length > 0) {
        useStore.getState().setPineDrawings(result.drawings, result.plots);
      }

      if (result.error && !hasDrawings && result.plotNames.length === 0) {
        // PineTS failed with no output at all — fall back to LLM
        const errMsg = result.error || "No output produced";
        addMessage({ role: "agent", content: `PineTS runtime error: ${errMsg}. Falling back to AI conversion...` });

        try {
          const llmResult = await sendChat(
            `Convert this Pine Script to a JavaScript indicator. The PineTS runtime gave this error: "${errMsg}". Fix the issue and return working JavaScript.\n\n${pineInput}`,
            activeMode,
            {}
          );
          addMessage({ role: "agent", content: llmResult.reply });
          if (llmResult.script) {
            const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
            addCustomIndicator({
              name: indName,
              backendName: indName.toLowerCase().replace(/\s+/g, "_"),
              active: true,
              params: (llmResult.data as Record<string, unknown>)?.default_params as Record<string, string> || {},
              script: llmResult.script,
              custom: true,
              color: colors[indicators.length % colors.length],
            });
            addMessage({ role: "agent", content: `"${indName}" converted via AI and added to chart.` });
          }
        } catch (llmErr) {
          addMessage({ role: "agent", content: `AI conversion also failed: ${llmErr instanceof Error ? llmErr.message : "Unknown error"}` });
        }
        setShowPineImport(false);
        setPineInput("");
        return;
      }

      // Add each plot as a custom indicator
      const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];

      for (let i = 0; i < result.plotNames.length; i++) {
        const plotName = result.plotNames[i];
        const values = result.plots[plotName];
        const displayName = result.plotNames.length === 1 ? indName : `${indName} — ${plotName}`;
        const color = colors[(indicators.length + i) % colors.length];

        // Store the Pine Script as the indicator script, with a special prefix
        // so the chart knows to use PineTS runtime instead of JS eval
        addCustomIndicator({
          name: displayName,
          backendName: displayName.toLowerCase().replace(/\s+/g, "_"),
          active: true,
          params: {},
          script: `__PINE__${pineInput}`,
          custom: true,
          color,
          // Store pre-computed values so we don't re-run PineTS on every toggle
          _precomputed: values,
        } as any);
      }

      addMessage({
        role: "agent",
        content: `Pine Script "${indName}" executed: ${result.plotNames.length} plot(s)${hasDrawings ? `, ${result.drawings.boxes.length} boxes, ${result.drawings.lines.length} lines, ${result.drawings.labels.length} labels` : ""} added to chart.`,
      });

      setShowPineImport(false);
      setPineInput("");
    } catch (err) {
      // PineTS threw — fall back to LLM
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      addMessage({ role: "agent", content: `PineTS error: ${errMsg}. Falling back to AI conversion...` });

      try {
        const llmResult = await sendChat(
          `Convert this Pine Script to JavaScript. PineTS gave error: "${errMsg}". Fix and return working JS.\n\n${pineInput}`,
          activeMode,
          {}
        );
        addMessage({ role: "agent", content: llmResult.reply });
        if (llmResult.script) {
          const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
          addCustomIndicator({
            name: indName,
            backendName: indName.toLowerCase().replace(/\s+/g, "_"),
            active: true,
            params: (llmResult.data as Record<string, unknown>)?.default_params as Record<string, string> || {},
            script: llmResult.script,
            custom: true,
            color: colors[indicators.length % colors.length],
          });
          addMessage({ role: "agent", content: `"${indName}" converted via AI fallback and added to chart.` });
        }
        setShowPineImport(false);
        setPineInput("");
      } catch {
        addMessage({ role: "agent", content: `Both PineTS and AI conversion failed. Try a simpler Pine Script.` });
      }
    } finally {
      setLoading(false);
    }
  };

  const placeholder: Record<string, string> = {
    pattern: "Describe a pattern to detect...",
    strategy: "Describe a trading strategy...",
  };

  return (
    <div className="flex w-full h-full flex-col" style={{ background: "var(--surface)" }}>
      {/* ─── Datasets ─── */}
      <Section title="Datasets">
        {datasets.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)]">No datasets loaded</p>
        ) : (
          <ul className="space-y-1">
            {datasets.map((ds) => (
              <li key={ds.id}>
                <button
                  onClick={() => setActiveDataset(ds.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    activeDataset === ds.id
                      ? "bg-[var(--surface-2)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                  }`}
                >
                  <div className="font-medium truncate">{ds.name}</div>
                  <div className="text-[var(--text-tertiary)]">
                    {ds.metadata.rows.toLocaleString()} bars
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="mt-2 w-full rounded border border-dashed border-[var(--border)] px-2 py-1.5 text-xs text-[var(--text-tertiary)] hover:border-slate-400 hover:text-[var(--text-secondary)]"
        >
          + Upload CSV
        </button>
        {showUpload && (
          <div className="mt-2">
            <FileUpload />
          </div>
        )}
      </Section>

      {/* ─── Resources ─── */}
      <Section title="Resources">
        {/* Indicators */}
        <div className="space-y-1">
          {indicators.map((ind, idx) => (
            <div key={`ind-${idx}-${ind.backendName}`}>
              <div className="flex items-center gap-1.5 py-0.5">
                <button
                  onClick={() => toggleIndicator(ind.name)}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    ind.active
                      ? "border-slate-900 bg-slate-900"
                      : "border-[var(--border)] bg-[var(--surface)]"
                  }`}
                >
                  {ind.active && (
                    <svg
                      className="h-3 w-3 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={3}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
                <span
                  className="text-xs text-[var(--text-secondary)] flex-1 cursor-pointer hover:text-[var(--text-primary)]"
                  onClick={() =>
                    setEditingIndicator(
                      editingIndicator === ind.name ? null : ind.name
                    )
                  }
                >
                  {ind.name}
                </span>
                <span className="rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ background: TAG_STYLES.indicator.bg, color: TAG_STYLES.indicator.color }}>
                  indicator
                </span>
                <button
                  onClick={() => removeIndicator(ind.name)}
                  className="text-[var(--text-muted)] hover:text-red-400 transition-colors"
                  title="Remove"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Inline param editor */}
              {editingIndicator === ind.name && (
                <div className="ml-6 mt-1 mb-2 space-y-1 rounded border border-[var(--border-subtle)] bg-[var(--surface-2)]/50 p-2">
                  {Object.entries(ind.params).map(([key, val]) => (
                    <div key={key} className="flex items-center gap-2">
                      <label className="text-[10px] text-[var(--text-tertiary)] w-20 truncate" title={key}>
                        {key.replace(/_/g, " ")}
                      </label>
                      <input
                        type="text"
                        defaultValue={String(val)}
                        onBlur={(e) => {
                          const newParams = { ...ind.params, [key]: e.target.value };
                          updateIndicatorParams(ind.name, newParams);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const newParams = { ...ind.params, [key]: (e.target as HTMLInputElement).value };
                            updateIndicatorParams(ind.name, newParams);
                            setEditingIndicator(null);
                          }
                        }}
                        className="flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-slate-400"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Scripts */}
        {scripts.length > 0 && (
          <div className="mt-3 space-y-1">
            {scripts.map((script) => (
              <div
                key={script.id}
                className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-[var(--surface-2)]"
              >
                {/* Run button */}
                <button
                  onClick={async () => {
                    setCurrentScript(script.code);
                    setView("code");
                    if (activeDataset) {
                      const runData = datasetRawData[activeDataset] || chartData;
                      if (runData && runData.length > 0) {
                        try {
                          const matches = await executePatternScript(script.code, runData);
                          setPatternMatches(matches);
                          addMessage({ role: "agent", content: `Re-ran "${script.name}": ${matches.length} matches.` });
                        } catch {
                          addMessage({ role: "agent", content: `Failed to run "${script.name}".` });
                        }
                      }
                    }
                  }}
                  disabled={!activeDataset}
                  className="text-[var(--text-tertiary)] hover:text-emerald-500 disabled:opacity-30 transition-colors"
                  title="Run"
                >
                  <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                </button>
                {/* Name — click to open in editor */}
                <button
                  onClick={() => {
                    setCurrentScript(script.code);
                    setView("code");
                  }}
                  className="flex-1 truncate text-left text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  {script.name}
                </button>
                <span className="rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ background: (TAG_STYLES[script.type] || TAG_STYLES.pattern).bg, color: (TAG_STYLES[script.type] || TAG_STYLES.pattern).color }}>
                  {script.type}
                </span>
                {/* Delete button */}
                <button
                  onClick={() => removeScript(script.id)}
                  className="text-[var(--text-muted)] hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {scripts.length === 0 && indicators.length === 0 && (
          <p className="mt-2 text-[10px] text-[var(--text-tertiary)]">
            Scripts and strategies created from chat will appear here.
          </p>
        )}

        {/* Import Pine Script */}
        {!showPineImport ? (
          <button
            onClick={() => setShowPineImport(true)}
            className="mt-2 w-full rounded border border-dashed border-[var(--border)] px-2 py-1.5 text-[10px] text-[var(--text-tertiary)] hover:border-slate-400 hover:text-[var(--text-secondary)]"
          >
            + Import Pine Script
          </button>
        ) : (
          <div className="mt-2 rounded border border-[var(--border)] bg-[var(--surface-2)]/50 p-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-semibold text-[var(--text-secondary)] uppercase">Paste Pine Script</span>
              <button
                onClick={() => { setShowPineImport(false); setPineInput(""); }}
                className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-xs"
              >
                &times;
              </button>
            </div>
            <textarea
              value={pineInput}
              onChange={(e) => setPineInput(e.target.value)}
              placeholder="//@version=5&#10;indicator(...)&#10;..."
              className="w-full h-24 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-[10px] text-[var(--text-secondary)] outline-none focus:border-slate-400 resize-none"
            />
            <button
              onClick={handlePineImport}
              disabled={!pineInput.trim() || loading}
              className="mt-1 w-full rounded bg-slate-900 px-2 py-1.5 text-[10px] font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              {loading ? "Converting..." : "Convert & Add Indicator"}
            </button>
          </div>
        )}
      </Section>

      {/* ─── Strategy Summary (when in strategy mode) ─── */}
      {activeMode === "strategy" && <StrategySummary />}

      {/* ─── Mode + Chat / Code ─── */}
      <div className="flex flex-1 flex-col min-h-0">
        {/* View toggle: Chat / Code */}
        <div className="flex" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <button
            onClick={() => setView("chat")}
            className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              view === "chat"
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            Chat
          </button>
          <button
            onClick={() => setView("code")}
            className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              view === "code"
                ? "text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`}
          >
            Code
          </button>
        </div>

        {/* Content */}
        <div className="relative flex-1 overflow-y-auto">
          {/* Floating segmented control */}
          <div className="sticky top-0 z-10 flex justify-center py-1.5" style={{ background: "var(--surface)" }}>
            <div className="relative flex rounded-md p-[2px]" style={{ background: "var(--surface-2)", fontSize: 0 }}>
              <div
                className="absolute top-[2px] bottom-[2px] rounded transition-all duration-200 ease-out"
                style={{
                  width: "calc(50% - 2px)",
                  left: activeMode === "pattern" ? "2px" : "50%",
                  background: "var(--surface)",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
                }}
              />
              {(["pattern", "strategy"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => useStore.getState().setMode(mode)}
                  className="relative z-10 rounded px-3 py-0.5 text-[10px] font-semibold transition-colors"
                  style={{ color: activeMode === mode ? "var(--text-primary)" : "var(--text-muted)" }}
                >
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {view === "chat" ? (
            <div className="p-3 space-y-3">
              {messages.length === 0 && (
                <p className="text-[12px] text-center mt-6" style={{ color: "var(--text-tertiary)" }}>
                  {activeMode === "strategy"
                    ? "Let's build a strategy! Describe your entry signal to get started."
                    : "Describe a pattern hypothesis or strategy in natural language."}
                </p>
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

        {/* Action buttons for code view */}
        {view === "code" && currentScript && (
          <div className="flex gap-2 border-t border-[var(--border-subtle)] p-2">
            <button
              onClick={activeMode === "strategy" ? handleBacktest : handleRun}
              disabled={loading || !activeDataset || runState === "running" || (activeMode === "strategy" && strategyDraft?.state !== "complete")}
              className={`flex-1 rounded px-3 py-1.5 text-xs font-medium transition-all ${
                runState === "running"
                  ? "bg-amber-500 text-white animate-pulse"
                  : runState === "done"
                    ? "bg-emerald-500 text-white"
                    : runState === "error"
                      ? "bg-red-500 text-white"
                      : "bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
              }`}
            >
              {runState === "running"
                ? (activeMode === "strategy" ? "Backtesting..." : "Running...")
                : runState === "done"
                  ? "Done!"
                  : runState === "error"
                    ? "Failed"
                    : (activeMode === "strategy" ? "Run Backtest" : "Run")}
            </button>
            <button
              onClick={handleSave}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              Save
            </button>
            {patternMatches.length > 0 && (
              <button
                onClick={() => setPatternMatches([])}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-50 hover:text-red-500"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Input */}
        <div className="p-2" style={{ borderTop: "1px solid var(--border-subtle)" }}>
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder={placeholder[activeMode]}
              className="flex-1 rounded-lg px-3 py-2 text-[12px] outline-none transition-colors"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
              }}
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="rounded-lg px-3 py-2 text-[12px] font-medium text-white disabled:opacity-40 transition-colors"
              style={{ background: "var(--accent)" }}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
