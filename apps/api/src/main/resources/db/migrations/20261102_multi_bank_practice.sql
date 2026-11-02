BEGIN;
CREATE OR REPLACE FUNCTION validate_practice_item_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF (OLD.session_id,OLD.question_id,OLD.revision_id,OLD.material_revision_id,OLD.position) IS DISTINCT FROM
     (NEW.session_id,NEW.question_id,NEW.revision_id,NEW.material_revision_id,NEW.position)
  THEN RAISE EXCEPTION 'Issued question references are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM question q JOIN question_bank b ON b.id=q.bank_id
   JOIN practice_session s ON true JOIN question_bank primary_bank ON primary_bank.id=s.bank_id
   WHERE b.subject_id=primary_bank.subject_id
   AND (q.bank_id=s.bank_id OR coalesce(s.configuration_snapshot::jsonb->'questionBankIds','[]'::jsonb) ? q.bank_id::text)
   AND q.id=NEW.question_id AND s.id=NEW.session_id AND NOT q.is_group
   AND ((q.reading_parent_id IS NULL AND NEW.material_revision_id IS NULL)
     OR EXISTS(SELECT 1 FROM question_revision r WHERE r.id=NEW.material_revision_id AND r.question_id=q.reading_parent_id AND r.type='READING')))
 THEN RAISE EXCEPTION 'Practice item content does not match its bank or material' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
COMMIT;
