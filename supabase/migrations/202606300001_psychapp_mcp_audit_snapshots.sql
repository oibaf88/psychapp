create extension if not exists pgcrypto;

create table if not exists public.psychapp_mcp_oauth_audit (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null,
  subject text,
  client_id_hash text,
  tool_name text,
  resource text,
  scopes text[] default array[]::text[],
  metadata jsonb not null default '{}'::jsonb
);

alter table public.psychapp_mcp_oauth_audit enable row level security;

revoke all on table public.psychapp_mcp_oauth_audit from anon, authenticated;
grant select, insert, update, delete on table public.psychapp_mcp_oauth_audit to service_role;

create index if not exists psychapp_mcp_oauth_audit_created_at_idx
  on public.psychapp_mcp_oauth_audit (created_at desc);

create index if not exists psychapp_mcp_oauth_audit_metadata_gin_idx
  on public.psychapp_mcp_oauth_audit using gin (metadata);

create table if not exists public.psychapp_analysis_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  owner_subject text not null default 'owner',
  title text not null,
  summary text not null default '',
  source text not null default 'mcp',
  payload jsonb not null default '{}'::jsonb
);

alter table public.psychapp_analysis_snapshots enable row level security;

revoke all on table public.psychapp_analysis_snapshots from anon, authenticated;
grant select, insert, update, delete on table public.psychapp_analysis_snapshots to service_role;

create index if not exists psychapp_analysis_snapshots_created_at_idx
  on public.psychapp_analysis_snapshots (created_at desc);

create index if not exists psychapp_analysis_snapshots_payload_gin_idx
  on public.psychapp_analysis_snapshots using gin (payload);
