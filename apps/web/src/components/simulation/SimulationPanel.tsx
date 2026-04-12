"use client";

import { useRef } from "react";
import { useStore } from "@/store/useStore";
import { AgentCard } from "./AgentCard";
import { DecisionCard } from "./DecisionCard";
import type { AgentRole } from "@/types";

export function SimulationPanel() {
  const activeDataset = useStore((s) => s.activeDataset);
  const debate = useStore((s) => s.currentDebate);
  const loading = useStore((s) => s.simulationLoading);
  const runDebate = useStore((s) => s.runDebate);
  const resetSimulation = useStore((s) => s.resetSimulation);
  const report = useStore((s) => s.simulationReport);
  const setReport = useStore((s) => s.setSimulationReport);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setReport(text);
  };

  const agentRoles = debate
    ? (Object.keys(debate.agents) as AgentRole[])
    : [];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex-1 min-w-0">
          <div className="text-[9px] font-bold uppercase tracking-widest" style={{ color: "var(--accent)", opacity: 0.6 }}>
            Simulation
          </div>
          <div className="text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
            Multi-Agent Debate
          </div>
        </div>
        {debate && debate.status === "complete" && (
          <button
            onClick={resetSimulation}
            className="rounded px-2 py-1 text-[9px] font-semibold uppercase"
            style={{ background: "var(--surface-2)", color: "var(--text-tertiary)", border: "1px solid var(--border)" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Report Upload */}
      <div className="px-3 py-2 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="text-[9px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: "var(--text-muted)" }}>
          Research Report (optional)
        </div>
        {report ? (
          <div className="flex items-center gap-2">
            <div
              className="flex-1 rounded px-2 py-1.5 text-[10px] line-clamp-2"
              style={{ background: "var(--surface-2)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
            >
              {report.slice(0, 120)}...
            </div>
            <button
              onClick={() => setReport("")}
              className="text-[9px] font-semibold px-1.5 py-1 rounded"
              style={{ color: "var(--danger)" }}
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full rounded py-2 text-[10px] font-semibold border-dashed border-2 transition-colors hover:border-[var(--accent)]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)", background: "var(--surface-2)" }}
          >
            Upload Report (.txt, .md, .pdf)
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.csv,.pdf"
          onChange={handleFileUpload}
          className="hidden"
        />
        <p className="text-[8px] mt-1" style={{ color: "var(--text-muted)" }}>
          Agents will use this report to create specialized analysis personas.
        </p>
      </div>

      {/* Run Button */}
      <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={runDebate}
          disabled={!activeDataset || loading}
          className="w-full rounded py-2 text-[11px] font-bold uppercase tracking-wide transition-opacity disabled:opacity-40"
          style={{ background: "var(--accent)", color: "#000" }}
        >
          {loading ? "Analyzing..." : debate?.status === "complete" ? "Run Again" : "Run Committee Debate"}
        </button>
        {!activeDataset && (
          <p className="text-[9px] mt-1 text-center" style={{ color: "var(--text-muted)" }}>
            Load a dataset first
          </p>
        )}
      </div>

      {/* Agent Cards (scrollable) */}
      <div className="flex-1 overflow-y-auto py-1">
        {!debate && !loading && (
          <div className="flex items-center justify-center h-full text-[10px]" style={{ color: "var(--text-tertiary)" }}>
            <div className="text-center space-y-2 px-6">
              <div className="text-2xl">🏛</div>
              <p>Run a debate to see agent analysis.</p>
              <p className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                Upload a report to generate specialized agent personas, or run with just OHLC data for the default committee.
              </p>
            </div>
          </div>
        )}

        {debate && agentRoles.map((role) => (
          <AgentCard key={role} result={debate.agents[role]} />
        ))}
      </div>

      {/* Decision Card (sticky bottom) */}
      {debate?.decision && (
        <div className="shrink-0">
          <DecisionCard decision={debate.decision} />
        </div>
      )}

      {/* Error state */}
      {debate?.status === "error" && (
        <div className="mx-3 mb-3 rounded-md p-3 text-[10px]" style={{ background: "rgba(255,77,77,0.1)", color: "#ff4d4d", border: "1px solid rgba(255,77,77,0.3)" }}>
          {debate.error || "Unknown error"}
        </div>
      )}
    </div>
  );
}
