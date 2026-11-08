CREATE VIEW visible_question_bank AS
SELECT b.* FROM question_bank b JOIN subject s ON s.id=b.subject_id
WHERE b.status='ACTIVE' AND b.publication_status='PUBLISHED' AND s.status='ACTIVE'
AND EXISTS(SELECT 1 FROM active_question q WHERE q.bank_id=b.id AND NOT q.is_group);

CREATE OR REPLACE FUNCTION bank_visible(bank uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM visible_question_bank b WHERE b.id=bank)
$$;
