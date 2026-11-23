import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text

from app import stock
from app.core import SessionLocal, engine
from app.main import app
from app.models import Organization, StockBalance, User
from app.recon import reconcile
from app.sequences import next_number

BACKEND = Path(__file__).resolve().parent.parent


def alembic(url, *args):
    env = {**os.environ, "DATABASE_URL": url}
    return subprocess.run([sys.executable, "-m", "alembic", *args], cwd=BACKEND, env=env, capture_output=True, text=True)


def test_migrations_build_the_same_schema_as_the_models():
    url = f"sqlite:///{tempfile.mkdtemp()}/m.db"
    up = alembic(url, "upgrade", "head")
    assert up.returncode == 0, up.stderr
    chk = alembic(url, "check")  # fails if models and migrations have drifted apart
    assert chk.returncode == 0, chk.stdout + chk.stderr


def test_legacy_database_is_adopted_and_upgraded():
    url = f"sqlite:///{tempfile.mkdtemp()}/legacy.db"
    assert alembic(url, "upgrade", "0001").returncode == 0
    from sqlalchemy import create_engine
    e = create_engine(url)
    with e.begin() as c:
        c.execute(text("DROP TABLE alembic_version"))  # what a pre-Alembic database looks like
    e.dispose()
    code = ("from app.migrate import run; run(); from sqlalchemy import inspect; from app.core import engine; "
            "t=inspect(engine).get_table_names(); assert 'number_sequences' in t and 'alembic_version' in t, t")
    r = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env={**os.environ, "DATABASE_URL": url}, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


def test_migrating_a_populated_database_keeps_rows_referenced_by_foreign_keys():
    """Regression: SQLite batch migrations rebuild tables; rows referenced by other tables must survive."""
    from sqlalchemy import create_engine
    url = f"sqlite:///{tempfile.mkdtemp()}/pop.db"
    assert alembic(url, "upgrade", "0002").returncode == 0
    e = create_engine(url)
    with e.begin() as c:
        c.execute(text("PRAGMA foreign_keys=ON"))
        c.execute(text("insert into organizations(id,name,currency,allow_negative_stock,created_at) values(1,'o','INR',0,'2026-01-01')"))
        c.execute(text("insert into warehouses(id,org_id,code,name,is_active) values(1,1,'W','W',1)"))
        c.execute(text("insert into products(id,org_id,name,sku,brand,unit,purchase_price,selling_price,tax_rate,avg_cost,reorder_point,safety_stock,track_batches,is_archived,created_at,updated_at) values(1,1,'a','A','Bosch','pcs',1,1,18,1,0,0,0,0,'2026-01-01','2026-01-01')"))
        c.execute(text("insert into stock_balances(org_id,product_id,warehouse_id,on_hand,reserved,damaged,version) values(1,1,1,5,0,0,0)"))
    e.dispose()
    up = alembic(url, "upgrade", "head")
    assert up.returncode == 0, up.stderr[-600:]
    e = create_engine(url)
    with e.connect() as c:
        assert c.execute(text("select count(*) from stock_balances")).scalar() == 5 // 5
        assert c.execute(text("select brand_id is not null and status = 'active' from products")).scalar() == 1
        assert c.execute(text("PRAGMA foreign_key_check")).fetchall() == []
    e.dispose()


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_document_numbers_are_unique_under_concurrency(client):
    r = client.post("/api/auth/signup", json={"org_name": "Seq Org", "name": "O", "email": "seq@x.com", "password": "password123"})
    assert r.status_code == 201
    with SessionLocal() as db:
        oid = db.scalars(select(User).where(User.email == "seq@x.com")).first().org_id
    got, errors = [], []

    def work():
        try:
            with SessionLocal() as db:
                n = next_number(db, oid, "SO")
                db.commit()
                got.append(n)
        except Exception as e:  # noqa: BLE001
            errors.append(repr(e))

    ts = [threading.Thread(target=work) for _ in range(20)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors, errors
    assert len(got) == 20 and len(set(got)) == 20
    assert sorted(got)[0] == "SO-00001" and sorted(got)[-1] == "SO-00020"
    with SessionLocal() as db:
        assert next_number(db, oid, "PO") == "PO-00001"  # independent counter per document type
        db.commit()


def test_reconcile_detects_drift_and_confirms_integrity(client):
    r = client.post("/api/auth/signup", json={"org_name": "Rec Org", "name": "O", "email": "rec@x.com", "password": "password123"})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    w = client.get("/api/warehouses", headers=h).json()[0]["id"]
    p = client.post("/api/products", headers=h, json={"name": "Widget", "sku": "RC-1"}).json()["id"]
    assert client.post("/api/inventory/receive", headers=h, json={"product_id": p, "warehouse_id": w, "mode": "increase", "quantity": 10, "reason": "seed"}).status_code == 201
    assert client.post("/api/inventory/adjust", headers=h, json={"product_id": p, "warehouse_id": w, "mode": "damage", "quantity": 2, "reason": "dropped"}).status_code == 201
    rep = client.get("/api/inventory/reconcile", headers=h).json()
    assert rep["ok"] and rep["checked"] == 1, rep
    with SessionLocal() as db:  # someone edits a balance behind the ledger's back
        b = db.scalars(select(StockBalance).where(StockBalance.product_id == p)).first()
        b.on_hand += 5
        db.commit()
    rep = client.get("/api/inventory/reconcile", headers=h).json()
    assert not rep["ok"] and rep["mismatches"][0]["balance"]["on_hand"] == 13 and rep["mismatches"][0]["ledger"]["on_hand"] == 8


def test_fulfilment_permissions(client):
    from app.core import can
    assert can("warehouse", "fulfilment", "w") and not can("sales", "fulfilment", "w") and can("sales", "fulfilment", "r")
    assert can("viewer", "fulfilment", "r") and not can("viewer", "fulfilment", "w")