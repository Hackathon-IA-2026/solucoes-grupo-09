# Poppler is not an optional dependency here: the parser rasterises pages for the
# vision model and falls back to the text layer, and both are poppler.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/rag/pyproject.toml apps/rag/README.md ./
COPY apps/rag/src ./src

# Torch from the CPU index **before** the package, so `sentence-transformers`
# finds it already satisfied. The default index serves the CUDA build, which is
# some two gigabytes of driver nobody here can use: this service ranks a few
# dozen passages per question on a CPU.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch \
 && pip install --no-cache-dir ".[rerank]" \
 && useradd --create-home --uid 10001 wattsteer

# The cross-encoder, baked in rather than fetched on first use.
#
# `rerank.py` loads it lazily and falls back to the RRF order if it cannot, so a
# missing model is a quiet loss of quality rather than an error — which is
# exactly the failure that would go unnoticed. Downloading at build time also
# keeps the first question after a deploy from paying for it, and keeps the
# container from needing egress to huggingface.co at run time.
#
# `HF_HOME` is under /app so the unprivileged user can read the cache it did not
# create.
ENV HF_HOME=/app/.hf
RUN python -c "from sentence_transformers import CrossEncoder; \
    CrossEncoder('cross-encoder/mmarco-mMiniLMv2-L12-H384-v1')" \
 && chmod -R a+rX /app/.hf

# The evaluation set travels with the image. It is the list of real curtailment
# records the console offers, so leaving it out is what makes a perfectly healthy
# deployment tell every visitor there is no evaluation set to choose from. It is
# also what `eval/run_eval.py` measures against, so the image can be scored
# without a checkout.
COPY apps/rag/eval ./eval

# The store holds the raw documents, addressed by hash. A volume keeps them
# across deploys so a re-ingest does not re-download the corpus.
# The reranker is named here rather than left to the config's empty default,
# because this image is the one that has it: `config.py` stays empty so a
# checkout without the extra runs the retrieval it can, and the image that
# carries the model uses it. Measured before being turned on, as
# `docs/rag/decisions.md` asks — 52 of 67 goldset questions put the answering
# passage in front of the drafter under RRF, 59 under this model, none lost.
ENV WATTSTEER_RAG_STORE_DIR=/data/rag-store \
    WATTSTEER_RAG_GATEWAY_CONFIG=/app/gateway.yaml \
    WATTSTEER_RAG_RERANK_MODEL=cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 \
    WATTSTEER_RAG_PORT=8082
COPY docs/rag/gateway.yaml /app/gateway.yaml

COPY apps/rag/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8082/health', timeout=3).status==200 else 1)"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "wattsteer_rag.app"]

# Who built this, from what, and under which licence — read by registries, by
# `docker scout`, and by ECR's image scanning. An image with no provenance is one
# nobody can trace back to a commit when it misbehaves at 3am.
#
# Last in the file on purpose: these args change every commit, and a LABEL high
# up would invalidate every layer beneath it — a full dependency install to write
# eight strings. Every field naming a project is set rather than inherited, or
# the base image's `revision` sends that 3am search to oven-sh/bun's history.
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="wattsteer-rag" \
      org.opencontainers.image.description="Evidence retrieval over the ONS public record." \
      org.opencontainers.image.source="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.url="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${GIT_SHA}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
