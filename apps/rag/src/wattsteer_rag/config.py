"""Runtime configuration.

Every knob is an environment variable so the service can be deployed without a
file, and every secret is read by name so it never reaches a log line.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WATTSTEER_RAG_", extra="ignore")

    # The corpus, the chunks and the evidence live here. Own database, own schema:
    # the gateway's Postgres has no pgvector and apps/api owns every table in `public`.
    database_url: str = "postgres://wattsteer:wattsteer@localhost:5439/wattsteer_rag"
    redis_url: str | None = None

    # Where raw documents are kept after download, addressed by sha256.
    store_dir: Path = REPO_ROOT / ".rag-store"

    gateway_config: Path = REPO_ROOT / "docs" / "rag" / "gateway.yaml"

    port: int = 8082
    host: str = "0.0.0.0"

    # Retrieval shape. Kept here because the evaluation harness sweeps them.
    hybrid_vector_k: int = 40
    hybrid_text_k: int = 40
    rerank_top_n: int = 8
    embedding_dimensions: int = 1024

    user_agent: str = "WattSteer-RAG/0.1 (+https://www.wattsteer.com)"
    fetch_interval_s: float = 1.0

    @property
    def dsn(self) -> str:
        """asyncpg wants postgresql://, the ecosystem writes postgres://."""
        return self.database_url.replace("postgres://", "postgresql://", 1)


@lru_cache
def settings() -> Settings:
    return Settings()
