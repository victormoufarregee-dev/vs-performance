-- ============================================================================
-- Teste da view v_ledger_victor (extrato da Conta do Victor) — rodar no SQL Editor.
--
-- Termina SEMPRE em exceção com o placar (nada fica gravado):
--   esperado:  RESULTADO_VIEW: 9 ok, 0 falha(s)
--
-- Valida PROPRIEDADES, não quantidade histórica: o número de movimentos é lido da própria
-- tabela no início do teste, então uma compra ou um reembolso novo não quebra nada.
--
-- Contexto: até 17/09/2026 a view rodava com as permissões da dona (postgres), ignorando a
-- RLS da ledger_victor, e anon tinha SELECT nela. A primeira versão deste teste, rodada
-- antes da correção, deu "3 ok, 3 falha(s) | V1 view sem security_invoker || V2 anon leu a
-- view || V3 intruso logado viu 21 linhas".
-- ============================================================================
do $t$
declare
  uv uuid; us uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  n int; total int; ok int := 0; f text[] := '{}'; opcoes text; saldo_real numeric; saldo_view numeric;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  select id into us from auth.users where lower(email) = 'xsthexsouza@gmail.com';
  if uv is null or us is null then raise exception 'RESULTADO_VIEW: ABORTADO — uid de Victor ou Stefany nao encontrado'; end if;

  -- a verdade, lida como dono do banco (sem RLS)
  select count(*) into total from public.ledger_victor;
  saldo_real := public.vsp_saldo_victor();

  select array_to_string(reloptions, ',') into opcoes from pg_class where oid = 'public.v_ledger_victor'::regclass;
  if opcoes like '%security_invoker=true%' then ok := ok + 1; else f := f || text 'V1 view sem security_invoker'; end if;
  if not has_table_privilege('anon', 'public.v_ledger_victor', 'select') then ok := ok + 1;
  else f := f || text 'V2 anon tem SELECT na view'; end if;

  -- anon
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin perform count(*) from public.v_ledger_victor; f := f || text 'V3 anon leu a view';
  exception when insufficient_privilege then ok := ok + 1; end;
  execute 'reset role';

  -- intruso logado, fora da allowlist
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.v_ledger_victor;
  if n = 0 then ok := ok + 1; else f := f || ('V4 intruso logado viu ' || n || ' linhas'); end if;
  execute 'reset role';

  -- Victor e Stefany: veem TODOS os movimentos que existem, e o saldo corrido fecha
  for uv, n in select x.u, 0 from (values (uv), (us)) as x(u) loop
    perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', uv::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.v_ledger_victor;
    if n = total then ok := ok + 1; else f := f || ('V5 autorizado viu ' || n || ' de ' || total || ' movimentos'); end if;
    select saldo_corrido into saldo_view from public.v_ledger_victor order by data desc, id desc limit 1;
    if coalesce(saldo_view, 0) = saldo_real then ok := ok + 1;
    else f := f || ('V6 saldo corrido final ' || coalesce(saldo_view::text, 'nulo') || ' <> vsp_saldo_victor ' || saldo_real); end if;
    execute 'reset role';
  end loop;

  select count(*) into n from public.v_ledger_victor where saldo_corrido is null;
  if n = 0 then ok := ok + 1; else f := f || text 'V7 saldo corrido nulo'; end if;

  raise exception 'RESULTADO_VIEW: % ok, % falha(s) | movimentos=% saldo=% | %',
    ok, coalesce(array_length(f,1),0), total, saldo_real, coalesce(array_to_string(f,' || '),'');
end $t$;
