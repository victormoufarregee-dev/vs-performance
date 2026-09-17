-- ============================================================================
-- Matriz de acesso pela API (RLS + grants) — rodado DENTRO do banco real, desfeito no fim.
--   esperado:  RESULTADO_SEGURANCA: N ok, 0 falha(s)
--
-- Para cada tabela de negócio, como anon e como conta autenticada FORA da allowlist:
--   SELECT não vê nada · INSERT recusado · UPDATE/DELETE não afetam nenhuma linha.
-- usuarios_autorizados: ninguém se inclui pela API (nem intruso, nem Victor).
-- Nenhuma linha real é alterada: os UPDATE/DELETE de teste usam "where true" mas, se a RLS
-- falhasse, a exceção final desfaria tudo.
-- ============================================================================
do $t$
declare
  uv uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  ok int := 0; f text[] := '{}'; n int; t text; papel text;
  tabelas text[] := array['vendas','clientes','saidas','reposicoes','produtos','estoque','ledger_victor',
                          'conferencias_caixa','audit_log','config','backups','usuarios_autorizados'];
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';

  foreach papel in array array['anon', 'intruso'] loop
    foreach t in array tabelas loop
      execute 'reset role';
      if papel = 'anon' then
        perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
        execute 'set local role anon';
      else
        perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', ui::text, true);
        execute 'set local role authenticated';
      end if;

      -- SELECT
      begin
        execute format('select count(*) from public.%I', t) into n;
        if n = 0 then ok := ok + 1; else f := f || (papel || ' LE ' || n || ' linhas de ' || t); end if;
      exception when insufficient_privilege then ok := ok + 1; end;

      -- INSERT (linha vazia: se a RLS deixar passar, cai em NOT NULL ou entra — os dois são falha)
      begin
        execute format('insert into public.%I default values', t);
        f := f || (papel || ' INSERIU em ' || t);
      exception
        when insufficient_privilege then ok := ok + 1;
        when others then f := f || (papel || ' passou da RLS no insert em ' || t || ' (' || sqlstate || ')');
      end;

      -- UPDATE e DELETE: não podem afetar linha nenhuma
      begin
        execute format('update public.%I set id = id where true', t);
        get diagnostics n = row_count;
        if n = 0 then ok := ok + 1; else f := f || (papel || ' ATUALIZOU ' || n || ' linhas de ' || t); end if;
      exception when insufficient_privilege then ok := ok + 1;
                when undefined_column then ok := ok + 1;   -- tabela sem coluna id: sem update genérico
                when others then f := f || (papel || ' update ' || t || ': ' || sqlstate); end;
      begin
        execute format('delete from public.%I where true', t);
        get diagnostics n = row_count;
        if n = 0 then ok := ok + 1; else f := f || (papel || ' APAGOU ' || n || ' linhas de ' || t); end if;
      exception when insufficient_privilege then ok := ok + 1;
                when others then f := f || (papel || ' delete ' || t || ': ' || sqlstate); end;
    end loop;
  end loop;
  execute 'reset role';

  -- intruso tentando se incluir na allowlist
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  begin
    insert into public.usuarios_autorizados (uid, nome, ativo) values (ui, 'Intruso', true);
    f := f || text 'INTRUSO SE INCLUIU NA ALLOWLIST';
  exception when insufficient_privilege then ok := ok + 1;
            when others then f := f || ('intruso na allowlist: ' || sqlstate); end;
  execute 'reset role';

  -- nem o Victor inclui/altera/remove gente pela API (é ato administrativo, no SQL Editor)
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.usuarios_autorizados;
  if n >= 2 then ok := ok + 1; else f := f || ('Victor ve ' || n || ' autorizados'); end if;
  begin
    insert into public.usuarios_autorizados (uid, nome, ativo) values (ui, 'Intruso', true);
    f := f || text 'Victor incluiu pela API';
  exception when insufficient_privilege then ok := ok + 1; end;
  update public.usuarios_autorizados set ativo = not ativo where true;
  get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; else f := f || ('Victor alterou ' || n || ' autorizados pela API'); end if;
  delete from public.usuarios_autorizados where true;
  get diagnostics n = row_count;
  if n = 0 then ok := ok + 1; else f := f || ('Victor apagou ' || n || ' autorizados pela API'); end if;
  execute 'reset role';

  -- funções: nenhuma vsp_* executável por anon (exceto trigger), e contas de auth existentes
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname like 'vsp%' and pg_get_function_result(p.oid) <> 'trigger'
     and has_function_privilege('anon', p.oid, 'execute');
  if n = 0 then ok := ok + 1; else f := f || (n || ' funcoes vsp executaveis por anon'); end if;

  raise exception 'RESULTADO_SEGURANCA: % ok, % falha(s) | contas_auth=% autorizados_ativos=% | %',
    ok, coalesce(array_length(f,1),0),
    (select count(*) from auth.users), (select count(*) from public.usuarios_autorizados where ativo),
    coalesce(array_to_string(f,' || '),'');
end $t$;
