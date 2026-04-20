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

import { sendChat, type PlanStep, fixScript } from "@/lib/api";
import { executePatternScript } from "@/lib/scriptExecutor";
import { executeStrategy } from "@/lib/strategyExecutor";
import { useStore } from "@/store/useStore";
import { runToolCalls } from "@/lib/toolRegistry";
import type { StrategyConfig, TraceStep, TraceSubStep, TraceData } from "@/types";

/**
 * Auto-fix a pattern script that crashed in the Web Worker, then re-run
 * it. Returns { matches, fixedScript, explanation } on success, or
 * throws the original error if the fix attempt fails too.
 *
 * Bounded to a single fix attempt per script per dataset so one
 * hopelessly broken script can't trigger a fix loop (backend has its
 * own retry caps, but defence in depth).
 *
 * Shared between planExecutor and RightSidebar's handleRun so both
 * code paths get automatic error recovery.
 */
export async function runPatternScriptWithAutoFix(
  script: string,
  bars: import("@/types").OHLCBar[],
  intent: string,
): Promise<{
  matches: import("@/types").PatternMatch[];
  fixedScript: string | null;
  fixExplanation: string | null;
}> {
  try {
    const matches = await executePatternScript(script, bars);
    return { matches, fixedScript: null, fixExplanation: null };
  } catch (runErr) {
    const errMsg = runErr instanceof Error ? runErr.message : String(runErr);
    // Ask the backend Error Handler Agent for a fix
    const fix = await fixScript({
      script,
      error: errMsg,
      intent,
      script_type: "pattern",
    }).catch((fixApiErr) => {
      console.warn("[autofix] /fix-script call failed:", fixApiErr);
      return null;
    });

    if (!fix || !fix.fixed_script || fix.error) {
      // Fixer couldn't help — re-throw original error
      throw runErr;
    }

    // Try once with the fixed script
    try {
      const matches = await executePatternScript(fix.fixed_script, bars);
      return {
        matches,
        fixedScript: fix.fixed_script,
        fixExplanation: fix.explanation || "Script auto-fixed",
      };
    } catch (secondErr) {
      // Fix didn't help either — re-throw the SECOND error
      // (it's more informative than the first since the fixer agent's
      // diagnosis is in the middle)
      throw secondErr;
    }
  }
}

/**
 * Strategy-script equivalent of runPatternScriptWithAutoFix.
 *
 * Flow:
 *   1. Try executeStrategy(script, bars, config)
 *   2. On runtime crash: POST /fix-script with script_type="strategy"
 *   3. Try once with the fixed version
 *   4. Second crash → re-throw (caller shows original error)
 *
 * Returns { result, fixedScript, fixExplanation } — fixedScript is null
 * on success-first-try so callers know whether to persist the fix.
 *
 * Bounded to one fix attempt per run, matching the pattern helper.
 */
export async function runStrategyWithAutoFix(
  script: string,
  bars: import("@/types").OHLCBar[],
  config: StrategyConfig,
  intent: string,
): Promise<{
  result: import("@/types").BacktestResult;
  fixedScript: string | null;
  fixExplanation: string | null;
}> {
  try {
    const result = await executeStrategy(script, bars, config);
    return { result, fixedScript: null, fixExplanation: null };
  } catch (runErr) {
    const errMsg = runErr instanceof Error ? runErr.message : String(runErr);
    const fix = await fixScript({
      script,
      error: errMsg,
      intent,
      script_type: "strategy",
    }).catch((apiErr) => {
      console.warn("[autofix] /fix-script call failed (strategy):", apiErr);
      return null;
    });

    if (!fix || !fix.fixed_script || fix.error) {
      throw runErr;
    }

    try {
      const result = await executeStrategy(fix.fixed_script, bars, config);
      return {
        result,
        fixedScript: fix.fixed_script,
        fixExplanation: fix.explanation || "Strategy script auto-fixed",
      };
    } catch (secondErr) {
      throw secondErr;
    }
  }
}

/**
 * Known sub-step sequences for long-running skills. When a step with one of
 * these skill IDs starts running, the trace shows internal progress ticking
 * through these stages on a timer. When the backend call returns, all
 * sub-steps snap to done.
 */
// `predict_analysis` is the new id for what used to be `swarm_intelligence`.
// We register the sub-plan under BOTH keys so any saved plans that still
// reference the old skill id keep rendering the progress ticker correctly.
const SKILL_SUB_PLANS: Record<string, { label: string; durationMs: number }[]> = {
  predict_analysis: [
    // Stage 1: Context
    { label: "Stage 1: Classifying asset + analyzing market context...", durationMs: 4000 },
    { label: "Stage 1: Building specialization data feeds (6 feeds)...", durationMs: 2000 },
    // Stage 1.5: Intelligence Gathering
    { label: "Stage 1.5: Searching web for recent news (3-8 results)...", durationMs: 8000 },
    { label: "Stage 1.5: Searching market analysis + regulatory updates...", durationMs: 8000 },
    { label: "Stage 1.5: Computing indicators (RSI, MACD, Bollinger, ATR, VWAP)...", durationMs: 2000 },
    { label: "Stage 1.5: Synthesizing intelligence briefing (bull/bear cases)...", durationMs: 5000 },
    // Stage 2: Personas
    { label: "Stage 2: Generating personas batch 1 (10-12 agents)...", durationMs: 8000 },
    { label: "Stage 2: Generating personas batch 2 (10-12 more)...", durationMs: 8000 },
    { label: "Stage 2: Generating personas batch 3 (10-12 more)...", durationMs: 8000 },
    { label: "Stage 2: Generating personas batch 4 (10-12 more)...", durationMs: 8000 },
    { label: "Stage 2: Generating personas batch 5 (final batch, target 50)...", durationMs: 8000 },
    { label: "Stage 2: Assigning tools per specialization (technical, macro, quant, etc.)...", durationMs: 1000 },
    // Stage 2.5: Iterative Research Phase
    { label: "Stage 2.5: Agents planning their own research queries (LLM-driven)...", durationMs: 30000 },
    { label: "Stage 2.5: Executing iterative web searches per agent (up to 4 queries each)...", durationMs: 60000 },
    { label: "Stage 2.5: Agents evaluating findings + deciding if more research needed...", durationMs: 30000 },
    { label: "Stage 2.5: Caching research findings per agent for debate prompts...", durationMs: 2000 },
    // Stage 3: Debate — these are approximate timeline markers driven by a
    // local timer, NOT synced to actual backend rounds. If the real pipeline
    // is slower than the labels, the UI will sit on the final marker while
    // the backend keeps working. Check server logs ([swarm.stage3] Round X/Y)
    // for true round-by-round progress.
    { label: "Stage 3: Debate starting — agents inject research into first messages...", durationMs: 45000 },
    { label: "Stage 3: Debate continuing — initial positions forming...", durationMs: 45000 },
    { label: "Stage 3: Debate continuing — counterarguments and rebuttals...", durationMs: 45000 },
    { label: "Stage 3: Debate continuing — evidence-based refinement...", durationMs: 45000 },
    { label: "Stage 3: Debate continuing — consensus emerging...", durationMs: 45000 },
    { label: "Stage 3: Debate finishing — final positions + convergence check (check server logs for true progress)...", durationMs: 45000 },
    // Stage 4: Cross-Exam
    { label: "Stage 4: Selecting 6-8 most divergent agents for cross-exam...", durationMs: 2000 },
    { label: "Stage 4: Cross-examining extreme positions (parallel)...", durationMs: 20000 },
    // Stage 5: Report
    { label: "Stage 5: ReACT analysis — DEEP_ANALYSIS tool...", durationMs: 5000 },
    { label: "Stage 5: ReACT analysis — INTERVIEW tool (sentiment shifts)...", durationMs: 5000 },
    { label: "Stage 5: ReACT analysis — VERIFY tool (fact check vs data)...", durationMs: 5000 },
    { label: "Stage 5: Synthesizing final research note...", durationMs: 15000 },
  ],
  // Backward-compat alias — old skill id keeps its sub-plan so saved
  // plans still render the progress ticker. Both keys point at the
  // same array so updates to one affect the other.
  get swarm_intelligence() { return this.predict_analysis; },
  data_fetcher: [
    { label: "Parsing request (extracting symbol, interval, limit)...", durationMs: 3000 },
    { label: "Fetching historical bars from data provider...", durationMs: 5000 },
    { label: "Resampling to chart timeframe...", durationMs: 1500 },
    { label: "Syncing dataset to backend store...", durationMs: 1500 },
  ],
  pattern: [
    { label: "Analyzing user's pattern description...", durationMs: 2000 },
    { label: "Generating pattern detection script...", durationMs: 8000 },
    { label: "Validating script syntax...", durationMs: 500 },
    { label: "Running script in Web Worker...", durationMs: 3000 },
  ],
  strategy: [
    { label: "Parsing strategy config (entry/exit/TP/SL)...", durationMs: 1500 },
    { label: "Generating JavaScript strategy...", durationMs: 10000 },
    { label: "Running backtest on chart data...", durationMs: 2500 },
    { label: "Computing metrics (win rate, profit factor, Sharpe)...", durationMs: 1000 },
  ],
};

interface ExecutePlanArgs {
  steps: PlanStep[];
  /**
   * When provided, re-use this trace message id instead of creating a
   * new one. RightSidebar posts an "interim planning" trace message
   * before calling `/plan` so the user gets instant feedback; once the
   * plan arrives we reuse that same trace card to show per-step
   * progress — otherwise users see two stacked planner cards.
   */
  existingTraceId?: string;
}

/**
 * Walk a plan step-by-step, executing each step's generated script against
 * the live store state and feeding real results into the next step. Renders
 * a single trace message that updates in place as steps run.
 */
export async function executePlanInBrowser({ steps, existingTraceId }: ExecutePlanArgs): Promise<void> {
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

  const initialTrace = {
    status: "running" as const,
    steps: initialSteps,
    title: `Planning ${steps.length} step${steps.length !== 1 ? "s" : ""}`,
  };

  // Reuse the caller's interim trace (from RightSidebar.handleSubmit) if
  // provided; otherwise create a fresh trace message. Reusing avoids the
  // "two planner cards in a row" UX bug where the interim "Planning..."
  // card and the step-by-step card both show up for the same request.
  let traceId: string;
  if (existingTraceId) {
    traceId = existingTraceId;
    updateMessage(traceId, { trace: initialTrace });
  } else {
    traceId = addMessage({
      role: "trace",
      content: "",
      trace: initialTrace,
    });
  }

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

  // Multi-chart context — every skill call sees the full list of
  // dataset ids currently loaded on the Canvas (one per open chart
  // window), so skills can operate across multiple charts at once
  // (Swarm portfolio debate, per-chart pattern detection, cross-asset
  // backtest). Skills that don't understand dataset_ids fall back to
  // dataset_id (the focused window) like before.
  const collectDatasetIds = (): string[] => {
    const windows = useStore.getState().chartWindows;
    return windows
      .map((w) => w.datasetId)
      .filter((id): id is string => Boolean(id));
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    patchStep(i, { status: "running" });
    patchTrace({ title: `Running step ${i + 1}/${steps.length}` });

    // Refresh the multi-chart list on every step — earlier steps may
    // have added or removed windows (e.g. data_fetcher spawns one per
    // fetched ticker).
    const currentDatasetIds = collectDatasetIds();
    if (currentDatasetIds.length > 0) {
      accumulatedContext.dataset_ids = currentDatasetIds;
    }

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

      // Wait for tool calls to settle. data.dataset.add triggers an async
      // syncDatasetToBackend — the next step (e.g. swarm_intelligence) needs
      // the data in the backend store before it can run. Wait up to 5 seconds
      // for the sync to complete by checking if the dataset appears.
      if (step.skill === "data_fetcher") {
        const dsId = useStore.getState().activeDataset;
        if (dsId) {
          for (let wait = 0; wait < 20; wait++) {
            await new Promise((r) => setTimeout(r, 250));
            if (useStore.getState().syncedDatasets.has(dsId)) break;
          }
        }
      } else {
        await new Promise((r) => setTimeout(r, 250));
      }

      let resultSummary = "";

      // ─── Auto-run pattern scripts — across EVERY canvas chart ─────────
      // Multi-chart mode: the same generated pattern script is executed
      // against each loaded dataset, and matches are stored per-dataset
      // so every ChartWindow renders ONLY its own detections.
      // Single-chart fallback: if the canvas has 0 or 1 windows, runs
      // against the focused chart's data like before.
      if (result.script && (result.script_type === "pattern" || step.skill === "pattern")) {
        const state = useStore.getState();
        const windowsWithData = state.chartWindows
          .map((w) => {
            const dsid = w.datasetId;
            const bars = dsid ? state.datasetChartData[dsid] : undefined;
            return dsid && bars && bars.length > 0
              ? { datasetId: dsid, bars, window: w }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);

        // Track if the Error Handler Agent replaced the script so we
        // can load the fixed version into the editor AFTER the run.
        let effectiveScript = result.script;
        let fixNote: string | null = null;

        if (windowsWithData.length === 0) {
          // Fall back to the legacy chartData check for single-chart mode
          const chartData = state.chartData;
          if (!chartData || chartData.length === 0) {
            resultSummary = "no dataset on chart — skipped run";
          } else {
            try {
              const out = await runPatternScriptWithAutoFix(
                result.script, chartData, step.message,
              );
              state.setPatternMatches(out.matches);
              state.setLastScriptResult({ ran: true });
              resultSummary =
                `found ${out.matches.length} pattern match${out.matches.length !== 1 ? "es" : ""}` +
                (out.fixedScript ? " (auto-fixed after initial error)" : "");
              accumulatedContext.pattern_matches_count = out.matches.length;
              if (out.fixedScript) {
                effectiveScript = out.fixedScript;
                fixNote = out.fixExplanation;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              state.setLastScriptResult({ ran: true, error: msg });
              patchStep(i, { status: "failed", error: `pattern run failed: ${msg}` });
              continue;
            }
          }
        } else {
          // Multi-chart path: run script on every window's data.
          // Auto-fix runs per-dataset — if the script crashes on the
          // first dataset, the fixed version is used for all remaining
          // datasets too (don't re-fix per dataset; reuse the fix).
          const perDatasetCounts: Array<{ symbol: string; count: number }> = [];
          let totalMatches = 0;
          let anyError: string | null = null;
          let activeScript = result.script;

          for (const { datasetId, bars } of windowsWithData) {
            try {
              const out = await runPatternScriptWithAutoFix(
                activeScript, bars, step.message,
              );
              state.setPatternMatchesForDataset(datasetId, out.matches);
              totalMatches += out.matches.length;
              const ds = state.datasets.find((d) => d.id === datasetId);
              const sym = ds?.metadata?.symbol || ds?.name || "?";
              perDatasetCounts.push({ symbol: String(sym), count: out.matches.length });
              if (out.fixedScript) {
                activeScript = out.fixedScript;
                effectiveScript = out.fixedScript;
                if (!fixNote) fixNote = out.fixExplanation;
              }
            } catch (err) {
              anyError = err instanceof Error ? err.message : String(err);
              break;
            }
          }

          if (anyError) {
            state.setLastScriptResult({ ran: true, error: anyError });
            patchStep(i, { status: "failed", error: `pattern run failed: ${anyError}` });
            continue;
          }

          state.setLastScriptResult({ ran: true });
          accumulatedContext.pattern_matches_count = totalMatches;

          const fixSuffix = fixNote ? " (auto-fixed after initial error)" : "";
          if (perDatasetCounts.length === 1) {
            const { symbol, count } = perDatasetCounts[0];
            resultSummary =
              `found ${count} pattern match${count !== 1 ? "es" : ""} on ${symbol}${fixSuffix}`;
          } else {
            const breakdown = perDatasetCounts
              .map(({ symbol, count }) => `${symbol}:${count}`)
              .join(", ");
            resultSummary =
              `${totalMatches} total matches across ${perDatasetCounts.length} charts (${breakdown})${fixSuffix}`;
          }
        }

        // If a fix was applied, replace the script in the editor with
        // the corrected version so the user can see what changed +
        // keep using it for future runs.
        if (effectiveScript !== result.script) {
          runToolCalls(
            [{ tool: "script_editor.load", value: effectiveScript }],
            step.skill,
            ["script_editor.load"],
          );
          if (fixNote) {
            accumulatedContext.pattern_auto_fix_explanation = fixNote;
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
            // Auto-fix on runtime crash — same pattern as
            // runPatternScriptWithAutoFix: try once, on crash POST
            // /fix-script, try with the fix, re-throw on second crash.
            const out = await runStrategyWithAutoFix(
              result.script, chartData, config, step.message,
            );
            const backtest = out.result;
            useStore.getState().setBacktestResults(backtest);
            const winRate = (backtest.winRate * 100).toFixed(1);
            const totalReturn = (backtest.totalReturn * 100).toFixed(1);
            const fixSuffix = out.fixedScript ? " (auto-fixed after initial error)" : "";
            resultSummary =
              `${backtest.totalTrades} trades, ${winRate}% win rate, ${totalReturn}% return${fixSuffix}`;
            accumulatedContext.backtest_summary = {
              totalTrades: backtest.totalTrades,
              winRate: backtest.winRate,
              totalReturn: backtest.totalReturn,
            };

            // Load the fixed script into the editor so the user sees
            // the corrected version + future runs use it.
            if (out.fixedScript) {
              runToolCalls(
                [{ tool: "script_editor.load", value: out.fixedScript }],
                step.skill,
                ["script_editor.load"],
              );
              if (out.fixExplanation) {
                accumulatedContext.strategy_auto_fix_explanation = out.fixExplanation;
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            patchStep(i, { status: "failed", error: `backtest failed: ${msg}` });
            continue;
          }
        }
      }

      // Swarm intelligence summary
      if (!resultSummary && (step.skill === "predict_analysis" || step.skill === "swarm_intelligence")) {
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

      // Always carry the active dataset ID forward so downstream skills
      // (like swarm_intelligence) can find the data in the backend store.
      // Plus the full list of open-window datasets for multi-chart
      // aware skills.
      const currentDataset = useStore.getState().activeDataset;
      if (currentDataset) {
        accumulatedContext.dataset_id = currentDataset;
        accumulatedContext.activeDataset = currentDataset;
      }
      const dsIds = collectDatasetIds();
      if (dsIds.length > 0) {
        accumulatedContext.dataset_ids = dsIds;
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
