-- RRE Tally: same as SQLite migration 024. A version number on every record people edit, raised by every change, so a save made
-- from an older copy (another device changed the record in the meantime) is refused instead of silently overwriting it.
-- Used by core/rowVersion.js (If-Match style check on PUT / PATCH / DELETE).
SET search_path = rre;

CREATE OR REPLACE FUNCTION rre_bump_row_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.row_version IS NOT DISTINCT FROM OLD.row_version THEN NEW.row_version := OLD.row_version + 1; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['stock_items', 'stock_groups', 'units_of_measure', 'godowns', 'ledgers', 'inv_orders', 'quotations'] LOOP
    EXECUTE format('ALTER TABLE rre.%I ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_row_version ON rre.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_row_version BEFORE UPDATE ON rre.%I FOR EACH ROW EXECUTE FUNCTION rre_bump_row_version()', t, t);
  END LOOP;
END $$;
