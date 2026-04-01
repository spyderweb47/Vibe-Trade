"use client";

import { useEffect, useRef } from "react";
import { TopBar } from "@/components/TopBar";
import { RightSidebar } from "@/components/RightSidebar";
import { BottomPanel } from "@/components/BottomPanel";
import { Chart } from "@/components/Chart";
import { DrawingToolbar } from "@/components/DrawingToolbar";
import { useStore } from "@/store/useStore";

export default function Home() {
  const chartData = useStore((s) => s.chartData);
  const patternMatches = useStore((s) => s.patternMatches);
  const rootRef = useRef<HTMLDivElement>(null);

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

  return (
    <div ref={rootRef} className="flex h-screen overflow-hidden">
      {/* Center Content */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Top Bar */}
        <TopBar />

        {/* Chart Area with Drawing Toolbar */}
        <div className="flex flex-1 min-h-0">
          <DrawingToolbar />
          <div className="flex-1 min-h-0 p-2">
            <Chart data={chartData} patternMatches={patternMatches} />
          </div>
        </div>

        {/* Bottom Panel - collapsible, contextual by mode */}
        <BottomPanel />
      </div>

      {/* Right Sidebar */}
      <RightSidebar />
    </div>
  );
}
