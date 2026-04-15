"""
Multi-provider LLM client for agent interactions.

Supports the following providers via a unified interface:
  - openai         (default, uses OPENAI_API_KEY)
  - openrouter     (uses OPENROUTER_API_KEY, any model available on OpenRouter)
  - deepseek       (uses DEEPSEEK_API_KEY, default deepseek-chat)
  - groq           (uses GROQ_API_KEY, fast inference for Llama/Mixtral)
  - anthropic      (uses ANTHROPIC_API_KEY, native Claude SDK)
  - gemini         (uses GOOGLE_API_KEY, OpenAI-compat endpoint)
  - together       (uses TOGETHER_API_KEY, open-source models)
  - fireworks      (uses FIREWORKS_API_KEY, fast inference)
  - ollama         (local, uses OLLAMA_BASE_URL, no key needed)

Select the provider via the LLM_PROVIDER env var (default: openai).
Optionally override the model via LLM_MODEL.

Example .env:
  LLM_PROVIDER=anthropic
  LLM_MODEL=claude-sonnet-4-5
  ANTHROPIC_API_KEY=sk-ant-...
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

try:
    from openai import OpenAI
except ImportError:
    OpenAI = None  # type: ignore

try:
    import anthropic
except ImportError:
    anthropic = None  # type: ignore


# ─── Provider configuration ─────────────────────────────────────────────────

# Each provider entry: (default_model, base_url, env_var_name)
# base_url=None means "use OpenAI SDK default" (for openai itself)
# env_var_name=None means "no key needed" (for ollama)
PROVIDER_CONFIG: Dict[str, Dict[str, Any]] = {
    "openai": {
        "default_model": "gpt-4o-mini",
        "base_url": None,
        "env_var": "OPENAI_API_KEY",
        "kind": "openai_compat",
    },
    "openrouter": {
        "default_model": "openai/gpt-4o-mini",
        "base_url": "https://openrouter.ai/api/v1",
        "env_var": "OPENROUTER_API_KEY",
        "kind": "openai_compat",
    },
    "deepseek": {
        "default_model": "deepseek-chat",
        "base_url": "https://api.deepseek.com/v1",
        "env_var": "DEEPSEEK_API_KEY",
        "kind": "openai_compat",
    },
    "groq": {
        "default_model": "llama-3.3-70b-versatile",
        "base_url": "https://api.groq.com/openai/v1",
        "env_var": "GROQ_API_KEY",
        "kind": "openai_compat",
    },
    "gemini": {
        "default_model": "gemini-2.0-flash",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "env_var": "GOOGLE_API_KEY",
        "kind": "openai_compat",
    },
    "together": {
        "default_model": "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "base_url": "https://api.together.xyz/v1",
        "env_var": "TOGETHER_API_KEY",
        "kind": "openai_compat",
    },
    "fireworks": {
        "default_model": "accounts/fireworks/models/llama-v3p3-70b-instruct",
        "base_url": "https://api.fireworks.ai/inference/v1",
        "env_var": "FIREWORKS_API_KEY",
        "kind": "openai_compat",
    },
    "ollama": {
        "default_model": "llama3.2",
        "base_url": None,  # filled from OLLAMA_BASE_URL env var
        "env_var": None,
        "kind": "openai_compat",
    },
    "anthropic": {
        "default_model": "claude-sonnet-4-5",
        "base_url": None,
        "env_var": "ANTHROPIC_API_KEY",
        "kind": "anthropic",
    },
}


def _active_provider() -> str:
    """Which LLM provider is currently configured?"""
    provider = os.environ.get("LLM_PROVIDER", "openai").lower().strip()
    if provider not in PROVIDER_CONFIG:
        # Unknown provider — fall back to openai
        return "openai"
    return provider


def _active_model() -> str:
    """Which model to use (env override or provider default)."""
    override = os.environ.get("LLM_MODEL", "").strip()
    if override:
        return override
    return PROVIDER_CONFIG[_active_provider()]["default_model"]


# ─── OpenAI-compatible client factory ────────────────────────────────────────

def _get_openai_compat_client() -> "OpenAI":
    """Build an OpenAI SDK client pointed at the configured provider."""
    if OpenAI is None:
        raise RuntimeError("openai package is not installed. Run: pip install openai")

    provider = _active_provider()
    config = PROVIDER_CONFIG[provider]

    # Resolve API key
    if provider == "ollama":
        api_key = "ollama"  # placeholder — Ollama doesn't require a real key
        base_url = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1")
    else:
        env_var = config["env_var"]
        api_key = os.environ.get(env_var) if env_var else None
        if not api_key:
            raise RuntimeError(
                f"{env_var} environment variable is not set. "
                f"Set it in your .env file before starting the server."
            )
        base_url = config["base_url"]

    if base_url:
        return OpenAI(api_key=api_key, base_url=base_url)
    return OpenAI(api_key=api_key)


# ─── Anthropic client factory ────────────────────────────────────────────────

def _get_anthropic_client():
    """Build a native Anthropic SDK client."""
    if anthropic is None:
        raise RuntimeError(
            "anthropic package is not installed. Run: pip install anthropic"
        )
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY environment variable is not set. "
            "Set it in your .env file before starting the server."
        )
    return anthropic.Anthropic(api_key=api_key)


# ─── Unified chat_completion API ─────────────────────────────────────────────

def chat_completion(
    system_prompt: str,
    user_message: str,
    model: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
) -> str:
    """
    Send a chat completion request to the configured LLM provider.

    Parameters
    ----------
    system_prompt : str
        System message setting the agent's role and constraints.
    user_message : str
        The user's input.
    model : str, optional
        Override the configured model for this call.
    temperature : float
        Sampling temperature (lower = more deterministic).
    max_tokens : int
        Maximum tokens in the response.

    Returns
    -------
    str
        The assistant's response text.
    """
    provider = _active_provider()
    kind = PROVIDER_CONFIG[provider]["kind"]
    chosen_model = model or _active_model()

    if kind == "anthropic":
        client = _get_anthropic_client()
        response = client.messages.create(
            model=chosen_model,
            system=system_prompt,
            messages=[{"role": "user", "content": user_message}],
            temperature=temperature,
            max_tokens=max_tokens,
        )
        # Anthropic returns a list of content blocks — join text blocks
        text_parts = []
        for block in response.content:
            if hasattr(block, "text"):
                text_parts.append(block.text)
        return "".join(text_parts)

    # OpenAI-compatible path (openai, openrouter, deepseek, groq, gemini,
    # together, fireworks, ollama)
    client = _get_openai_compat_client()
    response = client.chat.completions.create(
        model=chosen_model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return response.choices[0].message.content or ""


def chat_completion_json(
    system_prompt: str,
    user_message: str,
    model: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: int = 4096,
) -> Dict[str, Any]:
    """
    Send a chat completion request and parse the response as JSON.

    Falls back to returning {"raw": response_text} if JSON parsing fails.
    """
    text = chat_completion(
        system_prompt=system_prompt,
        user_message=user_message,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    cleaned = text.strip()
    if cleaned.startswith("```"):
        first_newline = cleaned.index("\n") if "\n" in cleaned else len(cleaned)
        cleaned = cleaned[first_newline + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw": text}


def is_available() -> bool:
    """Check if the configured LLM provider has its API key set."""
    provider = _active_provider()
    config = PROVIDER_CONFIG[provider]

    # Check required package
    if config["kind"] == "anthropic":
        if anthropic is None:
            return False
    else:
        if OpenAI is None:
            return False

    # Check API key (or no key required for ollama)
    env_var = config["env_var"]
    if env_var is None:
        return True  # ollama
    return bool(os.environ.get(env_var))


def active_provider_info() -> Dict[str, str]:
    """Return the currently active provider and model (for /chat/status endpoint)."""
    provider = _active_provider()
    return {
        "provider": provider,
        "model": _active_model(),
    }


# ─── Backwards compatibility ─────────────────────────────────────────────────

# Old code imports `DEFAULT_MODEL` — keep it for compatibility.
DEFAULT_MODEL = PROVIDER_CONFIG["openai"]["default_model"]


def get_client() -> "OpenAI":
    """Legacy: returns an OpenAI-compatible client for the active provider."""
    return _get_openai_compat_client()
