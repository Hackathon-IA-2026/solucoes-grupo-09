"""The router: it decides which key of which provider answers, and what happens
when none of them can.

The rule the rest of the service depends on: a call either returns a result, or
returns a `waiting_quota` outcome with the instant the work can resume. It never
raises because a free tier ran out, and it never silently changes the model that
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

from .adapters import Block, OpenAICompatibleAdapter, PopplerAdapter, ProviderError
from .limits import KeySlot, Ledger, load_keys

log = logging.getLogger("wattsteer_rag.gateway")

DEFAULT_COOLING_S = 60.0
# A quota answers 429 and recovers; these say the request itself is wrong.
NON_RETRYABLE = {400, 401, 403, 404, 405, 410, 422}


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
    source: str = "model"


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
    top_n: int = 8
    temperature: float = 0.0
    max_output_tokens: int = 1000
    want_json: bool = False
    on_exhausted: str = "waiting_quota"


@dataclass
class Provider:
    name: str
    kind: str
    adapter: Any
    keys: list[KeySlot] = field(default_factory=list)
    enabled: bool = True


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
            kind = spec.get("kind", "openai_compatible")
            keys = load_keys(name, spec.get("api_keys_env"), spec.get("api_key_env"))
            if kind == "openai_compatible":
                base = _expand(spec.get("base_url", ""))
                adapter: Any = OpenAICompatibleAdapter(
                    name,
                    base,
                    float(spec.get("timeout_s", 60)),
                    self.user_agent,
                    thinking_toggle=bool((spec.get("extra") or {}).get("thinking_toggle")),
                )
            elif kind == "local":
                # Poppler, not Docling. The chain used to name a dependency that
                # was never installed, which is a promise the fallback cannot keep.
                adapter = PopplerAdapter()
                keys = keys or [KeySlot(provider=name, secret="local")]
            else:
                # bedrock and template are declared in the config before they exist.
                adapter = None
            enabled = bool(spec.get("enabled", True)) and (adapter is not None) and bool(keys)
            self.providers[name] = Provider(name, kind, adapter, keys, enabled)
            self.ledger.configure(name, spec.get("limits"), spec.get("limits_per_model"))

        for name, spec in (raw.get("tasks") or {}).items():
            chain = [
                Link(link["provider"], link.get("model", ""), link.get("max_input_tokens"))
                for link in spec.get("chain", [])
            ]
            self.tasks[name] = Task(
                name=name,
                chain=chain,
                model=spec.get("model"),
                dimensions=spec.get("dimensions"),
                batch_size=int(spec.get("batch_size", 32)),
                top_n=int(spec.get("top_n", 8)),
                temperature=float(spec.get("temperature", 0.0)),
                max_output_tokens=int(spec.get("max_output_tokens", 1000)),
                want_json=bool((spec.get("require") or {}).get("json_schema")),
                on_exhausted=spec.get("on_exhausted", "waiting_quota"),
            )
        self._check_embedding_identity()

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
        task = self.tasks[task_name]
        out = []
        for link in task.chain:
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
            headroom = 0.0
            for window in (state.rpm, state.tpm, state.rpd, state.tpd):
                if window is not None and window.limit:
                    used = 0 if now >= window.resets_at else window.used
                    headroom += (window.limit - used) / window.limit
            if best is None or headroom > best[0]:
                best = (headroom, slot)
        return best[1] if best else None

    # the one entry point ------------------------------------------------

    async def run(self, task_name: str, *, tokens: int = 0, **kwargs) -> Result:
        task = self.tasks[task_name]
        attempts = 0
        soonest = float("inf")
        refusals: list[str] = []
        client = await self.client()

        for link, provider in self.usable_links(task_name):
            model = link.model or task.model or ""
            if link.max_input_tokens and tokens > link.max_input_tokens:
                continue  # this link cannot hold the payload; not a failure
            while True:
                slot = self._pick_key(provider, model, tokens)
                if slot is None:
                    for key in provider.keys:
                        state = self.ledger.slot(provider.name, key.id, model)
                        soonest = min(soonest, state.next_free(time.time()))
                    break
                attempts += 1
                started = time.perf_counter()
                try:
                    value, usage = await self._invoke(task, link, provider, slot, client, **kwargs)
                except ProviderError as exc:
                    self._record(task_name, provider.name, slot.id, model, attempts, 0, 0, str(exc))
                    log.warning("gateway %s %s key=%s: %s", task_name, model, slot.id, exc)
                    if exc.status in NON_RETRYABLE:
                        # Not a quota problem: the same request will fail on every
                        # key. Disable the link for this run and move on.
                        refusals.append(f"{provider.name}:{model} HTTP {exc.status}")
                        break
                    state = self.ledger.slot(provider.name, slot.id, model)
                    state.cool(exc.retry_after or DEFAULT_COOLING_S, time.time())
                    continue  # another key of the same link, then the next link
                latency = int((time.perf_counter() - started) * 1000)
                tokens_in = int(usage.get("prompt_tokens") or 0)
                tokens_out = int(usage.get("completion_tokens") or 0)
                self.ledger.slot(provider.name, slot.id, model).record(
                    max(tokens, tokens_in + tokens_out), time.time()
                )
                self._record(task_name, provider.name, slot.id, model, attempts, tokens_in, tokens_out, None)
                return Result(
                    value=value,
                    provider=provider.name,
                    model=model,
                    key_id=slot.id,
                    attempts=attempts,
                    latency_ms=latency,
                    tokens_in=tokens_in,
                    tokens_out=tokens_out,
                )

        retry_at = soonest if soonest != float("inf") else time.time() + 60
        if task.on_exhausted == "skip_rerank":
            return Result(None, "none", "", "", attempts, 0, source="skipped")
        if task.on_exhausted == "template":
            return Result(None, "template", "", "", attempts, 0, source="template")
        if task.on_exhausted == "fail" or (refusals and soonest == float("inf")):
            raise ProviderRefused(
                f"{task_name}: every link refused ({'; '.join(refusals) or 'no link usable'})"
            )
        raise QuotaExhausted(task_name, retry_at)

    async def _invoke(self, task: Task, link: Link, provider: Provider, slot: KeySlot, client, **kwargs):
        model = link.model or task.model or ""
        if task.name == "embed":
            return await provider.adapter.embed(
                client,
                slot.secret,
                model=model,
                texts=kwargs["texts"],
                input_type=kwargs.get("input_type", "passage"),
            )
        if task.name == "parse":
            if provider.kind == "local":
                return provider.adapter.parse_pdf_page(kwargs["pdf_path"], kwargs["page"]), {}
            return await provider.adapter.parse_page(client, slot.secret, model=model, image=kwargs["image"])
        return await provider.adapter.chat(
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
        del self.calls[:-500]

    def quota(self) -> dict:
        return {
            "providers": {
                name: {
                    "enabled": provider.enabled,
                    "keys": len(provider.keys),
                    "kind": provider.kind,
                }
                for name, provider in self.providers.items()
            },
            "slots": self.ledger.snapshot(),
            "recent_calls": self.calls[-20:],
        }


def _expand(value: str) -> str:
    """Support ${VAR:-default} in the config without pulling in a template engine."""
    import os
    import re as _re

    def replace(match: _re.Match[str]) -> str:
        name, _, default = match.group(1).partition(":-")
        return os.environ.get(name, default)

    return _re.sub(r"\$\{([^}]+)\}", replace, value)


__all__ = ["Gateway", "QuotaExhausted", "ProviderRefused", "Result", "Block", "ProviderError"]
