-- RRE Tally: database-level security (row level security). Written by hand; applied after 001_core_schema.sql.
--
-- Who connects:  the RRE server only. It logs in with the database credentials from its private .env and, on every connection,
--                switches to the restricted role rre_app (SET ROLE rre_app). rre_app owns nothing and cannot bypass RLS.
-- Per request:   the server sets  rre.company_id  (the company the signed-in person works in),
--                and rre.user_id  (for the _created_by audit column).
-- Isolation:     every table: a row is visible / insertable / changeable only when its company_no equals rre.company_id.
--                With no company set, nothing at all is visible (fail closed).
--                Customer-level isolation inside a company: see the end of this file.
-- Not exposed:   the anon / authenticated roles of Supabase's web API get no access to schema rre at all.
SET search_path = rre;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rre_app') THEN CREATE ROLE rre_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB; END IF;
END $$;
GRANT rre_app TO CURRENT_USER;

GRANT USAGE ON SCHEMA rre TO rre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA rre TO rre_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA rre TO rre_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rre TO rre_app;
-- per-company id counters used by the insert triggers (no business data)
GRANT USAGE ON SCHEMA rre_meta TO rre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rre_meta.id_counters TO rre_app;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE 'REVOKE ALL ON SCHEMA rre FROM anon'; EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA rre FROM anon'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE 'REVOKE ALL ON SCHEMA rre FROM authenticated'; EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA rre FROM authenticated'; END IF;
END $$;
REVOKE ALL ON SCHEMA rre FROM PUBLIC;

-- The company the current connection works in (NULL when none is set: then every policy below is false).
CREATE OR REPLACE FUNCTION rre.current_company() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('rre.company_id', true), '') $$;

-- Company isolation on every table.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'rre' LOOP
    EXECUTE format('ALTER TABLE rre.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE rre.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON rre.%I', t.tablename);
    EXECUTE format('CREATE POLICY company_isolation ON rre.%I TO rre_app USING (company_no = rre.current_company()) WITH CHECK (company_no = rre.current_company())', t.tablename);
  END LOOP;
END $$;

-- Customer-level isolation (a customer-portal login sees only its own orders, invoices and quotations) is enforced by the server:
-- core/portal.js takes the customer account from the database, never from the browser, and filters every query by it (test_portal.js).
-- It is deliberately NOT a database policy here: the server's own work inside a customer request (the next order number, stock,
-- prices) must see the whole company, and a party filter at this level returned wrong numbers (duplicate SO-00001) in testing.
