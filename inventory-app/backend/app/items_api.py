"""Items (products): CRUD, filters, brands, preferred vendor, opening stock, images, barcode/QR, history, CSV."""
import csv
import io
import os
import re
import uuid
from decimal import Decimal
from pathlib import Path
from typing import Literal, Optional

import barcode
import segno
from barcode.writer import SVGWriter
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import stock as stk
from .api import _totals, audit, ean13, org_of, require
from .core import get_db
from .models import (Brand, Category, Product, StockBalance, StockMovement, User, Vendor, Warehouse)

router = APIRouter(prefix="/api")
D = Decimal
UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR", "./uploads")).resolve()
MAX_IMAGE = 2 * 1024 * 1024


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    sku: Optional[str] = Field(default=None, max_length=64)
    barcode: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2000)
    category_id: Optional[int] = None
    brand_id: Optional[int] = None
    brand: Optional[str] = Field(default=None, max_length=100)  # name; created on the fly if new
    preferred_vendor_id: Optional[int] = None
    status: Literal["active", "inactive"] = "active"
    unit: str = Field(default="pcs", max_length=20)
    hsn_code: Optional[str] = Field(default=None, max_length=8)
    purchase_price: Decimal = Field(default=D(0), ge=0)
    selling_price: Decimal = Field(default=D(0), ge=0)
    tax_rate: Decimal = Field(default=D(18), ge=0, le=100)
    reorder_point: Decimal = Field(default=D(0), ge=0)
    safety_stock: Decimal = Field(default=D(0), ge=0)
    parent_id: Optional[int] = None
    attributes: Optional[dict] = None
    track_batches: bool = False
    opening_stock: Decimal = Field(default=D(0), ge=0)
    opening_warehouse_id: Optional[int] = None


class ProductPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    barcode: Optional[str] = Field(default=None, max_length=64)
    description: Optional[str] = Field(default=None, max_length=2000)
    category_id: Optional[int] = None
    brand_id: Optional[int] = None
    brand: Optional[str] = Field(default=None, max_length=100)
    preferred_vendor_id: Optional[int] = None
    status: Optional[Literal["active", "inactive"]] = None
    unit: Optional[str] = Field(default=None, max_length=20)
    hsn_code: Optional[str] = Field(default=None, max_length=8)
    purchase_price: Optional[Decimal] = Field(default=None, ge=0)
    selling_price: Optional[Decimal] = Field(default=None, ge=0)
    tax_rate: Optional[Decimal] = Field(default=None, ge=0, le=100)
    reorder_point: Optional[Decimal] = Field(default=None, ge=0)
    safety_stock: Optional[Decimal] = Field(default=None, ge=0)
    attributes: Optional[dict] = None
    is_archived: Optional[bool] = None


def product_out(p: Product, totals=None):
    on_hand, reserved, damaged = [float(x or 0) for x in (totals or (0, 0, 0))]
    return {"id": p.id, "name": p.name, "sku": p.sku, "barcode": p.barcode, "description": p.description,
            "category_id": p.category_id, "category": p.category.name if p.category else None, "brand": p.brand,
            "brand_id": p.brand_id, "preferred_vendor_id": p.preferred_vendor_id,
            "preferred_vendor": p.preferred_vendor.name if p.preferred_vendor else None, "status": p.status,
            "has_image": bool(p.image_path), "unit": p.unit, "hsn_code": p.hsn_code,
            "purchase_price": float(p.purchase_price), "selling_price": float(p.selling_price),
            "tax_rate": float(p.tax_rate), "avg_cost": float(p.avg_cost or 0), "reorder_point": float(p.reorder_point),
            "safety_stock": float(p.safety_stock), "parent_id": p.parent_id, "attributes": p.attributes,
            "is_archived": p.is_archived, "on_hand": on_hand, "reserved": reserved, "damaged": damaged,
            "available": on_hand - reserved}


def _next_sku(db, org_id):
    n = db.scalar(select(func.count(Product.id)).where(Product.org_id == org_id)) + 1
    while db.scalars(select(Product.id).where(Product.org_id == org_id, Product.sku == f"SKU-{n:06d}")).first():
        n += 1
    return f"SKU-{n:06d}"


def _resolve_brand(db, org_id, brand_id, brand_name):
    """Returns (brand_id, brand_name) from either an id or a free-text name (created if new)."""
    if brand_id:
        b = db.get(Brand, brand_id)
        if not b or b.org_id != org_id:
            raise HTTPException(422, "Unknown brand")
        return b.id, b.name
    name = (brand_name or "").strip()
    if not name:
        return None, None
    b = db.scalars(select(Brand).where(Brand.org_id == org_id, func.lower(Brand.name) == name.lower())).first()
    if not b:
        b = Brand(org_id=org_id, name=name)
        db.add(b)
        db.flush()
    return b.id, b.name


def _validate_refs(db, user, category_id=None, parent_id=None, vendor_id=None):
    if category_id:
        c = db.get(Category, category_id)
        if not c or c.org_id != user.org_id:
            raise HTTPException(422, "Unknown category")
    if parent_id:
        par = db.get(Product, parent_id)
        if not par or par.org_id != user.org_id or par.parent_id:
            raise HTTPException(422, "Parent must be an existing top-level product")
    if vendor_id:
        v = db.get(Vendor, vendor_id)
        if not v or v.org_id != user.org_id:
            raise HTTPException(422, "Unknown vendor")


def _own(db, user, pid) -> Product:
    p = db.get(Product, pid)
    if not p or p.org_id != user.org_id:
        raise HTTPException(404, "Product not found")
    return p


# ---------- brands ----------
@router.get("/brands", tags=["products"])
def brands(user: User = Depends(require("products")), db: Session = Depends(get_db)):
    return [{"id": b.id, "name": b.name} for b in db.scalars(select(Brand).where(Brand.org_id == user.org_id).order_by(Brand.name))]


class BrandIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/brands", tags=["products"], status_code=201)
def create_brand(body: BrandIn, user: User = Depends(require("products", "w")), db: Session = Depends(get_db)):
    b = Brand(org_id=user.org_id, name=body.name.strip())
    db.add(b)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Brand already exists")
    return {"id": b.id, "name": b.name}


# ---------- list / create ----------
SORTS = {"name": "name", "sku": "sku", "category": "category", "brand": "brand", "selling_price": "selling_price",
         "purchase_price": "purchase_price", "available": "available", "on_hand": "on_hand", "reserved": "reserved"}


@router.get("/products", tags=["products"])
def list_products(q: Optional[str] = None, category_id: Optional[int] = None, brand_id: Optional[int] = None,
                  vendor_id: Optional[int] = None, status: str = "active", stock: str = "all", low_stock: bool = False,
                  sort: str = "name", desc: bool = False, page: int = Query(1, ge=1),
                  page_size: int = Query(25, ge=1, le=200), user: User = Depends(require("products")),
                  db: Session = Depends(get_db)):
    """status: active | inactive | archived | all.  stock: all | in | low | out."""
    stmt = (select(Product).where(Product.org_id == user.org_id)
            .options(selectinload(Product.category), selectinload(Product.preferred_vendor)))
    if status == "active":
        stmt = stmt.where(Product.is_archived.is_(False), Product.status == "active")
    elif status == "inactive":
        stmt = stmt.where(Product.is_archived.is_(False), Product.status == "inactive")
    elif status == "archived":
        stmt = stmt.where(Product.is_archived.is_(True))
    if category_id:
        stmt = stmt.where(Product.category_id == category_id)
    if brand_id:
        stmt = stmt.where(Product.brand_id == brand_id)
    if vendor_id:
        stmt = stmt.where(Product.preferred_vendor_id == vendor_id)
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Product.name.ilike(like), Product.sku.ilike(like), Product.barcode == q.strip(),
                              Product.brand.ilike(like), Product.description.ilike(like)))
    totals = _totals(db, user.org_id)
    items = [product_out(p, totals.get(p.id)) for p in db.scalars(stmt).all()]
    if low_stock:
        stock = "low"
    if stock == "in":
        items = [i for i in items if i["available"] > 0]
    elif stock == "out":
        items = [i for i in items if i["available"] <= 0]
    elif stock == "low":
        items = [i for i in items if i["reorder_point"] and i["available"] <= i["reorder_point"]]
    key = SORTS.get(sort, "name")
    items.sort(key=lambda i: (i[key] is None, (i[key] or "").lower() if isinstance(i[key], str) else (i[key] or 0)), reverse=desc)
    total = len(items)
    start = (page - 1) * page_size
    return {"total": total, "page": page, "page_size": page_size, "items": items[start:start + page_size]}


@router.post("/products", tags=["products"], status_code=201)
def create_product(body: ProductIn, user: User = Depends(require("products", "w")), db: Session = Depends(get_db)):
    _validate_refs(db, user, body.category_id, body.parent_id, body.preferred_vendor_id)
    if body.opening_stock > 0 and not can_stock(user):
        raise HTTPException(403, "Your role cannot record opening stock")
    data = body.model_dump(exclude={"opening_stock", "opening_warehouse_id", "brand", "brand_id"})
    data["brand_id"], data["brand"] = _resolve_brand(db, user.org_id, body.brand_id, body.brand)
    data["sku"] = (data["sku"] or "").strip() or _next_sku(db, user.org_id)
    p = Product(org_id=user.org_id, **data)
    p.avg_cost = p.purchase_price
    db.add(p)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"SKU '{data['sku']}' already exists")
    if not p.barcode:
        p.barcode = ean13(p.id + user.org_id * 1000000)
    if body.opening_stock > 0:
        wid = body.opening_warehouse_id or db.scalar(select(Warehouse.id).where(
            Warehouse.org_id == user.org_id, Warehouse.is_active.is_(True)).order_by(Warehouse.id))
        try:
            stk.apply_movement(db, org_of(db, user), product_id=p.id, warehouse_id=wid, type="opening",
                               qty_delta=body.opening_stock, unit_cost=p.purchase_price, reason="Opening stock",
                               user_id=user.id, idempotency_key=f"opening:{p.id}")
        except stk.StockError as e:
            db.rollback()
            raise HTTPException(e.status, str(e))
    audit(db, user, "create", "product", p.id, {"sku": p.sku})
    db.commit()
    return product_out(p, _totals(db, user.org_id).get(p.id))


def can_stock(user) -> bool:
    from .core import can
    return can(user, "inventory", "w")


@router.get("/products/lookup/{code}", tags=["products"])
def lookup(code: str, user: User = Depends(require("products")), db: Session = Depends(get_db)):
    """Barcode / SKU scanner endpoint."""
    p = db.scalars(select(Product).where(Product.org_id == user.org_id,
                                         or_(Product.barcode == code, Product.sku == code))).first()
    if not p:
        raise HTTPException(404, "No product matches this code")
    return product_out(p, _totals(db, user.org_id).get(p.id))


@router.get("/products/{pid}", tags=["products"])
def get_product(pid: int, user: User = Depends(require("products")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    out = product_out(p, _totals(db, user.org_id).get(pid))
    out["variants"] = [product_out(v) for v in db.scalars(select(Product).where(Product.parent_id == pid))]
    whs = {w.id: w for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    out["balances"] = [{"warehouse_id": b.warehouse_id, "warehouse": whs[b.warehouse_id].code,
                        "warehouse_name": whs[b.warehouse_id].name, "on_hand": float(b.on_hand),
                        "reserved": float(b.reserved), "damaged": float(b.damaged),
                        "available": float(b.on_hand - b.reserved), "value": float(b.on_hand * (p.avg_cost or 0))}
                       for b in db.scalars(select(StockBalance).where(StockBalance.product_id == pid))]
    out["inventory_value"] = sum(b["value"] for b in out["balances"])
    return out


@router.patch("/products/{pid}", tags=["products"])
def update_product(pid: int, body: ProductPatch, user: User = Depends(require("products", "w")),
                   db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    ch = body.model_dump(exclude_unset=True)
    _validate_refs(db, user, ch.get("category_id"), None, ch.get("preferred_vendor_id"))
    if "brand_id" in ch or "brand" in ch:
        ch["brand_id"], ch["brand"] = _resolve_brand(db, user.org_id, ch.get("brand_id"), ch.get("brand"))
    for k, v in ch.items():
        setattr(p, k, v)
    audit(db, user, "update", "product", p.id, {k: str(v) for k, v in ch.items()})
    db.commit()
    return product_out(p, _totals(db, user.org_id).get(pid))


@router.delete("/products/{pid}", tags=["products"], status_code=204)
def delete_product(pid: int, user: User = Depends(require("products", "w")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    if db.scalars(select(StockMovement.id).where(StockMovement.product_id == pid).limit(1)).first():
        raise HTTPException(409, "Product has stock history; archive it instead of deleting")
    if db.scalars(select(Product.id).where(Product.parent_id == pid).limit(1)).first():
        raise HTTPException(409, "Delete or re-parent this product's variants first")
    db.query(StockBalance).filter(StockBalance.product_id == pid).delete()
    _drop_image(p)
    db.delete(p)
    audit(db, user, "delete", "product", pid, {"sku": p.sku})
    db.commit()


# ---------- stock history ----------
@router.get("/products/{pid}/history", tags=["products"])
def product_history(pid: int, type: Optional[str] = None, page: int = Query(1, ge=1),
                    page_size: int = Query(25, ge=1, le=100), user: User = Depends(require("products")),
                    db: Session = Depends(get_db)):
    """Every ledger entry for the item with the responsible user and warehouse."""
    _own(db, user, pid)
    stmt = select(StockMovement).where(StockMovement.product_id == pid, StockMovement.org_id == user.org_id)
    if type:
        stmt = stmt.where(StockMovement.type == type)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(StockMovement.id.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    users = {u.id: u.name for u in db.scalars(select(User).where(User.org_id == user.org_id))}
    whs = {w.id: w.code for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    return {"total": total, "page": page, "page_size": page_size, "items": [
        {"id": m.id, "created_at": m.created_at, "type": m.type, "warehouse": whs.get(m.warehouse_id),
         "qty_delta": float(m.qty_delta), "reserved_delta": float(m.reserved_delta),
         "on_hand_after": float(m.on_hand_after), "reserved_after": float(m.reserved_after),
         "unit_cost": float(m.unit_cost) if m.unit_cost is not None else None, "ref_type": m.ref_type,
         "ref_id": m.ref_id, "reason": m.reason, "user": users.get(m.user_id)} for m in rows]}


# ---------- image (validated, stored outside the web root, served only to authenticated users) ----------
def _sniff(b: bytes):
    if b.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if b.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _drop_image(p: Product):
    if p.image_path:
        try:
            (UPLOAD_DIR / p.image_path).unlink(missing_ok=True)
        except OSError:
            pass
        p.image_path = None


@router.post("/products/{pid}/image", tags=["products"])
async def upload_image(pid: int, file: UploadFile, user: User = Depends(require("products", "w")),
                       db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    raw = await file.read(MAX_IMAGE + 1)
    if len(raw) > MAX_IMAGE:
        raise HTTPException(413, "Image too large (max 2 MB)")
    kind = _sniff(raw)  # trust the bytes, not the filename or declared content type
    if not kind:
        raise HTTPException(422, "Only PNG, JPEG or WebP images are accepted")
    rel = f"items/{user.org_id}/{uuid.uuid4().hex}.{kind[0]}"
    dest = UPLOAD_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(raw)
    _drop_image(p)
    p.image_path = rel
    audit(db, user, "image", "product", pid, {"bytes": len(raw)})
    db.commit()
    return {"has_image": True}


@router.get("/products/{pid}/image", tags=["products"])
def get_image(pid: int, user: User = Depends(require("products")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    path = (UPLOAD_DIR / p.image_path).resolve() if p.image_path else None
    if not path or UPLOAD_DIR not in path.parents or not path.exists():
        raise HTTPException(404, "No image")
    return FileResponse(path, media_type=_sniff(path.read_bytes()[:16])[1], headers={"Cache-Control": "private, max-age=300"})


@router.delete("/products/{pid}/image", tags=["products"], status_code=204)
def delete_image(pid: int, user: User = Depends(require("products", "w")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    _drop_image(p)
    db.commit()


# ---------- barcode / QR (generated on demand as SVG) ----------
@router.get("/products/{pid}/barcode.svg", tags=["products"])
def barcode_svg(pid: int, user: User = Depends(require("products")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    value = p.barcode or p.sku
    buf = io.BytesIO()
    try:
        if re.fullmatch(r"\d{13}", value):
            code = barcode.get("ean13", value[:12], writer=SVGWriter())  # check digit is recomputed
        else:
            code = barcode.get("code128", value, writer=SVGWriter())
        code.write(buf, options={"module_height": 14, "font_size": 9, "text_distance": 4, "quiet_zone": 3})
    except Exception:
        raise HTTPException(422, "This barcode value cannot be rendered")
    return Response(buf.getvalue(), media_type="image/svg+xml")


@router.get("/products/{pid}/qr.svg", tags=["products"])
def qr_svg(pid: int, user: User = Depends(require("products")), db: Session = Depends(get_db)):
    p = _own(db, user, pid)
    buf = io.BytesIO()
    segno.make(p.sku, error="m").save(buf, kind="svg", scale=5, border=2, dark="#111827")
    return Response(buf.getvalue(), media_type="image/svg+xml")


# ---------- CSV ----------
CSV_COLS = ["name", "sku", "barcode", "category", "brand", "preferred_vendor", "status", "unit", "hsn_code",
            "purchase_price", "selling_price", "tax_rate", "reorder_point", "opening_stock", "warehouse"]


@router.get("/products-export.csv", tags=["products"])
def export_products(user: User = Depends(require("products")), db: Session = Depends(get_db)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLS[:-2] + ["on_hand", "reserved"])
    totals = _totals(db, user.org_id)
    q = select(Product).where(Product.org_id == user.org_id).options(selectinload(Product.category),
                                                                    selectinload(Product.preferred_vendor))
    for p in db.scalars(q.order_by(Product.sku)):
        t = totals.get(p.id, (0, 0, 0))
        w.writerow([p.name, p.sku, p.barcode, p.category.name if p.category else "", p.brand or "",
                    p.preferred_vendor.code if p.preferred_vendor else "", p.status, p.unit, p.hsn_code or "",
                    p.purchase_price, p.selling_price, p.tax_rate, p.reorder_point, t[0] or 0, t[1] or 0])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": "attachment; filename=items.csv"})


@router.post("/products-import", tags=["products"])
async def import_products(file: UploadFile, user: User = Depends(require("products", "w")),
                          db: Session = Depends(get_db)):
    if len(raw := await file.read()) > 5_000_000:
        raise HTTPException(413, "File too large (max 5 MB)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(422, "File must be UTF-8 encoded CSV")
    created, errors = 0, []
    cats = {c.name.lower(): c for c in db.scalars(select(Category).where(Category.org_id == user.org_id))}
    vendors = {v.code.lower(): v for v in db.scalars(select(Vendor).where(Vendor.org_id == user.org_id))}
    whs = {w.code.lower(): w for w in db.scalars(select(Warehouse).where(Warehouse.org_id == user.org_id))}
    default_wh = next((w for w in sorted(whs.values(), key=lambda w: w.id) if w.is_active), None)
    org = org_of(db, user)
    for n, row in enumerate(csv.DictReader(io.StringIO(text)), start=2):
        try:
            with db.begin_nested():  # a bad row rolls back only itself (including a created category/brand)
                name = (row.get("name") or "").strip()
                if not name:
                    raise ValueError("name is required")
                sku = (row.get("sku") or "").strip() or _next_sku(db, user.org_id)
                if db.scalars(select(Product.id).where(Product.org_id == user.org_id, Product.sku == sku)).first():
                    raise ValueError(f"SKU {sku} already exists")
                cat = None
                if (cn := (row.get("category") or "").strip()):
                    cat = cats.get(cn.lower())
                    if not cat:
                        cat = Category(org_id=user.org_id, name=cn)
                        db.add(cat)
                        db.flush()
                        cats[cn.lower()] = cat
                try:
                    pp, sp, tr = D(row.get("purchase_price") or 0), D(row.get("selling_price") or 0), D(row.get("tax_rate") or 18)
                    ro, op = D(row.get("reorder_point") or 0), D(row.get("opening_stock") or 0)
                except Exception:
                    raise ValueError("numeric column is not a number")
                if min(pp, sp, ro, op) < 0 or not 0 <= tr <= 100:
                    raise ValueError("prices, quantities or tax out of range")
                status = (row.get("status") or "active").strip().lower()
                if status not in ("active", "inactive"):
                    raise ValueError("status must be active or inactive")
                vend = None
                if (vc := (row.get("preferred_vendor") or "").strip()):
                    vend = vendors.get(vc.lower())
                    if not vend:
                        raise ValueError(f"unknown vendor code {vc}")
                bid, bname = _resolve_brand(db, user.org_id, None, row.get("brand"))
                p = Product(org_id=user.org_id, name=name, sku=sku, barcode=(row.get("barcode") or None),
                            category_id=cat.id if cat else None, brand_id=bid, brand=bname, status=status,
                            preferred_vendor_id=vend.id if vend else None, unit=row.get("unit") or "pcs",
                            hsn_code=row.get("hsn_code") or None, purchase_price=pp, selling_price=sp, tax_rate=tr,
                            avg_cost=pp, reorder_point=ro)
                db.add(p)
                db.flush()
                if not p.barcode:
                    p.barcode = ean13(p.id + user.org_id * 1000000)
                if op > 0:
                    wh = whs.get((row.get("warehouse") or "").strip().lower()) if row.get("warehouse") else default_wh
                    if not wh:
                        raise ValueError("opening stock needs a valid warehouse code")
                    stk.apply_movement(db, org, product_id=p.id, warehouse_id=wh.id, type="opening", qty_delta=op,
                                       unit_cost=pp, reason="Opening stock (CSV import)", user_id=user.id,
                                       idempotency_key=f"opening:{p.id}")
            created += 1
        except Exception as e:  # row-level failure doesn't abort the import
            errors.append({"row": n, "error": str(e)})
    audit(db, user, "import", "product", None, {"created": created, "errors": len(errors)})
    db.commit()
    return {"created": created, "errors": errors}
