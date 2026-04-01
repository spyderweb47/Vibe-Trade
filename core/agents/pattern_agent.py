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
1. Always initialize: const results = [];
2. Use array index access: data[i].close, data[i].open, etc.
3. Use for loops: for (let i = 0; i < data.length; i++) { ... }
4. Include a confidence score (0.0 to 1.0) based on pattern quality.
5. Handle edge cases: check data.length >= minimum required bars.
6. Keep the script concise — under 50 lines of logic.
7. Use helper variables for readability: const closes = data.map(d => d.close);
8. End the script with: return results;

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
1. Initialize output: const values = new Array(data.length).fill(null);
2. Access params for tunable settings: const period = params.period || 20;
3. Use array index access: data[i].close, data[i].high, etc.
4. Return null for bars before the indicator has enough data to compute.
5. Handle edge cases: check data.length >= minimum required bars.
6. Keep the script concise — under 40 lines.
7. End the script with: return values;

## Common parameter names to use
- period: lookback window length (default depends on indicator)
- source: which price to use ('close', 'high', 'low', 'open') — access via data[i][source]
- multiplier: scaling factor for bands/channels
- smoothing: smoothing type or factor

## Output format
Return ONLY the JavaScript code. No markdown fences, no explanations outside comments."""


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
# Must be very specific — general pattern/trading terms should NOT trigger this.
INDICATOR_KEYWORDS = [
    "create indicator", "create an indicator", "create a indicator",
    "custom indicator", "build indicator", "build an indicator",
    "make indicator", "make an indicator", "new indicator",
    "create oscillator", "build oscillator",
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
        """Detect whether the user wants a pattern or indicator."""
        lower = text.lower()
        for kw in INDICATOR_KEYWORDS:
            if kw in lower:
                return "indicator"
        return "pattern"

    def _generate_with_llm(self, hypothesis: str, script_type: str) -> Dict[str, Any]:
        prompt = INDICATOR_SYSTEM_PROMPT if script_type == "indicator" else PATTERN_SYSTEM_PROMPT

        script = chat_completion(
            system_prompt=prompt,
            user_message=hypothesis,
            model=self.model,
            temperature=0.3,
        )
        script = _strip_code_fences(script)

        explanation = chat_completion(
            system_prompt=(
                f"You are a trading analyst. Explain the following JavaScript "
                f"{'indicator' if script_type == 'indicator' else 'pattern detection'} "
                f"script in 2-3 sentences. What does it compute and how?"
            ),
            user_message=script,
            model=self.model,
            temperature=0.3,
            max_tokens=300,
        )

        result = {
            "script": script,
            "script_type": script_type,
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
        if script_type == "indicator":
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
