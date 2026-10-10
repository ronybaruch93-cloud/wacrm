-- ============================================================
-- 044_deals_external_id.sql — idempotent deal creation
--
-- Fluxo.os: the public API (POST /api/v1/deals) lets a storefront
-- create orders / bookings. A network retry must not create a second
-- order, so the caller may send its own `external_id` (its order
-- number); the same id in the same account resolves to the deal
-- already created instead of inserting another.
--
--   - Optional: NULL for every deal created from the dashboard.
--   - Unique per ACCOUNT, not globally: two clients can both have an
--     order "1001".
--   - Partial unique index: the many NULLs never collide.
--   - Length-capped so it can't be abused as a payload store.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE deals ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_external_id_length;
ALTER TABLE deals ADD CONSTRAINT deals_external_id_length
  CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_account_external_id
  ON deals (account_id, external_id)
  WHERE external_id IS NOT NULL;
