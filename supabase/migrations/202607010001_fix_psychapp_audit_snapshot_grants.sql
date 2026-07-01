revoke all on table public.psychapp_mcp_oauth_audit from anon, authenticated;
revoke all on table public.psychapp_analysis_snapshots from anon, authenticated;

grant select, insert, update, delete on table public.psychapp_mcp_oauth_audit to service_role;
grant select, insert, update, delete on table public.psychapp_analysis_snapshots to service_role;
