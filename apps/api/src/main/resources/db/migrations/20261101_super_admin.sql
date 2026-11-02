BEGIN;

ALTER TABLE admin_account DROP CONSTRAINT IF EXISTS admin_account_role_check;
UPDATE admin_account
SET role = 'SUPER_ADMIN', version = version + 1, updated_at = now()
WHERE role IN ('PLATFORM_ADMIN', 'CONTENT_ADMIN');
ALTER TABLE admin_account
    ADD CONSTRAINT admin_account_role_check CHECK (role = 'SUPER_ADMIN');

COMMIT;
