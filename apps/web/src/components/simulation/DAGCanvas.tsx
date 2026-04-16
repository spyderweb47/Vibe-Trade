"use client";

import { useMemo, useRef, useEffect } from "react";
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
import type { SimulationDebate, DiscussionMessage } from "@/types";

// ─── Entity Node (circular layout) ───
interface EntityNodeData {
  name: string;
  role: string;
  bias: string;
  sentiment: number;
  messageCount: number;
  isActive: boolean;
  [key: string]: unknown;
}

function EntityNode({ data }: { data: EntityNodeData }) {
  const biasColor = data.bias?.includes("bull") ? "#00d68f"
    : data.bias?.includes("bear") ? "#ff4d4d"
    : "#ff6b00";

  const borderColor = data.isActive ? "#ff6b00" : data.messageCount > 0 ? biasColor : "#26262e";

  return (
    <div
      className={`rounded-lg transition-all ${data.isActive ? "animate-pulse" : ""}`}
      style={{
        background: data.messageCount > 0 ? `${borderColor}12` : "#17171c",
        border: `2px solid ${borderColor}`,
        width: 140,
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: borderColor, width: 6, height: 6 }} />
      <Handle type="source" position={Position.Right} style={{ background: borderColor, width: 6, height: 6 }} />
      <div className="px-2 py-1.5 text-center">
        <div className="text-[10px] font-bold truncate" style={{ color: "#f4f4f5" }}>
          {data.name}
        </div>
        <div className="text-[8px] truncate" style={{ color: "#71717a" }}>
          {data.role}
        </div>
        {data.messageCount > 0 && (
          <div className="mt-0.5 text-[7px] font-mono" style={{ color: biasColor }}>
            {data.sentiment > 0 ? "+" : ""}{(data.sentiment * 100).toFixed(0)}%
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Status Node (center) ───
function StatusNode({ data }: { data: { status: string; round: number; total: number; [key: string]: unknown } }) {
  const statusText: Record<string, string> = {
    idle: "Ready",
    classifying: "Classifying Asset...",
    generating_entities: "Creating Personas...",
    discussing: `Round ${data.round}/${data.total}`,
    summarizing: "Summarizing...",
    complete: "Complete",
    error: "Error",
  };

  return (
    <div
      className="rounded-xl text-center"
      style={{
        background: data.status === "complete" ? "rgba(0,214,143,0.1)" : "rgba(255,107,0,0.1)",
        border: `2px solid ${data.status === "complete" ? "#00d68f" : data.status === "error" ? "#ff4d4d" : "#ff6b00"}`,
        width: 160,
        padding: "12px 8px",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: "hidden" }} />
      <Handle type="source" position={Position.Right} style={{ visibility: "hidden" }} />
      <div className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#52525b" }}>
        Discussion
      </div>
      <div className="text-[11px] font-bold mt-0.5" style={{ color: data.status === "complete" ? "#00d68f" : "#ff6b00" }}>
        {statusText[data.status] || data.status}
      </div>
    </div>
  );
}

// ─── Summary Node ───
function SummaryNode({ data }: { data: { direction?: string; confidence?: number; [key: string]: unknown } }) {
  const dir = data.direction;
  const color = dir === "BULLISH" ? "#00d68f" : dir === "BEARISH" ? "#ff4d4d" : "#a1a1aa";

  return (
    <div
      className="rounded-lg text-center"
      style={{
        background: dir ? `${color}15` : "#17171c",
        border: `2px solid ${dir ? color : "#26262e"}`,
        width: 150,
        padding: "10px 8px",
        fontFamily: "Inter, sans-serif",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color, width: 6, height: 6 }} />
      {dir ? (
        <>
          <div className="text-[8px] font-bold uppercase tracking-widest" style={{ color: "#52525b" }}>Verdict</div>
          <div className="text-lg font-black uppercase" style={{ color }}>{dir}</div>
          <div className="text-[9px] font-mono" style={{ color }}>
            {Math.round((data.confidence || 0) * 100)}% confidence
          </div>
        </>
      ) : (
        <div className="text-[10px] py-2" style={{ color: "#52525b" }}>Awaiting verdict...</div>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  entity: EntityNode,
  status: StatusNode,
  summary: SummaryNode,
};

// ─── Build graph from debate state ───
function buildGraph(debate: SimulationDebate | null): { nodes: Node[]; edges: Edge[] } {
  if (!debate || debate.entities.length === 0) {
    return { nodes: [], edges: [] };
  }

  const entities = debate.entities;
  const n = entities.length;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Circular layout for entity nodes
  const cx = 400, cy = 350, radius = 300;
  entities.forEach((e, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    const x = cx + radius * Math.cos(angle) - 70;
    const y = cy + radius * Math.sin(angle) - 20;

    const msgs = debate.thread.filter((m) => m.entityId === e.id);
    const avgSentiment = msgs.length > 0 ? msgs.reduce((s, m) => s + m.sentiment, 0) / msgs.length : 0;
    const isActive = debate.status === "discussing" && debate.currentRound > 0;

    nodes.push({
      id: e.id,
      type: "entity",
      position: { x, y },
      data: {
        name: e.name,
        role: e.role,
        bias: e.bias,
        sentiment: avgSentiment,
        messageCount: msgs.length,
        isActive: isActive && msgs.length > 0 && msgs[msgs.length - 1].round === debate.currentRound,
      },
    });

    // Edge from entity to center
    edges.push({
      id: `${e.id}-center`,
      source: e.id,
      target: "center",
      style: { stroke: msgs.length > 0 ? "#ff6b0044" : "#26262e", strokeWidth: 1 },
      type: "smoothstep",
    });
  });

  // Center status node
  nodes.push({
    id: "center",
    type: "status",
    position: { x: cx - 80, y: cy - 30 },
    data: { status: debate.status, round: debate.currentRound, total: debate.totalRounds },
  });

  // Summary node (right of center)
  nodes.push({
    id: "summary",
    type: "summary",
    position: { x: cx + 220, y: cy - 30 },
    data: {
      direction: debate.summary?.consensusDirection,
      confidence: debate.summary?.confidence,
    },
  });
  edges.push({
    id: "center-summary",
    source: "center",
    target: "summary",
    style: { stroke: debate.summary ? "#00d68f" : "#26262e", strokeWidth: 2 },
    type: "smoothstep",
    animated: debate.status === "summarizing",
  });

  // Agree/disagree edges between entities
  for (const msg of debate.thread) {
    for (const name of msg.agreedWith || []) {
      const target = entities.find((e) => e.name === name);
      if (target) {
        edges.push({
          id: `agree-${msg.id}-${target.id}`,
          source: msg.entityId,
          target: target.id,
          style: { stroke: "#00d68f33", strokeWidth: 1 },
          type: "smoothstep",
        });
      }
    }
    for (const name of msg.disagreedWith || []) {
      const target = entities.find((e) => e.name === name);
      if (target) {
        edges.push({
          id: `disagree-${msg.id}-${target.id}`,
          source: msg.entityId,
          target: target.id,
          style: { stroke: "#ff4d4d33", strokeWidth: 1, strokeDasharray: "4 2" },
          type: "smoothstep",
        });
      }
    }
  }

  return { nodes, edges };
}

export function DAGCanvas() {
  const debate = useStore((s) => s.currentDebate);
  const { nodes: graphNodes, edges: graphEdges } = useMemo(() => buildGraph(debate), [debate]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graphNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graphEdges);

  useMemo(() => {
    setNodes(graphNodes);
    setEdges(graphEdges);
  }, [graphNodes, graphEdges, setNodes, setEdges]);


  if (!debate || debate.status === "idle") {
    return (
      <div className="flex items-center justify-center h-full" style={{ background: "#050507" }}>
        <div className="text-center space-y-2 px-6">
          <div className="text-4xl">🏛</div>
          <p className="text-[12px] font-semibold" style={{ color: "var(--text-secondary)" }}>Social Simulation Engine</p>
          <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            Run a simulation to see 20-30 AI entities debate price predictions.
          </p>
        </div>
      </div>
    );
  }

  const hasEntities = debate.entities.length > 0;

  return (
    <div className="flex flex-col h-full" style={{ background: "#050507" }}>
      {/* DAG Canvas — full height (thread moved to dedicated Debate Thread tab) */}
      <div className="flex-1 min-h-0">
        {hasEntities ? (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.15 }}
            minZoom={0.2}
            maxZoom={2}
            defaultEdgeOptions={{ type: "smoothstep" }}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#1b1b21" />
            <Controls
              showInteractive={false}
              style={{ background: "#17171c", border: "1px solid #26262e", borderRadius: 8 }}
              className="dag-controls"
            />
            <MiniMap
              style={{ background: "#0d0d10", border: "1px solid #26262e" }}
              nodeColor={() => "#ff6b00"}
              maskColor="rgba(0,0,0,0.7)"
            />
          </ReactFlow>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-[11px] animate-pulse" style={{ color: "var(--accent)" }}>
              {debate.status === "classifying" ? "Classifying asset..." : "Generating entities..."}
            </div>
          </div>
        )}
      </div>

      {/* Discussion thread removed — now in the dedicated Debate Thread tab */}
    </div>
  );
}
