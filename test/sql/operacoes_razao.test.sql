-- ============================================================================
-- Operações principais + razão do Victor + caixa esperado — rodado DENTRO do banco real.
-- Termina SEMPRE em exceção com o placar: nada fica gravado (venda, compra, cancelamento,
-- estorno, reembolso, saídas de teste — tudo desfeito).
--
--   esperado (com a 008 aplicada):  RESULTADO_OPERACOES: 34 ok, 0 falha(s)
--   antes da 008 (17/09/2026, banco real): 23 ok, 10 falhas — O5b estorno de compra nao estornou o
--   razao (+500), O7 reembolso pelo Financeiro nao creditou, O9 pagamento editado, O11a/b/c
--   lancamento futuro no caixa de hoje, O10a/b intruso leu o saldo e estornou; O6a/O6c em cascata.
--
-- Usa o produto TG que existe em produção; exige pelo menos 1 caixa em estoque.
-- ============================================================================
do $t$
declare
  uv uuid; us uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  ok int := 0; f text[] := '{}'; r jsonb; n int; m int;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  cx0 int; cx1 int; saldo0 numeric; saldo1 numeric; caixa0 numeric; caixa1 numeric;
  id_venda bigint := 990000000000001; id_venda_s bigint := 990000000000002; id_compra bigint := 990000000000003;
  id_saida bigint := 990000000000004; id_fut bigint := 990000000000005; id_venda_fut bigint := 990000000000006;
  v_venda jsonb; id_reemb bigint;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  select id into us from auth.users where lower(email) = 'xsthexsouza@gmail.com';
  if uv is null or us is null then raise exception 'RESULTADO_OPERACOES: ABORTADO — uids'; end if;
  select caixas into cx0 from public.produtos where id = 'TG';
  if coalesce(cx0, 0) < 1 then raise exception 'RESULTADO_OPERACOES: ABORTADO — TG sem estoque (%)', cx0; end if;

  v_venda := jsonb_build_object('id', id_venda, 'prod', 'TG', 'tipo', 'caixa', 'qtd', 1, 'val_orig', 100, 'desconto', 0,
    'val_final', 100, 'bruto', 100, 'custo', 1, 'taxa', 0, 'taxa_val', 0, 'taxa_quem', 'nos', 'liq', 100, 'lucro_liq', 99,
    'margem', 99, 'cliente', 'TESTE AUDITORIA', 'wpp', '', 'cli_id', '', 'data', hoje, 'obs', '', 'pgto', 'pix',
    'parcelas', '', 'vence_em', '', 'usuario', 'Stefany', 'lote', '');

  -- ================================================================ Victor
  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';
  saldo0 := public.vsp_saldo_victor();

  -- O1 venda: estoque baixa, ator = sessão (payload dizia Stefany), auditoria, idempotência
  r := public.vsp_registrar_venda(v_venda, 'aud-venda-1');
  select caixas into cx1 from public.produtos where id = 'TG';
  if cx1 = cx0 - 1 then ok := ok + 1; else f := f || ('O1a estoque ' || cx0 || ' -> ' || cx1); end if;
  if r->'venda'->>'usuario' = 'Victor' then ok := ok + 1; else f := f || ('O1b ator da venda ' || coalesce(r->'venda'->>'usuario','?')); end if;
  select count(*) into n from public.audit_log where acao = 'VENDA' and usuario = 'Victor' and detalhes like '%TESTE AUDITORIA%';
  if n = 1 then ok := ok + 1; else f := f || ('O1c auditoria da venda ' || n); end if;
  r := public.vsp_registrar_venda(v_venda, 'aud-venda-1');
  select count(*) into n from public.vendas where op_id = 'aud-venda-1';
  select caixas into cx1 from public.produtos where id = 'TG';
  if (r->>'repetida')::boolean and n = 1 and cx1 = cx0 - 1 then ok := ok + 1; else f := f || text 'O1d retry duplicou'; end if;

  -- O2 sem estoque: recusa e não mexe
  begin
    perform public.vsp_registrar_venda(jsonb_set(jsonb_set(v_venda, '{id}', to_jsonb(id_venda + 100)), '{qtd}', '99999'), 'aud-venda-grande');
    f := f || text 'O2 vendeu sem estoque';
  exception when others then
    if sqlerrm ilike '%estoque insuficiente%' then ok := ok + 1; else f := f || ('O2 erro inesperado: ' || sqlerrm); end if;
  end;

  -- O3 cancelamento: devolve estoque, ator da sessão, idempotente
  r := public.vsp_cancelar_venda(id_venda, 'teste auditoria', 'Stefany', 'aud-cancel-1');
  select caixas into cx1 from public.produtos where id = 'TG';
  if (r->'venda'->>'cancelada')::boolean and r->'venda'->>'cancelada_por' = 'Victor' and cx1 = cx0 then ok := ok + 1;
  else f := f || ('O3a cancelamento: ' || coalesce(r->'venda'->>'cancelada_por','?') || ' estoque ' || cx1); end if;
  r := public.vsp_cancelar_venda(id_venda, 'de novo', null, 'aud-cancel-2');
  if (r->>'repetida')::boolean then ok := ok + 1; else f := f || text 'O3b cancelar duas vezes'; end if;

  -- O4 compra: estoque, débito no razão, saldo, auditoria, idempotência
  r := public.vsp_registrar_compra(jsonb_build_object('id', id_compra, 'prod', 'TG', 'tipo', 'caixa', 'qtd', 1, 'cust_unit', 500,
        'frete', 0, 'forn', 'TESTE AUDITORIA', 'data', hoje, 'obs', '', 'lote', '', 'validade', '', 'nota_lote', ''), 'aud-compra-1');
  select caixas into cx1 from public.produtos where id = 'TG';
  if cx1 = cx0 + 1 then ok := ok + 1; else f := f || ('O4a estoque apos compra ' || cx1); end if;
  if public.vsp_saldo_victor() = saldo0 + 500 then ok := ok + 1; else f := f || ('O4b saldo apos compra ' || public.vsp_saldo_victor()); end if;
  select count(*) into n from public.ledger_victor where origem_tipo = 'reposicao' and origem_id = id_compra and direcao = 'debito';
  if n = 1 then ok := ok + 1; else f := f || ('O4c debitos da compra ' || n); end if;
  r := public.vsp_registrar_compra(jsonb_build_object('id', id_compra, 'prod', 'TG', 'tipo', 'caixa', 'qtd', 1, 'cust_unit', 500,
        'frete', 0, 'forn', 'TESTE AUDITORIA', 'data', hoje), 'aud-compra-1');
  if (r->>'repetida')::boolean and public.vsp_saldo_victor() = saldo0 + 500 then ok := ok + 1; else f := f || text 'O4d retry da compra'; end if;

  -- O5 estorno da compra: estoque volta e o débito é estornado (bug C)
  r := public.vsp_estornar_compra(id_compra, 'Stefany', 'aud-estorno-1');
  select caixas into cx1 from public.produtos where id = 'TG';
  if cx1 = cx0 and not exists (select 1 from public.reposicoes where id = id_compra) then ok := ok + 1;
  else f := f || ('O5a estorno: estoque ' || cx1); end if;
  if public.vsp_saldo_victor() = saldo0 then ok := ok + 1;
  else f := f || ('O5b ESTORNO DE COMPRA NAO ESTORNOU O RAZAO: saldo ' || public.vsp_saldo_victor() || ' esperado ' || saldo0); end if;
  select count(*) into n from public.ledger_victor where origem_tipo = 'reposicao' and origem_id = id_compra;
  if n = 1 then ok := ok + 1; else f := f || text 'O5c o movimento original do razao sumiu (tem de ficar, compensado)'; end if;

  -- O6 reembolso pela RPC: uma saída, UM crédito, saldo −100, idempotente
  r := public.vsp_reembolsar_victor(100, hoje, 'TESTE AUDITORIA reembolso', 'pix', 'aud-reemb-1');
  id_reemb := (r->'saida'->>'id')::bigint;
  if public.vsp_saldo_victor() = saldo0 - 100 then ok := ok + 1; else f := f || ('O6a saldo apos reembolso ' || public.vsp_saldo_victor()); end if;
  select count(*) into n from public.ledger_victor where op_id = 'aud-reemb-1' or (origem_tipo = 'saida' and origem_id = (r->'saida'->>'id')::bigint);
  if n = 1 then ok := ok + 1; else f := f || ('O6b creditos do reembolso ' || n); end if;
  r := public.vsp_reembolsar_victor(100, hoje, 'TESTE AUDITORIA reembolso', 'pix', 'aud-reemb-1');
  if (r->>'repetida')::boolean and public.vsp_saldo_victor() = saldo0 - 100 then ok := ok + 1; else f := f || text 'O6c retry do reembolso'; end if;
  select count(*) into n from public.audit_log where acao = 'REEMBOLSO_VICTOR' and usuario = 'Victor' and detalhes like '%TESTE AUDITORIA%';
  if n = 1 then ok := ok + 1; else f := f || ('O6d auditoria do reembolso ' || n); end if;
  saldo1 := public.vsp_saldo_victor();

  -- O7 reembolso pelo caminho do app (Financeiro -> "Pagamento fornecedor" = insert em saidas) (bug A)
  insert into public.saidas (id, tipo, socio, descricao, data, val, pgto)
  values (id_saida, 'fornecedor', 'Hassan', 'TESTE AUDITORIA pagamento', hoje, 50, 'pix');
  if public.vsp_saldo_victor() = saldo1 - 50 then ok := ok + 1;
  else f := f || ('O7 REEMBOLSO PELO FINANCEIRO NAO CREDITOU O RAZAO: saldo ' || public.vsp_saldo_victor() || ' esperado ' || (saldo1 - 50)); end if;

  -- O9 editar pagamento ao fornecedor: bloqueado (o razão já registrou)
  begin
    update public.saidas set val = 5000 where id = id_saida;
    get diagnostics n = row_count;
    if n = 0 then f := f || text 'O9 update nao afetou linha (policy?)'; else f := f || ('O9 PAGAMENTO EDITADO: saldo agora ' || public.vsp_saldo_victor()); end if;
  exception when insufficient_privilege then ok := ok + 1; end;

  -- O8 excluir o pagamento pelo caminho do app (delete em saidas): crédito estornado (bug B)
  delete from public.saidas where id = id_saida;
  get diagnostics n = row_count;
  if n = 1 and public.vsp_saldo_victor() = saldo1 then ok := ok + 1;
  else f := f || ('O8 EXCLUSAO NAO ESTORNOU O CREDITO: linhas ' || n || ' saldo ' || public.vsp_saldo_victor() || ' esperado ' || saldo1); end if;

  -- O8b excluir um pagamento que JA tem credito no razao (o reembolso do O6): o credito tem de ser estornado
  delete from public.saidas where id = id_reemb;
  if public.vsp_saldo_victor() = saldo1 + 100 then ok := ok + 1;
  else f := f || ('O8b EXCLUSAO DO REEMBOLSO NAO ESTORNOU O CREDITO: saldo ' || public.vsp_saldo_victor() || ' esperado ' || (saldo1 + 100)); end if;

  -- O11 caixa esperado ignora lançamento futuro (bug F); o de hoje conta
  caixa0 := public.vsp_caixa_esperado();
  insert into public.saidas (id, tipo, socio, descricao, data, val, pgto) values (id_fut, 'outros', null, 'TESTE AUDITORIA futura', hoje + 10, 77, 'pix');
  if public.vsp_caixa_esperado() = caixa0 then ok := ok + 1;
  else f := f || ('O11a SAIDA FUTURA ENTROU NO CAIXA DE HOJE: ' || caixa0 || ' -> ' || public.vsp_caixa_esperado()); end if;
  r := public.vsp_registrar_venda(jsonb_set(jsonb_set(jsonb_set(v_venda, '{id}', to_jsonb(id_venda_fut)), '{data}', to_jsonb(hoje + 10)), '{cliente}', '"TESTE FUTURA"'), 'aud-venda-fut');
  if public.vsp_caixa_esperado() = caixa0 then ok := ok + 1;
  else f := f || ('O11b VENDA FUTURA ENTROU NO CAIXA DE HOJE: ' || caixa0 || ' -> ' || public.vsp_caixa_esperado()); end if;
  -- O11c e sobre a FORMULA do caixa, nao sobre permissao: desde a 010 authenticated nao
  -- tem UPDATE em saidas (o app nunca edita saida — ele apaga e relanca), entao a data e
  -- movida como dono do banco.
  execute 'reset role';
  update public.saidas set data = hoje where id = id_fut;
  if public.vsp_caixa_esperado() = caixa0 - 77 then ok := ok + 1; else f := f || ('O11c saida de hoje nao entrou: ' || public.vsp_caixa_esperado()); end if;

  -- ================================================================ Stefany
  perform set_config('request.jwt.claims', json_build_object('sub', us, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', us::text, true);
  execute 'set local role authenticated';
  r := public.vsp_registrar_venda(jsonb_set(jsonb_set(v_venda, '{id}', to_jsonb(id_venda_s)), '{usuario}', '"Victor"'), 'aud-venda-s');
  if r->'venda'->>'usuario' = 'Stefany' then ok := ok + 1; else f := f || ('O12 Stefany assinou como ' || coalesce(r->'venda'->>'usuario','?')); end if;
  if public.vsp_saldo_victor() is not null then ok := ok + 1; else f := f || text 'O13 Stefany nao le o saldo'; end if;
  execute 'reset role';

  -- ================================================================ intruso (conta sem allowlist) (bug D)
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  begin
    perform public.vsp_saldo_victor();
    f := f || text 'O10a INTRUSO LEU O SALDO DO VICTOR';
  exception when others then ok := ok + 1; end;
  begin
    perform public.vsp_ledger_estornar_origem('reposicao', 1, 'intruso');
    f := f || text 'O10b INTRUSO ESTORNOU MOVIMENTO DO RAZAO';
  exception when others then ok := ok + 1; end;
  begin
    perform public.vsp_registrar_venda(jsonb_set(v_venda, '{id}', to_jsonb(id_venda + 200)), 'aud-intruso');
    f := f || text 'O10c intruso vendeu';
  exception when others then ok := ok + 1; end;
  begin
    perform public.vsp_reembolsar_victor(1, hoje, 'intruso', 'pix', 'aud-intruso-r');
    f := f || text 'O10d intruso reembolsou';
  exception when others then ok := ok + 1; end;
  select count(*) into n from public.vendas; select count(*) into m from public.ledger_victor;
  if n = 0 and m = 0 then ok := ok + 1; else f := f || ('O10e intruso ve ' || n || ' vendas e ' || m || ' movimentos'); end if;
  execute 'reset role';

  -- ================================================================ anon
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin perform public.vsp_saldo_victor(); f := f || text 'O14a anon leu o saldo';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin perform public.vsp_registrar_venda(v_venda, 'aud-anon'); f := f || text 'O14b anon vendeu';
  exception when insufficient_privilege then ok := ok + 1; end;
  execute 'reset role';

  raise exception 'RESULTADO_OPERACOES: % ok, % falha(s) | %', ok, coalesce(array_length(f,1),0), coalesce(array_to_string(f,' || '),'');
end $t$;
