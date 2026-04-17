# Vibe Trade v0.4.1 — Stage 5 hang fix + ddgs migration

Patch release focused on two bugs the v0.4.0 release surfaced in the
wild on pipx-installed copies.

## What this fixes

### Stage 5 (report generation) could hang indefinitely

Users running full 50-agent / 30-round debates on slower providers
saw the pipeline freeze at *"Generating ReACT report..."* with no
progress and no eventual timeout.

Root cause: three stacked issues.

1. **Token budget too large** — the report LLM call asked for up to
   8000 tokens. At 50-100 tokens/sec on most providers that's 80-160s
   wall-clock, but we only gave each LLM call 90s (`LLM_CALL_TIMEOUT_S`)
   before treating it as a hang and retrying. Every retry was also
   cut off mid-generation, burning the retry budget without ever
   returning a response.

2. **No per-call timeout override** — `chat_completion()` always used
   the global 90s ceiling. A known-slow call like report generation
   had no way to ask for more headroom.

3. **Useless fallback** — on timeout or error, Stage 5 returned a
   `{consensus: NEUTRAL, confidence: 0, key_arguments: []}` stub that
   threw away all the debate data. The user saw nothing meaningful.

Fixed by:

- **Reducing report output to 4500 tokens** (still plenty for a
  multi-section investment note — roughly 45-90s wall-clock on any
  provider).
- **New `timeout_s` parameter** on `chat_completion()` and
  `chat_completion_json()`. The report agent now explicitly asks for
  240s, so a legitimately long generation doesn't get mistaken for a
  hang.
- **Real fallback summary** extracted directly from the debate thread
  if Stage 5 still fails:
  - Consensus from `_compute_consensus` (influence-weighted math on
    actual agent sentiments)
  - Top 5 bullish messages as `key_arguments` (ranked by
    sentiment × influence)
  - Top 3 bearish messages as `dissenting_views`
  - Price targets from the median/spread of `price_prediction`
    values in the thread
  - BUY/SELL/HOLD recommendation with entry, stop, and target
    anchored on the current close
- **Outer ceiling bumped** to 8 minutes (was 10) — no longer needed as
  a long fuse now that the per-call timeout is handled properly.

### `duckduckgo-search` deprecation warnings

Running any command that used web research spammed stderr with:

```
RuntimeWarning: This package (`duckduckgo_search`) has been renamed to
ddgs! Use `pip install ddgs` instead.
```

Fixed by switching the dependency in `pyproject.toml` from
`duckduckgo-search>=7.0` to `ddgs>=9.0`. The code in `swarm_tools.py`
already tried `ddgs` first and fell back to the old name, so the
migration is transparent: existing checkouts keep working, new installs
get the maintained package with no warnings.

## Upgrade

```bash
vibe-trade update
# or
pipx upgrade vibe-trade
```

Env vars (unchanged from 0.4.0, repeated here for reference):

```
LLM_CALL_TIMEOUT_S=90      # per-LLM-call timeout
LLM_MAX_RETRIES=2          # retries on transient failures
DEBATE_TIMEOUT_S=2700      # 45 min outer ceiling
```

## Links

- Source: <https://github.com/spyderweb47/Vibe-Trade>
- PyPI: <https://pypi.org/project/vibe-trade/>
- Issues: <https://github.com/spyderweb47/Vibe-Trade/issues>
