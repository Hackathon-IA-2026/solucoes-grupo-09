"""Key pools and quota accounting.

Every provider on the free tier meters per account, so the team pools its keys:
each key is a slot with its own counters and its own cooling period. The router
exhausts the slots of one link before it moves to the next link of the chain,
which is what keeps a five person team from being limited to one person's quota.

A pool of one key behaves exactly like a single key. That is deliberate: nobody
should be blocked from developing because the rest of the team has not signed up.

Counters are fixed windows in process memory. That is honest only for a single
replica: two processes each start their own count, so the pool can exceed the
provider's real limit. Fixed windows can let a burst through at a boundary; the
alternative costs a sorted set per call and buys nothing here, because the
providers themselves reset on the minute.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BRASILIA = ZoneInfo("America/Sao_Paulo")

# The four windows a provider can declare. Requests cost one; tokens cost the
# request's tokens. A minute window resets sixty seconds after it opened; a
# daily window resets at midnight in Brasilia, which is when the quotas do.
WINDOW_NAMES = ("rpm", "tpm", "rpd", "tpd")
TOKEN_WINDOWS = {"tpm", "tpd"}
DAILY_WINDOWS = {"rpd", "tpd"}


def key_id(secret: str) -> str:
    """A stable, non-reversible label for a key, safe to log."""
    return hashlib.sha256(secret.encode()).hexdigest()[:8]


@dataclass(frozen=True)
class KeySlot:
    provider: str
    secret: str

    @property
    def id(self) -> str:
        return key_id(self.secret)


def load_keys(provider: str, keys_env: str | None, key_env: str | None) -> list[KeySlot]:
    """Resolve a pool: the plural variable first, then the singular, then nothing.

    A provider with no key is not an error. It is a link the chain will skip.
    """
    raw = os.environ.get(keys_env, "") if keys_env else ""
    if not raw.strip() and key_env:
        raw = os.environ.get(key_env, "")
    secrets = list(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    return [KeySlot(provider=provider, secret=secret) for secret in secrets]


def _day_seconds(now: float) -> int:
    """Seconds until midnight in Brasilia."""
    local = datetime.fromtimestamp(now, BRASILIA)
    midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int(midnight.timestamp() - now))


@dataclass
class Window:
    limit: int
    daily: bool = False
    used: int = 0
    resets_at: float = 0.0

    def used_now(self, now: float) -> int:
        return 0 if now >= self.resets_at else self.used

    def room(self, cost: int, now: float) -> bool:
        return self.used_now(now) + cost <= self.limit

    def take(self, cost: int, now: float) -> None:
        if now >= self.resets_at:
            self.used = 0
            # Recomputed rather than reused: keeping the original span would make
            # a window created at noon reset at noon forever.
            self.resets_at = now + (_day_seconds(now) if self.daily else 60)
        self.used += cost

    def next_reset(self, now: float) -> float:
        return max(self.resets_at, now)


def _cost(window: str, tokens: int) -> int:
    return tokens if window in TOKEN_WINDOWS else 1


@dataclass
class SlotState:
    """Counters for one key on one model."""

    windows: dict[str, Window] = field(default_factory=dict)
    cooling_until: float = 0.0
    failures: int = 0

    def room(self, tokens: int, now: float) -> bool:
        if now < self.cooling_until:
            return False
        return all(window.room(_cost(name, tokens), now) for name, window in self.windows.items())

    def record(self, tokens: int, now: float) -> None:
        for name, window in self.windows.items():
            window.take(_cost(name, tokens), now)

    def cool(self, seconds: float, now: float) -> None:
        self.cooling_until = max(self.cooling_until, now + seconds)
        self.failures += 1

    def next_free(self, now: float) -> float:
        candidates = [self.cooling_until]
        candidates += [window.next_reset(now) for window in self.windows.values() if not window.room(1, now)]
        return max([c for c in candidates if c > now], default=now)

    def headroom(self, now: float) -> float:
        """How much of every window is still free, summed. Higher is emptier."""
        return sum((w.limit - w.used_now(now)) / w.limit for w in self.windows.values() if w.limit)

    def state(self, now: float) -> str:
        if now < self.cooling_until:
            return "cooling"
        return "ok" if self.room(1, now) else "exhausted"


@dataclass
class Ledger:
    """All the counters, keyed by provider, key id and model."""

    limits: dict[str, dict] = field(default_factory=dict)
    state: dict[tuple[str, str, str], SlotState] = field(default_factory=dict)

    def configure(self, provider: str, limits: dict | None, per_model: dict | None) -> None:
        self.limits[provider] = {"default": limits or {}, "per_model": per_model or {}}

    def _limits_for(self, provider: str, model: str) -> dict:
        conf = self.limits.get(provider, {})
        return (conf.get("per_model") or {}).get(model) or conf.get("default") or {}

    def slot(self, provider: str, kid: str, model: str) -> SlotState:
        key = (provider, kid, model)
        if key not in self.state:
            now = time.time()
            limits = self._limits_for(provider, model)
            windows = {}
            for name in WINDOW_NAMES:
                if limits.get(name):
                    daily = name in DAILY_WINDOWS
                    windows[name] = Window(
                        limits[name], daily, resets_at=now + (_day_seconds(now) if daily else 60)
                    )
            self.state[key] = SlotState(windows)
        return self.state[key]

    def snapshot(self) -> list[dict]:
        """What /internal/llm/quota serves. Key ids only, never a secret."""
        now = time.time()
        return [
            {
                "provider": provider,
                "key_id": kid,
                "model": model,
                "state": slot.state(now),
                "windows": {
                    name: {"used": window.used_now(now), "limit": window.limit}
                    for name, window in slot.windows.items()
                },
                "failures": slot.failures,
                "next_free_at": slot.next_free(now),
            }
            for (provider, kid, model), slot in sorted(self.state.items())
        ]
