'use strict';
/* =============================================================================
 * financeiro.test.js — o dinheiro. Tudo aqui roda o codigo REAL do index.html.
 * =============================================================================
 * Nada e reimplementado: o teste popula o `DB` do app, chama a funcao de verdade
 * (valorEstTotal, renderFin, dadosFechamento, dadosDRE, confReposicao,
 * estornarCompra) e le o resultado — inclusive lendo os numeros do HTML que o
 * proprio app escreveu, quando a conta so existe dentro de um render.
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');
const { CANONICO } = F;

// --------------------------------------------------------------- utilidades ----

/** Harness novo + DB populado. ~4ms, entao cada caso roda isolado de verdade. */
function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  if (db) h.carregarDB(db);
  return h;
}

/**
 * Le um valor que o app escreveu no HTML. O R() do app formata sempre como
 * "R$ 1234.50" (sem separador de milhar), entao a raspagem e segura.
 */
function valorRotulado(html, rotulo) {
  const i = html.indexOf(rotulo);
  if (i < 0) throw new Error('rotulo "' + rotulo + '" nao existe no HTML gerado');
  const m = html.slice(i).match(/R\$ (-?[\d]+\.\d{2})/);
  if (!m) throw new Error('nenhum valor R$ depois de "' + rotulo + '"');
  return Number(m[1]);
}

/** Roda o renderFin REAL e devolve os dois blocos que ele preenche. */
function financeiroRenderizado(h) {
  h.escopo.renderFin();
  return { met: h.ui.html('finMet'), forn: h.ui.html('fornBody') };
}

const CAMPOS_COMPRA = {
  repProd: 'TG', repTipo: 'caixa', repQtd: '', repCustUnit: '', repForn: 'Victor',
  repData: '2026-09-15', repObs: '', repFrete: '', repLote: '', repValidade: '',
  repNota: '',
};

// =============================================================================
describe('REGRESSAO da baseline de 15/09/2026 — estes numeros NAO podem mudar', () => {

  it('valorEstTotal() = R$ 4.660,00 (8 caixas de TG a 582,50)', () => {
    const h = novo(F.producao());
    assertClose(h.escopo.valorEstTotal(), 4660.00,
      'valor do estoque divergiu da baseline');
    assertEqual(CANONICO.valorEstoque, 4660.00, 'a baseline mudou de valor');
  });

  it('o estoque por produto e o da baseline (TG 8cx a 582,50 · RETA_VERDE 0)', () => {
    const h = novo(F.producao());
    const tg = h.escopo.getProd('TG');
    const rv = h.escopo.getProd('RETA_VERDE');
    assertEqual(tg.caixas, CANONICO.estoque.TG.caixas, 'caixas de TG');
    assertEqual(tg.frascos, CANONICO.estoque.TG.frascos, 'frascos de TG');
    assertClose(tg.custoCaixa, CANONICO.estoque.TG.custoCaixa, 'custo da caixa de TG');
    assertEqual(rv.caixas, CANONICO.estoque.RETA_VERDE.caixas, 'caixas de RETA_VERDE');
    assertClose(rv.custoCaixa, CANONICO.estoque.RETA_VERDE.custoCaixa, 'custo da caixa de RETA_VERDE');
    // valorEstProd usa caixas x custoCaixa: o dinheiro gasto, nao o frasco arredondado
    assertClose(h.escopo.valorEstProd(tg), 4660.00, 'valor em estoque do TG');
    assertClose(h.escopo.valorEstProd(rv), 0, 'RETA_VERDE esta zerado');
  });

  it('custo ja vendido (CMV acumulado) = R$ 23.539,30', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    assertClose(valorRotulado(r.met, 'Custo dos produtos vendidos'), 23539.30,
      'CMV no painel do Financeiro');
    assertClose(valorRotulado(r.forn, 'Custo já vendido'), 23539.30,
      'CMV no bloco de Fornecedores');
  });

  it('mercadoria fornecida (vendida + estoque) = R$ 28.199,30', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    assertClose(valorRotulado(r.forn, 'Mercadoria fornecida'), 28199.30,
      'mercadoria fornecida');
  });

  it('pago a fornecedores = R$ 22.441,00 (inclui os 4.356,00 restaurados em 15/09)', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    assertClose(valorRotulado(r.forn, 'Já pago aos fornecedores'), 22441.00,
      'total pago a fornecedores');
    const restaurada = h.escopo.DB.saidas.find((s) => s.val === 4356.00);
    assertTrue(!!restaurada, 'o pagamento de 4.356,00 tem de estar no fixture');
    assertEqual(restaurada.tipo, 'fornecedor', 'tipo da saida restaurada');
    assertEqual(restaurada.socio, 'Victor', 'socio da saida restaurada');
    assertEqual(restaurada.data, '2026-09-15', 'data da saida restaurada');
  });

  it('divida da empresa com Victor = R$ 5.758,30', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    assertClose(valorRotulado(r.forn, 'Falta pagar'), 5758.30,
      '"falta pagar ao(s) fornecedor(es)" e a divida com Victor');
  });

  it('a divida segue a formula canonica: CMV + estoque - pago a fornecedor', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    const cmv = valorRotulado(r.forn, 'Custo já vendido');
    const est = valorRotulado(r.forn, 'Custo do estoque atual');
    const pago = valorRotulado(r.forn, 'Já pago aos fornecedores');
    const divida = valorRotulado(r.forn, 'Falta pagar');
    assertClose(cmv + est - pago, divida, 'a formula da divida mudou');
    assertClose(est, h.escopo.valorEstTotal(), 'o estoque do bloco e o valorEstTotal()');
  });

  it('resultado de caixa = -R$ 3,49 (recebido 51.066,00 - saidas 51.069,49)', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    assertClose(valorRotulado(r.met, 'Entradas recebidas'), 51066.00, 'recebido total');
    assertClose(valorRotulado(r.met, 'Saídas (financeiro)'), 51069.49, 'saidas totais');
    assertClose(valorRotulado(r.met, 'Resultado (caixa)'), -3.49, 'resultado de caixa');
  });

  it('total comprado (reposicoes) = R$ 19.065,00, somado mes a mes pelo dadosDRE', () => {
    const h = novo(F.producao());
    const meses = ['2026-06', '2026-07', '2026-08', '2026-09'];
    const total = meses.reduce((a, m) => a + h.escopo.dadosDRE(m).compras, 0);
    assertClose(total, 19065.00, 'total comprado');
  });

  it('a diferenca conhecida mercadoria - comprado e R$ 9.134,30 (divida pre-registro)', () => {
    const h = novo(F.producao());
    const r = financeiroRenderizado(h);
    const mercadoria = valorRotulado(r.forn, 'Mercadoria fornecida');
    const meses = ['2026-06', '2026-07', '2026-08', '2026-09'];
    const comprado = meses.reduce((a, m) => a + h.escopo.dadosDRE(m).compras, 0);
    assertClose(mercadoria - comprado, CANONICO.diferencaExplicada,
      'a diferenca explicada da baseline mudou — reveja o BASELINE antes de "consertar"');
  });

  it('venda cancelada nao entra em nenhuma conta (o filtro !cancelada e real)', () => {
    const h = novo(F.producao());
    const antes = valorRotulado(financeiroRenderizado(h).met, 'Custo dos produtos vendidos');
    const v = h.escopo.DB.vendas.find((x) => !x.cancelada);
    v.cancelada = true;
    const depois = valorRotulado(financeiroRenderizado(h).met, 'Custo dos produtos vendidos');
    assertClose(antes - depois, v.custo,
      'ao cancelar uma venda o CMV tem de cair exatamente o custo dela');
  });

  it('as 5 vendas canceladas do fixture ja estao fora do CMV canonico', () => {
    const h = novo(F.producao());
    const canceladas = h.escopo.DB.vendas.filter((x) => x.cancelada);
    assertEqual(canceladas.length, 5, 'contagem de canceladas');
    const somaCanceladas = canceladas.reduce((a, v) => a + v.custo, 0);
    assertMaior(somaCanceladas, 0, 'as canceladas precisam ter custo, senao o teste e vazio');
    const cmv = valorRotulado(financeiroRenderizado(h).met, 'Custo dos produtos vendidos');
    assertClose(cmv, 23539.30, 'CMV com canceladas no banco');
  });
});

// =============================================================================
describe('Custo medio ponderado — confReposicao (regressao do arredondamento)', () => {

  it('8 caixas a 582,50 com estoque zerado -> custoCaixa 582,50 EXATO', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    const p = h.escopo.getProd('TG');
    assertEqual(p.custoCaixa, 582.50, 'custoCaixa tem de ser 582,50 cravado');
    assertEqual(p.custoFrasco, 145.63, 'custoFrasco e 145,625 arredondado para 145,63');
    assertEqual(p.caixas, 8, 'as 8 caixas entraram no estoque');
  });

  it('o custo da caixa NAO e 582,52 (o bug de multiplicar o frasco arredondado)', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    const p = h.escopo.getProd('TG');
    assertFalse(p.custoCaixa === 582.52,
      'voltou o bug: custoCaixa saiu de custoFrasco arredondado x fpc');
    assertClose(p.custoFrasco * p.fpc, 582.52, 'o valor errado seria este', 0.005);
  });

  it('o valor em estoque bate com o dinheiro gasto: 8 x 582,50 = 4.660,00', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    assertClose(h.escopo.valorEstTotal(), 4660.00,
      'o estoque tem de valer exatamente o que foi pago');
    const r = h.escopo.DB.reposicoes[0];
    assertClose(r.custTotal, 4660.00, 'custo total da compra');
  });

  it('a segunda compra pondera com o estoque que ja existia', async () => {
    // 2 caixas a 500,00 (8 frascos a 125,00) + 8 caixas a 582,50 (32 frascos)
    // = 40 frascos por 5.660,00 -> 141,50/frasco e 566,00/caixa
    const h = novo(F.dbMinimo({
      produtos: [F.produtoTG({ caixas: 2, frascos: 0, custoCaixa: 500.00, custoFrasco: 125.00 })],
    }));
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    const p = h.escopo.getProd('TG');
    assertEqual(p.custoFrasco, 141.50, 'custo medio do frasco');
    assertEqual(p.custoCaixa, 566.00, 'custo medio da caixa');
    assertEqual(p.caixas, 10, 'estoque somado');
    assertClose(h.escopo.valorEstTotal(), 5660.00, '1.000,00 + 4.660,00');
  });

  it('o frete entra no custo da mercadoria', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA,
      { repQtd: '8', repCustUnit: '582.50', repFrete: '100' }));
    await h.escopo.confReposicao();
    const p = h.escopo.getProd('TG');
    assertClose(h.escopo.DB.reposicoes[0].custTotal, 4760.00, 'total com frete');
    assertClose(p.custoFrasco, 148.75, '4.760,00 / 32 frascos');
    assertClose(p.custoCaixa, 595.00, '148,75 x 4');
  });

  it('a compra NAO lanca saida no Financeiro (a mercadoria e divida com Victor)', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    assertEqual(h.escopo.DB.saidas.length, 0,
      'a opcao "ja paguei esta compra" foi removida em 15/09: nada de saida automatica');
    assertEqual(h.rede.por('POST', '/saidas').length, 0, 'nenhum POST em saidas');
  });

  it('sem quantidade, custo ou data a compra e bloqueada e o estoque nao muda', async () => {
    const h = novo(F.dbEstoqueZero());
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();
    assertMatch(h.ui.ultimoToast(), /Preencha quantidade, custo e data/, 'mensagem de bloqueio');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'nada foi gravado');
    assertEqual(h.escopo.getProd('TG').caixas, 0, 'estoque intacto');
    assertEqual(h.rede.chamadas.length, 0, 'nao chamou a rede');
  });

  it(
    'custo digitado com virgula ("582,50") deveria valer 582,50',
    async () => {
      const h = novo(F.dbEstoqueZero());
      h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '8', repCustUnit: '582,50' }));
      await h.escopo.confReposicao();
      assertClose(h.escopo.DB.reposicoes[0].custUnit, 582.50,
        'o custo unitario digitado com virgula');
      assertClose(h.escopo.DB.reposicoes[0].custTotal, 4660.00, 'o total da compra');
      assertEqual(h.escopo.getProd('TG').custoCaixa, 582.50, 'o custo medio da caixa');
    }
  );
});

// =============================================================================
describe('Estorno de compra — estornarCompra', () => {

  it('caso limpo (sem venda depois): devolve o estoque E o custo medio', async () => {
    const h = novo(F.dbEstorno('limpo'));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    const p = h.escopo.getProd('TG');
    assertEqual(p.caixas, 2, 'o estoque voltou de 10 para 2 caixas');
    assertEqual(p.custoFrasco, 125.00, 'custo do frasco voltou ao de antes da compra');
    assertEqual(p.custoCaixa, 500.00, 'custo da caixa voltou ao de antes da compra');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'a compra saiu do historico');
    assertClose(h.escopo.valorEstTotal(), 1000.00, 'estoque volta a valer 1.000,00');
    assertMatch(h.ui.ultimoToast(), /Compra estornada/, 'confirmacao ao usuario');
    assertEqual(h.rede.por('DELETE', '/reposicoes').length, 1, 'apagou a reposicao no banco');
  });

  it('o aviso do confirm() avisa que o custo medio vai voltar', async () => {
    const h = novo(F.dbEstorno('limpo'));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    const aviso = h.ui.confirms[0];
    assertInclui(aviso, 'Estornar esta compra?', 'cabecalho do aviso');
    assertInclui(aviso, 'volta de R$ 141.50 para R$ 125.00', 'o aviso mostra o custo novo');
    assertInclui(aviso, 'Estoque volta de 10 para 2', 'o aviso mostra o estoque');
  });

  it('REGRESSAO: com venda depois da compra, o custo NAO e zerado nem recalculado', async () => {
    const h = novo(F.dbEstorno('vendaDepois'));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    const p = h.escopo.getProd('TG');
    // a subtracao ingenua daria (4.669,50 - 4.660,00) / 1 frasco = 9,50 — o bug
    // que zerava o custo do produto e travava a venda seguinte
    assertEqual(p.custoFrasco, 141.50, 'custo do frasco tem de ficar como estava');
    assertEqual(p.custoCaixa, 566.00, 'custo da caixa tem de ficar como estava');
    assertFalse(p.custoFrasco === 9.50, 'voltou o bug do custo subtraido as cegas');
    assertMaior(p.custoFrasco, 0, 'custo zerado trava a venda do produto');
    assertEqual(p.caixas, 0, 'o estoque de caixas foi devolvido (8 - 8)');
    assertEqual(p.frascos, 1, 'os frascos nao sao mexidos numa compra de caixas');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'a compra saiu do historico');
  });

  it('e o aviso explica por que o custo nao pode ser recalculado', async () => {
    const h = novo(F.dbEstorno('vendaDepois'));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    const aviso = h.ui.confirms[0];
    assertInclui(aviso, 'continua R$ 141.50', 'o aviso diz que o custo fica');
    assertInclui(aviso, 'houve 1 venda(s)', 'o aviso conta as vendas posteriores');
  });

  it('venda ANTERIOR a compra nao impede o recalculo', async () => {
    const h = novo(F.dbEstorno('limpo')); // tem uma venda em 15/08, compra em 02/09
    assertEqual(h.escopo.DB.vendas.length, 1, 'o fixture tem de ter a venda anterior');
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    assertEqual(h.escopo.getProd('TG').custoFrasco, 125.00,
      'venda antes da compra nao entra na guarda podeRecalcular');
  });

  it('estoque insuficiente: bloqueia, nao mexe em nada e nem toca a rede', async () => {
    const h = novo(F.dbEstorno('insuficiente'));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    const p = h.escopo.getProd('TG');
    assertMatch(h.ui.ultimoToast(), /Não dá para estornar/, 'mensagem de bloqueio');
    assertInclui(h.ui.ultimoToast(), 'o estoque tem 3 caixa(s) e a compra foi de 8',
      'a mensagem diz os numeros');
    assertEqual(p.caixas, 3, 'estoque intacto');
    assertEqual(p.custoFrasco, 141.50, 'custo intacto');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra continua no historico');
    assertEqual(h.ui.confirms.length, 0, 'nem chegou a perguntar');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma chamada de rede');
  });

  it('se o usuario cancelar o confirm(), nada acontece', async () => {
    const h = novo(F.dbEstorno('limpo'));
    h.confirmar(false);
    await h.escopo.estornarCompra(3000);
    const p = h.escopo.getProd('TG');
    assertEqual(h.ui.confirms.length, 1, 'perguntou');
    assertEqual(p.caixas, 10, 'estoque intacto');
    assertEqual(p.custoFrasco, 141.50, 'custo intacto');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra continua no historico');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma chamada de rede');
  });

  it('compra inexistente: avisa e sai', async () => {
    const h = novo(F.dbEstorno('limpo'));
    await h.escopo.estornarCompra(999999);
    assertMatch(h.ui.ultimoToast(), /Compra não encontrada/, 'mensagem');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'nada removido');
  });

  it('compra de produto que nao existe mais: avisa e sai', async () => {
    const db = F.dbEstorno('limpo');
    db.reposicoes[0].prod = 'PRODUTO_QUE_SUMIU';
    const h = novo(db);
    await h.escopo.estornarCompra(3000);
    assertMatch(h.ui.ultimoToast(), /produto desta compra não existe mais/, 'mensagem');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'nada removido');
  });

  it('saida automatica antiga (id = compra+1, mesmo valor) e apagada junto', async () => {
    // caminho de compatibilidade: compras lancadas antes de 15/09 podiam ter
    // criado uma saida "ja paguei" com id sequencial
    const db = F.dbEstorno('limpo');
    db.saidas = [{
      id: 3001, tipo: 'fornecedor', socio: 'Victor',
      desc: 'Compra de estoque (lancada junto)', data: '2026-09-02',
      val: 4660.00, pgto: 'pix',
    }];
    const h = novo(db);
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    assertInclui(h.ui.confirms[0], 'saída de R$ 4660.00', 'o aviso menciona a saida');
    assertEqual(h.escopo.DB.saidas.length, 0, 'a saida automatica foi apagada');
    assertEqual(h.rede.por('DELETE', '/saidas').length, 1, 'apagou a saida no banco');
  });
});

// =============================================================================
describe('Fechamento por socio x DRE do mesmo mes (item C1)', () => {

  it('o lucro do mes no Fechamento e o mesmo lucro bruto do DRE', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-09');
    const d = h.escopo.dadosDRE('2026-09');
    assertClose(f.lucroTotal, d.lucroBruto,
      'sem taxa de maquininha, lucro das vendas = receita - custo');
    assertClose(d.lucroBruto, d.receita - d.custo, 'identidade do lucro bruto');
    assertEqual(f.vend.length, 15, 'setembro tem 15 vendas ativas no fixture');
  });

  it('custosTotal do Fechamento reage a despesa, imposto e outros', () => {
    const h = novo(F.producao());
    const antes = h.escopo.dadosFechamento('2026-09').custosTotal;
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 990001, tipo: 'despesa', data: '2026-09-22', val: 10.00 }));
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 990002, tipo: 'imposto', data: '2026-09-22', val: 20.00 }));
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 990003, tipo: 'outros', data: '2026-09-22', val: 30.00 }));
    assertClose(h.escopo.dadosFechamento('2026-09').custosTotal, antes + 60.00,
      'as tres entram como custo do mes');
  });

  it('custosTotal NAO inclui pro-labore nem retirada (e o que esta sendo dividido)', () => {
    const h = novo(F.producao());
    const antes = h.escopo.dadosFechamento('2026-09').custosTotal;
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 990004, tipo: 'prolabore', socio: 'Victor', data: '2026-09-22', val: 500.00 }));
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 990005, tipo: 'retirada', socio: 'Stefany', data: '2026-09-22', val: 700.00 }));
    assertClose(h.escopo.dadosFechamento('2026-09').custosTotal, antes,
      'pro-labore e retirada nao podem virar custo');
  });

  it('resultado a dividir = lucro do mes - custosTotal', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-09');
    assertClose(f.resultado, f.lucroTotal - f.custosTotal, 'formula do resultado a dividir');
  });

  it('no DRE, resultado = operacional - pro-labore - retirada', () => {
    const h = novo(F.producao());
    const d = h.escopo.dadosDRE('2026-09');
    assertClose(d.operacional, d.lucroBruto - d.taxas - d.despesa - d.imposto - d.outros,
      'formula do operacional');
    assertClose(d.resultado, d.operacional - d.prolabore - d.retirada, 'formula do resultado');
    assertClose(d.fornecedor, 4356.00, 'o DRE mostra o pagamento de fornecedor em separado');
    assertClose(d.prolabore, 5200.00, 'pro-labore de setembro');
    assertClose(d.retirada, 1200.00, 'retirada de setembro (a "Ambos")');
  });

  it('DOCUMENTADO: o pagamento de fornecedor de setembro existe e vale 4.356,00', () => {
    const h = novo(F.producao());
    const forn = h.escopo.DB.saidas
      .filter((s) => s.tipo === 'fornecedor' && s.data.startsWith('2026-09'))
      .reduce((a, s) => a + s.val, 0);
    assertClose(forn, 4356.00, 'e este o valor que hoje entra em dobro no resultado a dividir');
  });

  it(
    'C1 — o resultado a dividir nao deveria descontar o pagamento de fornecedor',
    () => {
      const h = novo(F.producao());
      const f = h.escopo.dadosFechamento('2026-09');
      const d = h.escopo.dadosDRE('2026-09');
      const fornMes = h.escopo.DB.saidas
        .filter((s) => s.tipo === 'fornecedor' && s.data.startsWith('2026-09'))
        .reduce((a, s) => a + s.val, 0);
      // hoje: custosTotal = fornecedor + despesa + imposto + outros
      //       resultado    = 3.882,70  e  operacional do DRE = 8.238,70
      //       divergencia  = 4.356,00, exatamente o fornecedor do mes
      assertClose(f.resultado, d.operacional,
        'Fechamento e DRE divergem em ' + fornMes.toFixed(2) +
        ' — exatamente o pagamento de fornecedor de setembro');
    }
  );
});

// =============================================================================
describe('Retirada do tipo "Ambos"', () => {

  it('o total retirado pelos dois socios sempre soma a retirada inteira', () => {
    const h = novo(F.dbSplit(60, 40, 1200.00));
    const f = h.escopo.dadosFechamento('2026-09');
    const soma = f.porSocio.reduce((a, x) => a + x.retirado, 0);
    assertClose(soma, 1200.00,
      'nao pode aparecer nem desaparecer dinheiro no rateio da retirada conjunta');
  });

  it('com o split 50/50 (padrao) cada socio fica com metade — hoje e sempre', () => {
    const h = novo(F.dbSplit(50, 50, 1200.00));
    const f = h.escopo.dadosFechamento('2026-09');
    f.porSocio.forEach((x) => {
      assertClose(x.retirado, 600.00, 'retirado de ' + x.nome);
      assertEqual(x.pct, 50, 'porcentagem de ' + x.nome);
    });
  });

  it('o split configurado e lido corretamente para o DIREITO de cada socio', () => {
    const h = novo(F.dbSplit(60, 40, 1200.00));
    const f = h.escopo.dadosFechamento('2026-09');
    const victor = f.porSocio.find((x) => x.nome === 'Victor');
    const stefany = f.porSocio.find((x) => x.nome === 'Stefany');
    assertEqual(victor.pct, 60, 'porcentagem de Victor');
    assertEqual(stefany.pct, 40, 'porcentagem de Stefany');
    assertClose(victor.direito, f.resultado * 0.6, 'direito de Victor');
    assertClose(stefany.direito, f.resultado * 0.4, 'direito de Stefany');
    assertClose(victor.saldo, victor.direito - victor.retirado, 'saldo = direito - retirado');
  });

  it('o rateio da "Ambos" e o MESMO no dadosFechamento e no painel do renderFin', () => {
    // a divisao da retirada conjunta esta escrita em dois lugares (dadosFechamento
    // e o bloco "socioVictor/socioStefany" do renderFin). Se um for corrigido e o
    // outro nao, o app mostra dois numeros diferentes para a mesma retirada.
    // O fixture tem tudo no mesmo mes, senao a comparacao nao seria justa: o
    // renderFin soma TODAS as retiradas, o dadosFechamento so as do mes.
    const h = novo(F.dbSplit(60, 40, 1200.00));
    const f = h.escopo.dadosFechamento('2026-09');
    h.escopo.renderFin();
    f.porSocio.forEach((x) => {
      const painel = h.ui.html('socio' + x.nome);
      const m = painel.match(/Total retirado<\/span><span[^>]*>R\$ (-?[\d]+\.\d{2})/);
      assertTrue(!!m, 'nao achei o total retirado de ' + x.nome + ' no painel');
      assertClose(Number(m[1]), x.retirado,
        'renderFin e dadosFechamento discordam do retirado de ' + x.nome +
        ' — a correcao do rateio "Ambos" entrou em um lugar so');
    });
  });

  it(
    'A retirada "Ambos" deveria seguir o split configurado, nao 50/50 fixo',
    () => {
      const h = novo(F.dbSplit(60, 40, 1200.00));
      const f = h.escopo.dadosFechamento('2026-09');
      const victor = f.porSocio.find((x) => x.nome === 'Victor');
      const stefany = f.porSocio.find((x) => x.nome === 'Stefany');
      assertClose(victor.retirado, 720.00, 'Victor deveria absorver 60% da retirada conjunta');
      assertClose(stefany.retirado, 480.00, 'Stefany deveria absorver 40%');
    }
  );

  it('retirada de um socio so continua inteira no dele', () => {
    const h = novo(F.dbMinimo({
      vendas: [F.vendaSimples({ data: '2026-09-05', usuario: 'Victor' })],
      saidas: [{ id: 970001, tipo: 'retirada', socio: 'Victor', desc: 'Retirada', data: '2026-09-11', val: 300.00, pgto: 'pix' }],
    }));
    const f = h.escopo.dadosFechamento('2026-09');
    assertClose(f.porSocio.find((x) => x.nome === 'Victor').retirado, 300.00, 'Victor');
    assertClose(f.porSocio.find((x) => x.nome === 'Stefany').retirado, 0, 'Stefany');
  });
});

// =============================================================================
describe('Fechamento — o resto da conta por socio', () => {

  it('vendas sem vendedor entram no lucro total mas em ninguem', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-06');
    assertEqual(f.semDono.length, 2, 'junho tem 2 vendas sem usuario no fixture');
    const somaSocios = f.porSocio.reduce((a, x) => a + x.lucro, 0);
    const semDono = f.semDono.reduce((a, v) => a + v.lucroLiq, 0);
    assertClose(somaSocios + semDono, f.lucroTotal,
      'lucro dos socios + lucro sem dono = lucro total do mes');
    assertMaior(semDono, 0, 'senao o teste nao prova nada');
  });

  it('fiado em aberto nao conta como recebido, e conta como a receber', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-07');
    const fiado = f.vend.filter((v) => v.pgto === 'fiado' && !v.quitado);
    assertMaior(fiado.length, 0, 'julho tem fiado em aberto no fixture');
    const somaFiado = fiado.reduce((a, v) => a + v.bruto, 0);
    const fiadoSocios = f.porSocio.reduce((a, x) => a + x.fiado, 0);
    const recebido = f.porSocio.reduce((a, x) => a + x.recebido, 0);
    assertClose(fiadoSocios, somaFiado, 'o "a receber" e o bruto do fiado em aberto');
    f.vend.filter((v) => v.pgto === 'fiado' && !v.quitado).forEach((v) => {
      assertEqual(v.lucroLiq, 0, 'fiado em aberto nasce com lucro 0 (venda ' + v.id + ')');
    });
    assertMaior(f.recebTotal, 0, 'recebido do mes');
    assertTrue(recebido <= f.recebTotal + 0.005, 'recebido por socio nao excede o do mes');
  });

  it('o direito de cada socio e o resultado vezes a porcentagem dele', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-09');
    f.porSocio.forEach((x) => {
      assertClose(x.direito, f.resultado * (x.pct / 100), 'direito de ' + x.nome);
      assertClose(x.saldo, x.direito - x.retirado, 'saldo de ' + x.nome);
    });
  });

  it('mes sem movimento nao quebra e nao inventa numero', () => {
    const h = novo(F.producao());
    const f = h.escopo.dadosFechamento('2026-01');
    assertEqual(f.vend.length, 0, 'nenhuma venda');
    assertEqual(f.said.length, 0, 'nenhuma saida');
    assertClose(f.lucroTotal, 0, 'lucro zero');
    assertClose(f.resultado, 0, 'resultado zero');
    f.porSocio.forEach((x) => assertClose(x.direito, 0, 'direito de ' + x.nome));
  });
});

// =============================================================================
describe('DRE — taxa de maquininha e caixa do mes', () => {

  it('taxa paga por nos sai do liquido e aparece como taxa no DRE', () => {
    const h = novo(F.dbComTaxa());
    const d = h.escopo.dadosDRE('2026-09');
    assertClose(d.receita, 1000.00, 'receita bruta');
    assertClose(d.custo, 582.50, 'custo');
    assertClose(d.taxas, 40.00, 'taxa da maquininha (taxaQuem = nos)');
    assertClose(d.lucroBruto, 417.50, 'receita - custo');
    assertClose(d.operacional, 417.50 - 40.00 - 100.00, 'menos taxa e menos a despesa');
    assertClose(d.recebido, 960.00, 'recebido e o liquido, ja sem a taxa');
    assertClose(d.caixa, 960.00 - 100.00, 'caixa = recebido - saidas');
  });

  it('taxa repassada ao cliente nao reduz o liquido', () => {
    const db = F.dbComTaxa();
    db.vendas[0].taxaQuem = 'cliente';
    db.vendas[0].liq = 1000.00;
    db.vendas[0].lucroLiq = 417.50;
    const h = novo(db);
    const d = h.escopo.dadosDRE('2026-09');
    assertClose(d.taxas, 0, 'taxa do cliente nao entra como custo nosso');
    assertClose(d.recebido, 1000.00, 'recebemos o valor cheio');
  });

  it('mesAnterior e nomeMes viram a virada de ano corretamente', () => {
    const h = novo(F.dbMinimo());
    assertEqual(h.escopo.mesAnterior('2026-01'), '2025-12', 'janeiro volta para dezembro');
    assertEqual(h.escopo.mesAnterior('2026-09'), '2026-08', 'mes comum');
    assertEqual(h.escopo.nomeMes('2026-09'), 'setembro de 2026', 'nome do mes');
  });
});
