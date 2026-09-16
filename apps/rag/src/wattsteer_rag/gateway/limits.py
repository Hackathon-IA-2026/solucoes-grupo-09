"""Key pools and quota accounting.

Every provider on the free tier meters per account, so the team pools its keys:
each key is a slot with its own counters and its own cooling period. The router
exhausts the slots of one link before it moves to the next link of the chain,
which is what keeps a five person team from being limited to one person's quota.

A pool of one key behaves exactly like a single key. That is deliberate: nobody
should be blocked from developing because the rest of the team has not signed up.

Counters are fixed windows in Redis when a Redis URL is configured, and in
process memory otherwise. Fixed windows can let a burst through at a boundary;
the alternative costs a sorted set per call and buys us nothing here, because
the providers themselves reset on the minute.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

BRASILIA = ZoneInfo("America/Sao_Paulo")


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
    raw = ""
    if keys_env:
        raw = os.environ.get(keys_env, "")
    if not raw.strip() and key_env:
        raw = os.environ.get(key_env, "")
    seen: set[str] = set()
    slots: list[KeySlot] = []
    for part in raw.split(","):
        secret = part.strip()
        if not secret or secret in seen:
            continue
        seen.add(secret)
        slots.append(KeySlot(provider=provider, secret=secret))
    return slots


@dataclass
class Window:
    limit: int
    seconds: int
    used: int = 0
    resets_at: float = 0.0

    def room(self, cost: int, now: float) -> bool:
        if now >= self.resets_at:
            return cost <= self.limit
        return self.used + cost <= self.limit

    def take(self, cost: int, now: float) -> None:
        if now >= self.resets_at:
            self.used = 0
            self.resets_at = now + self.seconds
        self.used += cost

    def next_reset(self, now: float) -> float:
        return max(self.resets_at, now)


def _day_seconds(now: float) -> int:
    """Seconds until midnight in Brasilia, which is when the daily quotas reset."""
    local = datetime.fromtimestamp(now, BRASILIA)
    midnight = (local + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int(midnight.timestamp() - now))


@dataclass
class SlotState:
    """Counters for one key on one model."""

    rpm: Window | None = None
    tpm: Window | None = None
    rpd: Window | None = None
    tpd: Window | None = None
    cooling_until: float = 0.0
    failures: int = 0

    def room(self, tokens: int, now: float) -> bool:
        if now < self.cooling_until:
            return False
        for window, cost in ((self.rpm, 1), (self.tpm, tokens), (self.rpd, 1), (self.tpd, tokens)):
            if window is not None and not window.room(cost, now):
                return False
        return True

    def record(self, tokens: int, now: float) -> None:
        for window, cost in ((self.rpm, 1), (self.tpm, tokens), (self.rpd, 1), (self.tpd, tokens)):
            if window is not None:
                window.take(cost, now)

    def cool(self, seconds: float, now: float) -> None:
        self.cooling_until = max(self.cooling_until, now + seconds)
        self.failures += 1

    def next_free(self, now: float) -> float:
        candidates = [self.cooling_until]
        for window in (self.rpm, self.tpm, self.rpd, self.tpd):
            if window is not None and not window.room(1, now):
                candidates.append(window.next_reset(now))
        return max([c for c in candidates if c > now], default=now)


@dataclass
class Ledger:
    """All the counters, keyed by provider, key id and model."""

    limits: dict[str, dict] = field(default_factory=dict)
    state: dict[tuple[str, str, str], SlotState] = field(default_factory=dict)

    def configure(self, provider: str, limits: dict | None, per_model: dict | None) -> None:
        self.limits[provider] = {"default": limits or {}, "per_model": per_model or {}}

    def _limits_for(self, provider: str, model: str) -> dict:
        conf = self.limits.get(provider, {})
        per_model = conf.get("per_model") or {}
        return per_model.get(model) or conf.get("default") or {}

    def slot(self, provider: str, kid: str, model: str) -> SlotState:
        key = (provider, kid, model)
        if key not in self.state:
            limits = self._limits_for(provider, model)
            now = time.time()
            self.state[key] = SlotState(
                rpm=Window(limits["rpm"], 60, resets_at=now + 60) if limits.get("rpm") else None,
                tpm=Window(limits["tpm"], 60, resets_at=now + 60) if limits.get("tpm") else None,
                rpd=Window(limits["rpd"], _day_seconds(now), resets_at=now + _day_seconds(now))
                if limits.get("rpd")
                else None,
                tpd=Window(limits["tpd"], _day_seconds(now), resets_at=now + _day_seconds(now))
                if limits.get("tpd")
                else None,
            )
        return self.state[key]

    def snapshot(self) -> list[dict]:
        """What /internal/llm/quota serves. Key ids only, never a secret."""
        now = time.time()
        out = []
        for (provider, kid, model), slot in sorted(self.state.items()):
            windows = {}
            for name, window in (
                ("rpm", slot.rpm),
                ("tpm", slot.tpm),
                ("rpd", slot.rpd),
                ("tpd", slot.tpd),
            ):
                if window is None:
                    continue
                used = 0 if now >= window.resets_at else window.used
                windows[name] = {"used": used, "limit": window.limit}
            state = "cooling" if now < slot.cooling_until else "ok"
            if state == "ok" and not slot.room(1, now):
                state = "exhausted"
            out.append(
                {
                    "provider": provider,
                    "key_id": kid,
                    "model": model,
                    "state": state,
                    "windows": windows,
                    "failures": slot.failures,
                    "next_free_at": slot.next_free(now),
                }
            )
        return out
