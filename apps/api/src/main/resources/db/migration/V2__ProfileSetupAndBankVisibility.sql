ALTER TABLE user_account ADD COLUMN profile_setup_seen boolean NOT NULL DEFAULT false;
UPDATE user_account u SET profile_setup_seen=true
FROM user_profile p
WHERE p.user_id=u.id AND p.major_id IS NOT NULL AND p.grade IS NOT NULL;

CREATE OR REPLACE FUNCTION bank_visible(bank uuid, student uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 WITH student_scope AS (
   SELECT coalesce(m.college_id,p.college_id) college_id,p.major_id,
          current_grade(p.grade,p.grade_academic_year,(now() AT TIME ZONE 'Asia/Shanghai')::date) grade
   FROM user_account u LEFT JOIN user_profile p ON p.user_id=u.id LEFT JOIN major m ON m.id=p.major_id
   WHERE u.id=student
 )
 SELECT EXISTS(SELECT 1 FROM question_bank b JOIN subject s ON s.id=b.subject_id
 WHERE b.id=bank AND b.status='ACTIVE' AND b.publication_status='PUBLISHED' AND s.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM question q WHERE q.bank_id=b.id AND q.status='ACTIVE' AND NOT q.is_group)
 AND (student IS NULL OR b.scope_type='ALL'
 OR EXISTS(SELECT 1 FROM subject_user_access g WHERE g.subject_id=b.subject_id AND g.user_id=student)
 OR EXISTS(SELECT 1 FROM student_scope p WHERE p.college_id IS NULL
   OR EXISTS(SELECT 1 FROM bank_audience a LEFT JOIN major am ON am.id=a.major_id
     WHERE a.bank_id=b.id
     AND (coalesce(am.college_id,a.college_id) IS NULL OR coalesce(am.college_id,a.college_id)=p.college_id)
     AND (p.major_id IS NULL OR a.major_id IS NULL OR a.major_id=p.major_id)
     AND (p.major_id IS NULL OR p.grade IS NULL OR a.grade IS NULL OR a.grade=p.grade)))))
$$;
