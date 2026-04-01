"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/store/useStore";
import { ScriptEditor } from "./ScriptEditor";
import { FileUpload } from "./FileUpload";
import { sendChat } from "@/lib/api";
import { executePatternScript } from "@/lib/scriptExecutor";

const TAG_COLORS: Record<string, string> = {
  indicator: "bg-violet-100 text-violet-600",
  pattern: "bg-amber-100 text-amber-600",
  strategy: "bg-emerald-100 text-emerald-600",
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
    <div className="border-b border-slate-100">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600"
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
      });

      addMessage({ role: "agent", content: result.reply });

      if (result.script && result.script_type === "indicator") {
        // Add as a custom indicator to Resources
        const indName = (result.data as Record<string, unknown>)?.indicator_name as string || "Custom";
        const defaultParams = (result.data as Record<string, unknown>)?.default_params as Record<string, string> || {};
        const colors = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];
        const color = colors[indicators.length % colors.length];

        addCustomIndicator({
          name: indName,
          backendName: indName.toLowerCase().replace(/\s+/g, "_"),
          active: true,
          params: defaultParams,
          script: result.script,
          custom: true,
          color,
        });
        addMessage({ role: "agent", content: `Custom indicator "${indName}" added to Resources and enabled on chart.` });
      } else if (result.script) {
        const isEdit = currentScript.length > 0;
        setCurrentScript(result.script);
        // Only auto-switch to code on first script generation, not edits
        if (!isEdit) {
          setView("code");
        }
        // Show script update notification
        if (isEdit) {
          addMessage({ role: "agent", content: "Script updated. Switch to CODE tab to see changes, then click Run." });
        }
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
      setRunState("done");
      addMessage({
        role: "agent",
        content: `Found ${matches.length} pattern matches.`,
      });
      setTimeout(() => setRunState("idle"), 2000);
    } catch (err) {
      setRunState("error");
      addMessage({
        role: "agent",
        content: `Run error: ${err instanceof Error ? err.message : "Failed"}`,
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
    backtest: "Configure and run backtest...",
  };

  return (
    <div className="flex w-80 flex-col border-l border-slate-200 bg-white">
      {/* ─── Datasets ─── */}
      <Section title="Datasets">
        {datasets.length === 0 ? (
          <p className="text-xs text-slate-400">No datasets loaded</p>
        ) : (
          <ul className="space-y-1">
            {datasets.map((ds) => (
              <li key={ds.id}>
                <button
                  onClick={() => setActiveDataset(ds.id)}
                  className={`w-full rounded px-2 py-1.5 text-left text-xs transition-colors ${
                    activeDataset === ds.id
                      ? "bg-slate-100 text-slate-900"
                      : "text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  <div className="font-medium truncate">{ds.name}</div>
                  <div className="text-slate-400">
                    {ds.metadata.rows.toLocaleString()} bars
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="mt-2 w-full rounded border border-dashed border-slate-300 px-2 py-1.5 text-xs text-slate-400 hover:border-slate-400 hover:text-slate-600"
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
          {indicators.map((ind) => (
            <div key={ind.name}>
              <div className="flex items-center gap-1.5 py-0.5">
                <button
                  onClick={() => toggleIndicator(ind.name)}
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
                    ind.active
                      ? "border-slate-900 bg-slate-900"
                      : "border-slate-300 bg-white"
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
                  className="text-xs text-slate-600 flex-1 cursor-pointer hover:text-slate-900"
                  onClick={() =>
                    setEditingIndicator(
                      editingIndicator === ind.name ? null : ind.name
                    )
                  }
                >
                  {ind.name}
                </span>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${TAG_COLORS.indicator}`}>
                  indicator
                </span>
                <button
                  onClick={() => removeIndicator(ind.name)}
                  className="text-slate-300 hover:text-red-400 transition-colors"
                  title="Remove"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Inline param editor */}
              {editingIndicator === ind.name && (
                <div className="ml-6 mt-1 mb-2 space-y-1 rounded border border-slate-100 bg-slate-50/50 p-2">
                  {Object.entries(ind.params).map(([key, val]) => (
                    <div key={key} className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-400 w-20 truncate" title={key}>
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
                        className="flex-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 outline-none focus:border-slate-400"
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
                className="flex items-center gap-1.5 rounded px-2 py-1 hover:bg-slate-50"
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
                  className="text-slate-400 hover:text-emerald-500 disabled:opacity-30 transition-colors"
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
                  className="flex-1 truncate text-left text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  {script.name}
                </button>
                <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${TAG_COLORS[script.type] || TAG_COLORS.pattern}`}>
                  {script.type}
                </span>
                {/* Delete button */}
                <button
                  onClick={() => removeScript(script.id)}
                  className="text-slate-300 hover:text-red-400 transition-colors"
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
          <p className="mt-2 text-[10px] text-slate-400">
            Scripts and strategies created from chat will appear here.
          </p>
        )}
      </Section>

      {/* ─── Chat / Code ─── */}
      <div className="flex flex-1 flex-col min-h-0">
        {/* View toggle */}
        <div className="flex border-b border-slate-100">
          <button
            onClick={() => setView("chat")}
            className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              view === "chat"
                ? "text-slate-900"
                : "text-slate-400 hover:text-slate-600"
            }`}
          >
            Chat
          </button>
          <button
            onClick={() => setView("code")}
            className={`flex-1 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
              view === "code"
                ? "text-slate-900"
                : "text-slate-400 hover:text-slate-600"
            }`}
          >
            Code
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {view === "chat" ? (
            <div className="p-3 space-y-3">
              {messages.length === 0 && (
                <p className="text-xs text-slate-400 text-center mt-4">
                  Describe a pattern hypothesis or strategy in natural language.
                </p>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`text-xs rounded-lg px-3 py-2 ${
                    msg.role === "user"
                      ? "bg-slate-50 text-slate-700 ml-4"
                      : "bg-white text-slate-600 mr-4 border border-slate-200"
                  }`}
                >
                  <span className="font-semibold text-[10px] uppercase block mb-1 text-slate-400">
                    {msg.role === "user" ? "You" : "Agent"}
                  </span>
                  {msg.content}
                </div>
              ))}
              {loading && (
                <div className="text-xs text-slate-400 animate-pulse">
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
          <div className="flex gap-2 border-t border-slate-100 p-2">
            <button
              onClick={handleRun}
              disabled={loading || !activeDataset || runState === "running"}
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
                ? "Running..."
                : runState === "done"
                  ? "Done!"
                  : runState === "error"
                    ? "Failed"
                    : "Run"}
            </button>
            <button
              onClick={handleSave}
              className="rounded border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Save
            </button>
            {patternMatches.length > 0 && (
              <button
                onClick={() => setPatternMatches([])}
                className="rounded border border-slate-200 px-3 py-1.5 text-xs font-medium text-red-400 hover:bg-red-50 hover:text-red-500"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-slate-100 p-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder={placeholder[activeMode]}
              className="flex-1 rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 placeholder-slate-400 outline-none focus:border-slate-400 focus:ring-1 focus:ring-slate-200"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="rounded bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
