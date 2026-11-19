ALTER TABLE question ADD COLUMN IF NOT EXISTS portable_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS question_portable_bank_idx ON question(bank_id,portable_id);
ALTER TABLE question ADD COLUMN IF NOT EXISTS package_source jsonb;
ALTER TABLE file_asset ADD COLUMN IF NOT EXISTS package_source jsonb;
CREATE TABLE IF NOT EXISTS bank_package_upload (
 id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_account(id), bank_id uuid NOT NULL REFERENCES question_bank(id),
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 268435456), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS bank_package_part (
 upload_id uuid NOT NULL REFERENCES bank_package_upload(id) ON DELETE CASCADE,
 part_number integer NOT NULL, bytes bytea NOT NULL, PRIMARY KEY(upload_id,part_number)
);
CREATE INDEX IF NOT EXISTS bank_package_upload_expiry ON bank_package_upload(expires_at);
ALTER TABLE bank_package_upload ADD COLUMN IF NOT EXISTS preview_hash text;
CREATE TABLE IF NOT EXISTS bank_agent_grant (
 id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_account(id), session_id uuid NOT NULL,
 client_id text NOT NULL, redirect_uri text NOT NULL, resource text NOT NULL, scope text NOT NULL,
 challenge text NOT NULL, code_hash bytea UNIQUE, token_hash bytea UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS bank_agent_client (
 id uuid PRIMARY KEY, name text NOT NULL, redirects jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bank_agent_transfer (
 token_hash bytea PRIMARY KEY, grant_id uuid NOT NULL REFERENCES bank_agent_grant(id),
 bank_id uuid NOT NULL REFERENCES question_bank(id), purpose text NOT NULL, upload_id uuid, expires_at timestamptz NOT NULL
);
ALTER TABLE question ADD COLUMN IF NOT EXISTS retired_from_group uuid REFERENCES question(id)
 CHECK (retired_from_group IS NULL OR (status='INACTIVE' AND reading_parent_id IS NULL AND NOT is_group));
CREATE OR REPLACE VIEW bank_question AS SELECT * FROM question WHERE retired_from_group IS NULL;
