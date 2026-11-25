-- RRE Tally: the SQLite functions the application's queries use, as real PostgreSQL functions with the same results,
-- so each query keeps its meaning without being rewritten. Dates are text 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' in UTC, as in SQLite.
SET search_path = rre;

-- case-insensitive comparisons (SQLite COLLATE NOCASE)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid = c.collnamespace WHERE n.nspname = 'rre' AND c.collname = 'nocase') THEN
    CREATE COLLATION rre.nocase (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
  END IF;
END $$;

-- applies SQLite date modifiers: 'now', '+N days|hours|minutes|seconds|months|years', 'start of day|month|year', 'localtime', 'utc'
CREATE OR REPLACE FUNCTION rre.sqlite_ts(v text, mods text[] DEFAULT '{}') RETURNS timestamp LANGUAGE plpgsql STABLE AS $$
DECLARE t timestamp; m text; k numeric; u text; parts text[];
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  IF lower(v) = 'now' THEN t := timezone('utc', now())::timestamp(0);
  ELSIF v ~ '^-?\d+(\.\d+)?$' THEN t := timestamp '4714-11-24 12:00:00 BC' + (v::numeric * interval '1 day'); -- a Julian day number
  ELSE BEGIN t := v::timestamp; EXCEPTION WHEN others THEN RETURN NULL; END;
  END IF;
  FOREACH m IN ARRAY coalesce(mods, '{}') LOOP
    m := lower(trim(m));
    IF m IS NULL OR m = '' OR m = 'utc' OR m = 'localtime' THEN CONTINUE; END IF;
    IF m = 'start of day' THEN t := date_trunc('day', t);
    ELSIF m = 'start of month' THEN t := date_trunc('month', t);
    ELSIF m = 'start of year' THEN t := date_trunc('year', t);
    ELSE
      parts := regexp_match(m, '^([+-]?\d+(?:\.\d+)?)\s+(day|hour|minute|second|month|year)s?$');
      IF parts IS NULL THEN RETURN NULL; END IF;
      k := parts[1]::numeric; u := parts[2];
      t := t + (k || ' ' || u)::interval;
    END IF;
  END LOOP;
  RETURN t;
END $$;

CREATE OR REPLACE FUNCTION rre.datetime(v text, VARIADIC mods text[] DEFAULT '{}') RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(rre.sqlite_ts(v, mods), 'YYYY-MM-DD HH24:MI:SS') $$;
CREATE OR REPLACE FUNCTION rre.date(v text, VARIADIC mods text[] DEFAULT '{}') RETURNS text LANGUAGE sql STABLE AS $$ SELECT to_char(rre.sqlite_ts(v, mods), 'YYYY-MM-DD') $$;
CREATE OR REPLACE FUNCTION rre.julianday(v text, VARIADIC mods text[] DEFAULT '{}') RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT extract(epoch FROM rre.sqlite_ts(v, mods) - timestamp '4714-11-24 12:00:00 BC')::double precision / 86400 $$;

-- ROUND on a double precision value (SQLite has one round for every number type)
CREATE OR REPLACE FUNCTION rre.round(v double precision, d integer DEFAULT 0) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT round(v::numeric, d) $$;
-- printf('%0Nd', n) as used by the data migrations
CREATE OR REPLACE FUNCTION rre.printf(fmt text, n bigint) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE w int; BEGIN
  IF fmt ~ '^%0\d+d$' THEN w := substring(fmt FROM 3 FOR length(fmt) - 3)::int; RETURN lpad(n::text, w, '0'); END IF;
  IF fmt = '%d' THEN RETURN n::text; END IF;
  RAISE EXCEPTION 'printf format % is not supported', fmt;
END $$;
CREATE OR REPLACE FUNCTION rre.ifnull(a anycompatible, b anycompatible) RETURNS anycompatible LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(a, b) $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rre TO rre_app;
GRANT USAGE ON SCHEMA rre TO rre_app;
