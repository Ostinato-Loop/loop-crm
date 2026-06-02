-- Loop CRM — Customer Graph Schema
-- Migration: 20260602_customer_graph
-- LILCKY STUDIO LIMITED
-- Apply in Supabase SQL Editor for the RALD ecosystem Supabase project

-- ============================================================
-- WORKSPACE LAYER (Phase C foundation materialised in the DB)
-- ============================================================

CREATE TABLE IF NOT EXISTS crm_workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  owner_user_id   TEXT NOT NULL,        -- rald user id from auth_users
  plan            TEXT NOT NULL DEFAULT 'starter',  -- starter | growth | business | enterprise
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS crm_workspace_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL,        -- rald user id from auth_users
  role            TEXT NOT NULL DEFAULT 'member',  -- owner | admin | member | viewer
  invited_by      TEXT,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

-- ============================================================
-- CUSTOMER GRAPH (Phase D core)
-- ============================================================

-- Single canonical customer model — one record per person per workspace
CREATE TABLE IF NOT EXISTS crm_customers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  rald_user_id          TEXT,           -- optional link to auth_users (if customer has RALD account)

  -- Core identity
  name                  TEXT NOT NULL,
  email                 TEXT,
  phone                 TEXT,
  avatar_url            TEXT,

  -- Metadata
  source                TEXT NOT NULL DEFAULT 'manual',  -- manual | import | api | webhook | connect
  status                TEXT NOT NULL DEFAULT 'active',  -- active | inactive | blocked
  tags                  TEXT[] NOT NULL DEFAULT '{}',

  -- Business context (African-first defaults)
  company               TEXT,
  job_title             TEXT,
  location              TEXT,
  timezone              TEXT NOT NULL DEFAULT 'Africa/Lagos',
  language              TEXT NOT NULL DEFAULT 'en',
  currency              TEXT NOT NULL DEFAULT 'NGN',

  -- Denormalised stats (updated by triggers/API)
  total_spend           BIGINT NOT NULL DEFAULT 0,       -- kobo (NGN minor unit)
  conversation_count    INT NOT NULL DEFAULT 0,
  booking_count         INT NOT NULL DEFAULT 0,
  last_seen_at          TIMESTAMPTZ,
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Merge tracking
  merged_into           UUID REFERENCES crm_customers(id),
  is_primary            BOOLEAN NOT NULL DEFAULT TRUE,

  -- Audit
  created_by            TEXT,
  updated_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ              -- soft delete
);

-- Customer communication channels (email, phone, WhatsApp, social)
-- Enables identity resolution: find customer by incoming channel
CREATE TABLE IF NOT EXISTS crm_customer_channels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  channel_type    TEXT NOT NULL,   -- email | phone | whatsapp | instagram | facebook | twitter | linkedin
  channel_id      TEXT NOT NULL,   -- the actual identifier
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  is_verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(workspace_id, channel_type, channel_id)
);

-- Customer notes (internal team notes, pinnable)
CREATE TABLE IF NOT EXISTS crm_customer_notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  author_user_id  TEXT NOT NULL,
  content         TEXT NOT NULL,
  is_pinned       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

-- Customer activity timeline (append-only event log)
CREATE TABLE IF NOT EXISTS crm_customer_activity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  actor_user_id   TEXT,            -- NULL = system event
  event_type      TEXT NOT NULL,
  event_data      JSONB NOT NULL DEFAULT '{}',
  channel         TEXT,            -- email | whatsapp | sms | in-app
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NOTE: No updated_at — timeline is append-only / immutable
);

-- Customer segments (smart filter lists + manual groups)
CREATE TABLE IF NOT EXISTS crm_customer_segments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  filter_criteria  JSONB NOT NULL DEFAULT '{}',
  is_smart         BOOLEAN NOT NULL DEFAULT TRUE,  -- smart = computed; false = manual
  member_count     INT NOT NULL DEFAULT 0,         -- cached count
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at       TIMESTAMPTZ
);

-- Static segment membership (for manual segments only)
CREATE TABLE IF NOT EXISTS crm_customer_segment_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_id   UUID NOT NULL REFERENCES crm_customer_segments(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES crm_customers(id) ON DELETE CASCADE,
  added_by     TEXT,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(segment_id, customer_id)
);

-- Merge engine audit log (enables full rollback)
CREATE TABLE IF NOT EXISTS crm_customer_merge_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  primary_customer_id   UUID NOT NULL,  -- the survivor
  merged_customer_id    UUID NOT NULL,  -- the absorbed record
  merge_snapshot        JSONB NOT NULL, -- full snapshot of merged customer before absorption
  merged_by             TEXT NOT NULL,
  merged_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at        TIMESTAMPTZ,
  rolled_back_by        TEXT
);

-- Canonical audit trail (workspace-scoped)
CREATE TABLE IF NOT EXISTS crm_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES crm_workspaces(id) ON DELETE CASCADE,
  actor_user_id   TEXT NOT NULL,
  action          TEXT NOT NULL,    -- customer.created | customer.merged | segment.created | ...
  resource_type   TEXT NOT NULL,    -- customer | workspace | segment | channel | note
  resource_id     TEXT NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NOTE: Audit log is append-only — no update or delete
);

-- ============================================================
-- INDEXES (performance + workspace isolation enforcement)
-- ============================================================

-- Workspace lookup
CREATE INDEX IF NOT EXISTS idx_crm_workspaces_slug ON crm_workspaces(slug);
CREATE INDEX IF NOT EXISTS idx_crm_workspace_members_user ON crm_workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_crm_workspace_members_workspace ON crm_workspace_members(workspace_id);

-- Customer search (African SMB common patterns)
CREATE INDEX IF NOT EXISTS idx_crm_customers_workspace ON crm_customers(workspace_id, deleted_at, is_primary);
CREATE INDEX IF NOT EXISTS idx_crm_customers_email ON crm_customers(workspace_id, email) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customers_phone ON crm_customers(workspace_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customers_status ON crm_customers(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customers_source ON crm_customers(workspace_id, source) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customers_tags ON crm_customers USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_crm_customers_spend ON crm_customers(workspace_id, total_spend DESC) WHERE deleted_at IS NULL;

-- Channel identity resolution (primary use case: incoming message → find customer)
CREATE INDEX IF NOT EXISTS idx_crm_channels_resolve ON crm_customer_channels(workspace_id, channel_type, channel_id);
CREATE INDEX IF NOT EXISTS idx_crm_channels_customer ON crm_customer_channels(customer_id);

-- Timeline queries
CREATE INDEX IF NOT EXISTS idx_crm_activity_customer ON crm_customer_activity(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_workspace ON crm_customer_activity(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activity_event_type ON crm_customer_activity(workspace_id, event_type);

-- Segment queries
CREATE INDEX IF NOT EXISTS idx_crm_segments_workspace ON crm_customer_segments(workspace_id) WHERE deleted_at IS NULL;

-- Audit log queries
CREATE INDEX IF NOT EXISTS idx_crm_audit_workspace ON crm_audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_actor ON crm_audit_log(workspace_id, actor_user_id);
CREATE INDEX IF NOT EXISTS idx_crm_audit_resource ON crm_audit_log(resource_type, resource_id);

-- ============================================================
-- ROW LEVEL SECURITY (workspace isolation at DB layer)
-- ============================================================

ALTER TABLE crm_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_segment_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_customer_merge_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_audit_log ENABLE ROW LEVEL SECURITY;

-- Service role bypass (CF Worker uses service role key — bypasses RLS)
-- All workspace isolation is enforced at the API layer (workspaceMiddleware)
-- RLS acts as a second layer of defence

CREATE POLICY "Service role bypass" ON crm_workspaces TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_workspace_members TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customers TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_channels TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_notes TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_activity TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_segments TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_segment_members TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_customer_merge_log TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role bypass" ON crm_audit_log TO service_role USING (true) WITH CHECK (true);

-- Public access denied (anon role gets nothing)
CREATE POLICY "Deny anon" ON crm_workspaces FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon" ON crm_customers FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon" ON crm_customer_channels FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon" ON crm_customer_activity FOR ALL TO anon USING (false);
CREATE POLICY "Deny anon" ON crm_audit_log FOR ALL TO anon USING (false);

-- ============================================================
-- SEED DATA (starter workspace for testing)
-- ============================================================

-- NOTE: Do not run in production. Included for integration test reference only.
-- INSERT INTO crm_workspaces (id, name, slug, owner_user_id, plan)
-- VALUES ('00000000-0000-0000-0000-000000000001', 'Loop Demo', 'loop-demo', 'test-user-id', 'starter');

-- ============================================================
-- VERIFICATION
-- ============================================================

-- After applying this migration, run:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'crm_%';
-- Expected: 10 tables (crm_workspaces, crm_workspace_members, crm_customers, crm_customer_channels,
--            crm_customer_notes, crm_customer_activity, crm_customer_segments, crm_customer_segment_members,
--            crm_customer_merge_log, crm_audit_log)
