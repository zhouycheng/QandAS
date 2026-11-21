ALTER TABLE question_bank ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE OR REPLACE VIEW visible_question_bank AS
 SELECT b.* FROM question_bank b JOIN subject s ON s.id=b.subject_id
 WHERE b.deleted_at IS NULL AND b.status='ACTIVE' AND b.publication_status='PUBLISHED' AND s.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM active_question q WHERE q.bank_id=b.id AND NOT q.is_group);

ALTER TABLE practice_session ADD COLUMN IF NOT EXISTS bank_name varchar(120);

CREATE OR REPLACE FUNCTION pin_practice_bank_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT name INTO STRICT NEW.bank_name FROM question_bank WHERE id=NEW.bank_id;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER practice_bank_name BEFORE INSERT ON practice_session
 FOR EACH ROW EXECUTE FUNCTION pin_practice_bank_name();

UPDATE practice_session s SET bank_name=b.name FROM question_bank b
 WHERE s.bank_id=b.id AND s.bank_name IS NULL;
ALTER TABLE practice_session ALTER COLUMN bank_name SET NOT NULL;

ALTER TABLE practice_item ADD COLUMN IF NOT EXISTS issued_chapter_id uuid,
 ADD COLUMN IF NOT EXISTS issued_status varchar(12), ADD COLUMN IF NOT EXISTS issued_version bigint;
-- 兼容滚动升级期间仍按旧格式发放的练习。
CREATE OR REPLACE FUNCTION pin_legacy_practice_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 SELECT chapter_id,status,version INTO STRICT NEW.issued_chapter_id,NEW.issued_status,NEW.issued_version
 FROM question WHERE id=NEW.question_id;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER practice_item_snapshot BEFORE INSERT ON practice_item
 FOR EACH ROW WHEN (NEW.issued_version IS NULL) EXECUTE FUNCTION pin_legacy_practice_item();

UPDATE practice_item i SET issued_chapter_id=q.chapter_id, issued_status=q.status, issued_version=q.version
 FROM question q WHERE q.id=i.question_id AND i.issued_version IS NULL;
ALTER TABLE practice_item ALTER COLUMN issued_version SET NOT NULL, ALTER COLUMN issued_status SET NOT NULL;
