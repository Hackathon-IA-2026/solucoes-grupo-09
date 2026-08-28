"""Entrypoint: `wattsteer-ml`, `python -m wattsteer_ml`, and `bun run ml`.

One entrypoint for local and deployed runs, so the port and reload rules are
decided in a single place rather than duplicated across a compose command, a
Dockerfile CMD and a README.
"""

from __future__ import annotations

import uvicorn

from .config import settings


def main() -> None:
    uvicorn.run(
        "wattsteer_ml.app:app",
        host="0.0.0.0",  # noqa: S104 — container-local; only the gateway reaches it
        port=settings.port,
        reload=not settings.is_prod,
        log_level="info",
    )


if __name__ == "__main__":
    main()
