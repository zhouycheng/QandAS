ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS writer_epoch bigint NOT NULL DEFAULT 1 CHECK(writer_epoch>0);
ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS writer_sealed boolean NOT NULL DEFAULT false;
ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS takeover_id uuid;
ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS takeover_device_id uuid;
ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS takeover_expires_at timestamptz;
ALTER TABLE practice_sync_state ADD COLUMN IF NOT EXISTS takeover_state varchar(8) CHECK(takeover_state IN ('WAITING','READY','EXPIRED'));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='practice_sync_state'::regclass AND conname='practice_takeover_complete') THEN
  ALTER TABLE practice_sync_state ADD CONSTRAINT practice_takeover_complete CHECK(num_nonnulls(takeover_id,takeover_device_id,takeover_expires_at,takeover_state) IN (0,4));
 END IF;
END $$;
