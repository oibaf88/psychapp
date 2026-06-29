create table if not exists public.psychapp_oauth_sessions (
  session_id text primary key,
  token_store text not null,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  expires_at timestamp with time zone not null,
  constraint psychapp_oauth_sessions_session_id_format check (session_id ~ '^[A-Za-z0-9_-]{32,160}$'),
  constraint psychapp_oauth_sessions_token_store_size check (octet_length(token_store) <= 120000)
);

alter table public.psychapp_oauth_sessions enable row level security;

grant usage on schema public to anon, authenticated;

create or replace function public.psychapp_request_header(header_name text)
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb ->> lower(header_name),
    ''
  );
$$;

revoke all on function public.psychapp_request_header(text) from public;
grant execute on function public.psychapp_request_header(text) to anon, authenticated;

drop policy if exists "PsychApp OAuth session select own" on public.psychapp_oauth_sessions;
drop policy if exists "PsychApp OAuth session insert own" on public.psychapp_oauth_sessions;
drop policy if exists "PsychApp OAuth session update own" on public.psychapp_oauth_sessions;
drop policy if exists "PsychApp OAuth session delete own" on public.psychapp_oauth_sessions;

create policy "PsychApp OAuth session select own"
on public.psychapp_oauth_sessions
for select
to anon, authenticated
using (
  session_id = public.psychapp_request_header('x-psychapp-session')
  and expires_at > now()
);

create policy "PsychApp OAuth session insert own"
on public.psychapp_oauth_sessions
for insert
to anon, authenticated
with check (
  session_id = public.psychapp_request_header('x-psychapp-session')
  and expires_at > now()
);

create policy "PsychApp OAuth session update own"
on public.psychapp_oauth_sessions
for update
to anon, authenticated
using (
  session_id = public.psychapp_request_header('x-psychapp-session')
)
with check (
  session_id = public.psychapp_request_header('x-psychapp-session')
  and expires_at > now()
);

create policy "PsychApp OAuth session delete own"
on public.psychapp_oauth_sessions
for delete
to anon, authenticated
using (
  session_id = public.psychapp_request_header('x-psychapp-session')
);

revoke all privileges on table public.psychapp_oauth_sessions from anon, authenticated;
grant select, insert, update, delete on table public.psychapp_oauth_sessions to anon, authenticated;
