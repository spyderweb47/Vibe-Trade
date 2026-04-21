"""
QA agent — the reusable "verify an artifact in a closed loop" pattern.

Used by any skill that wants a producer agent (writes a script, drafts
a strategy, picks a trade) followed by a verifier agent that actually
tests the output and tells the producer to iterate.

The loop:
  1. Producer generates artifact N
  2. Verifier runs acceptance criteria (optionally executes a test_fn)
  3. If pass → return artifact
  4. If fail → producer.reflect(prior=artifact, feedback=issues) → go to 2
  5. Cap at max_iterations

This is the closed-loop generalisation of what the cross-examiner did
in predict_analysis — now available for every skill via AgentSwarm.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from core.agents.base_agent import Agent, AgentResponse, AgentSpec, speak_json


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class QASpec:
    """What the verifier agent should check."""

    acceptance_criteria: str
    """Natural-language description of what 'pass' means. Passed to the
    verifier LLM. Example: 'Script must find 5-30 engulfing patterns
    with confidence > 0.6 and no zero-duration matches.'"""

    test_fn: Optional[Callable[[Any, Any], Dict[str, Any]]] = None
    """Optional programmatic check. Called with (artifact_structured, test_data).
    Returns a dict that gets fed to the verifier alongside the artifact, so
    the verifier can reason over actual execution results, not just the code.

    Example for pattern skill:
        test_fn = run_pattern_script_and_count_matches
        test_data = bars
        returns  = {'matches_count': 7, 'avg_confidence': 0.72, 'errors': []}
    """

    test_data: Any = None
    """Argument passed as the 2nd param of test_fn."""


@dataclass
class QAResult:
    """What a QA loop returns to the calling skill."""

    passed: bool
    final_artifact: AgentResponse
    """Producer's last output. If passed=True this is the accepted output;
    if passed=False it's the best attempt so far."""

    iterations: int
    """Number of producer iterations run. iterations=1 means one producer call
    that passed immediately."""

    feedback_history: List[Dict[str, Any]] = field(default_factory=list)
    """Each entry: {'iteration': N, 'artifact': str, 'verifier_issues': str,
    'programmatic_result': dict | None}. Useful for debugging + UI display."""

    final_reason: str = ""
    """Why the loop stopped. 'passed_qa' | 'max_iterations' | 'producer_failed' | ..."""


# ─── Verifier agent (specialised Agent subclass) ─────────────────────────────


class QAVerifierAgent(Agent):
    """
    An Agent whose job is to read a producer's output + optional programmatic
    test results, and return a structured pass/fail judgement with
    actionable feedback.

    The `parse_response` override extracts the structured JSON
    {passed, issues, suggested_fix, severity} so the orchestrator can route.
    """

    def build_prompt(self, context: str, task: str) -> tuple[str, str]:
        """Verifier-specific prompt emphasising adversarial behaviour."""
        p = self.spec.persona
        name = p.get("name", "QA Verifier")
        background = p.get(
            "background",
            "You are a skeptical QA engineer. Your job is to find reasons to reject.",
        )
        system = (
            f"You are {name}, a quality-assurance verifier.\n"
            f"Background: {background}\n\n"
            f"Your job: read the PRODUCER'S OUTPUT and decide if it meets the "
            f"ACCEPTANCE CRITERIA. Be adversarial — look for edge cases, "
            f"hidden bugs, weak reasoning, values outside expected ranges, "
            f"or places where the output doesn't actually do what was asked. "
            f"If there are execution results attached, weigh them heavily.\n\n"
            f"Return STRICT JSON only. Schema:\n"
            f"{{\n"
            f'  "passed": boolean,\n'
            f'  "severity": "ok" | "minor" | "major" | "critical",\n'
            f'  "issues": [array of strings — specific problems found],\n'
            f'  "suggested_fix": string — what the producer should change,\n'
            f'  "confidence": number 0-1 — how sure you are of this verdict\n'
            f"}}"
        )
        user = f"## Acceptance Criteria\n{context}\n\n## Producer's Output\n{task}"
        return system, user

    def parse_response(self, text: str) -> AgentResponse:
        """Try to extract the JSON verdict; fall back to raw text on parse fail."""
        import json

        cleaned = text.strip()
        if cleaned.startswith("```"):
            nl = cleaned.find("\n")
            if nl != -1:
                cleaned = cleaned[nl + 1:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
        try:
            verdict = json.loads(cleaned)
        except json.JSONDecodeError:
            try:
                # Try to find {...} substring
                start = cleaned.index("{")
                end = cleaned.rindex("}") + 1
                verdict = json.loads(cleaned[start:end])
            except (ValueError, json.JSONDecodeError):
                return AgentResponse(
                    content=text,
                    confidence=0.3,
                    error="Could not parse verifier JSON",
                )
        return AgentResponse(
            content=verdict.get("suggested_fix", ""),
            confidence=float(verdict.get("confidence", 0.5)),
            structured=verdict,
        )


# ─── The loop ────────────────────────────────────────────────────────────────


def run_qa_loop(
    producer: Agent,
    verifier: QAVerifierAgent,
    task: str,
    context: str,
    spec: QASpec,
    max_iterations: int = 3,
) -> QAResult:
    """
    Execute the producer → verifier → reflect → verifier loop.

    Synchronous. Wrap in asyncio.to_thread at the call site. AgentSwarm's
    Team.run_with_qa_loop() is the async-facing wrapper around this.
    """
    history: List[Dict[str, Any]] = []

    # Iteration 1 — cold start
    artifact = producer.speak(context=context, task=task)
    if artifact.error:
        return QAResult(
            passed=False,
            final_artifact=artifact,
            iterations=1,
            feedback_history=history,
            final_reason="producer_failed",
        )

    for iteration in range(1, max_iterations + 1):
        # Run the programmatic test if provided
        test_result: Optional[Dict[str, Any]] = None
        if spec.test_fn is not None:
            try:
                test_result = spec.test_fn(artifact.structured or artifact.content, spec.test_data)
            except Exception as err:  # noqa: BLE001
                test_result = {"error": f"{type(err).__name__}: {str(err)[:180]}"}

        # Ask the verifier
        verifier_context = spec.acceptance_criteria
        if test_result is not None:
            verifier_context += f"\n\n## Programmatic test results\n{test_result}"

        verdict = verifier.speak(context=verifier_context, task=artifact.content)
        struct = verdict.structured or {}

        history.append({
            "iteration": iteration,
            "artifact": artifact.content[:2000],
            "verifier_issues": struct.get("issues", []),
            "verifier_severity": struct.get("severity", "unknown"),
            "programmatic_result": test_result,
        })

        if struct.get("passed"):
            return QAResult(
                passed=True,
                final_artifact=artifact,
                iterations=iteration,
                feedback_history=history,
                final_reason="passed_qa",
            )

        # Don't bother iterating if we're at the cap
        if iteration >= max_iterations:
            break

        # Producer revises with verifier's feedback. Pass original
        # task/context so format constraints (e.g. "strict JSON only,
        # no preamble") survive into iteration 2+ — without this the
        # producer often replies with a prose changelog instead of
        # regenerating the artifact.
        feedback_text = _format_feedback(struct, test_result)
        artifact = producer.reflect(
            prior_output=artifact.content,
            feedback=feedback_text,
            original_task=task,
            original_context=context,
        )
        if artifact.error:
            return QAResult(
                passed=False,
                final_artifact=artifact,
                iterations=iteration + 1,
                feedback_history=history,
                final_reason="producer_reflect_failed",
            )

    # Loop fell through — max iterations hit with still-failing QA
    return QAResult(
        passed=False,
        final_artifact=artifact,
        iterations=max_iterations,
        feedback_history=history,
        final_reason="max_iterations",
    )


def _format_feedback(verdict: Dict[str, Any], test_result: Optional[Dict[str, Any]]) -> str:
    """Turn a verifier verdict + programmatic result into readable feedback."""
    issues = verdict.get("issues", [])
    suggested = verdict.get("suggested_fix", "")
    severity = verdict.get("severity", "unknown")

    parts = [f"## QA verdict: FAILED (severity: {severity})"]
    if issues:
        parts.append("\n### Issues found")
        parts.extend(f"- {i}" for i in issues)
    if test_result:
        parts.append(f"\n### Programmatic test result\n{test_result}")
    if suggested:
        parts.append(f"\n### Suggested fix\n{suggested}")
    return "\n".join(parts)
