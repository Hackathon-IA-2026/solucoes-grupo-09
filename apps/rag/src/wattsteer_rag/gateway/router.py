"""The router: it decides which key of which provider answers, and what happens
when none of them can.

The rule the rest of the service depends on: a call either returns a result, or
raises `QuotaExhausted` with the instant the work can resume. It never fails
because a free tier ran out, and it never silently changes the model that
produced an embedding.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import yaml

from .adapters import OpenAICompatibleAdapter, ProviderError
from .limits import KeySlot, Ledger, load_keys

log = logging.getLogger("wattsteer_rag.gateway")

DEFAULT_COOLING_S = 60.0
# A quota answers 429 and recovers; these say the request itself is wrong.
# 402 is an account that has to be paid for before it answers at all, which a
# minute of cooling does not change (Cerebras without a card, 22/09/2026).
NON_RETRYABLE = {400, 401, 402, 403, 404, 405, 410, 422}
CALLS_KEPT = 500


class ProviderRefused(Exception):
    """A link that will keep refusing: a bad key, an unknown model, a bad request.

    Telling this apart from a spent quota matters. A wrong model name that is
    treated as "no quota left" burns every key in the pool and then reports a
    delay, when the honest answer is that the configuration is wrong.
    """


class QuotaExhausted(Exception):
    """Every link of the chain is out of room. Carries when to try again."""

    def __init__(self, task: str, retry_at: float):
        super().__init__(f"{task}: every provider is out of quota")
        self.task = task
        self.retry_at = retry_at


@dataclass
class Result:
    value: Any
    provider: str
    model: str
    key_id: str
    attempts: int
    latency_ms: int
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class Link:
    provider: str
    model: str
    max_input_tokens: int | None = None


@dataclass
class Task:
    name: str
    chain: list[Link]
    model: str | None = None
    dimensions: int | None = None
    batch_size: int = 32
    temperature: float = 0.0
    max_output_tokens: int = 1000
    want_json: bool = False


@dataclass
class Provider:
    name: str
    adapter: OpenAICompatibleAdapter
    keys: list[KeySlot] = field(default_factory=list)
    enabled: bool = True


@dataclass
class _Walk:
    """What one `run` has learned so far, across links."""

    attempts: int = 0
    soonest: float = float("inf")
    refusals: list[str] = field(default_factory=list)


class Gateway:
    def __init__(self, config_path: Path, *, user_agent: str = "wattsteer-rag"):
        self.config_path = config_path
        self.user_agent = user_agent
        self.ledger = Ledger()
        self.providers: dict[str, Provider] = {}
        self.tasks: dict[str, Task] = {}
        self.calls: list[dict] = []
        self._client: httpx.AsyncClient | None = None
        self._load()

    # configuration -----------------------------------------------------

    def _load(self) -> None:
        raw = yaml.safe_load(self.config_path.read_text())
        for name, spec in (raw.get("providers") or {}).items():
            self.providers[name] = self._provider(name, spec)
            self.ledger.configure(name, spec.get("limits"), spec.get("limits_per_model"))
        for name, spec in (raw.get("tasks") or {}).items():
            self.tasks[name] = self._task(name, spec)
        self._check_embedding_identity()

    def _provider(self, name: str, spec: dict) -> Provider:
        adapter = OpenAICompatibleAdapter(
            name,
            spec.get("base_url", ""),
            float(spec.get("timeout_s", 60)),
            self.user_agent,
            thinking_toggle=bool((spec.get("extra") or {}).get("thinking_toggle")),
        )
        keys = load_keys(name, spec.get("api_keys_env"), spec.get("api_key_env"))
        # A provider without a key is not an error: it is a link the chain skips.
        return Provider(name, adapter, keys, enabled=bool(spec.get("enabled", True)) and bool(keys))

    @staticmethod
    def _task(name: str, spec: dict) -> Task:
        return Task(
            name=name,
            chain=[
                Link(link["provider"], link.get("model", ""), link.get("max_input_tokens"))
                for link in spec.get("chain", [])
            ],
            model=spec.get("model"),
            dimensions=spec.get("dimensions"),
            batch_size=int(spec.get("batch_size", 32)),
            temperature=float(spec.get("temperature", 0.0)),
            max_output_tokens=int(spec.get("max_output_tokens", 1000)),
            want_json=bool((spec.get("require") or {}).get("json_schema")),
        )

    def _check_embedding_identity(self) -> None:
        """One embedding model per chain, always. Two would mean two vector spaces
        in one index, and a similarity score that means nothing."""
        task = self.tasks.get("embed")
        if not task:
            return
        models = {link.model.lower() for link in task.chain if link.model}
        if len(models) > 1:
            raise ValueError(f"embed chain mixes vector spaces: {sorted(models)}")

    # plumbing ----------------------------------------------------------

    async def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient()
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def usable_links(self, task_name: str) -> list[tuple[Link, Provider]]:
        out = []
        for link in self.tasks[task_name].chain:
            provider = self.providers.get(link.provider)
            if provider and provider.enabled:
                out.append((link, provider))
        return out

    def _pick_key(self, provider: Provider, model: str, tokens: int) -> KeySlot | None:
        """The key with the most room, so one person's quota is not spent first."""
        now = time.time()
        best: tuple[float, KeySlot] | None = None
        for slot in provider.keys:
            state = self.ledger.slot(provider.name, slot.id, model)
            if not state.room(tokens, now):
                continue
            headroom = state.headroom(now)
            if best is None or headroom > best[0]:
                best = (headroom, slot)
        return best[1] if best else None

    # the one entry point ------------------------------------------------

    async def run(self, task_name: str, *, tokens: int = 0, **kwargs) -> Result:
        task = self.tasks[task_name]
        walk = _Walk()
        for link, provider in self.usable_links(task_name):
            if link.max_input_tokens and tokens > link.max_input_tokens:
                continue  # this link cannot hold the payload; not a failure
            result = await self._run_link(task, link, provider, tokens, kwargs, walk)
            if result is not None:
                return result
        if walk.refusals and walk.soonest == float("inf"):
            raise ProviderRefused(f"{task_name}: every link refused ({'; '.join(walk.refusals)})")
        retry_at = walk.soonest if walk.soonest != float("inf") else time.time() + DEFAULT_COOLING_S
        raise QuotaExhausted(task_name, retry_at)

    async def _run_link(
        self, task: Task, link: Link, provider: Provider, tokens: int, kwargs: dict, walk: _Walk
    ) -> Result | None:
        """Every key of one link, most room first. None means the link is spent or refused."""
        model = link.model or task.model or ""
        while (slot := self._pick_key(provider, model, tokens)) is not None:
            walk.attempts += 1
            started = time.perf_counter()
            try:
                value, usage = await self._invoke(task, provider, model, slot, kwargs)
            except ProviderError as exc:
                self._record(task.name, provider.name, slot.id, model, walk.attempts, 0, 0, str(exc))
                log.warning("gateway %s %s key=%s: %s", task.name, model, slot.id, exc)
                if exc.status in NON_RETRYABLE:
                    # Not a quota problem: the same request fails on every key.
                    walk.refusals.append(f"{provider.name}:{model} HTTP {exc.status}")
                    return None
                state = self.ledger.slot(provider.name, slot.id, model)
                state.cool(exc.retry_after or DEFAULT_COOLING_S, time.time())
                continue  # another key of the same link, then the next link
            tokens_in = int(usage.get("prompt_tokens") or 0)
            tokens_out = int(usage.get("completion_tokens") or 0)
            state = self.ledger.slot(provider.name, slot.id, model)
            state.record(max(tokens, tokens_in + tokens_out), time.time())
            self._record(task.name, provider.name, slot.id, model, walk.attempts, tokens_in, tokens_out, None)
            return Result(
                value=value,
                provider=provider.name,
                model=model,
                key_id=slot.id,
                attempts=walk.attempts,
                latency_ms=int((time.perf_counter() - started) * 1000),
                tokens_in=tokens_in,
                tokens_out=tokens_out,
            )
        now = time.time()
        for key in provider.keys:
            walk.soonest = min(walk.soonest, self.ledger.slot(provider.name, key.id, model).next_free(now))
        return None

    async def _invoke(self, task: Task, provider: Provider, model: str, slot: KeySlot, kwargs: dict):
        """Three verbs, chosen by the task: `embed`, `parse`, and everything else chats."""
        client = await self.client()
        adapter = provider.adapter
        if task.name == "embed":
            return await adapter.embed(
                client,
                slot.secret,
                model=model,
                texts=kwargs["texts"],
                input_type=kwargs.get("input_type", "passage"),
            )
        if task.name == "parse":
            return await adapter.parse_page(client, slot.secret, model=model, image=kwargs["image"])
        return await adapter.chat(
            client,
            slot.secret,
            model=model,
            messages=kwargs["messages"],
            max_tokens=kwargs.get("max_tokens", task.max_output_tokens),
            temperature=kwargs.get("temperature", task.temperature),
            want_json=kwargs.get("want_json", task.want_json),
        )

    def _record(self, task, provider, kid, model, attempts, tokens_in, tokens_out, error) -> None:
        self.calls.append(
            {
                "task": task,
                "provider": provider,
                "key_id": kid,
                "model": model,
                "attempt": attempts,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "error": error,
                "at": time.time(),
            }
        )
        del self.calls[:-CALLS_KEPT]

    def quota(self) -> dict:
        return {
            "providers": {
                name: {"enabled": provider.enabled, "keys": len(provider.keys)}
                for name, provider in self.providers.items()
            },
            "slots": self.ledger.snapshot(),
            "recent_calls": self.calls[-20:],
        }
