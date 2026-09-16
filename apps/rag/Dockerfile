# Poppler is not an optional dependency here: the parser rasterises pages for the
# vision model and falls back to the text layer, and both are poppler.
FROM python:3.12-slim

LABEL org.opencontainers.image.title="wattsteer-rag" \
      org.opencontainers.image.description="Evidence retrieval over the ONS public record." \
      org.opencontainers.image.source="https://github.com/vtorres/WattSteer" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/rag/pyproject.toml apps/rag/README.md ./
COPY apps/rag/src ./src
RUN pip install --no-cache-dir . && useradd --create-home --uid 10001 wattsteer

# The store holds the raw documents, addressed by hash. A volume keeps them
# across deploys so a re-ingest does not re-download the corpus.
ENV WATTSTEER_RAG_STORE_DIR=/data/rag-store \
    WATTSTEER_RAG_GATEWAY_CONFIG=/app/gateway.yaml \
    WATTSTEER_RAG_PORT=8082
COPY docs/rag/gateway.yaml /app/gateway.yaml

COPY apps/rag/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8082/health', timeout=3).status==200 else 1)"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "wattsteer_rag.app"]
