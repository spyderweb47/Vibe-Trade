"use client";

import { useStore } from "@/store/useStore";

/**
 * Bottom-panel tab showing the debate summary dashboard: consensus
 * direction, confidence, price targets, key arguments, dissenting
 * views, risk factors, and the trade recommendation.
 */
export function RunStatsTab() {
  const debate = useStore((s) => s.currentDebate);
  const summary = debate?.summary;

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        Run a swarm debate to see run statistics
      </div>
    );
  }

  const dirColor =
    summary.consensusDirection === "BULLISH"
      ? "#22c55e"
      : summary.consensusDirection === "BEARISH"
        ? "#ef4444"
        : "#ff6b00";

  const rec = summary.recommendation || {};

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* Consensus card */}
        <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Consensus
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <span
              className="rounded-md px-3 py-1 text-sm font-black uppercase tracking-wide"
              style={{ background: `${dirColor}22`, color: dirColor }}
            >
              {summary.consensusDirection}
            </span>
            <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
              {summary.confidence.toFixed(0)}%
            </span>
          </div>
          <div className="mt-1 text-[10px]" style={{ color: "var(--text-muted)" }}>
            {debate.entities.length} personas, {debate.totalRounds} rounds, {debate.thread.length} messages
          </div>
        </div>

        {/* Price targets */}
        {summary.priceTargets && (
          <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Price Targets
            </div>
            <div className="mt-2 flex items-end gap-4">
              <div>
                <div className="text-[9px]" style={{ color: "#ef4444" }}>Low</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
                  ${Number(summary.priceTargets.low).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-[9px]" style={{ color: "var(--accent)" }}>Mid</div>
                <div className="text-lg font-black tabular-nums" style={{ color: "var(--text-primary)" }}>
                  ${Number(summary.priceTargets.mid).toLocaleString()}
                </div>
              </div>
              <div>
                <div className="text-[9px]" style={{ color: "#22c55e" }}>High</div>
                <div className="text-sm font-bold tabular-nums" style={{ color: "var(--text-primary)" }}>
                  ${Number(summary.priceTargets.high).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Key arguments */}
        {summary.keyArguments && summary.keyArguments.length > 0 && (
          <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Key Arguments
            </div>
            <ul className="mt-2 space-y-1.5">
              {summary.keyArguments.map((arg, i) => (
                <li key={i} className="flex gap-2 text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                  <span style={{ color: "#22c55e" }}>+</span>
                  <span>{arg}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Dissenting views */}
        {summary.dissentingViews && summary.dissentingViews.length > 0 && (
          <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Dissenting Views
            </div>
            <ul className="mt-2 space-y-1.5">
              {summary.dissentingViews.map((v, i) => (
                <li key={i} className="flex gap-2 text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                  <span style={{ color: "#ef4444" }}>-</span>
                  <span>{v}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Risk factors */}
        {summary.riskFactors && summary.riskFactors.length > 0 && (
          <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Risk Factors
            </div>
            <ul className="mt-2 space-y-1.5">
              {summary.riskFactors.map((r, i) => (
                <li key={i} className="flex gap-2 text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                  <span style={{ color: "#f59e0b" }}>!</span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Trade recommendation */}
        {rec.action && (
          <div className="rounded-lg p-4" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Recommendation
            </div>
            <div className="mt-2">
              <span
                className="rounded px-2 py-1 text-[11px] font-bold uppercase"
                style={{ background: `${dirColor}22`, color: dirColor }}
              >
                {rec.action}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
              {rec.entry != null && (
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Entry: </span>
                  <span style={{ color: "var(--text-primary)" }}>${Number(rec.entry).toLocaleString()}</span>
                </div>
              )}
              {rec.stop != null && (
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Stop: </span>
                  <span style={{ color: "#ef4444" }}>${Number(rec.stop).toLocaleString()}</span>
                </div>
              )}
              {rec.target != null && (
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Target: </span>
                  <span style={{ color: "#22c55e" }}>${Number(rec.target).toLocaleString()}</span>
                </div>
              )}
              {rec.position_size_pct != null && (
                <div>
                  <span style={{ color: "var(--text-muted)" }}>Size: </span>
                  <span style={{ color: "var(--text-primary)" }}>{rec.position_size_pct}%</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
