-- ============================================================================
-- 006 — LEDGER DA CONTA DO VICTOR
-- Aplicado em produção em 16/09/2026.
--
-- PRINCÍPIO: estoque físico e dívida com Victor são conceitos diferentes.
-- A obrigação empresa ↔ Victor nasce de MOVIMENTOS FINANCEIROS, nunca do estoque.
-- Quebra, perda, sobra de inventário e venda mexem no estoque e NÃO tocam neste razão.
--
-- CONVENÇÃO DE SINAL (única, usada em todo o sistema):
--   saldo POSITIVO = a empresa DEVE a Victor
--   débito aumenta a dívida · crédito reduz a dívida
-- ============================================================================

create table if not exists public.ledger_victor (
  id           bigserial primary key,
  data         date        not null,
  tipo         text        not null,
  direcao      text        not null,
  valor        numeric     not null,
  descricao    text        not null,
  origem_tipo  text,
  origem_id    bigint,
  op_id        text,
  estorna_id   bigint      references public.ledger_victor(id) on delete restrict,
  estornado_em timestamptz,
  created_at   timestamptz not null default now(),
  created_by   text        not null
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname='chk_lv_tipo') then
    alter table public.ledger_victor add constraint chk_lv_tipo
      check (tipo in ('saldo_inicial','compra_financiada','reembolso','ajuste_financeiro','estorno'));
  end if;
  if not exists (select 1 from pg_constraint where conname='chk_lv_direcao') then
    alter table public.ledger_victor add constraint chk_lv_direcao check (direcao in ('debito','credito'));
  end if;
  if not exists (select 1 from pg_constraint where conname='chk_lv_valor') then
    alter table public.ledger_victor add constraint chk_lv_valor check (valor > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname='chk_lv_origem') then
    alter table public.ledger_victor add constraint chk_lv_origem
      check (origem_tipo is null or origem_tipo in ('reposicao','saida','migracao','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname='chk_lv_created_by') then
    alter table public.ledger_victor add constraint chk_lv_created_by check (btrim(created_by) <> '');
  end if;
end $$;

-- Identidade determinística: a mesma origem nunca entra duas vezes. É isto que torna o
-- backfill idempotente sem precisar de flag de controle nem tabela de migração.
create unique index if not exists ux_lv_origem on public.ledger_victor (origem_tipo, origem_id)
  where origem_tipo is not null and origem_id is not null;
create unique index if not exists ux_lv_op_id on public.ledger_victor (op_id) where op_id is not null;
create index if not exists idx_lv_data on public.ledger_victor (data, id);

-- RLS: mesmo padrão das demais tabelas. Sem DELETE — histórico financeiro não se apaga,
-- correção é por estorno compensatório.
alter table public.ledger_victor enable row level security;
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='ledger_victor' loop
    execute format('drop policy %I on public.ledger_victor', pol.policyname);
  end loop;
end $$;
create policy vsp_select_ledger_victor on public.ledger_victor for select to authenticated using (public.vsp_autorizado());
create policy vsp_insert_ledger_victor on public.ledger_victor for insert to authenticated with check (public.vsp_autorizado());
create policy vsp_update_ledger_victor on public.ledger_victor for update to authenticated using (public.vsp_autorizado()) with check (public.vsp_autorizado());

-- ---------------------------------------------------------------------------
-- SALDO E EXTRATO
-- ---------------------------------------------------------------------------
create or replace function public.vsp_saldo_victor() returns numeric
language sql stable security definer set search_path = public, pg_temp as $fn$
  select coalesce(sum(case when direcao='debito' then valor else -valor end), 0)
  from public.ledger_victor where estornado_em is null;
$fn$;
revoke all on function public.vsp_saldo_victor() from public, anon;
grant execute on function public.vsp_saldo_victor() to authenticated;

create or replace view public.v_ledger_victor as
select l.*,
  sum(case when l.direcao='debito' then l.valor else -l.valor end)
    over (order by l.data, l.id rows between unbounded preceding and current row) as saldo_corrido
from public.ledger_victor l where l.estornado_em is null;
grant select on public.v_ledger_victor to authenticated;

-- ---------------------------------------------------------------------------
-- BACKFILL HISTÓRICO — idempotente
--
-- SALDO INICIAL: a 1ª venda registrada é de 08/06/2026 e a 1ª compra só de 10/07/2026 —
-- 32 dias de vendas consumindo mercadoria que Victor financiou e que nunca foi lançada
-- como compra. O valor dessas compras não existe em nenhum registro, então entra como um
-- único movimento explícito, datado no dia anterior à 1ª venda. Só essa parcela é
-- irreconstruível; todo o resto vira movimento com origem rastreável.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_ledger_backfill()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_corte date; v_sem_registro numeric; v_ator text := 'migracao';
  n_ini int := 0; n_deb int := 0; n_cre int := 0;
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;

  select (select min(data) from vendas where coalesce(cancelada,false)=false) - 1 into v_corte;
  select (select sum(custo) from vendas where coalesce(cancelada,false)=false)
       + (select sum(caixas*custo_caixa+frascos*custo_frasco) from produtos)
       - (select sum(cust_total) from reposicoes) into v_sem_registro;

  if v_sem_registro > 0 then
    insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, created_by)
    values (v_corte, 'saldo_inicial', 'debito', round(v_sem_registro,2),
            'Mercadoria financiada por Victor antes de as compras passarem a ser registradas (vendas desde ' ||
            (select min(data) from vendas where coalesce(cancelada,false)=false) ||
            ', 1a compra registrada em ' || (select min(data) from reposicoes) ||
            '). Valor = mercadoria que passou menos compras registradas. Nao reconstruivel movimento a movimento.',
            'migracao', 0, v_ator)
    on conflict (origem_tipo, origem_id) where origem_tipo is not null and origem_id is not null do nothing;
    get diagnostics n_ini = row_count;
  end if;

  insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, created_by)
  select r.data, 'compra_financiada', 'debito', r.cust_total,
         'Compra de ' || coalesce(p.nome, r.prod) || ' - ' || r.qtd || ' ' || r.tipo || '(s)' ||
         case when coalesce(r.forn,'') <> '' then ' - fornecedor ' || r.forn else '' end,
         'reposicao', r.id, v_ator
  from reposicoes r left join produtos p on p.id = r.prod
  where r.cust_total > 0
  on conflict (origem_tipo, origem_id) where origem_tipo is not null and origem_id is not null do nothing;
  get diagnostics n_deb = row_count;

  insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, created_by)
  select s.data, 'reembolso', 'credito', s.val,
         coalesce(nullif(btrim(s.descricao),''), 'Reembolso a Victor'),
         'saida', s.id, v_ator
  from saidas s where s.tipo = 'fornecedor' and s.val > 0
  on conflict (origem_tipo, origem_id) where origem_tipo is not null and origem_id is not null do nothing;
  get diagnostics n_cre = row_count;

  return jsonb_build_object('saldo_inicial_criado', n_ini, 'debitos_criados', n_deb, 'creditos_criados', n_cre,
    'total_movimentos', (select count(*) from public.ledger_victor));
end $fn$;
revoke all on function public.vsp_ledger_backfill() from public, anon;
grant execute on function public.vsp_ledger_backfill() to authenticated;

-- ---------------------------------------------------------------------------
-- ESTORNO DE MOVIMENTO — por compensação, nunca por delete
-- ---------------------------------------------------------------------------
create or replace function public.vsp_ledger_estornar_origem(p_origem_tipo text, p_origem_id bigint, p_motivo text)
returns int language plpgsql security definer set search_path = public, pg_temp as $fn$
declare m public.ledger_victor%rowtype; v_ator text := public.vsp_ator(); n int := 0;
begin
  for m in select * from public.ledger_victor
           where origem_tipo = p_origem_tipo and origem_id = p_origem_id and estornado_em is null loop
    insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, estorna_id, created_by)
    values (current_date, 'estorno',
            case when m.direcao = 'debito' then 'credito' else 'debito' end,
            m.valor, 'Estorno do movimento #' || m.id || ' - ' || coalesce(p_motivo,'sem motivo'),
            'manual', null, m.id, v_ator);
    update public.ledger_victor set estornado_em = now() where id = m.id;
    n := n + 1;
  end loop;
  return n;
end $fn$;
revoke all on function public.vsp_ledger_estornar_origem(text,bigint,text) from public, anon;
grant execute on function public.vsp_ledger_estornar_origem(text,bigint,text) to authenticated;

-- ---------------------------------------------------------------------------
-- REEMBOLSO AO VICTOR — saída financeira + crédito no ledger + auditoria, atômicos
--
-- Reembolso NÃO é despesa operacional: o custo da mercadoria já saiu no CMV de cada venda.
-- Entra como saída tipo 'fornecedor', que o Fechamento já exclui do resultado (correção C1).
-- ---------------------------------------------------------------------------
create or replace function public.vsp_reembolsar_victor(p_valor numeric, p_data date, p_descricao text, p_pgto text, p_op_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_ja saidas%rowtype; v_s saidas%rowtype; v_ator text := public.vsp_ator(); v_id bigint;
begin
  if not public.vsp_autorizado() then raise exception 'nao autorizado'; end if;
  if coalesce(btrim(p_op_id),'') = '' then raise exception 'op_id obrigatorio'; end if;
  if p_valor is null or p_valor <= 0 then raise exception 'valor do reembolso precisa ser maior que zero'; end if;
  if p_data is null then raise exception 'data obrigatoria'; end if;

  select * into v_ja from saidas where op_id = p_op_id;
  if found then return jsonb_build_object('repetida', true, 'saida', to_jsonb(v_ja), 'saldo_victor', public.vsp_saldo_victor()); end if;

  v_id := (extract(epoch from clock_timestamp())*1000)::bigint;
  insert into saidas (id, tipo, socio, descricao, data, val, pgto, op_id)
  values (v_id, 'fornecedor', 'Victor', coalesce(nullif(btrim(p_descricao),''), 'Reembolso a Victor'),
          p_data, round(p_valor,2), coalesce(nullif(p_pgto,''),'pix'), p_op_id)
  returning * into v_s;

  insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, op_id, created_by)
  values (p_data, 'reembolso', 'credito', round(p_valor,2), v_s.descricao, 'saida', v_s.id, p_op_id, v_ator);

  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values (v_id + 1, now(), to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'REEMBOLSO_VICTOR',
          'R$ ' || to_char(round(p_valor,2),'FM999999990.00') || ' - ' || v_s.descricao ||
          ' - saldo passou para R$ ' || to_char(public.vsp_saldo_victor(),'FM999999990.00'), 'servidor');

  return jsonb_build_object('repetida', false, 'saida', to_jsonb(v_s), 'saldo_victor', public.vsp_saldo_victor());
end $fn$;
revoke all on function public.vsp_reembolsar_victor(numeric,date,text,text,text) from public, anon;
grant execute on function public.vsp_reembolsar_victor(numeric,date,text,text,text) to authenticated;

-- NOTA: vsp_registrar_compra foi alterada para inserir o movimento 'compra_financiada'
-- no ledger dentro da mesma transação. Ver o corpo atual da função no banco.
