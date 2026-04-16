"use client";

import { useState, useEffect, useRef } from "react";
import { useStore } from "@/store/useStore";

/* ── Themed confirmation dialog ─────────────────────────────────────── */
function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs rounded-xl shadow-2xl"
        style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <div className="px-4 pt-4 pb-2">
          <h3 className="text-[13px] font-bold" style={{ color: "var(--text-primary)" }}>
            {title}
          </h3>
          <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            {message}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors"
            style={{
              background: "var(--surface-2)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg px-3 py-1.5 text-[11px] font-semibold transition-colors"
            style={{
              background: "rgba(239, 68, 68, 0.15)",
              color: "#ef4444",
              border: "1px solid rgba(239, 68, 68, 0.3)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Main sidebar ───────────────────────────────────────────────────── */

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

/**
 * Kimi/ChatGPT-style left sidebar.
 *
 * Contents:
 *  - Brand + collapse toggle
 *  - "+ New Chat" button
 *  - Mode toggle (Building / Playground / Simulation)
 *  - "Chat History" section with persisted conversations
 *
 * Conversations live in `useStore.conversations` and are persisted to
 * localStorage by the store. Switching/creating snapshots the active
 * conversation's full state (messages, code, results) before swapping.
 */
export function LeftSidebar({ collapsed, onToggle }: Props) {
  const conversations = useStore((s) => s.conversations);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const createConversation = useStore((s) => s.createConversation);
  const switchConversation = useStore((s) => s.switchConversation);
  const deleteConversation = useStore((s) => s.deleteConversation);
  const renameConversation = useStore((s) => s.renameConversation);
  const appMode = useStore((s) => s.appMode);
  const setAppMode = useStore((s) => s.setAppMode);
  const loadingConversationIds = useStore((s) => s.loadingConversationIds);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deletingConvo = deletingId ? conversations.find((c) => c.id === deletingId) : null;

  if (collapsed) {
    return (
      <div
        className="flex flex-col items-center py-2 shrink-0 h-full"
        style={{ width: 44, background: "var(--surface)", borderRight: "1px solid var(--border)" }}
      >
        <button
          onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
          title="Show sidebar"
          style={{ color: "var(--text-tertiary)" }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
        <button
          onClick={() => createConversation()}
          className="mt-2 flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
          title="New chat"
          style={{ color: "var(--accent)" }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full shrink-0" style={{ background: "var(--surface)" }}>
      {/* Header — brand + collapse */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <div className="flex items-center gap-2">
          <div
            className="flex h-6 w-6 items-center justify-center rounded"
            style={{ background: "var(--accent)" }}
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17l6-6 4 4 8-8" />
            </svg>
          </div>
          <span className="text-[13px] font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            VIBE <span style={{ color: "var(--accent)" }}>TRADE</span>
          </span>
        </div>
        <button
          onClick={onToggle}
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-tertiary)" }}
          title="Hide sidebar"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
          </svg>
        </button>
      </div>

      {/* New chat */}
      <div className="px-3 pt-3 pb-1.5 shrink-0">
        <button
          onClick={() => { setAppMode("building" as never); createConversation(); }}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors hover:bg-[var(--surface)]"
          style={{
            background: "var(--surface-2)",
            color: "var(--text-primary)",
            border: "1px solid var(--border)",
          }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="var(--accent)" strokeWidth={2.5}>
            <circle cx="12" cy="12" r="10" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v8m4-4H8" />
          </svg>
          <span className="flex-1 text-left">New Chat</span>
        </button>
      </div>

      {/* Playground — separate section/page */}
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={() => setAppMode(appMode === "playground" ? "building" as never : "playground" as never)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors"
          style={{
            background: appMode === "playground" ? "rgba(139, 92, 246, 0.12)" : "var(--surface-2)",
            color: appMode === "playground" ? "#8b5cf6" : "var(--text-secondary)",
            border: `1px solid ${appMode === "playground" ? "rgba(139, 92, 246, 0.3)" : "var(--border)"}`,
          }}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="flex-1 text-left">Playground</span>
          {appMode === "playground" && (
            <span className="text-[8px] font-bold uppercase tracking-wider" style={{ color: "#8b5cf6" }}>Active</span>
          )}
        </button>
      </div>

      {/* Chat history */}
      <div className="px-3 pb-1 shrink-0" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <div
          className="pt-3 text-[9px] font-bold uppercase tracking-wider"
          style={{ color: "var(--text-muted)" }}
        >
          Chat History
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 && (
          <div className="px-2 py-3 text-[10px]" style={{ color: "var(--text-muted)" }}>
            No conversations yet. Click "New Chat" to start.
          </div>
        )}
        <ul className="space-y-0.5">
          {conversations.map((c) => {
            const isActive = c.id === activeConversationId;
            const isRenaming = renamingId === c.id;
            return (
              <li key={c.id}>
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => {
                      if (renameDraft.trim()) renameConversation(c.id, renameDraft);
                      setRenamingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        renameConversation(c.id, renameDraft);
                        setRenamingId(null);
                      } else if (e.key === "Escape") {
                        setRenamingId(null);
                      }
                    }}
                    className="w-full rounded px-2 py-1.5 text-[11px] outline-none"
                    style={{
                      background: "var(--surface-2)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--accent)",
                    }}
                  />
                ) : (
                  <div
                    data-conversation-id={c.id}
                    className="group flex items-center gap-1 rounded px-2 py-1.5 cursor-pointer transition-colors"
                    style={{
                      background: isActive ? "var(--surface-2)" : "transparent",
                      color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    }}
                    onClick={() => switchConversation(c.id)}
                    onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "var(--surface-2)"; }}
                    onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                  >
                    <span className="flex-1 truncate text-[11px]" title={c.title}>
                      {c.title || "New chat"}
                    </span>
                    {loadingConversationIds.has(c.id) && (
                      <span
                        className="shrink-0 h-2 w-2 rounded-full animate-pulse"
                        style={{ background: "var(--accent)" }}
                        title="Processing..."
                      />
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(c.id);
                        setRenameDraft(c.title || "");
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Rename"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingId(c.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      title="Delete"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Themed delete confirmation dialog */}
      {deletingConvo && (
        <ConfirmDialog
          title="Delete conversation"
          message={`Are you sure you want to delete "${deletingConvo.title || "this conversation"}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => {
            deleteConversation(deletingConvo.id);
            setDeletingId(null);
          }}
          onCancel={() => setDeletingId(null)}
        />
      )}
    </div>
  );
}
