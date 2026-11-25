-- RRE Tally: the list of companies in this database. Row level security hides every business row until a company is chosen, so the
-- server keeps the list of company numbers here (no business data: number, name, kind, when it was created).
CREATE TABLE IF NOT EXISTS rre_meta.companies (
  company_no text PRIMARY KEY,
  name text,
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'customer')),  -- 'customer' = a self-registered customer's own books (U<id>)
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT USAGE ON SCHEMA rre_meta TO rre_app;
GRANT SELECT, INSERT, UPDATE ON rre_meta.companies TO rre_app;
GRANT SELECT ON rre_meta.schema_versions TO rre_app;
