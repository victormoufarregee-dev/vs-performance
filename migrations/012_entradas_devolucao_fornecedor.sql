-- ============================================================================
-- 012 — ENTRADA QUE NÃO É VENDA: devolução de fornecedor
--
-- POR QUE: em 23/09/2026 o Hassan trocou a compra de TG de 15/09 (8 cx a R$ 582,50 =
-- R$ 4.660) por 5 cx a R$ 592 (R$ 2.960) e devolveu os R$ 1.700 de diferença para a
-- EMPRESA. O caixa do sistema era só "vendas recebidas − saídas": não havia onde lançar
-- dinheiro que entra sem ser venda. Sem isto, toda conferência de caixa a partir de hoje
-- acusaria R$ 1.700 a mais no real do que no esperado.
--
-- REGRA: entrada soma no CAIXA e só no caixa.
--   * NÃO é receita nem lucro: não entra em faturamento, lucro das vendas, margem, DRE.
--   * NÃO mexe na Conta do Victor. Quem pagou o fornecedor e se a dívida muda é decisão
--     de cada caso — no caso do Hassan a dívida ficou a mesma (ajuste #160 no razão).
--   * NÃO mexe em estoque (a compra já foi corrigida por estorno + compra nova).
--
-- COMO GRAVA: só por RPC (vsp_registrar_entrada / vsp_excluir_entrada), idempotente por
-- op_id, autor pela sessão (vsp_ator), auditoria na mesma transação. authenticated só lê.
--
-- NÃO MUDA: nenhuma tabela existente, nenhum dado, nenhuma outra RPC. Muda UMA função
-- existente: vsp_caixa_esperado_calc passa a somar as entradas até hoje.
-- ROLLBACK no fim do arquivo.
-- ============================================================================

create table if not exists public.entradas (
  id          bigint        primary key,
  tipo        text          not null,
  fornecedor  text          not null,
  descricao   text          not null,
  data        date          not null,
  val         numeric(14,2) not null,
  pgto        text          not null default 'pix',
  op_id       text          not null,
  created_at  timestamptz   not null default now(),
  created_by  text          not null,
  constraint chk_ent_tipo       check (tipo in ('devolucao_fornecedor')),
  constraint chk_ent_val        check (val > 0),
  constraint chk_ent_fornecedor check (btrim(fornecedor) <> ''),
  constraint chk_ent_descricao  check (btrim(descricao) <> ''),
  constraint chk_ent_pgto       check (pgto in ('pix','transferencia','dinheiro','debito')),
  constraint chk_ent_op_id      check (btrim(op_id) <> ''),
  constraint chk_ent_created_by check (btrim(created_by) <> '')
);
create unique index if not exists ux_ent_op_id on public.entradas (op_id);
create index if not exists idx_ent_data on public.entradas (data, id);

-- RLS: só leitura pela API; gravação só pelas RPCs (SECURITY DEFINER).
alter table public.entradas enable row level security;
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='entradas' loop
    execute format('drop policy %I on public.entradas', pol.policyname);
  end loop;
end $$;
create policy vsp_select_entradas on public.entradas for select to authenticated using (public.vsp_autorizado());

-- Grants: a 010 só fechou tabela nova para anon; authenticated ainda nasce com ALL.
revoke all on public.entradas from public, anon, authenticated;
grant select on public.entradas to authenticated;

-- ---------------------------------------------------------------------------
-- Caixa esperado: + entradas até hoje (mesmo corte de data das vendas e saídas)
-- ---------------------------------------------------------------------------
create or replace function public.vsp_caixa_esperado_calc()
returns numeric language sql stable security definer
set search_path = public, pg_temp as $fn$
  select round(
      coalesce((select sum(v.liq::numeric) from public.vendas v
                 where not coalesce(v.cancelada, false)
                   and (v.pgto is distinct from 'fiado' or coalesce(v.quitado, false))
                   and v.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)
    + coalesce((select sum(e.val::numeric) from public.entradas e
                 where e.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)
    - coalesce((select sum(s.val::numeric) from public.saidas s
                 where s.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)
  , 2);
$fn$;
revoke all on function public.vsp_caixa_esperado_calc() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Registrar entrada — idempotente por op_id
-- ---------------------------------------------------------------------------
create or replace function public.vsp_registrar_entrada(p_ent jsonb, p_op_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_ja public.entradas%rowtype; v_e public.entradas%rowtype; v_ator text := public.vsp_ator();
  v_val numeric; v_data date; v_id bigint;
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado' using errcode = '42501'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  select * into v_ja from public.entradas where op_id = p_op_id;
  if found then return jsonb_build_object('repetida', true, 'entrada', to_jsonb(v_ja)); end if;
  if coalesce(p_ent->>'tipo','') <> 'devolucao_fornecedor' then raise exception 'tipo de entrada invalido'; end if;
  if coalesce(btrim(p_ent->>'fornecedor'),'') = '' then raise exception 'informe o fornecedor'; end if;
  if coalesce(btrim(p_ent->>'descricao'),'') = '' then raise exception 'informe a descricao'; end if;
  v_val  := (p_ent->>'val')::numeric;
  v_data := (p_ent->>'data')::date;
  if v_val is null or v_val <= 0 then raise exception 'valor precisa ser maior que zero'; end if;
  if v_val <> round(v_val, 2) then raise exception 'valor com mais de 2 casas decimais'; end if;
  if v_data is null then raise exception 'data obrigatoria'; end if;
  v_id := (extract(epoch from clock_timestamp())*1000)::bigint;
  insert into public.entradas (id, tipo, fornecedor, descricao, data, val, pgto, op_id, created_by)
  values (v_id, 'devolucao_fornecedor', btrim(p_ent->>'fornecedor'), btrim(p_ent->>'descricao'), v_data, v_val,
          coalesce(nullif(p_ent->>'pgto',''),'pix'), p_op_id, v_ator)
  returning * into v_e;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values (v_id, now(), to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'), v_ator,
          'ENTRADA', concat_ws(' - ', 'Devolucao de fornecedor', v_e.fornecedor, v_e.descricao,
                               'R$ ' || to_char(v_e.val,'FM999999990.00'), to_char(v_e.data,'DD/MM/YYYY')), 'servidor');
  return jsonb_build_object('repetida', false, 'entrada', to_jsonb(v_e));
end $fn$;
revoke all on function public.vsp_registrar_entrada(jsonb,text) from public, anon;
grant execute on function public.vsp_registrar_entrada(jsonb,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Excluir entrada lançada errado — a auditoria guarda a linha inteira
-- ---------------------------------------------------------------------------
create or replace function public.vsp_excluir_entrada(p_id bigint, p_motivo text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_e public.entradas%rowtype; v_ator text := public.vsp_ator();
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado' using errcode = '42501'; end if;
  if coalesce(btrim(p_motivo),'') = '' then raise exception 'informe o motivo da exclusao'; end if;
  delete from public.entradas where id = p_id returning * into v_e;
  if not found then return jsonb_build_object('repetida', true, 'aviso', 'entrada ja excluida ou inexistente'); end if;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values ((extract(epoch from clock_timestamp())*1000)::bigint, now(),
          to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'), v_ator,
          'ENTRADA_EXCLUIDA', concat_ws(' - ', v_e.fornecedor, v_e.descricao,
                                        'R$ ' || to_char(v_e.val,'FM999999990.00'), to_char(v_e.data,'DD/MM/YYYY'),
                                        'motivo: ' || btrim(p_motivo), 'linha: ' || to_jsonb(v_e)::text), 'servidor');
  return jsonb_build_object('repetida', false, 'excluida', to_jsonb(v_e));
end $fn$;
revoke all on function public.vsp_excluir_entrada(bigint,text) from public, anon;
grant execute on function public.vsp_excluir_entrada(bigint,text) to authenticated;

-- ============================================================================
-- ROLLBACK (as entradas lançadas se perdem; exporte antes):
--   drop function if exists public.vsp_registrar_entrada(jsonb,text);
--   drop function if exists public.vsp_excluir_entrada(bigint,text);
--   reaplicar vsp_caixa_esperado_calc da 008;
--   drop table if exists public.entradas;
-- ============================================================================
