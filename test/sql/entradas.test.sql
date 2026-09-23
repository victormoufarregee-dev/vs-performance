-- ============================================================================
-- Testes da 012 — Entrada que não é venda (devolução de fornecedor), DENTRO do banco real.
--
-- COMO RODA: cole no SQL Editor o texto de migrations/012_entradas_devolucao_fornecedor.sql
-- seguido deste bloco, e rode UMA vez. O bloco termina SEMPRE com
-- `raise exception 'RESULTADO_ENTRADAS: ...'`: a exceção desfaz TUDO — a migration e as
-- entradas de teste. Nada fica gravado. Por isso dá para testar a 012 antes de aplicá-la.
-- Depois de aplicada, o bloco sozinho também roda (e também não grava nada).
--
-- Sessões simuladas como o PostgREST faz: role `authenticated`/`anon` e o JWT em
-- request.jwt.claims. O "intruso" é um uid que não existe na allowlist.
-- ============================================================================
do $teste$
declare
  uv uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  r jsonb; n int; ok int := 0; f text[] := '{}'; msg text; nome_v text;
  esp0 numeric; esp numeric; id_e bigint;
  cont_vendas int; cont_saidas int; cont_ledger int; saldo_vic numeric; estoque text;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  if uv is null then raise exception 'RESULTADO_ENTRADAS: ABORTADO — uid do Victor nao encontrado'; end if;

  esp0 := public.vsp_caixa_esperado_calc();
  select count(*) into cont_vendas from public.vendas;
  select count(*) into cont_saidas from public.saidas;
  select count(*) into cont_ledger from public.ledger_victor;
  saldo_vic := public.vsp_saldo_victor();
  select string_agg(id || ':' || caixas || '/' || frascos || '/' || custo_caixa, ',' order by id) into estoque from public.produtos;

  -- ---------------------------------------------------------------- estrutura
  if (select relrowsecurity from pg_class where oid = 'public.entradas'::regclass)
     and not has_table_privilege('anon', 'public.entradas', 'select')
     and has_table_privilege('authenticated', 'public.entradas', 'select')
     and not has_table_privilege('authenticated', 'public.entradas', 'insert')
     and not has_table_privilege('authenticated', 'public.entradas', 'update')
     and not has_table_privilege('authenticated', 'public.entradas', 'delete')
  then ok := ok + 1; else f := f || text 'T01 entradas sem RLS, legivel por anon ou gravavel pela API'; end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname in ('vsp_registrar_entrada','vsp_excluir_entrada','vsp_caixa_esperado_calc')
     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%';
  if n = 3 then ok := ok + 1; else f := f || ('T02 security definer + search_path fixo em ' || n || ' de 3'); end if;

  if not has_function_privilege('anon', 'public.vsp_registrar_entrada(jsonb,text)', 'execute')
     and not has_function_privilege('anon', 'public.vsp_excluir_entrada(bigint,text)', 'execute')
     and has_function_privilege('authenticated', 'public.vsp_registrar_entrada(jsonb,text)', 'execute')
     and has_function_privilege('authenticated', 'public.vsp_excluir_entrada(bigint,text)', 'execute')
     and not has_function_privilege('authenticated', 'public.vsp_caixa_esperado_calc()', 'execute')
  then ok := ok + 1; else f := f || text 'T03 grants de funcao errados'; end if;

  -- ---------------------------------------------------------------- anon
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin
    perform public.vsp_registrar_entrada('{"tipo":"devolucao_fornecedor","fornecedor":"x","descricao":"x","data":"2026-09-23","val":1}'::jsonb, 't-ent-anon');
    f := f || text 'T10 anon lancou entrada';
  exception when insufficient_privilege then ok := ok + 1;
            when others then f := f || ('T10 anon: erro inesperado ' || sqlerrm); end;
  execute 'reset role';

  -- ---------------------------------------------------------------- intruso
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  begin
    perform public.vsp_registrar_entrada('{"tipo":"devolucao_fornecedor","fornecedor":"x","descricao":"x","data":"2026-09-23","val":1}'::jsonb, 't-ent-intruso');
    f := f || text 'T11 intruso lancou entrada';
  exception when others then ok := ok + 1; end;
  select count(*) into n from public.entradas;
  if n = 0 then ok := ok + 1; else f := f || ('T12 intruso leu ' || n || ' entrada(s)'); end if;
  execute 'reset role';

  -- ---------------------------------------------------------------- Victor
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  nome_v := public.vsp_ator();

  -- escrita direta pela API: recusada
  begin
    insert into public.entradas (id, tipo, fornecedor, descricao, data, val, op_id, created_by)
    values (1, 'devolucao_fornecedor', 'x', 'x', hoje, 1, 't-ent-direto', 'x');
    f := f || text 'T20 INSERT direto em entradas passou';
  exception when insufficient_privilege then ok := ok + 1; end;

  -- payloads inválidos: recusados, nada gravado
  foreach msg in array array[
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","data":"2026-09-23","val":0}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","data":"2026-09-23","val":-5}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","data":"2026-09-23","val":10.005}',
    '{"tipo":"venda","fornecedor":"H","descricao":"d","data":"2026-09-23","val":10}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"  ","descricao":"d","data":"2026-09-23","val":10}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"","data":"2026-09-23","val":10}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","val":10}',
    '{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","data":"2026-09-23","val":10,"pgto":"fiado"}'
  ] loop
    begin
      perform public.vsp_registrar_entrada(msg::jsonb, 't-ent-inv-' || md5(msg));
      f := f || ('T21 aceitou payload invalido ' || msg);
    exception when others then ok := ok + 1; end;
  end loop;
  begin
    perform public.vsp_registrar_entrada('{"tipo":"devolucao_fornecedor","fornecedor":"H","descricao":"d","data":"2026-09-23","val":10}'::jsonb, '  ');
    f := f || text 'T22 aceitou op_id vazio';
  exception when others then ok := ok + 1; end;
  select count(*) into n from public.entradas where op_id like 't-ent-%';
  if n = 0 then ok := ok + 1; else f := f || ('T23 invalido gravou ' || n); end if;

  -- lançamento válido: soma exatamente no caixa
  r := public.vsp_registrar_entrada(jsonb_build_object('tipo','devolucao_fornecedor','fornecedor','Hassan',
         'descricao','teste 012','data',hoje,'val',1700.01,'pgto','pix'), 't-ent-ok');
  id_e := (r->'entrada'->>'id')::bigint;
  if not (r->>'repetida')::boolean and r->'entrada'->>'created_by' = nome_v and (r->'entrada'->>'val')::numeric = 1700.01
  then ok := ok + 1; else f := f || ('T30 lancamento: ' || r::text); end if;
  esp := public.vsp_caixa_esperado();
  if esp = esp0 + 1700.01 then ok := ok + 1; else f := f || ('T31 caixa ' || esp0 || ' -> ' || esp || ', esperado +1700.01'); end if;

  -- mesmo op_id: não duplica
  r := public.vsp_registrar_entrada(jsonb_build_object('tipo','devolucao_fornecedor','fornecedor','Hassan',
         'descricao','outra coisa','data',hoje,'val',9999), 't-ent-ok');
  select count(*) into n from public.entradas where op_id = 't-ent-ok';
  if (r->>'repetida')::boolean and n = 1 and public.vsp_caixa_esperado() = esp0 + 1700.01 then ok := ok + 1;
  else f := f || ('T32 retry duplicou ou mudou: ' || r::text); end if;

  -- data futura: não entra hoje
  r := public.vsp_registrar_entrada(jsonb_build_object('tipo','devolucao_fornecedor','fornecedor','Hassan',
         'descricao','futura','data',hoje + 5,'val',50), 't-ent-futura');
  if public.vsp_caixa_esperado() = esp0 + 1700.01 then ok := ok + 1; else f := f || text 'T33 entrada futura entrou no caixa de hoje'; end if;

  -- auditoria com o autor da sessão
  select count(*) into n from public.audit_log where acao = 'ENTRADA' and usuario = nome_v and detalhes like '%teste 012%';
  if n = 1 then ok := ok + 1; else f := f || ('T34 auditoria da entrada: ' || n); end if;

  -- não toca em venda, saída, razão do Victor nem estoque
  if (select count(*) from public.vendas) = cont_vendas and (select count(*) from public.saidas) = cont_saidas
     and (select count(*) from public.ledger_victor) = cont_ledger and public.vsp_saldo_victor() = saldo_vic
     and (select string_agg(id || ':' || caixas || '/' || frascos || '/' || custo_caixa, ',' order by id) from public.produtos) = estoque
  then ok := ok + 1; else f := f || text 'T35 a entrada mexeu em venda, saida, razao ou estoque'; end if;

  -- excluir: motivo obrigatório; com motivo sai do caixa; segunda vez é repetida
  begin
    perform public.vsp_excluir_entrada(id_e, '   ');
    f := f || text 'T40 excluiu sem motivo';
  exception when others then ok := ok + 1; end;
  r := public.vsp_excluir_entrada(id_e, 'teste');
  if not (r->>'repetida')::boolean and public.vsp_caixa_esperado() = esp0 then ok := ok + 1;
  else f := f || ('T41 exclusao: ' || r::text); end if;
  r := public.vsp_excluir_entrada(id_e, 'teste');
  if (r->>'repetida')::boolean then ok := ok + 1; else f := f || ('T42 excluir duas vezes: ' || r::text); end if;
  select count(*) into n from public.audit_log where acao = 'ENTRADA_EXCLUIDA' and usuario = nome_v and detalhes like '%motivo: teste%';
  if n = 1 then ok := ok + 1; else f := f || ('T43 auditoria da exclusao: ' || n); end if;
  execute 'reset role';

  raise exception 'RESULTADO_ENTRADAS: % ok, % falha(s) | caixa_esperado_antes=% | ator=% | %',
    ok, coalesce(array_length(f, 1), 0), esp0, nome_v, coalesce(array_to_string(f, ' || '), '');
end
$teste$;
