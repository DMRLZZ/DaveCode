-- Sign-up passwords now ride on the confirmation link instead of the account row.
-- Run this against the database BEFORE deploying the worker that uses it:
--   npx wrangler d1 execute davecode-accounts --remote --file migrations/0001_verification_password.sql
-- New databases already get the column from src/schema.ts; skip this file there (it errors if
-- the column exists). Links created before this change have a NULL value and keep working.
ALTER TABLE email_verifications ADD COLUMN password_hash TEXT;
