"use client";

import { useRef, useState, useEffect } from "react";
import { useStore, type Mode } from "@/store/useStore";
import type { SkillMetadata } from "@/lib/api";

// ─── Skill icon resolver ────────────────────────────────────────────────────
// The backend SKILL.md frontmatter specifies an icon name (string). The
// frontend maps it to an SVG. Unknown icon names fall back to the sparkle.

function SkillIcon({ name }: { name: string }) {
  switch (name) {
    case "chart-line":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3v18h18M7 16l4-8 4 4 4-10" />
        </svg>
      );
    case "briefcase":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
      );
    case "download":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
        </svg>
      );
    case "list-ordered":
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
        </svg>
      );
    case "sparkles":
    default:
      return (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.286 6.857L22 12l-6.714 2.143L13 21l-2.286-6.857L4 12l6.714-2.143L13 3z" />
        </svg>
      );
  }
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  placeholder?: string;
  onOpenDatasets: () => void;
}

export function ChatInputBar({
  value,
  onChange,
  onSend,
  disabled = false,
  placeholder = "Describe a pattern, strategy, or ask anything...",
  onOpenDatasets,
}: Props) {
  const activeDataset = useStore((s) => s.activeDataset);
  const datasets = useStore((s) => s.datasets);
  const skills = useStore((s) => s.skills);
  const skillsLoaded = useStore((s) => s.skillsLoaded);
  const activeSkillIds = useStore((s) => s.activeSkillIds);
  const setActiveSkills = useStore((s) => s.setActiveSkills);
  const indicators = useStore((s) => s.indicators);
  const toggleIndicator = useStore((s) => s.toggleIndicator);
  const scripts = useStore((s) => s.scripts);
  const [menuOpen, setMenuOpen] = useState(false);
  const [resourcesExpanded, setResourcesExpanded] = useState(false);
  const [skillRowOpen, setSkillRowOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeDs = datasets.find((d) => d.id === activeDataset);

  // If the store's skills list loads AFTER the component mounted with an
  // active skill id that no longer exists on the backend, prune it. Zero
  // active skills is allowed — the chat falls through to the general handler.
  useEffect(() => {
    if (!skillsLoaded || skills.length === 0) return;
    const validIds = new Set(skills.map((s) => s.id));
    const stillValid = Array.from(activeSkillIds).filter((id) => validIds.has(id));
    if (stillValid.length !== activeSkillIds.size) {
      setActiveSkills(new Set(stillValid));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsLoaded, skills]);

  const toggleSkill = (id: Mode) => {
    const next = new Set(activeSkillIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setActiveSkills(next);
  };

  // Build dynamic placeholder from the active skill's input hints.
  //   - exactly 1 skill active → use that skill's placeholder
  //   - 0 skills active        → generic "ask Vibe Trade anything" prompt
  //   - 2+ skills active       → fall through to the RightSidebar default
  const effectivePlaceholder = (() => {
    if (activeSkillIds.size === 1 && skills.length > 0) {
      const id = Array.from(activeSkillIds)[0];
      const skill = skills.find((s) => s.id === id);
      if (skill?.input_hints?.placeholder) return skill.input_hints.placeholder;
    }
    if (activeSkillIds.size === 0) {
      return "Ask Vibe Trade anything…";
    }
    return placeholder;
  })();

  // Close + menu on outside click
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
          placeholder={effectivePlaceholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-3 pt-3 pb-1 text-[12px] outline-none"
          style={{
            color: "var(--text-primary)",
            minHeight: 40,
            maxHeight: 140,
          }}
        />

        {/* Bottom controls row — wraps to multiple lines when there are
            many chips. The Send button uses ml-auto so it always sits at
            the end of its current row (right-aligned), even if earlier
            items wrapped onto additional rows above it. */}
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2">
          {/* + Attach menu */}
          <div className="relative shrink-0" ref={menuRef}>
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
                className="absolute bottom-full left-0 mb-2 w-64 rounded-lg shadow-2xl py-1 z-20"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                {/* Single Dataset entry — opens the datasets modal */}
                <MenuItem
                  icon={
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-5l-2-2H6a2 2 0 00-2 2z" />
                    </svg>
                  }
                  label="Dataset"
                  sublabel={datasets.length === 0 ? "Upload a CSV to begin" : `${datasets.length} loaded`}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenDatasets();
                  }}
                />

                {/* Resources expandable row — inline dropdown instead of a modal */}
                <button
                  onClick={() => setResourcesExpanded((v) => !v)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
                  type="button"
                >
                  <span style={{ color: "var(--text-secondary)" }}>
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14-7H5m14 14H5" />
                    </svg>
                  </span>
                  <span className="flex-1">
                    <span className="block text-[11px] font-semibold" style={{ color: "var(--text-primary)" }}>
                      Resources
                    </span>
                    <span className="block text-[9px]" style={{ color: "var(--text-muted)" }}>
                      Indicators & saved scripts
                    </span>
                  </span>
                  <svg
                    className="h-3 w-3 transition-transform"
                    style={{ transform: resourcesExpanded ? "rotate(180deg)" : "none", color: "var(--text-tertiary)" }}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.5}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {resourcesExpanded && (
                  <div
                    className="max-h-64 overflow-y-auto"
                    style={{ borderTop: "1px solid var(--border-subtle)" }}
                  >
                    {/* Indicators section */}
                    <div
                      className="px-3 pt-2 pb-1 text-[8px] font-bold uppercase tracking-wider"
                      style={{ color: "var(--text-muted)" }}
                    >
                      Indicators ({indicators.length})
                    </div>
                    {indicators.length === 0 && (
                      <div className="px-3 pb-1 text-[9px]" style={{ color: "var(--text-muted)" }}>
                        No indicators yet.
                      </div>
                    )}
                    {indicators.map((ind) => (
                      <button
                        key={ind.name}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleIndicator(ind.name);
                        }}
                        className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-[var(--surface-2)]"
                        type="button"
                      >
                        <span
                          className="flex h-3 w-3 shrink-0 items-center justify-center rounded border"
                          style={{
                            borderColor: ind.active ? "var(--accent)" : "var(--border)",
                            background: ind.active ? "var(--accent)" : "transparent",
                          }}
                        >
                          {ind.active && (
                            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="#000" strokeWidth={4}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </span>
                        <span className="flex-1 text-[10px] truncate" style={{ color: "var(--text-primary)" }}>
                          {ind.name}
                        </span>
                        {ind.custom && (
                          <span
                            className="rounded px-1 py-0.5 text-[7px] font-bold uppercase"
                            style={{ background: "rgba(255,107,0,0.15)", color: "var(--accent)" }}
                          >
                            custom
                          </span>
                        )}
                      </button>
                    ))}

                    {/* Scripts section */}
                    <div
                      className="px-3 pt-2 pb-1 text-[8px] font-bold uppercase tracking-wider"
                      style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border-subtle)", marginTop: 4 }}
                    >
                      Scripts ({scripts.length})
                    </div>
                    {scripts.length === 0 && (
                      <div className="px-3 pb-2 text-[9px]" style={{ color: "var(--text-muted)" }}>
                        No saved scripts.
                      </div>
                    )}
                    {scripts.map((script) => (
                      <div
                        key={script.id}
                        className="flex items-center gap-2 px-3 py-1 text-[10px] truncate"
                        style={{ color: "var(--text-primary)" }}
                        title={script.name}
                      >
                        <span className="flex-1 truncate">{script.name}</span>
                        <span
                          className="rounded px-1 py-0.5 text-[7px] font-bold uppercase"
                          style={{
                            background: script.type === "strategy" ? "rgba(38,166,154,0.15)" : "rgba(255,107,0,0.15)",
                            color: script.type === "strategy" ? "#26a69a" : "var(--accent)",
                          }}
                        >
                          {script.type}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Active skill chips — each shows icon + tagline + ✕ to remove.
              The user can deselect every skill: when zero are active, the
              chat falls through to the backend's general LLM handler. */}
          {skills.length > 0 && Array.from(activeSkillIds).map((id) => {
            const skill = skills.find((s) => s.id === id);
            if (!skill) return null;
            const accent = skill.color || "var(--accent)";
            return (
              <div
                key={skill.id}
                className="flex items-center gap-1 rounded-lg pl-2 pr-1 py-1 text-[10px] font-semibold"
                style={{
                  background: `${accent}26`,
                  color: accent,
                  border: `1px solid ${accent}`,
                }}
                title={skill.description}
              >
                <span className="scale-75 origin-center -mr-0.5">
                  <SkillIcon name={skill.icon} />
                </span>
                <span>{skill.tagline || skill.name}</span>
                <button
                  onClick={() => toggleSkill(skill.id)}
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full transition-colors hover:bg-black/20"
                  title={`Remove ${skill.name}`}
                  type="button"
                >
                  <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            );
          })}

          {/* "+ Skill" button — opens the full skill chip row below so the
              user can pick additional skills. Labeled explicitly so it's
              obvious what the button does. */}
          <button
            onClick={() => setSkillRowOpen(!skillRowOpen)}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[10px] font-semibold transition-colors"
            style={{
              background: skillRowOpen ? "var(--accent)" : "var(--surface)",
              color: skillRowOpen ? "#000" : "var(--accent)",
              border: `1px solid ${skillRowOpen ? "var(--accent)" : "rgba(255,107,0,0.3)"}`,
            }}
            title="Add skill"
            type="button"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Skill
          </button>

          {/* Active dataset chip */}
          {activeDs && (
            <span
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[9px] font-medium max-w-[120px] shrink-0"
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

          {/* Send button — ml-auto keeps it right-aligned on its current row
              (which may be the first row if chips fit, or a new row if they
              wrapped). Always visible, never clipped. */}
          <button
            onClick={onSend}
            disabled={disabled || !value.trim()}
            className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-opacity disabled:opacity-40"
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

      {/* Skill chip row — appears below the input when the Skills pill is clicked */}
      {skillRowOpen && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!skillsLoaded && (
            <div className="flex items-center text-[10px] px-2 py-1" style={{ color: "var(--text-muted)" }}>
              Loading skills…
            </div>
          )}
          {skillsLoaded && skills.length === 0 && (
            <div className="flex items-center text-[10px] px-2 py-1" style={{ color: "var(--text-muted)" }}>
              No skills registered on the backend.
            </div>
          )}
          {skills.map((skill: SkillMetadata) => {
            const isSelected = activeSkillIds.has(skill.id);
            const accent = skill.color || "var(--accent)";
            return (
              <button
                key={skill.id}
                onClick={() => toggleSkill(skill.id)}
                className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold transition-all"
                style={{
                  background: isSelected ? `${accent}26` : "var(--surface-2)",
                  color: isSelected ? accent : "var(--text-tertiary)",
                  border: `1px solid ${isSelected ? accent : "var(--border)"}`,
                }}
                title={skill.description}
              >
                <span className="scale-75 origin-center">
                  <SkillIcon name={skill.icon} />
                </span>
                {skill.name}
                {isSelected && (
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
          {skills.length > 0 && (
            <div className="flex items-center text-[9px] ml-1" style={{ color: "var(--text-muted)" }}>
              {activeSkillIds.size > 1 ? `${activeSkillIds.size} skills selected` : "Select one or more"}
            </div>
          )}
        </div>
      )}
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
