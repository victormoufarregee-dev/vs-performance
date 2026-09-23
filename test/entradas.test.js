'use strict';
/* =============================================================================
 * entradas.test.js — Entrada que não é venda: devolução de fornecedor (012)
 * =============================================================================
 *
 *   PROVA — com o JavaScript REAL do index.html:
 *     - a devolução SOMA no caixa esperado (a conta única da conferência e do Financeiro),
 *       só até hoje, e a data futura é contada como futura;
 *     - ela NÃO é receita nem lucro: lucro das vendas, estoque e Conta do Victor ficam iguais;
 *     - painel do mês e relatório por período também somam (não há conta de caixa paralela);
 *     - o app grava só pela RPC vsp_registrar_entrada, com o mesmo op_id no retry, e nunca
 *       por sbPost em saidas; sem conexão, recusa sem chamar nada;
 *     - excluir exige motivo e vai pela RPC vsp_excluir_entrada;
 *     - se a carga das entradas falhar, o card do caixa avisa em vez de calar.
 *
 *   NAO PROVA — o banco: vsp_caixa_esperado_calc com entradas, RLS, grants, idempotência
 *     real. Isso está em test/sql/entradas.test.sql (transação revertida).
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  h.carregarDB(db);
  h.escrever('today', () => '2026-09-23');
  return h;
}

// recebido 1000 · saídas 400 · devolução de 1.700 do Hassan → esperado 2.300,00
function dbComDevolucao() {
  return F.dbMinimo({
    vendas: [F.vendaSimples({ id: 1, pgto: 'pix', bruto: 1000, liq: 1000, data: '2026-09-10' })],
    saidas: [F.saidaSimples({ id: 11, tipo: 'despesa', val: 400, data: '2026-09-10' })],
    entradas: [{ id: 41, tipo: 'devolucao_fornecedor', forn: 'Hassan', desc: 'Diferença da troca de TG', data: '2026-09-23', val: 1700, pgto: 'pix' }],
    ledger: [{ id: 31, data: '2026-09-01', tipo: 'compra_financiada', direcao: 'debito', valor: 4660, descricao: 'x', origemTipo: 'reposicao', origemId: 21, saldoCorrido: 4660 }],
  });
}
const texto = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('Entradas — a devolução de fornecedor entra no caixa e só no caixa', () => {

  it('caixa esperado = recebido + devoluções − saídas = R$ 2.300,00', () => {
    const h = novo(dbComDevolucao());
    const cx = h.escopo.caixaEsperadoPartes();
    assertEqual(cx.centavos, 230000, 'centavos');
    assertClose(cx.entradas, 1700, 'entradas');
    assertClose(cx.recebido, 1000, 'recebido não muda');
    assertClose(cx.saidas, 400, 'saídas não mudam');
  });

  it('sem nenhuma entrada (DB antigo, sem a lista) o caixa é o de antes', () => {
    const db = dbComDevolucao(); delete db.entradas;
    const h = novo(db);
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, 60000, 'recebido − saídas');
  });

  it('devolução com data futura não entra hoje, é contada como futura e entra no dia', () => {
    const db = dbComDevolucao(); db.entradas[0].data = '2026-09-30';
    const h = novo(db);
    const cx = h.escopo.caixaEsperadoPartes();
    assertEqual(cx.centavos, 60000, 'ainda não aconteceu');
    assertEqual(cx.futuros, 1, 'uma futura');
    h.escrever('today', () => '2026-09-30');
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, 230000, 'no dia 30 entrou');
  });

  it('não é lucro nem receita: lucro das vendas, estoque e Conta do Victor não mudam', () => {
    const com = novo(dbComDevolucao());
    const semDb = dbComDevolucao(); semDb.entradas = [];
    const sem = novo(semDb);
    assertClose(com.escopo.saldoVictor(), sem.escopo.saldoVictor(), 'Conta do Victor');
    assertClose(com.escopo.valorEstTotal(), sem.escopo.valorEstTotal(), 'estoque');
    com.escopo.renderFin(); sem.escopo.renderFin();
    const lucro = (h) => (texto(h.ui.html('finMet')).match(/Lucro das vendas (R\$ [\d.,]+)/) || [])[1];
    assertEqual(lucro(com), lucro(sem), 'lucro das vendas');
  });

  it('Financeiro e conferência mostram o mesmo número, com a devolução à parte', () => {
    const h = novo(dbComDevolucao());
    h.escopo.renderFin();
    const met = texto(h.ui.html('finMet'));
    assertInclui(met, 'Devoluções de fornecedor', 'métrica própria');
    // o harness formata R() sem localidade ("R$ 2300.00"); a conferência usa brlCentavos
    assertMatch(met, /Resultado \(caixa\) R\$ 2\.?300[.,]00/, 'resultado com a devolução');
    assertInclui(texto(h.ui.html('confTopo')), 'R$ 2.300,00', 'mesmo número na conferência');
    assertInclui(texto(h.ui.html('entLista')), 'Hassan', 'a lista mostra a entrada');
  });

  it('painel do mês e relatório por período somam a devolução', () => {
    const h = novo(dbComDevolucao());
    h.escopo.renderDash();
    assertMatch(texto(h.ui.html('dashResultado')), /Caixa do mês R\$ 2\.?300[.,]00/, 'caixa do mês');
    h.ui.setValor('rDe', '2026-09-01'); h.ui.setValor('rAte', '2026-09-30'); h.ui.setValor('rPgto', '');
    h.escopo.gerarRel();
    assertMatch(texto(h.ui.html('relMet')), /Resultado \(caixa\) R\$ 2\.?300[.,]00/, 'relatório do mês');
    h.ui.setValor('rDe', '2026-09-01'); h.ui.setValor('rAte', '2026-09-20');
    h.escopo.gerarRel();
    assertMatch(texto(h.ui.html('relMet')), /Resultado \(caixa\) R\$ 600[.,]00/, 'fora do período não entra');
  });

  it('se a carga das entradas falhou, o card do caixa avisa', () => {
    const h = novo(dbComDevolucao());
    h.escopo.DB.entradas = []; h.escopo.DB.entErro = 'HTTP 404';
    h.escopo.renderFin();
    assertInclui(texto(h.ui.html('confTopo')), 'este número está sem elas', 'aviso');
  });
});

describe('Entradas — lançar e excluir pela RPC', () => {

  function preencher(h) {
    h.ui.setValor('eForn', 'Hassan'); h.ui.setValor('eDesc', 'Diferença da troca de TG');
    h.ui.setValor('eData', '2026-09-23'); h.ui.setValor('eVal', '1.700,00'); h.ui.setValor('ePgto', 'pix');
  }

  it('lança pela vsp_registrar_entrada com o payload certo e soma no caixa', async () => {
    const db = dbComDevolucao(); db.entradas = [];
    const h = novo(db);
    preencher(h);
    const rpc = h.espiarRpc((fn, p) => ({ repetida: false, entrada: { id: 77, tipo: 'devolucao_fornecedor', fornecedor: p.p_ent.fornecedor, descricao: p.p_ent.descricao, data: p.p_ent.data, val: p.p_ent.val, pgto: p.p_ent.pgto } }));
    await h.escopo.regEntrada();
    assertEqual(rpc.length, 1, 'uma chamada');
    assertEqual(rpc[0].fn, 'vsp_registrar_entrada', 'RPC certa');
    assertEqual(JSON.stringify(rpc[0].params.p_ent), JSON.stringify({ tipo: 'devolucao_fornecedor', fornecedor: 'Hassan', descricao: 'Diferença da troca de TG', data: '2026-09-23', val: 1700, pgto: 'pix' }), 'payload');
    assertTrue(!!rpc[0].op, 'tem op_id');
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, 230000, 'caixa somou');
  });

  it('falhou: o retry reusa o mesmo op_id; deu certo: o próximo lançamento usa outro', async () => {
    const db = dbComDevolucao(); db.entradas = [];
    const h = novo(db);
    preencher(h);
    const rpc = h.espiarRpc((fn, p, n) => { if (n === 1) throw new Error('timeout'); return { repetida: n === 2, entrada: { id: 77, tipo: 'devolucao_fornecedor', fornecedor: 'Hassan', descricao: 'x', data: '2026-09-23', val: 1700, pgto: 'pix' } }; });
    await h.escopo.regEntrada();
    assertEqual(h.escopo.DB.entradas.length, 0, 'falha não grava local');
    await h.escopo.regEntrada();
    assertEqual(rpc[0].op, rpc[1].op, 'mesmo op_id no retry');
    assertEqual(h.escopo.DB.entradas.length, 1, 'uma entrada, não duas');
    preencher(h);
    await h.escopo.regEntrada();
    assertTrue(rpc[2].op !== rpc[1].op, 'lançamento novo, op_id novo');
    assertEqual(h.escopo.DB.entradas.length, 1, 'mesmo id devolvido não duplica na tela');
  });

  it('sem fornecedor ou sem conexão: recusa e não chama nada', async () => {
    const h = novo(dbComDevolucao());
    const rpc = h.espiarRpc(() => ({}));
    preencher(h); h.ui.setValor('eForn', '');
    await h.escopo.regEntrada();
    preencher(h);
    h.escrever('semConexaoAgora', () => true);
    await h.escopo.regEntrada();
    assertEqual(rpc.length, 0, 'nenhuma RPC');
  });

  it('excluir pede motivo; sem motivo não chama; com motivo vai pela vsp_excluir_entrada', async () => {
    const h = novo(dbComDevolucao());
    const rpc = h.espiarRpc(() => ({ repetida: false }));
    h.ui.respostaPrompt = null;
    await h.escopo.delEntrada(41);
    h.ui.respostaPrompt = '   ';
    await h.escopo.delEntrada(41);
    assertEqual(rpc.length, 0, 'cancelado ou vazio não chama');
    h.ui.respostaPrompt = 'lançada em dobro';
    await h.escopo.delEntrada(41);
    assertEqual(rpc.length, 1, 'uma chamada');
    assertEqual(rpc[0].fn, 'vsp_excluir_entrada', 'RPC certa');
    assertEqual(rpc[0].params.p_id, 41, 'id'); assertEqual(rpc[0].params.p_motivo, 'lançada em dobro', 'motivo');
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, 60000, 'saiu do caixa');
  });
});
