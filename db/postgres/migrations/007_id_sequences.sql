-- RRE Tally: new row ids come from a SEQUENCE per table instead of a per-company counter row.
-- Why: with postings now running at the same time (core/tx.js, { concurrent: true }), every insert updated the SAME counter row
-- (company, table), so every posting had to wait for the previous one to finish (or collided with it). A sequence hands out ids
-- without any lock or conflict. Ids stay unique and increasing within every company (the key is (company_no, id)); they are no longer consecutive per company
-- (one sequence per table serves all companies, and a rolled-back posting leaves a gap). Voucher NUMBERS (voucher_no) are not ids and are
-- unchanged. Rows inserted with an explicit id (copy / restore of a company) move the sequence past that id.
SET search_path = rre;

DO $$ DECLARE t record; seq text; start bigint; BEGIN
  FOR t IN SELECT c.relname AS tbl FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'rre' AND tg.tgname = 'trg_' || c.relname || '_id' LOOP
    seq := t.tbl || '_id_seq';
    EXECUTE format('CREATE SEQUENCE IF NOT EXISTS rre.%I', seq);
    -- continue above every id ever handed out in any company (the counters saw every id, including explicit ones)
    SELECT COALESCE(MAX(last_id), 0) INTO start FROM rre_meta.id_counters WHERE tbl = t.tbl;
    IF start > 0 THEN EXECUTE format('SELECT setval(%L, %s, true)', 'rre.' || seq, start); END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION rre_assign_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seq regclass := format('rre.%I', TG_TABLE_NAME || '_id_seq')::regclass; cur bigint;
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := nextval(seq);
  ELSE
    -- an explicit id (copy / restore): make sure the sequence never hands it out again
    -- the highest id already handed out (a sequence that was never used reports last_value 1 with is_called false: nothing used yet)
    EXECUTE format('SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM %s', seq) INTO cur;
    IF NEW.id > cur THEN PERFORM setval(seq, NEW.id, true); END IF;
  END IF;
  RETURN NEW;
END $$;

GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA rre TO rre_app;
