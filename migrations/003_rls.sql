-- ============================================================
-- VS PERFORMANCE - 003_RLS (troca a policy permissiva)
-- ============================================================
-- HOJE o banco tem, em cada tabela:
--   create policy vsp_auth_<tabela> ... for all to authenticated
--     using (true) with check (true);
-- Ou seja: QUALQUER conta autenticada no projeto Supabase pode ler,
-- gravar, alterar e APAGAR tudo - inclusive vendas e a propria trilha
-- de auditoria. Como o app faz login de verdade (auth/v1/token
-- grant_type=password, ver index.html linha 1195), quem criar uma conta
-- no projeto entra com o mesmo poder que o Victor e a Stefany.
--
-- DEPOIS deste arquivo:
--   - somente uid na allowlist (usuarios_autorizados, ativo = true) acessa;
--   - cada tabela recebe policy POR COMANDO, nao "for all";
--   - vendas   -> sem DELETE. Venda errada se CANCELA (ja existe no app).
--   - audit_log -> so INSERT e SELECT. Nao da UPDATE nem DELETE em auditoria,
--                  senao ela nao prova nada.
--   - DELETE so em: saidas, reposicoes, backups, clientes (o que o app
--     realmente chama: sbDelete no index.html linhas 1574, 1747, 2165, 2175, 2478).
--
-- ATENCAO: ESTE ARQUIVO RODA EM DUAS PASSADAS.
--   1a passada: cria a tabela de allowlist e PARA com erro, porque ela
--               esta vazia (aplicar as policies com allowlist vazia =
--               trancar voce mesmo fora do banco).
--   2a passada: depois de inserir os 2 uid (secao 2), rode o arquivo
--               inteiro de novo e ele aplica as policies.
--
-- IDEMPOTENTE: pode rodar quantas vezes quiser depois disso.
-- ============================================================


-- ============================================================
-- ROLLBACK RAPIDO - COLE ISSO SE O ACESSO TRAVAR
-- (volta ao estado permissivo de hoje; nao perde dado nenhum)
-- ============================================================
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['produtos','vendas','clientes','saidas','reposicoes',
--                            'estoque','audit_log','config','backups']
--   loop
--     if exists (select 1 from information_schema.tables
--                 where table_schema='public' and table_name=t) then
--       -- derruba as policies granulares do 003
--       execute format('drop policy if exists %I on public.%I','vsp_sel_'||t,t);
--       execute format('drop policy if exists %I on public.%I','vsp_ins_'||t,t);
--       execute format('drop policy if exists %I on public.%I','vsp_upd_'||t,t);
--       execute format('drop policy if exists %I on public.%I','vsp_del_'||t,t);
--       -- devolve os GRANTs que a secao 5 tirou
--       execute format('grant select, insert, update, delete on public.%I to authenticated',t);
--       -- recria a policy permissiva antiga
--       if not exists (select 1 from pg_policies
--                       where schemaname='public' and tablename=t
--                         and policyname='vsp_auth_'||t) then
--         execute format('create policy %I on public.%I for all to authenticated '
--                        || 'using (true) with check (true)','vsp_auth_'||t,t);
--       end if;
--     end if;
--   end loop;
-- end $$;
--
-- EMERGENCIA TOTAL (ultimo recurso, deixa a tabela aberta):
--   alter table public.produtos disable row level security;
--   alter table public.vendas   disable row level security;
--   ... e assim por diante. Religue com "enable row level security"
--   assim que resolver.


-- ============================================================
-- PARTE A - SECAO 1: ALLOWLIST
-- ============================================================
create table if not exists usuarios_autorizados (
  uid   uuid primary key,          -- e o mesmo id de auth.users
  nome  text,                      -- 'Victor' / 'Stefany' (so para leitura humana)
  ativo boolean default true,      -- desligar acesso sem apagar historico
  criado timestamptz default now()
);

comment on table usuarios_autorizados is
  'Quem pode usar o app. Popule a partir de auth.users - ver secao 2 do 003_rls.sql.';

-- Funcao usada por TODAS as policies.
-- security definer: precisa ler usuarios_autorizados mesmo com RLS ligada nela.
-- stable: o Postgres chama uma vez por comando em vez de uma vez por linha.
-- search_path fixo: ninguem consegue apontar "usuarios_autorizados" para
-- outro schema e forjar autorizacao.
-- Corpo ALINHADO AO BANCO em 17/09/2026 (conferido por md5). Mesma regra do texto
-- anterior: "and ativo" com ativo nulo nao e verdadeiro, igual ao coalesce(ativo,false).
create or replace function public.vsp_autorizado()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from public.usuarios_autorizados where uid = auth.uid() and ativo);
$fn$;

revoke all on function public.vsp_autorizado() from public;
grant execute on function public.vsp_autorizado() to authenticated;

-- A propria allowlist tambem fica protegida: da para LER (o app pode querer
-- mostrar quem tem acesso), mas nao da para escrever pela API. Incluir ou
-- remover usuario e ato administrativo, feito no SQL Editor.
alter table usuarios_autorizados enable row level security;
drop policy if exists vsp_sel_usuarios_autorizados on usuarios_autorizados;
create policy vsp_sel_usuarios_autorizados on usuarios_autorizados
  for select to authenticated using (public.vsp_autorizado());
revoke insert, update, delete on usuarios_autorizados from authenticated, anon;
-- NOTA 17/09/2026: em producao este revoke NAO esta em vigor — anon e authenticated tem
-- os grants padrao do Supabase na tabela. A protecao efetiva e a RLS: so existe policy de
-- SELECT, entao nenhum INSERT/UPDATE/DELETE passa pela API (provado pela API publica).
-- Registrado como drift aberto em migrations/APLICADO.md; nao alterado nesta rodada.


-- ============================================================
-- PARTE A - SECAO 2: POPULAR A ALLOWLIST (FACA ISSO A MAO)
-- ============================================================
-- NAO existe UUID inventado neste arquivo, e nao deve existir. Pegue os
-- de verdade no seu projeto:
--
-- PASSO 1 - descubra os uid (rode so esta linha e copie o resultado):
--
--   select id, email, created_at, last_sign_in_at
--     from auth.users
--    order by created_at;
--
--   Os dois e-mails do sistema estao em index.html linha 657 (const NAMES):
--   um e o do Victor, o outro o da Stefany. Filtrando:
--
--   select id, email from auth.users
--    where email in ('victor.moufarregee@gmail.com','xsthexsouza@gmail.com')
--    order by email;
--
--   Se aparecer MAIS de duas contas, decida o que fazer com as outras
--   ANTES de seguir (ver DECISAO 5 no README) - elas vao perder o acesso.
--
-- PASSO 2 - cole o uid no lugar do texto entre < >, sem as chaves,
--           e rode (o on conflict deixa repetir sem erro):
--
--   insert into public.usuarios_autorizados (uid, nome) values
--     ('<COLE-AQUI-O-UUID-DO-VICTOR>',  'Victor'),
--     ('<COLE-AQUI-O-UUID-DA-STEFANY>', 'Stefany')
--   on conflict (uid) do update set ativo = true, nome = excluded.nome;
--
-- PASSO 3 - confira. Tem de voltar 2 linhas com ativo = true:
--
--   select u.uid, u.nome, u.ativo, a.email
--     from public.usuarios_autorizados u
--     left join auth.users a on a.id = u.uid
--    order by u.nome;
--
-- PARA TIRAR O ACESSO DE ALGUEM (sem apagar nada):
--   update public.usuarios_autorizados set ativo = false where nome = 'Stefany';


-- ============================================================
-- PARTE A - SECAO 3: TRAVA DE SEGURANCA
-- Se a allowlist estiver vazia, para aqui. Aplicar as policies agora
-- deixaria o banco inacessivel pelo app (e pelos dois donos).
-- ============================================================
do $$
declare v_n integer;
begin
  select count(*) into v_n from public.usuarios_autorizados where coalesce(ativo,false);
  if v_n = 0 then
    raise exception
      'PARE AQUI: usuarios_autorizados esta vazia. Faca a SECAO 2 deste arquivo '
      '(pegar os uid em auth.users e inserir) e rode o 003 de novo. '
      'Nada foi alterado nas policies.';
  end if;
  raise notice 'Allowlist com % usuario(s) ativo(s). Seguindo para as policies.', v_n;
end $$;


-- ============================================================
-- PARTE B - SECAO 4: POLICIES POR TABELA E POR COMANDO
-- ============================================================
-- Ajudante temporario (removido na secao 6). Le uma string de comandos:
--   S = select, I = insert, U = update, D = delete
-- e cria uma policy separada para cada um. Separar por comando e o ponto
-- central: "for all" foi exatamente o que deu DELETE em vendas para todo mundo.
create or replace function public.vsp_mig_policy(p_tab text, p_cmds text)
returns void language plpgsql as $fn$
declare
  i integer;
  c text;
  nome text;
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = p_tab) then
    raise notice 'PULADO % : tabela nao existe', p_tab;
    return;
  end if;

  execute format('alter table public.%I enable row level security', p_tab);

  -- A policy permissiva antiga sai. Enquanto ela existir, qualquer regra
  -- nova e inutil: policies do mesmo tipo se SOMAM (OR), nao se cortam.
  execute format('drop policy if exists %I on public.%I', 'vsp_auth_' || p_tab, p_tab);

  -- Apaga as quatro possiveis do 003 antes de recriar: assim rodar 2x nao
  -- duplica e a definicao fica sempre igual a deste arquivo.
  execute format('drop policy if exists %I on public.%I', 'vsp_sel_' || p_tab, p_tab);
  execute format('drop policy if exists %I on public.%I', 'vsp_ins_' || p_tab, p_tab);
  execute format('drop policy if exists %I on public.%I', 'vsp_upd_' || p_tab, p_tab);
  execute format('drop policy if exists %I on public.%I', 'vsp_del_' || p_tab, p_tab);

  for i in 1 .. length(p_cmds) loop
    c := upper(substr(p_cmds, i, 1));
    if c = 'S' then
      nome := 'vsp_sel_' || p_tab;
      execute format('create policy %I on public.%I for select to authenticated '
                     || 'using (public.vsp_autorizado())', nome, p_tab);
    elsif c = 'I' then
      nome := 'vsp_ins_' || p_tab;
      execute format('create policy %I on public.%I for insert to authenticated '
                     || 'with check (public.vsp_autorizado())', nome, p_tab);
    elsif c = 'U' then
      nome := 'vsp_upd_' || p_tab;
      -- using = pode enxergar a linha para alterar; with check = como ela pode
      -- ficar depois. Os dois sao necessarios, senao o UPDATE passa pela metade.
      execute format('create policy %I on public.%I for update to authenticated '
                     || 'using (public.vsp_autorizado()) with check (public.vsp_autorizado())',
                     nome, p_tab);
    elsif c = 'D' then
      nome := 'vsp_del_' || p_tab;
      execute format('create policy %I on public.%I for delete to authenticated '
                     || 'using (public.vsp_autorizado())', nome, p_tab);
    else
      raise exception 'comando desconhecido % para %', c, p_tab;
    end if;
    raise notice 'POLICY  %', nome;
  end loop;
end $fn$;

-- PRODUTOS: le, cadastra, edita. Nunca apaga - produto com historico de
-- venda nao pode sair do banco (e a FK do 001 tambem barraria).
select public.vsp_mig_policy('produtos', 'SIU');

-- VENDAS: le, lanca, atualiza (cancelar e quitar sao UPDATE).
-- SEM DELETE, de proposito. Venda nao se apaga: se cancela.
select public.vsp_mig_policy('vendas', 'SIU');

-- CLIENTES: o app tem botao de remover (delCli). Mantido.
-- Lembre que a FK do 001 (RESTRICT) impede remover quem tem venda.
select public.vsp_mig_policy('clientes', 'SIUD');

-- SAIDAS: o app remove lancamento errado (delSaida) e o estorno de compra
-- apaga a saida que ela gerou.
select public.vsp_mig_policy('saidas', 'SIUD');

-- REPOSICOES: estornarCompra apaga a linha da compra.
select public.vsp_mig_policy('reposicoes', 'SIUD');

-- AUDIT_LOG: so escreve e le. Auditoria que pode ser editada ou apagada
-- nao serve de prova de nada - e o unico lugar onde isso e absoluto.
select public.vsp_mig_policy('audit_log', 'SI');

-- CONFIG: linha unica id=1. O app le (sbGet) e altera (sbPatch); nunca
-- insere. Sem INSERT ninguem cria config paralela por acidente.
select public.vsp_mig_policy('config', 'SU');

-- BACKUPS: grava copia, lista e apaga as antigas (mantem as 12 ultimas).
-- Sem UPDATE: copia de seguranca nao se edita.
select public.vsp_mig_policy('backups', 'SID');

-- ESTOQUE: tabela legada (v2). O app so le ela uma vez, no seedProdutos
-- (index.html linha 1169), para herdar o estoque antigo. So SELECT.
select public.vsp_mig_policy('estoque', 'S');


-- ============================================================
-- PARTE B - SECAO 5: GRANTS (cinto e suspensorio)
-- ============================================================
-- RLS sem policy ja nega o comando. Mas o Supabase concede, por padrao,
-- select/insert/update/delete de tabela publica para authenticated e anon.
-- Tirar o privilegio no nivel do GRANT garante que um "drop policy" acidental
-- amanha nao reabra DELETE em vendas ou em auditoria.
revoke delete on public.vendas    from authenticated, anon;
revoke delete on public.produtos  from authenticated, anon;
revoke delete on public.config    from authenticated, anon;
revoke update, delete on public.audit_log from authenticated, anon;
revoke update on public.backups   from authenticated, anon;
revoke insert on public.config    from authenticated, anon;

-- OPCIONAL (mais restritivo, avalie antes): cortar a role anon de tudo.
-- Hoje o app usa a chave anon apenas para o login e troca o header pelo
-- token do usuario (index.html linhas 657 e 1199), entao isso nao deve
-- quebrar nada. Fica comentado porque muda a MENSAGEM de erro que o
-- "Testar seguranca do banco" e o "Diagnostico da nuvem" mostram
-- (deixa de ser erro de RLS e passa a ser erro de permissao).
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['produtos','vendas','clientes','saidas','reposicoes',
--                            'estoque','audit_log','config','backups','usuarios_autorizados']
--   loop
--     if exists (select 1 from information_schema.tables
--                 where table_schema='public' and table_name=t) then
--       execute format('revoke all on public.%I from anon', t);
--     end if;
--   end loop;
-- end $$;


-- ============================================================
-- SECAO 6: REMOVE O AJUDANTE
-- ============================================================
drop function if exists public.vsp_mig_policy(text,text);


-- ============================================================
-- SECAO 7: CONFERENCIA - LEIA ESTE RESULTADO
-- ============================================================
-- Esperado, por tabela:
--   produtos   SELECT INSERT UPDATE
--   vendas     SELECT INSERT UPDATE
--   clientes   SELECT INSERT UPDATE DELETE
--   saidas     SELECT INSERT UPDATE DELETE
--   reposicoes SELECT INSERT UPDATE DELETE
--   audit_log  SELECT INSERT
--   config     SELECT UPDATE
--   backups    SELECT INSERT DELETE
--   estoque    SELECT
-- rls_ligada = true em todas, e permissiva_antiga = 0 em todas.
select t.tablename as tabela,
       t.rowsecurity as rls_ligada,
       coalesce(string_agg(p.cmd, ' ' order by
         case p.cmd when 'SELECT' then 1 when 'INSERT' then 2
                    when 'UPDATE' then 3 when 'DELETE' then 4 else 5 end),
         '(NENHUMA - tabela fechada)') as comandos_liberados,
       count(*) filter (where p.policyname like 'vsp_auth_%') as permissiva_antiga
  from pg_tables t
  left join pg_policies p
    on p.schemaname = t.schemaname and p.tablename = t.tablename
 where t.schemaname = 'public'
   and t.tablename in ('produtos','vendas','clientes','saidas','reposicoes',
                       'estoque','audit_log','config','backups','usuarios_autorizados')
 group by t.tablename, t.rowsecurity
 order by t.tablename;
