"use client";

import { useEffect, useState } from "react";
import type { Message, TraceStep, TraceSubStep } from "@/types";

/**
 * Claude-style "agent process" trace rendered inline in the chat.
 *
 * While the planner is running, this box shows the plan's steps and updates
 * each one live as it transitions `pending → running → done`. When the run
 * finishes, it auto-collapses after a short delay to a 1-line summary chip
 * so it doesn't clutter the user ↔ agent conversation. The user can click
 * the chip to expand it again and review the full trace.
 *
 * Visually distinct from regular agent replies: no avatar label, dashed
 * border, muted background, and an inset step list with status icons.
 */
export function TraceMessage({ msg }: { msg: Message }) {
  const trace = msg.trace;
  const [manuallyToggled, setManuallyToggled] = useState(false);
  const [expanded, setExpanded] = useState(true);

  // Auto-collapse ~1.2s after the run completes (unless the user has
  // manually toggled the box, in which case respect their choice).
  useEffect(() => {
    if (!trace) return;
    if (manuallyToggled) return;
    if (trace.status === "done" || trace.status === "failed") {
      const t = setTimeout(() => setExpanded(false), 1200);
      return () => clearTimeout(t);
    }
    // While planning/running → keep expanded
    setExpanded(true);
  }, [trace?.status, manuallyToggled]);

  if (!trace) return null;

  const steps = trace.steps;
  const doneCount = steps.filter((s) => s.status === "done").length;
  const failed = trace.status === "failed";
  const running = trace.status === "running" || trace.status === "planning";
  const currentRunning = steps.findIndex((s) => s.status === "running");

  // ─── Collapsed state: compact summary chip ────────────────────────────
  if (!expanded) {
    return (
      <button
        onClick={() => {
          setManuallyToggled(true);
          setExpanded(true);
        }}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] w-full text-left transition-colors"
        style={{
          background: "var(--surface)",
          border: "1px dashed var(--border)",
          color: "var(--text-tertiary)",
        }}
        title="Expand agent process"
      >
        <span style={{ color: failed ? "var(--danger)" : "var(--success, #26a69a)" }}>
          {failed ? "✕" : "✓"}
        </span>
        <span className="font-semibold">
          {trace.title || (failed ? "Plan failed" : "Plan complete")}
        </span>
        <span style={{ color: "var(--text-muted)" }}>
          · {doneCount}/{steps.length} steps
        </span>
        <span className="ml-auto text-[9px] opacity-70">click to expand</span>
      </button>
    );
  }

  // ─── Expanded state: full process view ────────────────────────────────
  return (
    <div
      className="rounded-lg transition-colors"
      style={{
        background: "var(--surface)",
        border: "1px dashed var(--border)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: "1px solid var(--border-subtle)" }}
      >
        {running ? (
          <span
            className="inline-block h-3 w-3 rounded-full animate-pulse"
            style={{ background: "var(--accent)" }}
          />
        ) : failed ? (
          <span className="text-[12px]" style={{ color: "var(--danger)" }}>✕</span>
        ) : (
          <span className="text-[12px]" style={{ color: "var(--success, #26a69a)" }}>✓</span>
        )}
        <span
          className="text-[10px] font-bold uppercase tracking-wider flex-1"
          style={{ color: "var(--text-tertiary)" }}
        >
          {running ? "Agent process" : failed ? "Plan failed" : "Agent process"}
        </span>
        <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
          {doneCount}/{steps.length}
        </span>
        <button
          onClick={() => {
            setManuallyToggled(true);
            setExpanded(false);
          }}
          className="opacity-60 hover:opacity-100 transition-opacity"
          title="Collapse"
          style={{ color: "var(--text-muted)" }}
          type="button"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>

      {/* Title line */}
      {trace.title && (
        <div
          className="px-3 pt-2 pb-1 text-[11px] font-semibold"
          style={{ color: "var(--text-primary)" }}
        >
          {trace.title}
        </div>
      )}

      {/* Steps list */}
      <ol className="px-3 pb-3 pt-1 space-y-1.5">
        {steps.map((step, i) => (
          <TraceStepRow key={i} index={i} step={step} isCurrentRunning={i === currentRunning} />
        ))}
      </ol>
    </div>
  );
}

function TraceStepRow({ step, index, isCurrentRunning }: { step: TraceStep; index: number; isCurrentRunning: boolean }) {
  const isPending = step.status === "pending";
  const isRunning = step.status === "running";
  const isDone = step.status === "done";
  const isFailed = step.status === "failed";

  const indicatorColor =
    isDone ? "var(--success, #26a69a)" :
    isFailed ? "var(--danger)" :
    isRunning ? "var(--accent)" :
    "var(--text-muted)";

  return (
    <li
      className="flex gap-2 text-[11px] leading-relaxed"
      style={{ color: isPending ? "var(--text-muted)" : "var(--text-secondary)" }}
    >
      {/* Status indicator */}
      <span className="flex h-4 w-4 shrink-0 items-center justify-center mt-[1px]">
        {isDone ? (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke={indicatorColor} strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : isFailed ? (
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke={indicatorColor} strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : isRunning ? (
          <span
            className="inline-block h-2 w-2 rounded-full animate-pulse"
            style={{ background: indicatorColor }}
          />
        ) : (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ border: `1.5px solid ${indicatorColor}` }}
          />
        )}
      </span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className="font-mono font-semibold text-[9px] px-1 rounded"
            style={{
              background: "var(--surface-2)",
              color: indicatorColor,
            }}
          >
            {index + 1}
          </span>
          <span
            className="font-semibold"
            style={{ color: isPending ? "var(--text-muted)" : "var(--text-primary)" }}
          >
            {step.skill}
          </span>
          {isCurrentRunning && (
            <span
              className="text-[8px] uppercase tracking-wider font-bold rounded px-1"
              style={{ background: "rgba(255,107,0,0.15)", color: "var(--accent)" }}
            >
              running
            </span>
          )}
        </div>
        <div className="truncate" title={step.message}>
          {step.message}
        </div>
        {step.result && (
          <div
            className="text-[10px] mt-0.5"
            style={{ color: "var(--success, #26a69a)" }}
          >
            → {step.result}
          </div>
        )}
        {step.error && (
          <div
            className="text-[10px] mt-0.5"
            style={{ color: "var(--danger)" }}
          >
            ✕ {step.error}
          </div>
        )}
        {/* Sub-steps — internal progress for long-running skills */}
        {step.subSteps && step.subSteps.length > 0 && (
          <div className="mt-1.5 ml-1 space-y-0.5" style={{ borderLeft: "1px solid var(--border-subtle)", paddingLeft: 8 }}>
            {step.subSteps.map((sub, j) => (
              <div key={j} className="flex items-center gap-1.5 text-[9px]">
                {sub.status === "done" ? (
                  <svg className="h-2.5 w-2.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="var(--success, #26a69a)" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : sub.status === "running" ? (
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full animate-pulse" style={{ background: "var(--accent)" }} />
                ) : (
                  <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ border: "1px solid var(--text-muted)" }} />
                )}
                <span style={{ color: sub.status === "pending" ? "var(--text-muted)" : sub.status === "running" ? "var(--accent)" : "var(--text-secondary)" }}>
                  {sub.label}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
