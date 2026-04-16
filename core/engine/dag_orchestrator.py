"""
Swarm Intelligence Orchestrator — MiroFish-inspired 5-stage pipeline.

Pipeline:
  Stage 1: CONTEXT ANALYSIS
    Extract key themes, entities, price levels, market regime, and
    relationships from the OHLC data + user-provided context. Builds a
    structured "knowledge context" that feeds all subsequent stages.

  Stage 2: PERSONA GENERATION
    Generate 20-30 rich personas with explicit stances (bull/bear/neutral/
    observer), influence weights (0.5-3.0), and specialization areas.
    Observer agents fact-check rather than argue.

  Stage 3: MULTI-ROUND DEBATE WITH MEMORY
    Each agent maintains a personal memory of their own previous positions.
    Selective information routing: agents see messages most relevant to
    their specialization. Agents reference specific data points and price
    levels, not generic statements.

  Stage 4: CROSS-EXAMINATION
    After the main debate, the synthesis engine picks 3-5 key agents with
    the most divergent views and asks pointed follow-up questions. Forces
    agents to defend their thesis against specific counterarguments.

  Stage 5: ReACT REPORT GENERATION
    Multi-step report with tools: deep thread analysis, agent interviews,
    fact verification against the original data. Minimum 3 tool calls per
    section. Output is a professional investment research note with cited
    evidence from specific agents.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List

from core.agents.simulation_agents import (
    AssetClassifier,
    ChartSupportAgent,
    ContextAnalyzer,
    DataFeedBuilder,
    EntityGenerator,
    DiscussionAgent,
    CrossExaminer,
    ReACTReportAgent,
    SummaryAgent,
)


class DebateOrchestrator:
    """Runs the full MiroFish-inspired 5-stage swarm simulation."""

    MAX_ROUNDS = 30
    SPEAKERS_PER_ROUND = 15

    def __init__(self) -> None:
        self.classifier = AssetClassifier()
        self.chart_support = ChartSupportAgent()
        self.context_analyzer = ContextAnalyzer()
        self.entity_gen = EntityGenerator()
        self.cross_examiner = CrossExaminer()
        self.report_agent = ReACTReportAgent()
        self.summary_agent = SummaryAgent()

    async def run(
        self,
        bars: list[dict],
        symbol: str,
        report_text: str = "",
    ) -> Dict[str, Any]:
        """Execute the full 5-stage pipeline."""

        # ─── Stage 1: Context Analysis ───────────────────────────────────
        # Extract structured knowledge from the data: asset classification,
        # key themes, price levels, technical regime, market structure.
        price_range = (
            min(b["low"] for b in bars) if bars else 0,
            max(b["high"] for b in bars) if bars else 0,
        )
        # Run classification + context analysis in parallel
        asset_info, context = await asyncio.gather(
            asyncio.to_thread(self.classifier.classify, symbol, price_range, len(bars)),
            asyncio.to_thread(self.context_analyzer.analyze, bars, symbol, report_text),
        )

        # Prepare multi-timeframe data summaries
        summaries = self.chart_support.prepare_multi_timeframe(bars, symbol)
        main_summary = summaries.get("daily", summaries.get("raw", "No data"))

        # Build rich, specialization-specific data feeds from raw bars
        data_feeds = DataFeedBuilder.build_feeds(bars, symbol)

        # Merge context into a rich knowledge base for all agents
        knowledge = {
            "asset_info": asset_info,
            "context": context,
            "market_summary": main_summary,
            "data_feeds": data_feeds,
            "report_text": report_text,
        }

        # ─── Stage 2: Persona Generation ─────────────────────────────────
        # Generate personas with explicit stances, influence weights, and
        # specialization areas. Includes 2-3 observer agents.
        entities = await asyncio.to_thread(
            self.entity_gen.generate, asset_info, main_summary, report_text
        )
        # No cap — maximum throughput, all generated personas participate

        # ─── Stage 3: Multi-Round Debate with Memory ─────────────────────
        thread: List[Dict[str, Any]] = []
        thread_text = ""
        n_entities = len(entities)
        sentiments_by_round: List[float] = []
        # Per-agent memory: tracks each agent's own previous statements
        agent_memory: Dict[str, List[str]] = {e.get("id", f"a{i}"): [] for i, e in enumerate(entities)}

        for round_num in range(1, self.MAX_ROUNDS + 1):
            # Rotate speakers through all entities
            start_idx = ((round_num - 1) * self.SPEAKERS_PER_ROUND) % n_entities
            speaker_indices = [(start_idx + j) % n_entities for j in range(self.SPEAKERS_PER_ROUND)]
            speakers = [entities[i] for i in speaker_indices]

            # Build per-agent context: personal memory + relevant thread + specialization data
            agents_with_context = []
            for entity in speakers:
                eid = entity.get("id", "unknown")
                role = entity.get("role", "").lower()
                name = entity.get("name", "")
                spec = entity.get("specialization", "general")

                # Selective routing: show messages from related roles + mentions
                relevant_thread = self._filter_thread_for_agent(thread, name, role, max_chars=6000)

                # Personal memory of own previous positions
                own_memory = agent_memory.get(eid, [])
                memory_text = ""
                if own_memory:
                    memory_text = f"\n## Your previous positions:\n" + "\n".join(
                        f"- Round {i+1}: {m}" for i, m in enumerate(own_memory)
                    )

                # Route specialization-specific data feed
                feed_map = {
                    "technical": "technical",
                    "quant": "quant",
                    "macro": "macro",
                    "fundamental": "structure",
                    "industry": "structure",
                    "sentiment": "volume",
                    "geopolitical": "macro",
                }
                feed_key = feed_map.get(spec, "general")
                spec_data = data_feeds.get(feed_key, data_feeds.get("general", ""))

                # Combine: general summary + specialization data + memory
                full_market = main_summary + "\n\n" + spec_data + memory_text

                agents_with_context.append((entity, relevant_thread, full_market))

            # All speakers run in parallel
            agents = [DiscussionAgent(e, asset_info) for e, _, _ in agents_with_context]
            results = await asyncio.gather(
                *[asyncio.to_thread(
                    a.speak,
                    ctx[2],                  # full market context (summary + spec data + memory)
                    ctx[1],                  # filtered thread
                    report_text[:600],
                    round_num,
                ) for a, ctx in zip(agents, agents_with_context)]
            )

            # Append to thread + update agent memory
            round_sentiments = []
            for (entity, _, _), result in zip(agents_with_context, results):
                eid = entity.get("id", "unknown")
                content = result.get("content", "")
                msg = {
                    "id": str(uuid.uuid4()),
                    "round": round_num,
                    "entity_id": eid,
                    "entity_name": entity.get("name") or entity.get("label", "Unknown"),
                    "entity_role": entity.get("role") or entity.get("label", "Analyst"),
                    "content": content,
                    "sentiment": float(result.get("sentiment", 0)),
                    "price_prediction": result.get("price_prediction"),
                    "agreed_with": result.get("agreed_with", []),
                    "disagreed_with": result.get("disagreed_with", []),
                    "is_chart_support": False,
                    "data_request": result.get("data_request"),
                    "influence": float(entity.get("influence", 1.0)),
                    "stance": entity.get("stance", "neutral"),
                }
                thread.append(msg)
                round_sentiments.append(msg["sentiment"] * msg["influence"])

                # Update personal memory (keep last 5 positions)
                summary = content[:200] + ("..." if len(content) > 200 else "")
                if eid in agent_memory:
                    agent_memory[eid].append(summary)
                    agent_memory[eid] = agent_memory[eid][-5:]

            thread_text = self._build_thread_text(thread)

            # Handle data requests
            for msg in thread:
                if msg["round"] == round_num and msg.get("data_request"):
                    injected = self.chart_support.handle_data_request(
                        msg["data_request"], bars, symbol
                    )
                    if injected:
                        chart_msg = {
                            "id": str(uuid.uuid4()),
                            "round": round_num,
                            "entity_id": "chart_support",
                            "entity_name": "Chart Support",
                            "entity_role": "Data Agent",
                            "content": f"[Data requested by {msg['entity_name']}]\n{injected}",
                            "sentiment": 0,
                            "price_prediction": None,
                            "agreed_with": [],
                            "disagreed_with": [],
                            "is_chart_support": True,
                            "data_request": None,
                            "influence": 0,
                            "stance": "neutral",
                        }
                        thread.append(chart_msg)
                        thread_text = self._build_thread_text(thread)

            # Convergence check (influence-weighted)
            total_influence = sum(abs(s) for s in round_sentiments) or 1
            weighted_avg = sum(round_sentiments) / total_influence
            sentiments_by_round.append(weighted_avg)

            if round_num >= 20 and len(sentiments_by_round) >= 5:
                recent = sentiments_by_round[-5:]
                spread = max(recent) - min(recent)
                if spread < 0.05:  # Very tight convergence required
                    break

        # ─── Stage 4: Cross-Examination ──────────────────────────────────
        # Pick the most divergent agents and force them to defend their views
        cross_exam_results = await asyncio.to_thread(
            self.cross_examiner.examine,
            thread,
            entities,
            asset_info,
            main_summary,
        )
        # Add cross-examination messages to the thread
        for msg in cross_exam_results:
            msg["round"] = round_num + 1  # Mark as the cross-exam round
            thread.append(msg)
        if cross_exam_results:
            thread_text = self._build_thread_text(thread)

        # ─── Stage 5: ReACT Report Generation ───────────────────────────
        # Multi-step report with tools: deep analysis, interviews, citations.
        # Pass ALL data feeds so the report can verify claims against raw data.
        summary = await asyncio.to_thread(
            self.report_agent.generate_report,
            thread_text,
            thread,
            entities,
            asset_info,
            knowledge,
            entity_count=len(entities),
            round_count=round_num + (1 if cross_exam_results else 0),
            message_count=len(thread),
        )

        return {
            "asset_info": asset_info,
            "entities": entities,
            "thread": thread,
            "total_rounds": round_num + (1 if cross_exam_results else 0),
            "summary": summary,
        }

    def _filter_thread_for_agent(
        self, thread: List[Dict], agent_name: str, agent_role: str, max_chars: int = 4000
    ) -> str:
        """
        Selective information routing: instead of showing the full thread,
        prioritize messages that are most relevant to this agent:
        1. Messages that mention this agent by name
        2. Messages from agents with overlapping specialization
        3. Recent messages (last 2 rounds)
        4. High-influence messages
        """
        if not thread:
            return ""

        scored: List[tuple[float, Dict]] = []
        last_round = max(m["round"] for m in thread)

        role_keywords = set(agent_role.lower().split())

        for msg in thread:
            score = 0.0
            # Mentioned by name → highest priority
            if agent_name.lower() in msg.get("content", "").lower():
                score += 10.0
            # Overlapping role keywords
            msg_role = msg.get("entity_role", "").lower()
            overlap = len(role_keywords & set(msg_role.split()))
            score += overlap * 2.0
            # Recency bonus
            rounds_ago = last_round - msg["round"]
            score += max(0, 3.0 - rounds_ago * 0.5)
            # Influence bonus
            score += float(msg.get("influence", 1.0)) * 0.5
            scored.append((score, msg))

        # Sort by score descending, take top messages within char limit
        scored.sort(key=lambda x: -x[0])
        lines = []
        chars = 0
        for _, msg in scored:
            line = f"{msg['entity_name']} ({msg['entity_role']}, R{msg['round']}): {msg['content']}"
            if chars + len(line) > max_chars:
                break
            lines.append(line)
            chars += len(line)

        return "\n".join(lines) if lines else ""

    def _build_thread_text(self, thread: List[Dict]) -> str:
        lines = []
        current_round = 0
        for msg in thread:
            if msg["round"] != current_round:
                current_round = msg["round"]
                lines.append(f"\n--- Round {current_round} ---")
            if msg.get("is_chart_support"):
                lines.append(f"[Chart Support]: {msg['content']}")
            else:
                influence = msg.get("influence", 1.0)
                stance = msg.get("stance", "")
                tag = f" [{stance}]" if stance and stance != "neutral" else ""
                lines.append(f"{msg['entity_name']} ({msg['entity_role']}{tag}, influence={influence:.1f}): {msg['content']}")
        return "\n".join(lines)
