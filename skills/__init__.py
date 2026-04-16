# Backward-compat re-exports. All logic now lives in core/.
# This file exists only so `skills` remains a valid Python package
# (needed for pyproject.toml package discovery of skills/**/*.md).
from core.skill_registry import skill_registry  # noqa: F401
