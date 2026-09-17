-- ============================================================================
-- Teste da view v_ledger_victor (extrato da Conta do Victor) — rodar no SQL Editor.
--
-- Termina SEMPRE em exceção com o placar (nada fica gravado):
--   esperado depois de 17/09/2026:  RESULTADO_VIEW: 6 ok, 0 falha(s)
--
-- Contexto: até 17/09/2026 a view rodava com as permissões da dona (postgres), ignorando a
-- RLS da ledger_victor, e anon tinha SELECT nela. Qualquer um com a chave pública do app
-- lia o extrato inteiro pela API; qualquer conta logada fora da allowlist também.
-- Rodado ANTES da correção, este teste dava "3 ok, 3 falha(s) | V1 view sem
-- security_invoker || V2 anon leu a view || V3 intruso logado viu 21 linhas".
-- ============================================================================
do $t$
declare uv uuid; ui uuid := '00000000-0000-4000-8000-00000000dead'; n int; ok int := 0; f text[] := '{}'; opcoes text;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  select array_to_string(reloptions, ',') into opcoes from pg_class where oid = 'public.v_ledger_victor'::regclass;
  if opcoes like '%security_invoker=true%' then ok := ok + 1; else f := f || text 'V1 view sem security_invoker'; end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin perform count(*) from public.v_ledger_victor; f := f || text 'V2 anon leu a view';
  exception when insufficient_privilege then ok := ok + 1; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.v_ledger_victor;
  if n = 0 then ok := ok + 1; else f := f || ('V3 intruso logado viu ' || n || ' linhas'); end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.v_ledger_victor;
  -- 21 = movimentos do razão em 17/09/2026; se o razão crescer, ajuste este número
  if n = 21 then ok := ok + 1; else f := f || ('V4 Victor viu ' || n || ' linhas (esperado 21)'); end if;
  select count(*) into n from public.v_ledger_victor where saldo_corrido is null;
  if n = 0 then ok := ok + 1; else f := f || text 'V5 saldo corrido nulo'; end if;
  if (select saldo_corrido from public.v_ledger_victor order by data desc, id desc limit 1) = public.vsp_saldo_victor() then ok := ok + 1;
  else f := f || text 'V6 saldo corrido final diferente de vsp_saldo_victor()'; end if;
  execute 'reset role';
  raise exception 'RESULTADO_VIEW: % ok, % falha(s) | %', ok, coalesce(array_length(f,1),0), coalesce(array_to_string(f,' || '),'');
end $t$;
