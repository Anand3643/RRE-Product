-- RRE Tally: same as SQLite migration 025. Vouchers can be altered (PUT /api/vouchers/:id); they get the version number that other
-- edited records already have (008), so an alteration made from an older copy is refused (409) instead of overwriting a newer one.
SET search_path = rre;
ALTER TABLE rre.vouchers ADD COLUMN IF NOT EXISTS row_version bigint NOT NULL DEFAULT 1;
DROP TRIGGER IF EXISTS trg_vouchers_row_version ON rre.vouchers;
CREATE TRIGGER trg_vouchers_row_version BEFORE UPDATE ON rre.vouchers FOR EACH ROW EXECUTE FUNCTION rre_bump_row_version();
