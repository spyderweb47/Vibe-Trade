"""Allow `python -m vibe_trade` as an alternative entry point."""

from vibe_trade.cli import app


if __name__ == "__main__":
    app()
