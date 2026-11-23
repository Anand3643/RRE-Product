"""Schema management on startup.

* Fresh database            -> `alembic upgrade head`.
* Database created before Alembic was introduced (tables exist, no alembic_version) -> bring any missing columns
  up to date once (legacy), then stamp the baseline so future changes are normal migrations.
"""
import logging
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text

from .core import Base, engine

log = logging.getLogger("stockpilot.migrate")
BASELINE = "0001"


def _config() -> Config:
    root = Path(__file__).resolve().parent.parent
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    return cfg


def _legacy_add_missing_columns():
    insp = inspect(engine)
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name not in have:
                with engine.begin() as c:
                    c.execute(text(f'ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}'))


def run():
    insp = inspect(engine)
    cfg = _config()
    if not insp.has_table("alembic_version") and insp.has_table("users"):
        log.info("Legacy database detected: syncing columns and stamping baseline %s", BASELINE)
        _legacy_add_missing_columns()
        command.stamp(cfg, BASELINE)
    command.upgrade(cfg, "head")
