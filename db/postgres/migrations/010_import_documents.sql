-- RRE Tally: same as SQLite migration 026. Documents uploaded for import (PDF / Excel / CSV / images): the original file, what was read
-- from it, the preview settings and the import result - the Import History. Per company, with row level security like every table.
SET search_path = rre;

CREATE SEQUENCE IF NOT EXISTS rre.import_documents_id_seq;
CREATE TABLE IF NOT EXISTS import_documents (
  company_no text NOT NULL DEFAULT current_setting('rre.company_id'),
  id bigint NOT NULL,
  file_name text COLLATE "C" NOT NULL,
  mime text COLLATE "C",
  kind text COLLATE "C",
  size bigint DEFAULT 0,
  sha256 text COLLATE "C" NOT NULL,
  category text COLLATE "C",
  status text COLLATE "C" NOT NULL DEFAULT 'uploaded',
  detected bigint DEFAULT 0,
  imported bigint DEFAULT 0,
  rejected bigint DEFAULT 0,
  extraction text COLLATE "C",
  settings text COLLATE "C",
  result text COLLATE "C",
  error text COLLATE "C",
  uploaded_by text COLLATE "C",
  uploaded_at text COLLATE "C" DEFAULT to_char(timezone('utc', now()), 'YYYY-MM-DD HH24:MI:SS'),
  imported_by text COLLATE "C",
  imported_at text COLLATE "C",
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by text DEFAULT nullif(current_setting('rre.user_id', true), ''),
  PRIMARY KEY (company_no, id)
);
CREATE INDEX IF NOT EXISTS idx_import_documents_sha ON import_documents (company_no, sha256);
CREATE TABLE IF NOT EXISTS import_document_data (
  company_no text NOT NULL DEFAULT current_setting('rre.company_id'),
  document_id bigint NOT NULL,
  data bytea NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by text DEFAULT nullif(current_setting('rre.user_id', true), ''),
  PRIMARY KEY (company_no, document_id),
  FOREIGN KEY (company_no, document_id) REFERENCES import_documents (company_no, id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);

DROP TRIGGER IF EXISTS trg_import_documents_id ON import_documents;
CREATE TRIGGER trg_import_documents_id BEFORE INSERT ON import_documents FOR EACH ROW EXECUTE FUNCTION rre_assign_id();
DROP TRIGGER IF EXISTS trg_import_documents_touch ON import_documents;
CREATE TRIGGER trg_import_documents_touch BEFORE UPDATE ON import_documents FOR EACH ROW EXECUTE FUNCTION rre_touch();
DROP TRIGGER IF EXISTS trg_import_document_data_touch ON import_document_data;
CREATE TRIGGER trg_import_document_data_touch BEFORE UPDATE ON import_document_data FOR EACH ROW EXECUTE FUNCTION rre_touch();

GRANT SELECT, INSERT, UPDATE, DELETE ON import_documents, import_document_data TO rre_app;
GRANT USAGE, SELECT, UPDATE ON rre.import_documents_id_seq TO rre_app;
ALTER TABLE import_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_documents FORCE ROW LEVEL SECURITY;
ALTER TABLE import_document_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_document_data FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON import_documents;
CREATE POLICY company_isolation ON import_documents TO rre_app USING (company_no = rre.current_company()) WITH CHECK (company_no = rre.current_company());
DROP POLICY IF EXISTS company_isolation ON import_document_data;
CREATE POLICY company_isolation ON import_document_data TO rre_app USING (company_no = rre.current_company()) WITH CHECK (company_no = rre.current_company());
