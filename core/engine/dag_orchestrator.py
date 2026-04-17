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
    IterativeResearcher,
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
        self.researcher = IterativeResearcher()
        self.entity_gen = EntityGenerator()
        self.cross_examiner = CrossExaminer()
        self.report_agent = ReACTReportAgent()
        self.summary_agent = SummaryAgent()
        # Run-level events we want to surface to the end user in the UI
        # (timeouts, errors, partial-failure warnings). Distinct from the
        # chatty _log() progress lines, which stay server-side.
        self.run_events: List[Dict[str, Any]] = []

    def _log(self, stage: str, msg: str) -> None:
        """Log pipeline progress with timestamp (server console only)."""
        import time
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] [swarm.{stage}] {msg}", flush=True)

    def _event(self, level: str, stage: str, msg: str) -> None:
        """
        Record a user-visible event AND log it. `level` is one of
        'info', 'warn', 'error'. Events are surfaced to the frontend
        via the /debate response so the user can see what happened
        without reading server logs.
        """
        import time
        ts_human = time.strftime("%H:%M:%S")
        ts_iso = time.strftime("%Y-%m-%dT%H:%M:%S")
        prefix = {"info": "i", "warn": "!", "error": "x"}.get(level, "-")
        print(f"[{ts_human}] [swarm.{stage}] {prefix} {msg}", flush=True)
        self.run_events.append({
            "timestamp": ts_iso,
            "level": level,
            "stage": stage,
            "message": msg,
        })

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

        # ─── Stage 2.5: Iterative Agent Research ───────────────────────────
        # Each agent with web tools plans their OWN research queries (up to 4
        # iterations each). This runs once before the debate — findings are
        # cached and injected into their debate prompts.
        self._log("stage2.5", f"Starting iterative research phase for {n_entities} agents...")
        agent_research: Dict[str, dict] = {}

        # Run research in parallel (10 agents at a time to avoid overwhelming
        # the rate limiter)
        import itertools
        research_entities = [e for e in entities if any(t.startswith(("web_", "fetch_")) for t in e.get("tools", []))]
        self._log("stage2.5", f"{len(research_entities)}/{n_entities} agents have web tools — running research")

        batch_size = 10
        for batch_start in range(0, len(research_entities), batch_size):
            batch = research_entities[batch_start:batch_start + batch_size]
            results = await asyncio.gather(
                *[asyncio.to_thread(self.researcher.research, e, asset_info, main_summary) for e in batch],
                return_exceptions=True,
            )
            for entity, res in zip(batch, results):
                eid = entity.get("id", "unknown")
                if isinstance(res, dict) and res.get("findings"):
                    agent_research[eid] = res
                    self._log("stage2.5", f"  {entity.get('name')}: {res['total_iterations']} queries")
            # Progress log
            done = min(batch_start + batch_size, len(research_entities))
            self._log("stage2.5", f"Research progress: {done}/{len(research_entities)} agents")

        total_queries = sum(r.get("total_iterations", 0) for r in agent_research.values())
        self._log("stage2.5", f"Research complete: {len(agent_research)} agents did {total_queries} total queries")

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

                # Selective routing: show messages from related roles + mentions.
                # Cap the thread we score to the last 4 rounds worth of messages —
                # by round 20 the full thread is 300+ messages, and _filter_thread
                # iterates the whole list for every one of 15 speakers per round
                # (O(messages × speakers × rounds) which grows quadratically).
                # Only recent messages carry debate state anyway.
                recent_cap = self.SPEAKERS_PER_ROUND * 4 + 10  # ~70 messages
                thread_window = thread[-recent_cap:] if len(thread) > recent_cap else thread
                relevant_thread = self._filter_thread_for_agent(thread_window, name, role, max_chars=6000)

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

                # Inject iterative research findings (done in Stage 2.5)
                # plus any local tool results (indicators, levels for tech agents).
                tool_results_text = ""
                tool_calls_log: Dict[str, str] = {}  # tool_name -> short result
                agent_tools = entity.get("tools", [])

                # 1. Iterative research findings (already done pre-debate) — only in round 1
                if round_num == 1 and eid in agent_research:
                    research = agent_research[eid]
                    tool_results_text += "\n\n" + research["summary"]
                    # Log each query as a separate "tool call" for UI
                    for f in research["findings"]:
                        tool_name = f"{f['tool']}[q{f['iteration']}]"
                        tool_calls_log[tool_name] = f"Query: {f['query']}\nReasoning: {f['reasoning']}\n{f['result'][:500]}"

                # 2. Local tools (run_indicator, compute_levels) — only in round 1 for quant/tech agents
                if agent_tools and round_num == 1:
                    from core.agents.swarm_tools import execute_tool
                    local_tools = [t for t in agent_tools if t in ("run_indicator", "compute_levels")]
                    local_outputs = []
                    for tool_name in local_tools[:2]:
                        try:
                            result = execute_tool(tool_name, bars, asset_info.get("asset_name", symbol))
                            if result and len(result) > 20:
                                local_outputs.append(f"[{tool_name}]: {result[:1500]}")
                                tool_calls_log[tool_name] = result[:500]
                        except Exception as e:
                            tool_calls_log[tool_name] = f"Error: {str(e)[:200]}"
                    if local_outputs:
                        tool_results_text += "\n\n## Local analysis:\n" + "\n".join(local_outputs)

                # Combine: general summary + specialization data + briefing + tools + memory
                full_market = main_summary + "\n\n" + spec_data
                full_market += f"\n\n## Intelligence Briefing:\n{briefing_text[:2000]}"
                full_market += tool_results_text + memory_text

                agents_with_context.append((entity, relevant_thread, full_market, tool_calls_log))

            # All speakers run in parallel. Each speak() call can make 1+ LLM
            # requests; the LLM client already has per-request timeouts + retries,
            # but we ALSO wrap each agent task in asyncio.wait_for so that one
            # slow / stuck speaker cannot freeze the whole round (which in turn
            # would freeze the whole debate because rounds run sequentially).
            # On timeout the agent is treated as a no-show for this round.
            agents = [DiscussionAgent(e, asset_info) for e, _, _, _ in agents_with_context]

            # 3x the single-call budget — a speak() may chain multiple LLM calls
            # (tool use, reflection) and we want to tolerate a retry or two.
            per_speaker_timeout = 180.0

            async def _run_speaker(
                agent: DiscussionAgent,
                ctx: Any,
            ) -> Dict[str, Any]:
                try:
                    return await asyncio.wait_for(
                        asyncio.to_thread(
                            agent.speak,
                            ctx[2],        # full market context
                            ctx[1],        # filtered thread
                            report_text[:600],
                            round_num,
                        ),
                        timeout=per_speaker_timeout,
                    )
                except asyncio.TimeoutError:
                    entity = ctx[0]
                    self._event(
                        "warn",
                        "stage3",
                        f"{entity.get('name', 'unknown')} (round {round_num}) "
                        f"timed out after {per_speaker_timeout:.0f}s — "
                        "skipped. LLM provider may be slow or rate-limiting.",
                    )
                    return {
                        "content": "(agent timed out this round)",
                        "sentiment": 0.0,
                        "price_prediction": None,
                        "agreed_with": [],
                        "disagreed_with": [],
                        "_timed_out": True,
                    }
                except Exception as err:  # noqa: BLE001
                    entity = ctx[0]
                    self._event(
                        "warn",
                        "stage3",
                        f"{entity.get('name', 'unknown')} (round {round_num}) "
                        f"failed: {type(err).__name__}: {str(err)[:180]}",
                    )
                    return {
                        "content": f"(agent error: {type(err).__name__})",
                        "sentiment": 0.0,
                        "price_prediction": None,
                        "agreed_with": [],
                        "disagreed_with": [],
                        "_errored": True,
                    }

            results = await asyncio.gather(
                *[_run_speaker(a, ctx) for a, ctx in zip(agents, agents_with_context)]
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
        cross_exam_results: List[Dict[str, Any]] = []
        try:
            cross_exam_results = await asyncio.wait_for(
                asyncio.to_thread(
                    self.cross_examiner.examine,
                    thread,
                    entities,
                    asset_info,
                    main_summary,
                ),
                timeout=300.0,
            )
        except asyncio.TimeoutError:
            self._event(
                "warn",
                "stage4",
                "Cross-examination timed out after 5 minutes — "
                "continuing without it. Divergent-agent Q&A will be missing from the report.",
            )
        except Exception as err:  # noqa: BLE001
            self._event(
                "warn",
                "stage4",
                f"Cross-examination failed: {type(err).__name__}: {str(err)[:180]} "
                "— continuing without it.",
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
        summary: Dict[str, Any]
        # Outer ceiling: 8 min is enough for a 4500-token report across all
        # supported providers (50-100 tok/s = 45-90s) with one retry buffer.
        # The LLM client itself handles per-request timeouts + retries; this
        # wait_for is the last-resort fuse.
        try:
            summary = await asyncio.wait_for(
                asyncio.to_thread(
                    self.report_agent.generate_report,
                    thread_text,
                    thread,
                    entities,
                    asset_info,
                    knowledge,
                    entity_count=len(entities),
                    round_count=round_num + (1 if cross_exam_results else 0),
                    message_count=len(thread),
                ),
                timeout=480.0,
            )
        except asyncio.TimeoutError:
            self._event(
                "error",
                "stage5",
                "Report generation timed out after 8 minutes. "
                "Falling back to a summary extracted directly from the debate thread.",
            )
            summary = self._fallback_summary_from_thread(thread, entities, bars, "timeout")
        except Exception as err:  # noqa: BLE001
            self._event(
                "error",
                "stage5",
                f"Report generation failed: {type(err).__name__}: {str(err)[:180]}. "
                "Falling back to a summary extracted from the debate thread.",
            )
            summary = self._fallback_summary_from_thread(thread, entities, bars, str(err)[:120])

        self._log("stage5", f"Report done. LLM said: {summary.get('consensus_direction')} ({summary.get('confidence')}%)")

        # ─── Ground-truth consensus computed from actual thread sentiment ───
        # The LLM tends to copy the example values from the prompt (always
        # "BULLISH 72%"). Override with the real math from the messages.
        computed = self._compute_consensus(thread, entities)
        self._log("stage5", f"Computed from thread: {computed['direction']} ({computed['confidence']}%) — bulls={computed['bulls']}, bears={computed['bears']}, neutrals={computed['neutrals']}")

        # Trust the computed values over the LLM output
        summary["consensus_direction"] = computed["direction"]
        summary["confidence"] = computed["confidence"]

        self._log("complete", f"Pipeline done. {len(entities)} agents, {round_num} rounds, {len(thread)} messages.")

        # Build the convergence timeline for UI charting
        convergence_timeline = [
            {"round": i + 1, "sentiment": s} for i, s in enumerate(sentiments_by_round)
        ]

        # Flatten agent_research dict to serializable form
        agent_research_out: Dict[str, List[Dict[str, Any]]] = {}
        for eid, res in agent_research.items():
            if res and res.get("findings"):
                agent_research_out[eid] = res["findings"]

        # Log a summary of any events that fired during the run so the
        # user can see them in the server console as well as the UI.
        warn_count = sum(1 for e in self.run_events if e["level"] == "warn")
        err_count = sum(1 for e in self.run_events if e["level"] == "error")
        if warn_count or err_count:
            self._log(
                "complete",
                f"Run finished with {err_count} error(s) and {warn_count} warning(s). "
                "See `events` in the response or the UI 'Run Warnings' card for details.",
            )

        return {
            "asset_info": asset_info,
            "entities": entities,
            "thread": thread,
            "total_rounds": round_num + (1 if cross_exam_results else 0),
            "summary": summary,
            "intel_briefing": intel_briefing,
            "cross_exam_results": cross_exam_results,
            # New: expose previously-hidden pipeline data
            "market_context": context,
            "data_feeds": data_feeds,
            "agent_research": agent_research_out,
            "convergence_timeline": convergence_timeline,
            # Everything the user should know about what went right/wrong
            "events": self.run_events,
        }

    def _fallback_summary_from_thread(
        self, thread: List[Dict], entities: List[Dict], bars: List[Dict], reason: str,
    ) -> Dict[str, Any]:
        """
        Build a usable summary when Stage 5's LLM call fails or times out.
        Previously we returned an empty NEUTRAL stub, which wiped out all the
        debate data. This extracts what we can directly from the thread so
        the user still gets real output:
          - consensus from _compute_consensus (ground truth math)
          - key_arguments from the top-N most-confident bullish messages
          - dissenting_views from the top-N most-confident bearish messages
          - price_targets from the median / spread of predicted prices
          - current_price for recommendation anchoring
        """
        computed = self._compute_consensus(thread, entities)

        # Pull excerpts from the most-influential bullish / bearish messages
        bull_msgs = sorted(
            [m for m in thread if float(m.get("sentiment", 0)) > 0.2],
            key=lambda m: float(m.get("sentiment", 0)) * float(m.get("influence", 1.0)),
            reverse=True,
        )
        bear_msgs = sorted(
            [m for m in thread if float(m.get("sentiment", 0)) < -0.2],
            key=lambda m: abs(float(m.get("sentiment", 0))) * float(m.get("influence", 1.0)),
            reverse=True,
        )

        def _excerpt(m: Dict) -> str:
            content = (m.get("content", "") or "").strip()
            # First sentence or first 200 chars, whichever is shorter
            if "." in content[:220]:
                return content[: content.index(".") + 1].strip()
            return content[:200].strip() + ("..." if len(content) > 200 else "")

        key_arguments = [f"{m.get('entity_name', '?')}: {_excerpt(m)}" for m in bull_msgs[:5]]
        dissenting = [f"{m.get('entity_name', '?')}: {_excerpt(m)}" for m in bear_msgs[:3]]

        # Price targets from predictions in the thread
        preds: List[float] = []
        for m in thread:
            p = m.get("price_prediction")
            if isinstance(p, (int, float)) and p > 0:
                preds.append(float(p))
        if preds:
            preds.sort()
            low = preds[0]
            high = preds[-1]
            mid = preds[len(preds) // 2]
            price_targets = {"low": round(low, 2), "mid": round(mid, 2), "high": round(high, 2)}
        else:
            cur = float(bars[-1]["close"]) if bars else 0
            price_targets = {"low": cur * 0.95, "mid": cur, "high": cur * 1.05}

        # Recommendation based on computed consensus
        cur_price = float(bars[-1]["close"]) if bars else 0
        direction = computed["direction"]
        action = "BUY" if direction == "BULLISH" else "SELL" if direction == "BEARISH" else "HOLD"
        recommendation: Dict[str, Any] = {"action": action}
        if cur_price and direction != "NEUTRAL":
            recommendation["entry"] = round(cur_price, 2)
            if direction == "BULLISH":
                recommendation["target"] = price_targets["high"]
                recommendation["stop"] = round(cur_price * 0.95, 2)
            else:
                recommendation["target"] = price_targets["low"]
                recommendation["stop"] = round(cur_price * 1.05, 2)

        return {
            "consensus_direction": computed["direction"],
            "confidence": computed["confidence"],
            "key_arguments": key_arguments,
            "dissenting_views": dissenting,
            "price_targets": price_targets,
            "risk_factors": [
                f"Auto-generated fallback (Stage 5 failed: {reason}). "
                "The LLM report was skipped — numbers below are computed directly from the debate.",
            ],
            "recommendation": recommendation,
            "conviction_shifts": [],
        }

    def _compute_consensus(self, thread: list, entities: list) -> dict:
        """
        Compute the real influence-weighted consensus from the debate thread.
        Used as ground truth to override the LLM's summary output (which
        tends to hallucinate or copy example values from the prompt).

        Algorithm:
          1. For each agent, compute their final sentiment (average of last
             3 messages, weighted by recency).
          2. Weight by the agent's influence (0.5-3.0).
          3. Classify as bull (>0.2), bear (<-0.2), or neutral.
          4. Confidence = majority_weight / total_weight * 100.
        """
        # Build per-agent final sentiment from their last 3 messages
        agent_sentiments: Dict[str, list] = {}
        for msg in thread:
            eid = msg.get("entity_id", "")
            if eid == "chart_support" or msg.get("is_chart_support"):
                continue
            agent_sentiments.setdefault(eid, []).append(msg.get("sentiment", 0))

        # Build influence lookup
        influence_by_id: Dict[str, float] = {
            e.get("id", ""): float(e.get("influence", 1.0)) for e in entities
        }

        bull_weight = 0.0
        bear_weight = 0.0
        neutral_weight = 0.0
        bulls = 0
        bears = 0
        neutrals = 0

        for eid, sentiments in agent_sentiments.items():
            if not sentiments:
                continue
            # Average of last 3 messages, weighted toward recent
            recent = sentiments[-3:]
            weights = [1.0, 1.5, 2.0][-len(recent):]
            avg_sent = sum(s * w for s, w in zip(recent, weights)) / sum(weights)
            influence = influence_by_id.get(eid, 1.0)

            if avg_sent > 0.2:
                bulls += 1
                bull_weight += influence
            elif avg_sent < -0.2:
                bears += 1
                bear_weight += influence
            else:
                neutrals += 1
                neutral_weight += influence

        total_weight = bull_weight + bear_weight + neutral_weight or 1.0

        if bull_weight > bear_weight and bull_weight > neutral_weight:
            direction = "BULLISH"
            majority_weight = bull_weight
        elif bear_weight > bull_weight and bear_weight > neutral_weight:
            direction = "BEARISH"
            majority_weight = bear_weight
        else:
            direction = "NEUTRAL"
            majority_weight = max(bull_weight, bear_weight, neutral_weight)

        confidence = int(round((majority_weight / total_weight) * 100))

        return {
            "direction": direction,
            "confidence": confidence,
            "bulls": bulls,
            "bears": bears,
            "neutrals": neutrals,
            "bull_weight": round(bull_weight, 2),
            "bear_weight": round(bear_weight, 2),
            "neutral_weight": round(neutral_weight, 2),
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
