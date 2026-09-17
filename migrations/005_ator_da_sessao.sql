-- ============================================================================
-- 005 — QUEM ESTÁ OPERANDO VEM DA SESSÃO, NUNCA DO PAYLOAD
-- Aplicada em produção em 15/09/2026 direto pelo SQL Editor, SEM ARQUIVO. Este arquivo
-- foi escrito em 17/09/2026 a partir de pg_proc (conferido por md5).
--
-- A VULNERABILIDADE (migrations/APLICADO.md, seção 005): as RPCs gravavam o nome que o
-- app mandava. Stefany, com o token dela, mandou usuario:'Victor' e o banco gravou
-- "Victor" na venda e na auditoria.
--
-- A CORREÇÃO: vsp_ator() resolve o nome por auth.uid() na allowlist. Todas as RPCs que
-- gravam autor usam esta função (004, 006, 007). Fora da allowlist o nome é
-- '(sessao desconhecida)' — mas nenhuma RPC chega a gravar nesse caso, porque todas
-- recusam antes em vsp_autorizado().
--
-- As RPCs que passaram a usar vsp_ator() nesta etapa estão com o texto vigente na 004.
-- DEPENDE DE: 003 (usuarios_autorizados).
-- ============================================================================
create or replace function public.vsp_ator()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select nome from public.usuarios_autorizados where uid = auth.uid() and ativo),
    '(sessao desconhecida)'
  );
$fn$;
revoke all on function public.vsp_ator() from public, anon;
grant execute on function public.vsp_ator() to authenticated;

-- ROLLBACK: não há — derrubar vsp_ator() quebra todas as RPCs de escrita.
