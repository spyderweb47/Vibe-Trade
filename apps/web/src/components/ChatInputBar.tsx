"use client";

import { useRef, useState, useEffect } from "react";
import { useStore } from "@/store/useStore";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  onOpenDatasets: () => void;
  onOpenResources: () => void;
}

export function ChatInputBar({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = "Describe a pattern, strategy, or ask anything...",
  onOpenDatasets,
  onOpenResources,
}: Props) {
  const activeMode = useStore((s) => s.activeMode);
  const setMode = useStore((s) => s.setMode);
  const activeDataset = useStore((s) => s.activeDataset);
  const datasets = useStore((s) => s.datasets);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeDs = datasets.find((d) => d.id === activeDataset);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 140) + "px";
  }, [value]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="px-3 pb-3 pt-1">
      <div
        className="rounded-2xl transition-all"
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
        }}
      >
        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[12px] outline-none"
          style={{
            color: "var(--text-primary)",
            minHeight: 40,
            maxHeight: 140,
          }}
        />

        {/* Bottom controls row */}
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {/* + Attach menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
              style={{
                background: menuOpen ? "var(--accent)" : "var(--surface)",
                color: menuOpen ? "#000" : "var(--text-secondary)",
                border: "1px solid var(--border)",
              }}
              title="Add"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* Popup menu */}
            {menuOpen && (
              <div
                className="absolute bottom-full left-0 mb-2 w-52 rounded-lg shadow-2xl py-1 z-20"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                <MenuItem
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  }
                  label="Upload CSV"
                  sublabel="Add a new OHLC dataset"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenDatasets();
                  }}
                />
                <MenuItem
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-5l-2-2H6a2 2 0 00-2 2z" />
                    </svg>
                  }
                  label="Datasets"
                  sublabel={datasets.length === 0 ? "No datasets yet" : `${datasets.length} loaded`}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenDatasets();
                  }}
                />
                <MenuItem
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14-7H5m14 14H5" />
                    </svg>
                  }
                  label="Resources"
                  sublabel="Indicators & saved scripts"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenResources();
                  }}
                />
              </div>
            )}
          </div>

          {/* Agent mode pill */}
          <button
            onClick={() => setMode(activeMode === "pattern" ? "strategy" : "pattern")}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-semibold transition-colors"
            style={{
              background: "rgba(255,107,0,0.15)",
              color: "var(--accent)",
              border: "1px solid rgba(255,107,0,0.3)",
            }}
            title="Click to switch agent"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            {activeMode === "pattern" ? "Pattern" : "Strategy"}
          </button>

          {/* Active dataset chip */}
          {activeDs && (
            <span
              className="hidden sm:inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[9px] font-medium max-w-[120px]"
              style={{
                background: "var(--surface)",
                color: "var(--text-tertiary)",
                border: "1px solid var(--border-subtle)",
              }}
              title={activeDs.name}
            >
              <svg className="h-2.5 w-2.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
              </svg>
              <span className="truncate">{activeDs.name}</span>
            </span>
          )}

          <div className="flex-1" />

          {/* Send button */}
          <button
            onClick={onSend}
            disabled={disabled || !value.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-lg transition-opacity disabled:opacity-40"
            style={{
              background: "var(--accent)",
              color: "#000",
            }}
            title="Send"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  sublabel,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
      <span className="flex-1">
        <span className="block text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
          {label}
        </span>
        {sublabel && (
          <span className="block text-[9px]" style={{ color: "var(--text-muted)" }}>
            {sublabel}
          </span>
        )}
      </span>
    </button>
  );
}
