"""WattSteer's Python service.

Owns feature engineering, training, inference, SHAP, backtesting and the
OR-Tools flex optimizer. It reads Postgres directly and never writes to it; the
Elysia gateway in `apps/api` owns ingestion, the schema and every migration, and
is the only thing the Expo app talks to.
"""

__version__ = "0.1.0"
