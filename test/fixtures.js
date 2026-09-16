'use strict';
/* =============================================================================
 * fixtures.js — dados de teste do VS Performance
 * =============================================================================
 *
 * DE ONDE VEM ISSO
 *   De BASELINE_2026-09-15.md, a fotografia do banco de producao tirada antes do
 *   pente-fino. O dump linha-a-linha do Supabase NAO esta no repositorio, entao
 *   o fixture "producao" e SINTETICO no detalhe e EXATO no agregado: as 65
 *   vendas, 23 saidas, 5 reposicoes e 2 produtos foram construidos para somar,
 *   ao centavo, os numeros canonicos da baseline:
 *
 *     custo ja vendido ........ R$ 23.539,30
 *     valor do estoque ........ R$  4.660,00
 *     pago a fornecedores ..... R$ 22.441,00
 *     divida com Victor ....... R$  5.758,30
 *     recebido total .......... R$ 51.066,00
 *     saidas totais ........... R$ 51.069,49
 *     resultado de caixa ...... R$     -3,49
 *     total comprado .......... R$ 19.065,00
 *
 *   Ou seja: ele NAO prova nada sobre uma venda individual de producao (nao sao
 *   as vendas reais), e prova tudo sobre os TOTAIS — que e o que a baseline
 *   congelou e o que uma refatoracao pode quebrar sem ninguem ver.
 *
 *   Toda a aritmetica e feita em CENTAVOS INTEIROS e so no fim dividida por 100,
 *   para o fixture nao carregar erro de ponto flutuante proprio. Duas linhas sao
 *   explicitamente de AJUSTE (marcadas com `ajuste:true` na descricao): a ultima
 *   venda recebida e uma saida de "outros". Elas absorvem a diferenca entre os
 *   valores escolhidos a mao e o total canonico. Estao rotuladas de proposito —
 *   nenhum numero da baseline foi "encaixado" as escondidas.
 *
 * FORMATO
 *   Os objetos estao no formato POS-mapeamento (mapProd/mapVenda/mapSaida/mapRep),
 *   isto e, do jeito que o `DB` do app fica depois do loadAll(). Nada aqui passa
 *   pelo Supabase.
 *
 * FIXTURES PEQUENOS
 *   dbMinimo / produtoTG / dbEstorno / dbSplit / dbComTaxa — um caso isolado cada,
 *   com numeros redondos e conferiveis de cabeca.
 * ========================================================================== */

// ------------------------------------------------------------- canonicos ----

const CANONICO = {
  fonte: 'BASELINE_2026-09-15.md',
  shaInicial: '31c551d00593d754c80104d6a46b278ddde9eb05',
  contagens: {
    produtos: 2,
    vendas: 65,
    vendasAtivas: 60,
    vendasCanceladas: 5,
    clientes: 21,
    saidas: 23,
    reposicoes: 5,
  },
  custoJaVendido: 23539.30,
  valorEstoque: 4660.00,
  mercadoriaFornecida: 28199.30,
  pagoFornecedor: 22441.00,
  dividaComVictor: 5758.30,
  recebidoTotal: 51066.00,
  saidasTotais: 51069.49,
  resultadoCaixa: -3.49,
  totalComprado: 19065.00,
  diferencaExplicada: 9134.30,
  estoque: {
    TG: { caixas: 8, frascos: 0, custoCaixa: 582.50 },
    RETA_VERDE: { caixas: 0, frascos: 0, custoCaixa: 787.50 },
  },
};

const C = {
  custoJaVendido: 2353930,
  valorEstoque: 466000,
  pagoFornecedor: 2244100,
  recebidoTotal: 5106600,
  saidasTotais: 5106949,
  totalComprado: 1906500,
};

const cent = (c) => Math.round(c) / 100;

// -------------------------------------------------------------- produtos ----

function produtoTG(over) {
  return Object.assign({
    id: 'TG',
    nome: 'TG',
    vendeFrasco: true,
    fpc: 4,
    custoCaixa: 582.50,
    custoFrasco: 145.63, // 145,625 arredondado; o custoCaixa vem do valor NAO arredondado
    precoPadrao: 1450.00,
    estMin: 4,
    estCrit: 2,
    caixas: 8,
    frascos: 0,
    ativo: true,
  }, over || {});
}

function produtoReta(over) {
  return Object.assign({
    id: 'RETA_VERDE',
    nome: 'Reta Verde',
    vendeFrasco: true,
    fpc: 4,
    custoCaixa: 787.50,
    custoFrasco: 196.88,
    precoPadrao: 1900.00,
    estMin: 4,
    estCrit: 2,
    caixas: 0,
    frascos: 0,
    ativo: true,
  }, over || {});
}

/** TG sem nenhum estoque e sem custo: o cenario do custo medio "do zero". */
function produtoTGZerado(over) {
  return produtoTG(Object.assign({
    caixas: 0, frascos: 0, custoCaixa: 0, custoFrasco: 0,
  }, over || {}));
}

// ----------------------------------------------------------------- config ----

function config(over) {
  return Object.assign({
    id: 1,
    split_victor: 50,
    split_stefany: 50,
    meta_lucro_mes: 6000,
    meta_bruto_mes: 12000,
    meta_lucro_sem: 1500,
    meta_bruto_sem: 3000,
    lead_time: 7,
    cobertura_alvo: 45,
    janela_media: 30,
    aviso_validade: 60,
    pix_chave: '',
    pix_nome: '',
    pix_cidade: '',
    last_backup: '14/09/2026 23:10:02',
  }, over || {});
}

// ------------------------------------------------------- fixture producao ----

const MESES = ['2026-06', '2026-07', '2026-08', '2026-09'];
// ciclo de 6 custos que fecha 10 voltas em 60 vendas somando 23.539,30
const CUSTOS_CENT = [14563, 29126, 43689, 58250, 44882, 44883];
// fiado ainda em aberto: de proposito TODOS antes de setembro, para que o mes de
// setembro (usado nos testes de Fechamento x DRE) nao tenha venda com lucroLiq=0
const FIADO_ABERTO = new Set([7, 16, 22, 31, 38, 44]);
// marcacao media que reproduz o recebido canonico: 51.066,00 / 21.185,36 de custo
// recebido. Com ela a linha de ajuste da ultima venda fica em ~20 centavos.
const RAZAO_PRECO = 2.41043;
const PGTOS = ['pix', 'dinheiro', 'credito', 'debito', 'parcelado'];

const NOMES_CLI = [
  'Ana Paula', 'Bruno Lima', 'Carla Dias', 'Diego Rocha', 'Elisa Prado',
  'Fabio Neves', 'Gisele Matos', 'Hugo Barros', 'Ivone Cruz', 'Joao Vitor',
  'Karla Mendes', 'Leo Ferraz', 'Marcia Alves', 'Nelson Faria', 'Olivia Reis',
  'Paulo Serra', 'Queila Nunes', 'Rafael Toledo', 'Sandra Bueno', 'Tiago Melo',
  'Ursula Gomes',
];

function clientes() {
  return NOMES_CLI.map((nome, i) => ({
    id: 1 + i,
    nome,
    tel: '419' + String(90000000 + i * 1111).slice(0, 8),
    obs: '',
  }));
}

function vendasProducao() {
  const linhas = [];
  // 1a passada: valores "naturais" em centavos
  for (let i = 0; i < 60; i++) {
    const custoC = CUSTOS_CENT[i % 6];
    linhas.push({
      i,
      custoC,
      brutoC: Math.round(custoC * RAZAO_PRECO),
      fiadoAberto: FIADO_ABERTO.has(i),
    });
  }
  // 2a passada: a ULTIMA venda recebida absorve a diferenca ate o recebido canonico
  const recebidas = linhas.filter((l) => !l.fiadoAberto);
  const ultima = recebidas[recebidas.length - 1];
  const somaOutras = recebidas
    .filter((l) => l !== ultima)
    .reduce((a, l) => a + l.brutoC, 0);
  ultima.brutoC = C.recebidoTotal - somaOutras;
  ultima.ajuste = true;

  const vendas = linhas.map((l) => {
    const i = l.i;
    const mes = MESES[Math.floor(i / 15)];
    const dia = String(2 + (i % 15) * 2).padStart(2, '0');
    const data = mes + '-' + dia;
    const fiadoQuitado = !l.fiadoAberto && i % 10 === 3;
    const pgto = (l.fiadoAberto || fiadoQuitado) ? 'fiado' : PGTOS[i % 5];
    const bruto = cent(l.brutoC);
    const custo = cent(l.custoC);
    const lucroLiq = l.fiadoAberto ? 0 : cent(l.brutoC - l.custoC);
    const usuario = (i < 2) ? '' : (i % 2 === 0 ? 'Victor' : 'Stefany');
    const tipo = l.custoC === 58250 ? 'caixa' : 'frasco';
    const qtd = tipo === 'caixa' ? 1 : Math.max(1, Math.round(l.custoC / 14563));
    const cli = 1 + (i % NOMES_CLI.length);
    return {
      id: 500000 + i,
      prod: i % 7 === 5 ? 'RETA_VERDE' : 'TG',
      tipo,
      qtd,
      valOrig: bruto,
      desc: 0,
      valFinal: bruto,
      bruto,
      custo,
      taxa: 0,
      taxaVal: 0,
      taxaQuem: 'nos',
      liq: bruto, // taxa zero no fixture de producao (ver README)
      lucroLiq,
      margem: bruto ? (lucroLiq / bruto) * 100 : 0,
      cliente: NOMES_CLI[(i % NOMES_CLI.length)],
      wpp: '419' + String(90000000 + (i % NOMES_CLI.length) * 1111).slice(0, 8),
      cliId: cli,
      data,
      obs: l.ajuste ? 'linha de ajuste do fixture (fecha o recebido canonico)' : '',
      pgto,
      parcelas: pgto === 'parcelado' ? 3 : null,
      quitado: fiadoQuitado,
      pgtoQuitado: fiadoQuitado ? 'pix' : null,
      quitadoEm: fiadoQuitado ? '10/09/2026 10:00:00' : '',
      cancelada: false,
      canceladaPor: null,
      canceladaEm: null,
      canceladaMotivo: null,
      venceEm: (l.fiadoAberto || fiadoQuitado) ? data.slice(0, 8) + '28' : '',
      usuario,
      lote: '',
    };
  });

  // as 5 canceladas: valores plausiveis que NAO podem entrar em nenhuma conta
  const canceladas = [
    ['2026-06-11', 58250, 142000, 'Cliente desistiu'],
    ['2026-07-03', 29126, 71000, 'Erro de lancamento'],
    ['2026-07-27', 14563, 35500, 'Duplicidade'],
    ['2026-08-16', 43689, 106500, 'Produto trocado'],
    ['2026-09-04', 58250, 142000, 'Pagamento nao entrou'],
  ].map(([data, custoC, brutoC, motivo], k) => ({
    id: 600000 + k,
    prod: 'TG',
    tipo: custoC === 58250 ? 'caixa' : 'frasco',
    qtd: custoC === 58250 ? 1 : Math.max(1, Math.round(custoC / 14563)),
    valOrig: cent(brutoC),
    desc: 0,
    valFinal: cent(brutoC),
    bruto: cent(brutoC),
    custo: cent(custoC),
    taxa: 0,
    taxaVal: 0,
    taxaQuem: 'nos',
    liq: cent(brutoC),
    lucroLiq: cent(brutoC - custoC),
    margem: 0,
    cliente: NOMES_CLI[k],
    wpp: '41999990000',
    cliId: 1 + k,
    data,
    obs: '',
    pgto: 'pix',
    parcelas: null,
    quitado: false,
    pgtoQuitado: null,
    quitadoEm: '',
    cancelada: true,
    canceladaPor: 'Victor',
    canceladaEm: '15/09/2026 09:00:00',
    canceladaMotivo: motivo,
    venceEm: '',
    usuario: k % 2 === 0 ? 'Victor' : 'Stefany',
    lote: '',
  }));

  return vendas.concat(canceladas);
}

function saidasProducao() {
  const s = (id, data, tipo, socio, desc, valC, pgto) => ({
    id, tipo, socio, desc, data, val: cent(valC), pgto: pgto || 'pix',
  });

  const fornecedor = [
    s(1001, '2026-06-20', 'fornecedor', 'Victor', 'Pagamento fornecedor — lote junho', 500000),
    s(1002, '2026-07-05', 'fornecedor', 'Victor', 'Pagamento fornecedor — lote julho', 500000),
    s(1003, '2026-08-02', 'fornecedor', 'Victor', 'Pagamento fornecedor — lote agosto', 450000),
    s(1004, '2026-08-28', 'fornecedor', 'Victor', 'Pagamento fornecedor — complemento agosto', 358500),
    // restaurado em 15/09/2026 (item 1 da lista de correcoes da baseline)
    s(1005, '2026-09-15', 'fornecedor', 'Victor', 'Pagamento fornecedor — restaurado em 15/09', 435600),
  ];

  const outras = [
    s(1006, '2026-06-30', 'prolabore', 'Victor', 'Pro-labore junho', 180000),
    s(1007, '2026-06-30', 'prolabore', 'Stefany', 'Pro-labore junho', 180000),
    s(1008, '2026-07-31', 'prolabore', 'Victor', 'Pro-labore julho', 220000),
    s(1009, '2026-07-31', 'prolabore', 'Stefany', 'Pro-labore julho', 220000),
    s(1010, '2026-08-31', 'prolabore', 'Victor', 'Pro-labore agosto', 240000),
    s(1011, '2026-08-31', 'prolabore', 'Stefany', 'Pro-labore agosto', 240000),
    s(1012, '2026-09-10', 'prolabore', 'Victor', 'Pro-labore setembro', 260000),
    s(1013, '2026-09-10', 'prolabore', 'Stefany', 'Pro-labore setembro', 260000),
    s(1014, '2026-06-18', 'retirada', 'Victor', 'Retirada extra', 150000),
    s(1015, '2026-07-22', 'retirada', 'Stefany', 'Retirada extra', 120000),
    s(1016, '2026-08-14', 'retirada', 'Victor', 'Retirada extra', 90000),
    // a retirada "Ambos": hoje o Fechamento divide por 2 fixo (ver financeiro.test.js)
    s(1017, '2026-09-12', 'retirada', 'Ambos', 'Retirada conjunta setembro', 120000, 'dinheiro'),
    s(1018, '2026-06-25', 'despesa', null, 'Embalagens', 32000, 'dinheiro'),
    s(1019, '2026-07-20', 'despesa', null, 'Frete/motoboy', 48050, 'pix'),
    s(1020, '2026-08-18', 'despesa', null, 'Marketing', 65000, 'credito'),
    s(1021, '2026-09-05', 'despesa', null, 'Embalagens', 41235, 'dinheiro'),
    s(1022, '2026-09-08', 'imposto', null, 'DAS MEI', 7690, 'pix'),
  ];

  // LINHA DE AJUSTE: fecha o total de saidas da baseline (51.069,49).
  // Fica em JULHO de proposito, para setembro conter so valores escolhidos a mao.
  const somaAte = fornecedor.concat(outras)
    .reduce((a, x) => a + Math.round(x.val * 100), 0);
  const ajusteC = C.saidasTotais - somaAte;
  const ajuste = s(1023, '2026-07-25', 'outros',
    null, 'Despesas diversas acumuladas (linha de ajuste do fixture)', ajusteC, 'pix');

  return fornecedor.concat(outras, [ajuste]);
}

function reposicoesProducao() {
  const r = (id, data, prod, qtd, custUnitC, freteC, forn) => ({
    id, prod, tipo: 'caixa', qtd,
    custUnit: cent(custUnitC),
    frete: cent(freteC),
    custTotal: cent(qtd * custUnitC + freteC),
    forn, data,
    obs: '',
    lote: 'L' + data.replace(/-/g, '').slice(2),
    validade: data.slice(0, 4) + 1 + data.slice(4),
    notaLote: '',
  });
  return [
    r(2001, '2026-07-12', 'TG', 8, 50000, 0, 'Victor'),
    r(2002, '2026-08-01', 'TG', 6, 52500, 0, 'Victor'),
    r(2003, '2026-08-20', 'RETA_VERDE', 4, 78750, 0, 'Victor'),
    r(2004, '2026-09-02', 'TG', 8, 58250, 0, 'Victor'),
    r(2005, '2026-09-10', 'TG', 7, 57800, 5900, 'Victor'),
  ];
}

/**
 * Fixture "producao": reproduz os agregados canonicos da baseline.
 * Sempre devolve uma copia nova — pode mutar a vontade.
 */
function producao() {
  const db = {
    produtos: [produtoReta(), produtoTG()], // ordem alfabetica, como o loadAll pede
    vendas: vendasProducao(),
    clientes: clientes(),
    saidas: saidasProducao(),
    reposicoes: reposicoesProducao(),
    auditLog: [],
    config: config(),
  };
  verificar(db); // nao deixa um fixture torto passar por baseline
  return db;
}

// ------------------------------------------------------ fixtures pequenos ----

function dbMinimo(over) {
  return Object.assign({
    produtos: [produtoTG()],
    vendas: [],
    clientes: [],
    saidas: [],
    reposicoes: [],
    auditLog: [],
    config: config(),
  }, over || {});
}

/** Estoque e custo zerados: primeira compra de um produto novo. */
function dbEstoqueZero() {
  return dbMinimo({ produtos: [produtoTGZerado()] });
}

function vendaSimples(over) {
  return Object.assign({
    id: 700001,
    prod: 'TG',
    tipo: 'frasco',
    qtd: 1,
    valOrig: 400.00,
    desc: 0,
    valFinal: 400.00,
    bruto: 400.00,
    custo: 145.63,
    taxa: 0,
    taxaVal: 0,
    taxaQuem: 'nos',
    liq: 400.00,
    lucroLiq: 254.37,
    margem: 63.5925,
    cliente: 'Cliente Teste',
    wpp: '41999990000',
    cliId: 1,
    data: '2026-09-10',
    obs: '',
    pgto: 'pix',
    parcelas: null,
    quitado: false,
    pgtoQuitado: null,
    quitadoEm: '',
    cancelada: false,
    canceladaPor: null,
    canceladaEm: null,
    canceladaMotivo: null,
    venceEm: '',
    usuario: 'Victor',
    lote: '',
  }, over || {});
}

function saidaSimples(over) {
  return Object.assign({
    id: 800001,
    tipo: 'despesa',
    socio: null,
    desc: 'Despesa teste',
    data: '2026-09-10',
    val: 100.00,
    pgto: 'pix',
  }, over || {});
}

/**
 * Tres cenarios de estorno de compra. A compra sempre foi de 8 caixas a 582,50
 * (R$ 4.660,00) lancada em 02/09/2026 sobre um estoque anterior de 2 caixas a
 * 500,00 — ou seja, o estado "depois da compra" e 10 caixas com custo medio
 * 141,50/frasco (566,00/caixa), conta que fecha de cabeca:
 *   antes:  8 frascos x 125,00 = 1.000,00
 *   compra: 32 frascos        = 4.660,00
 *   depois: 40 frascos        = 5.660,00  ->  141,50/frasco
 *
 *   'limpo'         sem venda depois: devolve estoque E custo (volta a 125,00/500,00)
 *   'vendaDepois'   com venda depois: devolve estoque e MANTEM o custo (141,50/566,00)
 *   'insuficiente'  estoque menor que a compra: tem de ser bloqueado
 */
function dbEstorno(cenario) {
  const compra = {
    id: 3000,
    prod: 'TG',
    tipo: 'caixa',
    qtd: 8,
    custUnit: 582.50,
    frete: 0,
    custTotal: 4660.00,
    forn: 'Victor',
    data: '2026-09-02',
    obs: '',
    lote: 'L260902',
    validade: '2027-09-02',
    notaLote: '',
  };
  const base = {
    caixas: 10, frascos: 0, custoCaixa: 566.00, custoFrasco: 141.50,
  };

  if (cenario === 'limpo') {
    return dbMinimo({
      produtos: [produtoTG(base)],
      reposicoes: [compra],
      // venda ANTES da compra: nao deve impedir o recalculo
      vendas: [vendaSimples({ data: '2026-08-15' })],
    });
  }
  if (cenario === 'vendaDepois') {
    // estoque quase todo vendido depois da compra: e aqui que a subtracao
    // ingenua daria 9,50/frasco (o bug que zerava o custo)
    return dbMinimo({
      produtos: [produtoTG({ caixas: 8, frascos: 1, custoCaixa: 566.00, custoFrasco: 141.50 })],
      reposicoes: [compra],
      vendas: [vendaSimples({ data: '2026-09-08', tipo: 'caixa', qtd: 2, custo: 1132.00 })],
    });
  }
  if (cenario === 'insuficiente') {
    return dbMinimo({
      produtos: [produtoTG({ caixas: 3, frascos: 0, custoCaixa: 566.00, custoFrasco: 141.50 })],
      reposicoes: [compra],
      vendas: [vendaSimples({ data: '2026-09-09', tipo: 'caixa', qtd: 7, custo: 3962.00 })],
    });
  }
  throw new Error('cenario de estorno desconhecido: ' + cenario);
}

/**
 * Um mes com uma retirada "Ambos" de R$ 1.200,00 e split configurado.
 * Com 60/40, o certo seria Victor 720,00 e Stefany 480,00.
 */
function dbSplit(pctVictor, pctStefany, valorAmbos) {
  const val = valorAmbos == null ? 1200.00 : valorAmbos;
  return dbMinimo({
    config: config({ split_victor: pctVictor, split_stefany: pctStefany }),
    vendas: [
      vendaSimples({ id: 900001, data: '2026-09-05', usuario: 'Victor' }),
      vendaSimples({ id: 900002, data: '2026-09-06', usuario: 'Stefany' }),
    ],
    saidas: [
      { id: 900101, tipo: 'retirada', socio: 'Ambos', desc: 'Retirada conjunta', data: '2026-09-12', val, pgto: 'dinheiro' },
    ],
  });
}

/** Uma venda com taxa de maquininha paga por nos (taxaQuem='nos'). */
function dbComTaxa() {
  const bruto = 1000.00;
  const taxa = 4;
  const taxaVal = 40.00;
  const liq = 960.00;
  const custo = 582.50;
  return dbMinimo({
    vendas: [vendaSimples({
      id: 910001, data: '2026-09-07', tipo: 'caixa', qtd: 1,
      valOrig: bruto, valFinal: bruto, bruto, custo,
      taxa, taxaVal, taxaQuem: 'nos', liq,
      lucroLiq: liq - custo, margem: ((liq - custo) / bruto) * 100,
      pgto: 'credito',
    })],
    saidas: [saidaSimples({ data: '2026-09-07', val: 100.00, tipo: 'despesa' })],
  });
}

// ------------------------------------------------------------- verificacao ----

/**
 * Recalcula os agregados do fixture em centavos inteiros (implementacao propria,
 * independente do index.html) e explode se algum nao bater com a baseline.
 * Roda automaticamente em producao().
 */
function verificar(db) {
  const c = (x) => Math.round((+x || 0) * 100);
  const ativas = db.vendas.filter((v) => !v.cancelada);
  const canceladas = db.vendas.filter((v) => v.cancelada);

  const custoJaVendido = ativas.reduce((a, v) => a + c(v.custo), 0);
  const valorEstoque = db.produtos.reduce(
    (a, p) => a + c((p.caixas || 0) * (p.custoCaixa || 0) + (p.frascos || 0) * (p.custoFrasco || 0)), 0);
  const pagoFornecedor = db.saidas
    .filter((s) => s.tipo === 'fornecedor').reduce((a, s) => a + c(s.val), 0);
  const recebido = ativas
    .filter((v) => v.pgto !== 'fiado' || v.quitado).reduce((a, v) => a + c(v.liq), 0);
  const saidasTotais = db.saidas.reduce((a, s) => a + c(s.val), 0);
  const totalComprado = db.reposicoes.reduce((a, r) => a + c(r.custTotal), 0);

  const obtido = {
    'contagem produtos': db.produtos.length,
    'contagem vendas': db.vendas.length,
    'contagem vendas ativas': ativas.length,
    'contagem vendas canceladas': canceladas.length,
    'contagem clientes': db.clientes.length,
    'contagem saidas': db.saidas.length,
    'contagem reposicoes': db.reposicoes.length,
    'custo ja vendido': custoJaVendido,
    'valor do estoque': valorEstoque,
    'pago a fornecedores': pagoFornecedor,
    'divida com Victor': custoJaVendido + valorEstoque - pagoFornecedor,
    'recebido total': recebido,
    'saidas totais': saidasTotais,
    'resultado de caixa': recebido - saidasTotais,
    'total comprado': totalComprado,
  };
  const esperado = {
    'contagem produtos': CANONICO.contagens.produtos,
    'contagem vendas': CANONICO.contagens.vendas,
    'contagem vendas ativas': CANONICO.contagens.vendasAtivas,
    'contagem vendas canceladas': CANONICO.contagens.vendasCanceladas,
    'contagem clientes': CANONICO.contagens.clientes,
    'contagem saidas': CANONICO.contagens.saidas,
    'contagem reposicoes': CANONICO.contagens.reposicoes,
    'custo ja vendido': C.custoJaVendido,
    'valor do estoque': C.valorEstoque,
    'pago a fornecedores': C.pagoFornecedor,
    'divida com Victor': C.custoJaVendido + C.valorEstoque - C.pagoFornecedor,
    'recebido total': C.recebidoTotal,
    'saidas totais': C.saidasTotais,
    'resultado de caixa': C.recebidoTotal - C.saidasTotais,
    'total comprado': C.totalComprado,
  };

  const erros = Object.keys(esperado)
    .filter((k) => obtido[k] !== esperado[k])
    .map((k) => '  ' + k + ': fixture=' + obtido[k] + ' baseline=' + esperado[k]);
  if (erros.length) {
    throw new Error(
      'fixtures.js: o fixture de producao nao reproduz a baseline (valores em ' +
      'centavos / unidades):\n' + erros.join('\n')
    );
  }
  // sanidade das linhas geradas
  db.vendas.forEach((v) => {
    if (!(v.bruto > v.custo)) {
      throw new Error('fixtures.js: venda ' + v.id + ' com bruto <= custo');
    }
    if (v.bruto > v.custo * 5) {
      throw new Error('fixtures.js: venda ' + v.id + ' com marcacao implausivel');
    }
  });
  return obtido;
}

module.exports = {
  CANONICO,
  producao,
  verificar,
  dbMinimo,
  dbEstoqueZero,
  dbEstorno,
  dbSplit,
  dbComTaxa,
  produtoTG,
  produtoReta,
  produtoTGZerado,
  vendaSimples,
  saidaSimples,
  config,
  cent,
};
