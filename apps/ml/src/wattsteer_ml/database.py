"""Read-only Postgres access.

**Drizzle owns migrations; Python reads.** That boundary is stated in
`docs/specs/data-platform.md` and it is enforced here in code rather than left
to discipline: every connection in the pool opens with
`default_transaction_read_only = on`, so a stray `INSERT` in this service raises
`ReadOnlySqlTransactionError` at the database, not at review time. The service
also never runs a migration and owns no DDL.

Two layers, because one is not enough. In production the ML service should
additionally connect as a Postgres role granted `SELECT` and nothing else —
session read-only is a guard against our own mistakes, a role is a guard
against the connection string leaking. Locally there is one superuser role, so
the session guard is what there is; `WATTSTEER_ML_DATABASE_URL` exists so the
deployed service can be pointed at the restricted role independently.
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg

from .config import settings

log = logging.getLogger(__name__)

#: Applied to every pooled connection. `asyncpg` sends these as startup
#: parameters, so there is no window in which the session is writable.
READ_ONLY_SESSION: dict[str, str] = {
    "default_transaction_read_only": "on",
    "application_name": "wattsteer-ml",
}


class Database:
    """A lazily-opened, read-only connection pool.

    Lazy because the service must boot and answer `/health` with no database
    reachable — a health probe that depends on Postgres turns a database blip
    into a restart loop. `/ready` is where the database is allowed to matter.
    """

    def __init__(self, url: str) -> None:
        self._url = url
        self._pool: asyncpg.Pool[Any] | None = None

    async def connect(self) -> asyncpg.Pool[Any]:
        if self._pool is None:
            self._pool = await asyncpg.create_pool(
                self._url,
                min_size=settings.db_pool_min,
                max_size=settings.db_pool_max,
                timeout=settings.db_connect_timeout_sec,
                command_timeout=30,
                server_settings=READ_ONLY_SESSION,
            )
        return self._pool

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    async def ping(self) -> bool:
        """True when the database answers. Never raises — callers report."""
        try:
            pool = await self.connect()
            async with pool.acquire() as conn:
                await conn.fetchval("select 1")
        except (OSError, asyncpg.PostgresError, TimeoutError) as err:
            log.warning("database ping failed: %s", err)
            return False
        return True

    async def is_read_only(self) -> bool:
        """Assert the session guard actually took, rather than assuming it."""
        pool = await self.connect()
        async with pool.acquire() as conn:
            value = await conn.fetchval("show default_transaction_read_only")
        return bool(value == "on")

    async def relation_exists(self, name: str) -> bool:
        """Whether a Drizzle-owned table or view is present yet.

        Used by `/ready` to distinguish "no database" from "database, but
        migrations have not run" — two failures with very different fixes, and
        the fix for the second is never ours.
        """
        pool = await self.connect()
        async with pool.acquire() as conn:
            return bool(await conn.fetchval("select to_regclass($1) is not null", name))


#: `None` when no URL is configured — the service still boots and says so.
database: Database | None = (
    Database(settings.database_url) if settings.database_url else None
)
