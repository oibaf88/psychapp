create extension if not exists pgcrypto;

create table if not exists public.psychapp_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  app_path text not null default '/psychapp',
  request_meta jsonb not null default '{}'::jsonb,
  scraped jsonb not null default '[]'::jsonb,
  result jsonb not null default '{}'::jsonb,
  user_agent text not null default ''
);

alter table public.psychapp_runs enable row level security;

revoke all on table public.psychapp_runs from anon, authenticated;
grant select, insert, update, delete on table public.psychapp_runs to service_role;

create index if not exists psychapp_runs_created_at_idx
  on public.psychapp_runs (created_at desc);

create index if not exists psychapp_runs_request_meta_gin_idx
  on public.psychapp_runs using gin (request_meta);

create index if not exists psychapp_runs_scraped_gin_idx
  on public.psychapp_runs using gin (scraped);
