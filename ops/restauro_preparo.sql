-- O que o Supabase tem e um Postgres limpo não: os papéis da API e auth.uid().
-- Só para o TESTE de restauração do backup (.github/workflows/backup.yml).
-- Sem sessão, auth.uid() devolve nulo — como no SQL Editor.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
