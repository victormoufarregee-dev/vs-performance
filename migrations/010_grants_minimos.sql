-- ============================================================================
-- 010 — Menor privilégio nos GRANTS de tabela (defesa em profundidade)
--
-- POR QUE: até aqui quem protegia as tabelas era só a RLS. Os grants continuavam
-- os padrões do Supabase — `anon` e `authenticated` com ALL (SELECT, INSERT,
-- UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER) em todas as tabelas de negócio.
-- A RLS segurava, e o teste test/sql/seguranca_rls.test.sql prova isso (102 ok).
-- Mas bastava uma policy escrita errado no futuro para o grant amplo virar buraco.
-- Esta migration alinha o GRANT ao que a POLICY já permite, tabela por tabela.
--
-- COMO FOI DECIDIDO: o alvo não foi inventado. É a interseção de
--   (a) o que as policies da 003/006/007 permitem (pg_policies), e
--   (b) o que o app realmente chama pelo PostgREST (auditado em index.html:
--       sbGet/sbPost/sbPatch/sbDelete + a fila offline).
-- Onde a policy permite mas o app nunca usa, o grant sai (ex.: INSERT em vendas,
-- que só acontece dentro de vsp_registrar_venda). As policies ficam onde estão:
-- sem grant, o comando nem chega na RLS.
--
-- NÃO MUDA: nenhuma policy, nenhuma função, nenhum dado. As RPCs são
-- SECURITY DEFINER de `postgres` — passam por cima de grant e de RLS, então
-- venda, compra, cancelamento, estorno, conferência e reembolso não são afetados.
-- Os triggers idem: o PostgreSQL só exige EXECUTE na criação do trigger.
--
-- ROLLBACK no fim do arquivo.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) anon não toca em nada. A chave pública do app só serve para o /auth.
--    (o app usa anon de propósito em testarSeguranca(), que passa a ver
--     "bloqueado (HTTP 401)" em vez de "protegida ✓" — continua verde)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- 2) authenticated: zera e devolve só o que policy + app precisam
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from authenticated;

--  tabela               | policy diz          | app usa                    | grant
-- ----------------------+---------------------+----------------------------+---------------
grant select, insert                on public.audit_log            to authenticated; -- S I   | sbGet + sbPost
grant select, insert, delete        on public.backups              to authenticated; -- S I D | sbGet + sbPost + sbDelete
grant select, insert, update        on public.clientes             to authenticated; -- S I U | sbGet + sbPost + sbPatch
grant select                        on public.conferencias_caixa   to authenticated; -- S     | sbGet (grava por RPC)
grant select, update                on public.config               to authenticated; -- S U   | sbGet + sbPatch
grant select                        on public.estoque              to authenticated; -- S I U | só sbGet(id=eq.1)
grant select                        on public.ledger_victor        to authenticated; -- S I U | só leitura, pela view
grant select, insert, update        on public.produtos             to authenticated; -- S I U | sbGet + sbPost + sbPatch
grant select, update                on public.reposicoes           to authenticated; -- S I U D | sbGet + sbPatch(lote); grava/estorna por RPC
grant select, insert, delete        on public.saidas               to authenticated; -- S I U D | sbGet + sbPost + sbDelete (UPDATE o trigger recusa)
grant select                        on public.usuarios_autorizados to authenticated; -- S     | sbGet
grant select, update                on public.vendas               to authenticated; -- S I U | sbGet + sbPatch; INSERT só por RPC
grant select                        on public.v_ledger_victor      to authenticated; -- view security_invoker

-- ---------------------------------------------------------------------------
-- 3) vsp_cc_protege() era a única função vsp_* com o grant padrão de função
--    (EXECUTE para PUBLIC, e portanto para anon). É trigger function e SECURITY
--    INVOKER — chamada direta só dá "can only be called as a trigger" —, mas
--    não há motivo para ela ser executável pela API.
-- ---------------------------------------------------------------------------
revoke all on function public.vsp_cc_protege() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) tabela nova não nasce aberta para anon. Sem isto, qualquer CREATE TABLE
--    feito por `postgres` no schema public volta a ganhar ALL para anon pelo
--    default privilege que o Supabase instala.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon;

-- ============================================================================
-- ROLLBACK (volta ao padrão amplo do Supabase; só se algo quebrar):
--   grant all on all tables in schema public to anon, authenticated;
--   grant execute on function public.vsp_cc_protege() to public;
--   alter default privileges for role postgres in schema public grant all on tables to anon;
-- ============================================================================
