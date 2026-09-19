"""A second reader for every claim the gates accepted.

The gates are mechanical: the quote exists, every number of the claim is in the
quote, no causal word. A claim can pass all of them and still say something the
quote does not, and the validation of 18/09/2026 found three shapes of it:

- A number from the wrong row: asked for LAPA's solar output, the answer quoted
  a span that held the SIN's 11,802 next to LAPA's name, and every number was
  "in the quote".
- A clause stretched past its item: Submódulo 4.5 item (a) quoted for what its
  item (c) says.
- An operating instruction with nothing to do with the record, quoted because a
  restriction with no document named in it matched it on vocabulary.

Each needs reading, not matching. A smaller model first answers the question
from the quoted spans alone, as if the claim did not exist, and only then
compares. Asked the plain yes-or-no ("does this passage state this claim?"),
both gpt-oss sizes said yes to LAPA's 11,802 on 18/09/2026; answering first,
they refused it, and scored 7 of 9 labelled cases. The two they still accept:
an hourly forecast read as the day's scheduled load, and a step's preamble
given for the value its table holds. The reader sees only the question, the
claim and the quoted spans with their document and section, so it cannot
borrow support from the other passages.

When the reader is not available no claim is published and the builder stops
generating: the failure mode of this service is silence (see `evidence.py`).
"""

from __future__ import annotations

from typing import Any

from .gateway.adapters import ProviderError
from .gateway.router import Gateway, ProviderRefused, QuotaExhausted

VERIFY_PROMPT = """You review evidence from the ONS, the Brazilian power system operator. All
texts are in Portuguese.

You get a question, the passages a claim quotes (with document and section),
and the claim. Work in this order:

1. Read only the quoted passages, and answer the question from them alone, as
   if the claim did not exist. Be literal about scope: a value of one hour is
   not the value of the day, a value of one row, agent or area is not a total,
   a forecast or scheduled figure is not a verified one, a figure accumulated
   over the month to date is not the figure of the day, and a table row whose
   label names something else is not about the thing asked. If the passages do
   not contain the answer, say so.
2. Compare your answer with the claim.

Answer only with JSON:
{"answer_from_passages": "<your answer, or null>",
 "supported": <true only if the passages answer the question and the claim says the same>,
 "reason": "<one short sentence in Portuguese>"}"""


def _passages(claim: dict) -> str:
    """Each quote under its document's title and section. The title is what
    tells a bulletin's day ("Rel Balanco Energetico Diario") from its month to
    date ("Balanco Energetico Acumulo Dia"), which the quoted row alone does not."""
    return "\n\n".join(
        f"[{' | '.join(part for part in _label(citation) if part)}]\n{citation['quote']}"
        for citation in claim["citations"]
    )


def _label(citation: dict) -> tuple[str, ...]:
    section = (citation.get("locator") or {}).get("section")
    return (citation.get("external_id") or "", citation.get("title") or "", str(section) if section else "")


class ReaderUnavailable(Exception):
    """No link of the `verify` task could answer: no key, no quota, a refusal.

    Not the same thing as a "no". A "no" refuses one claim and the drafter may
    try again; an absent reader would refuse every claim of every retry, so the
    caller stops generating instead of spending the generation quota on drafts
    nobody can read."""


async def review(gateway: Gateway, question: str, claim: dict) -> tuple[bool, str]:
    """(supported, reason); raises ReaderUnavailable when no reader answered."""
    asked = f"Question: {question}\n\nQuoted passages:\n{_passages(claim)}\n\nClaim: {claim['claim']}"
    messages = [{"role": "system", "content": VERIFY_PROMPT}, {"role": "user", "content": asked}]
    try:
        result = await gateway.run("verify", tokens=len(messages[1]["content"]) // 4, messages=messages)
    except (QuotaExhausted, ProviderRefused, ProviderError) as exc:
        raise ReaderUnavailable(type(exc).__name__) from exc
    return _verdict(result.value)


def _verdict(value: Any) -> tuple[bool, str]:
    """All three fields, or a "no": a bare {"supported": true} skipped the
    independent answer this reader exists to give."""
    if not isinstance(value, dict) or not isinstance(value.get("supported"), bool):
        return False, "reader answered out of shape"
    answer, reason = value.get("answer_from_passages", ...), value.get("reason")
    if not (answer is None or isinstance(answer, str)) or not isinstance(reason, str) or not reason.strip():
        return False, "reader answered without its own answer or reason"
    return value["supported"], reason[:200]
