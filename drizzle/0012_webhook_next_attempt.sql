-- 0012_webhook_next_attempt.sql
-- Adds a scheduling column to webhook_deliveries so the retry sweep can
-- honor an upstream 429 `Retry-After` hint (and, in general, defer a row's
-- next attempt). NULL means "eligible immediately" — preserving prior
-- behavior for existing rows.

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
