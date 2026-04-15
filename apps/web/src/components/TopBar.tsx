"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/store/useStore";

interface TopBarProps {
  onToggleSidebar?: () => void;
  sidebarCollapsed?: boolean;
}

// GitHub repo metadata — clicking the badge opens the repo in a new tab.
// The star count is fetched once per hour and cached in localStorage so we
// don't hammer GitHub's unauthenticated API rate limit (60 requests/hour).
const GITHUB_REPO = "spyderweb47/Vibe-Trade";
const GITHUB_URL = `https://github.com/${GITHUB_REPO}`;
const STAR_CACHE_KEY = "vibe-trade.github-stars.v1";
const STAR_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function useGitHubStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    // Try cache first
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(STAR_CACHE_KEY) : null;
      if (raw) {
        const cached = JSON.parse(raw) as { count: number; ts: number };
        if (cached && typeof cached.count === "number" && Date.now() - cached.ts < STAR_CACHE_TTL_MS) {
          setStars(cached.count);
          return;
        }
      }
    } catch {
      // ignore parse errors
    }

    // Cache miss or stale — fetch from GitHub
    fetch(`https://api.github.com/repos/${GITHUB_REPO}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const count = typeof data.stargazers_count === "number" ? data.stargazers_count : 0;
        setStars(count);
        try {
          window.localStorage.setItem(STAR_CACHE_KEY, JSON.stringify({ count, ts: Date.now() }));
        } catch {
          // quota exceeded — not critical
        }
      })
      .catch(() => {
        // Network errors are not critical — just hide the count
      });
  }, []);

  return stars;
}

export function TopBar({ onToggleSidebar, sidebarCollapsed }: TopBarProps) {
  const darkMode = useStore((s) => s.darkMode);
  const toggleDarkMode = useStore((s) => s.toggleDarkMode);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const conversations = useStore((s) => s.conversations);
  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const stars = useGitHubStars();

  return (
    <div
      className="flex items-center gap-3 border-b px-4 h-11 shrink-0"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
    >
      {/* Active conversation title — replaces the brand+modes that moved to LeftSidebar */}
      <div className="flex items-center gap-2 shrink-0 min-w-0">
        <span
          className="text-[11px] font-semibold truncate max-w-[260px]"
          style={{ color: "var(--text-secondary)" }}
          title={activeConversation?.title || "New chat"}
        >
          {activeConversation?.title || "New chat"}
        </span>
      </div>

      <div className="flex-1 min-w-0" />

      {/* Right cluster */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* GitHub star badge — opens the repo in a new tab */}
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold transition-colors hover:bg-[var(--surface-2)]"
          style={{
            color: "var(--text-secondary)",
            border: "1px solid var(--border)",
          }}
          title={`${GITHUB_REPO} on GitHub`}
        >
          {/* GitHub mark (Octocat silhouette) */}
          <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
          <span>Star</span>
          {/* Vertical separator */}
          <span className="h-3 w-px" style={{ background: "var(--border)" }} />
          {/* Star icon + count */}
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 24 24" fill="var(--accent)">
            <path d="M12 2l2.928 6.93 7.572.618-5.757 4.973 1.73 7.379L12 17.77l-6.473 4.13 1.73-7.38L1.5 9.55l7.572-.618z" />
          </svg>
          <span style={{ color: "var(--text-primary)" }}>
            {stars !== null ? stars.toLocaleString() : "—"}
          </span>
        </a>

        {/* Dark/Light mode toggle */}
        <button
          onClick={toggleDarkMode}
          className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
          style={{ color: "var(--text-tertiary)" }}
          title={darkMode ? "Light mode" : "Dark mode"}
        >
          {darkMode ? (
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="5" />
              <path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.73 12.73l1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
            </svg>
          ) : (
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          )}
        </button>

        {/* Sidebar toggle */}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-2)]"
            style={{ color: sidebarCollapsed ? "var(--text-tertiary)" : "var(--accent)" }}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="15" y1="4" x2="15" y2="20" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
