/**
 * Frontend plan executor — runs a multi-step plan in the browser and
 * surfaces its real-time state as a single collapsible "trace" message in
 * the chat (Claude-style thinking box).
 *
 * The backend planner builds the plan structure but returns it WITHOUT
 * executing it. This module then walks the steps one at a time:
 *
 *   1. Calls `/chat` with the step's skill + the current accumulated context
 *   2. Runs the step's tool_calls (which may load a generated script into
 *      the editor, set the active timeframe, register a fetched dataset, etc.)
 *   3. If the step generated a runnable script, ACTUALLY EXECUTES IT via the
 *      Web Worker pattern/strategy executors and captures the real results
 *      (pattern matches, backtest trades, equity curve)
 *   4. Updates the trace message with the step's status + short result
 *   5. Adds the captured results to the accumulated context so the NEXT
 *      step's LLM call can see them
 *
 * Throughout the run, there's only ONE trace message in the chat — it
 * updates in place as steps transition `pending → running → done`. When the
 * plan completes, the box auto-collapses to a summary chip.
 */

import { sendChat, type PlanStep } from "@/lib/api";
import { executePatternScript } from "@/lib/scriptExecutor";
import { executeStrategy } from "@/lib/strategyExecutor";
import { useStore } from "@/store/useStore";
import { runToolCalls } from "@/lib/toolRegistry";
import type { StrategyConfig, TraceStep, TraceSubStep, TraceData } from "@/types";

/**
 * Known sub-step sequences for long-running skills. When a step with one of
 * these skill IDs starts running, the trace shows internal progress ticking
 * through these stages on a timer. When the backend call returns, all
 * sub-steps snap to done.
 */
const SKILL_SUB_PLANS: Record<string, { label: string; durationMs: number }[]> = {
  swarm_intelligence: [
    { label: "Classifying asset...", durationMs: 3000 },
    { label: "Preparing multi-timeframe data...", durationMs: 2000 },
    { label: "Generating personas (batch 1)...", durationMs: 6000 },
    { label: "Generating personas (batch 2)...", durationMs: 6000 },
    { label: "Generating personas (batch 3)...", durationMs: 6000 },
    { label: "Discussion round 1-5...", durationMs: 20000 },
    { label: "Discussion round 6-10...", durationMs: 20000 },
    { label: "Discussion round 11-15...", durationMs: 20000 },
    { label: "Discussion round 16-20...", durationMs: 20000 },
    { label: "Checking convergence...", durationMs: 2000 },
    { label: "Generating final summary...", durationMs: 5000 },
  ],
};

interface ExecutePlanArgs {
  steps: PlanStep[];
}

/**
 * Walk a plan step-by-step, executing each step's generated script against
 * the live store state and feeding real results into the next step. Renders
 * a single trace message that updates in place as steps run.
 */
export async function executePlanInBrowser({ steps }: ExecutePlanArgs): Promise<void> {
  const { addMessage, updateMessage } = useStore.getState();

  // Pre-populate activeSkillIds with EVERY skill the plan will touch. This
  // is critical for zero-skill default-agent mode: the BottomPanel computes
  // its tabs from activeSkillIds, so without this the Portfolio / Trade
  // List / Pattern Analysis tabs wouldn't exist even after the plan runs
  // real backtests and pattern detections. We merge with the existing set
  // (doesn't clobber user-selected chips) so scoped-planner mode is a no-op.
  const currentActive = useStore.getState().activeSkillIds;
  const planSkills = new Set(steps.map((s) => s.skill));
  const mergedActive = new Set([...currentActive, ...planSkills]);
  if (mergedActive.size !== currentActive.size) {
    useStore.getState().setActiveSkills(mergedActive);
  }

  // Build the initial trace from the plan
  const initialSteps: TraceStep[] = steps.map((s) => ({
    skill: s.skill,
    message: s.message,
    rationale: s.rationale,
    status: "pending",
  }));

  // Add ONE trace message at the start — we'll mutate it in place as the run progresses
  const traceId = addMessage({
    role: "trace",
    content: "",
    trace: {
      status: "running",
      steps: initialSteps,
      title: `Planning ${steps.length} step${steps.length !== 1 ? "s" : ""}`,
    },
  });

  // Helper to patch the trace with new step state
  const patchTrace = (patch: Partial<TraceData>) => {
    const current = useStore.getState().messages.find((m) => m.id === traceId);
    if (!current?.trace) return;
    updateMessage(traceId, { trace: { ...current.trace, ...patch } });
  };

  const patchStep = (index: number, patch: Partial<TraceStep>) => {
    const current = useStore.getState().messages.find((m) => m.id === traceId);
    if (!current?.trace) return;
    const next = current.trace.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    updateMessage(traceId, { trace: { ...current.trace, steps: next } });
  };

  // Accumulated context flows between steps
  const accumulatedContext: Record<string, unknown> = {};

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    patchStep(i, { status: "running" });
    patchTrace({ title: `Running step ${i + 1}/${steps.length}` });

    // Per-step context = accumulated + the planner's per-step overrides
    const stepContext = { ...accumulatedContext, ...(step.context || {}) };

    // Start sub-step ticker for known long-running skills
    const subPlan = SKILL_SUB_PLANS[step.skill];
    let subStepTimer: ReturnType<typeof setTimeout> | null = null;
    if (subPlan) {
      const subs: TraceSubStep[] = subPlan.map((s) => ({ label: s.label, status: "pending" as const }));
      subs[0] = { ...subs[0], status: "running" };
      patchStep(i, { subSteps: subs });

      // Tick through sub-steps on estimated timers
      let subIdx = 0;
      const tickNext = () => {
        subIdx++;
        if (subIdx >= subs.length) return;
        const updated = subs.map((s, j) => ({
          ...s,
          status: (j < subIdx ? "done" : j === subIdx ? "running" : "pending") as TraceSubStep["status"],
        }));
        patchStep(i, { subSteps: updated });
        subStepTimer = setTimeout(tickNext, subPlan[subIdx].durationMs);
      };
      subStepTimer = setTimeout(tickNext, subPlan[0].durationMs);
    }

    try {
      const result = await sendChat(step.message, step.skill, stepContext);

      // Clear sub-step timer and mark all done
      if (subStepTimer) clearTimeout(subStepTimer);
      if (subPlan) {
        const allDone = subPlan.map((s) => ({ label: s.label, status: "done" as const }));
        patchStep(i, { subSteps: allDone });
      }

      // Run tool_calls (script load, dataset add, timeframe set, etc.)
      // If the skill isn't found in the frontend registry, allow all tools
      // rather than blocking everything — the backend already validated.
      const skill = useStore.getState().skills.find((s) => s.id === step.skill);
      const allowedTools = skill?.tools || result.tool_calls?.map((tc) => tc.tool) || [];
      runToolCalls(result.tool_calls, step.skill, allowedTools);

      // Wait a tick for tool calls to settle (e.g. data.dataset.add registers
      // the dataset async-ishly via store update)
      await new Promise((r) => setTimeout(r, 250));

      let resultSummary = "";

      // ─── Auto-run pattern scripts ─────────────────────────────────────
      if (result.script && (result.script_type === "pattern" || step.skill === "pattern")) {
        const chartData = useStore.getState().chartData;
        if (!chartData || chartData.length === 0) {
          resultSummary = "no dataset on chart — skipped run";
        } else {
          try {
            const matches = await executePatternScript(result.script, chartData);
            useStore.getState().setPatternMatches(matches);
            useStore.getState().setLastScriptResult({ ran: true });
            resultSummary = `found ${matches.length} pattern match${matches.length !== 1 ? "es" : ""}`;
            accumulatedContext.pattern_matches_count = matches.length;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            useStore.getState().setLastScriptResult({ ran: true, error: msg });
            patchStep(i, { status: "failed", error: `pattern run failed: ${msg}` });
            continue;
          }
        }
      }

      // ─── Auto-run strategy scripts ────────────────────────────────────
      if (result.script && (result.script_type === "strategy" || step.skill === "strategy")) {
        const chartData = useStore.getState().chartData;
        const stepCfg = (step.context?.strategy_config as StrategyConfig | undefined) || undefined;
        const dataCfg = (result.data?.config as StrategyConfig | undefined) || undefined;
        const config: StrategyConfig =
          stepCfg ||
          dataCfg ||
          useStore.getState().strategyConfig ||
          ({
            entryCondition: "",
            exitCondition: "",
            takeProfit: { type: "percentage", value: 5 },
            stopLoss: { type: "percentage", value: 2 },
            maxDrawdown: 20,
            seedAmount: 10000,
            specialInstructions: "",
          } as StrategyConfig);

        if (!chartData || chartData.length === 0) {
          resultSummary = "no dataset on chart — skipped backtest";
        } else {
          try {
            const backtest = await executeStrategy(result.script, chartData, config);
            useStore.getState().setBacktestResults(backtest);
            const winRate = (backtest.winRate * 100).toFixed(1);
            const totalReturn = (backtest.totalReturn * 100).toFixed(1);
            resultSummary = `${backtest.totalTrades} trades, ${winRate}% win rate, ${totalReturn}% return`;
            accumulatedContext.backtest_summary = {
              totalTrades: backtest.totalTrades,
              winRate: backtest.winRate,
              totalReturn: backtest.totalReturn,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            patchStep(i, { status: "failed", error: `backtest failed: ${msg}` });
            continue;
          }
        }
      }

      // Swarm intelligence summary
      if (!resultSummary && step.skill === "swarm_intelligence") {
        const debate = result.data?.debate as Record<string, unknown> | undefined;
        if (debate) {
          const entities = (debate.entities as unknown[])?.length || 0;
          const thread = (debate.thread as unknown[])?.length || 0;
          const summary = debate.summary as Record<string, unknown> | undefined;
          const direction = summary?.consensus_direction || "N/A";
          const confidence = summary?.confidence || 0;
          resultSummary = `${entities} personas, ${thread} messages. Consensus: ${direction} (${confidence}%)`;
        }
      }

      // Data fetcher default summary
      if (!resultSummary && step.skill === "data_fetcher") {
        const ds = result.data?.dataset as { metadata?: { rows?: number }; symbol?: string; interval?: string } | undefined;
        if (ds?.metadata?.rows && ds.symbol) {
          resultSummary = `${ds.metadata.rows} bars of ${ds.symbol} ${ds.interval || ""}`.trim();
        } else {
          resultSummary = "dataset loaded";
        }
      }

      // Fallback: short reply snippet
      if (!resultSummary) {
        const reply = (result.reply || "").trim();
        resultSummary = reply.length > 80 ? reply.slice(0, 80) + "…" : reply;
      }

      patchStep(i, { status: "done", result: resultSummary });

      // Carry forward data for next step
      if (result.data && typeof result.data === "object") {
        for (const [k, v] of Object.entries(result.data)) {
          accumulatedContext[k] = v;
        }
      }
    } catch (err) {
      if (subStepTimer) clearTimeout(subStepTimer);
      const msg = err instanceof Error ? err.message : String(err);
      patchStep(i, { status: "failed", error: msg, subSteps: undefined });
      patchTrace({ status: "failed" });
      return;
    }
  }

  // All steps complete
  patchTrace({ status: "done", title: `Plan complete (${steps.length} step${steps.length !== 1 ? "s" : ""})` });
}
