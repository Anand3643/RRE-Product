"""Server-side provisioning of the initial administrator (never reachable over HTTP).

  INITIAL_ADMIN_EMAIL     required to do anything
  INITIAL_ADMIN_PASSWORD  optional; if omitted a random one is generated, logged ONCE and must be changed at first login
  INITIAL_ADMIN_NAME      optional display name
  INITIAL_ADMIN_ORG_ID    optional; default = the oldest organisation (created if none exists)
"""
import logging
import os
import secrets

from sqlalchemy import select

from .core import ADMIN_ROLES, SessionLocal, hash_password
from .models import AuditLog, Organization, User, Warehouse

log = logging.getLogger("stockpilot.bootstrap")
PLACEHOLDERS = {"", "your-email@example.com"}


def provision_initial_admin() -> str | None:
    email = os.getenv("INITIAL_ADMIN_EMAIL", "").strip().lower()
    if email in PLACEHOLDERS or "@" not in email:
        return None
    with SessionLocal() as db:
        existing = db.scalars(select(User).where(User.email == email)).first()
        if existing:
            if existing.role in ADMIN_ROLES:
                log.info("Initial admin %s already has the %s role - left unchanged", email, existing.role)
                return "kept"
            existing.role, existing.permissions = "admin", None
            db.add(AuditLog(org_id=existing.org_id, user_id=existing.id, action="admin_provisioned", entity="user",
                            entity_id=str(existing.id), detail={"source": "INITIAL_ADMIN_EMAIL", "promoted": True}))
            db.commit()
            log.warning("Existing user %s promoted to admin via INITIAL_ADMIN_EMAIL", email)
            return "promoted"
        org_id = os.getenv("INITIAL_ADMIN_ORG_ID")
        org = db.get(Organization, int(org_id)) if org_id else db.scalars(select(Organization).order_by(Organization.id)).first()
        if org is None:
            org = Organization(name="My Organization")
            db.add(org)
            db.flush()
            db.add(Warehouse(org_id=org.id, code="MAIN", name="Main Warehouse"))
        pw = os.getenv("INITIAL_ADMIN_PASSWORD") or ""
        generated = not pw
        if generated:
            pw = secrets.token_urlsafe(12) + "7a"
        u = User(org_id=org.id, email=email, name=os.getenv("INITIAL_ADMIN_NAME") or email.split("@")[0].title(),
                 role="admin", password_hash=hash_password(pw), must_change_password=generated)
        db.add(u)
        db.flush()
        db.add(AuditLog(org_id=org.id, user_id=u.id, action="admin_provisioned", entity="user", entity_id=str(u.id),
                        detail={"source": "INITIAL_ADMIN_EMAIL", "created": True}))
        db.commit()
        if generated:
            log.warning("INITIAL ADMIN CREATED: %s  temporary password: %s  (shown once; change it at first sign-in)", email, pw)
        else:
            log.warning("INITIAL ADMIN CREATED: %s (password from INITIAL_ADMIN_PASSWORD)", email)
        return "created"
