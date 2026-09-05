# 11 — The renderer renders, and it never decides

**What to build:** the generated paragraph. A user reading the Explain screen in
Portuguese gets a paragraph written *in* Portuguese — generated in the locale,
never translated into it — that states only what the payload already says.

**No tools, no retrieval, no database access, no web access, no arithmetic, no
conversation history.** Its whole world is the closed JSON document from ticket
08. That is a property of the call, not of the prompt, and the tests assert the
call.

| | |
|---|---|
| Model | `claude-opus-5` |
| Effort | `output_config: { effort: "low" }` — the task is restatement under constraint, not reasoning |
| Thinking | left at the model's default (adaptive). **Not disabled** — disabling it on this model risks leaked reasoning tags and tool-call text in the visible response, and low effort already buys the cost back |
| `max_tokens` | `700`, non-streaming |
| Output shape | structured outputs, a one-field schema `{ narration: string }`, so no preamble can appear |
| Caching | `cache_control: { type: "ephemeral" }` on the system block, which is byte-identical across every request; the volatile payload goes last |
| Tools | none, declared as none |

Volume is four subsystems × two locales × two gate profiles — roughly sixteen
calls a day, at cents. There is no cost argument for a weaker model, and a weaker
model fails in the one direction that matters here: it invents a number.

**The system prompt's load-bearing constraints:** one paragraph, 45–90 words, in
the requested locale; state only facts present in the input, and introduce no
number, name, place, date or quantity absent from it; say that the **model**
raised or lowered its forecast, never that a condition caused, drove or explains
the curtailment; state every rule flag; if any displayed group's hour
disagreement is at or above the flag threshold, say the driver acted in both
directions during the day; never give advice, never mention batteries, dispatch
or the optimizer, never speculate beyond the target date, never characterise the
band's meaning; round nothing.

**Blocked by:** 09, 10.

**Status:** done

- [ ] The Explain narration is generated in the requested locale, with no translation layer and no round trip
- [ ] The assembled request carries no tools, declared as none
- [ ] The system block is byte-identical across two different payloads, so caching can work, and the payload block is last
- [ ] The model identity, the effort setting and the output schema match the table above, asserted without calling the model
- [ ] The locale in the prompt matches the locale in the request
- [ ] Every generated narration passes the three gates before it is returned
- [ ] The response states that the narration came from the model
- [ ] One live scheduled call per locale per deployment asserts only that the real model's response passes all three gates — the only test here that spends money
- [ ] The default test run needs no network, no database and no artifact
