CREATE TABLE IF NOT EXISTS compatibility_usage (
 release text NOT NULL, day date NOT NULL, item text NOT NULL,
 hits bigint NOT NULL, last_seen timestamptz NOT NULL,
 PRIMARY KEY (release,day,item)
);
CREATE TABLE IF NOT EXISTS compatibility_coverage (
 release text NOT NULL, day date NOT NULL, observed tstzmultirange NOT NULL,
 PRIMARY KEY (release,day)
);
CREATE OR REPLACE VIEW compatibility_inventory AS
 WITH historical AS (
    SELECT revision_id AS id FROM practice_item
    UNION SELECT material_revision_id FROM practice_item WHERE material_revision_id IS NOT NULL
 )
 SELECT count(*) FILTER (WHERE NOT (r.content_data::jsonb ? 'contentFormat')) AS legacy_revisions,
        count(h.id) FILTER (WHERE NOT (r.content_data::jsonb ? 'contentFormat')) AS referenced_revisions,
        count(h.id) AS practice_revisions
 FROM question_revision r LEFT JOIN historical h ON h.id=r.id;
GRANT SELECT ON compatibility_usage, compatibility_coverage, compatibility_inventory TO qanda_monitor;
CREATE TABLE IF NOT EXISTS compatibility_release (
 release text PRIMARY KEY, first_seen timestamptz NOT NULL DEFAULT now(), manifest text NOT NULL
);
GRANT SELECT ON compatibility_release TO qanda_monitor;
