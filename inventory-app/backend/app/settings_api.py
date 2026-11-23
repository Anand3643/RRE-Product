"""Settings & administration: organization profile (name, GSTIN, state, address) and stock policy."""
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from .api import audit, org_of, require
from .core import can, get_db
from .models import User

router = APIRouter(prefix="/api")
GSTIN = re.compile(r"^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$")


def org_out(o):
    return {"id": o.id, "name": o.name, "currency": o.currency, "gstin": o.gstin, "state": o.state, "address": o.address,
            "allow_negative_stock": o.allow_negative_stock}


class OrgPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=200)
    gstin: Optional[str] = None
    state: Optional[str] = Field(default=None, max_length=100)
    address: Optional[str] = Field(default=None, max_length=300)
    allow_negative_stock: Optional[bool] = None

    @field_validator("gstin")
    @classmethod
    def _gstin(cls, v):
        if v in (None, ""):
            return None
        v = v.strip().upper()
        if not GSTIN.match(v):
            raise ValueError("GSTIN must be 15 characters, e.g. 27ABCDE1234F1Z5")
        return v


@router.get("/organization", tags=["settings"])
def get_org(user: User = Depends(require("settings")), db: Session = Depends(get_db)):
    return org_out(org_of(db, user))


@router.patch("/organization", tags=["settings"])
def patch_org(body: OrgPatch, user: User = Depends(require("settings", "w")), db: Session = Depends(get_db)):
    o = org_of(db, user)
    ch = body.model_dump(exclude_unset=True)
    if "allow_negative_stock" in ch and user.role not in ("owner", "admin"):
        raise HTTPException(403, "Only an owner or admin can change the negative-stock policy")
    for k, v in ch.items():
        setattr(o, k, v)
    audit(db, user, "update", "organization", o.id, {"fields": list(ch)})
    db.commit()
    return org_out(o)
