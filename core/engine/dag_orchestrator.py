"""
Social simulation orchestrator — forum-style multi-round debate.

Pipeline:
  1. Read asset name from dataset metadata (skip classifier if available)
  2. ChartSupportAgent — prepare multi-timeframe data
  3. EntityGenerator — create 30-35 deep personas
  4. Forum discussion — 20+ rounds, 8-10 speakers per round respond to each other
  5. ChartSupportAgent — inject data when entities request it mid-debate
  6. SummaryAgent — produce final report when consensus reached or max rounds hit

Each entity speaks 5+ times across the simulation. They MUST reference
and respond to other entities' messages — not just post independently.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any, Dict, List

from core.agents.simulation_agents import (
    AssetClassifier,
    ChartSupportAgent,
    EntityGenerator,
    DiscussionAgent,
    SummaryAgent,
)


class DebateOrchestrator:
    """Runs the full forum-style social simulation."""

    MAX_ROUNDS = 20
    SPEAKERS_PER_ROUND = 10  # 10 entities respond each round

    def __init__(self) -> None:
        self.classifier = AssetClassifier()
        self.chart_support = ChartSupportAgent()
        self.entity_gen = EntityGenerator()
        self.summary_agent = SummaryAgent()

    async def run(
        self,
        bars: list[dict],
        symbol: str,
        report_text: str = "",
    ) -> Dict[str, Any]:
        """Execute the full simulation pipeline."""

        # --- Stage 1: Asset classification ---
        # Use the symbol/filename from the dataset directly
        price_range = (
            min(b["low"] for b in bars) if bars else 0,
            max(b["high"] for b in bars) if bars else 0,
        )
        asset_info = await asyncio.to_thread(
            self.classifier.classify, symbol, price_range, len(bars)
        )

        # --- Stage 2: Prepare data ---
        summaries = self.chart_support.prepare_multi_timeframe(bars, symbol)
        main_summary = summaries.get("daily", summaries.get("raw", "No data"))

        # --- Stage 3: Generate entities (10-12 deep personas) ---
        entities = await asyncio.to_thread(
            self.entity_gen.generate, asset_info, main_summary, report_text
        )
        # 15 entities gives diverse perspectives without excessive API calls
        entities = entities[:15]

        # --- Stage 4: Forum discussion ---
        thread: List[Dict[str, Any]] = []
        thread_text = ""
        n_entities = len(entities)
        sentiments_by_round: List[float] = []

        for round_num in range(1, self.MAX_ROUNDS + 1):
            # Pick speakers: rotate through all entities, 5 per round
            start_idx = ((round_num - 1) * self.SPEAKERS_PER_ROUND) % n_entities
            speaker_indices = [(start_idx + j) % n_entities for j in range(self.SPEAKERS_PER_ROUND)]
            speakers = [entities[i] for i in speaker_indices]

            # All speakers in this round run in parallel
            agents = [DiscussionAgent(e, asset_info) for e in speakers]
            results = await asyncio.gather(
                *[asyncio.to_thread(
                    a.speak, main_summary, thread_text, report_text[:600], round_num
                ) for a in agents]
            )

            # Append to thread
            round_sentiments = []
            for entity, result in zip(speakers, results):
                msg = {
                    "id": str(uuid.uuid4()),
                    "round": round_num,
                    "entity_id": entity.get("id", "unknown"),
                    "entity_name": entity.get("name") or entity.get("label", "Unknown"),
                    "entity_role": entity.get("role") or entity.get("label", "Analyst"),
                    "content": result.get("content", ""),
                    "sentiment": float(result.get("sentiment", 0)),
                    "price_prediction": result.get("price_prediction"),
                    "agreed_with": result.get("agreed_with", []),
                    "disagreed_with": result.get("disagreed_with", []),
                    "is_chart_support": False,
                    "data_request": result.get("data_request"),
                }
                thread.append(msg)
                round_sentiments.append(msg["sentiment"])

            # Update thread text
            thread_text = self._build_thread_text(thread)

            # --- Stage 5: Check for data requests ---
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
                        }
                        thread.append(chart_msg)
                        thread_text = self._build_thread_text(thread)

            # Track sentiment convergence
            avg_sentiment = sum(round_sentiments) / len(round_sentiments) if round_sentiments else 0
            sentiments_by_round.append(avg_sentiment)

            # Check convergence: if last 4 rounds have similar sentiment, stop early.
            # With 30+ personas we need more rounds before declaring consensus.
            if round_num >= 10 and len(sentiments_by_round) >= 4:
                recent = sentiments_by_round[-4:]
                spread = max(recent) - min(recent)
                if spread < 0.10:  # sentiments converged within 10%
                    break

        # --- Stage 6: Summary ---
        summary = await asyncio.to_thread(
            self.summary_agent.summarize,
            thread_text,
            asset_info,
            entity_count=len(entities),
            round_count=round_num,
            message_count=len(thread),
        )

        return {
            "asset_info": asset_info,
            "entities": entities,
            "thread": thread,
            "total_rounds": round_num,
            "summary": summary,
        }

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
                lines.append(f"{msg['entity_name']} ({msg['entity_role']}): {msg['content']}")
        return "\n".join(lines)
