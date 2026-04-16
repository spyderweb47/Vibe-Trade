"""
Swarm Agent Tools — real-world research capabilities for debate personas.

Each persona gets a subset of these tools based on their role/specialization.
Tools are executed by the orchestrator when an agent requests them during
the debate, or by the IntelligenceGatherer during the pre-debate research phase.

Tool categories:
  - web_search:      Search the internet for recent news, analysis, reports
  - fetch_url:       Fetch and parse a specific URL (HTML → text)
  - fetch_pdf:       Download and extract text from a PDF
  - run_indicator:   Run a technical indicator on the loaded OHLC data
  - compute_levels:  Compute support/resistance levels from price data
  - fetch_news:      Search for recent news about a specific asset/topic
  - fetch_policy:    Search for regulatory/policy documents
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional


# ─── Web Search ──────────────────────────────────────────────────────────

import threading
import time as _time
from functools import wraps

# Global rate limiter — DuckDuckGo will IP-block if called too fast in parallel.
# Serialize all web searches through a single lock + min interval.
_search_lock = threading.Lock()
_last_search_time = 0.0
_MIN_SEARCH_INTERVAL = 0.5  # seconds between requests


def _with_timeout(timeout_seconds: float):
    """Run a function with a hard timeout. Returns None on timeout."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            result: List[Any] = [None]
            exc: List[Any] = [None]
            def target():
                try:
                    result[0] = func(*args, **kwargs)
                except Exception as e:
                    exc[0] = e
            t = threading.Thread(target=target, daemon=True)
            t.start()
            t.join(timeout_seconds)
            if t.is_alive():
                return None  # Timed out
            if exc[0]:
                raise exc[0]
            return result[0]
        return wrapper
    return decorator


def web_search(query: str, max_results: int = 5) -> List[Dict[str, str]]:
    """
    Search the web with retries, timeout, and backend fallback.

    Tries DuckDuckGo with multiple backends (auto, html, lite) with
    exponential backoff. Rate-limited globally to avoid IP blocks.
    Returns empty list on total failure (never hangs the pipeline).
    """
    global _last_search_time

    # Global rate limit
    with _search_lock:
        elapsed = _time.time() - _last_search_time
        if elapsed < _MIN_SEARCH_INTERVAL:
            _time.sleep(_MIN_SEARCH_INTERVAL - elapsed)
        _last_search_time = _time.time()

    backends = ["auto", "html", "lite"]
    for attempt, backend in enumerate(backends):
        try:
            @_with_timeout(10.0)  # 10s hard timeout per attempt
            def _do_search():
                try:
                    from ddgs import DDGS  # New package name
                except ImportError:
                    from duckduckgo_search import DDGS  # Old name fallback
                results = []
                with DDGS() as ddgs:
                    for r in ddgs.text(query, max_results=max_results, backend=backend):
                        results.append({
                            "title": r.get("title", ""),
                            "url": r.get("href", ""),
                            "snippet": r.get("body", ""),
                        })
                        if len(results) >= max_results:
                            break
                return results

            results = _do_search()
            if results:
                return results
        except Exception as e:
            # Exponential backoff: 1s, 2s, 4s
            wait = 2 ** attempt
            _time.sleep(wait)
            if attempt == len(backends) - 1:
                # Last attempt failed — log and return empty
                print(f"[web_search] all backends failed for '{query[:50]}': {str(e)[:100]}")
                return []

    return []


def fetch_news(asset_name: str, max_results: int = 5) -> List[Dict[str, str]]:
    """Search for recent news about a specific asset."""
    query = f"{asset_name} latest news analysis market"
    return web_search(query, max_results)


def fetch_policy(topic: str, max_results: int = 3) -> List[Dict[str, str]]:
    """Search for regulatory/policy documents about a topic."""
    query = f"{topic} regulation policy government official"
    return web_search(query, max_results)


# ─── URL Fetching ────────────────────────────────────────────────────────

def fetch_url(url: str, max_chars: int = 5000) -> str:
    """
    Fetch a URL and extract readable text content. Strips HTML tags,
    scripts, and styles. Returns plain text truncated to max_chars.
    """
    try:
        import requests
        from bs4 import BeautifulSoup

        resp = requests.get(url, timeout=10, headers={
            "User-Agent": "Mozilla/5.0 (compatible; VibeTrade/1.0)"
        })
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        # Remove scripts, styles, and nav elements
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()

        text = soup.get_text(separator="\n", strip=True)
        # Collapse multiple blank lines
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:max_chars]
    except Exception as e:
        return f"Failed to fetch {url}: {e}"


# ─── PDF Parsing ─────────────────────────────────────────────────────────

def fetch_pdf(url: str, max_chars: int = 5000) -> str:
    """Download a PDF from a URL and extract its text content."""
    try:
        import requests
        import io
        from PyPDF2 import PdfReader

        resp = requests.get(url, timeout=15, headers={
            "User-Agent": "Mozilla/5.0 (compatible; VibeTrade/1.0)"
        })
        resp.raise_for_status()

        reader = PdfReader(io.BytesIO(resp.content))
        text_parts = []
        for page in reader.pages[:20]:  # Cap at 20 pages
            text_parts.append(page.extract_text() or "")

        text = "\n".join(text_parts)
        return text[:max_chars]
    except Exception as e:
        return f"Failed to parse PDF {url}: {e}"


# ─── Technical Indicators ────────────────────────────────────────────────

def run_indicator(bars: list, indicator: str, params: Dict[str, Any] = None) -> str:
    """
    Run a technical indicator on OHLC bars and return a text summary.
    Supports: sma, ema, rsi, macd, bollinger, atr, vwap, obv.
    """
    if not bars:
        return "No data available."

    params = params or {}
    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]
    volumes = [b.get("volume", 0) for b in bars]
    n = len(closes)
    ind = indicator.lower().strip()

    def sma(data, period):
        if len(data) < period:
            return None
        return sum(data[-period:]) / period

    def ema(data, period):
        if len(data) < period:
            return None
        k = 2 / (period + 1)
        val = sum(data[:period]) / period
        for price in data[period:]:
            val = price * k + val * (1 - k)
        return val

    def rsi_calc(data, period=14):
        if len(data) < period + 1:
            return None
        gains, losses = 0, 0
        for i in range(-period, 0):
            d = data[i] - data[i - 1]
            if d > 0:
                gains += d
            else:
                losses -= d
        rs = gains / (losses or 1e-10)
        return 100 - 100 / (1 + rs)

    if ind == "sma":
        period = params.get("period", 20)
        val = sma(closes, period)
        return f"SMA({period}) = {val:.2f}. Price is {'above' if closes[-1] > val else 'below'} SMA." if val else "Not enough data."

    elif ind == "ema":
        period = params.get("period", 20)
        val = ema(closes, period)
        return f"EMA({period}) = {val:.2f}. Price is {'above' if closes[-1] > val else 'below'} EMA." if val else "Not enough data."

    elif ind == "rsi":
        period = params.get("period", 14)
        val = rsi_calc(closes, period)
        if val is None:
            return "Not enough data for RSI."
        zone = "overbought (>70)" if val > 70 else "oversold (<30)" if val < 30 else "neutral"
        return f"RSI({period}) = {val:.1f} — {zone}."

    elif ind == "macd":
        fast_ema = ema(closes, 12)
        slow_ema = ema(closes, 26)
        if fast_ema is None or slow_ema is None:
            return "Not enough data for MACD."
        macd_line = fast_ema - slow_ema
        signal = "bullish (MACD above zero)" if macd_line > 0 else "bearish (MACD below zero)"
        return f"MACD = {macd_line:.2f} — {signal}."

    elif ind == "bollinger":
        period = params.get("period", 20)
        mult = params.get("multiplier", 2)
        mid = sma(closes, period)
        if mid is None:
            return "Not enough data."
        variance = sum((c - mid) ** 2 for c in closes[-period:]) / period
        std = variance ** 0.5
        upper = mid + mult * std
        lower = mid - mult * std
        price = closes[-1]
        pos = "above upper band (overbought)" if price > upper else "below lower band (oversold)" if price < lower else "within bands"
        return f"Bollinger({period},{mult}): Upper={upper:.2f}, Mid={mid:.2f}, Lower={lower:.2f}. Price is {pos}."

    elif ind == "atr":
        period = params.get("period", 14)
        if n < period + 1:
            return "Not enough data."
        trs = []
        for i in range(1, n):
            tr = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
            trs.append(tr)
        atr_val = sum(trs[-period:]) / period
        pct = (atr_val / closes[-1]) * 100
        return f"ATR({period}) = {atr_val:.2f} ({pct:.2f}% of price). Volatility is {'high' if pct > 3 else 'moderate' if pct > 1 else 'low'}."

    elif ind == "vwap":
        if not any(v > 0 for v in volumes):
            return "No volume data for VWAP."
        cum_vol = sum(volumes[-50:]) or 1
        cum_tp_vol = sum(((h + l + c) / 3) * v for h, l, c, v in zip(highs[-50:], lows[-50:], closes[-50:], volumes[-50:]))
        vwap_val = cum_tp_vol / cum_vol
        return f"VWAP (50-bar) = {vwap_val:.2f}. Price is {'above' if closes[-1] > vwap_val else 'below'} VWAP."

    elif ind == "obv":
        obv = 0
        for i in range(1, n):
            if closes[i] > closes[i-1]:
                obv += volumes[i]
            elif closes[i] < closes[i-1]:
                obv -= volumes[i]
        obv_20 = 0
        for i in range(max(1, n-20), n):
            if closes[i] > closes[i-1]:
                obv_20 += volumes[i]
            elif closes[i] < closes[i-1]:
                obv_20 -= volumes[i]
        trend = "accumulation (bullish)" if obv_20 > 0 else "distribution (bearish)"
        return f"OBV trend (20-bar): {trend}. Net OBV = {obv:,.0f}."

    return f"Unknown indicator: {indicator}"


def compute_levels(bars: list) -> str:
    """Compute key support/resistance levels from price data."""
    if not bars or len(bars) < 20:
        return "Not enough data for level analysis."

    closes = [b["close"] for b in bars]
    highs = [b["high"] for b in bars]
    lows = [b["low"] for b in bars]

    # Find swing highs/lows
    swing_highs = []
    swing_lows = []
    for i in range(2, min(len(bars) - 2, 200)):
        if highs[i] > highs[i-1] and highs[i] > highs[i+1] and highs[i] > highs[i-2]:
            swing_highs.append(highs[i])
        if lows[i] < lows[i-1] and lows[i] < lows[i+1] and lows[i] < lows[i-2]:
            swing_lows.append(lows[i])

    lines = ["Key Price Levels:"]
    if swing_highs:
        lines.append(f"  Resistance: {', '.join(f'${p:.2f}' for p in sorted(swing_highs[-5:], reverse=True))}")
    if swing_lows:
        lines.append(f"  Support: {', '.join(f'${p:.2f}' for p in sorted(swing_lows[-5:]))}")

    # Current position relative to levels
    price = closes[-1]
    nearest_res = min((h for h in swing_highs if h > price), default=None)
    nearest_sup = max((l for l in swing_lows if l < price), default=None)
    if nearest_res:
        lines.append(f"  Nearest resistance: ${nearest_res:.2f} ({((nearest_res - price) / price * 100):.1f}% away)")
    if nearest_sup:
        lines.append(f"  Nearest support: ${nearest_sup:.2f} ({((price - nearest_sup) / price * 100):.1f}% away)")

    return "\n".join(lines)


# ─── Tool Registry ───────────────────────────────────────────────────────

# Maps persona specialization/role → list of tool names they can use
ROLE_TOOL_MAP: Dict[str, List[str]] = {
    "technical": ["run_indicator", "compute_levels"],
    "quant": ["run_indicator", "compute_levels"],
    "fundamental": ["web_search", "fetch_news", "fetch_url"],
    "macro": ["web_search", "fetch_news", "fetch_policy"],
    "industry": ["web_search", "fetch_news", "fetch_url"],
    "sentiment": ["web_search", "fetch_news"],
    "geopolitical": ["web_search", "fetch_policy", "fetch_url"],
    "general": ["web_search", "fetch_news"],
    "observer": ["web_search", "fetch_news", "run_indicator"],
}


def execute_tool(
    tool_name: str,
    bars: list,
    asset_name: str,
    params: Dict[str, Any] = None,
) -> str:
    """Execute a swarm agent tool and return text results."""
    params = params or {}

    if tool_name == "web_search":
        query = params.get("query", f"{asset_name} market analysis")
        results = web_search(query, max_results=params.get("max_results", 5))
        return "\n".join(f"- [{r['title']}]({r['url']}): {r['snippet']}" for r in results)

    elif tool_name == "fetch_news":
        results = fetch_news(asset_name, max_results=params.get("max_results", 5))
        return "\n".join(f"- {r['title']}: {r['snippet']}" for r in results)

    elif tool_name == "fetch_policy":
        topic = params.get("topic", asset_name)
        results = fetch_policy(topic, max_results=3)
        return "\n".join(f"- {r['title']}: {r['snippet']}" for r in results)

    elif tool_name == "fetch_url":
        url = params.get("url", "")
        if not url:
            return "No URL provided."
        return fetch_url(url, max_chars=params.get("max_chars", 3000))

    elif tool_name == "fetch_pdf":
        url = params.get("url", "")
        if not url:
            return "No PDF URL provided."
        return fetch_pdf(url, max_chars=params.get("max_chars", 3000))

    elif tool_name == "run_indicator":
        indicator = params.get("indicator", "rsi")
        return run_indicator(bars, indicator, params)

    elif tool_name == "compute_levels":
        return compute_levels(bars)

    return f"Unknown tool: {tool_name}"


def run_research_suite(
    asset_name: str,
    asset_class: str,
    bars: list,
) -> Dict[str, str]:
    """
    Run a comprehensive research suite for the IntelligenceGatherer.
    Returns a dict of research_area → text findings.
    """
    findings: Dict[str, str] = {}

    # 1. Recent news
    news = fetch_news(asset_name, max_results=8)
    findings["recent_news"] = "\n".join(
        f"- {r['title']}: {r['snippet']}" for r in news
    ) if news else "No news found."

    # 2. Market analysis
    analysis = web_search(f"{asset_name} {asset_class} technical analysis outlook 2025", max_results=5)
    findings["market_analysis"] = "\n".join(
        f"- {r['title']}: {r['snippet']}" for r in analysis
    ) if analysis else "No analysis found."

    # 3. Regulatory/policy (if relevant)
    if asset_class in ("commodity", "crypto", "forex"):
        policy = fetch_policy(f"{asset_name} {asset_class}", max_results=3)
        findings["regulatory"] = "\n".join(
            f"- {r['title']}: {r['snippet']}" for r in policy
        ) if policy else "No regulatory updates found."

    # 4. Technical indicators
    indicators = ["rsi", "macd", "bollinger", "atr", "vwap"]
    ind_results = []
    for ind in indicators:
        ind_results.append(run_indicator(bars, ind))
    findings["technical_indicators"] = "\n".join(ind_results)

    # 5. Key levels
    findings["key_levels"] = compute_levels(bars)

    return findings
