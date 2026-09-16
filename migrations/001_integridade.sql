-- ============================================================
-- VS PERFORMANCE - 001_INTEGRIDADE
-- CHECKs de nao-negatividade, FKs ON DELETE RESTRICT, NOT NULL, defaults.
-- ============================================================
-- PRE-REQUISITO: rodar 000_preflight.sql e ler o resultado.
--
-- ESTE ARQUIVO NAO CORRIGE DADO. Nenhum UPDATE/DELETE em linha de
-- venda, cliente, saida, compra ou estoque. So schema.
--
-- COMO ELE TRATA DADO QUE JA VIOLA A REGRA:
--   Se uma constraint nao puder ser validada por causa do historico,
--   ela e criada como NOT VALID: passa a valer para toda GRAVACAO NOVA
--   e NAO reprova o passado. Assim uma linha velha torta nao impede as
--   outras 30 constraints de entrarem, e nada e "consertado" por conta
--   propria. Depois de o responsavel decidir o que fazer com o dado antigo:
--     alter table public.<tabela> validate constraint <nome>;
--
-- IDEMPOTENTE: pode rodar 2x, 10x. Nada duplica, nada quebra.
-- O ULTIMO comando do arquivo e um SELECT de conferencia: leia ele.
-- ============================================================


-- ============================================================
-- 0) AJUDANTES TEMPORARIOS
-- Criados aqui e REMOVIDOS no fim do arquivo (secao 9).
-- Existem para nao repetir 40 blocos "do $$ ... if not exists".
-- ============================================================

create or replace function public.vsp_mig_check(p_tab text, p_nome text, p_expr text)
returns void language plpgsql as $fn$
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = p_tab) then
    raise notice 'PULADO  % : tabela nao existe', p_nome;
    return;
  end if;

  if exists (select 1 from pg_constraint c
               join pg_class t on t.oid = c.conrelid
               join pg_namespace n on n.oid = t.relnamespace
              where n.nspname = 'public' and t.relname = p_tab and c.conname = p_nome) then
    raise notice 'JA EXISTE  %', p_nome;
    return;
  end if;

  begin
    execute format('alter table public.%I add constraint %I check (%s)', p_tab, p_nome, p_expr);
    raise notice 'CRIADA  %', p_nome;
  exception when check_violation then
    -- Existe dado antigo violando. NOT VALID protege o futuro sem tocar no passado.
    execute format('alter table public.%I add constraint %I check (%s) not valid',
                   p_tab, p_nome, p_expr);
    raise warning 'NOT VALID  % : ha dado antigo violando. Gravacao nova ja esta protegida. Depois de limpar rode: alter table public.% validate constraint %;',
                  p_nome, p_tab, p_nome;
  end;
end $fn$;

create or replace function public.vsp_mig_fk(p_tab text, p_nome text, p_col text,
                                            p_ref_tab text, p_ref_col text)
returns void language plpgsql as $fn$
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = p_tab)
     or not exists (select 1 from information_schema.tables
                     where table_schema = 'public' and table_name = p_ref_tab) then
    raise notice 'PULADO  % : tabela nao existe', p_nome;
    return;
  end if;

  if exists (select 1 from pg_constraint c
               join pg_class t on t.oid = c.conrelid
               join pg_namespace n on n.oid = t.relnamespace
              where n.nspname = 'public' and t.relname = p_tab and c.conname = p_nome) then
    raise notice 'JA EXISTE  %', p_nome;
    return;
  end if;

  begin
    -- ON DELETE RESTRICT, nunca CASCADE: apagar um produto ou um cliente NAO pode
    -- levar venda/compra embora. Dado financeiro so sai por decisao explicita.
    -- ON UPDATE CASCADE existe porque produtos.id e chave natural de texto
    -- (ex. 'TG'): se um dia renomearem o id, as vendas acompanham em vez de romper.
    execute format('alter table public.%I add constraint %I foreign key (%I) '
                   || 'references public.%I(%I) on delete restrict on update cascade',
                   p_tab, p_nome, p_col, p_ref_tab, p_ref_col);
    raise notice 'CRIADA  %', p_nome;
  exception when foreign_key_violation then
    execute format('alter table public.%I add constraint %I foreign key (%I) '
                   || 'references public.%I(%I) on delete restrict on update cascade not valid',
                   p_tab, p_nome, p_col, p_ref_tab, p_ref_col);
    raise warning 'NOT VALID  % : existe linha orfa (veja o preflight). Gravacao nova ja esta protegida.',
                  p_nome;
  end;
end $fn$;

create or replace function public.vsp_mig_not_null(p_tab text, p_col text)
returns void language plpgsql as $fn$
declare v_nulos bigint; v_ja boolean;
begin
  select (is_nullable = 'NO') into v_ja
    from information_schema.columns
   where table_schema = 'public' and table_name = p_tab and column_name = p_col;

  if v_ja is null then
    raise notice 'PULADO  %.% : coluna nao existe', p_tab, p_col;
    return;
  end if;
  if v_ja then
    raise notice 'JA E NOT NULL  %.%', p_tab, p_col;
    return;
  end if;

  execute format('select count(*) from public.%I where %I is null', p_tab, p_col) into v_nulos;
  if v_nulos > 0 then
    -- NOT NULL nao tem versao NOT VALID: ou entra, ou nao entra.
    -- Nao vamos preencher nada por conta propria, entao so avisamos.
    raise warning 'PULADO  %.% : % linha(s) com NULL. Decida o valor e rode: alter table public.% alter column % set not null;',
                  p_tab, p_col, v_nulos, p_tab, p_col;
    return;
  end if;

  execute format('alter table public.%I alter column %I set not null', p_tab, p_col);
  raise notice 'NOT NULL  %.%', p_tab, p_col;
end $fn$;

create or replace function public.vsp_mig_default(p_tab text, p_col text, p_expr text)
returns void language plpgsql as $fn$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = p_tab and column_name = p_col) then
    raise notice 'PULADO default %.% : coluna nao existe', p_tab, p_col;
    return;
  end if;
  -- Default so vale para INSERT novo; NAO reescreve linha existente.
  execute format('alter table public.%I alter column %I set default %s', p_tab, p_col, p_expr);
  raise notice 'DEFAULT  %.% = %', p_tab, p_col, p_expr;
end $fn$;


-- ============================================================
-- 1) PRODUTOS - estoque e custo nunca negativos
-- ============================================================
select public.vsp_mig_check('produtos','ck_produtos_caixas_nao_neg',       'caixas >= 0');
select public.vsp_mig_check('produtos','ck_produtos_frascos_nao_neg',      'frascos >= 0');
select public.vsp_mig_check('produtos','ck_produtos_custo_caixa_nao_neg',  'custo_caixa >= 0');
select public.vsp_mig_check('produtos','ck_produtos_custo_frasco_nao_neg', 'custo_frasco >= 0');
select public.vsp_mig_check('produtos','ck_produtos_preco_padrao_nao_neg', 'preco_padrao >= 0');
-- frascos_por_caixa e DIVISOR do custo medio ponderado (004). Zero ou nulo ali
-- estoura divisao por zero e zera o custo do produto inteiro.
select public.vsp_mig_check('produtos','ck_produtos_fpc_min1',             'frascos_por_caixa >= 1');
select public.vsp_mig_check('produtos','ck_produtos_alertas_nao_neg',
  'estoque_minimo >= 0 and estoque_critico >= 0');

select public.vsp_mig_default('produtos','caixas','0');
select public.vsp_mig_default('produtos','frascos','0');
select public.vsp_mig_default('produtos','custo_caixa','0');
select public.vsp_mig_default('produtos','custo_frasco','0');
select public.vsp_mig_default('produtos','preco_padrao','0');
select public.vsp_mig_default('produtos','frascos_por_caixa','1');
select public.vsp_mig_default('produtos','vende_frasco','false');
select public.vsp_mig_default('produtos','ativo','true');
select public.vsp_mig_default('produtos','estoque_minimo','4');
select public.vsp_mig_default('produtos','estoque_critico','2');
select public.vsp_mig_default('produtos','criado','now()');

select public.vsp_mig_not_null('produtos','nome');
select public.vsp_mig_not_null('produtos','caixas');
select public.vsp_mig_not_null('produtos','frascos');
select public.vsp_mig_not_null('produtos','custo_caixa');
select public.vsp_mig_not_null('produtos','custo_frasco');
select public.vsp_mig_not_null('produtos','frascos_por_caixa');
select public.vsp_mig_not_null('produtos','vende_frasco');
select public.vsp_mig_not_null('produtos','ativo');


-- ============================================================
-- 2) VENDAS - valores, dominios e vinculos
-- ============================================================
select public.vsp_mig_check('vendas','ck_vendas_qtd_pos',       'qtd > 0');
select public.vsp_mig_check('vendas','ck_vendas_valores_nao_neg',
  'val_orig >= 0 and desconto >= 0 and val_final >= 0 and bruto >= 0 '
  || 'and custo >= 0 and taxa_val >= 0 and liq >= 0');
-- lucro_liq e margem NAO entram: venda com prejuizo e negativo legitimo.
select public.vsp_mig_check('vendas','ck_vendas_taxa_0_100',    'taxa >= 0 and taxa <= 100');
select public.vsp_mig_check('vendas','ck_vendas_parcelas_pos',  'parcelas is null or parcelas >= 1');
select public.vsp_mig_check('vendas','ck_vendas_tipo',          'tipo in (''caixa'',''frasco'')');

-- Dominios de texto ficam COMENTADOS: sao os que mais engessam o app se
-- amanha aparecer uma forma de pagamento nova. Se o preflight (linhas 41-43)
-- deu 0 e o responsavel quiser travar, descomente.
-- select public.vsp_mig_check('vendas','ck_vendas_pgto',
--   'pgto in (''pix'',''credito'',''debito'',''dinheiro'',''parcelado'',''fiado'')');
-- select public.vsp_mig_check('vendas','ck_vendas_taxa_quem',
--   'taxa_quem in (''nos'',''cliente'')');
-- select public.vsp_mig_check('vendas','ck_vendas_pgto_quitado',
--   'pgto_quitado is null or pgto_quitado in (''pix'',''credito'',''debito'',''dinheiro'')');

-- Coerencia do fiado: se esta quitado, tem de haver a forma recebida.
-- Tambem comentado - o historico pode ter fiado quitado antes de existir
-- a coluna pgto_quitado.
-- select public.vsp_mig_check('vendas','ck_vendas_fiado_quitado',
--   'coalesce(quitado,false) = false or pgto <> ''fiado'' or pgto_quitado is not null');

select public.vsp_mig_default('vendas','desconto','0');
select public.vsp_mig_default('vendas','taxa','0');
select public.vsp_mig_default('vendas','taxa_val','0');
select public.vsp_mig_default('vendas','taxa_quem','''nos''');
select public.vsp_mig_default('vendas','quitado','false');
select public.vsp_mig_default('vendas','cancelada','false');
select public.vsp_mig_default('vendas','prod','''TG''');

select public.vsp_mig_not_null('vendas','prod');
select public.vsp_mig_not_null('vendas','tipo');
select public.vsp_mig_not_null('vendas','qtd');
select public.vsp_mig_not_null('vendas','data');
select public.vsp_mig_not_null('vendas','pgto');
select public.vsp_mig_not_null('vendas','bruto');
select public.vsp_mig_not_null('vendas','custo');
select public.vsp_mig_not_null('vendas','val_final');
select public.vsp_mig_not_null('vendas','cliente');
select public.vsp_mig_not_null('vendas','quitado');
select public.vsp_mig_not_null('vendas','cancelada');
-- cli_id fica NULLABLE de proposito: existe venda sem cliente cadastrado.
-- lote, obs, usuario, vence_em, parcelas tambem ficam nullable (opcionais no app).


-- ============================================================
-- 3) CLIENTES
-- ============================================================
select public.vsp_mig_not_null('clientes','nome');
-- Sem UNIQUE em tel: o preflight (81) mostra duplicata de telefone, mas
-- cliente novo pode entrar sem telefone valido e travar a venda no balcao.


-- ============================================================
-- 4) SAIDAS (financeiro)
-- ============================================================
select public.vsp_mig_check('saidas','ck_saidas_val_nao_neg','val >= 0');
-- select public.vsp_mig_check('saidas','ck_saidas_tipo',
--   'tipo in (''prolabore'',''retirada'',''fornecedor'',''despesa'',''imposto'',''outros'')');
-- select public.vsp_mig_check('saidas','ck_saidas_pgto',
--   'pgto is null or pgto in (''pix'',''transferencia'',''dinheiro'',''debito'')');

select public.vsp_mig_not_null('saidas','tipo');
select public.vsp_mig_not_null('saidas','descricao');
select public.vsp_mig_not_null('saidas','data');
select public.vsp_mig_not_null('saidas','val');
-- socio fica nullable: em tipo='fornecedor' o app grava o nome do fornecedor ali,
-- e em alguns lancamentos antigos pode estar vazio.


-- ============================================================
-- 5) REPOSICOES (compras)
-- ============================================================
select public.vsp_mig_check('reposicoes','ck_reposicoes_qtd_pos','qtd > 0');
select public.vsp_mig_check('reposicoes','ck_reposicoes_valores_nao_neg',
  'cust_unit >= 0 and cust_total >= 0 and coalesce(frete,0) >= 0');
select public.vsp_mig_check('reposicoes','ck_reposicoes_tipo','tipo in (''caixa'',''frasco'')');
-- Sem check de cust_total = qtd*cust_unit + frete: o preflight (77) mostra as
-- divergencias, mas arredondamento de nota fiscal quebraria a igualdade exata.

select public.vsp_mig_default('reposicoes','frete','0');
select public.vsp_mig_default('reposicoes','prod','''TG''');

select public.vsp_mig_not_null('reposicoes','prod');
select public.vsp_mig_not_null('reposicoes','tipo');
select public.vsp_mig_not_null('reposicoes','qtd');
select public.vsp_mig_not_null('reposicoes','cust_unit');
select public.vsp_mig_not_null('reposicoes','cust_total');
-- data e NOT NULL porque o estorno (004) compara "houve venda deste produto
-- a partir da data da compra". Data nula ali torna a guarda inutil.
select public.vsp_mig_not_null('reposicoes','data');
select public.vsp_mig_not_null('reposicoes','frete');


-- ============================================================
-- 6) AUDIT_LOG e CONFIG
-- ============================================================
select public.vsp_mig_default('audit_log','ts','now()');
select public.vsp_mig_not_null('audit_log','ts');
select public.vsp_mig_not_null('audit_log','acao');

-- Garante a linha unica de config sem sobrescrever nada.
insert into config (id) values (1) on conflict (id) do nothing;

select public.vsp_mig_check('config','ck_config_metas_nao_neg',
  'coalesce(meta_lucro_mes,0) >= 0 and coalesce(meta_bruto_mes,0) >= 0 '
  || 'and coalesce(meta_lucro_sem,0) >= 0 and coalesce(meta_bruto_sem,0) >= 0');
select public.vsp_mig_check('config','ck_config_split_0_100',
  'coalesce(split_victor,0) between 0 and 100 and coalesce(split_stefany,0) between 0 and 100');
select public.vsp_mig_check('config','ck_config_previsao_nao_neg',
  'coalesce(lead_time,0) >= 0 and coalesce(cobertura_alvo,0) >= 0 '
  || 'and coalesce(janela_media,1) >= 1 and coalesce(aviso_validade,0) >= 0');
-- Sem check "split_victor + split_stefany = 100": o app deixa configurar
-- divisao que nao fecha 100 de proposito (socio com percentual sobre parte).


-- ============================================================
-- 7) FOREIGN KEYS - ON DELETE RESTRICT
-- ============================================================
-- vendas.prod e reposicoes.prod -> produtos.id
-- Impede vender/comprar produto inexistente e impede apagar produto que
-- tem historico (era assim que 'prod' ficava orfao e o estorno travava).
select public.vsp_mig_fk('vendas',    'fk_vendas_prod',     'prod', 'produtos','id');
select public.vsp_mig_fk('reposicoes','fk_reposicoes_prod', 'prod', 'produtos','id');

-- vendas.cli_id -> clientes.id
-- ATENCAO (DECISAO 3 do README): com RESTRICT, delCli() do app passa a FALHAR
-- para qualquer cliente que tenha venda. Isso e proposital - apagar o cadastro
-- de quem tem fiado em aberto e justamente o furo que existe hoje.
-- Se o responsavel preferir manter o botao "remover cliente" funcionando,
-- troque por SET NULL (perde o vinculo, mantem cliente/wpp gravados na venda):
--   alter table public.vendas drop constraint if exists fk_vendas_cli_id;
--   alter table public.vendas add constraint fk_vendas_cli_id
--     foreign key (cli_id) references public.clientes(id)
--     on delete set null on update cascade;
select public.vsp_mig_fk('vendas','fk_vendas_cli_id','cli_id','clientes','id');


-- ============================================================
-- 7b) OPCIONAL - soft delete de cliente (nao aplicado)
-- Se quiser a saida elegante para a DECISAO 3: em vez de apagar, inativar.
-- A coluna e aditiva e o app de hoje simplesmente ignora ela.
-- ============================================================
-- alter table public.clientes add column if not exists ativo boolean default true;
-- comment on column public.clientes.ativo is
--   'false = cliente arquivado. Preserva o historico de vendas (FK RESTRICT).';


-- ============================================================
-- 8) INDICES que as novas regras e as RPCs precisam
-- ============================================================
-- FK sem indice no lado filho faz o RESTRICT varrer a tabela em cada delete.
create index if not exists idx_vendas_cli_id on vendas(cli_id);
-- vsp_estornar_compra pergunta "houve venda deste produto a partir da data X".
create index if not exists idx_vendas_prod_data on vendas(prod, data);
-- Tela de Fiado: so o que esta em aberto.
create index if not exists idx_vendas_fiado_aberto on vendas(vence_em)
  where pgto = 'fiado' and coalesce(quitado,false) = false and coalesce(cancelada,false) = false;


-- ============================================================
-- 9) REMOVE OS AJUDANTES
-- Eles existem so durante a migration; nao ficam no banco para ninguem
-- chamar por acidente.
-- ============================================================
drop function if exists public.vsp_mig_check(text,text,text);
drop function if exists public.vsp_mig_fk(text,text,text,text,text);
drop function if exists public.vsp_mig_not_null(text,text);
drop function if exists public.vsp_mig_default(text,text,text);


-- ============================================================
-- 10) CONFERENCIA - LEIA ESTE RESULTADO
-- estado: OK          = criada e validada
--         NOT VALID   = vale para gravacao nova, dado antigo nao conferido
--         FALTANDO    = nao entrou (veja os avisos/NOTICE do editor)
--         (comentada) = intencionalmente nao aplicada neste arquivo
-- ============================================================
select p.tabela, p.constraint_nome,
       case when c.conname is null then 'FALTANDO'
            when c.convalidated then 'OK'
            else 'NOT VALID' end as estado,
       p.observacao
  from (values
    ('produtos','ck_produtos_caixas_nao_neg','estoque nao negativo'),
    ('produtos','ck_produtos_frascos_nao_neg','estoque nao negativo'),
    ('produtos','ck_produtos_custo_caixa_nao_neg','custo nao negativo'),
    ('produtos','ck_produtos_custo_frasco_nao_neg','custo nao negativo'),
    ('produtos','ck_produtos_preco_padrao_nao_neg','preco nao negativo'),
    ('produtos','ck_produtos_fpc_min1','divisor do custo medio'),
    ('produtos','ck_produtos_alertas_nao_neg','estoque minimo/critico'),
    ('vendas','ck_vendas_qtd_pos','quantidade positiva'),
    ('vendas','ck_vendas_valores_nao_neg','valores nao negativos'),
    ('vendas','ck_vendas_taxa_0_100','taxa em percentual'),
    ('vendas','ck_vendas_parcelas_pos','parcelas >= 1 ou nulo'),
    ('vendas','ck_vendas_tipo','caixa ou frasco'),
    ('vendas','fk_vendas_prod','FK produto - RESTRICT'),
    ('vendas','fk_vendas_cli_id','FK cliente - RESTRICT (ver DECISAO 3)'),
    ('saidas','ck_saidas_val_nao_neg','valor nao negativo'),
    ('reposicoes','ck_reposicoes_qtd_pos','quantidade positiva'),
    ('reposicoes','ck_reposicoes_valores_nao_neg','custos e frete nao negativos'),
    ('reposicoes','ck_reposicoes_tipo','caixa ou frasco'),
    ('reposicoes','fk_reposicoes_prod','FK produto - RESTRICT'),
    ('config','ck_config_metas_nao_neg','metas nao negativas'),
    ('config','ck_config_split_0_100','divisao 0..100'),
    ('config','ck_config_previsao_nao_neg','parametros de previsao')
  ) as p(tabela, constraint_nome, observacao)
  left join pg_constraint c
    on c.conname = p.constraint_nome
   and c.conrelid = ('public.' || p.tabela)::regclass
 order by
   case when c.conname is null then 0 when c.convalidated then 2 else 1 end,
   p.tabela, p.constraint_nome;


-- ============================================================
-- ROLLBACK DO 001 (cole no SQL Editor se precisar voltar atras)
-- ============================================================
-- alter table public.produtos   drop constraint if exists ck_produtos_caixas_nao_neg;
-- alter table public.produtos   drop constraint if exists ck_produtos_frascos_nao_neg;
-- alter table public.produtos   drop constraint if exists ck_produtos_custo_caixa_nao_neg;
-- alter table public.produtos   drop constraint if exists ck_produtos_custo_frasco_nao_neg;
-- alter table public.produtos   drop constraint if exists ck_produtos_preco_padrao_nao_neg;
-- alter table public.produtos   drop constraint if exists ck_produtos_fpc_min1;
-- alter table public.produtos   drop constraint if exists ck_produtos_alertas_nao_neg;
-- alter table public.vendas     drop constraint if exists ck_vendas_qtd_pos;
-- alter table public.vendas     drop constraint if exists ck_vendas_valores_nao_neg;
-- alter table public.vendas     drop constraint if exists ck_vendas_taxa_0_100;
-- alter table public.vendas     drop constraint if exists ck_vendas_parcelas_pos;
-- alter table public.vendas     drop constraint if exists ck_vendas_tipo;
-- alter table public.vendas     drop constraint if exists fk_vendas_prod;
-- alter table public.vendas     drop constraint if exists fk_vendas_cli_id;
-- alter table public.saidas     drop constraint if exists ck_saidas_val_nao_neg;
-- alter table public.reposicoes drop constraint if exists ck_reposicoes_qtd_pos;
-- alter table public.reposicoes drop constraint if exists ck_reposicoes_valores_nao_neg;
-- alter table public.reposicoes drop constraint if exists ck_reposicoes_tipo;
-- alter table public.reposicoes drop constraint if exists fk_reposicoes_prod;
-- alter table public.config     drop constraint if exists ck_config_metas_nao_neg;
-- alter table public.config     drop constraint if exists ck_config_split_0_100;
-- alter table public.config     drop constraint if exists ck_config_previsao_nao_neg;
--
-- -- NOT NULL (so o que voce quiser soltar de novo):
-- alter table public.vendas     alter column prod      drop not null;
-- alter table public.vendas     alter column data      drop not null;
-- alter table public.reposicoes alter column data      drop not null;
-- ...mesmo padrao para as outras colunas da secao 1 a 6.
--
-- -- Indices:
-- drop index if exists public.idx_vendas_prod_data;
-- drop index if exists public.idx_vendas_fiado_aberto;
