"""One-off repair for installs where every self-registration created its own organisation + owner (= ADMIN).

  python -m app.consolidate --admin-email you@example.com           # dry run: prints the plan, changes nothing
  python -m app.consolidate --admin-email you@example.com --apply   # performs it

The named account stays ADMIN of its organisation. Every other account that is an owner of its OWN organisation
is inspected: if that organisation holds no business data (items, customers, vendors, orders, extra warehouses)
the account becomes a USER in the administrator's organisation with its own customer record, and its login
history is kept (re-pointed to that organisation). Organisations that do contain data are never touched - they
are reported so a person can decide. Nothing is deleted.
"""
import argparse

from sqlalchemy import func, select, update

from .core import ADMIN_ROLES, SessionLocal
from .models import (AuditLog, Customer, LoginAuditLog, Organization, Product, PurchaseOrder, SalesOrder, User, UserSession, Vendor, Warehouse)
from .sequences import next_number


def org_has_data(db, org_id: int) -> list[str]:
    found = []
    for label, model in (("items", Product), ("customers", Customer), ("vendors", Vendor), ("sales orders", SalesOrder), ("purchase orders", PurchaseOrder)):
        n = db.scalar(select(func.count()).select_from(model).where(model.org_id == org_id)) or 0
        if n:
            found.append(f"{n} {label}")
    extra = db.scalar(select(func.count()).select_from(Warehouse).where(Warehouse.org_id == org_id, Warehouse.code != "MAIN")) or 0
    if extra:
        found.append(f"{extra} extra warehouses")
    return found


def run(admin_email: str, apply: bool) -> int:
    with SessionLocal() as db:
        admin = db.scalars(select(User).where(User.email == admin_email.lower())).first()
        if not admin:
            print(f"No account with e-mail {admin_email}")
            return 2
        if admin.role not in ADMIN_ROLES:
            print(f"{admin_email} is not an administrator (role {admin.role}); refusing to guess")
            return 2
        print(f"ADMIN: {admin.email} (id {admin.id}, org {admin.org_id}) - kept as is")
        for u in db.scalars(select(User).where(User.id != admin.id).order_by(User.id)).all():
            same_org = u.org_id == admin.org_id
            if u.role not in ADMIN_ROLES and same_org:
                print(f"  ok      {u.email}: already a USER in the administrator's organisation")
                continue
            if same_org:
                print(f"  SKIP    {u.email}: administrator role inside the main organisation (change it in User management)")
                continue
            data = org_has_data(db, u.org_id)
            if data:
                print(f"  SKIP    {u.email}: owns organisation {u.org_id} that contains {', '.join(data)} - not touched")
                continue
            print(f"  {'MOVE ' if apply else 'would move'} {u.email}: {u.role} of empty organisation {u.org_id} -> USER in organisation {admin.org_id}")
            if not apply:
                continue
            old_org = u.org_id
            cust = Customer(org_id=admin.org_id, code=next_number(db, admin.org_id, "CUS"), name=u.name, email=u.email, phone=u.phone, customer_type="individual", payment_terms=0)
            db.add(cust)
            db.flush()
            u.org_id, u.role, u.permissions, u.customer_id = admin.org_id, "user", None, cust.id
            for model in (UserSession, LoginAuditLog):
                db.execute(update(model).where(model.user_id == u.id).values(org_id=admin.org_id))
            db.execute(update(AuditLog).where(AuditLog.user_id == u.id, AuditLog.org_id == old_org).values(org_id=admin.org_id))
            db.add(AuditLog(org_id=admin.org_id, user_id=admin.id, action="account_consolidated", entity="user", entity_id=str(u.id),
                            detail={"from_org": old_org, "role": "user"}))
        if apply:
            db.commit()
            print("Done. Organisations left empty were kept (nothing deleted).")
        else:
            print("Dry run only. Re-run with --apply to perform these changes.")
        orgs = db.scalars(select(Organization).order_by(Organization.id)).all()
        print("Organisations now:", [(o.id, o.name, db.scalar(select(func.count()).select_from(User).where(User.org_id == o.id))) for o in orgs])
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--admin-email", required=True)
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()
    raise SystemExit(run(a.admin_email, a.apply))
