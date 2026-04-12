"use client";

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  Handle,
  Position,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStore } from "@/store/useStore";
import type { AgentRole, AgentStatus, SimulationDebate } from "@/types";

// ─── Custom Agent Node ───
interface AgentNodeData {
  label: string;
  role: string;
  status: AgentStatus;
  sentiment: number;
  argument: string;
  keyPoints: string[];
  signals: string[];
  [key: string]: unknown;
}

function AgentNode({ data }: { data: AgentNodeData }) {
  const status = data.status;
  const isActive = status === "running";
  const isDone = status === "done";

  const borderColor = isDone
    ? data.sentiment > 0.1 ? "#00d68f" : data.sentiment < -0.1 ? "#ff4d4d" : "#ff6b00"
    : isActive ? "#ff6b00" : "#26262e";

  const bgColor = isDone
    ? `${borderColor}15`
    : isActive ? "rgba(255,107,0,0.08)" : "#17171c";

  return (
    <div
      className={`rounded-lg shadow-lg transition-all ${isActive ? "animate-pulse" : ""}`}
      style={{
        background: bgColor,
        border: `2px solid ${borderColor}`,
        minWidth: 200,
        maxWidth: 280,
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: borderColor }} />
      <Handle type="source" position={Position.Right} style={{ background: borderColor }} />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${borderColor}33` }}>
        <div
          className="h-2.5 w-2.5 rounded-full shrink-0"
          style={{ background: isDone ? "#00d68f" : isActive ? "#ff6b00" : "#52525b" }}
        />
        <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "#f4f4f5" }}>
          {data.label}
        </span>
        {isDone && (
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[8px] font-bold"
            style={{
              background: data.sentiment > 0.1 ? "rgba(0,214,143,0.2)" : data.sentiment < -0.1 ? "rgba(255,77,77,0.2)" : "rgba(255,107,0,0.2)",
              color: data.sentiment > 0.1 ? "#00d68f" : data.sentiment < -0.1 ? "#ff4d4d" : "#ff6b00",
            }}
          >
            {data.sentiment > 0 ? "+" : ""}{(data.sentiment * 100).toFixed(0)}%
          </span>
        )}
      </div>

      {/* Body */}
      {isDone && (
        <div className="px-3 py-2 space-y-1.5">
          <p className="text-[10px] leading-relaxed line-clamp-3" style={{ color: "#a1a1aa" }}>
            {data.argument}
          </p>
          {data.keyPoints.length > 0 && (
            <ul className="space-y-0.5">
              {data.keyPoints.slice(0, 3).map((p, i) => (
                <li key={i} className="flex items-start gap-1 text-[9px]" style={{ color: "#71717a" }}>
                  <span style={{ color: "#ff6b00" }}>•</span>
                  <span className="line-clamp-1">{p}</span>
                </li>
              ))}
            </ul>
          )}
          {data.signals.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-0.5">
              {data.signals.slice(0, 4).map((s, i) => (
                <span
                  key={i}
                  className="rounded px-1 py-0.5 text-[7px] font-semibold"
                  style={{ background: "#222228", color: "#71717a", border: "1px solid #26262e" }}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pending/Running state */}
      {!isDone && (
        <div className="px-3 py-3 text-[10px]" style={{ color: isActive ? "#ff6b00" : "#52525b" }}>
          {isActive ? "Analyzing..." : "Waiting..."}
        </div>
      )}
    </div>
  );
}

// ─── Decision Node ───
function DecisionNode({ data }: { data: AgentNodeData & { decision?: string; confidence?: number; reasoning?: string } }) {
  const dec = data.decision;
  const conf = data.confidence ?? 0;
  const decColor = dec === "BUY" ? "#00d68f" : dec === "SELL" ? "#ff4d4d" : "#a1a1aa";

  return (
    <div
      className="rounded-lg shadow-lg"
      style={{
        background: dec ? `${decColor}15` : "#17171c",
        border: `2px solid ${dec ? decColor : "#26262e"}`,
        minWidth: 180,
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: decColor }} />
      <div className="px-3 py-2 text-center">
        <div className="text-[8px] font-bold uppercase tracking-widest mb-1" style={{ color: "#52525b" }}>
          Decision
        </div>
        {dec ? (
          <>
            <div
              className="text-lg font-black uppercase tracking-wider"
              style={{ color: decColor }}
            >
              {dec}
            </div>
            <div className="mt-1">
              <div className="h-1.5 rounded-full overflow-hidden mx-4" style={{ background: "#222228" }}>
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${conf * 100}%`, background: decColor }}
                />
              </div>
              <div className="text-[9px] font-mono mt-0.5" style={{ color: decColor }}>
                {Math.round(conf * 100)}% confidence
              </div>
            </div>
            {data.reasoning && (
              <p className="text-[9px] mt-1.5 leading-relaxed line-clamp-2" style={{ color: "#71717a" }}>
                {data.reasoning}
              </p>
            )}
          </>
        ) : (
          <div className="text-[10px] py-2" style={{ color: "#52525b" }}>
            Awaiting verdict...
          </div>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  agent: AgentNode,
  decision: DecisionNode,
};

// ─── Build nodes/edges from debate state ───
function buildGraph(debate: SimulationDebate | null): { nodes: Node[]; edges: Edge[] } {
  if (!debate) {
    return { nodes: [], edges: [] };
  }

  const roles = Object.keys(debate.agents) as AgentRole[];
  const agentCount = roles.length;

  // Layout: agents on the left in a vertical stack, decision on the right
  const spacing = 160;
  const startY = 0;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Agent nodes — vertical stack on left
  roles.forEach((role, i) => {
    const agent = debate.agents[role];
    nodes.push({
      id: role,
      type: "agent",
      position: { x: 0, y: startY + i * spacing },
      data: {
        label: agent.label,
        role: agent.role,
        status: agent.status,
        sentiment: agent.sentiment,
        argument: agent.argument,
        keyPoints: agent.keyPoints,
        signals: agent.signals,
      },
    });
  });

  // Decision node — right of all agents
  const decisionY = startY + ((agentCount - 1) * spacing) / 2;
  nodes.push({
    id: "decision",
    type: "decision",
    position: { x: 400, y: decisionY },
    data: {
      label: "Decision",
      role: "decision",
      status: debate.decision ? "done" : "pending",
      sentiment: 0,
      argument: "",
      keyPoints: [],
      signals: [],
      decision: debate.decision?.decision,
      confidence: debate.decision?.confidence,
      reasoning: debate.decision?.reasoning,
    },
  });

  // Edges: every agent → decision
  roles.forEach((role) => {
    edges.push({
      id: `${role}-decision`,
      source: role,
      target: "decision",
      animated: debate.agents[role].status === "running",
      style: {
        stroke: debate.agents[role].status === "done" ? "#ff6b00" : "#26262e",
        strokeWidth: 2,
      },
    });
  });

  return { nodes, edges };
}

export function DAGCanvas() {
  const debate = useStore((s) => s.currentDebate);

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraph(debate),
    [debate]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when debate changes
  useMemo(() => {
    const { nodes: n, edges: e } = buildGraph(debate);
    setNodes(n);
    setEdges(e);
  }, [debate, setNodes, setEdges]);

  if (!debate) {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: "#050507" }}>
        <div className="text-center space-y-2 px-6">
          <div className="text-4xl">🏛</div>
          <p className="text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>
            Committee Debate Canvas
          </p>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Run a simulation to see the agent debate DAG here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full" style={{ background: "#050507" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        defaultEdgeOptions={{ type: "smoothstep" }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1b1b21" />
        <Controls
          showInteractive={false}
          style={{ background: "#17171c", border: "1px solid #26262e", borderRadius: 8 }}
        />
        <MiniMap
          style={{ background: "#0d0d10", border: "1px solid #26262e" }}
          nodeColor={(n) => {
            const d = n.data as AgentNodeData;
            return d.status === "done" ? "#00d68f" : d.status === "running" ? "#ff6b00" : "#26262e";
          }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>
    </div>
  );
}
