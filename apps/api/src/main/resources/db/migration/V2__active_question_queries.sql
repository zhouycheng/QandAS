CREATE VIEW active_question AS
SELECT q.* FROM question q LEFT JOIN question parent ON parent.id=q.reading_parent_id
WHERE q.status='ACTIVE' AND (q.reading_parent_id IS NULL OR parent.status='ACTIVE');

CREATE OR REPLACE FUNCTION question_active(question_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM active_question q WHERE q.id=question_id)
$$;

CREATE OR REPLACE FUNCTION bank_visible(bank uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM question_bank b JOIN subject s ON s.id=b.subject_id
 WHERE b.id=bank AND b.status='ACTIVE' AND b.publication_status='PUBLISHED' AND s.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM active_question q WHERE q.bank_id=b.id AND NOT q.is_group))
$$;
