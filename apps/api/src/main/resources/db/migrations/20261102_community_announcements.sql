BEGIN;
CREATE TABLE IF NOT EXISTS community_group (
 id integer PRIMARY KEY CHECK(id=1), image bytea, expires_at timestamptz,
 version bigint NOT NULL DEFAULT 1 CHECK(version>0), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((image IS NULL) = (expires_at IS NULL))
);
INSERT INTO community_group(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
ALTER TABLE announcement ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE announcement ADD COLUMN IF NOT EXISTS show_community_group boolean NOT NULL DEFAULT false;
DROP INDEX IF EXISTS announcement_display_idx;
CREATE INDEX announcement_display_idx ON announcement(pinned DESC,updated_at DESC,id);
COMMIT;
