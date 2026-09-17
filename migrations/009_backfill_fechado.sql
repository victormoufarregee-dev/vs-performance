-- =============================================================================
-- 009 — vsp_ledger_backfill fechado para a API (hardening pós-baseline, 17/09/2026)
-- =============================================================================
-- O backfill é administrativo: montou o razão uma vez, na 006 (16/09/2026). O Supabase
-- Advisor o apontava como SECURITY DEFINER executável por `authenticated`.
--
-- Provado antes de aplicar (banco real, só leitura):
--   * o app (index.html, sw.js) não chama; nenhuma função, view, política, trigger ou job
--     cita a função; não há pg_cron;
--   * backfill concluído: saldo inicial presente, 0 compras sem débito, 0 pagamentos ao
--     fornecedor sem crédito (desde a 008 os triggers mantêm isso sozinhos).
--
-- Só muda permissão. O corpo da função fica igual (contrato: mesmo md5).
-- Continua executável por postgres (owner) e service_role; note que a própria função
-- exige vsp_autorizado(), então chamá-la sem sessão de usuário autorizado falha de qualquer jeito.

revoke execute on function public.vsp_ledger_backfill() from public, anon, authenticated;

-- ROLLBACK (só se um backfill novo for realmente necessário, e revogar de novo depois):
--   grant execute on function public.vsp_ledger_backfill() to authenticated;
