-- RRE Tally: same as SQLite migration 023. Indexes for the lookups done on every party ledger, outstanding and group report.
SET search_path = rre;
CREATE INDEX IF NOT EXISTS idx_vouchers_party ON vouchers (company_no, party_ledger_id, date);
CREATE INDEX IF NOT EXISTS idx_ledgers_group ON ledgers (company_no, group_id);
