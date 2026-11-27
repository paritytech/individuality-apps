-- Views over every stored game. store.py replaces {root}. Files: {root}/<network>/g<N>/<dataset>.parquet.
CREATE OR REPLACE MACRO as_num(x) AS TRY_CAST(x AS DOUBLE);
CREATE OR REPLACE MACRO as_bool(x) AS CASE lower(CAST(x AS VARCHAR)) WHEN 'true' THEN true WHEN 'false' THEN false ELSE NULL END;
CREATE OR REPLACE MACRO as_ts(x) AS TRY_CAST(x AS TIMESTAMPTZ);

-- view spans
CREATE OR REPLACE VIEW spans AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/spans.parquet', union_by_name = true, filename = true);

-- view errors
CREATE OR REPLACE VIEW errors AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/errors.parquet', union_by_name = true, filename = true);

-- view transactions
CREATE OR REPLACE VIEW transactions AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/transactions.parquet', union_by_name = true, filename = true);

-- view tracemetrics
CREATE OR REPLACE VIEW tracemetrics AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/tracemetrics.parquet', union_by_name = true, filename = true);

-- view logs
CREATE OR REPLACE VIEW logs AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/logs.parquet', union_by_name = true, filename = true);

-- view events_json
CREATE OR REPLACE VIEW events_json AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/events_json.parquet', union_by_name = true, filename = true);

-- view attachments
CREATE OR REPLACE VIEW attachments AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/attachments.parquet', union_by_name = true, filename = true);

-- view context_usernames
CREATE OR REPLACE VIEW context_usernames AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/context_usernames.parquet', union_by_name = true, filename = true);

-- view context_releases
CREATE OR REPLACE VIEW context_releases AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_parquet('{root}/*/g*/context_releases.parquet', union_by_name = true, filename = true);

-- view chain
CREATE OR REPLACE VIEW chain AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_json_auto('{root}/*/g*/chain.json', union_by_name = true, filename = true);

-- view manifests
CREATE OR REPLACE VIEW manifests AS
SELECT regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 1) AS _network,
       CAST(regexp_extract(filename, '([^/]+)/g([0-9]+)/[^/]+$', 2) AS INTEGER) AS _game,
       * EXCLUDE (filename)
FROM read_json_auto('{root}/*/g*/manifest.json', union_by_name = true, filename = true);

-- view accounts
CREATE OR REPLACE VIEW accounts AS
SELECT _network, _game, unnest(accounts, recursive := true) FROM chain;
