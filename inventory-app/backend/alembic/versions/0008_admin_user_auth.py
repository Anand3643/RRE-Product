"""admin/user auth: profile fields, per-user permissions, lockout, password resets

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa


revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('users') as b:
        b.add_column(sa.Column('phone', sa.String(length=30), nullable=True))
        b.add_column(sa.Column('department', sa.String(length=80), nullable=True))
        b.add_column(sa.Column('permissions', sa.JSON(), nullable=True))
        b.add_column(sa.Column('must_change_password', sa.Boolean(), nullable=False, server_default=sa.false()))
        b.add_column(sa.Column('failed_logins', sa.Integer(), nullable=False, server_default='0'))
        b.add_column(sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True))
        b.add_column(sa.Column('tokens_valid_after', sa.DateTime(timezone=True), nullable=True))
        b.add_column(sa.Column('reset_requested_at', sa.DateTime(timezone=True), nullable=True))
        b.add_column(sa.Column('created_by', sa.Integer(), nullable=True))
    op.create_table('password_resets',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_by', sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'))
    op.create_index('ix_password_resets_user_id', 'password_resets', ['user_id'])


def downgrade():
    op.drop_index('ix_password_resets_user_id', table_name='password_resets')
    op.drop_table('password_resets')
    with op.batch_alter_table('users') as b:
        for c in ('created_by', 'reset_requested_at', 'tokens_valid_after', 'locked_until', 'failed_logins',
                  'must_change_password', 'permissions', 'department', 'phone'):
            b.drop_column(c)
