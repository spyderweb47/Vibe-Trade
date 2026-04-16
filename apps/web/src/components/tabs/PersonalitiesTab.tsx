"use client";

import { useStore } from "@/store/useStore";
import { AgentDetailPanel } from "./AgentDetailPanel";

/**
 * Bottom-panel tab that shows entity/personality cards for the current debate.
 * Click a card to expand it — shows full activity, tool usage, cross-exam,
 * and a live interview chat box.
 */
export function PersonalitiesTab() {
  const debate = useStore((s) => s.currentDebate);
  const expandedAgentId = useStore((s) => s.expandedAgentId);
  const setExpandedAgentId = useStore((s) => s.setExpandedAgentId);
  const entities = debate?.entities ?? [];

  if (entities.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        Run a swarm debate to see personality profiles
      </div>
    );
  }

  // If an agent is expanded, show the detail panel instead of the grid
  if (expandedAgentId) {
    return <AgentDetailPanel agentId={expandedAgentId} onBack={() => setExpandedAgentId(null)} />;
  }

  // Compute per-entity sentiment + message count from thread
  const thread = debate?.thread ?? [];
  const sentimentMap: Record<string, { sum: number; count: number; tools: Set<string> }> = {};
  for (const msg of thread) {
    if (!sentimentMap[msg.entityId]) sentimentMap[msg.entityId] = { sum: 0, count: 0, tools: new Set() };
    sentimentMap[msg.entityId].sum += msg.sentiment;
    sentimentMap[msg.entityId].count += 1;
    for (const t of (msg.toolsUsed || [])) {
      sentimentMap[msg.entityId].tools.add(t);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-2 text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {entities.length} personas · click any card to expand
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {entities.map((e) => {
          const stats = sentimentMap[e.id];
          const avg = stats ? stats.sum / stats.count : 0;
          const msgCount = stats?.count || 0;
          const toolCount = stats?.tools.size || 0;
          const sentimentColor = avg > 0.2 ? "#22c55e" : avg < -0.2 ? "#ef4444" : "var(--text-muted)";
          const sentimentLabel = avg > 0.2 ? "Bullish" : avg < -0.2 ? "Bearish" : "Neutral";

          return (
            <button
              key={e.id}
              onClick={() => setExpandedAgentId(e.id)}
              className="rounded-lg p-3 text-left transition-all hover:shadow-md"
              style={{
                background: "var(--surface-2)",
                border: `1px solid var(--border)`,
                cursor: "pointer",
              }}
              onMouseEnter={(ev) => { (ev.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)"; }}
              onMouseLeave={(ev) => { (ev.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)"; }}
              title={`Click to expand ${e.name}`}
            >
              {/* Name + sentiment badge */}
              <div className="flex items-start justify-between gap-1">
                <h4 className="text-[11px] font-bold leading-tight" style={{ color: "var(--text-primary)" }}>
                  {e.name}
                </h4>
                <span
                  className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
                  style={{ background: `${sentimentColor}22`, color: sentimentColor }}
                >
                  {sentimentLabel}
                </span>
              </div>

              {/* Role */}
              <div className="mt-1 text-[10px] font-medium" style={{ color: "var(--accent)" }}>
                {e.role}
              </div>

              {/* Bias */}
              <div className="mt-1.5 text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                <span style={{ color: "var(--text-muted)" }}>Bias:</span> {e.bias}
              </div>

              {/* Personality snippet */}
              <div className="mt-1 text-[9px] leading-snug line-clamp-3" style={{ color: "var(--text-muted)" }}>
                {e.personality}
              </div>

              {/* Stats footer */}
              <div className="mt-2 flex items-center gap-2 text-[8px]" style={{ color: "var(--text-muted)" }}>
                <span>{msgCount} msg{msgCount === 1 ? "" : "s"}</span>
                {toolCount > 0 && (
                  <>
                    <span>·</span>
                    <span style={{ color: "var(--accent)" }}>{toolCount} tool{toolCount === 1 ? "" : "s"} used</span>
                  </>
                )}
                <span className="ml-auto opacity-60">→</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
