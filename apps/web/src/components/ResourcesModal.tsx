"use client";

import { useState } from "react";
import { useStore } from "@/store/useStore";

const TAG_STYLES: Record<string, { bg: string; color: string }> = {
  indicator: { bg: "rgba(255,107,0,0.15)", color: "#ff6b00" },
  pattern: { bg: "rgba(255,152,0,0.15)", color: "#ff9800" },
  strategy: { bg: "rgba(38,166,154,0.15)", color: "#26a69a" },
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export function ResourcesModal({ open, onClose }: Props) {
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const removeIndicator = useStore((s) => s.removeIndicator);
  const scripts = useStore((s) => s.scripts);
  const removeScript = useStore((s) => s.removeScript);
  const [tab, setTab] = useState<"indicators" | "scripts">("indicators");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl shadow-2xl flex flex-col max-h-[80vh]"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
            Resources
          </h2>
          <button
            onClick={onClose}
            className="rounded p-1 transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: "var(--text-tertiary)" }}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
          {(["indicators", "scripts"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 text-[10px] font-semibold uppercase tracking-wider transition-colors"
              style={{
                color: tab === t ? "var(--text-primary)" : "var(--text-tertiary)",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              {t === "indicators" ? `Indicators (${indicators.length})` : `Scripts (${scripts.length})`}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {tab === "indicators" && (
            <div className="space-y-1">
              {indicators.length === 0 && (
                <p className="text-[11px] p-2" style={{ color: "var(--text-tertiary)" }}>
                  No indicators yet. Ask the agent to create one for you.
                </p>
              )}
              {indicators.map((ind, idx) => (
                <div
                  key={`ind-${idx}-${ind.backendName}`}
                  className="flex items-center gap-2 rounded px-2 py-1.5"
                  style={{ background: "var(--surface-2)", border: "1px solid var(--border-subtle)" }}
                >
                  <button
                    onClick={() => toggleIndicator(ind.name)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                    style={{
                      borderColor: ind.active ? "var(--accent)" : "var(--border)",
                      background: ind.active ? "var(--accent)" : "transparent",
                    }}
                  >
                    {ind.active && (
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="#000" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                  <span className="flex-1 text-[11px] truncate" style={{ color: "var(--text-primary)" }}>
                    {ind.name}
                  </span>
                  <span
                    className="rounded px-1.5 py-0.5 text-[8px] font-semibold"
                    style={{ background: TAG_STYLES.indicator.bg, color: TAG_STYLES.indicator.color }}
                  >
                    indicator
                  </span>
                  <button
                    onClick={() => removeIndicator(ind.name)}
                    className="transition-colors hover:text-red-400"
                    style={{ color: "var(--text-muted)" }}
                    title="Remove"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {tab === "scripts" && (
            <div className="space-y-1">
              {scripts.length === 0 && (
                <p className="text-[11px] p-2" style={{ color: "var(--text-tertiary)" }}>
                  No saved scripts yet. Scripts you save from chat will appear here.
                </p>
              )}
              {scripts.map((script) => {
                const style = TAG_STYLES[script.type] || TAG_STYLES.pattern;
                return (
                  <div
                    key={script.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border-subtle)" }}
                  >
                    <span className="flex-1 text-[11px] truncate" style={{ color: "var(--text-primary)" }}>
                      {script.name}
                    </span>
                    <span
                      className="rounded px-1.5 py-0.5 text-[8px] font-semibold"
                      style={{ background: style.bg, color: style.color }}
                    >
                      {script.type}
                    </span>
                    <button
                      onClick={() => removeScript(script.id)}
                      className="transition-colors hover:text-red-400"
                      style={{ color: "var(--text-muted)" }}
                      title="Delete"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
