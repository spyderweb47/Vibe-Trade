"use client";

import { useStore } from "@/store/useStore";

/**
 * Bottom-panel tab that shows entity/personality cards for the current debate.
 * Reads from `currentDebate.entities` in the store.
 */
export function PersonalitiesTab() {
  const debate = useStore((s) => s.currentDebate);
  const entities = debate?.entities ?? [];

  if (entities.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        Run a swarm debate to see personality profiles
      </div>
    );
  }

  // Compute per-entity sentiment from thread messages
  const thread = debate?.thread ?? [];
  const sentimentMap: Record<string, { sum: number; count: number }> = {};
  for (const msg of thread) {
    if (!sentimentMap[msg.entityId]) sentimentMap[msg.entityId] = { sum: 0, count: 0 };
    sentimentMap[msg.entityId].sum += msg.sentiment;
    sentimentMap[msg.entityId].count += 1;
  }

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {entities.map((e) => {
          const avg = sentimentMap[e.id] ? sentimentMap[e.id].sum / sentimentMap[e.id].count : 0;
          const sentimentColor = avg > 0.2 ? "#22c55e" : avg < -0.2 ? "#ef4444" : "var(--text-muted)";
          const sentimentLabel = avg > 0.2 ? "Bullish" : avg < -0.2 ? "Bearish" : "Neutral";

          return (
            <div
              key={e.id}
              className="rounded-lg p-3"
              style={{
                background: "var(--surface-2)",
                border: `1px solid var(--border)`,
              }}
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
            </div>
          );
        })}
      </div>
    </div>
  );
}
