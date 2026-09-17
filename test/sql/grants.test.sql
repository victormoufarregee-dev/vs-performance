-- ============================================================================
-- Matriz de GRANTS de tabela — rodado DENTRO do banco real, desfeito no fim.
--   esperado (com a 010 aplicada):  RESULTADO_GRANTS: 17 ok, 0 falha(s)
--
-- Prova, sem olhar para a RLS, que o privilégio bruto já é o mínimo:
--   G1  anon não tem NENHUM privilégio em NENHUMA tabela/view do schema public
--   G2  authenticated tem exatamente o conjunto esperado, tabela por tabela
--   G3  ninguém além de postgres/service_role tem TRUNCATE, REFERENCES ou TRIGGER
--   G4  vsp_cc_protege() não é executável por public/anon/authenticated
--   G5  tabela nova criada por postgres não nasce com privilégio para anon
--
-- G5 cria uma tabela de teste; o `raise exception` do fim desfaz tudo.
-- ============================================================================
do $t$
declare
  ok int := 0; f text[] := '{}'; n int; t text; got text; want text;
  esperado text[][] := array[
    ['audit_log',            'INSERT,SELECT'],
    ['backups',              'DELETE,INSERT,SELECT'],
    ['clientes',             'INSERT,SELECT,UPDATE'],
    ['conferencias_caixa',   'SELECT'],
    ['config',               'SELECT,UPDATE'],
    ['estoque',              'SELECT'],
    ['ledger_victor',        'SELECT'],
    ['produtos',             'INSERT,SELECT,UPDATE'],
    ['reposicoes',           'SELECT,UPDATE'],
    ['saidas',               'DELETE,INSERT,SELECT'],
    ['usuarios_autorizados', 'SELECT'],
    ['vendas',               'SELECT,UPDATE'],
    ['v_ledger_victor',      'SELECT']
  ];
  i int;
begin
  -- G1 — anon sem nada
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon';
  if n = 0 then ok := ok + 1; else f := f || ('G1 anon ainda tem ' || n || ' privilegio(s) de tabela'); end if;

  -- G2 — authenticated, tabela por tabela
  for i in 1 .. array_length(esperado, 1) loop
    t := esperado[i][1]; want := esperado[i][2];
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), '(nenhum)')
      into got
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'authenticated' and table_name = t;
    if got = want then ok := ok + 1;
    else f := f || ('G2 ' || t || ': authenticated=' || got || ' esperado ' || want); end if;
  end loop;

  -- G3 — privilégios de DDL/integridade fora de postgres e service_role
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public'
     and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
     and grantee not in ('postgres', 'service_role', 'supabase_admin');
  if n = 0 then ok := ok + 1; else f := f || ('G3 ' || n || ' grant(s) de TRUNCATE/REFERENCES/TRIGGER fora de postgres/service_role'); end if;

  -- G4 — a trigger function da conferência não é porta da API
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'vsp_cc_protege'
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));
  if n = 0 then ok := ok + 1; else f := f || text 'G4 vsp_cc_protege ainda executavel por anon/authenticated'; end if;

  -- G5 — default privileges: tabela nova não nasce aberta para anon
  execute 'create table public.zz_vsp_teste_grants (id int)';
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'zz_vsp_teste_grants' and grantee = 'anon';
  if n = 0 then ok := ok + 1; else f := f || ('G5 tabela nova ja nasce com ' || n || ' privilegio(s) para anon'); end if;
  execute 'drop table public.zz_vsp_teste_grants';

  raise exception 'RESULTADO_GRANTS: % ok, % falha(s) | %',
    ok, coalesce(array_length(f, 1), 0), coalesce(array_to_string(f, ' || '), '');
end $t$;
