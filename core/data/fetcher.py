"""
Unified market data fetcher.

Two providers, both free and key-less for public data:
  - yfinance  → US/HK equities, ETFs, indices, forex, some crypto
  - ccxt      → 100+ crypto exchanges (default: binance) for crypto pairs

The `fetch()` entry point auto-detects which provider to use based on the
symbol shape:
  - "BTC/USDT"  → ccxt
  - "BTC-USD"   → ccxt (normalized to BTC/USD)
  - "AAPL"      → yfinance
  - "^GSPC"     → yfinance (indices)
  - "EURUSD=X"  → yfinance (forex)

Returns a normalized dict::

    {
        "symbol": "BTC/USDT",
        "source": "ccxt:binance",
        "interval": "1h",
        "bars": [
            {"time": 1776196800, "open": 74223.3, "high": 74434.33,
             "low": 74015.53, "close": 74102.29, "volume": 434.25},
            ...
        ],
        "metadata": {
            "rows": 1000,
            "startDate": "2026-01-01T00:00:00Z",
            "endDate":   "2026-04-15T00:00:00Z",
            "symbol": "BTC/USDT",
            "nativeTimeframe": "1h",
        },
    }

`time` is **unix seconds** (matching the rest of the platform's OHLCBar shape).
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


# ─── Interval normalization ─────────────────────────────────────────────────

# Map common user-facing interval strings to provider-specific formats.
# yfinance accepts: 1m, 2m, 5m, 15m, 30m, 60m, 90m, 1h, 1d, 5d, 1wk, 1mo, 3mo
# ccxt accepts: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M

_YFINANCE_INTERVAL: Dict[str, str] = {
    "1m": "1m", "2m": "2m", "5m": "5m", "15m": "15m", "30m": "30m",
    "60m": "60m", "1h": "60m", "90m": "90m",
    "1d": "1d", "daily": "1d", "5d": "5d",
    "1w": "1wk", "1wk": "1wk", "weekly": "1wk",
    "1mo": "1mo", "monthly": "1mo", "3mo": "3mo",
}

_CCXT_INTERVAL: Dict[str, str] = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "60m": "1h", "2h": "2h", "4h": "4h", "6h": "6h",
    "8h": "8h", "12h": "12h",
    "1d": "1d", "daily": "1d", "3d": "3d",
    "1w": "1w", "weekly": "1w", "1M": "1M", "monthly": "1M",
}


def _normalize_yf_interval(interval: str) -> str:
    return _YFINANCE_INTERVAL.get(interval.lower(), "1d")


def _normalize_ccxt_interval(interval: str) -> str:
    return _CCXT_INTERVAL.get(interval.lower(), "1h")


# ─── Symbol detection ───────────────────────────────────────────────────────

_CRYPTO_QUOTES = {"USDT", "USDC", "BUSD", "USD", "BTC", "ETH", "DAI", "TUSD", "USDS", "EUR", "GBP"}


def detect_provider(symbol: str) -> str:
    """Return 'ccxt' or 'yfinance' based on the symbol shape."""
    s = symbol.strip().upper()
    # yfinance-specific suffixes — commodities futures (=F), forex (=X), indices (^)
    if s.endswith("=F") or s.endswith("=X") or s.startswith("^"):
        return "yfinance"
    # Explicit pair separators
    if "/" in s:
        return "ccxt"
    # Hyphen with crypto-like quote (e.g. BTC-USD, ETH-USDT)
    if "-" in s:
        parts = s.split("-")
        if len(parts) == 2 and parts[1] in _CRYPTO_QUOTES:
            return "ccxt"
    # Bare crypto base (e.g. "BTC", "ETH") — assume ccxt with USDT quote
    if s in {"BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "AVAX", "MATIC", "BNB", "DOT", "LINK", "LTC", "TRX", "ATOM"}:
        return "ccxt"
    # Default: stocks / ETFs go to yfinance
    return "yfinance"


def _normalize_ccxt_symbol(symbol: str) -> str:
    """Convert 'BTC-USDT', 'BTCUSDT', or 'BTC' into 'BTC/USDT'."""
    s = symbol.strip().upper()
    if "/" in s:
        return s
    if "-" in s:
        return s.replace("-", "/")
    # Try splitting "BTCUSDT" → "BTC/USDT" by checking quote suffixes
    for q in sorted(_CRYPTO_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            base = s[: -len(q)]
            return f"{base}/{q}"
    # Bare base — default quote = USDT
    return f"{s}/USDT"


# ─── Public API ─────────────────────────────────────────────────────────────


def fetch(
    symbol: str,
    source: str = "auto",
    interval: str = "1d",
    limit: int = 1000,
    exchange: str = "binance",
) -> Dict[str, Any]:
    """
    Fetch historical OHLCV bars for a symbol.

    Args:
        symbol:   e.g. "AAPL", "BTC/USDT", "ETH-USD", "^GSPC", "EURUSD=X"
        source:   "auto" | "yfinance" | "ccxt"
        interval: "1m", "5m", "1h", "1d", "1w", "1mo" (provider-normalized)
        limit:    approximate number of bars to return (max ~5000 for ccxt)
        exchange: ccxt exchange name (binance, coinbase, kraken, okx, ...)

    Returns the normalized dict shape (see module docstring).
    Raises ValueError if the symbol can't be fetched.
    """
    if source == "auto":
        source = detect_provider(symbol)

    if source == "ccxt":
        return _fetch_ccxt(symbol, interval, limit, exchange)
    elif source == "yfinance":
        return _fetch_yfinance(symbol, interval, limit)
    else:
        raise ValueError(f"Unknown source: {source}")


def _fetch_yfinance(symbol: str, interval: str, limit: int) -> Dict[str, Any]:
    import yfinance as yf

    yf_interval = _normalize_yf_interval(interval)

    # yfinance limits intraday data to ~60 days; daily+ goes back further.
    # Pick a sensible period based on interval × limit.
    if yf_interval in {"1m", "2m"}:
        period = "7d"   # 1m max 7 days
    elif yf_interval in {"5m", "15m", "30m", "60m", "90m"}:
        period = "60d"  # intraday max 60 days
    elif yf_interval == "1d":
        # ~limit days × 1.5 buffer for weekends, capped at 10 years
        days = max(min(limit * 2, 3650), 30)
        period = f"{days}d"
    elif yf_interval in {"5d", "1wk"}:
        period = "10y"
    else:
        period = "max"

    ticker = yf.Ticker(symbol)
    df = ticker.history(period=period, interval=yf_interval, auto_adjust=False)

    if df.empty:
        raise ValueError(f"yfinance returned no bars for {symbol} ({yf_interval})")

    # Trim to the most recent `limit` bars
    if len(df) > limit:
        df = df.iloc[-limit:]

    bars: List[Dict[str, Any]] = []
    for ts, row in df.iterrows():
        unix = int(ts.timestamp()) if hasattr(ts, "timestamp") else int(ts.value / 1e9)
        bars.append({
            "time": unix,
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": float(row.get("Volume", 0) or 0),
        })

    if not bars:
        raise ValueError(f"yfinance: empty bar list after normalization for {symbol}")

    start_iso = datetime.fromtimestamp(bars[0]["time"], tz=timezone.utc).isoformat()
    end_iso = datetime.fromtimestamp(bars[-1]["time"], tz=timezone.utc).isoformat()

    return {
        "symbol": symbol,
        "source": "yfinance",
        "interval": yf_interval,
        "bars": bars,
        "metadata": {
            "rows": len(bars),
            "startDate": start_iso,
            "endDate": end_iso,
            "symbol": symbol,
            "nativeTimeframe": yf_interval,
        },
    }


def _fetch_ccxt(symbol: str, interval: str, limit: int, exchange: str) -> Dict[str, Any]:
    import time as _time
    import ccxt

    ccxt_interval = _normalize_ccxt_interval(interval)
    ccxt_symbol = _normalize_ccxt_symbol(symbol)

    if not hasattr(ccxt, exchange):
        raise ValueError(f"Unknown ccxt exchange: {exchange}")
    ex_class = getattr(ccxt, exchange)
    ex = ex_class({"enableRateLimit": True})

    # Most ccxt exchanges cap a single fetch_ohlcv at 1000 (some at 500). For
    # requests larger than that, paginate FORWARD from a computed `since`
    # timestamp that's (limit × interval_ms) in the past, fetching batches
    # until we've covered the requested range or hit the current time.
    interval_ms = _INTERVAL_SECONDS.get(ccxt_interval, 3600) * 1000

    if limit <= 1000:
        ohlcv = ex.fetch_ohlcv(ccxt_symbol, timeframe=ccxt_interval, limit=limit)
    else:
        now_ms = int(_time.time() * 1000)
        since = now_ms - (limit * interval_ms)

        all_bars: List[List[float]] = []
        batch_limit = 1000
        max_batches = (limit // batch_limit) + 5  # safety cap to prevent infinite loops
        batches_done = 0

        while len(all_bars) < limit and batches_done < max_batches:
            batch = ex.fetch_ohlcv(ccxt_symbol, timeframe=ccxt_interval, since=since, limit=batch_limit)
            batches_done += 1
            if not batch:
                break
            all_bars.extend(batch)
            # If this batch was short, we've reached the end (either current
            # time or the exchange's retention window)
            if len(batch) < batch_limit:
                break
            # Advance `since` to just after the last fetched bar's timestamp
            next_since = batch[-1][0] + interval_ms
            if next_since <= since:
                break  # no forward progress, bail
            since = next_since
            # Stop if we've already reached current time
            if since >= now_ms:
                break

        # Deduplicate by timestamp (batches can overlap on some exchanges) and
        # keep only the most recent `limit` bars
        seen = set()
        deduped: List[List[float]] = []
        for row in all_bars:
            ts = row[0]
            if ts in seen:
                continue
            seen.add(ts)
            deduped.append(row)
        deduped.sort(key=lambda r: r[0])
        ohlcv = deduped[-limit:] if len(deduped) > limit else deduped

    if not ohlcv:
        raise ValueError(f"ccxt {exchange}: no bars for {ccxt_symbol} ({ccxt_interval})")

    bars: List[Dict[str, Any]] = []
    for row in ohlcv:
        # ccxt returns: [timestamp_ms, open, high, low, close, volume]
        bars.append({
            "time": int(row[0] / 1000),  # ms → s
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]) if row[5] is not None else 0.0,
        })

    start_iso = datetime.fromtimestamp(bars[0]["time"], tz=timezone.utc).isoformat()
    end_iso = datetime.fromtimestamp(bars[-1]["time"], tz=timezone.utc).isoformat()

    return {
        "symbol": ccxt_symbol,
        "source": f"ccxt:{exchange}",
        "interval": ccxt_interval,
        "bars": bars,
        "metadata": {
            "rows": len(bars),
            "startDate": start_iso,
            "endDate": end_iso,
            "symbol": ccxt_symbol,
            "nativeTimeframe": ccxt_interval,
        },
    }


# ─── Natural-language query parsing ─────────────────────────────────────────


_TIMEFRAME_PATTERNS = [
    (re.compile(r"\b(1\s*min|1m|one\s*minute)\b", re.I), "1m"),
    (re.compile(r"\b(5\s*min|5m|five\s*minutes?)\b", re.I), "5m"),
    (re.compile(r"\b(15\s*min|15m|fifteen\s*minutes?)\b", re.I), "15m"),
    (re.compile(r"\b(30\s*min|30m|half\s*hour)\b", re.I), "30m"),
    (re.compile(r"\b(1\s*hour|1h|hourly|one\s*hour)\b", re.I), "1h"),
    (re.compile(r"\b(2\s*hour|2h|two\s*hour)\b", re.I), "2h"),
    (re.compile(r"\b(4\s*hour|4h|four\s*hour)\b", re.I), "4h"),
    (re.compile(r"\b(daily|1\s*day|1d|day)\b", re.I), "1d"),
    (re.compile(r"\b(weekly|1\s*week|1w|week)\b", re.I), "1w"),
    (re.compile(r"\b(monthly|1\s*month|1mo|month)\b", re.I), "1mo"),
]

# Explicit bar counts: "500 bars", "100 candles", "200 points"
_BAR_COUNT_PATTERN = re.compile(
    r"\b(?:last\s+|past\s+|recent\s+)?(\d{1,6})\s*(?:bars?|candles?|points?)\b",
    re.I,
)

# Time periods with explicit numbers — "2 years", "30 days", "3 weeks"
_YEARS_PATTERN = re.compile(r"\b(?:last\s+|past\s+|for\s+the\s+last\s+)?(\d+)\s*years?\b", re.I)
_MONTHS_PATTERN = re.compile(r"\b(?:last\s+|past\s+|for\s+the\s+last\s+)?(\d+)\s*months?\b", re.I)
_WEEKS_PATTERN = re.compile(r"\b(?:last\s+|past\s+|for\s+the\s+last\s+)?(\d+)\s*weeks?\b", re.I)
_DAYS_PATTERN = re.compile(r"\b(?:last\s+|past\s+|for\s+the\s+last\s+)?(\d+)\s*days?\b", re.I)
_HOURS_PATTERN = re.compile(r"\b(?:last\s+|past\s+|for\s+the\s+last\s+)?(\d+)\s*hours?\b", re.I)

# Bare time units — "last week", "last month", "past year" without a number.
# Treated as 1 of that unit. Matched AFTER the explicit-number patterns.
_BARE_LAST_PATTERN = re.compile(r"\b(?:last|past|this)\s+(year|month|week|day|hour)\b", re.I)

# Interval duration in seconds — used to convert "N days/hours/..." to a bar count
_INTERVAL_SECONDS: Dict[str, int] = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400,
    "6h": 21600, "8h": 28800, "12h": 43200,
    "1d": 86400, "3d": 259200,
    "1w": 604800, "1wk": 604800, "5d": 432000,
    "1mo": 2_592_000, "1M": 2_592_000, "3mo": 7_776_000,
}

# Hard cap so a typo like "last 10 years of 1m btc" doesn't ask for 5M bars
_MAX_BARS = 50_000

# Strict symbol heuristic: 2-10 UPPERCASE letters/numbers, optionally with / or -.
# Catches "BTC", "AAPL", "BTC/USDT", "ETH-USD", "^GSPC", "EURUSD=X".
_SYMBOL_PATTERN = re.compile(r"\b([A-Z][A-Z0-9]{1,9}(?:[/\-][A-Z0-9]{2,6})?)\b")

# Fallback for lowercase inputs like "fetch btc 1m" — match against a known
# set of common tickers so we don't have to whitelist every English word.
_KNOWN_CRYPTO_BASES = {
    "btc", "eth", "sol", "xrp", "doge", "ada", "avax", "matic", "bnb", "dot",
    "link", "ltc", "trx", "atom", "shib", "uni", "xlm", "bch", "aave", "mkr",
    "near", "apt", "sui", "arb", "op", "pepe", "wif", "ordi",
}
_KNOWN_STOCK_TICKERS = {
    "aapl", "spy", "tsla", "nvda", "msft", "goog", "googl", "amzn", "meta",
    "nflx", "qqq", "dia", "voo", "iwm", "vti", "amd", "intc", "coin", "pltr",
}
_KNOWN_SYMBOLS_LOWER = _KNOWN_CRYPTO_BASES | _KNOWN_STOCK_TICKERS

# Plain-English / forex aliases → yfinance tickers. When the user types
# "gold" or "xauusd" instead of the yfinance symbol, we rewrite to the
# correct futures contract. These go through yfinance (not ccxt) since
# they're commodities/forex, not crypto pairs.
_NAME_ALIASES: Dict[str, str] = {
    # Metals — COMEX futures
    "gold": "GC=F",
    "xau": "GC=F",
    "xauusd": "GC=F",
    "silver": "SI=F",
    "xag": "SI=F",
    "xagusd": "SI=F",
    "platinum": "PL=F",
    "palladium": "PA=F",
    "copper": "HG=F",
    # Energy — NYMEX futures
    "oil": "CL=F",
    "crude": "CL=F",
    "wti": "CL=F",
    "brent": "BZ=F",
    "gas": "NG=F",
    "natgas": "NG=F",
    "naturalgas": "NG=F",
    # Indices
    "spx": "^GSPC",
    "sp500": "^GSPC",
    "nasdaq": "^IXIC",
    "ndx": "^NDX",
    "dow": "^DJI",
    "russell": "^RUT",
    "vix": "^VIX",
    # Forex majors (yfinance uses "=X" suffix)
    "eurusd": "EURUSD=X",
    "gbpusd": "GBPUSD=X",
    "usdjpy": "USDJPY=X",
    "usdchf": "USDCHF=X",
    "audusd": "AUDUSD=X",
    "usdcad": "USDCAD=X",
    "nzdusd": "NZDUSD=X",
}


def _period_to_bars(interval: str, period_seconds: int) -> int:
    """Convert a duration (in seconds) to the matching bar count for an interval."""
    bar_sec = _INTERVAL_SECONDS.get(interval, 86400)
    bars = period_seconds // bar_sec
    return max(1, int(bars))


_LLM_PARSE_SYSTEM_PROMPT = """You are a market data query parser for a trading platform. Given a user's
natural-language request to load chart data, extract:

- `symbol`: the ticker or pair in the format the data provider needs.
  - Stocks/ETFs/indices: yfinance format (e.g. "AAPL", "SPY", "^GSPC", "^IXIC")
  - Commodities/futures: yfinance =F notation
      gold → "GC=F", silver → "SI=F", oil/crude/WTI → "CL=F", brent → "BZ=F",
      natural gas → "NG=F", copper → "HG=F", platinum → "PL=F", palladium → "PA=F",
      corn → "ZC=F", wheat → "ZW=F", soybeans → "ZS=F", coffee → "KC=F"
  - Forex: yfinance =X notation (e.g. "EURUSD=X", "GBPUSD=X", "USDJPY=X")
  - Crypto: ccxt pair notation with slash (e.g. "BTC/USDT", "ETH/USDT", "SOL/USDC").
    Unknown/new coins → default to /USDT quote.

- `interval`: one of "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h",
  "12h", "1d", "3d", "1w", "1mo". Default to "1d" if unspecified.

- `limit`: approximate number of bars to return. COMPUTE this from any time
  period the user mentioned, based on the interval:
  - "30 days" at "1m" = 30 * 24 * 60 = 43200
  - "2 years" at "1d" = 2 * 365 = 730
  - "last week" at "1h" = 7 * 24 = 168
  - "last month" at "5m" = 30 * 24 * 12 = 8640
  - "last year" at "1d" = 365
  - If the user said "500 bars" or "100 candles", use that literal number.
  - If nothing is specified, use 1000.
  - Cap at 50000 absolute max.

## Examples

Input: "fetch gold 1m last week"
Output: {"symbol": "GC=F", "interval": "1m", "limit": 10080}

Input: "get BTC/USDT 4h last 500 bars"
Output: {"symbol": "BTC/USDT", "interval": "4h", "limit": 500}

Input: "pull oil daily last 2 years"
Output: {"symbol": "CL=F", "interval": "1d", "limit": 730}

Input: "fetch dogecoin 5m past 30 days"
Output: {"symbol": "DOGE/USDT", "interval": "5m", "limit": 8640}

Input: "load XAU/USD 1h"
Output: {"symbol": "GC=F", "interval": "1h", "limit": 1000}

Input: "get the nasdaq weekly for the last 3 years"
Output: {"symbol": "^IXIC", "interval": "1w", "limit": 156}

Input: "fetch TSLA hourly 1 month"
Output: {"symbol": "TSLA", "interval": "1h", "limit": 720}

Input: "show me natural gas daily 6 months"
Output: {"symbol": "NG=F", "interval": "1d", "limit": 180}

## Output

Return STRICT JSON matching this exact shape — no markdown fences, no commentary:
{"symbol": "<string>", "interval": "<string>", "limit": <number>}

If you cannot confidently determine a symbol, return:
{"symbol": null, "interval": "1d", "limit": 1000}"""


def _parse_query_llm(message: str) -> Optional[Dict[str, Any]]:
    """
    Use an LLM to extract {symbol, interval, limit} from a free-form query.
    Returns None if the LLM is unavailable, errors out, or returns junk so
    the caller can fall back to the regex path.
    """
    # Lazy import to avoid circular deps (llm_client may not be used by the
    # rest of this module, so keep the import scoped)
    try:
        from core.agents.llm_client import chat_completion, is_available as llm_available
    except Exception:  # noqa: BLE001
        return None

    if not llm_available():
        return None

    try:
        raw = chat_completion(
            system_prompt=_LLM_PARSE_SYSTEM_PROMPT,
            user_message=message,
            temperature=0.0,
            max_tokens=150,
        )
    except Exception:  # noqa: BLE001
        return None

    # Strip code fences if the LLM wrapped the JSON
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        nl = cleaned.find("\n")
        if nl != -1:
            cleaned = cleaned[nl + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

    # If the LLM wrapped JSON in prose, pluck out the object
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        cleaned = cleaned[start : end + 1]

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        return None

    if not isinstance(parsed, dict):
        return None

    symbol = parsed.get("symbol")
    if symbol is not None and not isinstance(symbol, str):
        return None
    if isinstance(symbol, str):
        symbol = symbol.strip() or None

    interval = parsed.get("interval")
    if not isinstance(interval, str) or not interval.strip():
        interval = "1d"
    interval = interval.strip()

    limit_raw = parsed.get("limit", 1000)
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError):
        limit = 1000
    limit = max(1, min(limit, _MAX_BARS))

    return {
        "symbol": symbol,
        "interval": interval,
        "limit": limit,
        "source": "auto",
    }


def parse_query(message: str) -> Dict[str, Any]:
    """
    Parse a natural-language data fetch request into structured params.

    Dispatch:
      1. **LLM path** — if an LLM provider is configured, we ask it to
         resolve any ticker alias (including ones not in our hardcoded map,
         e.g. "dogecoin", "XAU/USD", "natural gas", new crypto coins). The
         LLM also computes the bar count from time periods.
      2. **Regex fallback** — if the LLM is unavailable, fails, or can't
         determine a symbol, we fall back to the regex + hardcoded alias
         map path. Handles all the common patterns:
           - "Fetch BTC/USDT hourly data"
           - "Get AAPL daily for the last 2 years"
           - "Load 500 bars of ETH 1h"
           - "Fetch BTC 1m for the last 30 days" → 43,200 bars

    Returns: {symbol, interval, limit, source}. `symbol` may be None if
    neither path can identify a ticker.
    """
    # Try LLM first
    llm_result = _parse_query_llm(message)
    if llm_result and llm_result.get("symbol"):
        return llm_result

    # Fallback — regex + hardcoded alias map
    return _parse_query_regex(message)


def _parse_query_regex(message: str) -> Dict[str, Any]:
    """
    Regex-based fallback parser. Same behaviour as the original parse_query
    from before the LLM path was added — handles the common patterns even
    when no LLM is available.
    """
    out: Dict[str, Any] = {
        "symbol": None,
        "interval": "1d",
        "limit": 1000,
        "source": "auto",
    }

    # Symbol detection — three-layer fallback:
    #   1. Plain-English / forex aliases ("gold" → "GC=F", "xauusd" → "GC=F")
    #   2. Strict uppercase regex (catches BTC, AAPL, BTC/USDT, ^GSPC, EURUSD=X)
    #   3. Lowercase token match against _KNOWN_SYMBOLS_LOWER ("btc" → "BTC")

    # Layer 1 — word-boundary scan for plain-English aliases. We sort by
    # length descending so "naturalgas" is matched before "gas".
    lower_msg = message.lower()
    for alias in sorted(_NAME_ALIASES.keys(), key=len, reverse=True):
        if re.search(rf"\b{re.escape(alias)}\b", lower_msg):
            out["symbol"] = _NAME_ALIASES[alias]
            break

    if out["symbol"] is None:
        # Layer 2 — strict uppercase ticker match
        candidates = _SYMBOL_PATTERN.findall(message)
        blocklist = {
            "GET", "FETCH", "PULL", "LOAD", "DATA", "BAR", "CHART", "FOR",
            "AND", "WITH", "FROM", "INTO", "THE", "PAST", "LAST", "RECENT",
            "USD", "EUR",  # bare currencies alone aren't tickers
        }
        for c in candidates:
            if c not in blocklist:
                out["symbol"] = c
                break

    if out["symbol"] is None:
        # Layer 3 — case-insensitive scan of individual tokens against a
        # known-base set
        for token in re.split(r"[\s,.;!?]+", message):
            token_clean = token.strip("()[]{}\"'`")
            lower = token_clean.lower()
            if lower in _KNOWN_SYMBOLS_LOWER:
                out["symbol"] = token_clean.upper()
                break
            # Also catch slashed/hyphenated lowercase pairs like "btc/usdt"
            if "/" in token_clean or "-" in token_clean:
                base = re.split(r"[/\-]", token_clean, maxsplit=1)[0].lower()
                if base in _KNOWN_CRYPTO_BASES:
                    out["symbol"] = token_clean.upper()
                    break

    # Interval — check all patterns, take the first match
    for pattern, value in _TIMEFRAME_PATTERNS:
        if pattern.search(message):
            out["interval"] = value
            break

    # Limit: try EXPLICIT bar counts first ("500 bars"), fall back to
    # TIME PERIODS which we convert to bar counts based on interval.
    bar_match = _BAR_COUNT_PATTERN.search(message)
    if bar_match:
        out["limit"] = min(int(bar_match.group(1)), _MAX_BARS)
        return out

    # No explicit bar count — look for a time period and convert
    period_seconds = 0
    years_m = _YEARS_PATTERN.search(message)
    months_m = _MONTHS_PATTERN.search(message)
    weeks_m = _WEEKS_PATTERN.search(message)
    days_m = _DAYS_PATTERN.search(message)
    hours_m = _HOURS_PATTERN.search(message)

    # Prefer the largest unit present (so "2 years 3 months" → 2 years)
    if years_m:
        period_seconds = int(years_m.group(1)) * 365 * 86400
    elif months_m:
        period_seconds = int(months_m.group(1)) * 30 * 86400
    elif weeks_m:
        period_seconds = int(weeks_m.group(1)) * 7 * 86400
    elif days_m:
        period_seconds = int(days_m.group(1)) * 86400
    elif hours_m:
        period_seconds = int(hours_m.group(1)) * 3600
    else:
        # Bare "last week" / "past month" / "last year" — no number. Treat as 1.
        bare_m = _BARE_LAST_PATTERN.search(message)
        if bare_m:
            unit = bare_m.group(1).lower()
            unit_seconds = {
                "year": 365 * 86400,
                "month": 30 * 86400,
                "week": 7 * 86400,
                "day": 86400,
                "hour": 3600,
            }
            period_seconds = unit_seconds.get(unit, 0)

    if period_seconds > 0:
        bars = _period_to_bars(out["interval"], period_seconds)
        out["limit"] = min(bars, _MAX_BARS)

    return out
