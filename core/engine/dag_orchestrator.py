"""
DAG-based debate orchestrator for the multi-agent trading committee.

When a report is provided, the Architect Agent dynamically generates
specialized analyst personas. All analysts run in parallel, then the
Portfolio Manager synthesizes their arguments into a final decision.

DAG structure:
  [Architect] → [Agent 1] ──┐
                [Agent 2] ──┤
                [Agent 3] ──├──→ [Portfolio Manager] ──→ Decision
                [Agent 4] ──┤
                [Agent N] ──┘
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from core.agents.simulation_agents import (
    ArchitectAgent,
    DynamicDebateAgent,
    PortfolioManager,
    format_ohlc_for_prompt,
)


class DebateOrchestrator:
    """Runs the multi-agent committee debate in DAG order."""

    def __init__(self) -> None:
        self.architect = ArchitectAgent()
        self.pm = PortfolioManager()

    async def run(
        self,
        bars: list[dict],
        symbol: str,
        report_text: str = "",
    ) -> Dict[str, Any]:
        """Execute the full debate DAG. Returns all agent results + PM decision."""
        market_data = format_ohlc_for_prompt(bars, symbol)

        # Layer 0: Architect generates personas (synchronous, fast)
        personas = await asyncio.to_thread(
            self.architect.generate_personas, symbol, report_text, market_data[:500]
        )

        # Layer 1: All dynamic agents run in parallel
        agents = [DynamicDebateAgent(p) for p in personas]
        agent_results = await asyncio.gather(
            *[asyncio.to_thread(a.analyze, market_data, report_text) for a in agents]
        )

        # Build results dict keyed by role
        results: Dict[str, Any] = {}
        for agent, result in zip(agents, agent_results):
            results[agent.role] = {
                "role": agent.role,
                "label": agent.label,
                "argument": result.get("argument", ""),
                "key_points": result.get("key_points", []),
                "sentiment": float(result.get("sentiment", 0)),
                "signals": result.get("signals", []),
            }

        # Layer 2: Portfolio Manager sees all arguments
        all_arguments = {
            agent.label: result.get("argument", "")
            for agent, result in zip(agents, agent_results)
        }
        pm_result = await asyncio.to_thread(
            self.pm.analyze, market_data, all_arguments
        )

        # Add PM to results
        results["pm"] = {
            "role": "pm",
            "label": "Portfolio Manager",
            "argument": pm_result.get("reasoning", pm_result.get("argument", "")),
            "key_points": pm_result.get("key_points", []),
            "sentiment": 0.0,
            "signals": [],
        }

        return {
            **{k: v for k, v in results.items()},
            "decision": {
                "decision": pm_result.get("decision", "HOLD"),
                "confidence": float(pm_result.get("confidence", 0.5)),
                "reasoning": pm_result.get("reasoning", ""),
                "suggested_entry": pm_result.get("suggested_entry"),
                "suggested_stop": pm_result.get("suggested_stop"),
                "suggested_target": pm_result.get("suggested_target"),
                "position_size_pct": pm_result.get("position_size_pct"),
            },
        }
