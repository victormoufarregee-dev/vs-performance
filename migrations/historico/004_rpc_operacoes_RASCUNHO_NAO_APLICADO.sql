-- ############################################################################
-- ##  HISTÓRICO — NÃO APLICAR.                                              ##
-- ##  Este é o texto que estava em migrations/004_rpc_operacoes.sql até     ##
-- ##  17/09/2026. Ele NUNCA correspondeu ao banco: as RPCs aplicadas em      ##
-- ##  15/09/2026 têm outra assinatura (payload jsonb + op_id) e os           ##
-- ##  auxiliares abaixo (vsp_uid, vsp_exige_autorizacao, vsp_brl,            ##
-- ##  vsp_display, vsp_audit, vsp_novo_id) não existem em produção.          ##
-- ##  A definição vigente está em migrations/004_rpc_operacoes.sql.          ##
-- ##  Guardado só para explicar o histórico (ver migrations/APLICADO.md,     ##
-- ##  seção "Drift 004 × produção").                                         ##
-- ############################################################################

-- ============================================================
-- VS PERFORMANCE - 004_RPC_OPERACOES
-- Operacoes financeiras dentro de UMA transacao no banco.
-- ============================================================
-- PROBLEMA QUE ISSO RESOLVE
-- Hoje o app faz cada operacao em 2 ou 3 chamadas HTTP separadas.
-- Em regVenda (index.html linha 1457):
--     await sbPost('vendas', row);                 <- 1a chamada
--     await sbPatch('produtos', p.id, {caixas...}) <- 2a chamada
--     await audit('VENDA', ...)                    <- 3a chamada
-- Se a 2a falhar (sinal cai no meio), a venda esta gravada e o estoque
-- NAO baixou. E a baixa e calculada no CELULAR: dois aparelhos vendendo
-- a ultima caixa ao mesmo tempo leem "1 caixa" cada um e os dois vendem.
--
-- COMO RESOLVE
-- Uma chamada RPC por operacao. Ou tudo entra (venda + estoque + auditoria)
-- ou nada entra. A baixa de estoque vira UPDATE com guarda no WHERE, avaliada
-- pelo banco: quem chegar depois nao encontra saldo e recebe erro claro.
--
-- DEPENDE DE: 002 (op_id). Recomendado depois do 001 e do 003.
--
-- AS FORMULAS SAO COPIA DAS DO APP, DE PROPOSITO.
-- Custo medio ponderado, guarda podeRecalcular do estorno, arredondamento
-- do custo da caixa a partir do valor NAO arredondado: tudo igual ao
-- index.html. Se o numero mudasse aqui, o historico deixaria de bater.
-- Diferenca residual conhecida: o app calcula em float (JavaScript) e o
-- banco em numeric. Em centavo isso pode dar 1 centavo de diferenca em
-- caso de empate exato de arredondamento. numeric e o mais correto dos dois.
--
-- IDEMPOTENTE: create or replace. Pode rodar 2x.
-- OBS: se um dia voce MUDAR a lista de parametros de uma funcao, o
-- "create or replace" nao serve - derrube a versao antiga primeiro
-- (ver secao de rollback no fim).
-- ============================================================


-- ============================================================
-- 1) AJUDANTES (ficam no banco - as RPCs usam em tempo de execucao)
-- ============================================================

-- auth.uid() a prova de contexto: no SQL Editor nao existe JWT e ela
-- devolve NULL em vez de estourar.
create or replace function public.vsp_uid()
returns uuid language plpgsql stable security definer
set search_path = public, pg_temp as $fn$
begin
  return auth.uid();
exception when others then
  return null;
end $fn$;

-- Porteiro das RPCs. Elas sao SECURITY DEFINER, ou seja, rodam com poder
-- de dono e PASSAM POR CIMA da RLS do 003 - por isso precisam checar a
-- allowlist por conta propria, senao viravam um buraco na seguranca.
-- Duas folgas propositais:
--  a) se a tabela do 003 ainda nao existe, nao bloqueia (permite aplicar
--     o 004 antes do 003 sem derrubar o app);
--  b) uid nulo = chamada de fora da API (SQL Editor / service_role). Quem
--     chega ali ja tem acesso total ao banco de qualquer jeito. E o EXECUTE
--     das funcoes e negado para anon, entao ninguem sem login passa por aqui.
create or replace function public.vsp_exige_autorizacao()
returns void language plpgsql stable security definer
set search_path = public, pg_temp as $fn$
declare v_uid uuid;
begin
  if to_regclass('public.usuarios_autorizados') is null then
    return;
  end if;
  v_uid := public.vsp_uid();
  if v_uid is null then
    return;
  end if;
  if not exists (select 1 from public.usuarios_autorizados u
                  where u.uid = v_uid and coalesce(u.ativo,false)) then
    raise exception 'Usuario sem autorizacao para operar (uid %).', v_uid
      using errcode = '42501',
            hint = 'Peca para incluir este uid em public.usuarios_autorizados.';
  end if;
end $fn$;

-- "R$ 1.234,56" - a auditoria fica legivel igual a do app (funcao R()).
-- Usa ',' e '.' literais no formato (e nao G e D) de proposito: G e D
-- seguem o locale do servidor e o resultado mudaria de banco para banco.
-- Depois troca para a ordem brasileira.
create or replace function public.vsp_brl(p_v numeric)
returns text language sql immutable
set search_path = public, pg_temp as $fn$
  select 'R$ ' || replace(replace(replace(
           to_char(coalesce(p_v,0), 'FM999,999,999,990.00'),
           '.', '|'), ',', '.'), '|', ',');
$fn$;

-- Carimbo igual ao getNow().display do app: DD/MM/AAAA HH:MM:SS.
-- Fixado em America/Sao_Paulo porque o banco roda em UTC e a coluna
-- "display"/"cancelada_em" e texto puro - se gravar em UTC, a auditoria
-- mostra 3 horas a menos que o relogio da loja.
create or replace function public.vsp_display()
returns text language sql stable
set search_path = public, pg_temp as $fn$
  select to_char(now() at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI:SS');
$fn$;

-- Grava auditoria DENTRO da transacao da operacao. No app o audit() e uma
-- chamada HTTP separada com try/catch vazio: se ela falha, a venda entra
-- sem rastro. Aqui, se a auditoria nao entra, a operacao inteira volta.
create or replace function public.vsp_audit(p_acao text, p_detalhes text, p_usuario text)
returns void language sql security definer
set search_path = public, pg_temp as $fn$
  insert into public.audit_log (ts, display, usuario, acao, detalhes, dispositivo)
  values (now(), public.vsp_display(), coalesce(nullif(btrim(p_usuario),''),'sistema'),
          p_acao, p_detalhes, 'rpc-banco');
$fn$;

-- Mantem o padrao de id do app (Date.now() em milissegundos) e evita
-- colisao quando duas gravacoes caem no mesmo milissegundo.
create or replace function public.vsp_novo_id(p_tabela text)
returns bigint language plpgsql
set search_path = public, pg_temp as $fn$
declare v_id bigint; v_existe integer;
begin
  if p_tabela not in ('vendas','saidas','reposicoes','clientes','backups') then
    raise exception 'tabela % nao permitida em vsp_novo_id', p_tabela;
  end if;
  v_id := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  loop
    execute format('select 1 from public.%I where id = $1', p_tabela) into v_existe using v_id;
    exit when v_existe is null;
    v_id := v_id + 1;
  end loop;
  return v_id;
end $fn$;

revoke all on function public.vsp_uid() from public;
revoke all on function public.vsp_exige_autorizacao() from public;
revoke all on function public.vsp_audit(text,text,text) from public;
revoke all on function public.vsp_novo_id(text) from public;
-- vsp_brl e vsp_display sao inofensivas e uteis em relatorio manual.
grant execute on function public.vsp_brl(numeric) to authenticated;
grant execute on function public.vsp_display() to authenticated;


-- ============================================================
-- 2) vsp_registrar_venda
-- Grava a venda e baixa o estoque no mesmo statement, com guarda.
-- Espelha regVenda() - index.html linha 1457.
-- ============================================================
create or replace function public.vsp_registrar_venda(
  p_prod       text,
  p_tipo       text,
  p_qtd        integer,
  p_val_orig   numeric,
  p_data       date,
  p_pgto       text,
  p_cli_id     bigint  default null,
  p_cliente    text    default '',
  p_wpp        text    default '',
  p_desconto   numeric default 0,
  p_taxa       numeric default 0,
  p_taxa_quem  text    default 'nos',
  p_parcelas   integer default null,
  p_obs        text    default '',
  p_lote       text    default '',
  p_vence_em   date    default null,
  p_usuario    text    default null,
  p_op_id      text    default null,
  p_id         bigint  default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p       produtos;
  v_row     vendas;
  v_fpc     integer;
  v_cu_unit numeric;
  v_vf      numeric;
  v_b       numeric;
  v_c       numeric;
  v_taxa    numeric;
  v_tv      numeric;
  v_l       numeric;
  v_ll      numeric;
  v_mg      numeric;
  v_vence   date;
  v_id      bigint;
begin
  perform public.vsp_exige_autorizacao();

  -- ---------- validacao de entrada ----------
  if p_tipo is null or p_tipo not in ('caixa','frasco') then
    raise exception 'Tipo de venda invalido (%). Use caixa ou frasco.', p_tipo;
  end if;
  if p_qtd is null or p_qtd <= 0 then
    raise exception 'Quantidade tem de ser maior que zero.';
  end if;
  if p_val_orig is null or p_val_orig < 0 then
    raise exception 'Valor da venda invalido.';
  end if;
  if p_data is null then
    raise exception 'Informe a data da venda.';
  end if;
  if p_pgto is null then
    raise exception 'Informe a forma de pagamento.';
  end if;

  -- ---------- idempotencia ----------
  -- Reenvio da fila offline nao pode virar segunda venda nem segunda
  -- baixa de estoque. Devolve a venda que ja esta gravada.
  if p_op_id is not null then
    select * into v_row from public.vendas where op_id = p_op_id;
    if found then
      select * into v_p from public.produtos where id = v_row.prod;
      return jsonb_build_object(
        'ok', true, 'duplicada', true,
        'venda', to_jsonb(v_row), 'produto', to_jsonb(v_p),
        'mensagem', 'Esta venda ja estava registrada (op_id repetido).');
    end if;
  end if;

  -- ---------- produto e custo ----------
  select * into v_p from public.produtos where id = p_prod;
  if not found then
    raise exception 'Produto % nao existe.', p_prod using errcode = '23503';
  end if;
  v_fpc := greatest(coalesce(v_p.frascos_por_caixa,1),1);

  if p_tipo = 'frasco' and not coalesce(v_p.vende_frasco,false) then
    raise exception '% nao vende frasco avulso.', v_p.nome;
  end if;

  -- cuProd() do app: custo da unidade vendida x quantidade.
  v_cu_unit := case when p_tipo = 'caixa' then coalesce(v_p.custo_caixa,0)
                    else coalesce(v_p.custo_frasco,0) end;
  if v_cu_unit <= 0 then
    raise exception 'Cadastre o custo de % antes de vender (Produtos > Editar).', v_p.nome;
  end if;

  -- ---------- valores (identicos a regVenda) ----------
  v_vf   := greatest(0, p_val_orig - coalesce(p_desconto,0));  -- vf = max(0, vo - dc)
  v_b    := p_qtd * v_vf;                                      -- bruto
  v_c    := v_cu_unit * p_qtd;                                 -- custo
  -- No app a taxa e forcada a 0 quando o pagamento e fiado.
  v_taxa := case when p_pgto = 'fiado' then 0 else coalesce(p_taxa,0) end;
  v_tv   := v_b * v_taxa / 100;
  v_l    := case when coalesce(p_taxa_quem,'nos') = 'nos' then v_b - v_tv else v_b end;
  -- Fiado nao virou dinheiro ainda: lucro e margem entram zerados e sao
  -- recalculados na quitacao (confirmarQuitar).
  v_ll   := case when p_pgto = 'fiado' then 0 else v_l - v_c end;
  v_mg   := case when p_pgto = 'fiado' then 0
                 when v_b <> 0 then v_ll / v_b * 100 else 0 end;
  -- addDias(dt,15): padrao do app quando o vencimento nao e combinado.
  v_vence := case when p_pgto = 'fiado' then coalesce(p_vence_em, p_data + 15) else null end;

  v_id := coalesce(p_id, public.vsp_novo_id('vendas'));

  begin
    -- ---------- baixa de estoque ATOMICA ----------
    if p_tipo = 'caixa' then
      -- A guarda esta no WHERE: quem nao tem saldo nao atualiza nada.
      update public.produtos
         set caixas = caixas - p_qtd
       where id = p_prod
         and caixas >= p_qtd
      returning * into v_p;
    else
      -- Venda de frasco: consome frascos soltos e, se faltar, abre caixa -
      -- mesma conta do app. As referencias a frascos/caixas dentro do SET
      -- sao os valores ANTIGOS da linha, por isso a conta fecha num statement.
      update public.produtos
         set caixas = case when frascos >= p_qtd then caixas
                           else caixas - ceil((p_qtd - frascos)::numeric / v_fpc)::integer end,
             frascos = case when frascos >= p_qtd then frascos - p_qtd
                            else ceil((p_qtd - frascos)::numeric / v_fpc)::integer * v_fpc
                                 - (p_qtd - frascos) end
       where id = p_prod
         and (caixas * v_fpc + frascos) >= p_qtd
      returning * into v_p;
    end if;

    if not found then
      -- Le de novo so para montar a mensagem com os numeros reais.
      select * into v_p from public.produtos where id = p_prod;
      raise exception
        'Estoque insuficiente de %: tem % caixa(s) e % frasco(s) (= % frasco(s) equivalentes) e a venda pede % %(s).',
        v_p.nome, v_p.caixas, v_p.frascos, v_p.caixas * v_fpc + v_p.frascos, p_qtd, p_tipo
        using hint = 'Registre a compra (reposicao) antes da venda, ou ajuste o estoque.';
    end if;

    insert into public.vendas (
      id, prod, tipo, qtd, val_orig, desconto, val_final, bruto, custo,
      taxa, taxa_val, taxa_quem, liq, lucro_liq, margem,
      cliente, wpp, cli_id, data, obs, pgto, parcelas,
      quitado, cancelada, vence_em, usuario, lote, op_id
    ) values (
      v_id, p_prod, p_tipo, p_qtd, p_val_orig, coalesce(p_desconto,0), v_vf, v_b, v_c,
      v_taxa, v_tv, coalesce(p_taxa_quem,'nos'), v_l, v_ll, v_mg,
      coalesce(p_cliente,''), coalesce(p_wpp,''), p_cli_id, p_data, coalesce(p_obs,''),
      p_pgto, case when p_pgto = 'parcelado' then p_parcelas else null end,
      false, false, v_vence, p_usuario, coalesce(p_lote,''), p_op_id
    ) returning * into v_row;

  exception when unique_violation then
    -- Corrida: outra copia da mesma operacao ganhou. O bloco inteiro
    -- (inclusive a baixa de estoque) volta atras, e devolvemos a venda dela.
    if p_op_id is not null then
      select * into v_row from public.vendas where op_id = p_op_id;
      if found then
        select * into v_p from public.produtos where id = v_row.prod;
        return jsonb_build_object(
          'ok', true, 'duplicada', true,
          'venda', to_jsonb(v_row), 'produto', to_jsonb(v_p),
          'mensagem', 'Esta venda ja estava registrada (op_id repetido).');
      end if;
    end if;
    raise;
  end;

  -- ---------- auditoria, na mesma transacao ----------
  perform public.vsp_audit('VENDA',
    v_p.nome || ' | ' || coalesce(nullif(p_cliente,''),'sem cliente')
      || ' | ' || case when p_tipo = 'caixa' then 'Caixa' else 'Frasco' end
      || ' x' || p_qtd || ' | ' || public.vsp_brl(v_b) || ' | ' || p_pgto,
    p_usuario);

  return jsonb_build_object(
    'ok', true, 'duplicada', false,
    'venda', to_jsonb(v_row), 'produto', to_jsonb(v_p));
end $fn$;


-- ============================================================
-- 3) vsp_registrar_compra
-- Insere a reposicao, soma estoque e recalcula o custo medio ponderado.
-- Espelha confReposicao() - index.html linha 2203.
-- ============================================================
create or replace function public.vsp_registrar_compra(
  p_prod      text,
  p_tipo      text,
  p_qtd       integer,
  p_cust_unit numeric,
  p_data      date,
  p_frete     numeric default 0,
  p_forn      text    default '',
  p_obs       text    default '',
  p_lote      text    default '',
  p_validade  date    default null,
  p_nota_lote text    default '',
  p_usuario   text    default null,
  p_op_id     text    default null,
  p_id        bigint  default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p          produtos;
  v_rep        reposicoes;
  v_fpc        integer;
  v_un_antes   integer;
  v_val_antes  numeric;
  v_novas_un   integer;
  v_val_novo   numeric;
  v_un_depois  integer;
  v_cf_raw     numeric;
  v_cf         numeric;
  v_cc         numeric;
  v_total      numeric;
  v_id         bigint;
begin
  perform public.vsp_exige_autorizacao();

  if p_tipo is null or p_tipo not in ('caixa','frasco') then
    raise exception 'Tipo de compra invalido (%). Use caixa ou frasco.', p_tipo;
  end if;
  if p_qtd is null or p_qtd <= 0 then
    raise exception 'Quantidade da compra tem de ser maior que zero.';
  end if;
  if p_cust_unit is null or p_cust_unit < 0 then
    raise exception 'Custo unitario invalido.';
  end if;
  if p_data is null then
    raise exception 'Informe a data da compra.';
  end if;
  if coalesce(p_frete,0) < 0 then
    raise exception 'Frete nao pode ser negativo.';
  end if;

  if p_op_id is not null then
    select * into v_rep from public.reposicoes where op_id = p_op_id;
    if found then
      select * into v_p from public.produtos where id = v_rep.prod;
      return jsonb_build_object(
        'ok', true, 'duplicada', true,
        'reposicao', to_jsonb(v_rep), 'produto', to_jsonb(v_p),
        'mensagem', 'Esta compra ja estava registrada (op_id repetido).');
    end if;
  end if;

  -- FOR UPDATE: o custo medio depende do estoque lido AGORA. Sem o lock,
  -- duas compras simultaneas leem o mesmo "valor anterior" e uma das duas
  -- desaparece da media - erro que nao aparece no extrato, so no custo.
  select * into v_p from public.produtos where id = p_prod for update;
  if not found then
    raise exception 'Produto % nao existe.', p_prod using errcode = '23503';
  end if;
  v_fpc := greatest(coalesce(v_p.frascos_por_caixa,1),1);

  if p_tipo = 'frasco' and not coalesce(v_p.vende_frasco,false) then
    raise exception '% nao trabalha com frasco avulso.', v_p.nome;
  end if;

  -- ---------- CUSTO MEDIO PONDERADO (identico ao app) ----------
  -- totFP(): estoque em frascos equivalentes.
  v_un_antes  := coalesce(v_p.caixas,0) * v_fpc + coalesce(v_p.frascos,0);
  -- valorEstProd(): caixas x custo_caixa + frascos x custo_frasco.
  -- Usa o valor REAL do estoque, nao o custo do frasco arredondado vezes
  -- a quantidade - senao o erro de centavo cresce a cada compra.
  v_val_antes := coalesce(v_p.caixas,0) * coalesce(v_p.custo_caixa,0)
               + coalesce(v_p.frascos,0) * coalesce(v_p.custo_frasco,0);
  v_novas_un  := case when p_tipo = 'caixa' then p_qtd * v_fpc else p_qtd end;
  -- O frete entra no custo da mercadoria: foi dinheiro gasto para ela chegar.
  v_val_novo  := p_qtd * p_cust_unit + coalesce(p_frete,0);
  v_un_depois := v_un_antes + v_novas_un;
  v_total     := v_val_novo;

  v_cf_raw := case when v_un_depois > 0
                   then (v_val_antes + v_val_novo) / v_un_depois
                   else case when p_tipo = 'caixa' then p_cust_unit / v_fpc
                             else p_cust_unit end
              end;
  -- Cada um arredondado UMA vez, os dois a partir do valor nao arredondado.
  -- Se o custo da caixa saisse de round(custo_frasco,2) x fpc, o erro do
  -- centavo do frasco seria multiplicado por fpc e o valor em estoque
  -- deixaria de bater com o dinheiro gasto.
  v_cf := round(v_cf_raw, 2);
  v_cc := round(v_cf_raw * v_fpc, 2);

  v_id := coalesce(p_id, public.vsp_novo_id('reposicoes'));

  begin
    update public.produtos
       set caixas       = caixas  + case when p_tipo = 'caixa'  then p_qtd else 0 end,
           frascos      = frascos + case when p_tipo = 'frasco' then p_qtd else 0 end,
           custo_frasco = v_cf,
           custo_caixa  = v_cc
     where id = p_prod
    returning * into v_p;

    insert into public.reposicoes (
      id, prod, tipo, qtd, cust_unit, frete, cust_total,
      forn, data, obs, lote, validade, nota_lote, op_id
    ) values (
      v_id, p_prod, p_tipo, p_qtd, p_cust_unit, coalesce(p_frete,0), v_total,
      coalesce(p_forn,''), p_data, coalesce(p_obs,''),
      btrim(coalesce(p_lote,'')), p_validade, btrim(coalesce(p_nota_lote,'')), p_op_id
    ) returning * into v_rep;

  exception when unique_violation then
    if p_op_id is not null then
      select * into v_rep from public.reposicoes where op_id = p_op_id;
      if found then
        select * into v_p from public.produtos where id = v_rep.prod;
        return jsonb_build_object(
          'ok', true, 'duplicada', true,
          'reposicao', to_jsonb(v_rep), 'produto', to_jsonb(v_p),
          'mensagem', 'Esta compra ja estava registrada (op_id repetido).');
      end if;
    end if;
    raise;
  end;

  perform public.vsp_audit('REPOSICAO',
    v_p.nome || ' | ' || p_qtd || ' ' || p_tipo || '(s) | '
      || coalesce(nullif(p_forn,''),'sem fornecedor') || ' | ' || public.vsp_brl(v_total),
    p_usuario);

  return jsonb_build_object(
    'ok', true, 'duplicada', false,
    'reposicao', to_jsonb(v_rep), 'produto', to_jsonb(v_p),
    'custo_frasco_sem_arredondar', v_cf_raw,
    'unidades_antes', v_un_antes, 'valor_antes', v_val_antes);
end $fn$;


-- ============================================================
-- 4) vsp_cancelar_venda
-- Marca cancelada e devolve o estoque. Espelha confirmarCancelamento()
-- - index.html linha 1508.
-- ============================================================
-- SOBRE O CUSTO: o app de hoje devolve a QUANTIDADE e nao mexe no custo
-- medio. Esta funcao faz o mesmo por padrao. Se p_recalcular_custo = true,
-- ela devolve tambem o VALOR ao estoque usando o custo HISTORICO gravado
-- na propria venda (vendas.custo) - nunca o custo medio de hoje, que pode
-- ter mudado por compras posteriores e inflaria ou esvaziaria o estoque.
-- Deixar o padrao em false mantem o comportamento identico ao do app;
-- ligar e decisao do responsavel (DECISAO 6 do README).
create or replace function public.vsp_cancelar_venda(
  p_venda_id         bigint,
  p_motivo           text,
  p_usuario          text    default null,
  p_recalcular_custo boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_v         vendas;
  v_p         produtos;
  v_fpc       integer;
  v_un_dev    integer;
  v_un_antes  integer;
  v_val_antes numeric;
  v_cf_raw    numeric;
  v_cf        numeric;
  v_cc        numeric;
  v_recalc    boolean := false;
begin
  perform public.vsp_exige_autorizacao();

  if p_motivo is null or btrim(p_motivo) = '' then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  -- FOR UPDATE: sem ele, dois cliques no botao devolvem o estoque duas vezes.
  select * into v_v from public.vendas where id = p_venda_id for update;
  if not found then
    raise exception 'Venda % nao encontrada.', p_venda_id;
  end if;

  -- Ja cancelada = operacao repetida. Devolve o estado atual em vez de
  -- somar estoque de novo. E esta a idempotencia do cancelamento: o
  -- proprio campo "cancelada", nao um op_id (o op_id de vendas pertence
  -- ao registro da venda).
  if coalesce(v_v.cancelada,false) then
    select * into v_p from public.produtos where id = v_v.prod;
    return jsonb_build_object(
      'ok', true, 'duplicada', true,
      'venda', to_jsonb(v_v), 'produto', to_jsonb(v_p),
      'mensagem', 'Esta venda ja estava cancelada.');
  end if;

  select * into v_p from public.produtos where id = v_v.prod for update;
  if not found then
    raise exception 'O produto desta venda (%) nao existe mais - nao da para devolver o estoque.',
      v_v.prod;
  end if;
  v_fpc := greatest(coalesce(v_p.frascos_por_caixa,1),1);

  v_un_dev    := case when v_v.tipo = 'caixa' then v_v.qtd * v_fpc else v_v.qtd end;
  v_un_antes  := coalesce(v_p.caixas,0) * v_fpc + coalesce(v_p.frascos,0);
  v_val_antes := coalesce(v_p.caixas,0) * coalesce(v_p.custo_caixa,0)
               + coalesce(v_p.frascos,0) * coalesce(v_p.custo_frasco,0);

  if p_recalcular_custo and coalesce(v_v.custo,0) > 0 and (v_un_antes + v_un_dev) > 0 then
    -- Ponderada usando o custo daquela venda, do jeito que ele foi gravado.
    v_cf_raw := (v_val_antes + coalesce(v_v.custo,0)) / (v_un_antes + v_un_dev);
    v_cf := round(v_cf_raw, 2);
    v_cc := round(v_cf_raw * v_fpc, 2);
    v_recalc := true;
  else
    v_cf := coalesce(v_p.custo_frasco,0);
    v_cc := coalesce(v_p.custo_caixa,0);
  end if;

  -- Devolucao do estoque, mesma normalizacao do app: frasco devolvido que
  -- completa caixa volta a virar caixa.
  update public.produtos
     set caixas  = case when v_v.tipo = 'caixa' then caixas + v_v.qtd
                        else caixas + ((frascos + v_v.qtd) / v_fpc) end,
         frascos = case when v_v.tipo = 'caixa' then frascos
                        else (frascos + v_v.qtd) % v_fpc end,
         custo_frasco = v_cf,
         custo_caixa  = v_cc
   where id = v_p.id
  returning * into v_p;

  update public.vendas
     set cancelada        = true,
         cancelada_por    = coalesce(nullif(btrim(p_usuario),''),'sistema'),
         cancelada_em     = public.vsp_display(),
         cancelada_motivo = btrim(p_motivo)
   where id = p_venda_id
  returning * into v_v;

  perform public.vsp_audit('CANCELAMENTO',
    'Venda de ' || coalesce(nullif(v_v.cliente,''),'sem cliente')
      || ' (' || public.vsp_brl(v_v.bruto) || ') cancelada | Motivo: ' || btrim(p_motivo)
      || case when v_recalc then ' | custo medio recalculado pelo custo historico da venda'
              else ' | custo medio mantido' end,
    p_usuario);

  return jsonb_build_object(
    'ok', true, 'duplicada', false,
    'venda', to_jsonb(v_v), 'produto', to_jsonb(v_p),
    'custo_recalculado', v_recalc,
    'custo_historico_da_venda', v_v.custo);
end $fn$;


-- ============================================================
-- 5) vsp_estornar_compra
-- Espelha estornarCompra() - index.html linha 2134, inclusive a guarda
-- podeRecalcular.
-- ============================================================
create or replace function public.vsp_estornar_compra(
  p_reposicao_id  bigint,
  p_usuario       text    default null,
  p_excluir_saida boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_rep        reposicoes;
  v_p          produtos;
  v_fpc        integer;
  v_disp       integer;
  v_un         integer;
  v_un_atual   integer;
  v_val_atual  numeric;
  v_un_rest    integer;
  v_val_rest   numeric;
  v_vendas_dep integer;
  v_pode       boolean;
  v_cf_raw     numeric;
  v_cf         numeric;
  v_cc         numeric;
  v_saida      saidas;
  v_saida_del  boolean := false;
begin
  perform public.vsp_exige_autorizacao();

  select * into v_rep from public.reposicoes where id = p_reposicao_id for update;
  if not found then
    raise exception 'Compra % nao encontrada (ja estornada?).', p_reposicao_id;
  end if;

  select * into v_p from public.produtos where id = v_rep.prod for update;
  if not found then
    raise exception 'O produto desta compra (%) nao existe mais - nao da para estornar.',
      v_rep.prod;
  end if;
  v_fpc := greatest(coalesce(v_p.frascos_por_caixa,1),1);

  -- So estorna se a mercadoria ainda estiver la. Se parte foi vendida, o
  -- estoque nao pode ficar negativo: cancele as vendas primeiro.
  v_disp := case when v_rep.tipo = 'caixa' then coalesce(v_p.caixas,0)
                 else coalesce(v_p.frascos,0) end;
  if v_disp < v_rep.qtd then
    raise exception
      'Nao da para estornar: o estoque tem % %(s) e a compra foi de %. Parte ja foi vendida - cancele as vendas primeiro.',
      v_disp, v_rep.tipo, v_rep.qtd;
  end if;

  v_un        := case when v_rep.tipo = 'caixa' then v_rep.qtd * v_fpc else v_rep.qtd end;
  v_un_atual  := coalesce(v_p.caixas,0) * v_fpc + coalesce(v_p.frascos,0);
  v_val_atual := coalesce(v_p.caixas,0) * coalesce(v_p.custo_caixa,0)
               + coalesce(v_p.frascos,0) * coalesce(v_p.custo_frasco,0);
  v_un_rest   := v_un_atual - v_un;
  v_val_rest  := v_val_atual - coalesce(v_rep.cust_total,0);

  -- GUARDA podeRecalcular (copia do app):
  -- desfazer o custo medio so e exato se NADA foi vendido deste produto a
  -- partir da data da compra. Se houve venda, o valor do estoque ja foi
  -- consumido e a subtracao daria um custo baixo demais - ou zero, que
  -- trava a venda do produto. Nesse caso mantem-se o custo atual e so a
  -- quantidade volta.
  -- A comparacao de datas replica o String(v.data||'') >= String(r.data||'')
  -- do JavaScript, inclusive o caso de data vazia.
  select count(*) into v_vendas_dep
    from public.vendas v
   where coalesce(v.cancelada,false) = false
     and v.prod = v_rep.prod
     and coalesce(to_char(v.data,'YYYY-MM-DD'),'') >= coalesce(to_char(v_rep.data,'YYYY-MM-DD'),'');

  v_pode := (v_vendas_dep = 0 and v_un_rest > 0 and v_val_rest > 0);

  v_cf_raw := case when v_pode then v_val_rest / v_un_rest
                   else coalesce(v_p.custo_frasco,0) end;
  v_cf := round(v_cf_raw, 2);
  v_cc := round(v_cf_raw * v_fpc, 2);

  -- Guarda tambem no WHERE: estoque nunca fica negativo, nem sob corrida.
  update public.produtos
     set caixas  = caixas  - case when v_rep.tipo = 'caixa'  then v_rep.qtd else 0 end,
         frascos = frascos - case when v_rep.tipo = 'frasco' then v_rep.qtd else 0 end,
         custo_frasco = v_cf,
         custo_caixa  = v_cc
   where id = v_p.id
     and (case when v_rep.tipo = 'caixa' then caixas else frascos end) >= v_rep.qtd
  returning * into v_p;

  if not found then
    raise exception 'Estoque mudou durante o estorno da compra % - nada foi alterado.',
      p_reposicao_id;
  end if;

  -- A saida que a compra lancou no Financeiro, quando existe. O pareamento
  -- e o mesmo heuristico do app (id da saida = id da compra + 1, tipo
  -- fornecedor, valor igual a menos de 1 centavo). O preflight, linha 78,
  -- conta quantas compras tem esse par.
  if coalesce(p_excluir_saida,true) then
    select * into v_saida from public.saidas s
     where s.id = v_rep.id + 1
       and s.tipo = 'fornecedor'
       and abs(coalesce(s.val,0) - coalesce(v_rep.cust_total,0)) < 0.01;
    if found then
      delete from public.saidas where id = v_saida.id;
      v_saida_del := true;
    end if;
  end if;

  delete from public.reposicoes where id = v_rep.id;

  perform public.vsp_audit('REPOSICAO_ESTORNADA',
    v_p.nome || ' | ' || v_rep.qtd || ' ' || v_rep.tipo || '(s) | '
      || public.vsp_brl(v_rep.cust_total)
      || coalesce(' | ' || nullif(v_rep.forn,''), '')
      || ' | estornado por ' || coalesce(nullif(btrim(p_usuario),''),'sistema')
      || case when v_pode then ' | custo medio recalculado para ' || public.vsp_brl(v_cf)
              else ' | custo medio mantido em ' || public.vsp_brl(v_cf)
                   || ' (houve ' || v_vendas_dep || ' venda(s) a partir da data da compra)' end,
    p_usuario);

  if v_saida_del then
    perform public.vsp_audit('FINANCEIRO_EXCLUIDO',
      coalesce(v_saida.descricao,'(sem descricao)') || ' | ' || public.vsp_brl(v_saida.val)
        || ' excluido no estorno da compra',
      p_usuario);
  end if;

  return jsonb_build_object(
    'ok', true, 'duplicada', false,
    'reposicao_estornada', to_jsonb(v_rep),
    'produto', to_jsonb(v_p),
    'pode_recalcular', v_pode,
    'vendas_a_partir_da_data', v_vendas_dep,
    'saida_excluida', v_saida_del,
    'saida', case when v_saida_del then to_jsonb(v_saida) else null end);
end $fn$;


-- ============================================================
-- 6) PERMISSOES DAS RPCs
-- Postgres concede EXECUTE a PUBLIC por padrao; como sao SECURITY
-- DEFINER, isso deixaria a role anon (chave publica do app) operar
-- o financeiro sem login. Tira de todos e devolve so a authenticated.
-- ============================================================
revoke all on function public.vsp_registrar_venda(
  text,text,integer,numeric,date,text,bigint,text,text,numeric,numeric,text,
  integer,text,text,date,text,text,bigint) from public;
grant execute on function public.vsp_registrar_venda(
  text,text,integer,numeric,date,text,bigint,text,text,numeric,numeric,text,
  integer,text,text,date,text,text,bigint) to authenticated;

revoke all on function public.vsp_registrar_compra(
  text,text,integer,numeric,date,numeric,text,text,text,date,text,text,text,bigint) from public;
grant execute on function public.vsp_registrar_compra(
  text,text,integer,numeric,date,numeric,text,text,text,date,text,text,text,bigint) to authenticated;

revoke all on function public.vsp_cancelar_venda(bigint,text,text,boolean) from public;
grant execute on function public.vsp_cancelar_venda(bigint,text,text,boolean) to authenticated;

revoke all on function public.vsp_estornar_compra(bigint,text,boolean) from public;
grant execute on function public.vsp_estornar_compra(bigint,text,boolean) to authenticated;


-- ============================================================
-- 7) CONFERENCIA - LEIA ESTE RESULTADO
-- Esperado: 4 linhas com definer = true, search_path_fixo = true e
-- executa_authenticated = true; anon nunca true.
-- ============================================================
select p.proname as funcao,
       p.prosecdef as definer,
       (p.proconfig is not null
         and exists (select 1 from unnest(p.proconfig) cfg
                      where cfg like 'search_path=%')) as search_path_fixo,
       has_function_privilege('authenticated', p.oid, 'execute') as executa_authenticated,
       has_function_privilege('anon', p.oid, 'execute')          as executa_anon,
       pg_get_function_identity_arguments(p.oid) as parametros
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('vsp_registrar_venda','vsp_registrar_compra',
                     'vsp_cancelar_venda','vsp_estornar_compra')
 order by p.proname;


-- ============================================================
-- COMO O APP CHAMA (referencia para quem for mexer no index.html)
-- ============================================================
-- Uma unica chamada substitui o sbPost + sbPatch + audit:
--
--   async function sbRpc(fn, args){
--     const r = await sbFetch(`${SB_URL}/rest/v1/rpc/${fn}`,
--       {method:'POST', headers:{...H}, body:JSON.stringify(args)});
--     if(!r.ok) throw await sbErro(r,'Operacao',fn);
--     return r.json();
--   }
--
--   const res = await sbRpc('vsp_registrar_venda',{
--     p_prod:p.id, p_tipo:t, p_qtd:q, p_val_orig:vo, p_data:dt, p_pgto:pg,
--     p_cli_id:ci, p_cliente:cn, p_wpp:cw, p_desconto:dc,
--     p_taxa:tx, p_taxa_quem:tq, p_parcelas:pa, p_obs:obs, p_lote:lote,
--     p_vence_em:vence, p_usuario:currentUser,
--     p_op_id:'venda-'+crypto.randomUUID()
--   });
--   // res.venda   -> linha gravada (use com mapVenda)
--   // res.produto -> produto com o estoque JA atualizado pelo banco
--   // res.duplicada === true -> era reenvio; nao mostre "venda registrada" de novo
--
-- O op_id tem de ser gerado UMA vez, junto com o formulario, e reusado no
-- retry. Se o app gerar um novo a cada tentativa, a protecao nao existe.
--
-- TESTE MANUAL NO SQL EDITOR (rode dentro de uma transacao e desfaca):
--   begin;
--     select public.vsp_registrar_venda(
--       p_prod := 'TG', p_tipo := 'caixa', p_qtd := 1, p_val_orig := 100,
--       p_data := current_date, p_pgto := 'pix', p_usuario := 'teste',
--       p_op_id := 'teste-001');
--     -- rode de novo com o MESMO op_id: tem de voltar duplicada = true
--     -- e o estoque nao pode cair duas vezes.
--   rollback;   -- <<< nao esqueca


-- ============================================================
-- ROLLBACK DO 004
-- Derrubar as funcoes nao toca em dado nenhum. O app volta a fazer as
-- chamadas separadas de hoje (se ele ja tiver sido alterado para usar as
-- RPCs, reverta o index.html ANTES de derrubar).
-- ============================================================
-- drop function if exists public.vsp_registrar_venda(
--   text,text,integer,numeric,date,text,bigint,text,text,numeric,numeric,text,
--   integer,text,text,date,text,text,bigint);
-- drop function if exists public.vsp_registrar_compra(
--   text,text,integer,numeric,date,numeric,text,text,text,date,text,text,text,bigint);
-- drop function if exists public.vsp_cancelar_venda(bigint,text,text,boolean);
-- drop function if exists public.vsp_estornar_compra(bigint,text,boolean);
-- -- ajudantes (vsp_autorizado pertence ao 003 e NAO deve cair aqui):
-- drop function if exists public.vsp_audit(text,text,text);
-- drop function if exists public.vsp_novo_id(text);
-- drop function if exists public.vsp_display();
-- drop function if exists public.vsp_brl(numeric);
-- drop function if exists public.vsp_exige_autorizacao();
-- drop function if exists public.vsp_uid();
