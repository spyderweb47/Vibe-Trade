"""
Strategy agent v2 — structured strategy builder.

Generates JavaScript strategy scripts from structured config input,
then analyzes backtest results with improvement suggestions.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion, is_available as llm_available


STRATEGY_GENERATE_PROMPT = """You are a quantitative trading strategy engineer.

Generate a JavaScript strategy script from the user's structured config.

## Config
- Entry: {entry_condition}
- Exit: {exit_condition}
- Take Profit: {tp_type} {tp_value}
- Stop Loss: {sl_type} {sl_value}
- Max Drawdown: {max_drawdown}%
- Seed Amount: ${seed_amount}
- Special: {special}

## Script Requirements
The script receives `data` (array of {{time, open, high, low, close, volume}}) and `config` ({{stopLoss, takeProfit, maxDrawdown, seedAmount}}).

MUST return: {{ trades: [...], equity: [...] }}

Each trade object MUST have ALL these fields:
- type: 'long' or 'short'
- entryIdx: number (bar index of entry)
- exitIdx: number (bar index of exit)
- entryPrice: number
- exitPrice: number
- pnl: number (dollar profit/loss)
- pnlPercent: number (percentage profit/loss)
- reason: string ('signal', 'stop_loss', 'take_profit', 'max_drawdown')
- entryReason: string (why entered)
- exitReason: string (why exited)
- maxAdverseExcursion: number (worst unrealized PnL during trade)
- maxFavorableExcursion: number (best unrealized PnL during trade)
- holdingBars: number (how many bars the trade was held)

equity: array of portfolio value at each bar (starting at seedAmount).

## CRITICAL RULES
- EVERY function you call MUST be defined in the script. Do NOT assume any function exists.
- Always bounds-check array access: never access data[i] where i < 0 or i >= data.length
- Start the main loop at index >= max indicator period (e.g., i = 200 if using SMA200)
- In indicator helpers, return null if not enough data (idx < period)
- Push to equity array on EVERY bar iteration, not just when in a trade
- Use simple for loops: for (let i = 0; i < data.length; i++)
- Track max drawdown and stop trading if exceeded
- Do NOT use import/require/fetch
- Define pnl variable before using it outside trade blocks
- Indicator lookbacks must be relative to current bar index, NOT the end of the array
- Entry conditions should be achievable — avoid conditions that require breaking all-time highs/lows
- The strategy SHOULD produce trades on typical market data. If entry requires rare conditions, loosen them.
- Test your logic mentally: if SMA50 > SMA200 on 40% of bars, the strategy should enter on those bars

## INDICATOR QUALITY RULES
- If you use ANY indicator (RSI, SMA, EMA, ATR, Bollinger, MACD, etc.), you MUST
  define the function yourself in the script. Write it from scratch — do not assume
  any pre-existing function.
- Your indicator implementations MUST handle edge cases: return null for bars before
  the indicator has enough lookback data. Never divide by zero.
- Test your indicator logic mentally: SMA(20) should return null for bars 0-18, then
  the average of bars 0-19 at index 19.
- For EMA: use the standard smoothing formula k = 2/(period+1). Seed with the first close.
- For RSI: use Wilder's smoothing (not simple average). Period 14 is standard.
- Keep indicator functions simple and self-contained — one function per indicator.
- ALWAYS extract closes first: const closes = data.map(d => d.close);

Return ONLY JavaScript code. No markdown fences."""


STRATEGY_ANALYSIS_PROMPT = """You are a trading strategy analyst. Analyze these backtest results and provide:

1. **Overall Assessment** (2-3 sentences): Is this strategy profitable? What's the risk/reward profile?
2. **Strengths**: What works well?
3. **Weaknesses**: What's concerning?
4. **Suggestions**: 3-5 specific improvements the user should try

## Results
- Total Trades: {total_trades}
- Win Rate: {win_rate}%
- Profit Factor: {profit_factor}
- Sharpe Ratio: {sharpe}
- Max Drawdown: {max_drawdown}%
- Total Return: {total_return}%
- Avg Win: ${avg_win}, Avg Loss: ${avg_loss}
- Largest Win: ${largest_win}, Largest Loss: ${largest_loss}
- Win Streak: {win_streak}, Lose Streak: {lose_streak}

## Strategy Config
- Entry: {entry_condition}
- Exit: {exit_condition}
- TP: {tp}, SL: {sl}

Be concise and actionable. Return as JSON:
{{"analysis": "...", "suggestions": ["...", "..."]}}"""


class StrategyAgent:
    def __init__(self, model: str = "gpt-4o-mini") -> None:
        self.model = model

    def generate_from_config(self, config: Dict[str, Any]) -> Dict[str, Any]:
        """Generate a strategy script from structured config."""
        if llm_available():
            return self._generate_with_llm(config)
        return self._generate_mock(config)

    def analyze_results(self, config: Dict[str, Any], metrics: Dict[str, Any]) -> Dict[str, Any]:
        """Analyze backtest results and return suggestions."""
        if llm_available():
            return self._analyze_with_llm(config, metrics)
        return {
            "analysis": "Strategy completed with the given parameters. Review the trade list for details.",
            "suggestions": ["Try adjusting the entry conditions", "Consider different TP/SL ratios", "Test on different timeframes"],
        }

    def _generate_with_llm(self, config: Dict[str, Any]) -> Dict[str, Any]:
        tp = config.get("takeProfit", {})
        sl = config.get("stopLoss", {})

        prompt = STRATEGY_GENERATE_PROMPT.format(
            entry_condition=config.get("entryCondition", ""),
            exit_condition=config.get("exitCondition", ""),
            tp_type=tp.get("type", "percentage"),
            tp_value=tp.get("value", 5),
            sl_type=sl.get("type", "percentage"),
            sl_value=sl.get("value", 2),
            max_drawdown=config.get("maxDrawdown", 20),
            seed_amount=config.get("seedAmount", 10000),
            special=config.get("specialInstructions", "None"),
        )

        script = chat_completion(
            system_prompt=prompt,
            user_message="Generate the strategy script now. Include all indicator functions you need. The script must produce trades on typical market data.",
            model=self.model,
            temperature=0.3,
        )

        # Strip fences
        script = script.strip()
        if script.startswith("```"):
            nl = script.index("\n") if "\n" in script else len(script)
            script = script[nl + 1:]
            if script.endswith("```"):
                script = script[:-3]
            script = script.strip()

        return {"script": script, "explanation": "Strategy script generated from your configuration."}

    def _analyze_with_llm(self, config: Dict[str, Any], metrics: Dict[str, Any]) -> Dict[str, Any]:
        tp = config.get("takeProfit", {})
        sl = config.get("stopLoss", {})

        prompt = STRATEGY_ANALYSIS_PROMPT.format(
            total_trades=metrics.get("totalTrades", 0),
            win_rate=round(metrics.get("winRate", 0) * 100, 1),
            profit_factor=metrics.get("profitFactor", 0),
            sharpe=metrics.get("sharpeRatio", 0),
            max_drawdown=round(metrics.get("maxDrawdown", 0) * 100, 1),
            total_return=round(metrics.get("totalReturn", 0) * 100, 1),
            avg_win=round(metrics.get("avgWin", 0), 2),
            avg_loss=round(metrics.get("avgLoss", 0), 2),
            largest_win=round(metrics.get("largestWin", 0), 2),
            largest_loss=round(metrics.get("largestLoss", 0), 2),
            win_streak=metrics.get("winStreak", 0),
            lose_streak=metrics.get("loseStreak", 0),
            entry_condition=config.get("entryCondition", ""),
            exit_condition=config.get("exitCondition", ""),
            tp=f"{tp.get('type', 'percentage')} {tp.get('value', 5)}",
            sl=f"{sl.get('type', 'percentage')} {sl.get('value', 2)}",
        )

        response = chat_completion(
            system_prompt=prompt,
            user_message="Analyze now.",
            model=self.model,
            temperature=0.3,
            max_tokens=500,
        )

        try:
            cleaned = response.strip()
            if cleaned.startswith("```"):
                nl = cleaned.index("\n") if "\n" in cleaned else len(cleaned)
                cleaned = cleaned[nl + 1:]
                if cleaned.endswith("```"):
                    cleaned = cleaned[:-3]
                cleaned = cleaned.strip()
            result = json.loads(cleaned)
            return result
        except json.JSONDecodeError:
            return {"analysis": response, "suggestions": []}

    def _generate_mock(self, config: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "script": MOCK_STRATEGY,
            "explanation": "Generated a simple EMA crossover strategy. Click Run to test it.",
        }


MOCK_STRATEGY = """const trades = [];
const equity = [];
let capital = config.seedAmount || 10000;
let position = null;
const slPct = config.stopLoss / 100;
const tpPct = config.takeProfit / 100;
const maxDD = config.maxDrawdown / 100;
let peakCapital = capital;

function ema(closes, period) {
  const k = 2 / (period + 1);
  const r = [closes[0]];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] * k + r[i-1] * (1-k));
  return r;
}

const closes = data.map(d => d.close);
const ema9 = ema(closes, 9);
const ema21 = ema(closes, 21);

for (let i = 21; i < data.length; i++) {
  const dd = (peakCapital - capital) / peakCapital;
  if (dd > maxDD) { equity.push(capital); continue; }

  if (position) {
    const pnlPct = position.type === 'long'
      ? (data[i].close - position.ep) / position.ep
      : (position.ep - data[i].close) / position.ep;
    const mae = position.type === 'long'
      ? (Math.min(...data.slice(position.ei, i+1).map(d=>d.low)) - position.ep) / position.ep
      : (position.ep - Math.max(...data.slice(position.ei, i+1).map(d=>d.high))) / position.ep;
    const mfe = position.type === 'long'
      ? (Math.max(...data.slice(position.ei, i+1).map(d=>d.high)) - position.ep) / position.ep
      : (position.ep - Math.min(...data.slice(position.ei, i+1).map(d=>d.low))) / position.ep;

    let exit = false, reason = '', exitReason = '';
    if (pnlPct <= -slPct) { exit = true; reason = 'stop_loss'; exitReason = 'Stop loss hit'; }
    else if (pnlPct >= tpPct) { exit = true; reason = 'take_profit'; exitReason = 'Take profit reached'; }
    else if (position.type === 'long' && ema9[i] < ema21[i]) { exit = true; reason = 'signal'; exitReason = 'EMA bearish crossover'; }
    else if (position.type === 'short' && ema9[i] > ema21[i]) { exit = true; reason = 'signal'; exitReason = 'EMA bullish crossover'; }

    if (exit) {
      const pnl = capital * pnlPct;
      capital += pnl;
      if (capital > peakCapital) peakCapital = capital;
      trades.push({
        type: position.type, entryIdx: position.ei, exitIdx: i,
        entryPrice: position.ep, exitPrice: data[i].close,
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(pnlPct * 10000) / 100,
        reason, entryReason: position.er, exitReason,
        maxAdverseExcursion: Math.round(mae * 10000) / 100,
        maxFavorableExcursion: Math.round(mfe * 10000) / 100,
        holdingBars: i - position.ei
      });
      position = null;
    }
  }

  if (!position) {
    if (ema9[i] > ema21[i] && ema9[i-1] <= ema21[i-1]) {
      position = { type: 'long', ei: i, ep: data[i].close, er: 'EMA 9 crossed above EMA 21' };
    } else if (ema9[i] < ema21[i] && ema9[i-1] >= ema21[i-1]) {
      position = { type: 'short', ei: i, ep: data[i].close, er: 'EMA 9 crossed below EMA 21' };
    }
  }

  equity.push(capital + (position ? capital * ((position.type === 'long'
    ? (data[i].close - position.ep) / position.ep
    : (position.ep - data[i].close) / position.ep)) : 0));
}
return { trades, equity };"""
