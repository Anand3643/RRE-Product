"""login monitoring: user_sessions and login_audit_logs

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa


revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table('user_sessions',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('session_id_hash', sa.String(length=64), nullable=False),
        sa.Column('login_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_activity_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('logout_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ip_address', sa.String(length=45), nullable=True),
        sa.Column('device_type', sa.String(length=12), nullable=False),
        sa.Column('browser', sa.String(length=40), nullable=False),
        sa.Column('os', sa.String(length=30), nullable=False),
        sa.Column('session_status', sa.String(length=12), nullable=False),
        sa.Column('end_reason', sa.String(length=40), nullable=True),
        sa.Column('terminated_by', sa.Integer(), nullable=True),
        sa.Column('suspicious', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('suspicious_reason', sa.String(length=200), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('session_id_hash'))
    op.create_index('ix_user_sessions_user_id', 'user_sessions', ['user_id'])
    op.create_index('ix_user_sessions_user_login', 'user_sessions', ['user_id', 'login_at'])
    op.create_index('ix_user_sessions_org_login', 'user_sessions', ['org_id', 'login_at'])
    op.create_table('login_audit_logs',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('org_id', sa.Integer(), nullable=True),
        sa.Column('user_id', sa.Integer(), nullable=True),
        sa.Column('email_attempted', sa.String(length=255), nullable=False),
        sa.Column('event_type', sa.String(length=24), nullable=False),
        sa.Column('event_timestamp', sa.DateTime(timezone=True), nullable=False),
        sa.Column('ip_address', sa.String(length=45), nullable=True),
        sa.Column('device_information', sa.String(length=160), nullable=True),
        sa.Column('failure_category', sa.String(length=24), nullable=True),
        sa.Column('session_id', sa.Integer(), nullable=True),
        sa.Column('detail', sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(['org_id'], ['organizations.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.ForeignKeyConstraint(['session_id'], ['user_sessions.id']),
        sa.PrimaryKeyConstraint('id'))
    op.create_index('ix_login_audit_logs_user_id', 'login_audit_logs', ['user_id'])
    op.create_index('ix_login_audit_logs_email_attempted', 'login_audit_logs', ['email_attempted'])
    op.create_index('ix_login_audit_logs_event_timestamp', 'login_audit_logs', ['event_timestamp'])
    op.create_index('ix_login_audit_org_ts', 'login_audit_logs', ['org_id', 'event_timestamp'])


def downgrade():
    op.drop_table('login_audit_logs')
    op.drop_table('user_sessions')
