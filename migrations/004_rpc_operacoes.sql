-- ============================================================================
-- 004 — OPERAÇÕES TRANSACIONAIS (venda, cancelamento, estorno de compra)
-- Aplicada em produção em 15/09/2026. Texto ALINHADO AO BANCO em 17/09/2026.
--
-- O QUE ESTE ARQUIVO É: a definição VIGENTE das RPCs que a 004 criou, copiada de
-- pg_proc.prosrc (conferida por md5 em test/sql/contrato.js). Rodar 000 → 007 em ordem
-- reproduz o contrato de produção.
--
-- POR QUE FOI REESCRITO (mesma convenção da 006, commit 095bcca: o arquivo representa o
-- que está aplicado, não o rascunho):
--   * o texto antigo descrevia RPCs com 19/14 parâmetros soltos; o banco tem
--     (p_venda jsonb, p_op_id text), (p_rep jsonb, p_op_id text),
--     (p_id bigint, p_motivo text, p_usuario text, p_op_id text) e
--     (p_id bigint, p_usuario text, p_op_id text) — o mesmo que o app chama;
--   * os auxiliares vsp_uid, vsp_exige_autorizacao, vsp_brl, vsp_display, vsp_audit e
--     vsp_novo_id nunca existiram em produção. As RPCs reais autorizam com
--     vsp_autorizado() (003) e auditam com insert direto em audit_log.
--   O rascunho antigo está em migrations/historico/ (NÃO APLICAR).
--
-- O QUE O TEXTO VIGENTE JÁ CARREGA DE ETAPAS POSTERIORES:
--   * 005 (15/09, auditoria de segurança): o autor vem de vsp_ator() — a sessão —, nunca
--     do payload; p_usuario continua na assinatura por compatibilidade e é IGNORADO.
--     vsp_ator() é criada em 005_ator_da_sessao.sql. plpgsql resolve a chamada em tempo
--     de execução, então criar estas funções antes da 005 não falha; USÁ-LAS exige a 005.
--   * o corpo original de 15/09 (antes da 005) não foi preservado em lugar nenhum; não
--     foi reconstruído aqui para não inventar código que nunca rodou.
--
-- vsp_registrar_compra NÃO está aqui: a 006 a substituiu (a compra passou a gravar o
-- débito no razão do Victor na mesma transação). A definição vigente está na 006.
--
-- DEPENDE DE: 002 (op_id), 003 (vsp_autorizado), 005 (vsp_ator).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- VENDA — grava a venda, baixa o estoque com guarda no UPDATE, audita. Idempotente por
-- op_id (índice único parcial da 002). Sem saldo, nenhuma linha é afetada e a transação
-- inteira volta com "estoque insuficiente".
-- ---------------------------------------------------------------------------
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
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if v_qtd is null or v_qtd <= 0 then raise exception 'quantidade invalida'; end if;
  if v_tipo is null or v_tipo not in ('caixa','frasco') then raise exception 'tipo invalido: %', coalesce(v_tipo,'(nulo)'); end if;
  select * into v_ja from vendas where op_id = p_op_id;
  if found then return jsonb_build_object('repetida', true, 'venda', to_jsonb(v_ja)); end if;
  select * into v_prod from produtos where id = p_venda->>'prod' for update;
  if not found then raise exception 'produto % nao existe', coalesce(p_venda->>'prod','(nulo)'); end if;
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
         (p_venda->>'val_orig')::numeric, (p_venda->>'desconto')::numeric, (p_venda->>'val_final')::numeric,
         (p_venda->>'bruto')::numeric, (p_venda->>'custo')::numeric, (p_venda->>'taxa')::numeric,
         (p_venda->>'taxa_val')::numeric, p_venda->>'taxa_quem', (p_venda->>'liq')::numeric,
         (p_venda->>'lucro_liq')::numeric, (p_venda->>'margem')::numeric, p_venda->>'cliente',
         p_venda->>'wpp', nullif(p_venda->>'cli_id','')::bigint, (p_venda->>'data')::date,
         p_venda->>'obs', p_venda->>'pgto', nullif(p_venda->>'parcelas','')::int,
         false, false, nullif(p_venda->>'vence_em','')::date, v_ator, p_venda->>'lote', p_op_id
  returning * into v_nova;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'VENDA',
          concat_ws(' - ', v_prod.nome, (p_venda->>'cliente'), v_tipo || ' x' || v_qtd,
                    'R$ ' || (p_venda->>'bruto'), (p_venda->>'pgto')), 'servidor');
  select * into v_prod from produtos where id = v_prod.id;
  return jsonb_build_object('repetida', false, 'venda', to_jsonb(v_nova), 'produto', to_jsonb(v_prod));
end $fn$;
revoke all on function public.vsp_registrar_venda(jsonb,text) from public, anon;
grant execute on function public.vsp_registrar_venda(jsonb,text) to authenticated;

-- ---------------------------------------------------------------------------
-- CANCELAMENTO — marca cancelada, devolve o estoque pelo custo HISTÓRICO gravado na venda
-- (não pelo custo médio de hoje), audita. Venda já cancelada volta como repetida.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_cancelar_venda(p_id bigint, p_motivo text, p_usuario text, p_op_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_v vendas%rowtype; v_p produtos%rowtype; v_fpc int;
  v_un_antes numeric; v_val_antes numeric; v_un_volta numeric; v_val_volta numeric; v_raw numeric; v_fr int;
  v_ator text := public.vsp_ator();   -- p_usuario e IGNORADO de proposito
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if p_id is null then raise exception 'id da venda obrigatorio'; end if;
  select * into v_v from vendas where id = p_id for update;
  if not found then raise exception 'venda % nao existe', p_id; end if;
  if coalesce(v_v.cancelada,false) then return jsonb_build_object('repetida', true, 'venda', to_jsonb(v_v)); end if;
  select * into v_p from produtos where id = v_v.prod for update;
  if found then
    v_fpc := greatest(coalesce(v_p.frascos_por_caixa,1),1);
    v_un_antes  := v_p.caixas * v_fpc + v_p.frascos;
    v_val_antes := v_p.caixas * coalesce(v_p.custo_caixa,0) + v_p.frascos * coalesce(v_p.custo_frasco,0);
    v_un_volta  := case when v_v.tipo = 'caixa' then v_v.qtd * v_fpc else v_v.qtd end;
    v_val_volta := coalesce(v_v.custo, 0);
    if v_v.tipo = 'caixa' then update produtos set caixas = caixas + v_v.qtd where id = v_p.id;
    else v_fr := v_p.frascos + v_v.qtd;
         update produtos set caixas = caixas + (v_fr / v_fpc), frascos = v_fr % v_fpc where id = v_p.id; end if;
    if (v_un_antes + v_un_volta) > 0 and v_val_volta > 0 then
      v_raw := (v_val_antes + v_val_volta) / (v_un_antes + v_un_volta);
      update produtos set custo_frasco = round(v_raw,2), custo_caixa = round(v_raw * v_fpc, 2) where id = v_p.id;
    end if;
  end if;
  update vendas set cancelada = true, cancelada_por = v_ator,
         cancelada_em = to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
         cancelada_motivo = p_motivo where id = p_id;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'CANCELAMENTO',
          concat_ws(' - ', 'Venda de ' || v_v.cliente, 'R$ ' || to_char(v_v.bruto,'FM999999990.00'),
                    'Motivo: ' || coalesce(p_motivo,'(sem motivo)')), 'servidor');
  select * into v_v from vendas where id = p_id;
  select * into v_p from produtos where id = v_v.prod;
  return jsonb_build_object('repetida', false, 'venda', to_jsonb(v_v), 'produto', to_jsonb(v_p));
end $fn$;
revoke all on function public.vsp_cancelar_venda(bigint,text,text,text) from public, anon;
grant execute on function public.vsp_cancelar_venda(bigint,text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- ESTORNO DE COMPRA — recusa se parte já foi vendida, devolve o estoque, recalcula o custo
-- médio só se não houve venda depois da compra, remove a saída ligada (id+1), apaga a
-- reposição, audita. Compra inexistente volta como repetida.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_estornar_compra(p_id bigint, p_usuario text, p_op_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r reposicoes%rowtype; v_p produtos%rowtype; v_fpc int; v_disp int;
  v_un numeric; v_un_atual numeric; v_val_atual numeric; v_un_rest numeric; v_val_rest numeric;
  v_vendas_depois int; v_pode boolean; v_raw numeric; v_saida saidas%rowtype; v_saida_txt text := 'nenhuma';
  v_ator text := public.vsp_ator();   -- p_usuario e IGNORADO de proposito
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if p_id is null then raise exception 'id da compra obrigatorio'; end if;
  select * into v_r from reposicoes where id = p_id for update;
  if not found then return jsonb_build_object('repetida', true, 'aviso', 'compra ja estornada ou inexistente'); end if;
  select * into v_p from produtos where id = v_r.prod for update;
  if not found then raise exception 'o produto desta compra nao existe mais'; end if;
  v_fpc  := greatest(coalesce(v_p.frascos_por_caixa,1),1);
  v_disp := case when v_r.tipo = 'caixa' then v_p.caixas else v_p.frascos end;
  if v_disp < v_r.qtd then
    raise exception 'nao da para estornar: estoque tem % e a compra foi de %. Parte ja foi vendida.', v_disp, v_r.qtd;
  end if;
  v_un        := case when v_r.tipo = 'caixa' then v_r.qtd * v_fpc else v_r.qtd end;
  v_un_atual  := v_p.caixas * v_fpc + v_p.frascos;
  v_val_atual := v_p.caixas * coalesce(v_p.custo_caixa,0) + v_p.frascos * coalesce(v_p.custo_frasco,0);
  v_un_rest   := v_un_atual - v_un;
  v_val_rest  := v_val_atual - coalesce(v_r.cust_total,0);
  select count(*) into v_vendas_depois from vendas
   where prod = v_r.prod and coalesce(cancelada,false) = false and data >= v_r.data;
  v_pode := (v_vendas_depois = 0 and v_un_rest > 0 and v_val_rest > 0);
  v_raw  := case when v_pode then v_val_rest / v_un_rest else coalesce(v_p.custo_frasco,0) end;
  update produtos set
    caixas  = caixas  - case when v_r.tipo = 'caixa'  then v_r.qtd else 0 end,
    frascos = frascos - case when v_r.tipo <> 'caixa' then v_r.qtd else 0 end,
    custo_frasco = round(v_raw, 2), custo_caixa = round(v_raw * v_fpc, 2)
  where id = v_p.id;
  select * into v_saida from saidas
   where id = v_r.id + 1 and tipo = 'fornecedor' and abs(coalesce(val,0) - coalesce(v_r.cust_total,0)) < 0.01;
  if found then delete from saidas where id = v_saida.id; v_saida_txt := 'R$ ' || to_char(v_saida.val,'FM999999990.00'); end if;
  delete from reposicoes where id = v_r.id;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'REPOSICAO_ESTORNADA',
          concat_ws(' - ', v_p.nome, v_r.qtd || ' ' || v_r.tipo || '(s)',
                    'R$ ' || to_char(v_r.cust_total,'FM999999990.00'),
                    case when v_pode then 'custo medio recalculado' else 'custo medio mantido' end,
                    'saida: ' || v_saida_txt), 'servidor');
  select * into v_p from produtos where id = v_p.id;
  return jsonb_build_object('repetida', false, 'recalculou_custo', v_pode, 'vendas_depois', v_vendas_depois,
                            'saida_removida', v_saida_txt, 'produto', to_jsonb(v_p));
end $fn$;
revoke all on function public.vsp_estornar_compra(bigint,text,text) from public, anon;
grant execute on function public.vsp_estornar_compra(bigint,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- ROLLBACK (não toca em dado; o app deixa de conseguir vender/cancelar/estornar):
--   drop function if exists public.vsp_registrar_venda(jsonb,text);
--   drop function if exists public.vsp_cancelar_venda(bigint,text,text,text);
--   drop function if exists public.vsp_estornar_compra(bigint,text,text);
-- ---------------------------------------------------------------------------
