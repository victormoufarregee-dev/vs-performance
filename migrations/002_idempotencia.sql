-- ============================================================
-- VS PERFORMANCE - 002_IDEMPOTENCIA (op_id)
-- ============================================================
-- PROBLEMA QUE ISSO RESOLVE
-- O app usa PWA e fila offline (enviarFila). Se o celular perde sinal
-- no meio do POST, o registro pode entrar no banco e o app achar que
-- falhou - e reenviar. Resultado: venda dobrada, compra dobrada (e,
-- pior, estoque baixado duas vezes). O preflight (linha 55) conta as
-- duplicidades suspeitas que ja existem.
--
-- COMO RESOLVE
-- Cada operacao passa a carregar um identificador criado no CELULAR
-- (nao no banco). Se o mesmo op_id chegar duas vezes, a segunda nao
-- entra: o unique index barra, e as RPCs do 004 devolvem a linha que
-- ja existe em vez de estourar erro.
--
-- Sugestao de formato para o app gerar (nao e obrigatorio):
--   'venda-' + crypto.randomUUID()
-- ou, sem randomUUID: 'venda-' + Date.now() + '-' + currentUser.
--
-- POR QUE NULLABLE
-- As 65 vendas / 21 clientes / 23 saidas / 5 compras que ja existem nao
-- tem op_id e nunca vao ter. Coluna nullable + indice unico PARCIAL
-- (where op_id is not null) deixa o passado em paz e trava so o futuro.
-- Um UNIQUE de tabela tambem aceitaria varios NULL em Postgres, mas o
-- indice parcial e explicito e nao indexa as linhas antigas.
--
-- IDEMPOTENTE: pode rodar 2x.
-- ============================================================

-- ---------- 1) COLUNAS ----------
alter table vendas     add column if not exists op_id text;
alter table saidas     add column if not exists op_id text;
alter table reposicoes add column if not exists op_id text;
alter table clientes   add column if not exists op_id text;

comment on column vendas.op_id     is 'Chave de idempotencia gerada no app. NULL = registro anterior ao 002.';
comment on column saidas.op_id     is 'Chave de idempotencia gerada no app. NULL = registro anterior ao 002.';
comment on column reposicoes.op_id is 'Chave de idempotencia gerada no app. NULL = registro anterior ao 002.';
comment on column clientes.op_id   is 'Chave de idempotencia gerada no app. NULL = registro anterior ao 002.';


-- ---------- 2) INDICE UNICO PARCIAL ----------
-- Parcial de proposito: nao indexa (nem trava) as linhas antigas com NULL.
create unique index if not exists uq_vendas_op_id
  on vendas(op_id) where op_id is not null;
create unique index if not exists uq_saidas_op_id
  on saidas(op_id) where op_id is not null;
create unique index if not exists uq_reposicoes_op_id
  on reposicoes(op_id) where op_id is not null;
create unique index if not exists uq_clientes_op_id
  on clientes(op_id) where op_id is not null;


-- ---------- 3) op_id vazio nao vale ----------
-- Sem isso, um bug no app mandando op_id:'' faria a PRIMEIRA operacao
-- reservar a string vazia e todas as seguintes serem tratadas como
-- repeticao dela - perda silenciosa de venda. Pior falha possivel aqui.
do $$
declare
  t text;
  nome text;
begin
  foreach t in array array['vendas','saidas','reposicoes','clientes']
  loop
    nome := 'ck_' || t || '_op_id_nao_vazio';
    if not exists (select 1 from pg_constraint c
                     join pg_class cl on cl.oid = c.conrelid
                     join pg_namespace n on n.oid = cl.relnamespace
                    where n.nspname = 'public' and cl.relname = t and c.conname = nome) then
      execute format(
        'alter table public.%I add constraint %I check (op_id is null or length(btrim(op_id)) > 0)',
        t, nome);
      raise notice 'CRIADA  %', nome;
    else
      raise notice 'JA EXISTE  %', nome;
    end if;
  end loop;
end $$;


-- ---------- 4) CONFERENCIA - LEIA ESTE RESULTADO ----------
-- Esperado: 4 linhas, todas com coluna_op_id = true e indice_unico = true.
select t.tabela,
       exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = t.tabela
                  and c.column_name = 'op_id')                        as coluna_op_id,
       exists (select 1 from pg_indexes i
                where i.schemaname = 'public' and i.tablename = t.tabela
                  and i.indexname = 'uq_' || t.tabela || '_op_id')    as indice_unico,
       exists (select 1 from pg_constraint c
                where c.conrelid = ('public.' || t.tabela)::regclass
                  and c.conname = 'ck_' || t.tabela || '_op_id_nao_vazio') as check_nao_vazio,
       (select count(*) from information_schema.columns c2
         where c2.table_schema = 'public' and c2.table_name = t.tabela)    as colunas_na_tabela
  from (values ('vendas'),('saidas'),('reposicoes'),('clientes')) as t(tabela)
 order by t.tabela;


-- ============================================================
-- ROLLBACK DO 002
-- Derrubar o indice e inofensivo. Derrubar a COLUNA apaga os op_id
-- ja gravados, e o app perde a protecao contra reenvio - mas nao perde
-- venda nenhuma.
-- ============================================================
-- drop index if exists public.uq_vendas_op_id;
-- drop index if exists public.uq_saidas_op_id;
-- drop index if exists public.uq_reposicoes_op_id;
-- drop index if exists public.uq_clientes_op_id;
-- alter table public.vendas     drop constraint if exists ck_vendas_op_id_nao_vazio;
-- alter table public.saidas     drop constraint if exists ck_saidas_op_id_nao_vazio;
-- alter table public.reposicoes drop constraint if exists ck_reposicoes_op_id_nao_vazio;
-- alter table public.clientes   drop constraint if exists ck_clientes_op_id_nao_vazio;
-- -- ATENCAO: o 004 usa vendas.op_id e reposicoes.op_id. Se apagar as colunas,
-- -- derrube as RPCs primeiro (ver rollback do 004).
-- alter table public.vendas     drop column if exists op_id;
-- alter table public.saidas     drop column if exists op_id;
-- alter table public.reposicoes drop column if exists op_id;
-- alter table public.clientes   drop column if exists op_id;
