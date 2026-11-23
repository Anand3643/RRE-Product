"""sales_orders.payment_method (how a portal customer chose to pay)

Revision ID: 0011
Revises: 0010
"""
from alembic import op
import sqlalchemy as sa


revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('sales_orders') as b:
        b.add_column(sa.Column('payment_method', sa.String(length=15), nullable=True))


def downgrade():
    with op.batch_alter_table('sales_orders') as b:
        b.drop_column('payment_method')
