-- ============================================================================
-- 008 — O RAZÃO DO VICTOR ACOMPANHA TODO LANÇAMENTO; CAIXA ESPERADO SÓ ATÉ HOJE
-- Escrita em 17/09/2026 na auditoria de encerramento. Aplicada conforme APLICADO.md.
--
-- BUGS CORRIGIDOS (latentes: nenhum dado real afetado até a aplicação — saídas e
-- reposições não mudaram desde a 006):
--
--  A) Reembolso ao Victor lançado no Financeiro ("Pagamento fornecedor") gravava só a saída.
--     O razão não recebia o crédito e a Conta do Victor não baixava.
--  B) Excluir um pagamento ao fornecedor apagava a saída e deixava o crédito no razão.
--  C) Estornar uma compra apagava a reposição e deixava o débito no razão.
--  D) vsp_saldo_victor() e vsp_ledger_estornar_origem() são SECURITY DEFINER e não
--     conferiam a allowlist: qualquer conta autenticada fora dela lia o saldo ou gravava
--     estorno no razão (cadastro público está desligado, então só conta já existente).
--  F) vsp_caixa_esperado_calc() somava venda e saída com data FUTURA no caixa de hoje.
--
-- POR QUE TRIGGER: o razão tem de acompanhar a saída/reposição em QUALQUER caminho de
-- gravação (app, API, SQL Editor), na mesma transação. Um trigger não depende de o cliente
-- lembrar de chamar a função certa — foi exatamente esse esquecimento que causou A, B e C.
--
-- NÃO MUDA: fórmula da dívida (débitos − créditos), convenção de sinal, estorno por
-- compensação (nada é apagado do razão), assinatura de nenhuma RPC.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- D) saldo do Victor só para quem está na allowlist
-- ---------------------------------------------------------------------------
create or replace function public.vsp_saldo_victor() returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  -- sessão da API sem allowlist não lê o saldo. Sem sessão (SQL Editor, dono do banco) lê.
  if public.vsp_uid_sessao() is not null and not public.vsp_autorizado() then
    raise exception 'nao autorizado' using errcode = '42501';
  end if;
  return (select coalesce(sum(case when direcao='debito' then valor else -valor end), 0) from public.ledger_victor);
end $fn$;
revoke all on function public.vsp_saldo_victor() from public, anon;
grant execute on function public.vsp_saldo_victor() to authenticated;

-- auth.uid() à prova de contexto (no SQL Editor não há JWT)
create or replace function public.vsp_uid_sessao() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
begin
  return auth.uid();
exception when others then
  return null;
end $fn$;
revoke all on function public.vsp_uid_sessao() from public, anon, authenticated;

-- D) estorno de origem: o app não chama; só os triggers abaixo (como dono do banco)
revoke execute on function public.vsp_ledger_estornar_origem(text,bigint,text) from authenticated;

-- ---------------------------------------------------------------------------
-- A) todo pagamento ao fornecedor é reembolso ao Victor e credita o razão
-- ---------------------------------------------------------------------------
create or replace function public.vsp_lv_saida_inserida() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.tipo = 'fornecedor' and coalesce(new.val, 0) > 0 then
    insert into public.ledger_victor (data, tipo, direcao, valor, descricao, origem_tipo, origem_id, op_id, created_by)
    values (new.data, 'reembolso', 'credito', round(new.val::numeric, 2),
            coalesce(nullif(btrim(new.descricao), ''), 'Reembolso a Victor'),
            'saida', new.id, new.op_id, public.vsp_ator())
    on conflict (origem_tipo, origem_id) where origem_tipo is not null and origem_id is not null do nothing;
  end if;
  return null;
end $fn$;
revoke all on function public.vsp_lv_saida_inserida() from public, anon, authenticated;
drop trigger if exists trg_lv_saida_inserida on public.saidas;
create trigger trg_lv_saida_inserida after insert on public.saidas
  for each row execute function public.vsp_lv_saida_inserida();

-- B) excluir um pagamento ao fornecedor estorna o crédito (por compensação)
create or replace function public.vsp_lv_saida_excluida() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if old.tipo = 'fornecedor' then
    perform public.vsp_ledger_estornar_origem('saida', old.id, 'Pagamento ao fornecedor excluido do Financeiro');
  end if;
  return null;
end $fn$;
revoke all on function public.vsp_lv_saida_excluida() from public, anon, authenticated;
drop trigger if exists trg_lv_saida_excluida on public.saidas;
create trigger trg_lv_saida_excluida after delete on public.saidas
  for each row execute function public.vsp_lv_saida_excluida();

-- A/B) pagamento ao fornecedor não se edita: o razão já registrou o valor. Exclua e lance de
-- novo. (O app não edita saída; isto fecha o caminho pela API.)
create or replace function public.vsp_lv_saida_editada() returns trigger
language plpgsql set search_path = public, pg_temp as $fn$
begin
  if (old.tipo = 'fornecedor' or new.tipo = 'fornecedor')
     and (new.tipo is distinct from old.tipo or new.val is distinct from old.val
          or new.data is distinct from old.data or new.id is distinct from old.id) then
    raise exception 'Pagamento ao fornecedor nao se edita (o razao do Victor ja registrou). Exclua e lance de novo.'
      using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function public.vsp_lv_saida_editada() from public, anon, authenticated;
drop trigger if exists trg_lv_saida_editada on public.saidas;
create trigger trg_lv_saida_editada before update on public.saidas
  for each row execute function public.vsp_lv_saida_editada();

-- C) estornar (apagar) uma compra estorna o débito
create or replace function public.vsp_lv_reposicao_excluida() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  perform public.vsp_ledger_estornar_origem('reposicao', old.id, 'Compra estornada');
  return null;
end $fn$;
revoke all on function public.vsp_lv_reposicao_excluida() from public, anon, authenticated;
drop trigger if exists trg_lv_reposicao_excluida on public.reposicoes;
create trigger trg_lv_reposicao_excluida after delete on public.reposicoes
  for each row execute function public.vsp_lv_reposicao_excluida();

-- ---------------------------------------------------------------------------
-- A) reembolso pela RPC: a saída agora credita o razão pelo trigger; a RPC não insere de
-- novo (senão seriam dois créditos) e devolve o movimento que o trigger criou.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_reembolsar_victor(p_valor numeric, p_data date, p_descricao text, p_pgto text, p_op_id text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $fn$
declare v_ja saidas%rowtype; v_s saidas%rowtype; v_mov public.ledger_victor%rowtype; v_ator text := public.vsp_ator(); v_id bigint;
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
  select * into v_mov from public.ledger_victor where origem_tipo = 'saida' and origem_id = v_s.id;
  insert into audit_log (id, ts, display, usuario, acao, detalhes, dispositivo)
  values (v_id + 1, now(), to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
          v_ator, 'REEMBOLSO_VICTOR',
          'R$ ' || to_char(round(p_valor,2),'FM999999990.00') || ' - ' || v_s.descricao ||
          ' - saldo passou para R$ ' || to_char(public.vsp_saldo_victor(),'FM999999990.00'), 'servidor');
  return jsonb_build_object('repetida', false, 'saida', to_jsonb(v_s), 'movimento', to_jsonb(v_mov), 'saldo_victor', public.vsp_saldo_victor());
end $fn$;
revoke all on function public.vsp_reembolsar_victor(numeric,date,text,text,text) from public, anon;
grant execute on function public.vsp_reembolsar_victor(numeric,date,text,text,text) to authenticated;

-- ---------------------------------------------------------------------------
-- F) caixa esperado AGORA: lançamento com data futura ainda não aconteceu.
-- Data de referência = hoje em America/Sao_Paulo (a data que o app grava).
-- Crédito e parcelado continuam contando no dia da venda: o Victor confirmou em 17/09/2026
-- que a maquininha repassa tudo em 1–2 dias.
-- ---------------------------------------------------------------------------
create or replace function public.vsp_caixa_esperado_calc()
returns numeric language sql stable security definer
set search_path = public, pg_temp as $fn$
  select round(
      coalesce((select sum(v.liq::numeric) from public.vendas v
                 where not coalesce(v.cancelada, false)
                   and (v.pgto is distinct from 'fiado' or coalesce(v.quitado, false))
                   and v.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)
    - coalesce((select sum(s.val::numeric) from public.saidas s
                 where s.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)
  , 2);
$fn$;
revoke all on function public.vsp_caixa_esperado_calc() from public, anon, authenticated;

-- ROLLBACK (só se necessário; os movimentos já gravados no razão pelos triggers ficam):
--   drop trigger if exists trg_lv_saida_inserida on public.saidas;
--   drop trigger if exists trg_lv_saida_excluida on public.saidas;
--   drop trigger if exists trg_lv_saida_editada on public.saidas;
--   drop trigger if exists trg_lv_reposicao_excluida on public.reposicoes;
--   e reaplicar as definições da 006/007.
