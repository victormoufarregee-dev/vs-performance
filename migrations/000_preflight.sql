-- ============================================================
-- VS PERFORMANCE - 000_PREFLIGHT (diagnostico)
-- ============================================================
-- SOMENTE LEITURA. Nao cria, nao altera e nao apaga nada.
-- Rode ANTES de 001 / 002 / 003 / 004.
--
-- COMO RODAR NO SUPABASE:
--   SQL Editor > New query > colar TODO este arquivo > Run.
--   O editor mostra o resultado do ULTIMO comando; por isso o
--   diagnostico inteiro e UM unico SELECT (uma linha por checagem).
--
-- COMO LER:
--   "registros" = quantas linhas ja existentes estao no estado descrito.
--   "efeito"    = o que acontece quando o 001 for aplicado:
--      BLOQUEIA -> a constraint nao valida. O 001 cria ela como NOT VALID
--                  (protege gravacao nova, nao reprova o passado) e avisa.
--                  O dado antigo continua errado ate alguem decidir.
--      ATENCAO  -> nao bloqueia, mas muda comportamento do app.
--      INFO     -> so conferencia / contagem.
--   Todas as linhas BLOQUEIA com registros = 0  =>  001 entra limpo.
--
-- Referencia informada pelo responsavel (bate com os grupos 90-94):
--   65 vendas, 21 clientes, 23 saidas, 5 reposicoes, 2 produtos.
-- ============================================================

select * from (
values

-- ---------- PRODUTOS / ESTOQUE ----------
( 1,'BLOQUEIA','produtos.caixas negativo',
  (select count(*) from produtos where caixas < 0)::bigint,
  'ck_produtos_caixas_nao_neg'),
( 2,'BLOQUEIA','produtos.frascos negativo',
  (select count(*) from produtos where frascos < 0)::bigint,
  'ck_produtos_frascos_nao_neg'),
( 3,'BLOQUEIA','produtos.custo_caixa negativo',
  (select count(*) from produtos where custo_caixa < 0)::bigint,
  'ck_produtos_custo_caixa_nao_neg'),
( 4,'BLOQUEIA','produtos.custo_frasco negativo',
  (select count(*) from produtos where custo_frasco < 0)::bigint,
  'ck_produtos_custo_frasco_nao_neg'),
( 5,'BLOQUEIA','produtos.preco_padrao negativo',
  (select count(*) from produtos where preco_padrao < 0)::bigint,
  'ck_produtos_preco_padrao_nao_neg'),
( 6,'BLOQUEIA','produtos.frascos_por_caixa < 1 ou nulo (divide o custo medio)',
  (select count(*) from produtos where frascos_por_caixa is null or frascos_por_caixa < 1)::bigint,
  'ck_produtos_fpc_min1'),
( 7,'BLOQUEIA','produtos.estoque_minimo/critico negativo',
  (select count(*) from produtos where estoque_minimo < 0 or estoque_critico < 0)::bigint,
  'ck_produtos_alertas_nao_neg'),
( 8,'BLOQUEIA','produtos.nome nulo ou vazio',
  (select count(*) from produtos where nome is null or btrim(nome) = '')::bigint,
  'not null produtos.nome'),
( 9,'ATENCAO','produtos com estoque mas custo zerado (app trava a venda; lucro erra)',
  (select count(*) from produtos
    where (coalesce(caixas,0) > 0 or coalesce(frascos,0) > 0)
      and coalesce(custo_caixa,0) <= 0)::bigint,
  'corrigir em Produtos > Editar'),
(10,'INFO','produtos.nome duplicado (nao havera UNIQUE; so conferencia)',
  (select coalesce(sum(c - 1),0) from
     (select count(*) c from produtos group by lower(btrim(nome)) having count(*) > 1) x)::bigint,
  'nenhuma acao automatica'),

-- ---------- VENDAS: valores ----------
(20,'BLOQUEIA','vendas.qtd nula ou <= 0',
  (select count(*) from vendas where qtd is null or qtd <= 0)::bigint,
  'ck_vendas_qtd_pos'),
(21,'BLOQUEIA','vendas com valor negativo (val_orig, desconto, val_final, bruto, custo, taxa_val, liq)',
  (select count(*) from vendas
    where val_orig < 0 or desconto < 0 or val_final < 0 or bruto < 0
       or custo < 0 or taxa_val < 0 or liq < 0)::bigint,
  'ck_vendas_valores_nao_neg'),
(22,'BLOQUEIA','vendas.taxa fora de 0..100',
  (select count(*) from vendas where taxa < 0 or taxa > 100)::bigint,
  'ck_vendas_taxa_0_100'),
(23,'BLOQUEIA','vendas.parcelas <= 0 (nulo e permitido)',
  (select count(*) from vendas where parcelas is not null and parcelas <= 0)::bigint,
  'ck_vendas_parcelas_pos'),
-- lucro_liq e margem NAO entram em check: prejuizo negativo e legitimo.
(24,'INFO','vendas com lucro_liq negativo (prejuizo legitimo; nao tera constraint)',
  (select count(*) from vendas where lucro_liq < 0)::bigint,
  'nenhuma constraint'),

-- ---------- VENDAS: NULLs que viram NOT NULL ----------
(30,'BLOQUEIA','vendas.prod nulo',
  (select count(*) from vendas where prod is null)::bigint,
  'not null vendas.prod'),
(31,'BLOQUEIA','vendas.tipo nulo',
  (select count(*) from vendas where tipo is null)::bigint,
  'not null vendas.tipo'),
(32,'BLOQUEIA','vendas.data nula',
  (select count(*) from vendas where data is null)::bigint,
  'not null vendas.data'),
(33,'BLOQUEIA','vendas.pgto nulo',
  (select count(*) from vendas where pgto is null)::bigint,
  'not null vendas.pgto'),
(34,'BLOQUEIA','vendas.bruto ou vendas.custo nulo',
  (select count(*) from vendas where bruto is null or custo is null)::bigint,
  'not null vendas.bruto / vendas.custo'),
(35,'BLOQUEIA','vendas.val_final nulo',
  (select count(*) from vendas where val_final is null)::bigint,
  'not null vendas.val_final'),
(36,'BLOQUEIA','vendas.cliente nulo',
  (select count(*) from vendas where cliente is null)::bigint,
  'not null vendas.cliente'),
(37,'BLOQUEIA','vendas.quitado ou vendas.cancelada nulo',
  (select count(*) from vendas where quitado is null or cancelada is null)::bigint,
  'not null vendas.quitado / vendas.cancelada'),

-- ---------- VENDAS: dominios de texto ----------
(40,'BLOQUEIA','vendas.tipo fora de (caixa, frasco)',
  (select count(*) from vendas where tipo is not null and tipo not in ('caixa','frasco'))::bigint,
  'ck_vendas_tipo'),
(41,'ATENCAO','vendas.pgto fora de (pix, credito, debito, dinheiro, parcelado, fiado)',
  (select count(*) from vendas
    where pgto is not null and pgto not in ('pix','credito','debito','dinheiro','parcelado','fiado'))::bigint,
  'ck_vendas_pgto - vem COMENTADO no 001'),
(42,'ATENCAO','vendas.taxa_quem fora de (nos, cliente)',
  (select count(*) from vendas
    where taxa_quem is not null and taxa_quem not in ('nos','cliente'))::bigint,
  'ck_vendas_taxa_quem - vem COMENTADO no 001'),
(43,'ATENCAO','vendas.pgto_quitado fora de (pix, credito, debito, dinheiro)',
  (select count(*) from vendas
    where pgto_quitado is not null and pgto_quitado not in ('pix','credito','debito','dinheiro'))::bigint,
  'ck_vendas_pgto_quitado - vem COMENTADO no 001'),

-- ---------- VENDAS: integridade referencial ----------
(50,'BLOQUEIA','vendas.prod orfao (produto nao existe mais em produtos)',
  (select count(*) from vendas v
    where v.prod is null or not exists (select 1 from produtos p where p.id = v.prod))::bigint,
  'fk_vendas_prod'),
(51,'BLOQUEIA','vendas.cli_id orfao (cliente apagado, venda ainda apontando)',
  (select count(*) from vendas v
    where v.cli_id is not null
      and not exists (select 1 from clientes c where c.id = v.cli_id))::bigint,
  'fk_vendas_cli_id'),
(52,'INFO','vendas.cli_id nulo (a FK aceita nulo: venda sem cliente cadastrado)',
  (select count(*) from vendas where cli_id is null)::bigint,
  'fk aceita nulo'),
(53,'ATENCAO','clientes que passam a NAO poder ser apagados (FK ON DELETE RESTRICT)',
  (select count(distinct cli_id) from vendas where cli_id is not null)::bigint,
  'delCli() vai falhar nestes - ver README, DECISAO 3'),
(54,'INFO','vendas fiado em aberto sem vence_em',
  (select count(*) from vendas
    where pgto = 'fiado' and coalesce(quitado,false) = false
      and coalesce(cancelada,false) = false and vence_em is null)::bigint,
  'so afeta a cobranca automatica'),
(55,'INFO','vendas suspeitas de duplicidade (mesmo prod/tipo/qtd/cliente/data/valor)',
  (select coalesce(sum(c - 1),0) from
     (select count(*) c from vendas
       where coalesce(cancelada,false) = false
       group by prod, tipo, qtd, coalesce(cli_id,-1), data, bruto
       having count(*) > 1) x)::bigint,
  'op_id (002) evita novas; as antigas ficam'),

-- ---------- SAIDAS ----------
(60,'BLOQUEIA','saidas.val nulo ou negativo',
  (select count(*) from saidas where val is null or val < 0)::bigint,
  'ck_saidas_val_nao_neg + not null'),
(61,'BLOQUEIA','saidas.data nula',
  (select count(*) from saidas where data is null)::bigint,
  'not null saidas.data'),
(62,'BLOQUEIA','saidas.descricao nula ou vazia',
  (select count(*) from saidas where descricao is null or btrim(descricao) = '')::bigint,
  'not null saidas.descricao'),
(63,'BLOQUEIA','saidas.tipo nulo',
  (select count(*) from saidas where tipo is null)::bigint,
  'not null saidas.tipo'),
(64,'ATENCAO','saidas.tipo fora de (prolabore, retirada, fornecedor, despesa, imposto, outros)',
  (select count(*) from saidas
    where tipo is not null
      and tipo not in ('prolabore','retirada','fornecedor','despesa','imposto','outros'))::bigint,
  'ck_saidas_tipo - vem COMENTADO no 001'),
(65,'ATENCAO','saidas.pgto fora de (pix, transferencia, dinheiro, debito)',
  (select count(*) from saidas
    where pgto is not null and pgto not in ('pix','transferencia','dinheiro','debito'))::bigint,
  'ck_saidas_pgto - vem COMENTADO no 001'),

-- ---------- REPOSICOES (compras) ----------
(70,'BLOQUEIA','reposicoes.qtd nula ou <= 0',
  (select count(*) from reposicoes where qtd is null or qtd <= 0)::bigint,
  'ck_reposicoes_qtd_pos'),
(71,'BLOQUEIA','reposicoes com valor negativo (cust_unit, cust_total, frete)',
  (select count(*) from reposicoes where cust_unit < 0 or cust_total < 0 or frete < 0)::bigint,
  'ck_reposicoes_valores_nao_neg'),
(72,'BLOQUEIA','reposicoes.prod orfao',
  (select count(*) from reposicoes r
    where r.prod is null or not exists (select 1 from produtos p where p.id = r.prod))::bigint,
  'fk_reposicoes_prod'),
(73,'BLOQUEIA','reposicoes.data nula',
  (select count(*) from reposicoes where data is null)::bigint,
  'not null reposicoes.data (o estorno compara datas)'),
(74,'BLOQUEIA','reposicoes.tipo nulo',
  (select count(*) from reposicoes where tipo is null)::bigint,
  'not null reposicoes.tipo'),
(75,'BLOQUEIA','reposicoes.tipo fora de (caixa, frasco)',
  (select count(*) from reposicoes
    where tipo is not null and tipo not in ('caixa','frasco'))::bigint,
  'ck_reposicoes_tipo'),
(76,'BLOQUEIA','reposicoes.cust_unit ou cust_total nulo',
  (select count(*) from reposicoes where cust_unit is null or cust_total is null)::bigint,
  'not null reposicoes.cust_unit / cust_total'),
(77,'INFO','reposicoes onde cust_total <> qtd*cust_unit + frete (diferenca > 0,01)',
  (select count(*) from reposicoes
    where abs(coalesce(cust_total,0)
              - (coalesce(qtd,0) * coalesce(cust_unit,0) + coalesce(frete,0))) > 0.01)::bigint,
  'conferir a mao; nao tera constraint'),
(78,'INFO','reposicoes com saida pareada (saidas.id = reposicoes.id+1) - usado pelo estorno',
  (select count(*) from reposicoes r
    where exists (select 1 from saidas s
                   where s.id = r.id + 1 and s.tipo = 'fornecedor'
                     and abs(coalesce(s.val,0) - coalesce(r.cust_total,0)) < 0.01))::bigint,
  'vsp_estornar_compra apaga essa saida'),

-- ---------- CLIENTES ----------
(80,'BLOQUEIA','clientes.nome nulo ou vazio',
  (select count(*) from clientes where nome is null or btrim(nome) = '')::bigint,
  'not null clientes.nome'),
(81,'INFO','clientes com telefone duplicado (nao havera UNIQUE; so conferencia)',
  (select coalesce(sum(c - 1),0) from
     (select count(*) c from clientes
       where tel is not null and btrim(tel) <> ''
       group by regexp_replace(tel,'[^0-9]','','g') having count(*) > 1) x)::bigint,
  'nenhuma acao automatica'),

-- ---------- AUDIT / CONFIG ----------
(85,'BLOQUEIA','audit_log.ts nulo',
  (select count(*) from audit_log where ts is null)::bigint,
  'not null audit_log.ts (default now())'),
(86,'BLOQUEIA','audit_log.acao nula',
  (select count(*) from audit_log where acao is null)::bigint,
  'not null audit_log.acao'),
(87,'ATENCAO','config: linha id=1 presente (0 = faltando, 1 = ok)',
  (select count(*) from config where id = 1)::bigint,
  '001 garante o insert'),
(88,'INFO','config: split_victor + split_stefany <> 100',
  (select count(*) from config
    where abs(coalesce(split_victor,0) + coalesce(split_stefany,0) - 100) > 0.001)::bigint,
  'so conferencia'),

-- ---------- CONTAGENS DE REFERENCIA ----------
(90,'INFO','TOTAL produtos',   (select count(*) from produtos)::bigint,   'esperado 2'),
(91,'INFO','TOTAL vendas',     (select count(*) from vendas)::bigint,     'esperado 65'),
(92,'INFO','TOTAL clientes',   (select count(*) from clientes)::bigint,   'esperado 21'),
(93,'INFO','TOTAL saidas',     (select count(*) from saidas)::bigint,     'esperado 23'),
(94,'INFO','TOTAL reposicoes', (select count(*) from reposicoes)::bigint, 'esperado 5'),
(95,'INFO','TOTAL audit_log',  (select count(*) from audit_log)::bigint,  'sem referencia'),
(96,'INFO','TOTAL vendas canceladas',
  (select count(*) from vendas where coalesce(cancelada,false))::bigint, 'sem referencia'),

-- ---------- ESTADO DAS MIGRATIONS ----------
(97,'INFO','002 aplicado? colunas op_id existentes (0 antes, 4 depois)',
  (select count(*) from information_schema.columns
    where table_schema = 'public' and column_name = 'op_id'
      and table_name in ('vendas','saidas','reposicoes','clientes'))::bigint,
  'referencia'),
(98,'INFO','policies permissivas vsp_auth_% ainda no banco (003 remove)',
  (select count(*) from pg_policies
    where schemaname = 'public' and policyname like 'vsp_auth_%')::bigint,
  '003 troca por policy por comando'),
(99,'ATENCAO','tabelas do app com RLS DESLIGADA',
  (select count(*) from pg_tables
    where schemaname = 'public'
      and tablename in ('produtos','vendas','clientes','saidas','reposicoes',
                        'estoque','audit_log','config','backups')
      and not rowsecurity)::bigint,
  'deve ser 0'),
(100,'INFO','tabela usuarios_autorizados existe? (0 antes do 003, 1 depois)',
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'usuarios_autorizados')::bigint,
  'referencia')

) as t(ordem, efeito, checagem, registros, constraint_ou_acao)
order by ordem;


-- ============================================================
-- DETALHAMENTO (opcional)
-- Ficam COMENTADOS de proposito: o SQL Editor mostra so o resultado
-- do ultimo comando, e o painel acima e o que importa.
-- Descomente UM por vez quando alguma linha BLOQUEIA vier > 0.
-- ============================================================

-- -- Vendas apontando para produto que nao existe:
-- select id, data, prod, cliente, bruto from vendas v
--  where v.prod is null or not exists (select 1 from produtos p where p.id = v.prod)
--  order by data;

-- -- Vendas apontando para cliente apagado:
-- select id, data, cli_id, cliente, wpp, bruto, pgto from vendas v
--  where v.cli_id is not null
--    and not exists (select 1 from clientes c where c.id = v.cli_id)
--  order by data;

-- -- Compras apontando para produto que nao existe:
-- select id, data, prod, qtd, tipo, cust_total, forn from reposicoes r
--  where r.prod is null or not exists (select 1 from produtos p where p.id = r.prod);

-- -- Clientes que deixam de ser apagaveis (FK ON DELETE RESTRICT):
-- select c.id, c.nome, c.tel, count(v.id) as vendas
--   from clientes c join vendas v on v.cli_id = c.id
--  group by c.id, c.nome, c.tel order by vendas desc;

-- -- Vendas com qualquer valor negativo:
-- select id, data, cliente, val_orig, desconto, val_final, bruto, custo, taxa, taxa_val, liq
--   from vendas
--  where val_orig < 0 or desconto < 0 or val_final < 0 or bruto < 0
--     or custo < 0 or taxa_val < 0 or liq < 0;

-- -- Duplicidades suspeitas de venda (candidatas a erro de lancamento):
-- select prod, tipo, qtd, cli_id, data, bruto, count(*) as vezes,
--        array_agg(id order by id) as ids
--   from vendas where coalesce(cancelada,false) = false
--  group by prod, tipo, qtd, cli_id, data, bruto having count(*) > 1;

-- -- Foto do estoque e do custo medio ANTES de mexer (guarde o resultado):
-- select id, nome, caixas, frascos, frascos_por_caixa,
--        custo_caixa, custo_frasco,
--        caixas * frascos_por_caixa + frascos as unidades_equivalentes,
--        caixas * custo_caixa + frascos * custo_frasco as valor_em_estoque
--   from produtos order by nome;

-- -- Depois do 002: op_id duplicado (tem que dar zero linhas sempre):
-- select 'vendas' as tabela, op_id, count(*) from vendas
--   where op_id is not null group by op_id having count(*) > 1
-- union all
-- select 'saidas', op_id, count(*) from saidas
--   where op_id is not null group by op_id having count(*) > 1
-- union all
-- select 'reposicoes', op_id, count(*) from reposicoes
--   where op_id is not null group by op_id having count(*) > 1
-- union all
-- select 'clientes', op_id, count(*) from clientes
--   where op_id is not null group by op_id having count(*) > 1;

-- -- Depois do 001: constraints que ficaram NOT VALID (dado antigo violando):
-- select conrelid::regclass as tabela, conname as constraint_nome,
--        contype, convalidated
--   from pg_constraint
--  where connamespace = 'public'::regnamespace and not convalidated
--  order by 1, 2;
