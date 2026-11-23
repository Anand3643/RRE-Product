"""Config, database engine/session, security helpers."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

def _load_dotenv():
    """Tiny .env reader (backend/.env): KEY=VALUE lines; real environment variables win."""
    f = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.isfile(f):
        for line in open(f, encoding="utf-8-sig"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.split(" #")[0].strip().strip('"').strip("'"))


_load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./stockpilot.db")
SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-me-in-production-0123456789")
ACCESS_MINUTES = int(os.getenv("ACCESS_MINUTES", "30"))
REFRESH_DAYS = int(os.getenv("REFRESH_DAYS", "14"))
ALGO = "HS256"

_kwargs = {}
if DATABASE_URL.startswith("sqlite"):
    _kwargs["connect_args"] = {"check_same_thread": False}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, **_kwargs)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _fk_pragma(conn, _):  # enforce FKs + better concurrency on SQLite
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def now():
    return datetime.now(timezone.utc)


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except ValueError:
        return False


def make_token(user_id: int, kind: str, minutes: int = 0, days: int = 0, sid: str | None = None) -> tuple[str, str, datetime]:
    jti = uuid.uuid4().hex
    issued = now()
    exp = issued + timedelta(minutes=minutes, days=days)
    tok = jwt.encode({"sub": str(user_id), "typ": kind, "jti": jti, "exp": exp, "iat": issued.timestamp(), "sid": sid},
                     SECRET_KEY, algorithm=ALGO)
    return tok, jti, exp


def decode_token(token: str, kind: str) -> dict:
    data = jwt.decode(token, SECRET_KEY, algorithms=[ALGO])
    if data.get("typ") != kind:
        raise jwt.InvalidTokenError("wrong token type")
    return data


# ---- RBAC ----
MODULES = ["products", "inventory", "warehouses", "sales", "purchases", "fulfilment", "finance", "reports", "users", "settings"]
ROLE_PERMS: dict[str, dict[str, str]] = {
    "user": {},   # portal-only account (customer): no staff modules
    # module -> "r" read, "w" read+write
    "owner": {m: "w" for m in MODULES},
    "admin": {m: "w" for m in MODULES},
    "manager": {**{m: "w" for m in MODULES}, "users": "r", "settings": "r"},
    "warehouse": {"products": "r", "inventory": "w", "warehouses": "w", "reports": "r", "sales": "r", "purchases": "r", "fulfilment": "w"},
    "sales": {"products": "r", "inventory": "r", "sales": "w", "reports": "r", "fulfilment": "r"},
    "accountant": {"products": "r", "finance": "w", "sales": "r", "purchases": "r", "reports": "r", "fulfilment": "r"},
    "viewer": {m: "r" for m in MODULES if m not in ("users", "settings")},
}
ROLES = list(ROLE_PERMS)
ADMIN_ROLES = ("owner", "admin")          # the "ADMIN" user type; every other role is a "USER" template
ACTIONS = ["view", "create", "edit", "delete", "approve", "export"]
WRITE_ACTIONS = {"create", "edit", "delete", "approve"}


def is_admin(subject) -> bool:
    return (subject if isinstance(subject, str) else subject.role) in ADMIN_ROLES


def role_actions(role: str, module: str) -> set[str]:
    """Default actions a role template grants on a module."""
    have = ROLE_PERMS.get(role, {}).get(module)
    if have == "w":
        return set(ACTIONS)
    if have == "r":
        return {"view", "export"}
    return set()


def actions_for(subject, module: str) -> set[str]:
    """Effective actions. Admins always have everything; a user with an explicit permission set uses it
    (any granted action implies view); otherwise the role template applies."""
    if isinstance(subject, str):
        return role_actions(subject, module)
    if subject.role in ADMIN_ROLES:
        return set(ACTIONS)
    custom = getattr(subject, "permissions", None)
    if custom is not None:
        got = {a for a in custom.get(module, []) if a in ACTIONS}
        if got:
            got.add("view")
        return got
    return role_actions(subject.role, module)


def effective_permissions(subject) -> dict[str, list[str]]:
    return {m: sorted(actions_for(subject, m), key=ACTIONS.index) for m in MODULES if actions_for(subject, m)}


def legacy_permissions(subject) -> dict[str, str]:
    """module -> 'r' | 'w' (what the existing UI gates on)."""
    out = {}
    for m in MODULES:
        a = actions_for(subject, m)
        if a & WRITE_ACTIONS:
            out[m] = "w"
        elif "view" in a:
            out[m] = "r"
    return out


def can(subject, module: str, level: str = "r", action: str | None = None) -> bool:
    """subject is a User (preferred: honours per-user permissions) or a bare role name."""
    a = actions_for(subject, module)
    if action:
        return action in a
    return bool(a & WRITE_ACTIONS) if level == "w" else "view" in a


def validate_permissions(perms) -> dict[str, list[str]]:
    if not isinstance(perms, dict):
        raise ValueError("permissions must be an object of module -> actions")
    out = {}
    for m, acts in perms.items():
        if m not in MODULES:
            raise ValueError(f"Unknown module '{m}'")
        if not isinstance(acts, list) or any(a not in ACTIONS for a in acts):
            raise ValueError(f"Invalid actions for '{m}'. Allowed: {ACTIONS}")
        if acts:
            out[m] = sorted(set(acts), key=ACTIONS.index)
    return out
