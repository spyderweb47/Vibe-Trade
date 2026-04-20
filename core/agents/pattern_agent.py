"""
Pattern & indicator agent.

Converts natural-language descriptions into JavaScript scripts for either
pattern detection or custom indicator calculation, running in the browser.

Uses OpenAI when available, falls back to keyword-matched example scripts.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from core.agents.llm_client import chat_completion, is_available as llm_available


# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

PATTERN_SYSTEM_PROMPT = """You are a quantitative trading pattern detection engineer.

Given a natural-language hypothesis about a price pattern, generate a JavaScript
script that detects occurrences of that pattern in OHLC data.

## Environment
- The script receives an array called `data` where each element is an object:
  { time: number, open: number, high: number, low: number, close: number, volume: number }
- `data` is sorted by time ascending. `time` is a unix timestamp in seconds.
- The script MUST populate an array called `results` with objects, where each object
  has the keys: start_idx (number), end_idx (number), confidence (number 0-1),
  pattern_type (string).
- You have access to: Math.min, Math.max, Math.abs, Math.round, Math.sqrt, Math.floor, Math.ceil.
- Do NOT use import, require, fetch, XMLHttpRequest, eval, Function, or any DOM APIs.
- Do NOT use async/await or Promises.

## CRITICAL RULES
1. WRITE A FLAT TOP-LEVEL SCRIPT. Do NOT wrap your logic in an outer function like
   `const detectPattern = (data) => { ... }` or `function detect(data) { ... }`.
   The `data` variable is already injected as a function argument — your script
   runs inside `new Function("data", "Math", YOUR_CODE)`. Write code at the top level.
2. Always initialize at the TOP SCOPE: const results = [];
3. Use array index access: data[i].close, data[i].open, etc.
4. Use for loops: for (let i = 0; i < data.length; i++) { ... }
5. Include a confidence score (0.0 to 1.0) based on pattern quality. Do NOT hardcode 1.0 —
   vary it with some measurable quality signal (e.g. candle body ratio, volume relative
   to average, pattern depth, etc.).
6. Handle edge cases: check data.length >= minimum required bars.
7. Keep the script concise — under 50 lines of logic.
8. Use helper variables for readability: const closes = data.map(d => d.close);
9. End the script with: return results;
10. THRESHOLDS MUST BE FORGIVING. Real market data is noisy, so strict thresholds
    (e.g. correlation > 0.85, or exact fibonacci levels) will find ZERO matches on
    5000-bar datasets. This is a fatal UX bug — users see nothing and assume the
    detector is broken.
    - For correlation-based matching (SHAPE / fingerprint patterns), use a threshold
      of 0.50 — NOT 0.7+. Below 0.50 is unlikely to be the same pattern.
    - For tolerance-based matching (price level similarity), use 3-5% — NOT 1%.
    - Confidence should be the raw quality score (e.g. correlation value), not
      artificially inflated.

11. MANDATORY TOP-K FALLBACK. Every script MUST include a programmatic safety net
    so the user always has results to look at. The pattern is:

    a) Maintain an `allCandidates` array OUTSIDE the loop, at top scope.
    b) Inside the loop, AT THE TOP — before any branching — declare a local
       `score` variable. Push EVERY evaluated position into `allCandidates`
       BEFORE deciding whether it passes the threshold:

       ```javascript
       const allCandidates = [];   // top scope, before the loop
       for (let i = 0; i < data.length; i++) {
         const score = computeScore(i);   // ALWAYS declare score here
         allCandidates.push({
           start_idx: i,
           end_idx: i + windowSize - 1,
           confidence: score,             // EXPLICIT key:value, not shorthand
           pattern_type: 'my_pattern'
         });
         if (score >= 0.50) {
           results.push({
             start_idx: i,
             end_idx: i + windowSize - 1,
             confidence: score,
             pattern_type: 'my_pattern'
           });
         }
       }
       ```

    c) After the loop, fall back to top-K if too few passed:

       ```javascript
       if (results.length < 5 && allCandidates.length > 0) {
         allCandidates.sort((a, b) => b.confidence - a.confidence);
         const seen = new Set(results.map(r => r.start_idx));
         for (const c of allCandidates) {
           if (results.length >= 5) break;
           if (!seen.has(c.start_idx)) results.push(c);
         }
       }
       ```

    Skipping this fallback is forbidden.

12. NEVER USE OBJECT PROPERTY SHORTHAND for `confidence`. ALWAYS write the
    explicit `confidence: <localVarName>` form. Object shorthand `{ confidence }`
    only works if a variable named `confidence` is in scope at that exact point —
    if you declared `const score = ...` and then wrote `{ confidence }` you'll
    get "ReferenceError: confidence is not defined". The explicit form `confidence: score`
    is safer in every scope. This rule is non-negotiable.

13. AVOID OVERLAPPING DUPLICATES. If your detector emits many near-identical matches
    (e.g. consecutive bars all firing the same pattern), keep only the highest-confidence
    one in any cluster. Greedy non-max suppression: walk results sorted by confidence,
    keep one if no kept result already covers ≥ 50% of its bar range.

14. OPTIONAL PER-MATCH DRAWINGS. A bounding box alone is often too coarse for
    geometric patterns — head-and-shoulders has three peaks + a neckline,
    double-top has two peaks and a horizontal resistance line, harmonics
    have fibonacci retracement legs. You can attach annotations to any
    match by including a `drawings` array on the result object:

    ```javascript
    results.push({
      start_idx: leftShoulderIdx,
      end_idx: rightShoulderIdx,
      confidence: score,
      pattern_type: 'head_and_shoulders',
      drawings: [
        // Neckline connecting left shoulder low and right shoulder low
        { type: 'trendline',
          points: [
            { idx: leftShoulderIdx, price: lsLow },
            { idx: rightShoulderIdx, price: rsLow }
          ],
          label: 'neckline',
          dashed: true },
        // Peaks labeled
        { type: 'point', idx: leftShoulderIdx,  price: lsHigh, label: 'LS' },
        { type: 'point', idx: headIdx,          price: headHigh, label: 'H' },
        { type: 'point', idx: rightShoulderIdx, price: rsHigh, label: 'RS' },
      ],
    });
    ```

    Available drawing types (all fields strictly typed — the renderer
    silently drops malformed entries):

      - `trendline`:       { type, points: [{idx,price}, {idx,price}], color?, label?, dashed? }
      - `horizontal_line`: { type, price, start_idx?, end_idx?, color?, label?, dashed? }
      - `point`:           { type, idx, price, label?, color? }
      - `label`:           { type, idx, price, text, color? }
      - `fibonacci`:       { type, points: [{idx,price}, {idx,price}], levels? (array of 0-1 floats) }

    Rules for using drawings:
    - OMIT `drawings` when the bounding box alone tells the story (e.g. a
      generic bullish-engulfing candle pattern — the box IS the pattern).
    - ADD drawings when the pattern has SPECIFIC geometric elements the user
      wants to see called out (necklines, support/resistance, fib levels,
      named peaks/troughs).
    - All `idx` values MUST be valid indices into `data`. Out-of-range
      drawings are dropped silently but waste tokens.
    - Keep labels short — "LS", "H", "RS", "resistance", "neckline", etc.
    - Don't over-annotate: 3-6 drawings per match is usually enough. More
      clutters the chart.
    - Colors are optional — if omitted, the drawing uses the match's
      direction colour (green for bullish, red for bearish, orange for neutral).

## SHAPE / fingerprint patterns (CRITICAL)

A fingerprint request looks like this:

```
Find this 275-bar pattern (scale-free):
SHAPE: [0.06, 0.43, 0.33, ..., 0.89]   (16 values — the COMPRESSED signature)
Sliding window: 275 bars                (the FULL window size to scan with)
```

**The SHAPE array length and the window size are usually DIFFERENT.** The
shape is a compressed/downsampled signature (~16 points); the window is the
real bar range to scan (~275 bars). Comparing them naively with Pearson
correlation will silently fail (mismatched lengths → garbage scores → 0
matches). You MUST resample the window down to the shape's length before
correlating.

### PRE-INJECTED HELPERS — DO NOT REDEFINE

The following functions are **pre-injected into the runtime** and available
as globals. **Never define your own versions — call them directly:**

- `pearson(a, b)` — Pearson correlation between two equal-length arrays
- `resampleTo(arr, targetLen)` — linear-interpolation resample to a new length
- `normalizeMinMax(arr)` — normalize an array to [0, 1] via min-max scaling

If you write your own `function pearson(...)` you will be silently stripped
out and the pre-injected version used anyway, so don't waste tokens on it.

### Use the EXACT template below — adapt only the constants:

```javascript
const results = [];
const allCandidates = [];
const closes = data.map(d => d.close);

// READ FROM THE USER MESSAGE:
const targetShape = [/* paste the SHAPE: array here */];
const WINDOW = 275;                      // from "Sliding window: N bars"
const SHAPE_LEN = targetShape.length;    // e.g. 16
const stride = Math.max(1, Math.floor(WINDOW / 20));   // ~5% step
const threshold = 0.55;                  // from RULES, OR default 0.50

if (data.length < WINDOW) return results;

// pearson() and resampleTo() are pre-injected — call them, don't redefine.

for (let i = 0; i + WINDOW <= data.length; i += stride) {
  const win = closes.slice(i, i + WINDOW);
  const normalized = normalizeMinMax(win);          // pre-injected helper

  // CRITICAL: resample down to the shape's length BEFORE correlating
  const resampled = resampleTo(normalized, SHAPE_LEN);
  const score = pearson(resampled, targetShape);

  // ALWAYS push to allCandidates first, BEFORE the threshold check.
  // Use EXPLICIT confidence: score, NEVER shorthand { confidence }.
  allCandidates.push({
    start_idx: i,
    end_idx: i + WINDOW - 1,
    confidence: score,
    pattern_type: 'shape_match'
  });

  if (score >= threshold) {
    results.push({
      start_idx: i,
      end_idx: i + WINDOW - 1,
      confidence: score,
      pattern_type: 'shape_match'
    });
  }
}

// Mandatory fallback — fill to top 8 if threshold was too strict
const TARGET_COUNT = 8;
if (results.length < TARGET_COUNT && allCandidates.length > 0) {
  allCandidates.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set(results.map(r => r.start_idx));
  for (const c of allCandidates) {
    if (results.length >= TARGET_COUNT) break;
    if (!seen.has(c.start_idx)) results.push(c);
  }
}

// Non-max suppression — sliding windows overlap 90%+ at small strides, so
// "any overlap" would collapse everything to one. Suppress only if a kept
// match covers ≥ 70% of the candidate AND has a higher score.
results.sort((a, b) => b.confidence - a.confidence);
const kept = [];
for (const r of results) {
  const rDur = r.end_idx - r.start_idx + 1;
  const dominated = kept.some(k => {
    const overlap = Math.max(0, Math.min(k.end_idx, r.end_idx) - Math.max(k.start_idx, r.start_idx) + 1);
    return (overlap / rDur) >= 0.70 && k.confidence > r.confidence;
  });
  if (!dominated) kept.push(r);
}

// NMS floor: never return fewer than min(5, results.length) — if NMS was too
// aggressive, fall back to the pre-NMS top-K by confidence.
const MIN_KEEP = Math.min(5, results.length);
if (kept.length < MIN_KEEP) {
  return results.slice(0, MIN_KEEP);
}
return kept;
```

Adapt this template — don't reinvent it. Specifically:
- Replace `targetShape = [...]` with the numbers from the SHAPE: line
- Replace `WINDOW = 275` with the value from "Sliding window: N bars"
- Replace `threshold = 0.55` with the value from the user's RULES (default 0.50)
- Keep `pearson()`, `resampleTo()`, the loop structure, the fallback, the NMS,
  and the MIN_KEEP floor EXACTLY as written.

Fingerprints should ALWAYS return at least 5 candidates on any dataset
larger than the window. If your output has fewer, your template is wrong.

## Example of the CORRECT shape

```javascript
// ✅ Flat script — `results` and `data` are at top scope
const results = [];
const closes = data.map(d => d.close);

if (data.length < 5) return results;

for (let i = 1; i < data.length - 1; i++) {
  // ... pattern check using closes[i-1], closes[i], closes[i+1] ...
  if (isPattern) {
    const confidence = Math.min(1, someQualityMetric);
    results.push({ start_idx: i - 1, end_idx: i + 1, confidence, pattern_type: 'my_pattern' });
  }
}

return results;
```

## Example of the WRONG shape

```javascript
// ❌ Function-wrapped — `results` is trapped inside, outer `return results;` fails
const detectPattern = (data) => {
  const results = [];
  // ...
  return results;
};
// Script ends here — no call to detectPattern, and the executor's
// appended `return results;` throws ReferenceError
```

## PATTERN GENERATION GUIDELINES
- You are an expert quantitative engineer. The user will describe ANY trading pattern
  — classic (head and shoulders, double top), modern (fair value gap, order block,
  liquidity sweep), or completely custom. You know them ALL.
- Research the pattern's precise mathematical definition before writing code.
  Think step by step: what are the exact conditions? What price relationships matter?
  What constitutes a "significant" instance vs noise?
- Use ADAPTIVE thresholds based on the data itself (e.g. compute ATR or standard
  deviation from the data, then size your thresholds relative to that). Never hardcode
  absolute price levels or fixed percentage thresholds.
- For any indicator you need (ATR, SMA, RSI, etc.), define the function yourself
  in the script. Write it correctly from scratch.
- The confidence score should reflect actual pattern quality — body ratios, volume
  confirmation, how cleanly the geometry matches. Not a constant.
- Your detection logic should be robust across different assets (crypto, stocks,
  forex, commodities) and timeframes (1m to 1mo). The same pattern looks different
  at different scales — use relative measurements, not absolute.

## Output format
Return ONLY the JavaScript code. No markdown fences, no explanations outside comments."""


INDICATOR_SYSTEM_PROMPT = """You are a quantitative trading indicator engineer.

Given a natural-language description of a technical indicator, generate a JavaScript
script that computes the indicator values for OHLC data.

## Environment
- The script receives an array called `data` where each element is an object:
  { time: number, open: number, high: number, low: number, close: number, volume: number }
- The script receives a `params` object with user-configurable parameters.
- `data` is sorted by time ascending. `time` is a unix timestamp in seconds.
- The script MUST return an array of numbers (or null for insufficient data), one per bar.
  Example: return data.map((d, i) => i < period - 1 ? null : computedValue);
- You have access to: Math.min, Math.max, Math.abs, Math.round, Math.sqrt, Math.floor, Math.ceil.
- Do NOT use import, require, fetch, XMLHttpRequest, eval, Function, or any DOM APIs.
- Do NOT use async/await or Promises.

## CRITICAL RULES
1. WRITE A FLAT TOP-LEVEL SCRIPT. Do NOT wrap your logic in an outer function like
   `const calc = (data, params) => { ... }`. The `data` and `params` variables are
   already injected — your script runs inside `new Function("data", "params", "Math", YOUR_CODE)`.
2. Initialize output at TOP SCOPE: const values = new Array(data.length).fill(null);
3. Access params for tunable settings: const period = params.period || 20;
4. Use array index access: data[i].close, data[i].high, etc.
5. Return null for bars before the indicator has enough data to compute.
6. Handle edge cases: check data.length >= minimum required bars.
7. Keep the script concise — under 40 lines.
8. End the script with: return values;

## Common parameter names to use
- period: lookback window length (default depends on indicator)
- source: which price to use ('close', 'high', 'low', 'open') — access via data[i][source]
- multiplier: scaling factor for bands/channels
- smoothing: smoothing type or factor

## Output format
Return ONLY the JavaScript code. No markdown fences, no explanations outside comments."""


PINE_CONVERT_PROMPT = """You are a TradingView Pine Script to JavaScript converter.

Convert the given Pine Script indicator/strategy into a JavaScript indicator script.

## Target Environment
- The script receives `data` array: each element is { time, open, high, low, close, volume }
- The script receives `params` object for tunable parameters
- Must return an array of (number | null), one value per bar
- Access: Math.min, Math.max, Math.abs, Math.round, Math.sqrt, Math.floor, Math.ceil
- No import, require, fetch, or DOM APIs

## Conversion Rules
1. Pine `input()` → extract as `params.paramName || defaultValue`
2. Pine `sma(src, len)` → implement as rolling mean
3. Pine `ema(src, len)` → implement as exponential moving average: alpha = 2/(len+1)
4. Pine `rsi(src, len)` → implement Wilder's RSI
5. Pine `stdev(src, len)` → implement rolling standard deviation
6. Pine `crossover(a, b)` → `a[i] > b[i] && a[i-1] <= b[i-1]`
7. Pine `crossunder(a, b)` → `a[i] < b[i] && a[i-1] >= b[i-1]`
8. Pine `close`, `open`, `high`, `low`, `volume` → `data[i].close` etc.
9. Pine `close[1]` → `data[i-1].close`
10. For strategies with entry/exit signals, return the main indicator line (e.g., Bollinger basis)
11. Initialize: `const values = new Array(data.length).fill(null);`
12. End with: `return values;`

## Important
- Return the MAIN visual line of the indicator (the one most useful on a price chart)
- If the indicator has multiple lines (e.g., Bollinger upper/middle/lower), return the middle/basis line
- Extract ALL tunable parameters from Pine `input()` calls into `params`

## Output
Return ONLY JavaScript code. No markdown fences, no explanations."""


# ---------------------------------------------------------------------------
# Example scripts
# ---------------------------------------------------------------------------

EXAMPLE_DOUBLE_BOTTOM = '''// Double Bottom Pattern Detection
const results = [];
const window = 20;
const tolerance = 0.02;
const n = data.length;

if (n >= window * 2) {
  const lows = data.map(d => d.low);
  const highs = data.map(d => d.high);

  for (let i = window; i < n - window; i++) {
    let leftMin = lows[i - window], leftIdx = i - window;
    for (let j = i - window + 1; j < i; j++) {
      if (lows[j] < leftMin) { leftMin = lows[j]; leftIdx = j; }
    }
    let rightMin = lows[i], rightIdx = i;
    for (let j = i + 1; j < i + window && j < n; j++) {
      if (lows[j] < rightMin) { rightMin = lows[j]; rightIdx = j; }
    }
    if (leftMin === 0) continue;
    const diffPct = Math.abs(leftMin - rightMin) / leftMin;
    if (diffPct <= tolerance) {
      let midHigh = highs[leftIdx];
      for (let j = leftIdx + 1; j <= rightIdx; j++) {
        if (highs[j] > midHigh) midHigh = highs[j];
      }
      if (midHigh > leftMin * (1 + tolerance * 2)) {
        const confidence = Math.max(0, 1 - diffPct / tolerance);
        results.push({
          start_idx: leftIdx, end_idx: rightIdx,
          confidence: Math.round(confidence * 1000) / 1000,
          pattern_type: "double_bottom"
        });
      }
    }
  }
}
return results;'''

EXAMPLE_BULLISH_ENGULFING = '''// Bullish Engulfing Pattern Detection
const results = [];

for (let i = 1; i < data.length; i++) {
  const prev = data[i - 1];
  const curr = data[i];
  const prevBearish = prev.close < prev.open;
  const currBullish = curr.close > curr.open;

  if (prevBearish && currBullish) {
    const engulfs = curr.open <= prev.close && curr.close >= prev.open;
    if (engulfs) {
      const prevBody = Math.abs(prev.open - prev.close);
      const currBody = Math.abs(curr.close - curr.open);
      const ratio = prevBody > 0 ? currBody / prevBody : 1;
      const confidence = Math.min(1, ratio / 2);
      results.push({
        start_idx: i - 1, end_idx: i,
        confidence: Math.round(confidence * 1000) / 1000,
        pattern_type: "bullish_engulfing"
      });
    }
  }
}
return results;'''

EXAMPLE_VOLUME_BREAKOUT = '''// Volume Breakout Pattern Detection
const results = [];
const lookback = 20;
const volMultiplier = 2.0;
const n = data.length;

if (n >= lookback + 1) {
  for (let i = lookback; i < n; i++) {
    let resistance = data[i - lookback].high;
    let volSum = 0;
    for (let j = i - lookback; j < i; j++) {
      if (data[j].high > resistance) resistance = data[j].high;
      volSum += data[j].volume;
    }
    const avgVol = volSum / lookback;
    if (data[i].close > resistance && avgVol > 0) {
      const volRatio = data[i].volume / avgVol;
      if (volRatio >= volMultiplier) {
        const confidence = Math.min(1, volRatio / (volMultiplier * 2));
        results.push({
          start_idx: i - lookback, end_idx: i,
          confidence: Math.round(confidence * 1000) / 1000,
          pattern_type: "volume_breakout"
        });
      }
    }
  }
}
return results;'''

EXAMPLE_CUSTOM_SMA = '''// Custom SMA Indicator
const period = params.period || 20;
const values = new Array(data.length).fill(null);
const closes = data.map(d => d.close);

let sum = 0;
for (let i = 0; i < data.length; i++) {
  sum += closes[i];
  if (i >= period) sum -= closes[i - period];
  if (i >= period - 1) values[i] = sum / period;
}
return values;'''

EXAMPLE_CUSTOM_ENVELOPE = '''// Price Envelope (Channel) Indicator
const period = params.period || 20;
const pct = params.percentage || 2.5;
const values = new Array(data.length).fill(null);
const closes = data.map(d => d.close);

let sum = 0;
for (let i = 0; i < data.length; i++) {
  sum += closes[i];
  if (i >= period) sum -= closes[i - period];
  if (i >= period - 1) {
    const sma = sum / period;
    // Return upper band (for lower band user can negate percentage)
    values[i] = sma * (1 + pct / 100);
  }
}
return values;'''

EXAMPLE_PATTERN_SCRIPTS: Dict[str, str] = {
    "double_bottom": EXAMPLE_DOUBLE_BOTTOM,
    "bullish_engulfing": EXAMPLE_BULLISH_ENGULFING,
    "volume_breakout": EXAMPLE_VOLUME_BREAKOUT,
}

EXAMPLE_INDICATOR_SCRIPTS: Dict[str, str] = {
    "sma": EXAMPLE_CUSTOM_SMA,
    "envelope": EXAMPLE_CUSTOM_ENVELOPE,
}

# Keywords that indicate an EXPLICIT indicator creation request.
INDICATOR_KEYWORDS = [
    "create indicator", "create an indicator", "create a indicator",
    "custom indicator", "build indicator", "build an indicator",
    "make indicator", "make an indicator", "new indicator",
    "create oscillator", "build oscillator",
]

# Pine Script detection markers
PINE_SCRIPT_MARKERS = [
    "//@version=", "strategy(", "indicator(", "study(",
    "strategy.entry", "strategy.close", "strategy.exit",
    "plot(", "plotshape(", "barcolor(", "bgcolor(",
    "input(", "ta.sma", "ta.ema", "ta.rsi", "ta.bb",
    "crossover(", "crossunder(", "sma(", "ema(", "rsi(",
]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

class PatternAgent:
    """
    Agent that generates JavaScript scripts for pattern detection
    or custom indicator calculation.
    """

    def __init__(self, model: str = "gpt-4o-mini") -> None:
        self.model = model

    def generate(self, hypothesis: str) -> Dict[str, Any]:
        script_type = self._detect_type(hypothesis)
        if llm_available():
            return self._generate_with_llm(hypothesis, script_type)
        return self._generate_mock(hypothesis, script_type)

    @staticmethod
    def _detect_type(text: str) -> str:
        """Detect whether the user wants a pattern, indicator, or Pine Script conversion."""
        # Check for Pine Script first (highest priority)
        for marker in PINE_SCRIPT_MARKERS:
            if marker in text:
                return "pine_convert"
        lower = text.lower()
        for kw in INDICATOR_KEYWORDS:
            if kw in lower:
                return "indicator"
        return "pattern"

    def _generate_with_llm(self, hypothesis: str, script_type: str) -> Dict[str, Any]:
        if script_type == "pine_convert":
            prompt = PINE_CONVERT_PROMPT
            effective_type = "indicator"
        elif script_type == "indicator":
            prompt = INDICATOR_SYSTEM_PROMPT
            effective_type = "indicator"
        else:
            prompt = PATTERN_SYSTEM_PROMPT
            effective_type = "pattern"

        script = chat_completion(
            system_prompt=prompt,
            user_message=hypothesis,
            model=self.model,
            temperature=0.3,
        )
        script = _strip_code_fences(script)

        explain_context = "Pine Script conversion to JavaScript indicator" if script_type == "pine_convert" else (
            "indicator" if effective_type == "indicator" else "pattern detection"
        )
        explanation = chat_completion(
            system_prompt=(
                f"You are a trading analyst. Explain the following JavaScript "
                f"{explain_context} script in 2-3 sentences. What does it compute and how?"
            ),
            user_message=script,
            model=self.model,
            temperature=0.3,
            max_tokens=300,
        )

        result = {
            "script": script,
            "script_type": effective_type,
            "explanation": explanation,
            "parameters": self._extract_parameters(script),
            "indicators_used": self._extract_indicators(script),
        }

        # For indicators, also extract the default param values and a short name
        if script_type == "indicator":
            result["default_params"] = self._extract_default_params(script)
            # Ask LLM for a concise 2-3 word name
            if llm_available():
                name = chat_completion(
                    system_prompt="Return ONLY a short 2-3 word name for this indicator. No quotes, no punctuation. Example: Weighted MA, Hull EMA, Volume Ratio",
                    user_message=hypothesis,
                    model=self.model,
                    temperature=0.1,
                    max_tokens=20,
                ).strip().strip("'\".")
                result["indicator_name"] = name or self._infer_indicator_name(hypothesis)
            else:
                result["indicator_name"] = self._infer_indicator_name(hypothesis)

        return result

    def _generate_mock(self, hypothesis: str, script_type: str) -> Dict[str, Any]:
        if script_type == "pine_convert" or script_type == "indicator":
            script, name = self._match_indicator_example(hypothesis)
            return {
                "script": script,
                "script_type": "indicator",
                "explanation": (
                    f"Generated custom indicator for: '{hypothesis}'. "
                    f"Uses the '{name}' template."
                ),
                "parameters": self._extract_parameters(script),
                "indicators_used": [],
                "default_params": self._extract_default_params(script),
                "indicator_name": self._infer_indicator_name(hypothesis),
            }
        else:
            script, pattern_name = self._match_pattern_example(hypothesis)
            return {
                "script": script,
                "script_type": "pattern",
                "explanation": (
                    f"Generated pattern detection for: '{hypothesis}'. "
                    f"Uses the '{pattern_name}' template."
                ),
                "parameters": self._extract_parameters(script),
                "indicators_used": self._extract_indicators(script),
            }

    @staticmethod
    def _match_pattern_example(hypothesis: str) -> tuple[str, str]:
        h = hypothesis.lower()
        if any(kw in h for kw in ["double bottom", "two troughs", "w pattern"]):
            return EXAMPLE_DOUBLE_BOTTOM, "double_bottom"
        if any(kw in h for kw in ["engulfing", "bullish candle", "candle pattern"]):
            return EXAMPLE_BULLISH_ENGULFING, "bullish_engulfing"
        if any(kw in h for kw in ["volume", "breakout", "spike"]):
            return EXAMPLE_VOLUME_BREAKOUT, "volume_breakout"
        return EXAMPLE_BULLISH_ENGULFING, "bullish_engulfing"

    @staticmethod
    def _match_indicator_example(hypothesis: str) -> tuple[str, str]:
        h = hypothesis.lower()
        if any(kw in h for kw in ["envelope", "channel", "band"]):
            return EXAMPLE_CUSTOM_ENVELOPE, "envelope"
        return EXAMPLE_CUSTOM_SMA, "sma"

    @staticmethod
    def _extract_parameters(script: str) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        for match in re.finditer(r'const\s+(\w+)\s*=\s*(\d+\.?\d*)', script):
            name, value = match.group(1), match.group(2)
            if name not in ("results", "values", "n", "i", "j"):
                params[name] = float(value) if "." in value else int(value)
        return params

    @staticmethod
    def _extract_default_params(script: str) -> Dict[str, str]:
        """Extract params.X || default patterns from indicator scripts."""
        params: Dict[str, str] = {}
        for match in re.finditer(r'params\.(\w+)\s*\|\|\s*([^\s;,]+)', script):
            name = match.group(1)
            default = match.group(2).strip("'\"")
            params[name] = default
        return params

    @staticmethod
    def _infer_indicator_name(hypothesis: str) -> str:
        """Infer a short name for the indicator from the hypothesis."""
        h = hypothesis.lower()
        # Remove common filler words
        for word in ["create", "build", "make", "custom", "indicator", "a", "an", "the", "for", "me", "please"]:
            h = h.replace(word, "")
        # Clean up and title-case
        name = h.strip().strip(".,!?")
        if not name:
            name = "custom"
        # Take first 3 meaningful words
        words = [w for w in name.split() if len(w) > 1][:3]
        return " ".join(words).title() if words else "Custom Indicator"

    @staticmethod
    def _extract_indicators(script: str) -> List[str]:
        known = ["sma", "ema", "rsi", "macd", "bollinger", "atr", "vwap"]
        lower = script.lower()
        return [ind for ind in known if ind in lower]


def _strip_code_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        first_nl = text.index("\n") if "\n" in text else len(text)
        text = text[first_nl + 1:]
        if text.endswith("```"):
            text = text[:-3]
    return text.strip()


# ─── Static analyser for the QA loop ────────────────────────────────────────
#
# Used by `_pattern_processor` in `processors.py` via `QASpec.test_fn`. The
# QA verifier agent reads this function's output alongside the script and
# reasons about whether the draft is acceptable.
#
# Deliberately static (no JS execution) — the frontend Web Worker runs the
# script for real once the skill response lands. This is defence-in-depth
# against common LLM mistakes (forgotten `return results`, hardcoded
# confidence=1.0, forbidden APIs, over-strict thresholds) that would cause
# silent "0 matches" failures on the frontend.

_FORBIDDEN_APIS = (
    "import ", "require(", "fetch(", "XMLHttpRequest", "eval(",
    " Function(", "async ", "await ", "Promise", "document.",
    "window.", "localStorage", "sessionStorage",
)

_REQUIRED_PATTERNS = {
    "results_init": r"(const|let|var)\s+results\s*=\s*\[\s*\]",
    # Any for-loop iterating `data` — start index can be 0 or any other
    # value (scripts often start at a minBars offset for the pattern).
    "data_loop": r"for\s*\([^)]*;\s*\w+\s*<\s*data\.length",
    "return_results": r"return\s+results\s*;?",
}


def static_analyse_pattern_script(artifact: Any, _test_data: Any = None) -> Dict[str, Any]:
    """
    Static checks on a generated pattern script. Returns a dict the QA
    verifier agent can reason over; `passed_all` is a quick gate for the
    agent's first read. Verifier reasons beyond this as well (things like
    "is the confidence formula actually varying" are hard to detect
    syntactically).

    Accepts either a str (raw script) or a dict (if the writer returned
    structured output with a "script" key).
    """
    if isinstance(artifact, dict):
        script = str(artifact.get("script") or artifact.get("content") or "")
    else:
        script = str(artifact)
    script = _strip_code_fences(script)

    report: Dict[str, Any] = {
        "script_length_lines": script.count("\n") + 1,
        "script_length_chars": len(script),
    }

    # Forbidden APIs — these are fatal (browser sandbox blocks them)
    forbidden_found = [kw for kw in _FORBIDDEN_APIS if kw in script]
    report["forbidden_apis_found"] = forbidden_found

    # Required structural elements
    structure: Dict[str, bool] = {}
    for name, pat in _REQUIRED_PATTERNS.items():
        structure[name] = bool(re.search(pat, script))
    report["structure"] = structure

    # Confidence sanity — must not be hardcoded to 1.0
    hardcoded_conf_hits = list(re.finditer(
        r"confidence\s*:\s*1(?:\.0+)?\s*[,}]", script,
    ))
    report["hardcoded_confidence_1"] = len(hardcoded_conf_hits)

    # Threshold sanity — flag over-strict correlation thresholds
    overstrict: List[str] = []
    for m in re.finditer(r"(correlation|corr|similarity)\s*>\s*0\.(\d+)", script, re.I):
        thresh = float("0." + m.group(2))
        if thresh >= 0.75:
            overstrict.append(f"{m.group(0)} (>={thresh} is too strict; use 0.50)")
    report["over_strict_thresholds"] = overstrict

    # Pattern detection: populates required keys?
    fills_schema = all(
        k in script
        for k in ("start_idx", "end_idx", "confidence", "pattern_type")
    )
    report["populates_result_schema"] = fills_schema

    # Summary pass/fail
    report["passed_structure"] = all(structure.values())
    report["passed_all"] = (
        report["passed_structure"]
        and not forbidden_found
        and report["hardcoded_confidence_1"] == 0
        and fills_schema
        and report["script_length_lines"] < 120  # sanity cap
    )
    return report


# Natural-language version of the acceptance criteria that gets fed into the
# QA verifier agent. Defines WHAT the verifier should judge beyond the static
# checks (things that need LLM reasoning, not regex).

PATTERN_QA_CRITERIA = """\
The producer has drafted a JavaScript pattern-detection script to run in
a Web Worker. Judge the draft against these requirements:

1. Runs in a sandbox — no imports, no fetch, no async/await, no DOM APIs
2. Structural shape — `const results = []` at top; `for (let i = 0; ...; ...) { ... }`
   iterating `data`; ends with `return results`
3. Each results entry has {start_idx, end_idx, confidence, pattern_type}
4. Confidence is a VARIABLE quality signal (e.g. correlation value,
   body-ratio score) — NOT hardcoded to 1.0
5. Thresholds are FORGIVING — real market data is noisy:
   - correlation-based: threshold around 0.50 (NOT > 0.75)
   - price-tolerance: 3-5% (NOT 1%)
   A script with overly strict thresholds will find zero matches on real
   data — this is a fatal UX bug even though the code "runs"
6. Handles edge cases — checks `data.length >= N` before indexing
7. Logic is concise (under ~60 lines of detector logic — drawings code
   doesn't count against this budget) and readable
8. OPTIONAL drawings API — if the pattern has geometric elements
   (necklines, peaks, support/resistance, fib legs), the script MAY
   attach `drawings: [...]` to each result. Judge these when present:
   - Drawing types must be one of: trendline, horizontal_line, point,
     label, fibonacci
   - All `idx` fields must be in range `[0, data.length)` — hardcoded
     out-of-range indices are a bug (silently dropped at render)
   - 3-6 drawings per match is ideal; more clutters the chart
   - Generic candle patterns (engulfing, doji, hammer) should NOT
     attach drawings — the box is sufficient
   - Patterns with explicit geometry (head-and-shoulders, double-top,
     harmonic XABCD, flag, wedge) benefit from drawings and should
     include them

The programmatic static analysis report accompanying this script lists
concrete issues it could detect (forbidden APIs found, missing
structural elements, over-strict thresholds, hardcoded confidence).
Weight those heavily when judging — they're factual, not stylistic.

Return STRICT JSON:
{
  "passed": bool,
  "severity": "ok" | "minor" | "major" | "critical",
  "issues": [...],
  "suggested_fix": "specific changes the producer should make",
  "confidence": 0-1
}
"""
