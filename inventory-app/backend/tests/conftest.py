"""Test bootstrap: one database for the whole session.

TEST_DATABASE_URL=postgresql+psycopg://...  runs the suite on PostgreSQL (schema is dropped and recreated);
otherwise a throw-away SQLite file is used.
"""
import os
import tempfile

os.environ["SP_SKIP_MIGRATE"] = "1"
os.environ["ALLOW_SIGNUP"] = "1"
os.environ["ALLOW_ORG_SIGNUP"] = "1"   # legacy one-organisation-per-signup, tests only
os.environ["DATABASE_URL"] = os.getenv("TEST_DATABASE_URL") or f"sqlite:///{os.path.join(tempfile.mkdtemp(), 'test.db')}"

import app.models  # noqa: E402,F401  (register every table on the metadata)
from app.core import Base, engine  # noqa: E402

Base.metadata.drop_all(engine)
Base.metadata.create_all(engine)
