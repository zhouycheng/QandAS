CREATE TABLE test_account (
 user_id uuid PRIMARY KEY REFERENCES user_account(id),
 expires_at timestamptz NOT NULL, include_in_statistics boolean NOT NULL DEFAULT false,
 created_by uuid NOT NULL REFERENCES admin_account(id), disabled_at timestamptz,
 disable_reason varchar(12) CHECK(disable_reason IN ('MANUAL','EXPIRED')),
 password_ciphertext text, password_nonce varchar(24), password_key_version integer,
 CHECK((disabled_at IS NULL) = (disable_reason IS NULL)),
 CHECK((password_ciphertext IS NULL) = (password_nonce IS NULL)),
 CHECK((password_ciphertext IS NULL) = (password_key_version IS NULL))
);
CREATE INDEX test_account_expiry_idx ON test_account(expires_at,user_id) WHERE disabled_at IS NULL;

CREATE FUNCTION account_in_statistics(student uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM test_account WHERE user_id=student AND NOT include_in_statistics)
$$;

CREATE OR REPLACE VIEW monitoring_student AS
 SELECT u.id user_id,u.account_code,u.nickname,u.status,u.credential_version,u.created_at,
 coalesce(p.college_id,m.college_id) college_id,c.name college_name,p.major_id,m.name major_name,
 current_grade(p.grade,p.grade_academic_year,(now() AT TIME ZONE 'Asia/Shanghai')::date) current_grade,
 account_in_statistics(u.id) include_in_statistics
 FROM user_account u LEFT JOIN user_profile p ON p.user_id=u.id LEFT JOIN major m ON m.id=p.major_id
 LEFT JOIN college c ON c.id=coalesce(p.college_id,m.college_id);

CREATE OR REPLACE FUNCTION monitoring_online_at(sample_time timestamptz)
 RETURNS TABLE(session_id uuid,user_id uuid,foreground_seen_at timestamptz)
 LANGUAGE sql STABLE AS $$
 SELECT s.id,s.user_id,p.foreground_seen_at
 FROM user_session s JOIN session_presence p ON p.session_id=s.id JOIN user_account u ON u.id=s.user_id
 LEFT JOIN test_account t ON t.user_id=u.id
 WHERE s.revoked_at IS NULL AND s.expires_at>sample_time AND u.status='ACTIVE' AND s.credential_version=u.credential_version
 AND (t.user_id IS NULL OR (t.disabled_at IS NULL AND t.expires_at>sample_time))
 AND p.foreground_seen_at>sample_time-interval '120 seconds' AND p.foreground_seen_at<=sample_time
$$;
GRANT SELECT(user_id,expires_at,disabled_at,include_in_statistics) ON test_account TO qanda_monitor;
