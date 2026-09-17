'use strict';
/* =============================================================================
 * conferencia.test.js — Conferência de Caixa (lado do app)
 * =============================================================================
 *
 *   PROVA — com o JavaScript REAL do index.html:
 *     - a conta do caixa esperado (a mesma do "Resultado (caixa)" do Financeiro) e a
 *       ÚNICA; num fixture inventado ela dá um número que cada fórmula errada provável
 *       (fiado em aberto, venda cancelada, bruto no lugar do líquido, compra de estoque,
 *       dívida do Victor, estoque) NÃO dá — não é um teste que só passa porque os números
 *       reais coincidem;
 *     - diferença = real − esperado, em centavos inteiros (0,01 · 0,10 · 100,01 · negativo);
 *     - leitura de dinheiro em pt-BR sem adivinhar (1.000 é mil, 12,345 é recusado);
 *     - o app manda SÓ saldo real, observação e op_id — nunca esperado, diferença ou autor;
 *     - o op_id é o mesmo no retry; clique duplo não dispara duas chamadas;
 *     - o histórico mostra a FOTO gravada, mesmo depois de o caixa atual mudar;
 *     - registrar não mexe em venda, saída, razão ou no caixa esperado;
 *     - sem conexão, recusa com a mensagem combinada e não usa cópia local.
 *
 *   NAO PROVA — o que o banco faz: cálculo do esperado no servidor, RLS, impersonação,
 *     idempotência real, trigger de imutabilidade. Isso roda em SQL contra o Supabase,
 *     numa transação revertida: test/sql/conferencia_caixa.test.sql e
 *     migrations/APLICADO.md (seção 007).
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

const MSG_OFFLINE = 'A conferência de caixa precisa de conexão para comparar com o saldo atual do sistema.';

function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  h.carregarDB(db);
  return h;
}

/**
 * Fixture onde a conta CERTA e as erradas divergem:
 *   recebido certo  = 1000,00 (pix) + 300,00 (fiado quitado) + 95,37 (crédito, líquido da taxa)
 *   saídas          = 400,00 (reembolso fornecedor) + 200,01 (retirada) + 99,99 (despesa)
 *   esperado certo  = 1395,37 − 700,00 = 695,37
 * Armadilhas: fiado em aberto (500), venda cancelada (700), bruto ≠ líquido (100 × 95,37),
 * compra de estoque (5.000), razão do Victor (3.000), estoque (8 caixas).
 */
function dbDivergente() {
  return F.dbMinimo({
    vendas: [
      F.vendaSimples({ id: 1, pgto: 'pix', bruto: 1000, liq: 1000 }),
      F.vendaSimples({ id: 2, pgto: 'fiado', quitado: true, bruto: 300, liq: 300 }),
      F.vendaSimples({ id: 3, pgto: 'fiado', quitado: false, bruto: 500, liq: 500 }),
      F.vendaSimples({ id: 4, pgto: 'pix', cancelada: true, bruto: 700, liq: 700 }),
      F.vendaSimples({ id: 5, pgto: 'credito', taxa: 4.63, taxaVal: 4.63, bruto: 100, liq: 95.37 }),
    ],
    saidas: [
      F.saidaSimples({ id: 11, tipo: 'fornecedor', socio: 'Victor', val: 400 }),
      F.saidaSimples({ id: 12, tipo: 'retirada', socio: 'Stefany', val: 200.01 }),
      F.saidaSimples({ id: 13, tipo: 'despesa', val: 99.99 }),
    ],
    reposicoes: [{ id: 21, prod: 'TG', tipo: 'caixa', qtd: 8, custUnit: 625, frete: 0, custTotal: 5000, forn: 'Hassan', data: '2026-09-01', obs: '', lote: '', validade: '', notaLote: '' }],
    ledger: [{ id: 31, data: '2026-09-01', tipo: 'compra_financiada', direcao: 'debito', valor: 3000, descricao: 'x', origemTipo: 'reposicao', origemId: 21, saldoCorrido: 3000 }],
  });
}

function conf(over) {
  return Object.assign({
    id: 901, conferido_em: '2026-09-17T15:00:00Z', escopo: 'consolidado',
    saldo_esperado: 1000, saldo_real: 950, diferenca: -50, observacao: '', situacao: 'valida',
    invalidada_em: null, invalidada_por: null, motivo_invalidacao: null,
    op_id: 'op-901', created_at: '2026-09-17T15:00:00Z', created_by: 'Victor',
  }, over || {});
}

function semRede() { return Object.assign(new Error('sem internet no momento'), { semRede: true }); }

/** Abre o modal com o servidor respondendo `esperado` e digita `real`. */
async function abrirEDigitar(h, esperado, real) {
  const rpc = h.espiarRpc((fn, p) => (fn === 'vsp_caixa_esperado' ? esperado : null));
  await h.escopo.abrirConferenciaCaixa();
  h.ui.setValor('confReal', real);
  h.escopo.previaConferenciaCaixa();
  return rpc;
}
const texto = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// =============================================================================
describe('Conferência de caixa — de onde vem o caixa esperado', () => {

  it('esperado = recebido líquido (fiado só quitado) − todas as saídas = R$ 695,37', () => {
    const h = novo(dbDivergente());
    const cx = h.escopo.caixaEsperadoPartes();
    assertEqual(cx.centavos, 69537, 'centavos');
    assertClose(cx.recebido, 1395.37, 'recebido');
    assertClose(cx.saidas, 700.00, 'saídas');
  });

  it('cada fórmula errada provável dá OUTRO número neste fixture', () => {
    const h = novo(dbDivergente());
    const certo = h.escopo.caixaEsperadoPartes().centavos;
    const db = h.escopo.DB;
    const c = (x) => Math.round(x * 100);
    const soma = (l, f) => l.reduce((a, x) => a + (+f(x) || 0), 0);
    const ativas = db.vendas.filter((v) => !v.cancelada);
    const recebidas = ativas.filter((v) => v.pgto !== 'fiado' || v.quitado);
    const saidas = soma(db.saidas, (s) => s.val);
    // cada fórmula errada provável, calculada de verdade sobre o mesmo DB
    const erradas = {
      'conta fiado em aberto': c(soma(ativas, (v) => v.liq) - saidas),
      'conta venda cancelada': c(soma(db.vendas.filter((v) => v.pgto !== 'fiado' || v.quitado), (v) => v.liq) - saidas),
      'usa bruto em vez de líquido': c(soma(recebidas, (v) => v.bruto) - saidas),
      'desconta compra de estoque': c(soma(recebidas, (v) => v.liq) - saidas - soma(db.reposicoes, (r) => r.custTotal)),
      'desconta a dívida com o Victor': c(soma(recebidas, (v) => v.liq) - saidas - h.escopo.saldoVictor()),
      'soma o valor do estoque': c(soma(recebidas, (v) => v.liq) - saidas + h.escopo.valorEstTotal()),
      'ignora reembolso ao fornecedor': c(soma(recebidas, (v) => v.liq) - soma(db.saidas.filter((s) => s.tipo !== 'fornecedor'), (s) => s.val)),
      'so despesas, sem retirada': c(soma(recebidas, (v) => v.liq) - soma(db.saidas.filter((s) => s.tipo !== 'retirada' && s.tipo !== 'prolabore'), (s) => s.val)),
      'diferença invertida (esperado usado como real)': -certo,
    };
    Object.keys(erradas).forEach((k) => assertTrue(erradas[k] !== certo, k + ' coincidiria — o fixture não protegeria'));
    assertEqual(certo, 69537, 'e o app dá o certo');
  });

  it('o Financeiro mostra exatamente o mesmo número (uma conta só)', () => {
    const h = novo(dbDivergente());
    h.escopo.renderFin();
    assertInclui(h.ui.html('finMet'), 'R$ 695.37', 'Resultado (caixa) do Financeiro');
    assertInclui(texto(h.ui.html('confTopo')), 'Caixa esperado agora R$ 695,37', 'card da conferência');
  });

  it('com os dados de 15/09: esperado negativo, −R$ 3,49, aceito e explicado', () => {
    const h = novo(F.producao());
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, -349, 'centavos');
    h.escopo.renderFin();
    assertInclui(texto(h.ui.html('confTopo')), '−R$ 3,49', 'sinal de menos e vírgula');
  });

  it('não depende de estoque, compra ou razão: mexer neles não muda o esperado', () => {
    const h = novo(dbDivergente());
    const antes = h.escopo.caixaEsperadoPartes().centavos;
    h.escopo.getProd('TG').caixas += 50;
    h.escopo.DB.reposicoes.push({ id: 22, prod: 'TG', tipo: 'caixa', qtd: 1, custTotal: 999, data: '2026-09-02' });
    h.escopo.DB.ledger.push({ id: 32, tipo: 'reembolso', direcao: 'credito', valor: 1000, data: '2026-09-02' });
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, antes, 'igual');
  });
});

// =============================================================================
describe('Conferência de caixa — dinheiro em centavos, pt-BR', () => {

  it('lê valores digitados sem adivinhar', () => {
    const h = novo(dbDivergente());
    const casos = [
      ['1000', 100000], ['1.000', 100000], ['1.000,50', 100050], ['1000,5', 100050],
      ['950', 95000], ['100,01', 10001], ['100.01', 10001], ['0,01', 1], ['0,10', 10], ['0,1', 10],
      ['R$ 1.250,00', 125000], ['-50,00', -5000], ['−50,00', -5000], ['1.234.567,89', 123456789],
      ['0', 0], ['12,345', null], ['1,2,3', null], ['abc', null], ['', null], ['1.00.0', null], ['10.5.3', null],
    ];
    casos.forEach(([t, esp]) => assertEqual(h.escopo.dinheiroParaCentavos(t), esp, JSON.stringify(t)));
  });

  it('formata em pt-BR com sinal explícito', () => {
    const h = novo(dbDivergente());
    const b = h.escopo.brlCentavos;
    assertEqual(b(0), 'R$ 0,00', 'zero');
    assertEqual(b(1), 'R$ 0,01', 'um centavo');
    assertEqual(b(-5000), '−R$ 50,00', 'negativo');
    assertEqual(b(5000, true), '+R$ 50,00', 'positivo com sinal');
    assertEqual(b(0, true), 'R$ 0,00', 'zero sem sinal');
    assertEqual(b(123456789), 'R$ 1.234.567,89', 'milhar');
    assertEqual(h.escopo.centavosTexto(-1), '-0.01', 'texto para o banco');
    assertEqual(h.escopo.centavosTexto(10001), '100.01', 'texto para o banco');
  });

  it('prévia: diferença = real − esperado (igual, falta, sobra, centavo, negativo)', async () => {
    const casos = [
      [1000, '1000', 'R$ 0,00', /exatamente o que o sistema esperava/],
      [1000, '950', '−R$ 50,00', /R\$ 50,00 a MENOS/],
      [1000, '1050', '+R$ 50,00', /R\$ 50,00 a MAIS/],
      [100.01, '100,00', '−R$ 0,01', /R\$ 0,01 a MENOS/],
      [100, '100,10', '+R$ 0,10', /R\$ 0,10 a MAIS/],
      [-3.49, '0', '+R$ 3,49', /R\$ 3,49 a MAIS/],
      [0.1, '0,3', '+R$ 0,20', /R\$ 0,20 a MAIS/],   // 0.3 − 0.1 em ponto flutuante = 0.19999…
      // em ponto flutuante 19.99*100 = 1998.9999…, 0.29*100 = 28.9999…: quem trunca perde o centavo
      [19.99, '19,99', 'R$ 0,00', /exatamente o que o sistema esperava/],
      [0.29, '0,30', '+R$ 0,01', /R\$ 0,01 a MAIS/],
      [1.15, '1,15', 'R$ 0,00', /exatamente/],
      [4.35, '4,34', '−R$ 0,01', /R\$ 0,01 a MENOS/],
    ];
    for (const [esperado, real, dif, frase] of casos) {
      const h = novo(dbDivergente());
      await abrirEDigitar(h, esperado, real);
      const p = texto(h.ui.html('confPrevia'));
      assertInclui(p, 'Diferença ' + dif, esperado + ' vs ' + real);
      assertMatch(p, frase, 'explicação ' + esperado + ' vs ' + real);
    }
  });
});

// =============================================================================
describe('Conferência de caixa — o que o app manda para o banco', () => {

  it('só saldo real, observação e op_id: nunca esperado, diferença ou autor', async () => {
    const h = novo(dbDivergente());
    const rpc = h.espiarRpc((fn, p) => (fn === 'vsp_caixa_esperado' ? 1000 : { repetida: false, conferencia: conf() }));
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    h.ui.setValor('confObs', 'Nubank + gaveta');
    await h.escopo.confirmarConferenciaCaixa();
    const c = rpc.por('vsp_registrar_conferencia_caixa');
    assertEqual(c.length, 1, 'uma chamada');
    assertEqual(Object.keys(c[0].params).sort().join(','), 'p_observacao,p_op_id,p_saldo_real', 'só estes parâmetros');
    assertEqual(c[0].params.p_saldo_real, '950.00', 'valor em texto decimal exato');
    assertEqual(c[0].params.p_observacao, 'Nubank + gaveta', 'observação');
    assertTrue(!!c[0].params.p_op_id, 'op_id');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma gravação tabela por tabela');
  });

  it('adota a foto do servidor, e avisa se o esperado mudou enquanto conferia', async () => {
    const h = novo(dbDivergente());
    h.espiarRpc((fn) => (fn === 'vsp_caixa_esperado' ? 999 : {
      repetida: false, conferencia: conf({ saldo_esperado: 1000, saldo_real: 950, diferenca: -50 }),
    }));
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    await h.escopo.confirmarConferenciaCaixa();
    const c = h.escopo.DB.conferencias[0];
    assertEqual(c.saldoEsperado, 100000, 'esperado do servidor, não o da prévia');
    assertEqual(c.diferenca, -5000, 'diferença do servidor');
    assertMatch(h.ui.ultimoToast(), /mudou para R\$ 1\.000,00/, 'avisou a mudança');
    assertMatch(h.ui.ultimoToast(), /Nada foi corrigido automaticamente/, 'deixa claro que não corrigiu');
  });

  it('retry usa o MESMO op_id; a conferência seguinte ganha outro', async () => {
    const h = novo(dbDivergente());
    let n = 0;
    const rpc = h.espiarRpc((fn) => {
      if (fn === 'vsp_caixa_esperado') return 1000;
      n++;
      if (n === 1) throw semRede();
      return { repetida: n === 2, conferencia: conf({ id: 900 + n }) };
    });
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    await h.escopo.confirmarConferenciaCaixa();
    assertInclui(h.ui.ultimoToast(), MSG_OFFLINE, 'mensagem de conexão');
    assertEqual((h.escopo.DB.conferencias || []).length, 0, 'nada registrado no aparelho');
    await h.escopo.confirmarConferenciaCaixa();
    const ops = rpc.por('vsp_registrar_conferencia_caixa').map((c) => c.op);
    assertEqual(ops[0], ops[1], 'mesmo op_id');
    assertMatch(h.ui.ultimoToast(), /já estava registrada — não gravei outra/, 'avisa que era repetida');
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    await h.escopo.confirmarConferenciaCaixa();
    const ops2 = rpc.por('vsp_registrar_conferencia_caixa').map((c) => c.op);
    assertTrue(ops2[2] !== ops2[0], 'nova conferência, novo op_id');
  });

  it('clique duplo: uma chamada', async () => {
    const h = novo(dbDivergente());
    let libera;
    const rpc = h.espiarRpc((fn) => (fn === 'vsp_caixa_esperado' ? 1000
      : new Promise((ok) => { libera = () => ok({ repetida: false, conferencia: conf() }); })));
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    const p1 = h.escopo.confirmarConferenciaCaixa();
    const p2 = h.escopo.confirmarConferenciaCaixa();
    await p2;
    libera();
    await p1;
    assertEqual(rpc.por('vsp_registrar_conferencia_caixa').length, 1, 'uma chamada');
    assertEqual((h.escopo.DB.conferencias || []).length, 1, 'uma conferência');
  });

  it('recusa do servidor (ex.: sem autorização) não registra nada', async () => {
    const h = novo(dbDivergente());
    h.espiarRpc((fn) => { if (fn === 'vsp_caixa_esperado') return 1000; throw new Error('nao autorizado'); });
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual((h.escopo.DB.conferencias || []).length, 0, 'nada');
    assertMatch(h.ui.ultimoToast(), /Não consegui registrar a conferência: nao autorizado/, 'motivo');
  });

  it('valor inválido não chama o banco', async () => {
    const h = novo(dbDivergente());
    const rpc = await abrirEDigitar(h, 1000, '12,345');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual(rpc.por('vsp_registrar_conferencia_caixa').length, 0, 'nenhuma chamada');
    assertMatch(texto(h.ui.html('confPrevia')), /Não entendi o valor/, 'prévia avisa');
  });
});

// =============================================================================
describe('Conferência de caixa — verificação, não correção', () => {

  it('registrar não altera venda, saída, razão, estoque nem o caixa esperado', async () => {
    const h = novo(dbDivergente());
    const antes = {
      caixa: h.escopo.caixaEsperadoPartes().centavos,
      vendas: JSON.stringify(h.escopo.DB.vendas), saidas: JSON.stringify(h.escopo.DB.saidas),
      ledger: JSON.stringify(h.escopo.DB.ledger), estoque: JSON.stringify(h.estoqueAgora()),
      victor: h.escopo.saldoVictor(),
    };
    h.espiarRpc((fn) => (fn === 'vsp_caixa_esperado' ? 695.37
      : { repetida: false, conferencia: conf({ saldo_esperado: 695.37, saldo_real: 600, diferenca: -95.37 }) }));
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '600');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual(h.escopo.caixaEsperadoPartes().centavos, antes.caixa, 'caixa esperado igual');
    assertEqual(JSON.stringify(h.escopo.DB.vendas), antes.vendas, 'vendas iguais');
    assertEqual(JSON.stringify(h.escopo.DB.saidas), antes.saidas, 'nenhuma saída de ajuste');
    assertEqual(JSON.stringify(h.escopo.DB.ledger), antes.ledger, 'razão igual');
    assertEqual(JSON.stringify(h.estoqueAgora()), antes.estoque, 'estoque igual');
    assertEqual(h.escopo.saldoVictor(), antes.victor, 'Conta do Victor igual');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma gravação fora da RPC');
    assertEqual((h.escopo.DB.conferencias || []).length, 1, 'só a conferência entrou');
  });

  it('o histórico mostra a FOTO: o caixa de hoje muda, a conferência de ontem não', () => {
    const h = novo(dbDivergente());
    h.escopo.DB.conferencias = [h.escopo.mapConferencia(conf({
      saldo_esperado: 695.37, saldo_real: 700, diferenca: 4.63, conferido_em: '2026-09-16T15:00:00Z',
    }))];
    h.escopo.renderConferenciaCaixa();
    const antes = texto(h.ui.html('confBody'));
    // alguém lança hoje uma saída antiga de R$ 100,00
    h.escopo.DB.saidas.push(F.saidaSimples({ id: 14, val: 100, data: '2026-09-10' }));
    h.escopo.renderConferenciaCaixa();
    const topo = texto(h.ui.html('confTopo'));
    const depois = texto(h.ui.html('confBody'));
    assertInclui(topo, 'Caixa esperado agora R$ 595,37', 'o esperado de agora mudou');
    assertEqual(depois, antes, 'a linha histórica não mudou');
    assertInclui(depois, 'R$ 695,37', 'esperado da foto');
    assertInclui(depois, '+R$ 4,63', 'diferença da foto');
    assertInclui(topo, 'Diferença +R$ 4,63', 'última conferência também é a foto');
  });

  it('histórico não esconde divergência nem invalidada; filtra por período', () => {
    const h = novo(dbDivergente());
    h.escopo.DB.conferencias = [
      conf({ id: 3, conferido_em: '2026-09-17T13:00:00Z', saldo_real: 1000, diferenca: 0, op_id: 'c' }),
      conf({ id: 2, conferido_em: '2026-09-10T13:00:00Z', situacao: 'invalidada', invalidada_em: '2026-09-10T14:00:00Z', invalidada_por: 'Stefany', motivo_invalidacao: 'digitei errado', op_id: 'b' }),
      conf({ id: 1, conferido_em: '2026-09-01T13:00:00Z', saldo_real: 900, diferenca: -100, op_id: 'a' }),
    ].map(h.escopo.mapConferencia);
    h.escopo.renderConferenciaCaixa();
    const tudo = texto(h.ui.html('confBody'));
    assertInclui(tudo, '−R$ 100,00', 'divergência aparece');
    assertInclui(tudo, 'Invalidada', 'invalidada aparece');
    assertInclui(tudo, 'digitei errado', 'motivo aparece');
    assertInclui(tudo, 'Stefany', 'quem invalidou');
    assertEqual((h.ui.html('confCards').match(/vic-mov/g) || []).length, 3, 'cards do celular: 3');
    assertInclui(texto(h.ui.html('confTopo')), 'Confere', 'última VÁLIDA é a de 17/09, que confere');
    h.ui.setValor('confDe', '2026-09-05');
    h.ui.setValor('confAte', '2026-09-12');
    h.escopo.renderConferenciaCaixa();
    const filtrado = texto(h.ui.html('confBody'));
    assertInclui(filtrado, 'digitei errado', 'a de 10/09 fica');
    assertNaoInclui(filtrado, '−R$ 100,00', 'a de 01/09 sai');
  });

  it('invalidar pede motivo, preserva a linha e não apaga nada', async () => {
    const h = novo(dbDivergente());
    h.escopo.DB.conferencias = [h.escopo.mapConferencia(conf())];
    const rpc = h.espiarRpc((fn, p) => ({ repetida: false, conferencia: conf({
      situacao: 'invalidada', invalidada_em: '2026-09-17T16:00:00Z', invalidada_por: 'Victor', motivo_invalidacao: p.p_motivo }) }));
    h.ui.respostaPrompt = '';
    await h.escopo.invalidarConferenciaCaixa(901);
    assertEqual(rpc.length, 0, 'sem motivo, não chama');
    h.ui.respostaPrompt = 'contei a gaveta duas vezes';
    await h.escopo.invalidarConferenciaCaixa(901);
    assertEqual(rpc.length, 1, 'chamou');
    assertEqual(Object.keys(rpc[0].params).sort().join(','), 'p_id,p_motivo', 'só id e motivo');
    const c = h.escopo.DB.conferencias;
    assertEqual(c.length, 1, 'a linha continua');
    assertEqual(c[0].situacao, 'invalidada', 'marcada');
    assertEqual(c[0].saldoReal, 95000, 'números originais');
    // a foto vinda do banco também não pode perder centavo na conversão
    const f = h.escopo.mapConferencia(conf({ saldo_esperado: 19.99, saldo_real: 4.35, diferenca: -15.64 }));
    assertEqual(f.saldoEsperado, 1999, '19,99');
    assertEqual(f.saldoReal, 435, '4,35');
    assertEqual(f.diferenca, -1564, '-15,64');
  });
});

// =============================================================================
describe('Conferência de caixa — sem conexão', () => {

  it('offline: recusa com a mensagem combinada, sem chamar o banco nem abrir o modal', async () => {
    const h = novo(dbDivergente());
    const rpc = h.espiarRpc(() => 1000);
    h.ctx.navigator.onLine = false;
    await h.escopo.abrirConferenciaCaixa();
    assertEqual(h.ui.ultimoToast(), MSG_OFFLINE, 'mensagem exata');
    assertEqual(rpc.length, 0, 'nenhuma chamada');
    assertTrue(h.ui.elementos.get('confModal') === undefined || h.ui.elementos.get('confModal').style.display !== 'flex', 'modal fechado');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual(rpc.length, 0, 'confirmar offline também não chama');
    assertEqual((h.escopo.DB.conferencias || []).length, 0, 'nada registrado');
  });

  it('rede cai ao consultar o esperado: fecha, avisa e NÃO usa o caixa da cópia local', async () => {
    const h = novo(dbDivergente());
    const rpc = h.espiarRpc(() => { throw semRede(); });
    await h.escopo.abrirConferenciaCaixa();
    assertInclui(h.ui.ultimoToast(), MSG_OFFLINE, 'mensagem');
    assertEqual(h.ui.elementos.get('confModal').style.display, 'none', 'modal fechado');
    assertNull(h.escopo.CONF.esperado, 'nenhum esperado local foi assumido');
    h.ui.setValor('confReal', '695,37');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual(rpc.por('vsp_registrar_conferencia_caixa').length, 0, 'não tentou registrar');
    assertEqual((h.escopo.DB.conferencias || []).length, 0, 'nada registrado');
  });

  it('não usa a fila offline', async () => {
    const h = novo(dbDivergente());
    h.espiarRpc((fn) => { if (fn === 'vsp_caixa_esperado') return 1000; throw semRede(); });
    await h.escopo.abrirConferenciaCaixa();
    h.ui.setValor('confReal', '950');
    await h.escopo.confirmarConferenciaCaixa();
    assertEqual((h.escopo.fila || []).length, 0, 'nada na fila');
    assertInclui(h.ui.ultimoToast(), 'Nada foi registrado neste aparelho', 'diz que não guardou');
  });

  it('carga das conferências falhando não trava o resto do app', () => {
    const h = novo(dbDivergente());
    h.escopo.DB.conferencias = null;
    h.escopo.DB.confErro = 'Leitura de conferencias_caixa (HTTP 404)';
    h.escopo.renderFin();
    assertInclui(h.ui.html('confTopo'), 'Não consegui carregar as conferências', 'card avisa');
    assertInclui(h.ui.html('finMet'), 'R$ 695.37', 'o Financeiro segue');
  });
});
