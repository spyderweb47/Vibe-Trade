"use client";

import { useStore } from "@/store/useStore";
import dynamic from "next/dynamic";

// Lazy-load ReactFlow so it doesn't bloat the initial bundle for users
// who never open the DAG tab. SSR is disabled because ReactFlow uses
// browser APIs (ResizeObserver, etc.).
const DAGCanvas = dynamic(
  () => import("@/components/simulation/DAGCanvas").then((m) => m.DAGCanvas),
  { ssr: false },
);

/**
 * Bottom-panel tab wrapper for the DAG graph.
 * Shows the entity network with agree/disagree edges, center status
 * node, and summary node. Falls back to a "no debate" message.
 */
export function DAGGraphTab() {
  const debate = useStore((s) => s.currentDebate);

  if (!debate || debate.entities.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs" style={{ color: "var(--text-muted)" }}>
        Run a swarm debate to see the DAG graph
      </div>
    );
  }

  return (
    <div className="h-full w-full" style={{ minHeight: 300 }}>
      <DAGCanvas />
    </div>
  );
}
