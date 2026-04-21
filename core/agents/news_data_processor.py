"""
NewsDataProcessor — the specialised agent that converts raw web-search
findings into a validated list of NewsEvent objects for the historic_news
skill.

Why this exists as a separate agent (vs. the old analyzer + QA loop):

  The old flow asked ONE LLM call to produce the full JSON payload for
  every event across the chart window. That failed in three different
  ways for three different assets:

    1. Output truncation — `max_tokens` ran out mid-JSON, leaving an
       unterminated string. The strict-JSON parser choked.
    2. Out-of-range hallucinations — the LLM dated events to training-
       era years (2023, 2024) which the chart-range filter then
       dropped, leaving zero events.
    3. Prose changelog on QA iteration 2 — the producer replied with a
       narrative of "what changed" instead of regenerating the JSON.

  Every fix added another band-aid to the prompt. The real problem is
  that we were asking the LLM to do too much in one call: date
  extraction + category assignment + direction inference + impact
  rating + URL preservation + exact-in-range timestamps + valid JSON,
  for 15-30 events, in one shot.

Solution: split the work.

  Phase 1 — Programmatic extraction (no LLM):
    Parse the `_run_real_research` findings document into Candidate
    records. Each candidate keeps the REAL url/title/snippet as-is.
    This step CANNOT hallucinate — it's pure string parsing.

  Phase 2 — Batched LLM enrichment:
    Send candidates in small batches (5 at a time). The LLM's only
    job is to add analytic fields (category, direction, impact,
    price_impact_pct) AND derive a plausible timestamp in range. Much
    shorter output per call means truncation stops happening; a batch
    failure only loses 5 events, not the whole run.

  Phase 3 — Deterministic validation:
    Drop anything outside the chart range or without a real URL.
    Never calls the LLM again.

Result: predictable, fault-isolated, real-data-only.
"""

from __future__ import annotations

import json as _json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from core.agents.llm_client import chat_completion, is_available as llm_available


# ─── Types ───────────────────────────────────────────────────────────────────


@dataclass
class Candidate:
    """One search-result entry before LLM enrichment."""
    title: str
    url: str
    snippet: str
    query: str                         # the search query this came from


@dataclass
class NewsEventDict:
    """The finished event payload sent to the frontend."""
    id: str
    timestamp: int
    headline: str
    summary: str
    source: str
    url: Optional[str]
    category: str
    impact: str
    direction: str
    price_impact_pct: Optional[float]

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "timestamp": self.timestamp,
            "headline": self.headline,
            "summary": self.summary,
            "source": self.source,
            "url": self.url,
            "category": self.category,
            "impact": self.impact,
            "direction": self.direction,
            "price_impact_pct": self.price_impact_pct,
        }


@dataclass
class ProcessResult:
    """Output of NewsDataProcessor.process."""
    events: List[Dict[str, Any]]                   # final event dicts
    summary: str                                    # one-paragraph overview
    key_themes: List[str]                           # 3-5 themes
    candidates_found: int                           # after Phase 1
    batches_processed: int                          # total LLM batches
    batches_failed: int                             # batches that failed JSON parse
    dropped_out_of_range: int
    dropped_no_timestamp: int
    dropped_no_url: int


# ─── Phase 1: deterministic candidate extraction ─────────────────────────────


# Finding block format (from _run_real_research):
#   ### Query N: <text>
#   - **Title** (url)
#     snippet text
#   - **Title** (url)
#     snippet text
#   ### Query M: ...

_FINDING_BLOCK_RE = re.compile(
    r"^###\s+Query\s+\d+:\s*(.+?)$",
    re.MULTILINE,
)
_ENTRY_RE = re.compile(
    r"-\s+\*\*(?P<title>.+?)\*\*\s*\((?P<url>[^)]*)\)\s*\n\s+(?P<snippet>.+?)(?=\n-\s+\*\*|\n###|\Z)",
    re.DOTALL,
)


def extract_candidates(findings_text: str) -> List[Candidate]:
    """
    Parse the findings document produced by _run_real_research into
    a list of Candidate objects. Pure string manipulation — no LLM.
    """
    if not findings_text or not findings_text.strip():
        return []

    # Split on query headers. findall returns the query strings; split
    # returns the bodies. Keep both aligned.
    headers = _FINDING_BLOCK_RE.findall(findings_text)
    bodies = _FINDING_BLOCK_RE.split(findings_text)
    # split returns [preamble, q1, body1, q2, body2, ...] so bodies[2::2]
    # are the body strings aligned with headers[]
    if len(headers) == 0:
        return []

    out: List[Candidate] = []
    seen_urls: set = set()
    for i, query in enumerate(headers):
        body = bodies[2 + i * 2] if 2 + i * 2 < len(bodies) else ""
        for m in _ENTRY_RE.finditer(body):
            title = (m.group("title") or "").strip()
            url = (m.group("url") or "").strip()
            snippet = (m.group("snippet") or "").strip()
            # Collapse whitespace in snippets (they often span multiple
            # newlines with awkward indentation)
            snippet = re.sub(r"\s+", " ", snippet)
            if not title and not snippet:
                continue
            # Dedupe by URL — same article often shows up under multiple
            # queries. Keep the first occurrence.
            if url and url in seen_urls:
                continue
            if url:
                seen_urls.add(url)
            out.append(Candidate(
                title=title,
                url=url,
                snippet=snippet[:800],  # cap snippet length for the LLM
                query=query.strip(),
            ))
    return out


# ─── Phase 2: batched LLM enrichment ─────────────────────────────────────────


_ENRICH_SYSTEM = """You are the News Data Processor for a trading platform. Your
job is to enrich a SMALL batch of pre-found news articles with analytic
fields. You are NOT fetching news — the search has already happened.

For each input article you get:
  - title (real, from the search engine)
  - url (real, from the search engine — preserve it EXACTLY)
  - snippet (real text from the result page)

Your job per article:
  1. Derive a unix-second TIMESTAMP from the title/snippet. If the
     article or snippet mentions a specific date, use it. If not,
     produce your best estimate WITHIN the requested date window.
     Do NOT return null for timestamp.
  2. Classify CATEGORY: earnings | regulatory | macro | product |
     sentiment | geopolitical | technical
  3. Classify DIRECTION: bullish | bearish | neutral
  4. Classify IMPACT: high | medium | low
  5. Estimate PRICE_IMPACT_PCT if the snippet mentions a specific
     percent move, else null
  6. Write a 1-2 sentence summary based on the snippet

Output rules:
  - Return STRICT JSON ONLY. No markdown fences. No preamble.
  - Preserve title and url EXACTLY — never rewrite or invent.
  - timestamp MUST be an integer in the requested unix range.
"""


def _enrich_prompt_user(
    batch: List[Candidate],
    chart_lo_unix: int,
    chart_hi_unix: int,
    chart_lo_iso: str,
    chart_hi_iso: str,
    topic: str,
) -> str:
    """Build the user prompt for one batch enrichment call."""
    lines = [
        f"Topic: {topic}",
        f"Required timestamp range: {chart_lo_unix} to {chart_hi_unix}",
        f"(equivalent ISO: {chart_lo_iso} to {chart_hi_iso})",
        "",
        "## Articles to enrich",
    ]
    for i, c in enumerate(batch, 1):
        lines.append(f"\n### Article {i}")
        lines.append(f"Title: {c.title}")
        lines.append(f"URL: {c.url}")
        lines.append(f"Search query: {c.query}")
        lines.append(f"Snippet: {c.snippet}")

    lines.extend([
        "",
        "## Output shape (STRICT JSON)",
        "{",
        '  "events": [',
        "    {",
        '      "headline": "<exact title>",',
        '      "url": "<exact url — or null>",',
        f'      "timestamp": <integer between {chart_lo_unix} and {chart_hi_unix}>,',
        '      "summary": "<1-2 sentences>",',
        '      "source": "<extracted from URL hostname>",',
        '      "category": "earnings|regulatory|macro|product|sentiment|geopolitical|technical",',
        '      "impact": "high|medium|low",',
        '      "direction": "bullish|bearish|neutral",',
        '      "price_impact_pct": <float or null>',
        "    }",
        "  ]",
        "}",
        "",
        f"Return exactly {len(batch)} event(s), in the same order as the articles above.",
    ])
    return "\n".join(lines)


def _parse_enrichment_output(text: str) -> Optional[List[Dict[str, Any]]]:
    """
    Robust JSON extraction. Returns the events list on success, None on
    unrecoverable parse failure.
    """
    cleaned = text.strip()
    # Strip fences
    if cleaned.startswith("```"):
        nl = cleaned.find("\n")
        if nl != -1:
            cleaned = cleaned[nl + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

    # Direct parse first
    try:
        parsed = _json.loads(cleaned)
    except _json.JSONDecodeError:
        # Extract first balanced {...} block
        parsed = _extract_balanced(cleaned)
        if parsed is None:
            return None

    if isinstance(parsed, list):
        return parsed if all(isinstance(e, dict) for e in parsed) else None
    if isinstance(parsed, dict):
        events = parsed.get("events")
        if isinstance(events, list) and all(isinstance(e, dict) for e in events):
            return events
    return None


def _extract_balanced(text: str) -> Any:
    """Find first balanced { ... } block and return parsed JSON."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    return _json.loads(text[start:i + 1])
                except _json.JSONDecodeError:
                    return None
    return None


# ─── Phase 3: deterministic validation ──────────────────────────────────────


def _coerce_ts(v: Any, lo: int, hi: int) -> int:
    """Timestamp coercion scoped to the chart range. Returns 0 if unusable."""
    if isinstance(v, (int, float)):
        n = int(v)
        if n > 10**12:
            n //= 1000
        return n if lo <= n <= hi else 0
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0
        if s.lstrip("-").isdigit():
            n = int(s)
            if n > 10**12:
                n //= 1000
            return n if lo <= n <= hi else 0
        try:
            from datetime import datetime as _dt
            s2 = s.replace("Z", "+00:00")
            dt = (_dt.fromisoformat(s2) if ("T" in s2 or "+" in s2 or len(s2) > 10)
                  else _dt.strptime(s2, "%Y-%m-%d"))
            n = int(dt.timestamp())
            return n if lo <= n <= hi else 0
        except (ValueError, ImportError):
            return 0
    return 0


def _source_from_url(url: str) -> str:
    """
    Extract a human-friendly source name from a URL. Handles common
    cases:
      reuters.com              -> Reuters
      www.reuters.com/foo      -> Reuters
      uk.finance.yahoo.com     -> Yahoo  (not 'Finance')
      news.bbc.co.uk/bar       -> Bbc    (not 'News')
      en.wikipedia.org/baz     -> Wikipedia
    Strategy: strip subdomain prefixes, then take the BRAND label —
    the one right before the TLD (handling .co.uk / .com.au /
    two-part TLDs by picking the 2nd-to-last label for .xx.yy
    and last-non-generic otherwise).
    """
    if not url:
        return "Unknown"
    try:
        from urllib.parse import urlparse
        host = urlparse(url).netloc.lower()
        if not host:
            return "Unknown"
        parts = host.split(".")
        # Strip leading generic subdomain labels
        _GENERIC = {"www", "m", "uk", "en", "news", "finance", "money",
                    "markets", "business", "www2", "mobile", "amp"}
        while len(parts) > 2 and parts[0] in _GENERIC:
            parts = parts[1:]
        # Two-part TLD (.co.uk / .com.au / .co.jp) — brand is at index -3
        _TWO_PART_SUFFIXES = {"co.uk", "co.jp", "com.au", "co.in",
                              "com.br", "co.za", "com.mx", "co.nz"}
        if len(parts) >= 3 and ".".join(parts[-2:]) in _TWO_PART_SUFFIXES:
            name = parts[-3]
        else:
            name = parts[-2] if len(parts) >= 2 else parts[0]
        return name.capitalize() if name else "Unknown"
    except Exception:  # noqa: BLE001
        return "Unknown"


# ─── Main agent ──────────────────────────────────────────────────────────────


class NewsDataProcessor:
    """
    The specialised agent that glues the three phases together.

    Usage from a skill processor:

        proc = NewsDataProcessor(
            chart_lo_unix=..., chart_hi_unix=...,
            chart_lo_iso=..., chart_hi_iso=...,
            topic="OIL", event_sink=swarm._event,
        )
        result = proc.process(real_findings_text)
        events = result.events  # ready to ship to the frontend
    """

    def __init__(
        self,
        chart_lo_unix: int,
        chart_hi_unix: int,
        chart_lo_iso: str,
        chart_hi_iso: str,
        topic: str,
        event_sink=None,
        batch_size: int = 5,
    ) -> None:
        self.lo_unix = chart_lo_unix
        self.hi_unix = chart_hi_unix
        self.lo_iso = chart_lo_iso
        self.hi_iso = chart_hi_iso
        self.topic = topic
        self.batch_size = batch_size
        # Event sink lets us emit swarm events for the trace UI.
        # Signature: (level, stage, message, agent_role)
        self._emit = event_sink or (lambda *a, **kw: None)

    def process(self, findings_text: str) -> ProcessResult:
        # ─── Phase 1 ─────────────────────────────────────────────────
        candidates = extract_candidates(findings_text)
        self._emit(
            "info", "news_processor",
            f"Phase 1: extracted {len(candidates)} candidate(s) from search findings",
            "news_processor",
        )

        if not candidates:
            return ProcessResult(
                events=[], summary="", key_themes=[],
                candidates_found=0,
                batches_processed=0, batches_failed=0,
                dropped_out_of_range=0, dropped_no_timestamp=0, dropped_no_url=0,
            )

        # Filter candidates that have no URL — we can't verify these
        # are real, and the whole point of this rewrite is no fakes.
        url_candidates = [c for c in candidates if c.url]
        no_url_drop = len(candidates) - len(url_candidates)

        # ─── Phase 2 ─────────────────────────────────────────────────
        if not llm_available():
            self._emit(
                "warn", "news_processor",
                "LLM unavailable — emitting raw candidates with defaulted analytic fields",
                "news_processor",
            )
            # Degraded mode: emit candidates with defaults so the user
            # sees something instead of nothing.
            enriched: List[Dict[str, Any]] = []
            for c in url_candidates:
                # Midpoint of chart range as a placeholder
                mid = (self.lo_unix + self.hi_unix) // 2
                enriched.append({
                    "headline": c.title,
                    "url": c.url,
                    "timestamp": mid,
                    "summary": c.snippet[:300],
                    "source": _source_from_url(c.url),
                    "category": "sentiment",
                    "impact": "medium",
                    "direction": "neutral",
                    "price_impact_pct": None,
                })
            return self._finalise(enriched, candidates_count=len(candidates),
                                  batches=0, failed=0, no_url=no_url_drop)

        # Batched LLM enrichment
        enriched_all: List[Dict[str, Any]] = []
        batches_total = 0
        batches_failed = 0
        for start in range(0, len(url_candidates), self.batch_size):
            batch = url_candidates[start:start + self.batch_size]
            batches_total += 1
            try:
                raw = chat_completion(
                    system_prompt=_ENRICH_SYSTEM,
                    user_message=_enrich_prompt_user(
                        batch,
                        self.lo_unix, self.hi_unix,
                        self.lo_iso, self.hi_iso,
                        self.topic,
                    ),
                    temperature=0.2,
                    max_tokens=1500,   # generous for 5 events
                    timeout_s=90.0,
                )
            except Exception as exc:  # noqa: BLE001
                batches_failed += 1
                self._emit(
                    "warn", "news_processor",
                    f"batch {batches_total} LLM call failed: {type(exc).__name__}: {str(exc)[:120]}",
                    "news_processor",
                )
                continue

            events = _parse_enrichment_output(raw)
            if events is None:
                batches_failed += 1
                self._emit(
                    "warn", "news_processor",
                    f"batch {batches_total} JSON parse failed (len={len(raw)}). First 200 chars: {raw[:200]!r}",
                    "news_processor",
                )
                continue

            # Overlay the REAL urls/titles from the candidate — protects
            # against the LLM rewriting them even though we told it not
            # to.
            for cand, ev in zip(batch, events):
                if not isinstance(ev, dict):
                    continue
                ev["url"] = cand.url                 # force real URL
                ev["headline"] = cand.title          # force real title
                enriched_all.append(ev)

            self._emit(
                "info", "news_processor",
                f"batch {batches_total}/{(len(url_candidates) + self.batch_size - 1) // self.batch_size}: enriched {len(events)} event(s)",
                "news_processor",
            )

        return self._finalise(
            enriched_all,
            candidates_count=len(candidates),
            batches=batches_total,
            failed=batches_failed,
            no_url=no_url_drop,
        )

    # ─── Phase 3 — deterministic validation + finalisation ──────────
    def _finalise(
        self,
        enriched: List[Dict[str, Any]],
        candidates_count: int,
        batches: int,
        failed: int,
        no_url: int,
    ) -> ProcessResult:
        out_events: List[Dict[str, Any]] = []
        dropped_range = 0
        dropped_ts = 0
        dropped_no_url = no_url

        for e in enriched:
            ts = _coerce_ts(e.get("timestamp"), self.lo_unix, self.hi_unix)
            url = str(e.get("url") or "").strip() or None
            if not url:
                dropped_no_url += 1
                continue
            if ts <= 0:
                if e.get("timestamp") in (None, "", 0):
                    dropped_ts += 1
                else:
                    dropped_range += 1
                continue

            out_events.append({
                "id": f"ne_{ts}_{len(out_events)}",
                "timestamp": ts,
                "headline": str(e.get("headline") or "").strip(),
                "summary": str(e.get("summary") or "").strip(),
                "source": str(e.get("source") or _source_from_url(url)).strip(),
                "url": url,
                "category": str(e.get("category") or "sentiment").lower().strip() or "sentiment",
                "impact": str(e.get("impact") or "medium").lower().strip() or "medium",
                "direction": str(e.get("direction") or "neutral").lower().strip() or "neutral",
                "price_impact_pct": (
                    float(e["price_impact_pct"])
                    if e.get("price_impact_pct") not in (None, "", "null")
                    and isinstance(e.get("price_impact_pct"), (int, float, str))
                    and str(e.get("price_impact_pct")).replace(".", "").replace("-", "").isdigit()
                    else None
                ),
            })

        out_events.sort(key=lambda x: x["timestamp"], reverse=True)

        # Derive a summary + key themes programmatically so we never
        # need another LLM call for this.
        by_cat: Dict[str, int] = {}
        for e in out_events:
            by_cat[e["category"]] = by_cat.get(e["category"], 0) + 1
        summary_parts: List[str] = []
        if out_events:
            bullish = sum(1 for e in out_events if e["direction"] == "bullish")
            bearish = sum(1 for e in out_events if e["direction"] == "bearish")
            summary_parts.append(
                f"{len(out_events)} news events across {self.lo_iso} to {self.hi_iso}. "
                f"{bullish} bullish, {bearish} bearish, {len(out_events) - bullish - bearish} neutral."
            )
        summary = " ".join(summary_parts)
        key_themes = [k for k, _ in sorted(by_cat.items(), key=lambda kv: -kv[1])[:5]]

        self._emit(
            "info", "news_processor",
            f"finalised: {len(out_events)} events kept, "
            f"{dropped_range} out-of-range, {dropped_ts} without timestamp, "
            f"{dropped_no_url} without URL",
            "news_processor",
        )

        return ProcessResult(
            events=out_events,
            summary=summary,
            key_themes=key_themes,
            candidates_found=candidates_count,
            batches_processed=batches,
            batches_failed=failed,
            dropped_out_of_range=dropped_range,
            dropped_no_timestamp=dropped_ts,
            dropped_no_url=dropped_no_url,
        )
