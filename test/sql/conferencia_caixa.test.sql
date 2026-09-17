-- ============================================================================
-- Testes da 007 — Conferência de Caixa, rodados DENTRO do banco real.
--
-- COMO RODA: node test/sql/montar.js [mutante] gera um arquivo com
--   (a) a migration 007 (ou uma cópia mutada) e (b) este bloco.
-- Cola-se no SQL Editor do Supabase e roda UMA vez. O bloco termina SEMPRE com
-- `raise exception 'RESULTADO_CONFERENCIA: ...'`: a mensagem traz o placar e a
-- exceção desfaz TUDO — a migration, as conferências de teste e as saídas de teste.
-- Nada fica gravado. Por isso dá para testar a 007 antes de aplicá-la.
--
-- Sessões simuladas como o PostgREST faz: role `authenticated`/`anon` e o JWT em
-- request.jwt.claims. Victor e Stefany são achados pelo e-mail em auth.users; o
-- "intruso" é um uid que não existe na allowlist.
-- ============================================================================
do $teste$
declare
  uv uuid; us uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  r jsonb; c public.conferencias_caixa%rowtype;
  esp numeric; esp_inicial numeric; esp2 numeric; esp_a numeric; esp_b numeric;
  n int; ok int := 0; f text[] := '{}'; msg text; nome_v text; nome_s text;
  id_igual bigint; id_falta bigint;
  cont_vendas int; cont_ledger int; saldo_vic numeric; estoque text; cont_saidas int;
  casas int;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  select id into us from auth.users where lower(email) = 'xsthexsouza@gmail.com';
  if uv is null or us is null then
    raise exception 'RESULTADO_CONFERENCIA: ABORTADO — uid de Victor ou Stefany nao encontrado';
  end if;

  esp_inicial := public.vsp_caixa_esperado_calc();
  select count(*) into casas from (
    select 1 from public.vendas where liq::numeric <> round(liq::numeric, 2)
    union all select 1 from public.saidas where val::numeric <> round(val::numeric, 2)) x;
  select count(*) into cont_vendas from public.vendas;
  select count(*) into cont_saidas from public.saidas;
  select count(*) into cont_ledger from public.ledger_victor;
  saldo_vic := public.vsp_saldo_victor();
  select string_agg(id || ':' || caixas || '/' || frascos, ',' order by id) into estoque from public.produtos;

  -- ---------------------------------------------------------------- estrutura
  select string_agg(pg_get_function_identity_arguments(p.oid), ' | ') into msg
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.proname = 'vsp_registrar_conferencia_caixa';
  if msg = 'p_saldo_real numeric, p_observacao text, p_op_id text' then ok := ok + 1;
  else f := f || ('T01 assinatura aceita mais do que saldo real/observacao/op_id: ' || coalesce(msg, '(nenhuma)')); end if;

  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public'
     and p.proname in ('vsp_registrar_conferencia_caixa','vsp_invalidar_conferencia_caixa','vsp_caixa_esperado','vsp_caixa_esperado_calc')
     and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public, pg_temp%';
  if n = 4 then ok := ok + 1; else f := f || ('T02 security definer + search_path fixo em ' || n || ' de 4 funcoes'); end if;

  if not has_function_privilege('anon', 'public.vsp_registrar_conferencia_caixa(numeric,text,text)', 'execute')
     and not has_function_privilege('anon', 'public.vsp_invalidar_conferencia_caixa(bigint,text)', 'execute')
     and not has_function_privilege('anon', 'public.vsp_caixa_esperado()', 'execute')
     and not has_function_privilege('authenticated', 'public.vsp_caixa_esperado_calc()', 'execute')
  then ok := ok + 1; else f := f || 'T03 anon executa alguma funcao, ou a conta interna esta exposta'; end if;

  if not has_table_privilege('anon', 'public.conferencias_caixa', 'select')
     and not has_table_privilege('authenticated', 'public.conferencias_caixa', 'insert')
     and not has_table_privilege('authenticated', 'public.conferencias_caixa', 'update')
     and not has_table_privilege('authenticated', 'public.conferencias_caixa', 'delete')
     and (select relrowsecurity from pg_class where oid = 'public.conferencias_caixa'::regclass)
  then ok := ok + 1; else f := f || 'T04 tabela gravavel pela API, legivel por anon, ou sem RLS'; end if;

  -- ---------------------------------------------------------------- anon
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin
    perform public.vsp_registrar_conferencia_caixa(1, 'anon', 't-anon');
    f := f || 'T10 anon registrou conferencia';
  exception when insufficient_privilege then ok := ok + 1;
            when others then f := f || ('T10 anon: erro inesperado ' || sqlerrm); end;
  begin
    perform count(*) from public.conferencias_caixa;
    f := f || 'T11 anon leu a tabela';
  exception when insufficient_privilege then ok := ok + 1; end;
  execute 'reset role';

  -- ---------------------------------------------------------------- intruso (logado, fora da allowlist)
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  begin
    perform public.vsp_registrar_conferencia_caixa(1, 'intruso', 't-intruso');
    f := f || 'T12 intruso registrou conferencia';
  exception when others then ok := ok + 1; end;
  begin
    perform public.vsp_caixa_esperado();
    f := f || 'T13 intruso leu o caixa esperado';
  exception when others then ok := ok + 1; end;
  select count(*) into n from public.conferencias_caixa;
  if n = 0 then ok := ok + 1; else f := f || 'T14 intruso ve conferencias'; end if;
  execute 'reset role';

  -- ---------------------------------------------------------------- Victor
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  nome_v := public.vsp_ator();
  esp := public.vsp_caixa_esperado();
  if esp = esp_inicial then ok := ok + 1; else f := f || ('T20 vsp_caixa_esperado ' || esp || ' <> calc ' || esp_inicial); end if;

  r := public.vsp_registrar_conferencia_caixa(esp, 'igual', 't-igual');
  id_igual := (r->'conferencia'->>'id')::bigint;
  if (r->'conferencia'->>'diferenca')::numeric = 0 and (r->'conferencia'->>'saldo_esperado')::numeric = esp
     and (r->>'repetida')::boolean = false and r->'conferencia'->>'created_by' = nome_v and nome_v = 'Victor'
  then ok := ok + 1; else f := f || ('T21 igual: ' || r::text); end if;

  r := public.vsp_registrar_conferencia_caixa(esp - 50, 'falta', 't-falta');
  id_falta := (r->'conferencia'->>'id')::bigint;
  if (r->'conferencia'->>'diferenca')::numeric = -50.00 then ok := ok + 1; else f := f || ('T22 falta de 50: ' || r::text); end if;
  r := public.vsp_registrar_conferencia_caixa(esp + 50, 'sobra', 't-sobra');
  if (r->'conferencia'->>'diferenca')::numeric = 50.00 then ok := ok + 1; else f := f || ('T23 sobra de 50: ' || r::text); end if;
  r := public.vsp_registrar_conferencia_caixa(esp - 0.01, 'centavo', 't-centavo');
  if (r->'conferencia'->>'diferenca')::numeric = -0.01 then ok := ok + 1; else f := f || ('T24 um centavo: ' || r::text); end if;
  r := public.vsp_registrar_conferencia_caixa(esp + 0.10, 'dez centavos', 't-dez');
  if (r->'conferencia'->>'diferenca')::numeric = 0.10 then ok := ok + 1; else f := f || ('T25 dez centavos: ' || r::text); end if;
  begin
    perform public.vsp_registrar_conferencia_caixa(100.001, 'tres casas', 't-tres');
    f := f || 'T26 aceitou 3 casas decimais';
  exception when others then ok := ok + 1; end;

  -- idempotência: mesmo op_id, valor diferente -> devolve a primeira, não grava outra
  r := public.vsp_registrar_conferencia_caixa(esp + 999, 'retry', 't-falta');
  select count(*) into n from public.conferencias_caixa where op_id = 't-falta';
  if (r->>'repetida')::boolean and (r->'conferencia'->>'id')::bigint = id_falta
     and (r->'conferencia'->>'saldo_real')::numeric = esp - 50 and n = 1
  then ok := ok + 1; else f := f || ('T27 retry: n=' || n || ' ' || r::text); end if;

  -- registrar não mexe no caixa, em venda, saída, razão ou estoque
  esp_a := public.vsp_caixa_esperado();
  r := public.vsp_registrar_conferencia_caixa(esp_a - 123.45, 'nao corrige', 't-nao-corrige');
  esp_b := public.vsp_caixa_esperado();
  if esp_a = esp_b
     and (select count(*) from public.vendas) = cont_vendas
     and (select count(*) from public.saidas) = cont_saidas
     and (select count(*) from public.ledger_victor) = cont_ledger
     and public.vsp_saldo_victor() = saldo_vic
     and (select string_agg(id || ':' || caixas || '/' || frascos, ',' order by id) from public.produtos) = estoque
  then ok := ok + 1; else f := f || ('T28 registrar alterou algo: caixa ' || esp_a || ' -> ' || esp_b); end if;

  -- auditoria com o ator da sessão
  select count(*) into n from public.audit_log
   where acao = 'CONFERENCIA_CAIXA' and usuario = 'Victor' and detalhes like '%conferência ' || id_igual;
  if n = 1 then ok := ok + 1; else f := f || ('T29 auditoria da conferencia ' || id_igual || ': ' || n); end if;

  -- direto na tabela, sem RPC
  begin
    insert into public.conferencias_caixa (saldo_esperado, saldo_real, diferenca, op_id, created_by)
    values (0, 0, 0, 't-direto', 'Victor');
    f := f || 'T30 authenticated inseriu direto na tabela';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    update public.conferencias_caixa set saldo_real = 0 where id = id_falta;
    f := f || 'T31 authenticated atualizou direto na tabela';
  exception when insufficient_privilege then ok := ok + 1; end;
  execute 'reset role';

  -- ---------------------------------------------------------------- Stefany tentando assinar como Victor
  perform set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', us::text, true);
  execute 'set local role authenticated';
  nome_s := public.vsp_ator();
  r := public.vsp_registrar_conferencia_caixa(esp, 'Victor', 't-stef');
  if r->'conferencia'->>'created_by' = 'Stefany' and nome_s = 'Stefany' then ok := ok + 1;
  else f := f || ('T40 ator da Stefany: ' || coalesce(r->'conferencia'->>'created_by', '?')); end if;
  begin
    execute $q$select public.vsp_registrar_conferencia_caixa(p_saldo_real => 1, p_observacao => '', p_op_id => 't-imp', p_usuario => 'Victor')$q$ into r;
    if r->'conferencia'->>'created_by' = 'Victor' then f := f || 'T41 IMPERSONACAO: Stefany gravou como Victor';
    else f := f || 'T41 a funcao aceita p_usuario (mesmo sem efeito, nao deveria existir)'; end if;
  exception when undefined_function then ok := ok + 1; end;
  begin
    execute $q$select public.vsp_registrar_conferencia_caixa(p_saldo_real => 1, p_observacao => '', p_op_id => 't-dita', p_saldo_esperado => 1)$q$ into r;
    f := f || ('T42 o cliente consegue ditar o esperado: ' || coalesce(r->'conferencia'->>'saldo_esperado', '?'));
  exception when undefined_function then ok := ok + 1; end;
  select count(*) into n from public.audit_log where acao = 'CONFERENCIA_CAIXA' and usuario = 'Stefany'
     and detalhes like '%conferência ' || (select id from public.conferencias_caixa where op_id = 't-stef');
  if n = 1 then ok := ok + 1; else f := f || 'T43 auditoria da Stefany'; end if;
  execute 'reset role';

  -- ---------------------------------------------------------------- foto: o caixa muda, a conferência não
  insert into public.saidas (id, tipo, socio, descricao, data, val, pgto)
  values (public.vsp_novo_id('saidas'), 'outros', null, 'TESTE conferencia (revertido)', current_date, 10.00, 'pix');
  esp2 := public.vsp_caixa_esperado_calc();
  select * into c from public.conferencias_caixa where id = id_igual;
  if esp2 = esp - 10 and c.saldo_esperado = esp and c.diferenca = 0 then ok := ok + 1;
  else f := f || ('T50 foto mudou: esperado agora ' || esp2 || ', foto ' || c.saldo_esperado || ' dif ' || c.diferenca); end if;

  -- esperado negativo (−3,49), qualquer que seja o caixa real de hoje
  insert into public.saidas (id, tipo, socio, descricao, data, val, pgto)
  values (public.vsp_novo_id('saidas'), 'outros', null, 'TESTE negativo (revertido)', current_date, esp2 + 3.49, 'pix');
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  r := public.vsp_registrar_conferencia_caixa(0, 'negativo', 't-neg');
  if public.vsp_caixa_esperado() = -3.49 and (r->'conferencia'->>'saldo_esperado')::numeric = -3.49
     and (r->'conferencia'->>'diferenca')::numeric = 3.49
  then ok := ok + 1; else f := f || ('T51 esperado negativo: ' || r::text); end if;

  -- invalidar: motivo obrigatório, números preservados, uma vez só
  begin
    perform public.vsp_invalidar_conferencia_caixa(id_falta, '  ');
    f := f || 'T60 invalidou sem motivo';
  exception when others then ok := ok + 1; end;
  r := public.vsp_invalidar_conferencia_caixa(id_falta, 'digitei errado');
  if r->'conferencia'->>'situacao' = 'invalidada' and r->'conferencia'->>'invalidada_por' = 'Victor'
     and (r->'conferencia'->>'saldo_real')::numeric = esp - 50 and (r->'conferencia'->>'diferenca')::numeric = -50
  then ok := ok + 1; else f := f || ('T61 invalidar: ' || r::text); end if;
  r := public.vsp_invalidar_conferencia_caixa(id_falta, 'de novo');
  if (r->>'repetida')::boolean and r->'conferencia'->>'motivo_invalidacao' = 'digitei errado' then ok := ok + 1;
  else f := f || ('T62 invalidar duas vezes: ' || r::text); end if;
  select count(*) into n from public.audit_log where acao = 'CONFERENCIA_CAIXA_INVALIDADA' and usuario = 'Victor';
  if n >= 1 then ok := ok + 1; else f := f || 'T63 auditoria da invalidacao'; end if;
  execute 'reset role';

  -- imutável até para o dono do banco
  begin
    update public.conferencias_caixa set saldo_esperado = saldo_esperado + 1, diferenca = diferenca - 1 where id = id_igual;
    f := f || 'T70 o dono do banco reescreveu a foto';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    delete from public.conferencias_caixa where id = id_igual;
    f := f || 'T71 conferencia apagada';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    update public.conferencias_caixa set situacao = 'valida', invalidada_em = null, invalidada_por = null, motivo_invalidacao = null where id = id_falta;
    f := f || 'T72 invalidada voltou a valida';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    insert into public.conferencias_caixa (saldo_esperado, saldo_real, diferenca, op_id, created_by)
    values (100, 90, 10, 't-conta-errada', 'Victor');
    f := f || 'T73 aceitou diferenca fora da convencao real - esperado';
  exception when check_violation then ok := ok + 1; end;

  raise exception 'RESULTADO_CONFERENCIA: % ok, % falha(s) | caixa_esperado_antes=% | linhas_com_mais_de_2_casas=% | ator_victor=% ator_stefany=% | %',
    ok, coalesce(array_length(f, 1), 0), esp_inicial, casas, nome_v, nome_s, coalesce(array_to_string(f, ' || '), '');
end
$teste$;
