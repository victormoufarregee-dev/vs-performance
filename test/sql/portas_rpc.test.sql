-- ============================================================================
-- As 11 portas SECURITY DEFINER do app — rodado DENTRO do banco real, desfeito no fim.
--   esperado:  RESULTADO_PORTAS: 49 ok, 0 falha(s)
--
-- O Supabase Advisor lista essas funções como "SECURITY DEFINER executável por
-- authenticated". É esperado: são as portas do app. O que as torna seguras, e é o que
-- este arquivo prova para CADA uma:
--   P1 security definer + search_path = public, pg_temp
--   P2 anon não tem EXECUTE (nem via PUBLIC)
--   P3 authenticated tem EXECUTE (o app precisa)
--   P4 intruso (logado, fora da allowlist) é recusado — ou, nas duas auxiliares,
--      vsp_autorizado() = false e vsp_ator() não devolve nome de ninguém
--   P5 nada mudou no negócio depois de todas as tentativas do intruso
-- E o backfill (009): nem authenticated nem anon executam; Victor é recusado.
-- ============================================================================
do $t$
declare
  ui uuid := '00000000-0000-4000-8000-00000000dead'; uv uuid;
  ok int := 0; f text[] := '{}'; fn text; cfg text[]; antes text; depois text;
  id_venda bigint; id_rep bigint; s text; b boolean;
  portas text[] := array['vsp_registrar_venda(jsonb,text)', 'vsp_registrar_compra(jsonb,text)',
    'vsp_cancelar_venda(bigint,text,text,text)', 'vsp_estornar_compra(bigint,text,text)',
    'vsp_reembolsar_victor(numeric,date,text,text,text)', 'vsp_registrar_conferencia_caixa(numeric,text,text)',
    'vsp_invalidar_conferencia_caixa(bigint,text)', 'vsp_caixa_esperado()', 'vsp_saldo_victor()',
    'vsp_autorizado()', 'vsp_ator()'];
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  select id into id_venda from public.vendas where not coalesce(cancelada, false) order by id limit 1;
  select id into id_rep from public.reposicoes order by id limit 1;
  antes := (select md5(concat(
    (select json_agg(v order by v.id)::text from public.vendas v), (select json_agg(r order by r.id)::text from public.reposicoes r),
    (select json_agg(p order by p.id)::text from public.produtos p), (select json_agg(s2 order by s2.id)::text from public.saidas s2),
    (select json_agg(l order by l.id)::text from public.ledger_victor l), (select count(*) from public.conferencias_caixa),
    (select count(*) from public.audit_log))));

  -- P1..P3 (catálogo)
  foreach fn in array portas loop
    select p.prosecdef, p.proconfig into b, cfg from pg_proc p where p.oid = ('public.' || fn)::regprocedure;
    if b and cfg @> array['search_path=public, pg_temp'] then ok := ok + 1; else f := f || ('P1 ' || fn); end if;
    if not has_function_privilege('anon', ('public.' || fn)::regprocedure, 'execute') then ok := ok + 1; else f := f || ('P2 anon executa ' || fn); end if;
    if has_function_privilege('authenticated', ('public.' || fn)::regprocedure, 'execute') then ok := ok + 1; else f := f || ('P3 app sem EXECUTE ' || fn); end if;
  end loop;

  -- P4 intruso
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  set local role authenticated;
  begin perform public.vsp_registrar_venda('{}'::jsonb, 'portas-intruso-v'); f := f || text 'P4 intruso passou em registrar_venda';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 registrar_venda outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_registrar_compra('{}'::jsonb, 'portas-intruso-c'); f := f || text 'P4 intruso passou em registrar_compra';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 registrar_compra outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_cancelar_venda(id_venda, 'intruso', 'Intruso', 'portas-intruso-x'); f := f || text 'P4 intruso cancelou venda';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 cancelar_venda outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_estornar_compra(id_rep, 'Intruso', 'portas-intruso-e'); f := f || text 'P4 intruso estornou compra';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 estornar_compra outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_reembolsar_victor(1, current_date, 'intruso', 'pix', 'portas-intruso-r'); f := f || text 'P4 intruso reembolsou';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 reembolsar outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_registrar_conferencia_caixa(1, 'intruso', 'portas-intruso-cc'); f := f || text 'P4 intruso registrou conferencia';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 registrar_conferencia outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_invalidar_conferencia_caixa(1, 'intruso'); f := f || text 'P4 intruso invalidou conferencia';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 invalidar_conferencia outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_caixa_esperado(); f := f || text 'P4 intruso leu o caixa esperado';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 caixa_esperado outro erro: ' || sqlerrm); end if; end;
  begin perform public.vsp_saldo_victor(); f := f || text 'P4 intruso leu o saldo do Victor';
  exception when others then if sqlerrm ilike '%nao autorizado%' then ok := ok + 1; else f := f || ('P4 saldo_victor outro erro: ' || sqlerrm); end if; end;
  if not public.vsp_autorizado() then ok := ok + 1; else f := f || text 'P4 intruso autorizado'; end if;
  s := public.vsp_ator();
  if s is null or not exists (select 1 from public.usuarios_autorizados where nome = s) then ok := ok + 1;
  else f := f || ('P4 vsp_ator do intruso devolveu ' || s); end if;
  -- backfill (009): nem o intruso
  begin perform public.vsp_ledger_backfill(); f := f || text 'B1 intruso chamou o backfill';
  exception when insufficient_privilege then ok := ok + 1; end;
  reset role;

  -- backfill (009): nem o Victor
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  set local role authenticated;
  begin perform public.vsp_ledger_backfill(); f := f || text 'B2 Victor chamou o backfill pela API';
  exception when insufficient_privilege then ok := ok + 1; end;
  if public.vsp_autorizado() then ok := ok + 1; else f := f || text 'B3 Victor deixou de ser autorizado'; end if;
  reset role;
  if not has_function_privilege('authenticated', 'public.vsp_ledger_backfill()'::regprocedure, 'execute')
     and not has_function_privilege('anon', 'public.vsp_ledger_backfill()'::regprocedure, 'execute') then ok := ok + 1;
  else f := f || text 'B4 backfill executavel por authenticated/anon'; end if;

  -- P5
  depois := (select md5(concat(
    (select json_agg(v order by v.id)::text from public.vendas v), (select json_agg(r order by r.id)::text from public.reposicoes r),
    (select json_agg(p order by p.id)::text from public.produtos p), (select json_agg(s2 order by s2.id)::text from public.saidas s2),
    (select json_agg(l order by l.id)::text from public.ledger_victor l), (select count(*) from public.conferencias_caixa),
    (select count(*) from public.audit_log))));
  if antes = depois then ok := ok + 1; else f := f || text 'P5 o intruso mudou dado de negocio'; end if;

  raise exception 'RESULTADO_PORTAS: % ok, % falha(s) | %', ok, coalesce(array_length(f, 1), 0), array_to_string(f, ' ; ');
end $t$;
