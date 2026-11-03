DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qanda_monitor') THEN CREATE ROLE qanda_monitor NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='qanda_activity_writer') THEN CREATE ROLE qanda_activity_writer NOLOGIN; END IF;
END $$;
GRANT qanda_monitor, qanda_activity_writer TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO qanda_monitor,qanda_activity_writer;
GRANT SELECT ON monitoring_student,monitoring_learning,monitoring_session,monitoring_sync_completion,monitoring_jobs,user_activity,session_presence TO qanda_monitor;
-- The account module validates and touches sessions inside the monitor process.
GRANT SELECT ON user_account,user_session,admin_account,admin_session,security_policy TO qanda_monitor;
GRANT UPDATE(last_seen_at) ON user_session,admin_session TO qanda_monitor;
GRANT INSERT ON audit_log TO qanda_monitor;
GRANT SELECT,INSERT,UPDATE ON user_activity TO qanda_activity_writer;
GRANT SELECT,UPDATE(processed_at) ON domain_event_outbox TO qanda_activity_writer;
GRANT SELECT(user_id,expires_at,disabled_at,include_in_statistics) ON test_account TO qanda_monitor;
