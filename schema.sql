-- NOETIS — Supabase schema (fresh project)
-- Run once in the Supabase SQL editor. Table and column names match what index.html reads and writes.
-- Every tenant table carries workspace_id and is protected by Row Level Security.
-- Status: written to match the app; not yet run against a live project.

create extension if not exists "pgcrypto";

-- ---------- tenancy ----------
create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'strategist' check (role in ('owner','admin','strategist','analyst','client_viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- SECURITY DEFINER so policies on workspace_members do not recurse into themselves.
create or replace function is_member(ws uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid());
$$;
create or replace function can_edit(ws uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role in ('owner','admin','strategist','analyst'));
$$;
-- Called by the app the first time a signed-in user has no workspace.
create or replace function create_workspace(workspace_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  insert into workspaces (name) values (workspace_name) returning id into new_id;
  insert into workspace_members (workspace_id, user_id, role) values (new_id, auth.uid(), 'owner');
  return new_id;
end $$;
revoke execute on function create_workspace(text) from anon;

-- ---------- brand and market ----------
create table brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  website text not null,
  category text not null,
  geography text not null,                         -- primary market
  markets text not null default '',                -- other markets it sells into
  goal text not null default '',
  success text not null default '',
  status text not null default 'new' check (status in ('new','researching','ready')),
  is_demo boolean not null default false,
  demo_version int,
  dim_labels jsonb not null default '{}',          -- per-brand names for the positioning dimensions
  positions jsonb not null default '{}',           -- 1-5 judgement per positioning dimension
  placed_by text,
  onboarding jsonb not null default '{}',          -- raw onboarding answers, genuinely variable
  last_run_at timestamptz,
  last_run_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- One row per claim about the brand. Never one blob per profile.
create table brand_profile_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  section text not null check (section in ('dna','business','positioning','needs','category','identity')),
  label text not null,
  text text not null,
  excerpt text not null default '',                -- the words the claim came from, verbatim
  provenance text not null default 'unverified' check (provenance in ('brand_stated','observed','user_confirmed','ai_inferred','unverified')),
  confidence text not null default 'Medium' check (confidence in ('Low','Medium','High')),
  status text not null default 'candidate' check (status in ('candidate','confirmed','rejected')),
  source_url text not null default '',
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table products_services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  name text not null,
  category text not null default '',               -- range or type
  description text not null default '',
  features text not null default '',
  benefits text not null default '',
  problem text not null default '',                -- the problem this one solves
  pricing text not null default '',                -- price and packaging, as published
  differentiator text not null default '',
  provenance text not null default 'unverified',
  source_url text not null default '',
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- Intended and observed audiences are separate rows and never merged.
create table audience_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  kind text not null check (kind in ('intended','observed')),
  name text not null default '',                   -- segment name, if it has one
  description text not null,
  demographics text not null default '',           -- only ever recorded, never inferred
  geography text not null default '',
  motivations text not null default '',
  pains text not null default '',
  triggers text not null default '',
  objections text not null default '',
  behaviour text not null default '',
  basis text not null default '',                  -- Customer data | Team experience | Assumed
  provenance text not null default 'unverified',
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table competitors (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  name text not null,
  kind text not null default 'Direct' check (kind in ('Direct','Indirect','Emerging')),
  note text not null default '',
  positioning text not null default '',
  offering text not null default '',
  pricing text not null default '',
  messaging text not null default '',
  differentiation text not null default '',
  audience text not null default '',
  distribution text not null default '',
  activity text not null default '',               -- publicly observable marketing activity
  positions jsonb not null default '{}',           -- 1-5 judgement per positioning dimension
  placed_by text,                                  -- user | ai | demo
  hq text not null default '',                     -- headquarters only
  markets text not null default '',                -- markets served, kept apart from hq
  status text not null default 'candidate' check (status in ('candidate','confirmed','excluded')),
  source_url text not null default '',
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- Tensions (strength, gap, crowded, underused, shift) and emerging signals.
create table market_signals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  kind text not null check (kind in ('strength','gap','crowded','underused','shift','whitespace','threat','signal')),
  category text not null default 'consumer' check (category in ('consumer','competitor','category','product','regulatory')),
  country text not null default '',                -- where the signal is from; blank = not located
  published_at timestamptz,
  relevance text not null default 'Medium' check (relevance in ('Low','Medium','High')),
  implication text not null default '',            -- why it matters
  affects text not null default '',                -- what it affects
  brand_meaning text not null default '',          -- what it could mean for this brand
  source_type text not null default 'Other',
  text text not null,                              -- what is happening
  excerpt text not null default '',                -- the words the finding came from
  sample text not null default '',
  limits text not null default '',
  confidence text not null default 'Medium' check (confidence in ('Low','Medium','High')),
  provenance text not null default 'observed',
  source_url text not null default '',
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- ---------- opportunities and strategies ----------
create table opportunities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  name text not null,
  noticed text not null default '',
  why_now text not null default '',
  affects text not null default '',
  action text not null default '',
  assumptions text not null default '',
  type text not null default '',
  competitive_context text not null default '',
  brand_relevance text not null default '',
  owner text not null default '',
  rank int,                                         -- team priority, set by people only
  experiment text not null default '',
  metric text not null default '',
  impact text not null default 'Medium' check (impact in ('Low','Medium','High')),
  effort text not null default 'Medium' check (effort in ('Low','Medium','High')),
  urgency text not null default 'Medium' check (urgency in ('Low','Medium','High')),
  fit text not null default 'Medium' check (fit in ('Low','Medium','High')),
  horizon text not null default 'Now' check (horizon in ('Now','Next','Later')),
  status text not null default 'proposed' check (status in ('proposed','accepted','parked','rejected')),
  origin text not null default 'user' check (origin in ('user','ai','demo')),
  decision_reason text,
  decided_by text,
  decided_at timestamptz,
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

-- A market research request. Recorded whether or not an engine answers it, so an
-- unanswered question stays visible instead of looking like it was never asked.
create table research_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  topic text not null,
  category text not null default '',
  geography text not null default '',
  segment text not null default '',
  period text not null default '',
  focus text not null default '',
  status text not null default 'requested',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table opportunity_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  signal_id uuid not null references market_signals(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (opportunity_id, signal_id)
);

create table strategies (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid not null references brands(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  channel text not null,
  objective text not null default '',
  funnel_role text not null default '',
  audience text not null default '',
  tension text not null default '',
  message text not null default '',
  territories text not null default '',
  formats text not null default '',
  testing_plan text not null default '',
  budget_assumptions text not null default '',
  kpi text not null default '',
  risks text not null default '',
  next_actions text not null default '',
  owner text not null default '',
  status text not null default 'draft' check (status in ('draft','in_review','approved')),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid references brands(id) on delete cascade,
  actor text not null default '',
  action text not null,
  created_at timestamptz not null default now()
);

-- ---------- for the server side (not used by the browser app yet) ----------
-- Integration records hold status only. Tokens live encrypted in a separate table that
-- has RLS enabled and NO policies, so only the service role (server) can read it.
create table integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  brand_id uuid references brands(id) on delete cascade,
  provider text not null check (provider in ('meta')),
  status text not null default 'not_connected' check (status in ('not_connected','connected','error','needs_review')),
  external_account_id text,
  granted_scopes text[] not null default '{}',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create table integration_secrets (
  integration_id uuid primary key references integrations(id) on delete cascade,
  access_token_encrypted text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create table meta_insights (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  integration_id uuid not null references integrations(id) on delete cascade,
  level text not null check (level in ('account','campaign','adset','ad')),
  object_id text not null,
  object_name text,
  date_start date not null,
  date_stop date not null,
  currency text,
  account_timezone text,
  attribution_setting text,
  spend numeric, impressions bigint, reach bigint, frequency numeric, clicks bigint, ctr numeric, cpc numeric,
  results numeric, cost_per_result numeric, conversion_value numeric, roas numeric,
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  unique (integration_id, level, object_id, date_start, date_stop)
);

-- ---------- indexes ----------
create index on brands (workspace_id);
create index on brand_profile_items (brand_id);
create index on products_services (brand_id);
create index on audience_profiles (brand_id);
create index on competitors (brand_id);
create index on market_signals (brand_id);
create index on research_requests (brand_id);
create index on opportunities (brand_id);
create index on opportunity_evidence (opportunity_id);
create index on strategies (brand_id);
create index on activity_events (brand_id, created_at desc);
create index on meta_insights (integration_id, date_start);

-- ---------- Row Level Security ----------
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
create policy "members read workspace" on workspaces for select using (is_member(id));
create policy "members read memberships" on workspace_members for select using (user_id = auth.uid() or is_member(workspace_id));

-- Members read; owner, admin, strategist and analyst write; client_viewer is read-only.
do $$
declare t text;
begin
  foreach t in array array['brands','brand_profile_items','products_services','audience_profiles','competitors','market_signals','opportunities','opportunity_evidence','strategies','research_requests'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy "members read" on %I for select using (is_member(workspace_id))', t);
    execute format('create policy "editors insert" on %I for insert with check (can_edit(workspace_id))', t);
    execute format('create policy "editors update" on %I for update using (can_edit(workspace_id)) with check (can_edit(workspace_id))', t);
    execute format('create policy "editors delete" on %I for delete using (can_edit(workspace_id))', t);
  end loop;
end $$;

-- Activity is append-only for members.
alter table activity_events enable row level security;
create policy "members read" on activity_events for select using (is_member(workspace_id));
create policy "editors insert" on activity_events for insert with check (can_edit(workspace_id));

-- Integration status is readable by members; only the server writes it.
alter table integrations enable row level security;
create policy "members read" on integrations for select using (is_member(workspace_id));
alter table meta_insights enable row level security;
create policy "members read" on meta_insights for select using (is_member(workspace_id));
-- No policies on purpose: unreadable from the browser, readable only with the service role key.
alter table integration_secrets enable row level security;
