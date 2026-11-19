DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='security_policy'
            AND column_name='min_password_length' AND column_default='12') THEN
  ALTER TABLE public.security_policy DROP CONSTRAINT security_policy_min_password_length_check,
   ALTER COLUMN min_password_length SET DEFAULT 8,
   ADD CONSTRAINT security_policy_min_password_length_check CHECK(min_password_length BETWEEN 8 AND 64);
  UPDATE public.security_policy SET min_password_length=8,version=version+1,updated_at=now()
   WHERE id=1 AND version=1 AND min_password_length=12;
 END IF;
END $$;
