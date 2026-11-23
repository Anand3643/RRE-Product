"""portal accounts: users.customer_id and support_tickets

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa


revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users') as b:
        b.add_column(sa.Column('customer_id', sa.Integer(), nullable=True))
        b.create_foreign_key('fk_users_customer_id', 'customers', ['customer_id'], ['id'])
        b.create_index('ix_users_customer_id', ['customer_id'])
    op.create_table('support_tickets',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('subject', sa.String(length=200), nullable=False),
        sa.Column('message', sa.String(length=2000), nullable=False),
        sa.Column('status', sa.String(length=10), nullable=False),
        sa.Column('reply', sa.String(length=2000), nullable=True),
        sa.Column('replied_by', sa.Integer(), nullable=True),
        sa.Column('replied_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'))
    op.create_index('ix_support_tickets_org_id', 'support_tickets', ['org_id'])
    op.create_index('ix_support_tickets_user_id', 'support_tickets', ['user_id'])


def downgrade():
    op.drop_table('support_tickets')
    with op.batch_alter_table('users') as b:
        b.drop_index('ix_users_customer_id')
        b.drop_constraint('fk_users_customer_id', type_='foreignkey')
        b.drop_column('customer_id')
