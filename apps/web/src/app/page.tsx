"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { TopBar } from "@/components/TopBar";
import { LeftSidebar } from "@/components/LeftSidebar";
import { RightSidebar } from "@/components/RightSidebar";
import { BottomPanel } from "@/components/BottomPanel";
import { Chart } from "@/components/Chart";
import { DrawingToolbar } from "@/components/DrawingToolbar";
import { TimeframeSelector } from "@/components/TimeframeSelector";
import { PlaygroundControls } from "@/components/playground/PlaygroundControls";
import { DAGCanvas } from "@/components/simulation/DAGCanvas";
import { useStore } from "@/store/useStore";
import { usePlaygroundReplay } from "@/hooks/usePlaygroundReplay";

export default function Home() {
  const chartData = useStore((s) => s.chartData);
  const patternMatches = useStore((s) => s.patternMatches);
  const appMode = useStore((s) => s.appMode);
  const loadSkills = useStore((s) => s.loadSkills);
  const hydrateConversations = useStore((s) => s.hydrateConversations);

  // Drive the replay loop
  usePlaygroundReplay();

  // Load the skill registry from the backend on mount. Drives the skill
  // chip row in ChatInputBar and the bottom-panel tabs in BottomPanel.
  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  // Hydrate conversations from localStorage on mount (creates a fresh one
  // on first visit). This restores chat history + per-conversation state
  // like script, pattern matches, backtest results.
  useEffect(() => {
    hydrateConversations();
  }, [hydrateConversations]);

  // In playground mode, pass the full dataset to Chart — Chart renders whitespace
  // for future bars so drawings/trend lines can extend past the replay cursor.
  const displayedData = chartData;
  const rootRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(240);
  const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  const [showDAG, setShowDAG] = useState(false);
  const sidebarDrag = useRef({ active: false, startX: 0, startW: 0 });
  const leftSidebarDrag = useRef({ active: false, startX: 0, startW: 0 });

  // Track viewport width — auto-collapse sidebar on narrow screens
  useEffect(() => {
    const checkWidth = () => {
      const w = window.innerWidth;
      const narrow = w < 900;
      setIsNarrow(narrow);
      if (narrow && !sidebarCollapsed) setSidebarCollapsed(true);
    };
    checkWidth();
    window.addEventListener("resize", checkWidth);
    return () => window.removeEventListener("resize", checkWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarDrag.current = { active: true, startX: e.clientX, startW: sidebarWidth };

    const onMove = (ev: MouseEvent) => {
      if (!sidebarDrag.current.active) return;
      const dx = sidebarDrag.current.startX - ev.clientX;
      const newW = Math.max(240, Math.min(600, sidebarDrag.current.startW + dx));
      setSidebarWidth(newW);
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = () => {
      sidebarDrag.current.active = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  const onLeftSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    leftSidebarDrag.current = { active: true, startX: e.clientX, startW: leftSidebarWidth };

    const onMove = (ev: MouseEvent) => {
      if (!leftSidebarDrag.current.active) return;
      const dx = ev.clientX - leftSidebarDrag.current.startX;
      const newW = Math.max(180, Math.min(420, leftSidebarDrag.current.startW + dx));
      setLeftSidebarWidth(newW);
      window.dispatchEvent(new Event("resize"));
    };
    const onUp = () => {
      leftSidebarDrag.current.active = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [leftSidebarWidth]);

  // Prevent browser from scrolling the overflow-hidden container
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    const handler = () => { el.scrollTop = 0; el.scrollLeft = 0; };
    el.addEventListener("scroll", handler);
    return () => el.removeEventListener("scroll", handler);
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((v) => !v);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  const effectiveSidebarWidth = sidebarCollapsed ? 0 : sidebarWidth;

  return (
    <div ref={rootRef} className="flex h-screen overflow-hidden relative" style={{ background: "var(--bg)" }}>
      {/* Left Sidebar — chat history + mode toggle */}
      <div
        className="flex shrink-0 transition-[width] duration-200 ease-out"
        style={{ width: leftSidebarCollapsed ? 44 : leftSidebarWidth, borderRight: leftSidebarCollapsed ? "1px solid var(--border)" : "none" }}
      >
        <div className="flex-1 min-w-0 overflow-hidden">
          <LeftSidebar collapsed={leftSidebarCollapsed} onToggle={() => setLeftSidebarCollapsed(!leftSidebarCollapsed)} />
        </div>
        {!leftSidebarCollapsed && (
          <div
            onMouseDown={onLeftSidebarResizeStart}
            className="w-1 cursor-ew-resize hover:bg-[var(--accent)] transition-colors shrink-0"
            style={{ borderRight: "1px solid var(--border)" }}
          />
        )}
      </div>

      {/* Center Content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top Bar */}
        <TopBar onToggleSidebar={toggleSidebar} sidebarCollapsed={sidebarCollapsed} />

        {/* Timeframe selector */}
        <TimeframeSelector />

        {/* Playground replay controls (playground mode only) */}
        {appMode === "playground" && <PlaygroundControls />}

        {/* Simulation: Chart/DAG toggle bar */}
        {appMode === "simulation" && (
          <div
            className="flex items-center gap-2 px-3 py-1 shrink-0"
            style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}
          >
            <div
              className="flex rounded-md p-[2px]"
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
            >
              <button
                onClick={() => setShowDAG(false)}
                className="rounded px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider transition-all"
                style={{
                  background: !showDAG ? "var(--accent)" : "transparent",
                  color: !showDAG ? "#000" : "var(--text-tertiary)",
                }}
              >
                Chart
              </button>
              <button
                onClick={() => setShowDAG(true)}
                className="rounded px-2.5 py-1 text-[9px] font-bold uppercase tracking-wider transition-all"
                style={{
                  background: showDAG ? "var(--accent)" : "transparent",
                  color: showDAG ? "#000" : "var(--text-tertiary)",
                }}
              >
                DAG Canvas
              </button>
            </div>
            <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
              {showDAG ? "Explore agent debate graph" : "View price chart"}
            </span>
          </div>
        )}

        {/* Main content area: Chart or DAG Canvas */}
        <div className="flex flex-1 min-h-0">
          {appMode === "simulation" && showDAG ? (
            <div className="flex-1 min-h-0">
              <DAGCanvas />
            </div>
          ) : (
            <>
              <DrawingToolbar />
              <div className="flex-1 min-h-0">
                <Chart data={displayedData} patternMatches={appMode === "playground" ? [] : patternMatches} />
              </div>
            </>
          )}
        </div>

        {/* Bottom Panel - collapsible, contextual by mode */}
        <BottomPanel />
      </div>

      {/* Backdrop for sidebar overlay on narrow screens */}
      {isNarrow && !sidebarCollapsed && (
        <div
          onClick={toggleSidebar}
          className="absolute inset-0 z-30 transition-opacity"
          style={{ background: "rgba(0,0,0,0.5)" }}
        />
      )}

      {/* Right Sidebar with resize handle */}
      <div
        className={`flex shrink-0 transition-[width] duration-200 ease-out ${
          isNarrow ? "absolute right-0 top-0 h-full z-40 shadow-2xl" : ""
        }`}
        style={{
          width: effectiveSidebarWidth,
          background: "var(--surface)",
        }}
      >
        {!sidebarCollapsed && !isNarrow && (
          <div
            onMouseDown={onSidebarResizeStart}
            className="w-1 cursor-ew-resize hover:bg-[var(--accent)] transition-colors shrink-0"
          />
        )}
        {!sidebarCollapsed && (
          <div className="flex-1 min-w-0 overflow-hidden">
            <RightSidebar />
          </div>
        )}
      </div>
    </div>
  );
}
