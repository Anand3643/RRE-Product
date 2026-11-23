from alembic import context
from sqlalchemy import text

import app.models  # noqa: F401  (register all tables)
from app.core import DATABASE_URL, Base, engine

target_metadata = Base.metadata


def run_migrations_offline():
    context.configure(url=DATABASE_URL, target_metadata=target_metadata, literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online():
    with engine.connect() as conn:
        sqlite = conn.dialect.name == "sqlite"
        if sqlite:
            # SQLite "batch" migrations rebuild a table (copy -> DROP -> rename). With foreign keys enforced the DROP
            # fails whenever another table references it, so enforcement is paused for the migration and the
            # database is verified afterwards. (PostgreSQL alters in place and does not need this.)
            conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
            conn.commit()
        context.configure(connection=conn, target_metadata=target_metadata, render_as_batch=True, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()
        if sqlite:
            bad = conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            conn.commit()
            if bad:
                raise RuntimeError(f"Foreign key violations after migration: {bad[:5]}")


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
