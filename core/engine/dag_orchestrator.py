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
    IntelligenceGatherer,
    EntityGenerator,
    DiscussionAgent,
    CrossExaminer,
    ReACTReportAgent,
    SummaryAgent,
)


class DebateOrchestrator:
    """Runs the full MiroFish-inspired 5-stage swarm simulation."""

    # Max throughput mode: 30 rounds × 15 speakers = ~450 messages
    MAX_ROUNDS = 30
    SPEAKERS_PER_ROUND = 15

    def __init__(self) -> None:
        self.classifier = AssetClassifier()
        self.chart_support = ChartSupportAgent()
        self.context_analyzer = ContextAnalyzer()
        self.intelligence = IntelligenceGatherer()
        self.entity_gen = EntityGenerator()
        self.cross_examiner = CrossExaminer()
        self.report_agent = ReACTReportAgent()
        self.summary_agent = SummaryAgent()

    def _log(self, stage: str, msg: str) -> None:
        """Log pipeline progress with timestamp."""
        import time
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] [swarm.{stage}] {msg}", flush=True)

    async def run(
        self,
        bars: list[dict],
        symbol: str,
        report_text: str = "",
    ) -> Dict[str, Any]:
        """Execute the full 5-stage pipeline."""
        self._log("start", f"Debate starting for {symbol} — {len(bars)} bars")

        # ─── Stage 1: Context Analysis ───────────────────────────────────
        self._log("stage1", "Classifying asset + analyzing market context...")
        price_range = (
            min(b["low"] for b in bars) if bars else 0,
            max(b["high"] for b in bars) if bars else 0,
        )
        asset_info, context = await asyncio.gather(
            asyncio.to_thread(self.classifier.classify, symbol, price_range, len(bars)),
            asyncio.to_thread(self.context_analyzer.analyze, bars, symbol, report_text),
        )
        self._log("stage1", f"Asset: {asset_info.get('asset_name')} ({asset_info.get('asset_class')})")

        summaries = self.chart_support.prepare_multi_timeframe(bars, symbol)
        main_summary = summaries.get("daily", summaries.get("raw", "No data"))
        data_feeds = DataFeedBuilder.build_feeds(bars, symbol)
        self._log("stage1", f"Built {len(data_feeds)} data feeds: {list(data_feeds.keys())}")

        # ─── Stage 1.5: Intelligence Gathering ───────────────────────────
        asset_name = asset_info.get("asset_name", symbol)
        asset_class = asset_info.get("asset_class", "unknown")
        self._log("stage1.5", f"Gathering intelligence for {asset_name} (web search + indicators)...")
        intel_briefing = await asyncio.to_thread(
            self.intelligence.gather, asset_name, asset_class, bars
        )
        raw = intel_briefing.get("raw_findings", {})
        self._log("stage1.5", f"Intel done. Bull: {len(intel_briefing.get('bull_case', []))}, Bear: {len(intel_briefing.get('bear_case', []))}, News: {'yes' if raw.get('recent_news') else 'no'}")

        # Merge context into a rich knowledge base for all agents
        knowledge = {
            "asset_info": asset_info,
            "context": context,
            "market_summary": main_summary,
            "data_feeds": data_feeds,
            "intel_briefing": intel_briefing,
            "report_text": report_text,
        }

        # Format the briefing as text for injection into agent prompts
        briefing_text = self._format_briefing(intel_briefing)

        # ─── Stage 2: Persona Generation ─────────────────────────────────
        self._log("stage2", f"Generating personas (target: {self.entity_gen.TARGET_ENTITIES})...")
        entities = await asyncio.to_thread(
            self.entity_gen.generate, asset_info, main_summary, report_text
        )
        # Count specializations for logging
        specs: Dict[str, int] = {}
        for e in entities:
            specs[e.get("specialization", "general")] = specs.get(e.get("specialization", "general"), 0) + 1
        self._log("stage2", f"Got {len(entities)} personas. Specs: {specs}")

        # ─── Stage 3: Multi-Round Debate with Memory ─────────────────────
        thread: List[Dict[str, Any]] = []
        thread_text = ""
        n_entities = len(entities)
        sentiments_by_round: List[float] = []
        # Per-agent memory: tracks each agent's own previous statements
        agent_memory: Dict[str, List[str]] = {e.get("id", f"a{i}"): [] for i, e in enumerate(entities)}

        self._log("stage3", f"Starting debate: up to {self.MAX_ROUNDS} rounds x {self.SPEAKERS_PER_ROUND} speakers = max {self.MAX_ROUNDS * self.SPEAKERS_PER_ROUND} messages")
        for round_num in range(1, self.MAX_ROUNDS + 1):
            self._log("stage3", f"Round {round_num}/{self.MAX_ROUNDS} — {len(thread)} messages so far")
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

                # Execute agent-specific tools before they speak. Web tools
                # go through a global rate limiter + retry/fallback; local
                # tools (indicators, levels) are fast and pure Python.
                tool_results_text = ""
                tool_calls_log: Dict[str, str] = {}  # tool_name -> short result
                agent_tools = entity.get("tools", [])
                if agent_tools and round_num <= 3:  # Tools only in first 3 rounds
                    from core.agents.swarm_tools import execute_tool
                    tool_outputs = []
                    local_tools = [t for t in agent_tools if t in ("run_indicator", "compute_levels")]
                    web_tools = [t for t in agent_tools if t.startswith(("web_", "fetch_"))]
                    for tool_name in local_tools[:2] + web_tools[:1]:
                        try:
                            result = execute_tool(tool_name, bars, asset_info.get("asset_name", symbol))
                            if result and len(result) > 20:
                                tool_outputs.append(f"[{tool_name}]: {result[:1500]}")
                                tool_calls_log[tool_name] = result[:500]  # Short summary for UI
                        except Exception as e:
                            tool_outputs.append(f"[{tool_name}]: error — {str(e)[:100]}")
                            tool_calls_log[tool_name] = f"Error: {str(e)[:200]}"
                    if tool_outputs:
                        tool_results_text = "\n\n## Your research findings:\n" + "\n".join(tool_outputs)

                # Combine: general summary + specialization data + briefing + tools + memory
                full_market = main_summary + "\n\n" + spec_data
                full_market += f"\n\n## Intelligence Briefing:\n{briefing_text[:2000]}"
                full_market += tool_results_text + memory_text

                agents_with_context.append((entity, relevant_thread, full_market, tool_calls_log))

            # All speakers run in parallel
            agents = [DiscussionAgent(e, asset_info) for e, _, _, _ in agents_with_context]
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
            for (entity, _, _, tool_log), result in zip(agents_with_context, results):
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
                    "tools_used": list(tool_log.keys()),
                    "tool_results": tool_log,
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
                if spread < 0.05:  # Tight convergence required
                    break

        self._log("stage3", f"Debate complete after round {round_num}. Total messages: {len(thread)}")

        # ─── Stage 4: Cross-Examination ──────────────────────────────────
        self._log("stage4", "Running cross-examination on most divergent agents...")
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

        self._log("stage4", f"Cross-exam done. {len(cross_exam_results)} agents responded.")

        # ─── Stage 5: ReACT Report Generation ───────────────────────────
        self._log("stage5", "Generating ReACT report (deep analysis + interviews + verification)...")
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

        self._log("stage5", f"Report done. Consensus: {summary.get('consensus_direction')} ({summary.get('confidence')}%)")
        self._log("complete", f"Pipeline done. {len(entities)} agents, {round_num} rounds, {len(thread)} messages.")

        return {
            "asset_info": asset_info,
            "entities": entities,
            "thread": thread,
            "total_rounds": round_num + (1 if cross_exam_results else 0),
            "summary": summary,
            "intel_briefing": intel_briefing,       # Include for UI display
            "cross_exam_results": cross_exam_results,  # Include for UI display
        }

    def _format_briefing(self, briefing: dict) -> str:
        """Format the intelligence briefing as readable text for agent prompts."""
        parts = []
        summary = briefing.get("executive_summary", "")
        if summary:
            parts.append(f"Summary: {summary}")
        bull = briefing.get("bull_case", [])
        if bull:
            parts.append("Bull case: " + "; ".join(bull[:3]))
        bear = briefing.get("bear_case", [])
        if bear:
            parts.append("Bear case: " + "; ".join(bear[:3]))
        events = briefing.get("key_events", [])
        if events:
            parts.append("Upcoming events: " + "; ".join(events[:3]))
        sentiment = briefing.get("sentiment_reading", "")
        if sentiment:
            parts.append(f"Market sentiment: {sentiment}")
        data_points = briefing.get("data_points", [])
        if data_points:
            parts.append("Key data: " + "; ".join(data_points[:5]))
        return "\n".join(parts) if parts else "No briefing available."

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
