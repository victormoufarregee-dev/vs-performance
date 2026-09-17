-- ============================================================================
-- 011 — O banco calcula os derivados da venda; o app só informa fatos
--
-- POR QUE: até aqui `vsp_registrar_venda` gravava val_final, bruto, custo,
-- taxa_val, liq, lucro_liq e margem exatamente como vieram do navegador. O banco
-- conferia quantidade, tipo, produto e estoque — nenhum valor em dinheiro. Isso
-- deixa dois buracos:
--   1) sessão adulterada: quem tem um token válido POSTa bruto=1 e lucro=10000;
--   2) bug de cliente: um erro de leitura de número (numBR) grava dinheiro errado
--      sem ninguém perceber.
-- A compra (vsp_registrar_compra, 006) já fazia certo: ignora `cust_total` do
-- payload e usa qtd*cust_unit+frete. Esta migration leva a venda para o mesmo
-- padrão, e fecha o mesmo buraco na quitação do fiado — que até aqui era um
-- PATCH direto em `vendas` mandando lucro_liq e margem do navegador.
--
-- REGRA: fato vem do app (produto, tipo, qtd, val_orig, desconto, taxa,
-- taxa_quem, pgto, cliente, data, obs, lote, vencimento). Derivado é do banco:
--   val_final = max(0, val_orig - desconto)
--   bruto     = qtd * val_final
--   custo     = qtd * custo do produto NO MOMENTO (linha travada), nunca o payload
--   taxa_val  = bruto * taxa/100
--   liq       = taxa_quem='nos' ? bruto - taxa_val : bruto
--   lucro_liq = pgto='fiado' ? 0 : liq - custo
--   margem    = pgto='fiado' ? 0 : lucro_liq/bruto*100
-- Dinheiro arredondado em 2 casas, margem em 4 — como a compra já fazia.
--
-- CONSISTÊNCIA: se o payload trouxer um derivado que depende SÓ de fatos
-- (val_final, bruto, taxa_val, liq) divergindo mais de 1 centavo do que o banco
-- calcula, a venda é RECUSADA com o nome do campo — é adulteração ou bug de
-- cliente, e nos dois casos gravar seria pior. Os derivados que dependem do custo
-- (custo, lucro_liq, margem) são só sobrescritos: o app pode estar com o custo
-- médio velho em cache, e isso é legítimo, não é ataque.
--
-- CONTRATO EXTERNO: assinatura e retorno de vsp_registrar_venda não mudam.
-- Um cliente que não mande os derivados passa a funcionar também.
--
-- HISTÓRICO: nenhuma linha existente é tocada. As 65 vendas de produção conferem
-- em val_final, bruto, taxa_val, liq e lucro_liq; `custo` difere em 63 delas
-- porque o custo médio do produto mudou desde a venda (é o custo histórico, está
-- certo), e `margem` difere em 12 vendas antigas que gravaram markup sobre o
-- custo em vez de margem sobre a venda. Nada disso é reescrito.
--
-- ROLLBACK no fim do arquivo.
-- ============================================================================

create or replace function public.vsp_registrar_venda(p_venda jsonb, p_op_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_ja vendas%rowtype; v_prod produtos%rowtype;
  v_tipo text := p_venda->>'tipo';
  v_qtd  int  := (p_venda->>'qtd')::int;
  v_fpc int; v_precisa int; v_afetou int; v_nova vendas%rowtype;
  v_ator text := public.vsp_ator();   -- SESSAO, nunca o payload
  v_pgto text := p_venda->>'pgto';
  v_quem text := coalesce(p_venda->>'taxa_quem', 'nos');
  v_val_orig numeric; v_desc numeric; v_taxa numeric;
  v_val_final numeric; v_bruto numeric; v_custo numeric; v_unit numeric;
  v_taxa_val numeric; v_liq numeric; v_lucro numeric; v_margem numeric;
  v_dito numeric;
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if v_qtd is null or v_qtd <= 0 then raise exception 'quantidade invalida'; end if;
  if v_tipo is null or v_tipo not in ('caixa','frasco') then raise exception 'tipo invalido: %', coalesce(v_tipo,'(nulo)'); end if;
  select * into v_ja from vendas where op_id = p_op_id;
  if found then return jsonb_build_object('repetida', true, 'venda', to_jsonb(v_ja)); end if;
  select * into v_prod from produtos where id = p_venda->>'prod' for update;
  if not found then raise exception 'produto % nao existe', coalesce(p_venda->>'prod','(nulo)'); end if;

  -- ---- fatos ----
  v_val_orig := round(coalesce((p_venda->>'val_orig')::numeric, 0), 2);
  v_desc     := round(coalesce((p_venda->>'desconto')::numeric, 0), 2);
  v_taxa     := coalesce((p_venda->>'taxa')::numeric, 0);
  if v_val_orig < 0 then raise exception 'preco nao pode ser negativo'; end if;
  if v_desc < 0 then raise exception 'desconto nao pode ser negativo'; end if;
  if v_taxa < 0 or v_taxa > 100 then raise exception 'taxa fora de 0..100: %', v_taxa; end if;
  if v_quem not in ('nos','cliente') then raise exception 'taxa_quem invalido: %', v_quem; end if;

  -- ---- derivados, calculados aqui ----
  v_val_final := round(greatest(0, v_val_orig - v_desc), 2);
  v_bruto     := round(v_qtd * v_val_final, 2);
  v_unit      := case when v_tipo = 'caixa' then coalesce(v_prod.custo_caixa,0) else coalesce(v_prod.custo_frasco,0) end;
  v_custo     := round(v_qtd * v_unit, 2);
  v_taxa_val  := round(v_bruto * v_taxa / 100, 2);
  v_liq       := round(case when v_quem = 'nos' then v_bruto - v_taxa_val else v_bruto end, 2);
  v_lucro     := round(case when v_pgto = 'fiado' then 0 else v_liq - v_custo end, 2);
  v_margem    := round(case when v_pgto = 'fiado' or v_bruto = 0 then 0 else v_lucro / v_bruto * 100 end, 4);

  -- ---- o que o app disse tem de bater (só os que dependem de fato) ----
  v_dito := (p_venda->>'val_final')::numeric;
  if v_dito is not null and abs(v_dito - v_val_final) > 0.01 then
    raise exception 'valor incoerente: val_final enviado %, calculado %', v_dito, v_val_final; end if;
  v_dito := (p_venda->>'bruto')::numeric;
  if v_dito is not null and abs(v_dito - v_bruto) > 0.01 then
    raise exception 'valor incoerente: bruto enviado %, calculado %', v_dito, v_bruto; end if;
  v_dito := (p_venda->>'taxa_val')::numeric;
  if v_dito is not null and abs(v_dito - v_taxa_val) > 0.01 then
    raise exception 'valor incoerente: taxa_val enviado %, calculado %', v_dito, v_taxa_val; end if;
  v_dito := (p_venda->>'liq')::numeric;
  if v_dito is not null and abs(v_dito - v_liq) > 0.01 then
    raise exception 'valor incoerente: liq enviado %, calculado %', v_dito, v_liq; end if;

  v_fpc := greatest(coalesce(v_prod.frascos_por_caixa,1),1);
  if v_tipo = 'caixa' then
    update produtos set caixas = caixas - v_qtd where id = v_prod.id and caixas >= v_qtd;
  else
    v_precisa := v_qtd;
    if v_prod.frascos >= v_precisa then
      update produtos set frascos = frascos - v_precisa where id = v_prod.id and frascos >= v_precisa;
    else
      update produtos
         set caixas  = caixas - ceil((v_precisa - frascos)::numeric / v_fpc)::int,
             frascos = ceil((v_precisa - frascos)::numeric / v_fpc)::int * v_fpc - (v_precisa - frascos)
       where id = v_prod.id and caixas >= ceil((v_precisa - frascos)::numeric / v_fpc)::int;
    end if;
  end if;
  get diagnostics v_afetou = row_count;
  if v_afetou = 0 then raise exception 'estoque insuficiente de %: pedido % %(s)', v_prod.nome, v_qtd, v_tipo; end if;

  insert into vendas (id, prod, tipo, qtd, val_orig, desconto, val_final, bruto, custo, taxa,
                      taxa_val, taxa_quem, liq, lucro_liq, margem, cliente, wpp, cli_id, data,
                      obs, pgto, parcelas, quitado, cancelada, vence_em, usuario, lote, op_id)
  select (p_venda->>'id')::bigint, p_venda->>'prod', v_tipo, v_qtd,
         v_val_orig, v_desc, v_val_final, v_bruto, v_custo, v_taxa,
         v_taxa_val, v_quem, v_liq, v_lucro, v_margem, p_venda->>'cliente',
         p_venda->>'wpp', nullif(p_venda->>'cli_id','')::bigint, (p_venda->>'data')::date,
         p_venda->>'obs', v_pgto, nullif(p_venda->>'parcelas','')::int,
         false, false, nullif(p_venda->>'vence_em','')::date, v_ator, p_venda->>'lote', p_op_id
  returning * into v_nova;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'VENDA',
          concat_ws(' - ', v_prod.nome, (p_venda->>'cliente'), v_tipo || ' x' || v_qtd,
                    'R$ ' || to_char(v_bruto,'FM999999990.00'), v_pgto), 'servidor');
  select * into v_prod from produtos where id = v_prod.id;
  return jsonb_build_object('repetida', false, 'venda', to_jsonb(v_nova), 'produto', to_jsonb(v_prod));
end $fn$;
revoke all on function public.vsp_registrar_venda(jsonb,text) from public, anon;
grant execute on function public.vsp_registrar_venda(jsonb,text) to authenticated;

-- ---------------------------------------------------------------------------
-- QUITAÇÃO DE FIADO — era PATCH direto em `vendas` com lucro_liq e margem vindos
-- do navegador. Vira RPC: o banco recalcula o lucro pelo custo HISTÓRICO gravado
-- na venda (não pelo custo médio de hoje), carimba a data no fuso de São Paulo e
-- audita com o ator da sessão. Idempotente: quitar de novo devolve o que existe.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_quitar_fiado(p_id bigint, p_pgto text, p_op_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_v vendas%rowtype; v_nova vendas%rowtype;
  v_lucro numeric; v_margem numeric; v_quando text;
  v_ator text := public.vsp_ator();
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if p_id is null then raise exception 'id da venda obrigatorio'; end if;
  if coalesce(btrim(p_pgto),'') = '' then raise exception 'forma de pagamento obrigatoria'; end if;
  if p_pgto not in ('pix','credito','debito','dinheiro','parcelado') then
    raise exception 'forma de pagamento invalida: %', p_pgto; end if;

  select * into v_v from vendas where id = p_id for update;
  if not found then raise exception 'venda % nao existe', p_id; end if;
  if coalesce(v_v.cancelada, false) then raise exception 'venda cancelada nao se quita'; end if;
  if v_v.pgto is distinct from 'fiado' then raise exception 'venda % nao e fiado', p_id; end if;
  -- retry do mesmo clique: devolve o que já está gravado
  if coalesce(v_v.quitado, false) then
    return jsonb_build_object('repetida', true, 'venda', to_jsonb(v_v));
  end if;

  v_lucro  := round(coalesce(v_v.liq,0) - coalesce(v_v.custo,0), 2);
  v_margem := round(case when coalesce(v_v.bruto,0) = 0 then 0 else v_lucro / v_v.bruto * 100 end, 4);
  v_quando := to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS');

  update vendas set quitado = true, pgto_quitado = p_pgto, lucro_liq = v_lucro,
         margem = v_margem, quitado_em = v_quando
   where id = p_id returning * into v_nova;

  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'QUITAR',
          concat_ws(' - ', 'Fiado de ' || coalesce(v_v.cliente,'(sem cliente)'),
                    'R$ ' || to_char(coalesce(v_v.bruto,0),'FM999999990.00'), 'via ' || p_pgto), 'servidor');
  return jsonb_build_object('repetida', false, 'venda', to_jsonb(v_nova));
end $fn$;
revoke all on function public.vsp_quitar_fiado(bigint,text,text) from public, anon;
grant execute on function public.vsp_quitar_fiado(bigint,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Fechada a quitação pela RPC, o app não precisa mais de UPDATE na tabela toda:
-- o único campo que ele ainda edita direto em `vendas` é o vencimento do fiado.
-- O mesmo vale para reposições, onde só lote/validade/nota são editáveis na tela.
-- ---------------------------------------------------------------------------
revoke update on public.vendas from authenticated;
grant  update (vence_em) on public.vendas to authenticated;
revoke update on public.reposicoes from authenticated;
grant  update (lote, validade, nota_lote) on public.reposicoes to authenticated;

-- ============================================================================
-- ROLLBACK:
--   grant update on public.vendas to authenticated;
--   grant update on public.reposicoes to authenticated;
--   drop function if exists public.vsp_quitar_fiado(bigint,text,text);
--   e reaplicar o corpo de vsp_registrar_venda da 004.
-- ============================================================================
