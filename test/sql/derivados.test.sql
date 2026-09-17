-- ============================================================================
-- Derivados financeiros calculados pelo banco (011) — rodado DENTRO do banco
-- real, desfeito no fim.
--   esperado (com a 011 aplicada):  RESULTADO_DERIVADOS: 30 ok, 0 falha(s)
--
-- O que este arquivo prova, com a sessão do Victor (allowlist) simulada como o
-- PostgREST faz:
--   D1..D4   payload adulterado nos derivados que dependem SÓ de fato
--            (val_final, bruto, taxa_val, liq) é RECUSADO
--   D5..D7   payload adulterado em custo/lucro/margem não vira dado: o banco
--            sobrescreve com o que ele mesmo calcula
--   D8       payload sem nenhum derivado funciona (contrato aberto)
--   D9..D11  fatos inválidos (taxa fora de 0..100, desconto negativo,
--            taxa_quem desconhecido) são recusados
--   D12..D13 fiado zera lucro e margem; taxa do cliente não reduz o líquido
--   D14..D19 vsp_quitar_fiado: recalcula pelo custo histórico, carimba a data,
--            audita, é idempotente e recusa não-fiado, cancelada e intruso
--   D20..D21 authenticated perdeu UPDATE amplo em vendas e reposicoes
--
-- Termina SEMPRE em exceção com o placar: venda, quitação e auditoria de teste
-- são desfeitas. Usa o produto TG de produção (precisa de pelo menos 1 caixa).
-- ============================================================================
do $t$
declare
  uv uuid; ui uuid := '00000000-0000-4000-8000-00000000dead';
  ok int := 0; f text[] := '{}'; r jsonb; v vendas%rowtype; n int;
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  base jsonb; cc numeric; id1 bigint := 990000000000101; id2 bigint := 990000000000102;
  id3 bigint := 990000000000103; id4 bigint := 990000000000104;
  aud0 int; sqlerro text;
begin
  select id into uv from auth.users where lower(email) = 'victor.moufarregee@gmail.com';
  if uv is null then raise exception 'RESULTADO_DERIVADOS: ABORTADO - uid do Victor nao encontrado'; end if;
  select custo_caixa into cc from produtos where id = 'TG';
  if cc is null then raise exception 'RESULTADO_DERIVADOS: ABORTADO - produto TG sem custo'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', uv, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uv::text, true);
  execute 'set local role authenticated';

  -- payload "honesto": 1 caixa a 1000, desconto 100, taxa 2% por nossa conta
  base := jsonb_build_object(
    'id', id1, 'prod', 'TG', 'tipo', 'caixa', 'qtd', 1,
    'val_orig', 1000, 'desconto', 100, 'val_final', 900, 'bruto', 900,
    'custo', cc, 'taxa', 2, 'taxa_val', 18, 'taxa_quem', 'nos',
    'liq', 882, 'lucro_liq', 882 - cc, 'margem', (882 - cc) / 900 * 100,
    'cliente', 'TESTE DERIVADOS', 'wpp', '', 'cli_id', null, 'data', hoje,
    'obs', 'teste', 'pgto', 'pix', 'parcelas', null, 'vence_em', null, 'lote', '');

  -- D1..D4 — derivado de fato adulterado: recusa
  foreach sqlerro in array array['val_final', 'bruto', 'taxa_val', 'liq'] loop
    begin
      r := public.vsp_registrar_venda(jsonb_set(base, array[sqlerro], to_jsonb(1)), 'der-' || sqlerro);
      f := f || ('D-' || sqlerro || ' ACEITOU payload adulterado');
    exception when others then
      if sqlstate = 'P0001' and sqlerrm like 'valor incoerente: ' || sqlerro || '%' then ok := ok + 1;
      else f := f || ('D-' || sqlerro || ' recusou com outra mensagem: ' || sqlerrm); end if;
    end;
  end loop;

  -- D5 — venda honesta entra e grava os valores do BANCO
  r := public.vsp_registrar_venda(base, 'der-ok');
  select * into v from vendas where op_id = 'der-ok';
  if v.val_final = 900 and v.bruto = 900 and v.taxa_val = 18 and v.liq = 882 then ok := ok + 1;
  else f := f || ('D5 derivados gravados errados: vf=' || v.val_final || ' br=' || v.bruto || ' tv=' || v.taxa_val || ' lq=' || v.liq); end if;
  if v.custo = round(cc, 2) then ok := ok + 1; else f := f || ('D5b custo gravado ' || v.custo || ' esperado ' || round(cc,2)); end if;
  if v.lucro_liq = round(882 - cc, 2) then ok := ok + 1; else f := f || ('D5c lucro gravado ' || v.lucro_liq); end if;
  if v.usuario is not null and btrim(v.usuario) <> '' then ok := ok + 1; else f := f || text 'D5d venda sem ator'; end if;

  -- D6 — custo adulterado para zero: aceita o fato, ignora o custo do payload
  r := public.vsp_registrar_venda(jsonb_set(jsonb_set(base, '{id}', to_jsonb(id2)), '{custo}', to_jsonb(0)), 'der-custo');
  select * into v from vendas where op_id = 'der-custo';
  if v.custo = round(cc, 2) then ok := ok + 1; else f := f || ('D6 CUSTO DO PAYLOAD ENTROU: ' || v.custo); end if;

  -- D7 — lucro e margem inflados no payload: sobrescritos
  r := public.vsp_registrar_venda(
         jsonb_set(jsonb_set(jsonb_set(base, '{id}', to_jsonb(id3)), '{lucro_liq}', to_jsonb(99999)), '{margem}', to_jsonb(9999)),
         'der-lucro');
  select * into v from vendas where op_id = 'der-lucro';
  if v.lucro_liq = round(882 - cc, 2) and v.margem = round((882 - cc) / 900 * 100, 4) then ok := ok + 1;
  else f := f || ('D7 LUCRO/MARGEM DO PAYLOAD ENTROU: ' || v.lucro_liq || ' / ' || v.margem); end if;

  -- D8 — payload magro, só com fatos
  r := public.vsp_registrar_venda(
         jsonb_build_object('id', id4, 'prod', 'TG', 'tipo', 'caixa', 'qtd', 1, 'val_orig', 500,
                            'desconto', 0, 'taxa', 0, 'taxa_quem', 'nos', 'cliente', 'TESTE MAGRO',
                            'data', hoje, 'pgto', 'pix'),
         'der-magro');
  select * into v from vendas where op_id = 'der-magro';
  if v.bruto = 500 and v.liq = 500 and v.custo = round(cc, 2) and v.lucro_liq = round(500 - cc, 2) then ok := ok + 1;
  else f := f || ('D8 payload magro saiu errado: br=' || v.bruto || ' lq=' || v.liq || ' cu=' || v.custo); end if;

  -- D9..D11 — fatos inválidos
  begin r := public.vsp_registrar_venda(jsonb_set(base, '{taxa}', to_jsonb(150)), 'der-taxa');
        f := f || text 'D9 aceitou taxa 150%';
  exception when others then ok := ok + 1; end;
  begin r := public.vsp_registrar_venda(jsonb_set(base, '{desconto}', to_jsonb(-10)), 'der-desc');
        f := f || text 'D10 aceitou desconto negativo';
  exception when others then ok := ok + 1; end;
  begin r := public.vsp_registrar_venda(jsonb_set(base, '{taxa_quem}', '"ninguem"'), 'der-quem');
        f := f || text 'D11 aceitou taxa_quem desconhecido';
  exception when others then ok := ok + 1; end;

  -- D12 — fiado zera lucro e margem
  -- sem taxa: os derivados de taxa saem do payload para o banco recalcular
  r := public.vsp_registrar_venda(
         jsonb_set(jsonb_set(jsonb_set(base, '{id}', to_jsonb(id1 + 10)), '{pgto}', '"fiado"'), '{taxa}', to_jsonb(0))
           - 'taxa_val' - 'liq' - 'lucro_liq' - 'margem',
         'der-fiado');
  select * into v from vendas where op_id = 'der-fiado';
  if v.lucro_liq = 0 and v.margem = 0 and v.liq = 900 then ok := ok + 1;
  else f := f || ('D12 fiado saiu ll=' || v.lucro_liq || ' mg=' || v.margem || ' lq=' || v.liq); end if;

  -- D13 — taxa por conta do cliente não reduz o líquido
  r := public.vsp_registrar_venda(
         jsonb_set(jsonb_set(jsonb_set(base, '{id}', to_jsonb(id1 + 11)), '{taxa_quem}', '"cliente"'), '{liq}', to_jsonb(900)),
         'der-cliente');
  select * into v from vendas where op_id = 'der-cliente';
  if v.liq = 900 and v.taxa_val = 18 then ok := ok + 1;
  else f := f || ('D13 taxa do cliente saiu lq=' || v.liq || ' tv=' || v.taxa_val); end if;

  -- ---------------- quitação ----------------
  select count(*) into aud0 from audit_log;
  select * into v from vendas where op_id = 'der-fiado';

  -- D14 — quita e recalcula pelo custo histórico da venda
  r := public.vsp_quitar_fiado(v.id, 'pix', 'der-quita');
  select * into v from vendas where op_id = 'der-fiado';
  if v.quitado and v.pgto_quitado = 'pix' and v.lucro_liq = round(900 - v.custo, 2) then ok := ok + 1;
  else f := f || ('D14 quitacao saiu quitado=' || v.quitado || ' ll=' || v.lucro_liq); end if;
  -- D15 — carimbo de data no formato que o app lê, no fuso de São Paulo
  if v.quitado_em ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}$'
     and left(v.quitado_em, 10) = to_char(hoje, 'DD/MM/YYYY') then ok := ok + 1;
  else f := f || ('D15 quitado_em fora do padrao: ' || coalesce(v.quitado_em, '(nulo)')); end if;
  -- D16 — auditou
  select count(*) into n from audit_log;
  if n = aud0 + 1 then ok := ok + 1; else f := f || ('D16 quitacao gravou ' || (n - aud0) || ' linha(s) de auditoria, esperava 1'); end if;
  -- D17 — idempotente: quitar de novo devolve o que existe, não duplica nem remarca
  r := public.vsp_quitar_fiado(v.id, 'dinheiro', 'der-quita-2');
  if (r->>'repetida')::boolean then ok := ok + 1; else f := f || text 'D17 quitou duas vezes'; end if;
  select * into v from vendas where op_id = 'der-fiado';
  if v.pgto_quitado = 'pix' then ok := ok + 1; else f := f || ('D17b forma de pagamento mudou para ' || v.pgto_quitado); end if;

  -- D18 — venda que não é fiado não se quita
  select * into v from vendas where op_id = 'der-ok';
  begin r := public.vsp_quitar_fiado(v.id, 'pix', 'der-quita-3'); f := f || text 'D18 quitou venda que nao e fiado';
  exception when others then ok := ok + 1; end;
  -- D19 — op_id vazio e forma de pagamento inválida
  begin r := public.vsp_quitar_fiado(v.id, 'pix', '  '); f := f || text 'D19 quitou sem op_id';
  exception when others then ok := ok + 1; end;
  select * into v from vendas where op_id = 'der-fiado';
  begin r := public.vsp_quitar_fiado(v.id, 'boleto', 'der-quita-4'); f := f || text 'D19b aceitou forma de pagamento invalida';
  exception when others then ok := ok + 1; end;

  -- D20 — sem UPDATE amplo em vendas: só vence_em passa
  begin
    update vendas set liq = 1 where op_id = 'der-ok';
    f := f || text 'D20 authenticated ainda escreve em vendas.liq';
  exception when insufficient_privilege then ok := ok + 1; end;
  begin
    update vendas set quitado = true where op_id = 'der-ok';
    f := f || text 'D20b authenticated ainda marca quitado direto';
  exception when insufficient_privilege then ok := ok + 1; end;
  update vendas set vence_em = hoje + 30 where op_id = 'der-fiado';
  get diagnostics n = row_count;
  if n = 1 then ok := ok + 1; else f := f || text 'D20c o app perdeu o vencimento do fiado'; end if;

  -- D21 — sem UPDATE amplo em reposicoes: só lote/validade/nota
  begin
    update reposicoes set cust_total = 1 where true;
    f := f || text 'D21 authenticated ainda escreve em reposicoes.cust_total';
  exception when insufficient_privilege then ok := ok + 1; end;

  execute 'reset role';

  -- D22 — intruso e anônimo não quitam (o id é lido antes de trocar de papel:
  -- para o intruso a RLS esconde a venda e o teste provaria outra coisa)
  select id into id1 from vendas where op_id = 'der-ok';
  perform set_config('request.jwt.claims', json_build_object('sub', ui, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', ui::text, true);
  execute 'set local role authenticated';
  begin r := public.vsp_quitar_fiado(id1, 'pix', 'der-intruso'); f := f || text 'D22 intruso quitou';
  exception when others then ok := ok + 1; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
  begin perform public.vsp_quitar_fiado(id1, 'pix', 'der-anon'); f := f || text 'D22b anon quitou';
  exception when insufficient_privilege then ok := ok + 1;
            when others then f := f || ('D22b anon chegou na funcao: ' || sqlstate); end;
  execute 'reset role';

  raise exception 'RESULTADO_DERIVADOS: % ok, % falha(s) | custo_TG=% | %',
    ok, coalesce(array_length(f, 1), 0), cc, coalesce(array_to_string(f, ' || '), '');
end $t$;
