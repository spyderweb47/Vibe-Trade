"use client";

import { useState, useRef, useEffect } from "react";
import { useStore } from "@/store/useStore";
import { interviewAgent } from "@/lib/api";

interface Props {
  agentId: string;
  onBack: () => void;
}

/**
 * Expanded view for a single debate persona. Shows:
 *  - Full profile (name, role, background, personality, bias, influence, tools)
 *  - All debate messages grouped by round, with tools used per message
 *  - Cross-examination response (if this agent was cross-examined)
 *  - Live interview chat box for follow-up questions
 */
export function AgentDetailPanel({ agentId, onBack }: Props) {
  const debate = useStore((s) => s.currentDebate);
  const agentInterviews = useStore((s) => s.agentInterviews);
  const addAgentInterviewMessage = useStore((s) => s.addAgentInterviewMessage);
  const clearAgentInterview = useStore((s) => s.clearAgentInterview);
  const agentInterviewLoading = useStore((s) => s.agentInterviewLoading);
  const setAgentInterviewLoading = useStore((s) => s.setAgentInterviewLoading);

  const entity = debate?.entities.find((e) => e.id === agentId);
  const messages = (debate?.thread || []).filter((m) => m.entityId === agentId);
  const crossExam = (debate?.crossExamResults || []).find((c) => c.entityId === agentId);
  const interviewHistory = agentInterviews[agentId] || [];
  const isLoading = agentInterviewLoading.has(agentId);

  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new interview messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [interviewHistory.length, isLoading]);

  if (!entity) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center">
          <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>Agent not found</div>
          <button
            onClick={onBack}
            className="mt-2 rounded px-3 py-1 text-[10px] font-semibold transition-colors"
            style={{ background: "var(--surface-2)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
          >
            ← Back to grid
          </button>
        </div>
      </div>
    );
  }

  // Compute sentiment across all this agent's messages
  const avgSentiment = messages.length > 0
    ? messages.reduce((acc, m) => acc + m.sentiment, 0) / messages.length
    : 0;
  const sentimentColor = avgSentiment > 0.2 ? "#22c55e" : avgSentiment < -0.2 ? "#ef4444" : "var(--text-muted)";
  const sentimentLabel = avgSentiment > 0.2 ? "Bullish" : avgSentiment < -0.2 ? "Bearish" : "Neutral";

  // Compute all tools this agent used across all rounds
  const allToolsUsed = new Set<string>();
  for (const m of messages) {
    for (const t of (m.toolsUsed || [])) allToolsUsed.add(t);
  }
  // Also include tools declared on the entity (from ROLE_TOOL_MAP)
  const declaredTools = ((entity as unknown as Record<string, unknown>).tools || []) as string[];

  const handleSend = async () => {
    const q = question.trim();
    if (!q || isLoading) return;

    addAgentInterviewMessage(agentId, { role: "user", content: q });
    setQuestion("");
    setAgentInterviewLoading(agentId, true);

    try {
      const previousPositions = messages.map((m) => `Round ${m.round}: ${m.content.slice(0, 200)}`);
      const historyForApi = [...interviewHistory, { role: "user" as const, content: q }].map((t) => ({
        role: t.role,
        content: t.content,
      }));

      const result = await interviewAgent({
        agent_id: entity.id,
        agent_name: entity.name,
        agent_role: entity.role,
        agent_background: entity.background || "",
        agent_bias: entity.bias || "neutral",
        agent_personality: entity.personality || "",
        asset_name: debate?.assetName || "the asset",
        asset_class: debate?.assetClass || "unknown",
        previous_positions: previousPositions,
        question: q,
        interview_history: historyForApi.slice(0, -1),  // Don't include the question we just sent
      });

      addAgentInterviewMessage(agentId, { role: "agent", content: result.response });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addAgentInterviewMessage(agentId, { role: "agent", content: `[Error: ${msg}]` });
    } finally {
      setAgentInterviewLoading(agentId, false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ─── Header ─── */}
      <div className="flex items-center gap-3 p-3 shrink-0" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-2)" }}>
        <button
          onClick={onBack}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-semibold transition-colors hover:bg-[var(--surface)]"
          style={{ color: "var(--text-secondary)" }}
          title="Back to grid"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Back
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>{entity.name}</span>
            <span className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase" style={{ background: `${sentimentColor}22`, color: sentimentColor }}>
              {sentimentLabel}
            </span>
          </div>
          <div className="text-[10px]" style={{ color: "var(--accent)" }}>{entity.role}</div>
        </div>
        <div className="text-right text-[9px]" style={{ color: "var(--text-muted)" }}>
          <div>{messages.length} messages</div>
          <div>Bias: <span style={{ color: "var(--text-secondary)" }}>{entity.bias}</span></div>
        </div>
      </div>

      {/* ─── Body (scrollable) ─── */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Background */}
        <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
            Background
          </div>
          <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {entity.background}
          </p>
        </div>

        {/* Personality */}
        <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
          <div className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
            Personality
          </div>
          <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {entity.personality}
          </p>
        </div>

        {/* Tools assigned */}
        {(declaredTools.length > 0 || allToolsUsed.size > 0) && (
          <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
            <div className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              Tools Available
            </div>
            <div className="flex flex-wrap gap-1.5">
              {declaredTools.map((t) => (
                <span
                  key={t}
                  className="rounded px-2 py-0.5 text-[9px] font-mono"
                  style={{
                    background: allToolsUsed.has(t) ? "rgba(255, 107, 0, 0.15)" : "var(--surface)",
                    color: allToolsUsed.has(t) ? "var(--accent)" : "var(--text-muted)",
                    border: `1px solid ${allToolsUsed.has(t) ? "rgba(255, 107, 0, 0.3)" : "var(--border)"}`,
                  }}
                  title={allToolsUsed.has(t) ? "Used during debate" : "Available but not used"}
                >
                  {t}{allToolsUsed.has(t) ? " ✓" : ""}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Cross-Examination Response */}
        {crossExam && (
          <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid rgba(255, 107, 0, 0.3)" }}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
                Cross-Examination
              </span>
              <span
                className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase"
                style={{
                  background:
                    crossExam.convictionChange === "reversed" ? "rgba(239, 68, 68, 0.2)"
                    : crossExam.convictionChange === "weakened" ? "rgba(245, 158, 11, 0.2)"
                    : crossExam.convictionChange === "strengthened" ? "rgba(34, 197, 94, 0.2)"
                    : "var(--surface)",
                  color:
                    crossExam.convictionChange === "reversed" ? "#ef4444"
                    : crossExam.convictionChange === "weakened" ? "#f59e0b"
                    : crossExam.convictionChange === "strengthened" ? "#22c55e"
                    : "var(--text-muted)",
                }}
              >
                {crossExam.convictionChange}
              </span>
            </div>
            <div className="text-[9px] italic mb-1.5" style={{ color: "var(--text-muted)" }}>
              Q: {crossExam.question}
            </div>
            <p className="text-[10px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
              {crossExam.response}
            </p>
          </div>
        )}

        {/* Debate Activity — messages grouped by round */}
        {messages.length > 0 && (
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              Debate Activity ({messages.length} messages)
            </div>
            <div className="space-y-2">
              {messages.map((m, i) => {
                const sentColor = m.sentiment > 0.2 ? "#22c55e" : m.sentiment < -0.2 ? "#ef4444" : "var(--text-muted)";
                return (
                  <div
                    key={m.id || i}
                    className="rounded-lg p-2.5"
                    style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderLeft: `3px solid ${sentColor}` }}
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="rounded px-1.5 py-0.5 text-[8px] font-bold uppercase"
                        style={{ background: "var(--surface)", color: "var(--text-muted)" }}
                      >
                        R{m.round}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[9px] font-bold"
                        style={{ background: `${sentColor}22`, color: sentColor }}
                      >
                        {m.sentiment > 0 ? "+" : ""}{(m.sentiment * 100).toFixed(0)}%
                      </span>
                      {m.pricePrediction != null && (
                        <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                          Target: <span style={{ color: "var(--text-primary)" }}>${Number(m.pricePrediction).toLocaleString()}</span>
                        </span>
                      )}
                      {m.toolsUsed && m.toolsUsed.length > 0 && (
                        <div className="ml-auto flex gap-1">
                          {m.toolsUsed.map((t) => (
                            <span
                              key={t}
                              className="rounded px-1.5 py-0.5 text-[8px] font-mono"
                              style={{ background: "rgba(255, 107, 0, 0.15)", color: "var(--accent)" }}
                              title={m.toolResults?.[t] || t}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                      {m.content}
                    </p>
                    {(m.agreedWith?.length || m.disagreedWith?.length) && (
                      <div className="mt-2 flex flex-wrap gap-2 text-[9px]">
                        {m.agreedWith && m.agreedWith.length > 0 && (
                          <span style={{ color: "#22c55e" }}>Agreed: {m.agreedWith.join(", ")}</span>
                        )}
                        {m.disagreedWith && m.disagreedWith.length > 0 && (
                          <span style={{ color: "#ef4444" }}>Disagreed: {m.disagreedWith.join(", ")}</span>
                        )}
                      </div>
                    )}
                    {/* Tool results (collapsible) */}
                    {m.toolResults && Object.keys(m.toolResults).length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[8px] font-bold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                          Tool results ({Object.keys(m.toolResults).length})
                        </summary>
                        <div className="mt-1 space-y-1">
                          {Object.entries(m.toolResults).map(([tool, result]) => (
                            <div
                              key={tool}
                              className="rounded p-1.5"
                              style={{ background: "var(--surface)", border: "1px solid var(--border-subtle)" }}
                            >
                              <div className="text-[9px] font-mono font-bold" style={{ color: "var(--accent)" }}>{tool}</div>
                              <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[8px] leading-snug" style={{ color: "var(--text-secondary)" }}>
                                {result.slice(0, 500)}
                              </pre>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Live Interview */}
        <div className="rounded-lg p-3" style={{ background: "var(--surface-2)", border: "1px solid rgba(255, 107, 0, 0.3)" }}>
          <div className="flex items-center justify-between mb-2">
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: "var(--accent)" }}>
              Live Interview with {entity.name}
            </div>
            {interviewHistory.length > 0 && (
              <button
                onClick={() => clearAgentInterview(agentId)}
                className="text-[9px] transition-colors hover:text-[var(--text-secondary)]"
                style={{ color: "var(--text-muted)" }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Interview messages */}
          <div className="space-y-1.5 mb-2">
            {interviewHistory.length === 0 && !isLoading && (
              <p className="text-[10px] italic" style={{ color: "var(--text-muted)" }}>
                Ask {entity.name} a follow-up question. They&apos;ll respond in character based on their debate positions.
              </p>
            )}
            {interviewHistory.map((msg, i) => (
              <div
                key={i}
                className="rounded p-2 text-[10px] leading-relaxed"
                style={{
                  background: msg.role === "user" ? "var(--surface)" : "rgba(255, 107, 0, 0.05)",
                  border: `1px solid ${msg.role === "user" ? "var(--border)" : "rgba(255, 107, 0, 0.15)"}`,
                  color: "var(--text-secondary)",
                }}
              >
                <span className="font-bold text-[9px] uppercase tracking-wider" style={{ color: msg.role === "user" ? "var(--text-muted)" : "var(--accent)" }}>
                  {msg.role === "user" ? "You" : entity.name}:
                </span>
                <p className="mt-0.5 whitespace-pre-wrap">{msg.content}</p>
              </div>
            ))}
            {isLoading && (
              <div className="rounded p-2" style={{ background: "rgba(255, 107, 0, 0.05)", border: "1px solid rgba(255, 107, 0, 0.15)" }}>
                <div className="text-[9px]" style={{ color: "var(--accent)" }}>
                  <span className="animate-pulse">{entity.name} is thinking...</span>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
              placeholder={`Ask ${entity.name} anything...`}
              disabled={isLoading}
              className="flex-1 rounded px-2 py-1.5 text-[10px] outline-none"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
              }}
            />
            <button
              onClick={handleSend}
              disabled={!question.trim() || isLoading}
              className="rounded px-3 py-1.5 text-[10px] font-semibold transition-colors disabled:opacity-40"
              style={{
                background: "var(--accent)",
                color: "#000",
              }}
            >
              {isLoading ? "..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
