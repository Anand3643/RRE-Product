"""Customers and vendors: one router factory so both masters share validation, numbering, audit and export."""
import csv
import io
import re
from decimal import Decimal
from typing import Callable, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .api import audit, require
from .core import can, get_db
from .models import AuditLog, Customer, Product, PurchaseOrder, SalesOrder, User, Vendor
from .sequences import next_number

router = APIRouter(prefix="/api")
D = Decimal
GSTIN = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$")
IFSC = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")


class PartyBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    company_name: Optional[str] = Field(default=None, max_length=200)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, pattern=r"^[0-9+()\-\s]{6,30}$")
    gstin: Optional[str] = None
    bill_address: Optional[str] = Field(default=None, max_length=300)
    bill_city: Optional[str] = Field(default=None, max_length=100)
    bill_state: Optional[str] = Field(default=None, max_length=100)
    bill_pincode: Optional[str] = Field(default=None, max_length=10)
    payment_terms: int = Field(default=30, ge=0, le=180)
    status: Literal["active", "inactive"] = "active"
    notes: Optional[str] = Field(default=None, max_length=500)

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v in (None, ""):
            return None
        v = v.strip().upper()
        if not GSTIN.match(v):
            raise ValueError("GSTIN must be 15 characters, e.g. 27ABCDE1234F1Z5")
        return v

    @field_validator("name", "company_name", "bill_address", "bill_city", "bill_state", "notes", mode="before")
    @classmethod
    def _strip(cls, v):
        return v.strip() if isinstance(v, str) else v


class CustomerIn(PartyBase):
    customer_type: Literal["business", "individual"] = "business"
    ship_address: Optional[str] = Field(default=None, max_length=300)
    ship_city: Optional[str] = Field(default=None, max_length=100)
    ship_state: Optional[str] = Field(default=None, max_length=100)
    ship_pincode: Optional[str] = Field(default=None, max_length=10)
    credit_limit: Decimal = Field(default=D(0), ge=0, le=D("999999999"))


class VendorIn(PartyBase):
    contact_person: Optional[str] = Field(default=None, max_length=120)
    bank_name: Optional[str] = Field(default=None, max_length=120)
    bank_account: Optional[str] = Field(default=None, pattern=r"^\d{6,18}$")
    bank_ifsc: Optional[str] = None

    @field_validator("bank_ifsc")
    @classmethod
    def _ifsc(cls, v):
        if v in (None, ""):
            return None
        v = v.strip().upper()
        if not IFSC.match(v):
            raise ValueError("IFSC must look like HDFC0001234")
        return v


def _mask(v: Optional[str], keep: int = 4):
    return None if not v else "X" * max(0, len(v) - keep) + v[-keep:]


def customer_out(c: Customer, user: User, db: Session):
    return {**{k: getattr(c, k) for k in ("id", "code", "name", "company_name", "email", "phone", "gstin", "bill_address",
                                          "bill_city", "bill_state", "bill_pincode", "payment_terms", "status", "notes",
                                          "customer_type", "ship_address", "ship_city", "ship_state", "ship_pincode",
                                          "created_at")}, "credit_limit": float(c.credit_limit)}


def vendor_out(v: Vendor, user: User, db: Session):
    out = {k: getattr(v, k) for k in ("id", "code", "name", "company_name", "email", "phone", "gstin", "bill_address",
                                      "bill_city", "bill_state", "bill_pincode", "payment_terms", "status", "notes",
                                      "contact_person", "bank_name", "created_at")}
    if can(user, "purchases", "w"):
        out.update(bank_account=v.bank_account, bank_ifsc=v.bank_ifsc, bank_masked=False)
    else:  # sensitive bank details are only shown to roles that manage purchasing
        out.update(bank_account=_mask(v.bank_account), bank_ifsc=_mask(v.bank_ifsc, 3), bank_masked=True)
    out["items_supplied"] = db.scalar(select(func.count(Product.id)).where(Product.preferred_vendor_id == v.id))
    return out


def _vendor_in_use(db, v: Vendor):
    pos = db.scalar(select(func.count(PurchaseOrder.id)).where(PurchaseOrder.vendor_id == v.id))
    if pos:
        return f"It has {pos} purchase order(s). Mark it inactive instead."
    n = db.scalar(select(func.count(Product.id)).where(Product.preferred_vendor_id == v.id))
    return f"It is the preferred vendor of {n} item(s). Mark it inactive instead." if n else None


def party_routes(kind: str, Model, InModel, module: str, doc: str, out_fn: Callable, in_use: Callable, label: str,
                 extra_cols: list[str]):
    base = f"/{kind}s"
    tags = [f"{kind}s"]

    def _own(db, user, pid):
        o = db.get(Model, pid)
        if not o or o.org_id != user.org_id:
            raise HTTPException(404, f"{label} not found")
        return o

    def _check_gstin(db, user, gstin, exclude_id=None):
        if gstin:
            q = select(Model.id).where(Model.org_id == user.org_id, Model.gstin == gstin)
            if exclude_id:
                q = q.where(Model.id != exclude_id)
            if db.scalars(q).first():
                raise HTTPException(409, f"Another {label.lower()} already uses GSTIN {gstin}")

    @router.get(base, tags=tags, name=f"list_{kind}s")
    def list_(q: Optional[str] = None, status: str = "all", type: Optional[str] = None, sort: str = "name",
              desc: bool = False, page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200),
              user: User = Depends(require(module)), db: Session = Depends(get_db)):
        stmt = select(Model).where(Model.org_id == user.org_id)
        if status in ("active", "inactive"):
            stmt = stmt.where(Model.status == status)
        if type and hasattr(Model, "customer_type"):
            stmt = stmt.where(Model.customer_type == type)
        if q:
            like = f"%{q.strip()}%"
            stmt = stmt.where(or_(Model.name.ilike(like), Model.code.ilike(like), Model.company_name.ilike(like),
                                  Model.email.ilike(like), Model.phone.ilike(like), Model.gstin.ilike(like)))
        col = getattr(Model, sort if sort in ("name", "code", "company_name", "email", "status", "payment_terms",
                                              "created_at", "bill_city") else "name")
        total = db.scalar(select(func.count()).select_from(stmt.subquery()))
        rows = db.scalars(stmt.order_by(col.desc() if desc else col.asc(), Model.id)
                          .offset((page - 1) * page_size).limit(page_size)).all()
        return {"total": total, "page": page, "page_size": page_size, "items": [out_fn(o, user, db) for o in rows]}

    @router.post(base, tags=tags, status_code=201, name=f"create_{kind}")
    def create(body: InModel, user: User = Depends(require(module, "w")), db: Session = Depends(get_db)):  # type: ignore[valid-type]
        _check_gstin(db, user, body.gstin)
        o = Model(org_id=user.org_id, code=next_number(db, user.org_id, doc), **body.model_dump())
        db.add(o)
        db.flush()
        audit(db, user, "create", kind, o.id, {"code": o.code, "name": o.name})
        db.commit()
        return out_fn(o, user, db)

    @router.get(f"{base}/{{pid}}", tags=tags, name=f"get_{kind}")
    def get(pid: int, user: User = Depends(require(module)), db: Session = Depends(get_db)):
        return out_fn(_own(db, user, pid), user, db)

    @router.patch(f"{base}/{{pid}}", tags=tags, name=f"update_{kind}")
    def patch(pid: int, body: dict, user: User = Depends(require(module, "w")), db: Session = Depends(get_db)):
        o = _own(db, user, pid)
        fields = list(InModel.model_fields)
        unknown = set(body) - set(fields)
        if unknown:
            raise HTTPException(422, f"Unknown field(s): {', '.join(sorted(unknown))}")
        merged = {f: getattr(o, f) for f in fields}
        merged.update(body)
        try:  # re-validate the complete record so partial updates obey exactly the same rules as creation
            valid = InModel(**merged)
        except Exception as e:
            errs = getattr(e, "errors", None)
            raise HTTPException(422, "; ".join(f"{'.'.join(map(str, x['loc']))}: {x['msg']}" for x in errs()) if errs else str(e))
        _check_gstin(db, user, valid.gstin, pid)
        changed = [f for f in body if getattr(valid, f) != getattr(o, f)]
        for f in changed:
            setattr(o, f, getattr(valid, f))
        audit(db, user, "update", kind, pid, {"fields": changed})  # field names only: never log bank details
        db.commit()
        return out_fn(o, user, db)

    @router.delete(f"{base}/{{pid}}", tags=tags, status_code=204, name=f"delete_{kind}")
    def delete(pid: int, user: User = Depends(require(module, "w")), db: Session = Depends(get_db)):
        o = _own(db, user, pid)
        why = in_use(db, o)
        if why:
            raise HTTPException(409, f"{label} can't be deleted. {why}")
        audit(db, user, "delete", kind, pid, {"code": o.code, "name": o.name})
        db.delete(o)
        db.commit()

    @router.get(f"{base}-export.csv", tags=tags, name=f"export_{kind}s")
    def export(user: User = Depends(require(module)), db: Session = Depends(get_db)):
        cols = ["code", "name", "company_name", "email", "phone", "gstin", "bill_address", "bill_city", "bill_state",
                "bill_pincode", "payment_terms", "status"] + extra_cols
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        for o in db.scalars(select(Model).where(Model.org_id == user.org_id).order_by(Model.code)):
            row = out_fn(o, user, db)
            w.writerow([row.get(c, "") if row.get(c) is not None else "" for c in cols])
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f"attachment; filename={kind}s.csv"})

    @router.get(f"{base}/{{pid}}/activity", tags=tags, name=f"activity_{kind}")
    def activity(pid: int, user: User = Depends(require(module)), db: Session = Depends(get_db)):
        """Timeline: creation plus every audited change, newest first."""
        o = _own(db, user, pid)
        users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
        logs = db.scalars(select(AuditLog).where(AuditLog.org_id == user.org_id, AuditLog.entity == kind,
                                                 AuditLog.entity_id == str(pid)).order_by(AuditLog.id.desc())).all()
        return [{"when": a.created_at, "user": users.get(a.user_id), "action": a.action, "detail": a.detail} for a in logs] or \
               [{"when": o.created_at, "user": None, "action": "create", "detail": None}]


def _customer_in_use(db, c: Customer):
    n = db.scalar(select(func.count(SalesOrder.id)).where(SalesOrder.customer_id == c.id))
    return f"It has {n} sales order(s). Mark it inactive instead." if n else None


party_routes("customer", Customer, CustomerIn, "sales", "CUS", customer_out, _customer_in_use, "Customer",
             ["customer_type", "credit_limit", "ship_address", "ship_city", "ship_state", "ship_pincode"])
party_routes("vendor", Vendor, VendorIn, "purchases", "VEN", vendor_out, _vendor_in_use, "Vendor",
             ["contact_person", "bank_name"])


@router.get("/vendors/{pid}/products", tags=["vendors"])
def vendor_products(pid: int, user: User = Depends(require("purchases")), db: Session = Depends(get_db)):
    v = db.get(Vendor, pid)
    if not v or v.org_id != user.org_id:
        raise HTTPException(404, "Vendor not found")
    return [{"id": p.id, "sku": p.sku, "name": p.name, "purchase_price": float(p.purchase_price), "unit": p.unit,
             "source": "preferred vendor"} for p in db.scalars(
                 select(Product).where(Product.preferred_vendor_id == pid, Product.org_id == user.org_id).order_by(Product.name))]
