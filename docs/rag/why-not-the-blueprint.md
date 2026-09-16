# Why the evidence layer is ours and the models are NVIDIA's

## The short answer

NVIDIA's blueprint is a good search engine over documents. The operator of the
power system does not need a chat that answers questions about PDFs: they need
evidence they can take into an audit. We use NVIDIA's models to extract and to
draft. The layer that turns that into citable, dated, reproducible evidence is
ours, because it is the layer that decides whether the answer is fit to operate
on.

## The five differences that matter

### 1. Ours does not answer without a verifiable quote

A generic RAG returns text with the sources it used. Ours returns a structured
document in which **every claim carries a literal quote**, and that quote is only
accepted if it exists, character for character, in the piece of document that
was indexed. With it go the page or the table, the block's coordinates on the
page, the publication date and the sha256 of the original file.

If no claim passes that check, the system does not answer: it declares
"insufficient evidence" and says why. The behaviour in the worst case is the
point: a generic RAG fails by producing a plausible sentence, ours fails by
staying silent.

### 2. Ours respects the operation's clock

This is the difference an off-the-shelf RAG cannot have, because it is not
software, it is domain.

An ordinary search looks at the documents as they are today. The operation
needs the documents **as they were at the moment of the decision**: the D-1 run
at 09:00 may only see what had been published by that instant. Our retrieval
applies the same temporal cut the forecasting model already applies to the data
(`published_at` at or before the run's instant).

Without it you get the classic, invisible mistake: explaining yesterday's cut
with a report published a week later. The system would look excellent in the
backtest and fail on the real day. The blueprint accepts metadata and filters,
but building and proving that discipline is always the job of whoever knows the
domain.

### 3. In ours, the AI does not classify

In the blueprint, the language model answers the question. In WattSteer it
never decides the cause. The classification between external unavailability,
electrical reliability and energy reasons remains a rule plus SHAP. The RAG
enters as evidence, with a declared weight, and when the evidence contradicts
the rule we publish both and declare the disagreement.

This is not fastidiousness: it is what allows the system in front of an operator
working under the grid procedures, where the decision belongs to the person
operating and needs a traceable basis.

### 4. Ours reproduces the past

Same day, same input, same output hash. This is possible because the text of
the cited passage, the document's vintage, the search log (question, filters,
retrieved passages, scores, model and provider) and the alert all live **in the
same database and at the same point in time**.

If the evidence lived in a separate index, reproducing day D would mean
versioning that index as well. An auditor does not accept "the index has
changed since then".

### 5. Ours does not stop when the vendor changes

We found this out by testing, not by assuming. On 25/08/2026 NVIDIA ended the
life of three embedding models that were in our plan, among them `bge-m3`, and
the reranking endpoints went offline. A system with those models fixed in its
configuration simply stops.

Ours calls every model through its own gateway, which uses every team member's
key as one pool while counting each one's quota; switches key and then provider
while keeping the same request; declares "waiting for quota" instead of
breaking; and keeps the text of every indexed passage, so that changing the
embedding model is a scheduled job, not a disaster.

## Anticipating the judges' questions

**"Could you not deploy the blueprint and put your guarantees on top?"**
The guarantees are properties of the data model, not a wrapper. Temporal cut,
same transaction, same backup, same reproducible hash: those are decided by
where the data lives. And the two things the blueprint would save are already
with us: extraction is literally the NVIDIA model we call, and hybrid search is
a database query.

**"Isn't building from scratch in ten days risky?"**
We measured the other side of the risk. The blueprint comes up with
Elasticsearch, object storage and two more services, and the AWS environment is
only open for testing from 18 to 20 September. Debugging a third party's system
in that window costs more than writing our layer, which is one service and one
schema inside a Postgres the team already operates.

**"So you are not using NVIDIA?"**
We are, in the parts where it is best. `nemotron-parse` read a page of the ONS
daily operation bulletin, a PDF with no text layer, in 2.2 seconds, returning
the energy balance table with the correct values and the position of every block
on the page. The model that drafts the operator's text is Nemotron. What we do
not outsource is the criterion for what may become evidence.

NVIDIA supplies the models that read the document. The evidence the operator can
cite, with a literal quote, with a publication date before the decision and
reproducible the next day, is what WattSteer adds.

Numbers measured on 15 September 2026, with a real NVIDIA NIM key.
