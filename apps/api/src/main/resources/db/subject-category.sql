CREATE TABLE IF NOT EXISTS subject_category (
 id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES subject(id), college_id uuid REFERENCES college(id), major_id uuid REFERENCES major(id),
 grade integer CHECK(grade BETWEEN 1 AND 5), CHECK(major_id IS NULL OR college_id IS NULL),
 CHECK(num_nonnulls(college_id,major_id,grade)>0), UNIQUE NULLS NOT DISTINCT(subject_id,college_id,major_id,grade)
);
CREATE OR REPLACE FUNCTION subject_matches_category(subject_key uuid, selected_college uuid, selected_major uuid, selected_grade integer) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM subject_category WHERE subject_id=subject_key) OR EXISTS(
 SELECT 1 FROM subject_category c LEFT JOIN major m ON m.id=c.major_id WHERE c.subject_id=subject_key
 AND ((selected_college IS NULL AND selected_major IS NULL) OR coalesce(m.college_id,c.college_id) IS NULL
      OR coalesce(m.college_id,c.college_id)=coalesce(selected_college,(SELECT college_id FROM major WHERE id=selected_major)))
 AND (selected_major IS NULL OR c.major_id IS NULL OR c.major_id=selected_major)
 AND (selected_grade IS NULL OR c.grade IS NULL OR c.grade=selected_grade))
$$;
CREATE OR REPLACE FUNCTION bank_matches_category(bank uuid, selected_college uuid, selected_major uuid, selected_grade integer) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT subject_matches_category(b.subject_id, selected_college, selected_major, selected_grade) FROM question_bank b WHERE b.id=bank
$$;
