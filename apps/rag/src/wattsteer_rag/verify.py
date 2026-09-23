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
they refused it, and scored 7 of 9 labelled cases.

## The two it still accepted, and why more prose was not the fix

The two remaining shapes were **an hourly figure read as the day's**, and **a
scheduled figure given for a verified one**. Both were already forbidden in
this prompt, in as many words: step 1 has said "a value of one hour is not the
value of the day" and "a forecast or scheduled figure is not a verified one"
since the reader was written. The model read the instruction and answered
`supported: true` anyway, so a third sentence saying it more firmly is hoping
harder, and a third *reader* would only move the problem.

What was missing is that nothing could check the reading. `supported` is one
bit and it arrives with no account of what was read, so a model that believed
the programmed column answered a question about the verified one produced a
`true` indistinguishable from a correct one.

So the reader now **names the grain and the regime it read**, and
{@link _mismatch} refuses the disagreement in code. The model may still be
wrong about the passage; it can no longer be wrong *and* unexaminable. This is
the same move the drafting side already made — the gates do not ask the model
whether its quote is in the chunk, they look.

Two deliberate asymmetries:

- **The grain check runs in one direction only**: a question about a day,
  answered from an hour. The opposite is a legitimate reading — the day's table
  often states the hour of the peak — and "A que horas o ONS autorizou…" asks
  for a time of day rather than an hourly quantity, so a symmetric rule would
  refuse a correct answer.
- **`reading` is checked when present and not required.** The fields above it
  are load-bearing for the answer-first design and a claim without them is
  refused; this one can only take claims away. A model too old or too small to
  report it leaves the reader exactly as strict as it was, which is the
  property that lets this ship without a measured run behind it.

When the reader is not available no claim is published and the builder stops
generating: the failure mode of this service is silence (see `evidence.py`).
"""

from __future__ import annotations

import re
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
2. Say what you read, in `reading`: the grain of the figure you took
   ("hour" for one hour, "day" for a whole day, "month" for a month-to-date or
   monthly figure, "period" for anything else such as one event, "none" if you
   took no figure), and its regime ("verified" for a settled or verified value,
   "scheduled" for a programmed or scheduled one, "forecast" for a predicted
   one, "none" if it carries no such label). Report what the passage says, not
   what the question asked for.
3. Compare your answer with the claim. A question may ask for several things
   (a figure and when it happened, a normal range and an emergency one); a
   claim may answer one of them. Judge it on the part it answers: it is
   supported when the passages state what the claim says about that part, even
   if they say nothing about the others. A claim that answers no part of the
   question (a figure of something else, however well quoted) is not supported.

Answer only with JSON:
{"answer_from_passages": "<your answer, or null>",
 "reading": {"grain": "hour|day|month|period|none", "regime": "verified|scheduled|forecast|none"},
 "supported": <true only if the passages answer the part the claim addresses, as the claim says>,
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


# What a question asks for. Portuguese, because the corpus and the questions
# are: these are the words the ONS's own records and an operator's question use.
ASKS_HOUR = re.compile(
    r"\b(?:hor[áa]ri[ao]|a que horas|em que hora|por hora|hora a hora)\b|\b\d{1,2}\s*h\b", re.I
)
ASKS_DATE = re.compile(
    r"\b\d{1,2}/\d{1,2}/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\bno dia\b|\bdo dia\b|\bdi[áa]ri[ao]\b", re.I
)
ASKS_VERIFIED = re.compile(
    r"\bverificad[ao]s?\b|\brealizad[ao]s?\b|\bapurad[ao]s?\b|\bliquidad[ao]s?\b", re.I
)
ASKS_SCHEDULED = re.compile(r"\bprogramad[ao]s?\b|\bprevist[ao]s?\b|\bprevis[ãa]o\b|\bplanejad[ao]s?\b", re.I)

# A question that compares the two regimes: it names one side and asks for both.
ASKS_COMPARISON = re.compile(
    r"\b(?:abaixo|acima|desvio|diferen[çc]a|comparad[ao]|em rela[çc][ãa]o|frente a[os]?"
    r"|entreg\w*|cumpri\w*|superou)\b",
    re.I,
)

#: The regimes that are not a verified figure, as the reader may name them.
_UNSETTLED = frozenset({"scheduled", "forecast"})


def asked_reading(question: str) -> tuple[str | None, str | None]:
    """(grain, regime) the question asks for, or `None` where it does not say.

    Only what is stated. A question that names no regime is not asking for a
    verified figure by default — plenty of the corpus is about what was
    programmed — so an unstated axis disables its half of the check rather than
    guessing a side.

    The day grain is "names a date and asks for no hour", which is how these
    questions are written: "Segundo o IPDO de 12/09/2023, qual foi a geração
    eólica verificada no Nordeste?" is about that whole day. "A que horas o ONS
    autorizou o restabelecimento" names a date too and is not, which is why the
    hour cue is tested first.
    """
    grain = None if ASKS_HOUR.search(question) else ("day" if ASKS_DATE.search(question) else None)
    if ASKS_COMPARISON.search(question):
        # "Entregou o que estava programado?", "ficou quanto abaixo da
        # previsão?": naming one side, asking for both. Measured on 23/09/2026 in
        # a set written blind to this code: four answers giving the verified and
        # the scheduled figure and the deviation, each the expected answer, were
        # refused as "the question asks for the scheduled value".
        regime = None
    elif ASKS_VERIFIED.search(question):
        regime = "verified"
    elif ASKS_SCHEDULED.search(question):
        regime = "scheduled"
    else:
        regime = None
    return grain, regime


def _mismatch(question: str, reading: Any) -> str | None:
    """Why the reader's own account of what it read does not answer the question.

    Returns the refusal in Portuguese, as the reason a reader would have given,
    or `None` when there is nothing to object to — including when the reader
    said nothing about its reading, which is the case this is allowed to be
    silent on (see the module header).
    """
    if not isinstance(reading, dict):
        return None
    asked_grain, asked_regime = asked_reading(question)
    grain, regime = reading.get("grain"), reading.get("regime")
    if asked_grain == "day" and grain == "hour":
        # The named failure, in one direction. A day's table stating the hour of
        # its peak is the legitimate opposite and is left alone.
        return "a pergunta é sobre o dia e o valor lido é de uma hora"
    if asked_regime == "verified" and regime in _UNSETTLED:
        return "a pergunta pede o valor verificado e o valor lido é programado ou previsto"
    if asked_regime == "scheduled" and regime == "verified":
        return "a pergunta pede o valor programado e o valor lido é verificado"
    return None


async def review(gateway: Gateway, question: str, claim: dict) -> tuple[bool, str]:
    """(supported, reason); raises ReaderUnavailable when no reader answered."""
    asked = f"Question: {question}\n\nQuoted passages:\n{_passages(claim)}\n\nClaim: {claim['claim']}"
    messages = [{"role": "system", "content": VERIFY_PROMPT}, {"role": "user", "content": asked}]
    try:
        result = await gateway.run("verify", tokens=len(messages[1]["content"]) // 4, messages=messages)
    except (QuotaExhausted, ProviderRefused, ProviderError) as exc:
        raise ReaderUnavailable(type(exc).__name__) from exc
    return _verdict(result.value, question)


def _verdict(value: Any, question: str = "") -> tuple[bool, str]:
    """All three fields, or a "no": a bare {"supported": true} skipped the
    independent answer this reader exists to give.

    The reading is checked last and only against a `true`: a claim the reader
    already refused needs no second reason, and the reason it gave is the more
    useful one to hand the retry.
    """
    if not isinstance(value, dict) or not isinstance(value.get("supported"), bool):
        return False, "reader answered out of shape"
    answer, reason = value.get("answer_from_passages", ...), value.get("reason")
    if not (answer is None or isinstance(answer, str)) or not isinstance(reason, str) or not reason.strip():
        return False, "reader answered without its own answer or reason"
    if value["supported"] and (wrong := _mismatch(question, value.get("reading"))):
        return False, wrong
    return value["supported"], reason[:200]
