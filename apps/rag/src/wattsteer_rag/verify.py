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

Each needs reading, not matching, so a smaller model is asked the one question
a reviewer would ask: does this passage, on its own, state this claim about
this thing? It sees only the question, the claim and the quoted spans with
their document and section, not the other passages, so it cannot borrow
support from them.

When the reader is not available the claim is refused, not waved through: the
failure mode of this service is silence (see `evidence.py`).
"""

from __future__ import annotations

from typing import Any

from .gateway.adapters import ProviderError
from .gateway.router import Gateway, ProviderRefused, QuotaExhausted

VERIFY_PROMPT = """You review evidence from the ONS, the Brazilian power system operator.
You get a question, a claim written to answer it, and the passages the claim
quotes, with the document and section each came from. All in Portuguese.

Decide whether the quoted passages, read on their own, state what the claim
says, about the same thing the question asks: the same plant, line, substation,
subsystem, date, item and column. A value from another row, another subsystem,
another column (scheduled instead of verified), another item of the same
document, or another piece of equipment is not support. A document about a
different area of the grid than the question is not support. A claim that adds
anything the passages do not say is not supported.

Answer only with JSON: {"supported": true or false, "reason": "one short sentence in Portuguese"}"""


def _passages(claim: dict) -> str:
    return "\n\n".join(
        f"[{citation.get('external_id') or citation.get('title')}"
        f"{', ' + str(citation['locator'].get('section')) if citation['locator'].get('section') else ''}]\n"
        f"{citation['quote']}"
        for citation in claim["citations"]
    )


async def review(gateway: Gateway, question: str, claim: dict) -> tuple[bool, str]:
    """(supported, reason). Unavailable counts as not supported, with that reason."""
    asked = f"Question: {question}\n\nClaim: {claim['claim']}\n\nQuoted passages:\n{_passages(claim)}"
    messages = [{"role": "system", "content": VERIFY_PROMPT}, {"role": "user", "content": asked}]
    try:
        result = await gateway.run("verify", tokens=len(messages[1]["content"]) // 4, messages=messages)
    except (QuotaExhausted, ProviderRefused, ProviderError) as exc:
        return False, f"reviewer unavailable: {type(exc).__name__}"
    return _verdict(result.value)


def _verdict(value: Any) -> tuple[bool, str]:
    if not isinstance(value, dict) or not isinstance(value.get("supported"), bool):
        return False, "reviewer answered out of shape"
    return value["supported"], str(value.get("reason") or "")[:200]
