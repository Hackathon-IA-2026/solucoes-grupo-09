"""The two things every command and every route needs: a database and a gateway.

Built in one place so that the HTTP service and the command line cannot drift
apart in how they are configured, and closed in one place so that no command
forgets to.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

from .config import settings
from .db import Database
from .gateway.router import Gateway


@dataclass
class Runtime:
    db: Database
    gateway: Gateway


@asynccontextmanager
async def open_runtime(*, migrate: bool = False) -> AsyncIterator[Runtime]:
    conf = settings()
    runtime = Runtime(Database(), Gateway(conf.gateway_config, user_agent=conf.user_agent))
    try:
        if migrate:
            await runtime.db.migrate()
        yield runtime
    finally:
        await runtime.gateway.aclose()
        await runtime.db.close()
