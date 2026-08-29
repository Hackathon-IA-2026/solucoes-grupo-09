# 16 — How Python reads the canonical contract

**What to build:** nothing, until a decision is made. This ticket exists to hold
a contradiction that ticket 13 exposed rather than caused, and it needs a human
judgement before anything leans on it.

Ticket 13 said "compose the repositories, do not re-query". That is right — it is
what stops ONS's conventions being reimplemented on the Python side. But a
TypeScript module composing TypeScript functions is not something Python can
consume, so the contract was put behind HTTP at `/v1/canonical/*`.

That inverts the documented direction. `docs/specs/api-surface.md` has the
gateway calling the ML service, and has the ML service reading Postgres directly
on a read-only role; `docs/specs/feature-engineering.md` has it calling a SQL
feature function. Ticket 13's shape has the ML service calling the gateway
instead. All three cannot be true.

Nothing has committed to the answer yet: `apps/ml/src/wattsteer_ml/canonical.py`
carries the vocabulary and builds URLs but adds no HTTP dependency. That is why
this is cheap to settle now and expensive to settle later.

**The three candidates, as they stand:**

1. **ML calls the gateway over HTTP.** The contract is enforced in one place and
   in one language. Costs a hop on every training read, and a circular service
   dependency in Railway.
2. **ML reads Postgres directly on a read-only role**, as `api-surface.md` says.
   No hop — but the contract's renames and vintage rule then exist in Python too,
   which is the drift the contract was built to prevent, unless they are pushed
   into SQL views the database owns.
3. **The contract becomes SQL views**, and both languages read those. The
   vocabulary lives in the schema; `contract/reads.ts` becomes a thin caller.
   Most work, and the only option where "one definition" is structurally true
   rather than maintained.

**Blocked by:** 13 (merged). Blocked on a decision, not on code.

**Status:** needs-decision

- [ ] The transport is chosen and `api-surface.md` and `feature-engineering.md`
      are corrected so all three documents agree
- [ ] The chosen shape is implemented, and the parity fixtures still bind both sides
