ALTER TABLE email_challenge DROP CONSTRAINT email_challenge_purpose_check;
ALTER TABLE email_challenge ADD CONSTRAINT email_challenge_purpose_check CHECK(purpose IN ('LOGIN','REGISTER','RESET_PASSWORD','BIND_EMAIL','CHANGE_PASSWORD','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW'));
