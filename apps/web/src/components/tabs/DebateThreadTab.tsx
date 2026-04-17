"use client";

import { useStore } from "@/store/useStore";

/**
 * Bottom-panel tab that renders the full debate conversation thread.
 * Each message shows entity name, role, round, sentiment, content,
 * and optional price prediction + agree/disagree references.
 */
export function DebateThreadTab() {
  const debate = useStore((s) => s.currentDebate);
  const thread = debate?.thread ?? [];

  if (thread.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        Run a swarm debate to see the conversation thread
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-2">
      {thread.map((msg, i) => {
        const sentColor = msg.sentiment > 0.2 ? "#22c55e" : msg.sentiment < -0.2 ? "#ef4444" : "var(--text-muted)";
        const sentPct = `${(msg.sentiment * 100).toFixed(0)}%`;

        return (
          <div
            key={msg.id || i}
            className="rounded-lg p-3"
            style={{
              background: msg.isChartSupport ? "rgba(59, 130, 246, 0.06)" : "var(--surface-2)",
              border: `1px solid ${msg.isChartSupport ? "rgba(59, 130, 246, 0.2)" : "var(--border)"}`,
            }}
          >
            {/* Header: name + role + round + sentiment */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-bold" style={{ color: "var(--text-primary)" }}>
                {msg.entityName}
              </span>
              <span className="text-[9px]" style={{ color: "var(--accent)" }}>
                {msg.entityRole}
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase"
                style={{ background: "var(--surface)", color: "var(--text-muted)" }}
              >
                R{msg.round}
              </span>
              <span
                className="ml-auto rounded px-1.5 py-0.5 text-[9px] font-bold"
                style={{ background: `${sentColor}22`, color: sentColor }}
              >
                {msg.sentiment > 0 ? "+" : ""}{sentPct}
              </span>
            </div>

            {/* Content */}
            <p className="mt-1.5 text-[10px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
              {msg.content}
            </p>

            {/* Footer: price prediction + references */}
            <div className="mt-2 flex items-center gap-3 flex-wrap">
              {msg.pricePrediction != null && (
                <span className="text-[9px] font-medium" style={{ color: "var(--text-muted)" }}>
                  Target: <span style={{ color: "var(--text-primary)" }}>${Number(msg.pricePrediction).toLocaleString()}</span>
                </span>
              )}
              {msg.agreedWith && msg.agreedWith.length > 0 && (
                <span className="text-[9px]" style={{ color: "#22c55e" }}>
                  Agrees: {msg.agreedWith.join(", ")}
                </span>
              )}
              {msg.disagreedWith && msg.disagreedWith.length > 0 && (
                <span className="text-[9px]" style={{ color: "#ef4444" }}>
                  Disagrees: {msg.disagreedWith.join(", ")}
                </span>
              )}
              {msg.isChartSupport && (
                <span className="text-[9px] font-medium" style={{ color: "#3b82f6" }}>
                  Chart data injected
                </span>
              )}
              {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                <div className="flex gap-1 ml-auto">
                  {msg.toolsUsed.map((t) => (
                    <span
                      key={t}
                      className="rounded px-1.5 py-0.5 text-[8px] font-mono"
                      style={{ background: "rgba(255,107,0,0.12)", color: "var(--accent)" }}
                      title={msg.toolResults?.[t] || t}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
