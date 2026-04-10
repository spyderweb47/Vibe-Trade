"use client";

import { useState, useCallback } from "react";
import { useStore } from "@/store/useStore";
import { runPineScript } from "@/lib/pine/runPineScript";
import { sendChat } from "@/lib/api";

const PINE_TEMPLATES: { name: string; code: string }[] = [
  {
    name: "SMA Crossover",
    code: `//@version=5
indicator("SMA Crossover", overlay=true)
fast = ta.sma(close, 9)
slow = ta.sma(close, 21)
plot(fast, "Fast SMA", color=color.blue)
plot(slow, "Slow SMA", color=color.red)`,
  },
  {
    name: "RSI",
    code: `//@version=5
indicator("RSI", overlay=false)
rsiLen = input.int(14, "Length")
rsi = ta.rsi(close, rsiLen)
plot(rsi, "RSI", color=color.purple)
hline(70, "Overbought")
hline(30, "Oversold")`,
  },
  {
    name: "Bollinger Bands",
    code: `//@version=5
indicator("Bollinger Bands", overlay=true)
length = input.int(20, "Length")
mult = input.float(2.0, "Multiplier")
basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
upper = basis + dev
lower = basis - dev
plot(basis, "Basis", color=color.blue)
plot(upper, "Upper", color=color.red)
plot(lower, "Lower", color=color.green)`,
  },
  {
    name: "EMA Ribbon",
    code: `//@version=5
indicator("EMA Ribbon", overlay=true)
plot(ta.ema(close, 8), "EMA 8", color=color.blue)
plot(ta.ema(close, 13), "EMA 13", color=color.green)
plot(ta.ema(close, 21), "EMA 21", color=color.orange)
plot(ta.ema(close, 55), "EMA 55", color=color.red)`,
  },
];

const INDICATOR_COLORS = ["#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316", "#22c55e"];

export function PineScriptPanel() {
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [resultInfo, setResultInfo] = useState("");

  const chartData = useStore((s) => s.chartData);
  const datasets = useStore((s) => s.datasets);
  const activeDataset = useStore((s) => s.activeDataset);
  const indicators = useStore((s) => s.indicators);
  const addCustomIndicator = useStore((s) => s.addCustomIndicator);
  const addMessage = useStore((s) => s.addMessage);

  const handleRun = useCallback(async () => {
    if (!code.trim()) return;
    if (chartData.length === 0) {
      setStatus("error");
      setErrorMsg("Upload a dataset first");
      return;
    }

    setStatus("running");
    setErrorMsg("");
    setResultInfo("");

    try {
      const ds = datasets.find((d) => d.id === activeDataset);
      const tf = ds?.metadata.chartTimeframe || "D";

      const result = await runPineScript(code, chartData, ds?.name || "LOCAL", tf);

      const hasDrawings = result.drawings && (
        result.drawings.boxes.length > 0 ||
        result.drawings.lines.length > 0 ||
        result.drawings.labels.length > 0 ||
        (result.drawings.fills?.length || 0) > 0
      );

      // Always store drawings + plots when any exist (including fills)
      if (hasDrawings || result.plotNames.length > 0) {
        useStore.getState().setPineDrawings(result.drawings, result.plots);
      }

      // If PineTS failed or produced no output, fall back to LLM conversion
      if (result.error || (result.plotNames.length === 0 && !hasDrawings)) {
        setStatus("running");
        setResultInfo("Converting via AI agent...");

        try {
          const llmResult = await sendChat(
            `Convert this Pine Script to a JavaScript indicator. Extract the main computation logic and return values array.\n\n${code}`,
            "pattern",
            {}
          );

          if (llmResult.script) {
            const nameMatch = code.match(/(?:indicator|strategy|study)\s*\(\s*["']([^"']+)["']/);
            const indName = nameMatch ? nameMatch[1] : "Pine Import";
            const color = INDICATOR_COLORS[(indicators.length) % INDICATOR_COLORS.length];

            addCustomIndicator({
              name: indName,
              backendName: indName.toLowerCase().replace(/\s+/g, "_"),
              active: true,
              params: (llmResult.data as Record<string, unknown>)?.default_params as Record<string, string> || {},
              script: llmResult.script,
              custom: true,
              color,
            });

            setStatus("success");
            setResultInfo(`Converted via AI: "${indName}" added to chart`);
            addMessage({ role: "agent", content: llmResult.reply || `"${indName}" converted and added.` });
            setTimeout(() => setStatus("idle"), 3000);
            return;
          }
        } catch {
          // LLM also failed
        }

        setStatus("error");
        setErrorMsg(`PineTS: ${errorMsg}. AI conversion also failed.`);
        return;
      }

      // Extract indicator name from script
      const nameMatch = code.match(/(?:indicator|strategy|study)\s*\(\s*["']([^"']+)["']/);
      const indName = nameMatch ? nameMatch[1] : "Pine Import";

      // Add each plot as a custom indicator
      for (let i = 0; i < result.plotNames.length; i++) {
        const plotName = result.plotNames[i];
        const values = result.plots[plotName];
        const displayName = result.plotNames.length === 1 ? indName : `${indName} — ${plotName}`;
        const color = INDICATOR_COLORS[(indicators.length + i) % INDICATOR_COLORS.length];

        // Extract unique colors from drawings (dynamic color lines)
        const drawingColors = new Set<string>();
        if (result.drawings?.lines) {
          for (const l of result.drawings.lines) drawingColors.add(l.color);
        }
        const plotColors = [...drawingColors].filter(c => c !== "#ffffff" && c !== "transparent");

        // Also extract color inputs from Pine Script source
        const colorInputMatches = code.matchAll(/input\.color\s*\(\s*([^,)]+)/g);
        const inputColors: string[] = [];
        for (const m of colorInputMatches) {
          const val = m[1].trim().replace(/^#/, "#");
          if (val.startsWith("#")) inputColors.push(val);
        }

        const allColors = [...new Set([...plotColors, ...inputColors])].slice(0, 5);

        addCustomIndicator({
          name: displayName,
          backendName: displayName.toLowerCase().replace(/\s+/g, "_"),
          active: true,
          params: allColors.length > 0 ? { _plotColors: allColors.join(",") } : {},
          script: `__PINE__${code}`,
          custom: true,
          color: allColors[0] || color,
          _precomputed: values,
        } as any);
      }

      setStatus("success");
      const drawingInfo = hasDrawings
        ? `, ${result.drawings.boxes.length} boxes, ${result.drawings.lines.length} lines, ${result.drawings.labels.length} labels`
        : "";
      setResultInfo(`${result.plotNames.length} plot(s)${drawingInfo}`);
      addMessage({
        role: "agent",
        content: `Pine Script "${indName}" executed — ${result.plotNames.length} plot(s)${drawingInfo} added to chart.`,
      });

      setTimeout(() => setStatus("idle"), 3000);
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
    }
  }, [code, chartData, datasets, activeDataset, indicators, addCustomIndicator, addMessage]);

  return (
    <div className="flex h-full">
      {/* Code editor */}
      <div className="flex flex-1 flex-col min-w-0">
        <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
            Pine Script Editor
          </span>
          <span className="rounded px-1.5 py-0.5 text-[9px] font-medium" style={{ background: "rgba(255,107,0,0.15)", color: "#ff6b00" }}>
            v5
          </span>
          <div className="flex-1" />

          {/* Template dropdown */}
          <select
            onChange={(e) => {
              const tpl = PINE_TEMPLATES.find((t) => t.name === e.target.value);
              if (tpl) setCode(tpl.code);
              e.target.value = "";
            }}
            className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)] outline-none"
            defaultValue=""
          >
            <option value="" disabled>
              Templates...
            </option>
            {PINE_TEMPLATES.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>

          {/* Run button */}
          <button
            onClick={handleRun}
            disabled={!code.trim() || status === "running" || chartData.length === 0}
            className={`rounded px-3 py-1 text-[10px] font-semibold text-white transition-all ${
              status === "running"
                ? "bg-amber-500 animate-pulse"
                : status === "success"
                  ? "bg-emerald-500"
                  : status === "error"
                    ? "bg-red-500 hover:bg-red-600"
                    : "bg-[var(--accent)] hover:opacity-90 disabled:opacity-40"
            }`}
          >
            {status === "running" ? "Running..." : status === "success" ? "Added!" : "Run & Add to Chart"}
          </button>
        </div>

        <textarea
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            if (status !== "idle") setStatus("idle");
          }}
          spellCheck={false}
          className="flex-1 resize-none p-3 font-mono text-[11px] leading-relaxed outline-none"
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            tabSize: 4,
          }}
          placeholder={`//@version=5\nindicator("My Indicator", overlay=true)\n\n// Write your Pine Script here...\nplot(ta.sma(close, 20), "SMA 20")`}
        />

        {/* Status bar */}
        {(errorMsg || resultInfo) && (
          <div
            className="px-3 py-1.5 text-[10px] font-medium"
            style={{
              borderTop: "1px solid var(--border-subtle)",
              color: errorMsg ? "#ef4444" : "#22c55e",
              background: errorMsg ? "rgba(239,68,68,0.05)" : "rgba(34,197,94,0.05)",
            }}
          >
            {errorMsg || resultInfo}
          </div>
        )}
      </div>

      {/* Quick reference sidebar */}
      <div
        className="w-48 shrink-0 overflow-y-auto p-2 text-[10px]"
        style={{ borderLeft: "1px solid var(--border-subtle)", background: "var(--surface)" }}
      >
        <div className="font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-tertiary)" }}>
          Quick Reference
        </div>
        <div className="space-y-2" style={{ color: "var(--text-secondary)" }}>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Moving Averages</div>
            <code className="block text-[9px] mt-0.5 opacity-80">ta.sma(close, 20)</code>
            <code className="block text-[9px] opacity-80">ta.ema(close, 20)</code>
          </div>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Oscillators</div>
            <code className="block text-[9px] mt-0.5 opacity-80">ta.rsi(close, 14)</code>
            <code className="block text-[9px] opacity-80">ta.macd(close, 12, 26, 9)</code>
            <code className="block text-[9px] opacity-80">ta.stoch(close, high, low, 14)</code>
          </div>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Volatility</div>
            <code className="block text-[9px] mt-0.5 opacity-80">ta.atr(14)</code>
            <code className="block text-[9px] opacity-80">ta.stdev(close, 20)</code>
            <code className="block text-[9px] opacity-80">ta.bbands(close, 20, 2)</code>
          </div>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Crossovers</div>
            <code className="block text-[9px] mt-0.5 opacity-80">ta.crossover(a, b)</code>
            <code className="block text-[9px] opacity-80">ta.crossunder(a, b)</code>
          </div>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Plotting</div>
            <code className="block text-[9px] mt-0.5 opacity-80">plot(series, title)</code>
            <code className="block text-[9px] opacity-80">hline(price)</code>
            <code className="block text-[9px] opacity-80">bgcolor(color)</code>
          </div>
          <div>
            <div className="font-semibold" style={{ color: "var(--text-primary)" }}>Colors</div>
            <code className="block text-[9px] mt-0.5 opacity-80">color.red, color.blue</code>
            <code className="block text-[9px] opacity-80">color.green, color.orange</code>
            <code className="block text-[9px] opacity-80">color.purple, color.white</code>
          </div>
        </div>
      </div>
    </div>
  );
}
