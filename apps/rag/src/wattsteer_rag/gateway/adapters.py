"""One adapter per kind of provider. All of them speak the same three verbs.

`chat`, `embed` and `parse_page` are the only things the rest of the service is
allowed to ask for, which is what makes a provider swappable. Nothing here knows
about quotas: the router owns that.
"""

from __future__ import annotations

import base64
import json
import re
from dataclasses import dataclass
from typing import Any

import httpx


class ProviderError(Exception):
    """A call that failed in a way the router can react to."""

    def __init__(self, message: str, *, status: int | None = None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


@dataclass
class Block:
    """A piece of a page as the parser saw it."""

    type: str
    text: str
    bbox: dict[str, float] | None = None


# A reasoning block that opens the answer, and only that one: the tag closing it
# is the first match of its own name, so a claim quoting "</think>" is untouched.
REASONING_BLOCK = re.compile(r"\A\s*<(thought|think)>.*?</\1>", re.S)
REASONING_OPENS = re.compile(r"\A\s*<(?:thought|think)>")


def _json_from_text(text: str) -> Any:
    """Pull the last JSON value out of a model's answer.

    Reasoning models narrate before they answer, and a refusal to parse that
    would be a refusal to use half the open models.
    """
    # Gemma 4 on Google opens its answer with "<thought>...</thought>" and
    # cannot be told not to; the reasoning quotes the JSON it is about to write,
    # braces and all, so only what follows the block is the answer. A block that
    # never closes ran out of tokens while drafting: the JSON inside it is a
    # draft, not an answer.
    stripped = REASONING_BLOCK.sub("", text, count=1)
    if stripped == text and REASONING_OPENS.match(text):
        raise ProviderError("model ran out of tokens while reasoning")
    text = stripped.strip()
    fenced = re.findall(r"```(?:json)?\s*(.+?)```", text, re.S)
    for candidate in reversed(fenced):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = text.find(opener), text.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ProviderError("model did not return JSON")


def _blocks_from_message(message: dict) -> list[Block]:
    """nemotron-parse answers with a `markdown_bbox` tool call, but a provider
    that returns the page as plain text is still usable."""
    calls = message.get("tool_calls") or []
    if calls:
        return _blocks_from_tool_call(calls[0])
    content = (message.get("content") or "").strip()
    return [Block(type="Text", text=content)] if content else []


def _blocks_from_tool_call(call: dict) -> list[Block]:
    raw = json.loads(call["function"]["arguments"])
    if raw and isinstance(raw[0], list):  # the payload arrives wrapped once
        raw = raw[0]
    return [
        Block(type=item.get("type") or "Text", text=item.get("text") or "", bbox=item.get("bbox"))
        for item in raw
        if item.get("text")
    ]


class OpenAICompatibleAdapter:
    """Anything that speaks /v1/chat/completions and /v1/embeddings."""

    def __init__(
        self,
        name: str,
        base_url: str,
        timeout_s: float = 60.0,
        user_agent: str = "wattsteer-rag",
        thinking_toggle: bool = False,
    ):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.user_agent = user_agent
        # Nemotron reasons out loud unless told not to, and the knob to tell it is
        # NVIDIA's own. Groq answers 400 to a body it does not recognise, so a
        # parameter that helps one provider must never be sent to another.
        self.thinking_toggle = thinking_toggle

    async def _post(self, client: httpx.AsyncClient, path: str, secret: str, body: dict) -> dict:
        try:
            response = await client.post(
                f"{self.base_url}{path}",
                json=body,
                headers={
                    "Authorization": f"Bearer {secret}",
                    "content-type": "application/json",
                    "accept": "application/json",
                    "user-agent": self.user_agent,
                },
                timeout=self.timeout_s,
            )
        except httpx.RequestError as exc:  # timeouts, DNS, connection resets
            raise ProviderError(f"{self.name}: {type(exc).__name__}") from exc
        if response.status_code >= 400:
            retry_after = response.headers.get("retry-after")
            # The body can carry the provider's own key material in an echo; never keep it.
            raise ProviderError(
                f"{self.name}: HTTP {response.status_code}",
                status=response.status_code,
                retry_after=float(retry_after) if retry_after and retry_after.isdigit() else None,
            )
        return response.json()

    async def chat(
        self,
        client: httpx.AsyncClient,
        secret: str,
        *,
        model: str,
        messages: list[dict],
        max_tokens: int,
        temperature: float,
        want_json: bool,
    ) -> tuple[Any, dict]:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if want_json and self.thinking_toggle:
            body["chat_template_kwargs"] = {"thinking": False}
        data = await self._post(client, "/chat/completions", secret, body)
        choice = (data.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or ""
        usage = data.get("usage") or {}
        return (_json_from_text(content) if want_json else content), usage

    async def embed(
        self,
        client: httpx.AsyncClient,
        secret: str,
        *,
        model: str,
        texts: list[str],
        input_type: str,
    ) -> tuple[list[list[float]], dict]:
        data = await self._post(
            client,
            "/embeddings",
            secret,
            {
                "model": model,
                "input": texts,
                "input_type": input_type,
                "encoding_format": "float",
                "truncate": "END",
            },
        )
        rows = sorted(data.get("data") or [], key=lambda row: row.get("index", 0))
        return [row["embedding"] for row in rows], (data.get("usage") or {})

    async def parse_page(
        self, client: httpx.AsyncClient, secret: str, *, model: str, image: bytes
    ) -> tuple[list[Block], dict]:
        """Nemotron Parse answers with a tool call, not with prose."""
        encoded = base64.b64encode(image).decode()
        data = await self._post(
            client,
            "/chat/completions",
            secret,
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{encoded}"},
                            }
                        ],
                    }
                ],
                "max_tokens": 4000,
            },
        )
        message = (data.get("choices") or [{}])[0].get("message") or {}
        blocks = _blocks_from_message(message)
        if not blocks:
            raise ProviderError(f"{self.name}: parse returned no blocks")
        return blocks, (data.get("usage") or {})
