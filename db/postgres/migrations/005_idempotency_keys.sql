-- RRE Tally: same as SQLite migration 022_idempotency_keys. A financial request repeated with the same Idempotency-Key (double click,
-- network retry) returns the first result instead of posting twice. Per company, with row level security like every other table.
SET search_path = rre;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  company_no text NOT NULL DEFAULT current_setting('rre.company_id'),
  scope_key text COLLATE "C" NOT NULL,
  result text COLLATE "C" NOT NULL,
  created_at text COLLATE "C" DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by text DEFAULT nullif(current_setting('rre.user_id', true), ''),
  PRIMARY KEY (company_no, scope_key)
);
CREATE TRIGGER trg_idempotency_keys_touch BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION rre_touch();

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO rre_app;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY company_isolation ON idempotency_keys TO rre_app USING (company_no = rre.current_company()) WITH CHECK (company_no = rre.current_company());
