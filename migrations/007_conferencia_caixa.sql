-- ============================================================================
-- 007 — CONFERÊNCIA DE CAIXA
-- Escrita em 17/09/2026. NÃO APLICADA até constar em migrations/APLICADO.md.
--
-- PERGUNTA QUE RESPONDE: o dinheiro que existe de verdade bate com o que o sistema diz?
--
-- É uma camada de VERIFICAÇÃO. Ela só LÊ vendas e saídas para tirar uma foto do caixa
-- esperado e grava essa foto ao lado do saldo que a pessoa contou. Não cria despesa, não
-- edita venda, não mexe no razão do Victor, não corrige nada. Uma diferença registrada é
-- evidência para investigar depois, não um lançamento.
--
-- CONVENÇÃO ÚNICA:  diferenca = saldo_real − saldo_esperado
--   0 confere · positivo = existe MAIS dinheiro que o esperado · negativo = existe MENOS
--
-- FONTE DO CAIXA ESPERADO (a mesma do "Resultado (caixa)" do Financeiro, renderFin(),
-- que mostrava −R$ 3,49 = 51.066,00 recebidos − 51.069,49 de saídas em 15/09/2026):
--   Σ vendas.liq   das vendas NÃO canceladas e (não fiado OU fiado quitado)
-- − Σ saidas.val   de TODAS as saídas (pró-labore, retirada, fornecedor/reembolso ao
--                  Victor, despesa, imposto, outros)
--   desde o início, sem filtro de data, sem saldo inicial.
-- Compra de mercadoria NÃO entra (quem paga é o Victor; vira dívida no ledger_victor).
-- O reembolso ao Victor entra porque vsp_reembolsar_victor grava uma saída.
-- Estoque, CMV, lucro e a dívida com o Victor NÃO entram.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Caixa esperado — uma função só, usada pela tela e pela conferência
-- ---------------------------------------------------------------------------
create or replace function public.vsp_caixa_esperado_calc()
returns numeric language sql stable security definer
set search_path = public, pg_temp as $fn$
  -- cada valor vira numeric ANTES de somar (se a coluna for double precision, a soma em
  -- ponto flutuante poderia errar o centavo). Soma tudo e arredonda UMA vez no fim — a mesma
  -- regra do renderFin(); arredondar linha a linha seria uma segunda fórmula.
  select round(
      coalesce((select sum(v.liq::numeric) from public.vendas v
                 where not coalesce(v.cancelada, false)
                   and (v.pgto is distinct from 'fiado' or coalesce(v.quitado, false))), 0)
    - coalesce((select sum(s.val::numeric) from public.saidas s), 0)
  , 2);
$fn$;
revoke all on function public.vsp_caixa_esperado_calc() from public, anon, authenticated;

create or replace function public.vsp_caixa_esperado()
returns numeric language plpgsql stable security definer
set search_path = public, pg_temp as $fn$
begin
  if not public.vsp_autorizado() then
    raise exception 'nao autorizado' using errcode = '42501';
  end if;
  return public.vsp_caixa_esperado_calc();
end $fn$;
revoke all on function public.vsp_caixa_esperado() from public, anon;
grant execute on function public.vsp_caixa_esperado() to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Tabela — cada linha é uma FOTO. Os números nunca mudam depois de gravados.
-- ---------------------------------------------------------------------------
create table if not exists public.conferencias_caixa (
  id                  bigserial     primary key,
  conferido_em        timestamptz   not null default now(),
  -- V1 é consolidada (todo o dinheiro, somado). A coluna existe para, no futuro, uma
  -- conferência por conta ('banco_x', 'especie') sem migrar esta tabela.
  escopo              text          not null default 'consolidado',
  saldo_esperado      numeric(14,2) not null,
  saldo_real          numeric(14,2) not null,
  diferenca           numeric(14,2) not null,
  observacao          text          not null default '',
  situacao            text          not null default 'valida',
  invalidada_em       timestamptz,
  invalidada_por      text,
  motivo_invalidacao  text,
  op_id               text          not null,
  created_at          timestamptz   not null default now(),
  created_by          text          not null,
  constraint chk_cc_escopo      check (escopo = 'consolidado'),
  constraint chk_cc_diferenca   check (diferenca = saldo_real - saldo_esperado),
  constraint chk_cc_situacao    check (situacao in ('valida','invalidada')),
  constraint chk_cc_invalidacao check (
    (situacao = 'valida' and invalidada_em is null and invalidada_por is null and motivo_invalidacao is null)
    or (situacao = 'invalidada' and invalidada_em is not null and btrim(coalesce(invalidada_por,'')) <> ''
        and btrim(coalesce(motivo_invalidacao,'')) <> '')),
  constraint chk_cc_op_id       check (btrim(op_id) <> ''),
  constraint chk_cc_created_by  check (btrim(created_by) <> '')
);
create unique index if not exists ux_cc_op_id on public.conferencias_caixa (op_id);
create index if not exists idx_cc_conferido on public.conferencias_caixa (conferido_em desc, id desc);

-- A foto é imutável: só a situação pode passar de 'valida' para 'invalidada', uma vez,
-- com motivo. Nada apaga. Vale até para quem passa por cima da RLS (SECURITY DEFINER,
-- service_role): o trigger roda para todo mundo.
create or replace function public.vsp_cc_protege()
returns trigger language plpgsql
set search_path = public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'Conferência de caixa não se apaga: invalide com motivo e registre outra.'
      using errcode = '42501';
  end if;
  if new.id is distinct from old.id
     or new.conferido_em   is distinct from old.conferido_em
     or new.escopo         is distinct from old.escopo
     or new.saldo_esperado is distinct from old.saldo_esperado
     or new.saldo_real     is distinct from old.saldo_real
     or new.diferenca      is distinct from old.diferenca
     or new.observacao     is distinct from old.observacao
     or new.op_id          is distinct from old.op_id
     or new.created_at     is distinct from old.created_at
     or new.created_by     is distinct from old.created_by then
    raise exception 'Os números de uma conferência registrada não mudam.' using errcode = '42501';
  end if;
  if old.situacao = 'invalidada' then
    raise exception 'Esta conferência já foi invalidada.' using errcode = '42501';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_cc_protege on public.conferencias_caixa;
create trigger trg_cc_protege before update or delete on public.conferencias_caixa
  for each row execute function public.vsp_cc_protege();

-- RLS: quem está na allowlist LÊ. Escrever, só pelas funções abaixo.
alter table public.conferencias_caixa enable row level security;
do $$ declare pol record; begin
  for pol in select policyname from pg_policies where schemaname='public' and tablename='conferencias_caixa' loop
    execute format('drop policy %I on public.conferencias_caixa', pol.policyname);
  end loop;
end $$;
create policy vsp_select_conferencias_caixa on public.conferencias_caixa
  for select to authenticated using (public.vsp_autorizado());
revoke all on public.conferencias_caixa from public, anon;
revoke insert, update, delete, truncate on public.conferencias_caixa from authenticated;
grant select on public.conferencias_caixa to authenticated;
revoke all on sequence public.conferencias_caixa_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Registrar — o cliente manda SÓ o saldo contado, a observação e o op_id.
--    Não existe parâmetro para saldo esperado, diferença ou autor.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $fn$
declare
  v_ator text;
  v_esp  numeric(14,2);
  v_c    public.conferencias_caixa%rowtype;
begin
  if not public.vsp_autorizado() then
    raise exception 'nao autorizado' using errcode = '42501';
  end if;
  v_ator := public.vsp_ator();
  if coalesce(btrim(v_ator),'') = '' then
    raise exception 'nao foi possivel identificar quem esta conferindo' using errcode = '42501';
  end if;
  if coalesce(btrim(p_op_id),'') = '' then
    raise exception 'op_id obrigatorio';
  end if;

  -- mesmo op_id = a mesma conferência (retry depois de a resposta se perder)
  select * into v_c from public.conferencias_caixa where op_id = p_op_id;
  if found then
    return jsonb_build_object('repetida', true, 'conferencia', to_jsonb(v_c),
                              'caixa_esperado_agora', public.vsp_caixa_esperado_calc());
  end if;

  if p_saldo_real is null then
    raise exception 'Informe quanto dinheiro existe agora.';
  end if;
  if p_saldo_real <> round(p_saldo_real, 2) then
    raise exception 'O saldo real aceita no máximo 2 casas decimais (centavos).';
  end if;
  if abs(p_saldo_real) >= 1000000000000 then
    raise exception 'Saldo real fora do limite.';
  end if;

  -- a foto do que o sistema acredita AGORA, calculada aqui dentro
  v_esp := public.vsp_caixa_esperado_calc();

  begin
    insert into public.conferencias_caixa
      (saldo_esperado, saldo_real, diferenca, observacao, op_id, created_by)
    values
      (v_esp, round(p_saldo_real, 2), round(p_saldo_real, 2) - v_esp,
       coalesce(btrim(p_observacao), ''), p_op_id, v_ator)
    returning * into v_c;
  exception when unique_violation then
    -- duas chamadas com o mesmo op_id ao mesmo tempo: a outra ganhou, devolve a dela
    select * into v_c from public.conferencias_caixa where op_id = p_op_id;
    return jsonb_build_object('repetida', true, 'conferencia', to_jsonb(v_c),
                              'caixa_esperado_agora', public.vsp_caixa_esperado_calc());
  end;

  perform public.vsp_audit('CONFERENCIA_CAIXA',
    'Esperado ' || public.vsp_brl(v_c.saldo_esperado) ||
    ' · real '  || public.vsp_brl(v_c.saldo_real) ||
    ' · diferença ' || public.vsp_brl(v_c.diferenca) ||
    case when v_c.observacao <> '' then ' · ' || v_c.observacao else '' end ||
    ' · conferência ' || v_c.id, v_ator);

  return jsonb_build_object('repetida', false, 'conferencia', to_jsonb(v_c),
                            'caixa_esperado_agora', public.vsp_caixa_esperado_calc());
end $fn$;
revoke all on function public.vsp_registrar_conferencia_caixa(numeric,text,text) from public, anon;
grant execute on function public.vsp_registrar_conferencia_caixa(numeric,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Invalidar — digitou errado? Marca como invalidada, com motivo, e registra outra.
--    A linha antiga continua lá, com os números originais.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_invalidar_conferencia_caixa(p_id bigint, p_motivo text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp as $fn$
declare
  v_ator text;
  v_c    public.conferencias_caixa%rowtype;
begin
  if not public.vsp_autorizado() then
    raise exception 'nao autorizado' using errcode = '42501';
  end if;
  v_ator := public.vsp_ator();
  if coalesce(btrim(v_ator),'') = '' then
    raise exception 'nao foi possivel identificar quem esta invalidando' using errcode = '42501';
  end if;
  if coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Informe o motivo da invalidação.';
  end if;

  select * into v_c from public.conferencias_caixa where id = p_id for update;
  if not found then
    raise exception 'Conferência % não encontrada.', p_id;
  end if;
  if v_c.situacao = 'invalidada' then
    return jsonb_build_object('repetida', true, 'conferencia', to_jsonb(v_c));
  end if;

  update public.conferencias_caixa
     set situacao = 'invalidada', invalidada_em = now(),
         invalidada_por = v_ator, motivo_invalidacao = btrim(p_motivo)
   where id = p_id
  returning * into v_c;

  perform public.vsp_audit('CONFERENCIA_CAIXA_INVALIDADA',
    'Conferência ' || v_c.id || ' (esperado ' || public.vsp_brl(v_c.saldo_esperado) ||
    ', real ' || public.vsp_brl(v_c.saldo_real) || ', diferença ' || public.vsp_brl(v_c.diferenca) ||
    ') invalidada. Motivo: ' || v_c.motivo_invalidacao, v_ator);

  return jsonb_build_object('repetida', false, 'conferencia', to_jsonb(v_c));
end $fn$;
revoke all on function public.vsp_invalidar_conferencia_caixa(bigint,text) from public, anon;
grant execute on function public.vsp_invalidar_conferencia_caixa(bigint,text) to authenticated;

-- Rollback (só se nenhuma conferência real tiver sido registrada):
--   drop function if exists public.vsp_invalidar_conferencia_caixa(bigint,text);
--   drop function if exists public.vsp_registrar_conferencia_caixa(numeric,text,text);
--   drop table if exists public.conferencias_caixa;      -- apaga o trigger junto
--   drop function if exists public.vsp_cc_protege();
--   drop function if exists public.vsp_caixa_esperado();
--   drop function if exists public.vsp_caixa_esperado_calc();
