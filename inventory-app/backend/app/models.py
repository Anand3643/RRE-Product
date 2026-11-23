from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (JSON, Boolean, CheckConstraint, Date, DateTime, ForeignKey, Index, Integer, Numeric, String,
                        Text, UniqueConstraint)
from sqlalchemy import false as sa_false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .core import Base, now

Money = Numeric(14, 2)
Qty = Numeric(14, 3)
Cost = Numeric(14, 4)


class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    currency: Mapped[str] = mapped_column(String(3), default="INR")
    gstin: Mapped[str | None] = mapped_column(String(15))
    state: Mapped[str | None] = mapped_column(String(100))  # place of supply for GST (CGST+SGST vs IGST)
    address: Mapped[str | None] = mapped_column(String(300))
    allow_negative_stock: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20), default="viewer")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    phone: Mapped[str | None] = mapped_column(String(30))
    department: Mapped[str | None] = mapped_column(String(80))
    # None = use the role template; otherwise {module: [view, create, edit, delete, approve, export]}
    permissions: Mapped[dict | None] = mapped_column(JSON)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa_false())
    failed_logins: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tokens_valid_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # access tokens issued earlier are rejected
    reset_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("customers.id"), index=True)  # the customer record a USER (portal account) owns


class UserSession(Base):
    """One signed-in device. Only the SHA-256 of the session id is stored (never a token)."""
    __tablename__ = "user_sessions"
    __table_args__ = (Index("ix_user_sessions_user_login", "user_id", "login_at"), Index("ix_user_sessions_org_login", "org_id", "login_at"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    session_id_hash: Mapped[str] = mapped_column(String(64), unique=True)
    login_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    logout_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    device_type: Mapped[str] = mapped_column(String(12), default="Unknown")
    browser: Mapped[str] = mapped_column(String(40), default="Unknown")
    os: Mapped[str] = mapped_column(String(30), default="Unknown")
    session_status: Mapped[str] = mapped_column(String(12), default="active")  # active | logged_out | terminated | expired
    end_reason: Mapped[str | None] = mapped_column(String(40))
    terminated_by: Mapped[int | None] = mapped_column(Integer)
    suspicious: Mapped[bool] = mapped_column(Boolean, default=False, server_default=sa_false())
    suspicious_reason: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LoginAuditLog(Base):
    """Authentication events, including attempts for unknown accounts (user_id NULL). No passwords or tokens."""
    __tablename__ = "login_audit_logs"
    __table_args__ = (Index("ix_login_audit_org_ts", "org_id", "event_timestamp"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True)
    email_attempted: Mapped[str] = mapped_column(String(255), index=True)
    event_type: Mapped[str] = mapped_column(String(24))  # login_success | login_failed | logout | session_terminated | session_expired
    event_timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    ip_address: Mapped[str | None] = mapped_column(String(45))
    device_information: Mapped[str | None] = mapped_column(String(160))
    failure_category: Mapped[str | None] = mapped_column(String(24))  # unknown_account | wrong_password | account_locked | account_deactivated | throttled
    session_id: Mapped[int | None] = mapped_column(ForeignKey("user_sessions.id"))
    detail: Mapped[dict | None] = mapped_column(JSON)


class SupportTicket(Base):
    __tablename__ = "support_tickets"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    subject: Mapped[str] = mapped_column(String(200))
    message: Mapped[str] = mapped_column(String(2000))
    status: Mapped[str] = mapped_column(String(10), default="open")  # open | answered | closed
    reply: Mapped[str | None] = mapped_column(String(2000))
    replied_by: Mapped[int | None] = mapped_column(Integer)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class PasswordReset(Base):
    """One-time password-reset link issued by an admin (only the SHA-256 of the token is stored)."""
    __tablename__ = "password_resets"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[int | None] = mapped_column(Integer)


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    jti: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))


class Product(Base):
    """A stock-keeping item. Variants are child products (parent_id) with attributes like size/colour."""
    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("org_id", "sku"),
        CheckConstraint("purchase_price >= 0 AND selling_price >= 0 AND tax_rate >= 0 AND tax_rate <= 100"),
        Index("ix_products_org_barcode", "org_id", "barcode"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id"))
    name: Mapped[str] = mapped_column(String(200), index=True)
    sku: Mapped[str] = mapped_column(String(64))
    barcode: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(String(100))
    unit: Mapped[str] = mapped_column(String(20), default="pcs")
    hsn_code: Mapped[str | None] = mapped_column(String(8))
    purchase_price: Mapped[Decimal] = mapped_column(Money, default=0)
    selling_price: Mapped[Decimal] = mapped_column(Money, default=0)
    tax_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=18)
    avg_cost: Mapped[Decimal] = mapped_column(Cost, default=0)  # weighted average, maintained by stock service
    reorder_point: Mapped[Decimal] = mapped_column(Qty, default=0)
    safety_stock: Mapped[Decimal] = mapped_column(Qty, default=0)
    attributes: Mapped[dict | None] = mapped_column(JSON)  # variant attrs + custom fields
    track_batches: Mapped[bool] = mapped_column(Boolean, default=False)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(10), default="active")  # active | inactive (archived is separate)
    brand_id: Mapped[int | None] = mapped_column(ForeignKey("brands.id"))
    preferred_vendor_id: Mapped[int | None] = mapped_column(ForeignKey("vendors.id"))
    image_path: Mapped[str | None] = mapped_column(String(300))  # relative to UPLOAD_DIR
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    category = relationship("Category")
    preferred_vendor = relationship("Vendor", foreign_keys=[preferred_vendor_id])


class Warehouse(Base):
    __tablename__ = "warehouses"
    __table_args__ = (UniqueConstraint("org_id", "code"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    code: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(120))
    city: Mapped[str | None] = mapped_column(String(100))
    state: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(String(300))
    pincode: Mapped[str | None] = mapped_column(String(10))
    contact_name: Mapped[str | None] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    email: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(String(500))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)  # False = archived
    created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=now)


class StockBalance(Base):
    """Current quantities per product+warehouse. Only the stock service writes this table."""
    __tablename__ = "stock_balances"
    __table_args__ = (
        UniqueConstraint("product_id", "warehouse_id"),
        CheckConstraint("reserved >= 0 AND damaged >= 0"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    on_hand: Mapped[Decimal] = mapped_column(Qty, default=0)
    reserved: Mapped[Decimal] = mapped_column(Qty, default=0)
    damaged: Mapped[Decimal] = mapped_column(Qty, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)  # optimistic lock for SQLite / extra safety


class StockMovement(Base):
    """Append-only ledger. qty_delta affects on_hand; reserved_delta affects reservations."""
    __tablename__ = "stock_movements"
    __table_args__ = (UniqueConstraint("org_id", "idempotency_key"), Index("ix_mv_org_created", "org_id", "created_at"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    type: Mapped[str] = mapped_column(String(30))  # opening, receipt, issue, adjustment, transfer_in/out, reserve, release, damage
    qty_delta: Mapped[Decimal] = mapped_column(Qty, default=0)
    reserved_delta: Mapped[Decimal] = mapped_column(Qty, default=0)
    on_hand_after: Mapped[Decimal] = mapped_column(Qty)
    reserved_after: Mapped[Decimal] = mapped_column(Qty)
    unit_cost: Mapped[Decimal | None] = mapped_column(Cost)
    ref_type: Mapped[str | None] = mapped_column(String(30))
    ref_id: Mapped[str | None] = mapped_column(String(40))
    reason: Mapped[str | None] = mapped_column(String(300))
    idempotency_key: Mapped[str | None] = mapped_column(String(80))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AuditLog(Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(40))
    entity: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[str | None] = mapped_column(String(40))
    detail: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str | None] = mapped_column(Text)
    dedupe_key: Mapped[str | None] = mapped_column(String(80))
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TransferOrder(Base):
    __tablename__ = "transfer_orders"
    __table_args__ = (UniqueConstraint("org_id", "number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    from_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    to_warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="completed")
    notes: Mapped[str | None] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual | assistant
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    lines = relationship("TransferLine", cascade="all, delete-orphan")


class TransferLine(Base):
    __tablename__ = "transfer_lines"
    __table_args__ = (CheckConstraint("quantity > 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("transfer_orders.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)


class PurchaseRequest(Base):
    """Lightweight request raised from low stock; becomes a PO source in Phase 2."""
    __tablename__ = "purchase_requests"
    __table_args__ = (UniqueConstraint("org_id", "number"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="open")
    notes: Mapped[str | None] = mapped_column(String(300))
    source: Mapped[str] = mapped_column(String(20), default="manual")
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    lines = relationship("PurchaseRequestLine", cascade="all, delete-orphan")


class PurchaseRequestLine(Base):
    __tablename__ = "purchase_request_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("purchase_requests.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)


class AssistantDraft(Base):
    """Action prepared by the AI assistant. Nothing is applied until a user confirms it."""
    __tablename__ = "assistant_drafts"
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # transfer | adjustment | purchase_request
    title: Mapped[str] = mapped_column(String(200))
    payload: Mapped[dict] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | confirmed | dismissed
    result: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class NumberSequence(Base):
    """Gap-tolerant, race-safe document counters per organization and document type (SO, PO, PKG, ...)."""
    __tablename__ = "number_sequences"
    __table_args__ = (UniqueConstraint("org_id", "doc_type"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(20))
    next_value: Mapped[int] = mapped_column(Integer, default=1)

class Brand(Base):
    __tablename__ = "brands"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    name: Mapped[str] = mapped_column(String(120))


class _PartyMixin:
    """Columns shared by customers and vendors."""
    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200), index=True)
    company_name: Mapped[str | None] = mapped_column(String(200))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(30))
    gstin: Mapped[str | None] = mapped_column(String(15))
    bill_address: Mapped[str | None] = mapped_column(String(300))
    bill_city: Mapped[str | None] = mapped_column(String(100))
    bill_state: Mapped[str | None] = mapped_column(String(100))
    bill_pincode: Mapped[str | None] = mapped_column(String(10))
    payment_terms: Mapped[int] = mapped_column(Integer, default=30)  # days; 0 = due on receipt
    status: Mapped[str] = mapped_column(String(10), default="active")
    notes: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Customer(_PartyMixin, Base):
    __tablename__ = "customers"
    __table_args__ = (UniqueConstraint("org_id", "code"), CheckConstraint("credit_limit >= 0"))
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    customer_type: Mapped[str] = mapped_column(String(12), default="business")  # business | individual
    ship_address: Mapped[str | None] = mapped_column(String(300))
    ship_city: Mapped[str | None] = mapped_column(String(100))
    ship_state: Mapped[str | None] = mapped_column(String(100))
    ship_pincode: Mapped[str | None] = mapped_column(String(10))
    credit_limit: Mapped[Decimal] = mapped_column(Money, default=0)


class Vendor(_PartyMixin, Base):
    __tablename__ = "vendors"
    __table_args__ = (UniqueConstraint("org_id", "code"),)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    contact_person: Mapped[str | None] = mapped_column(String(120))
    bank_name: Mapped[str | None] = mapped_column(String(120))
    bank_account: Mapped[str | None] = mapped_column(String(34))
    bank_ifsc: Mapped[str | None] = mapped_column(String(11))

Pct = Numeric(5, 2)


class PurchaseOrder(Base):
    __tablename__ = "purchase_orders"
    __table_args__ = (UniqueConstraint("org_id", "number"), Index("ix_po_org_status", "org_id", "status"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    vendor_id: Mapped[int] = mapped_column(ForeignKey("vendors.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))  # default receiving warehouse
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft|issued|partially_received|received|cancelled
    order_date: Mapped[date] = mapped_column(Date)
    expected_date: Mapped[date | None] = mapped_column(Date)
    reference: Mapped[str | None] = mapped_column(String(60))
    notes: Mapped[str | None] = mapped_column(String(500))
    gst_mode: Mapped[str] = mapped_column(String(5), default="intra")  # intra = CGST+SGST, inter = IGST
    subtotal: Mapped[Decimal] = mapped_column(Money, default=0)  # before discount
    discount_total: Mapped[Decimal] = mapped_column(Money, default=0)
    taxable_total: Mapped[Decimal] = mapped_column(Money, default=0)
    cgst: Mapped[Decimal] = mapped_column(Money, default=0)
    sgst: Mapped[Decimal] = mapped_column(Money, default=0)
    igst: Mapped[Decimal] = mapped_column(Money, default=0)
    total: Mapped[Decimal] = mapped_column(Money, default=0)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    vendor = relationship("Vendor")
    lines = relationship("PurchaseOrderLine", cascade="all, delete-orphan", order_by="PurchaseOrderLine.id")
    receipts = relationship("GoodsReceipt", order_by="GoodsReceipt.id")


class PurchaseOrderLine(Base):
    __tablename__ = "purchase_order_lines"
    __table_args__ = (CheckConstraint("quantity > 0 AND qty_received >= 0 AND qty_received <= quantity AND rate >= 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    po_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    quantity: Mapped[Decimal] = mapped_column(Qty)
    qty_received: Mapped[Decimal] = mapped_column(Qty, default=0)
    rate: Mapped[Decimal] = mapped_column(Money)
    discount_pct: Mapped[Decimal] = mapped_column(Pct, default=0)
    tax_rate: Mapped[Decimal] = mapped_column(Pct, default=0)
    discount_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    taxable: Mapped[Decimal] = mapped_column(Money, default=0)
    tax_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    amount: Mapped[Decimal] = mapped_column(Money, default=0)  # taxable + tax
    product = relationship("Product")


class GoodsReceipt(Base):
    """A delivery (full or partial) against a purchase order. Posting one writes receipt movements to the ledger."""
    __tablename__ = "goods_receipts"
    __table_args__ = (UniqueConstraint("org_id", "number"), UniqueConstraint("org_id", "client_key"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    po_id: Mapped[int] = mapped_column(ForeignKey("purchase_orders.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    received_on: Mapped[date] = mapped_column(Date)
    notes: Mapped[str | None] = mapped_column(String(300))
    client_key: Mapped[str | None] = mapped_column(String(80))  # makes a double-submitted receipt a no-op
    received_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    lines = relationship("GoodsReceiptLine", cascade="all, delete-orphan", order_by="GoodsReceiptLine.id")


class GoodsReceiptLine(Base):
    __tablename__ = "goods_receipt_lines"
    __table_args__ = (CheckConstraint("quantity > 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    receipt_id: Mapped[int] = mapped_column(ForeignKey("goods_receipts.id"), index=True)
    po_line_id: Mapped[int] = mapped_column(ForeignKey("purchase_order_lines.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)
    unit_cost: Mapped[Decimal] = mapped_column(Cost)  # net of discount, excluding recoverable GST


class Payment(Base):
    """Money paid to a vendor or received from a customer. Outstanding balances = value delivered - payments."""
    __tablename__ = "payments"
    __table_args__ = (UniqueConstraint("org_id", "number"), CheckConstraint("amount > 0"),
                      Index("ix_payments_party", "org_id", "party_type", "party_id"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    party_type: Mapped[str] = mapped_column(String(10))  # vendor | customer
    party_id: Mapped[int] = mapped_column(Integer)
    order_type: Mapped[str | None] = mapped_column(String(5))  # PO | SO
    order_id: Mapped[int | None] = mapped_column(Integer)
    amount: Mapped[Decimal] = mapped_column(Money)
    paid_on: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String(20), default="bank_transfer")
    reference: Mapped[str | None] = mapped_column(String(80))
    notes: Mapped[str | None] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(10), default="posted")  # posted | void
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class SalesOrder(Base):
    __tablename__ = "sales_orders"
    __table_args__ = (UniqueConstraint("org_id", "number"), Index("ix_so_org_status", "org_id", "status"),
                      CheckConstraint("shipping_charge >= 0"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))  # default fulfilment warehouse
    status: Mapped[str] = mapped_column(String(12), default="draft")  # draft|confirmed|packed|shipped|delivered|cancelled
    order_date: Mapped[date] = mapped_column(Date)
    expected_date: Mapped[date | None] = mapped_column(Date)
    reference: Mapped[str | None] = mapped_column(String(60))
    notes: Mapped[str | None] = mapped_column(String(500))
    bill_to: Mapped[str | None] = mapped_column(String(400))
    ship_to: Mapped[str | None] = mapped_column(String(400))
    gst_mode: Mapped[str] = mapped_column(String(5), default="intra")
    subtotal: Mapped[Decimal] = mapped_column(Money, default=0)
    discount_total: Mapped[Decimal] = mapped_column(Money, default=0)
    taxable_total: Mapped[Decimal] = mapped_column(Money, default=0)
    cgst: Mapped[Decimal] = mapped_column(Money, default=0)
    sgst: Mapped[Decimal] = mapped_column(Money, default=0)
    igst: Mapped[Decimal] = mapped_column(Money, default=0)
    shipping_charge: Mapped[Decimal] = mapped_column(Money, default=0)
    total: Mapped[Decimal] = mapped_column(Money, default=0)
    credit_override: Mapped[bool] = mapped_column(Boolean, default=False)
    payment_method: Mapped[str | None] = mapped_column(String(15))  # portal orders: cod | bank_transfer | on_account
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)
    customer = relationship("Customer")
    lines = relationship("SalesOrderLine", cascade="all, delete-orphan", order_by="SalesOrderLine.id")


class SalesOrderLine(Base):
    __tablename__ = "sales_order_lines"
    __table_args__ = (CheckConstraint(
        "quantity > 0 AND qty_packed >= 0 AND qty_shipped >= 0 AND qty_delivered >= 0 AND qty_delivered <= qty_shipped "
        "AND qty_shipped <= qty_packed AND qty_packed <= quantity AND rate >= 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    so_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))  # stock is reserved here
    quantity: Mapped[Decimal] = mapped_column(Qty)
    qty_packed: Mapped[Decimal] = mapped_column(Qty, default=0)
    qty_shipped: Mapped[Decimal] = mapped_column(Qty, default=0)
    qty_delivered: Mapped[Decimal] = mapped_column(Qty, default=0)
    rate: Mapped[Decimal] = mapped_column(Money)
    discount_pct: Mapped[Decimal] = mapped_column(Pct, default=0)
    tax_rate: Mapped[Decimal] = mapped_column(Pct, default=0)
    discount_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    taxable: Mapped[Decimal] = mapped_column(Money, default=0)
    tax_amount: Mapped[Decimal] = mapped_column(Money, default=0)
    amount: Mapped[Decimal] = mapped_column(Money, default=0)
    product = relationship("Product")

class Package(Base):
    """Goods picked and packed for (part of) a sales order, from a single warehouse. Packing moves no stock."""
    __tablename__ = "packages"
    __table_args__ = (UniqueConstraint("org_id", "number"), UniqueConstraint("org_id", "client_key"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    so_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id"), index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"))
    status: Mapped[str] = mapped_column(String(10), default="packed")  # packed | shipped | delivered | void
    weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    notes: Mapped[str | None] = mapped_column(String(300))
    client_key: Mapped[str | None] = mapped_column(String(80))
    packed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    lines = relationship("PackageLine", cascade="all, delete-orphan", order_by="PackageLine.id")
    shipment = relationship("Shipment", uselist=False, back_populates="package")


class PackageLine(Base):
    __tablename__ = "package_lines"
    __table_args__ = (CheckConstraint("quantity > 0"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    package_id: Mapped[int] = mapped_column(ForeignKey("packages.id"), index=True)
    so_line_id: Mapped[int] = mapped_column(ForeignKey("sales_order_lines.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)


class Shipment(Base):
    __tablename__ = "shipments"
    __table_args__ = (UniqueConstraint("org_id", "number"), UniqueConstraint("package_id"), Index("ix_shp_org_status", "org_id", "status"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    package_id: Mapped[int] = mapped_column(ForeignKey("packages.id"))
    so_id: Mapped[int] = mapped_column(ForeignKey("sales_orders.id"), index=True)
    carrier: Mapped[str] = mapped_column(String(80))
    tracking_number: Mapped[str | None] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20), default="ready_to_ship")
    shipping_date: Mapped[date | None] = mapped_column(Date)
    expected_delivery: Mapped[date | None] = mapped_column(Date)
    ship_to: Mapped[str | None] = mapped_column(String(400))
    tracking_mode: Mapped[str] = mapped_column(String(10), default="manual")  # manual (simulated) | carrier
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_to: Mapped[str | None] = mapped_column(String(120))
    failure_reason: Mapped[str | None] = mapped_column(String(200))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    package = relationship("Package", back_populates="shipment")
    events = relationship("ShipmentEvent", cascade="all, delete-orphan", order_by="ShipmentEvent.id")


class ShipmentEvent(Base):
    __tablename__ = "shipment_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    shipment_id: Mapped[int] = mapped_column(ForeignKey("shipments.id"), index=True)
    status: Mapped[str] = mapped_column(String(20))
    note: Mapped[str | None] = mapped_column(String(300))
    location: Mapped[str | None] = mapped_column(String(120))
    source: Mapped[str] = mapped_column(String(10), default="manual")  # manual | simulated | carrier
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

class InventoryAdjustment(Base):
    """A posted, immutable stock adjustment document. Each line is backed by an auditable ledger movement."""
    __tablename__ = "inventory_adjustments"
    __table_args__ = (UniqueConstraint("org_id", "number"), UniqueConstraint("org_id", "client_key"))
    id: Mapped[int] = mapped_column(primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    number: Mapped[str] = mapped_column(String(20))
    adj_type: Mapped[str] = mapped_column(String(12))  # increase | decrease | damage | missing | correction
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("warehouses.id"), index=True)
    adj_date: Mapped[date] = mapped_column(Date)
    reason: Mapped[str] = mapped_column(String(300))
    notes: Mapped[str | None] = mapped_column(String(500))
    client_key: Mapped[str | None] = mapped_column(String(80))
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    lines = relationship("InventoryAdjustmentLine", cascade="all, delete-orphan", order_by="InventoryAdjustmentLine.id")


class InventoryAdjustmentLine(Base):
    __tablename__ = "inventory_adjustment_lines"
    id: Mapped[int] = mapped_column(primary_key=True)
    adjustment_id: Mapped[int] = mapped_column(ForeignKey("inventory_adjustments.id"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty)  # units adjusted (for a correction: the counted quantity)
    qty_before: Mapped[Decimal] = mapped_column(Qty)
    qty_delta: Mapped[Decimal] = mapped_column(Qty)
    unit_cost: Mapped[Decimal | None] = mapped_column(Cost)
    movement_id: Mapped[int | None] = mapped_column(ForeignKey("stock_movements.id"))