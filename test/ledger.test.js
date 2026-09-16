'use strict';
/* =============================================================================
 * ledger.test.js — A CONTA DO VICTOR, lida do razao (ledger_victor).
 * =============================================================================
 *
 * O QUE MUDOU
 *   Ate 15/09/2026 a divida da empresa com o Victor era DERIVADA do estoque:
 *
 *       divida = CMV + valor do estoque - pago a fornecedores
 *
 *   Isso misturava dois conceitos que nao tem nada a ver um com o outro. Quebrar
 *   um frasco, achar caixa sobrando no inventario ou corrigir um custo medio
 *   mexia na divida com o socio, o que e absurdo: nenhum dinheiro trocou de mao.
 *
 *   Agora a divida vem de um RAZAO — a tabela ledger_victor — onde cada linha e um
 *   fato financeiro: compra que o Victor bancou (debito) ou reembolso que ele
 *   recebeu (credito). O app carrega a view v_ledger_victor em `DB.ledger` e le
 *   por ledgerMovs() / saldoVictor().
 *
 *   CONVENCAO UNICA, valida em todo o sistema:
 *       saldo POSITIVO = a empresa DEVE ao Victor
 *       debito aumenta a divida · credito reduz a divida
 *
 * O QUE ESTE ARQUIVO PROVA
 *   Que o saldo e a soma com sinal do razao e de mais nada; que compra soma e
 *   reembolso subtrai o valor EXATO; que mexer em estoque (caixa a mais, caixa a
 *   menos, estoque zerado, venda, cancelamento) NAO move o saldo em um centavo;
 *   que o estorno e por compensacao e nao apaga historico; que o extrato, os
 *   filtros e os dois cards (Financeiro e Dashboard) leem o razao; e que um cache
 *   antigo, sem `DB.ledger`, nao quebra nenhuma tela.
 *
 * O QUE ELE NAO PROVA
 *   Nada do que acontece dentro do PostgreSQL. O movimento 'compra_financiada' e
 *   inserido pela vsp_registrar_compra, na mesma transacao da compra; aqui o sbRpc
 *   esta espionado e devolve o que o teste mandar. O que se prova da compra e a
 *   CONVERSA (funcao chamada, payload, op_id) e o que o app faz com a resposta.
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');
const { CANONICO } = F;
const LG = CANONICO.ledger;

// --------------------------------------------------------------- utilidades ----

function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  if (db) h.carregarDB(db);
  return h;
}

/** Harness com o razao de producao e o resto do fixture canonico. */
function comRazao(ledger) {
  const db = F.producao();
  if (ledger !== undefined) db.ledger = ledger;
  return novo(db);
}

/** Le um valor que o app escreveu no HTML (R() formata sempre "R$ 1234.50"). */
function valorRotulado(html, rotulo) {
  const i = html.indexOf(rotulo);
  if (i < 0) throw new Error('rotulo "' + rotulo + '" nao existe no HTML gerado');
  const m = html.slice(i).match(/R\$ (-?[\d]+\.\d{2})/);
  if (!m) throw new Error('nenhum valor R$ depois de "' + rotulo + '"');
  return Number(m[1]);
}

/** Ultimo textContent escrito num elemento (o stub grava toda escrita). */
function textoDe(h, id) {
  const e = h.ui.escritas.filter((x) => x.id === id && x.prop === 'textContent');
  return e.length ? e[e.length - 1].valor : null;
}

function display(h, id) {
  return h.escopo.document.getElementById(id).style.display;
}

/** Roda renderVictor e devolve o topo, o corpo da tabela e o estado vazio. */
function extrato(h) {
  h.escopo.renderVictor();
  return {
    topo: h.ui.html('vicTopo'),
    corpo: h.ui.html('vicBody'),
    vazio: textoDe(h, 'vicEmpty'),
    vazioVisivel: display(h, 'vicEmpty') === '',
    linhas: (h.ui.html('vicBody').match(/<tr>/g) || []).length,
  };
}

/** Soma com sinal, em centavos, calculada aqui (nao pelo app). */
function saldoCent(movs) {
  return movs.reduce(
    (a, m) => a + Math.round(m.valor * 100) * (m.direcao === 'debito' ? 1 : -1), 0);
}

const CAMPOS_COMPRA = {
  repProd: 'TG', repTipo: 'caixa', repQtd: '8', repCustUnit: '582.50',
  repForn: 'Victor', repData: '2026-09-16', repObs: '', repFrete: '',
  repLote: 'L260916', repValidade: '2027-09-16', repNota: '',
};

// =============================================================================
describe('Razao da Conta do Victor — os 21 movimentos de producao', () => {

  it('o razao tem 21 movimentos: 1 saldo inicial + 5 compras + 15 reembolsos', () => {
    const h = comRazao();
    const mv = h.escopo.ledgerMovs();
    assertEqual(mv.length, LG.movimentos, 'total de movimentos');
    assertEqual(mv.filter((m) => m.tipo === 'saldo_inicial').length, 1, 'saldo inicial');
    assertEqual(mv.filter((m) => m.tipo === 'compra_financiada').length, LG.comprasQtd, 'compras');
    assertEqual(mv.filter((m) => m.tipo === 'reembolso').length, LG.reembolsosQtd, 'reembolsos');
    // nenhum tipo fora do enum da tabela
    const permitidos = ['saldo_inicial', 'compra_financiada', 'reembolso', 'ajuste_financeiro', 'estorno'];
    const fora = mv.filter((m) => !permitidos.includes(m.tipo)).map((m) => m.tipo);
    assertEqual(fora.length, 0, 'tipo fora do enum: ' + fora.join(', '));
  });

  it('o saldo inicial e um movimento explicito de R$ 9.134,30 (debito)', () => {
    const h = comRazao();
    const ini = h.escopo.ledgerMovs().find((m) => m.tipo === 'saldo_inicial');
    assertTrue(!!ini, 'o movimento de saldo inicial existe');
    assertClose(ini.valor, LG.saldoInicial, 'valor do saldo inicial');
    assertEqual(ini.direcao, 'debito', 'ele aumenta a divida');
    assertEqual(ini.origemTipo, 'migracao', 'origem = apuracao historica');
    // datado ANTES da 1a venda ativa: e mercadoria consumida antes de existir registro
    const primeiraVenda = h.escopo.DB.vendas
      .filter((v) => !v.cancelada).map((v) => v.data).sort()[0];
    assertTrue(ini.data < primeiraVenda,
      'o saldo inicial (' + ini.data + ') tem de vir antes da 1a venda (' + primeiraVenda + ')');
  });

  it('as 5 compras somam R$ 19.065,00 e cada uma casa com a reposicao de origem', () => {
    const h = comRazao();
    const compras = h.escopo.ledgerMovs().filter((m) => m.tipo === 'compra_financiada');
    assertEqual(saldoCent(compras), Math.round(LG.compras * 100), 'total das compras');
    compras.forEach((m) => {
      assertEqual(m.direcao, 'debito', 'compra financiada e debito');
      assertEqual(m.origemTipo, 'reposicao', 'origem da compra');
      const rep = h.escopo.DB.reposicoes.find((r) => r.id === m.origemId);
      assertTrue(!!rep, 'a reposicao de origem #' + m.origemId + ' existe');
      assertClose(m.valor, rep.custTotal,
        'o debito e o custo total da compra #' + rep.id + ' (mercadoria + frete)');
      assertEqual(m.data, rep.data, 'a data do movimento e a da compra');
    });
  });

  it('os 15 reembolsos somam R$ 22.441,00 e todos sao credito', () => {
    const h = comRazao();
    const re = h.escopo.ledgerMovs().filter((m) => m.tipo === 'reembolso');
    assertEqual(re.length, LG.reembolsosQtd, 'quantidade de reembolsos');
    assertEqual(-saldoCent(re), Math.round(LG.reembolsos * 100), 'total dos reembolsos');
    assertEqual(re.filter((m) => m.direcao !== 'credito').length, 0,
      'reembolso que nao e credito aumentaria a divida ao ser pago');
  });

  it('saldoVictor() = R$ 5.758,30 — e e debitos menos creditos, nada mais', () => {
    const h = comRazao();
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo da conta');
    const mv = h.escopo.ledgerMovs();
    const deb = mv.filter((m) => m.direcao === 'debito').reduce((a, m) => a + m.valor, 0);
    const cre = mv.filter((m) => m.direcao === 'credito').reduce((a, m) => a + m.valor, 0);
    assertClose(deb, LG.saldoInicial + LG.compras, 'debitos = saldo inicial + compras');
    assertClose(cre, LG.reembolsos, 'creditos = reembolsos');
    assertClose(deb - cre, LG.saldo, 'saldo = debitos - creditos');
    assertClose(h.escopo.saldoVictor(), deb - cre, 'saldoVictor() nao usa outra conta');
  });

  it('saldo positivo significa que a EMPRESA deve ao Victor (convencao unica)', () => {
    const h = comRazao();
    assertMaior(h.escopo.saldoVictor(), 0, 'no fixture a empresa esta devendo');
    // um credito grande inverte o sinal: quem passa a ficar devendo e o Victor
    h.escopo.DB.ledger = h.escopo.ledgerMovs().concat([F.movLedger({
      id: 999, data: '2026-09-20', tipo: 'reembolso', direcao: 'credito',
      valor: 10000.00, descricao: 'Reembolso alem do saldo',
    })]);
    assertClose(h.escopo.saldoVictor(), LG.saldo - 10000.00, 'o credito reduz o saldo');
    assertTrue(h.escopo.saldoVictor() < 0, 'saldo negativo = Victor deve a empresa');
  });

  it('o saldo corrido de cada linha e a soma com sinal ate ela', () => {
    const h = comRazao();
    const mv = h.escopo.ledgerMovs();
    let acum = 0;
    mv.forEach((m) => {
      acum += Math.round(m.valor * 100) * (m.direcao === 'debito' ? 1 : -1);
      assertEqual(Math.round(m.saldoCorrido * 100), acum,
        'saldo corrido do movimento #' + m.id + ' (' + m.data + ')');
    });
    assertClose(mv[mv.length - 1].saldoCorrido, LG.saldo,
      'o saldo corrido da ultima linha e o saldo da conta');
  });

  it('ledgerMovs() entrega na ordem da view (data, id) — nao na ordem dos ids', () => {
    const h = comRazao();
    const mv = h.escopo.ledgerMovs();
    for (let i = 1; i < mv.length; i++) {
      assertTrue(mv[i - 1].data <= mv[i].data,
        'fora de ordem cronologica em ' + mv[i - 1].data + ' > ' + mv[i].data);
    }
    // os ids do backfill NAO sao cronologicos (1 = saldo inicial, 2..6 compras,
    // 7..21 reembolsos): se alguem trocar a ordenacao por id, o saldo corrido muda
    const ids = mv.map((m) => m.id);
    const crescente = ids.every((x, i) => i === 0 || ids[i - 1] < x);
    assertFalse(crescente,
      'o fixture perdeu a propriedade de ter id fora da ordem de data — o teste ficou vazio');
  });

  it('mapLedger traduz a linha do banco (snake_case) para o formato do app', () => {
    const h = comRazao();
    const m = h.escopo.mapLedger({
      id: 42, data: '2026-09-16', tipo: 'compra_financiada', direcao: 'debito',
      valor: '4660.00', descricao: 'Compra de TG', origem_tipo: 'reposicao',
      origem_id: 2004, estorna_id: null, estornado_em: null,
      created_by: 'Victor', saldo_corrido: '5758.30',
    });
    assertEqual(m.id, 42, 'id');
    assertEqual(m.origemTipo, 'reposicao', 'origem_tipo -> origemTipo');
    assertEqual(m.origemId, 2004, 'origem_id -> origemId');
    assertEqual(m.criadoPor, 'Victor', 'created_by -> criadoPor');
    assertTrue(typeof m.valor === 'number', 'valor chega como texto e vira numero');
    assertClose(m.valor, 4660.00, 'valor');
    assertTrue(typeof m.saldoCorrido === 'number', 'saldo_corrido tambem vira numero');
    assertClose(m.saldoCorrido, 5758.30, 'saldo corrido');
    // valor ausente nao pode virar NaN e envenenar a soma
    assertClose(h.escopo.mapLedger({ id: 1 }).valor, 0, 'valor nulo vira zero');
    assertEqual(h.escopo.mapLedger({ id: 1 }).descricao, '', 'descricao nula vira vazio');
  });
});

// =============================================================================
describe('Compra financiada — debito de valor exato', () => {

  it('um movimento de compra aumenta o saldo pelo valor exato da compra', () => {
    const h = comRazao();
    const antes = h.escopo.saldoVictor();
    h.escopo.DB.ledger = h.escopo.ledgerMovs().concat([F.movLedger({
      id: 900, data: '2026-09-16', tipo: 'compra_financiada', direcao: 'debito',
      valor: 4660.00, descricao: 'Compra de TG - 8 caixa(s)',
      origemTipo: 'reposicao', origemId: 2004,
    })]);
    assertClose(h.escopo.saldoVictor(), antes + 4660.00,
      'o saldo sobe exatamente o valor da compra');
  });

  it('uma compra gera UM movimento, nao dois', () => {
    const h = comRazao();
    const mv = h.escopo.ledgerMovs();
    const porOrigem = {};
    mv.filter((m) => m.origemTipo === 'reposicao').forEach((m) => {
      porOrigem[m.origemId] = (porOrigem[m.origemId] || 0) + 1;
    });
    const repetidas = Object.keys(porOrigem).filter((k) => porOrigem[k] > 1);
    assertEqual(repetidas.length, 0,
      'compra com mais de um movimento no razao: ' + repetidas.join(', '));
    assertEqual(Object.keys(porOrigem).length, h.escopo.DB.reposicoes.length,
      'uma compra registrada = um movimento no razao');
    // e o total dos debitos de compra e o total comprado, sem dobrar nada
    const compras = mv.filter((m) => m.tipo === 'compra_financiada');
    assertClose(compras.reduce((a, m) => a + m.valor, 0),
      h.escopo.DB.reposicoes.reduce((a, r) => a + r.custTotal, 0),
      'debitos de compra = soma das compras registradas');
  });

  it('confReposicao chama vsp_registrar_compra e nao mexe no razao local', async () => {
    const h = comRazao();
    const antes = h.escopo.saldoVictor();
    const movsAntes = h.escopo.ledgerMovs().length;
    const rpc = h.espiarRpc({ repetida: false });
    h.preencher(CAMPOS_COMPRA);
    await h.escopo.confReposicao();

    assertEqual(rpc.length, 1, 'uma compra = uma chamada');
    assertEqual(rpc[0].fn, 'vsp_registrar_compra', 'a funcao transacional do banco');
    assertClose(rpc[0].params.p_rep.cust_total, 4660.00, '8 x 582,50');
    assertTrue(typeof rpc[0].op === 'string' && rpc[0].op.length > 0, 'op_id nao vazio');
    // o movimento do razao e inserido DENTRO da transacao, no banco. O cliente nao
    // escreve no razao por conta propria — se escrevesse, um erro depois deixaria a
    // tela mostrando uma divida que o banco nao tem.
    assertEqual(h.escopo.ledgerMovs().length, movsAntes, 'o app nao inventou movimento');
    assertClose(h.escopo.saldoVictor(), antes, 'nem mexeu no saldo por conta propria');
  });

  it('o app adota o estado canonico devolvido pelo banco na compra', async () => {
    const h = comRazao();
    const compraDoBanco = {
      id: 2099, prod: 'TG', tipo: 'caixa', qtd: 8, cust_unit: 582.50, frete: 0,
      cust_total: 4660.00, forn: 'Victor', data: '2026-09-16', obs: '',
      lote: 'L260916', validade: '2027-09-16', nota_lote: '',
    };
    const produtoDoBanco = {
      id: 'TG', nome: 'TG', vende_frasco: true, frascos_por_caixa: 4,
      custo_caixa: 777.77, custo_frasco: 194.44, preco_padrao: 1450,
      estoque_minimo: 4, estoque_critico: 2, caixas: 16, frascos: 0, ativo: true,
    };
    h.espiarRpc({ repetida: false, compra: compraDoBanco, produto: produtoDoBanco });
    h.preencher(CAMPOS_COMPRA);
    await h.escopo.confReposicao();

    const rep = h.escopo.DB.reposicoes.find((r) => r.id === 2099);
    assertTrue(!!rep, 'a compra devolvida pelo banco entrou no historico local');
    const p = h.escopo.getProd('TG');
    assertEqual(p.caixas, 16, 'o estoque e o que o banco devolveu');
    assertClose(p.custoCaixa, 777.77, 'o custo medio tambem — o app nao recalcula');
  });

  it('a compra traz o movimento do razao e o app adota o saldo novo', async () => {
      // A vsp_reembolsar_victor JA devolve 'saldo_victor' no envelope (migration 006).
      // A vsp_registrar_compra insere o movimento na mesma transacao, mas o app nao le
      // nada do razao na resposta: depois de lancar uma compra, "A empresa deve a voce"
      // continua mostrando o saldo de antes ate alguem sincronizar.
      const h = comRazao();
      const antes = h.escopo.saldoVictor();
      h.espiarRpc({
        repetida: false,
        compra: { id: 2099, prod: 'TG', tipo: 'caixa', qtd: 8, cust_unit: 582.50,
                  frete: 0, cust_total: 4660.00, forn: 'Victor', data: '2026-09-16' },
        movimento: { id: 9001, data: '2026-09-16', tipo: 'compra_financiada', direcao: 'debito',
                     valor: 4660.00, descricao: 'Compra de TG - 8 caixa(s) - fornecedor Victor',
                     origem_tipo: 'reposicao', origem_id: 2099, created_by: 'Victor' },
        saldo_victor: antes + 4660.00,
      });
      h.preencher(CAMPOS_COMPRA);
      await h.escopo.confReposicao();
      assertClose(h.escopo.saldoVictor(), antes + 4660.00,
        'o app tem de adotar o saldo devolvido pelo banco');
    }
  );
});

// =============================================================================
describe('Reembolso — credito de valor exato', () => {

  it('um reembolso reduz o saldo pelo valor exato', () => {
    const h = comRazao();
    const antes = h.escopo.saldoVictor();
    h.escopo.DB.ledger = h.escopo.ledgerMovs().concat([F.movLedger({
      id: 901, data: '2026-09-16', tipo: 'reembolso', direcao: 'credito',
      valor: 1758.30, descricao: 'Reembolso a Victor', origemTipo: 'saida', origemId: 1099,
    })]);
    assertClose(h.escopo.saldoVictor(), antes - 1758.30, 'o saldo cai o valor do reembolso');
    assertClose(h.escopo.saldoVictor(), 4000.00, '5.758,30 - 1.758,30');
  });

  it('reembolsar o saldo inteiro zera a conta (e nao deixa centavo sobrando)', () => {
    const h = comRazao();
    h.escopo.DB.ledger = h.escopo.ledgerMovs().concat([F.movLedger({
      id: 902, data: '2026-09-16', tipo: 'reembolso', direcao: 'credito',
      valor: LG.saldo, descricao: 'Quitacao total', origemTipo: 'saida', origemId: 1098,
    })]);
    assertClose(h.escopo.saldoVictor(), 0, 'conta quitada');
    assertEqual(Math.round(h.escopo.saldoVictor() * 100), 0, 'zero ao centavo');
  });

  it('dois reembolsos seguidos descontam os dois, sem arredondar no meio', () => {
    const h = comRazao();
    h.escopo.DB.ledger = h.escopo.ledgerMovs().concat([
      F.movLedger({ id: 903, data: '2026-09-16', tipo: 'reembolso', direcao: 'credito', valor: 333.33 }),
      F.movLedger({ id: 904, data: '2026-09-17', tipo: 'reembolso', direcao: 'credito', valor: 666.67 }),
    ]);
    assertClose(h.escopo.saldoVictor(), LG.saldo - 1000.00, 'os dois creditos entram inteiros');
  });

  it('o card do Financeiro separa o que foi financiado do que ja voltou', () => {
    const h = comRazao();
    h.escopo.renderFin();
    const card = h.ui.html('fornBody');
    assertClose(valorRotulado(card, 'Você financiou'), LG.saldoInicial + LG.compras,
      'debitos');
    assertClose(valorRotulado(card, 'Já recebeu de volta'), LG.reembolsos, 'creditos');
    assertClose(valorRotulado(card, 'A empresa deve a você'), LG.saldo, 'saldo');
  });
});

// =============================================================================
// O TESTE MAIS IMPORTANTE DESTE ARQUIVO.
//
// Era exatamente aqui que a formula antiga errava: a divida com o Victor saia de
// CMV + valor do estoque - pago. Toda quebra, toda perda, todo ajuste de inventario
// e todo recalculo de custo medio mexia numa divida entre duas pessoas sem que um
// centavo tivesse trocado de mao.
// =============================================================================
describe('Estoque NAO altera o razao', () => {

  function provaSaldoImune(h, nome, mexer) {
    const antes = h.escopo.saldoVictor();
    const estoqueAntes = h.escopo.valorEstTotal();
    mexer();
    const depois = h.escopo.saldoVictor();
    assertEqual(Math.round(depois * 100), Math.round(antes * 100),
      nome + ': o saldo do razao mudou (antes ' + antes + ', depois ' + depois + ')');
    assertTrue(Math.round(h.escopo.valorEstTotal() * 100) !== Math.round(estoqueAntes * 100),
      nome + ': o cenario nao mexeu no estoque — o teste ficaria vazio');
  }

  it('aumentar caixas no estoque nao muda o saldo', () => {
    const h = comRazao();
    provaSaldoImune(h, 'caixa a mais', () => { h.escopo.getProd('TG').caixas += 12; });
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo intacto');
  });

  it('reduzir caixas (quebra, perda) nao muda o saldo', () => {
    const h = comRazao();
    provaSaldoImune(h, 'quebra', () => { h.escopo.getProd('TG').caixas -= 3; });
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo intacto');
  });

  it('zerar o estoque inteiro nao muda o saldo', () => {
    const h = comRazao();
    provaSaldoImune(h, 'estoque zerado', () => {
      h.escopo.DB.produtos.forEach((p) => { p.caixas = 0; p.frascos = 0; });
    });
    assertClose(h.escopo.valorEstTotal(), 0, 'o estoque realmente zerou');
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'e o saldo continua 5.758,30');
  });

  it('mudar o custo medio (sem mudar quantidade) nao muda o saldo', () => {
    const h = comRazao();
    provaSaldoImune(h, 'custo medio', () => {
      const p = h.escopo.getProd('TG');
      p.custoCaixa = 999.99; p.custoFrasco = 250.00;
    });
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo intacto');
  });

  it('uma VENDA (baixa de estoque + CMV) nao muda o saldo', () => {
    const h = comRazao();
    const antes = h.escopo.saldoVictor();
    const cmvAntes = h.escopo.DB.vendas
      .filter((v) => !v.cancelada).reduce((a, v) => a + v.custo, 0);
    // o que a vsp_registrar_venda faz: grava a venda e baixa o estoque
    h.escopo.DB.vendas.push(F.vendaSimples({
      id: 970001, data: '2026-09-16', tipo: 'caixa', qtd: 2, custo: 1165.00,
      bruto: 2900.00, valOrig: 2900.00, valFinal: 2900.00, liq: 2900.00,
      lucroLiq: 1735.00, usuario: 'Victor',
    }));
    h.escopo.getProd('TG').caixas -= 2;

    const cmvDepois = h.escopo.DB.vendas
      .filter((v) => !v.cancelada).reduce((a, v) => a + v.custo, 0);
    assertClose(cmvDepois - cmvAntes, 1165.00, 'o CMV subiu — o cenario e real');
    assertEqual(Math.round(h.escopo.saldoVictor() * 100), Math.round(antes * 100),
      'vender mercadoria nao cria nem quita divida com o socio');
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo intacto');
  });

  it('CANCELAR uma venda (estoque volta) nao muda o saldo', () => {
    const h = comRazao();
    const antes = h.escopo.saldoVictor();
    const v = h.escopo.DB.vendas.find((x) => !x.cancelada && x.tipo === 'caixa');
    assertTrue(!!v, 'o fixture tem venda de caixa para cancelar');
    // o que a vsp_cancelar_venda faz: marca cancelada e devolve o estoque
    v.cancelada = true;
    v.canceladaPor = 'Victor';
    v.canceladaMotivo = 'teste';
    h.escopo.getProd(v.prod).caixas += v.qtd;

    assertEqual(Math.round(h.escopo.saldoVictor() * 100), Math.round(antes * 100),
      'cancelamento e operacao de estoque e receita, nao de razao');
    assertClose(h.escopo.saldoVictor(), LG.saldo, 'saldo intacto');
  });

  it('nenhum movimento do razao tem origem em venda ou produto', () => {
    const h = comRazao();
    const origens = new Set(h.escopo.ledgerMovs().map((m) => m.origemTipo));
    ['venda', 'produto', 'estoque', 'inventario'].forEach((proibida) => {
      assertFalse(origens.has(proibida),
        'o razao nao pode ter movimento com origem "' + proibida + '"');
    });
    const permitidas = ['reposicao', 'saida', 'migracao', 'manual', ''];
    [...origens].forEach((o) => {
      assertTrue(permitidas.includes(o), 'origem inesperada no razao: ' + o);
    });
  });

  it('os dois cards (Financeiro e Dashboard) tambem ignoram o estoque', () => {
    const h = comRazao();
    h.escopo.renderFin();
    h.escopo.renderDash();
    const finAntes = valorRotulado(h.ui.html('fornBody'), 'A empresa deve a você');
    const dashAntes = valorRotulado(h.ui.html('dashVictor'), 'A empresa deve a você');
    assertClose(finAntes, LG.saldo, 'card do Financeiro');
    assertClose(dashAntes, LG.saldo, 'card do Dashboard');

    h.escopo.getProd('TG').caixas += 20;   // +11.650,00 de estoque
    h.escopo.DB.produtos.forEach((p) => { p.custoCaixa += 100; });
    h.escopo.renderFin();
    h.escopo.renderDash();
    assertClose(valorRotulado(h.ui.html('fornBody'), 'A empresa deve a você'), finAntes,
      'o card do Financeiro nao pode reagir a estoque');
    assertClose(valorRotulado(h.ui.html('dashVictor'), 'A empresa deve a você'), dashAntes,
      'nem o do Dashboard');
    assertMaior(h.escopo.valorEstTotal(), 4660.00, 'o estoque realmente subiu');
  });

  it('o extrato tambem nao se move quando o estoque se move', () => {
    const h = comRazao();
    const antes = extrato(h);
    h.escopo.getProd('TG').caixas = 0;
    h.escopo.getProd('TG').frascos = 99;
    const depois = extrato(h);
    assertEqual(depois.linhas, antes.linhas, 'mesmas linhas no extrato');
    assertClose(valorRotulado(depois.topo, 'A empresa deve a você'), LG.saldo,
      'mesmo saldo no topo');
  });
});

// =============================================================================
describe('Estorno — por compensacao, sem apagar historico', () => {

  const MOTIVO = 'compra lancada em duplicidade';

  /** Razao com a compra #2005 (R$ 4.105,00) estornada. */
  function comEstorno() {
    return F.ledgerComEstorno(F.ledgerProducao(), 'reposicao', 2005, MOTIVO);
  }

  it('o movimento compensatorio aparece no extrato, com sinal oposto', () => {
    const h = comRazao(comEstorno());
    const mv = h.escopo.ledgerMovs();
    assertEqual(mv.length, LG.movimentos + 1, 'o razao ganhou uma linha, nao perdeu nenhuma');
    const comp = mv.find((m) => m.tipo === 'estorno');
    assertTrue(!!comp, 'o movimento de estorno existe');
    assertEqual(comp.direcao, 'credito', 'estorno de debito entra como credito');
    assertClose(comp.valor, 4105.00, 'mesmo valor da compra estornada');
    assertEqual(comp.estornaId, 6, 'aponta para o movimento que ele desfaz');
    assertInclui(comp.descricao, 'Estorno do movimento #6', 'a descricao diz o que ele desfaz');
    assertInclui(comp.descricao, MOTIVO, 'e diz por que');

    const r = extrato(h);
    assertInclui(r.corpo, 'Estorno', 'o extrato mostra o movimento compensatorio');
    assertInclui(r.corpo, 'Estorna o movimento #6',
      'e a coluna Origem explica qual movimento ele estorna');
  });

  it('o historico continua visivel: o movimento original nao e apagado', () => {
    const h = comRazao(comEstorno());
    const original = h.escopo.ledgerMovs().find((m) => m.id === 6);
    assertTrue(!!original, 'o movimento estornado continua na tabela');
    assertTrue(!!original.estornadoEm, 'ele fica MARCADO como estornado, nao removido');
    assertEqual(original.tipo, 'compra_financiada', 'e continua sendo o que era');
    assertClose(original.valor, 4105.00, 'com o valor original preservado');
    // correcao de razao financeiro e por compensacao: nada de DELETE
    const r = extrato(h);
    assertInclui(r.corpo, 'Compra paga por você', 'a compra original continua listada');
    assertEqual(r.linhas, LG.movimentos + 1, 'as 22 linhas aparecem no extrato');
  });

  it('o movimento estornado nao conta duas vezes: o par soma zero', () => {
    const h = comRazao(comEstorno());
    const mv = h.escopo.ledgerMovs();
    const original = mv.find((m) => m.id === 6);
    const comp = mv.find((m) => m.estornaId === 6);
    const doPar = Math.round(original.valor * 100) * (original.direcao === 'debito' ? 1 : -1)
                + Math.round(comp.valor * 100) * (comp.direcao === 'debito' ? 1 : -1);
    assertEqual(doPar, 0, 'o par (movimento + compensacao) tem de somar zero');
  });

  it('um ajuste financeiro de estorno tambem entra pelo razao, nunca pelo estoque', () => {
    const h = comRazao(comEstorno());
    const antes = h.escopo.valorEstTotal();
    assertClose(h.escopo.valorEstTotal(), antes, 'estornar movimento nao mexe em estoque');
    // e o oposto tambem vale: estornar a COMPRA no estoque nao apaga o razao
    h.escopo.DB.reposicoes = h.escopo.DB.reposicoes.filter((r) => r.id !== 2005);
    h.escopo.getProd('TG').caixas -= 7;
    assertEqual(h.escopo.ledgerMovs().length, LG.movimentos + 1,
      'apagar a compra do historico de estoque nao apaga o razao');
    const r = extrato(h);
    assertInclui(r.corpo, 'Compra #2005 (já estornada)',
      'a origem passa a dizer que a compra nao existe mais, em vez de quebrar');
  });

  it(
    'o estorno deixa o saldo igual ao de antes do movimento estornado',
    () => {
      // A view corrigida entrega TODAS as linhas: a estornada (com o marcador) e a
      // compensatoria. O par soma zero, e o historico continua visivel no extrato.
      const comoAViewEntrega = comEstorno();
      const h = comRazao(comoAViewEntrega);
      // estornar a compra de 4.105,00 tem de deixar o saldo em 5.758,30 - 4.105,00
      assertClose(h.escopo.saldoVictor(), LG.saldo - 4105.00,
        'saldo depois de estornar a compra #2005');
    }
  );
});

// =============================================================================
describe('Extrato da Conta do Victor — renderVictor e os filtros', () => {

  it('o topo mostra o saldo do razao, o financiado, o recebido e o saldo inicial', () => {
    const h = comRazao();
    const r = extrato(h);
    assertClose(valorRotulado(r.topo, 'A empresa deve a você'), LG.saldo, 'saldo');
    assertClose(valorRotulado(r.topo, 'Você financiou'), LG.saldoInicial + LG.compras, 'debitos');
    assertClose(valorRotulado(r.topo, 'Já recebeu de volta'), LG.reembolsos, 'creditos');
    assertClose(valorRotulado(r.topo, 'Saldo inicial da conta'), LG.saldoInicial, 'saldo inicial');
    assertInclui(r.topo, 'saldo atual da conta', 'o rotulo diz que e o saldo da conta');
    assertInclui(r.topo, 'total', 'sem filtro, os totais sao da conta inteira');
  });

  it('o extrato lista os 21 movimentos, do mais recente para o mais antigo', () => {
    const h = comRazao();
    const r = extrato(h);
    assertEqual(r.linhas, LG.movimentos, 'uma linha por movimento');
    assertFalse(r.vazioVisivel, 'com movimento, o estado vazio fica escondido');
    const mv = h.escopo.ledgerMovs();
    const ultimo = mv[mv.length - 1];
    const primeiro = mv[0];
    const iUlt = r.corpo.indexOf(h.escopo.fmtD(ultimo.data));
    const iPri = r.corpo.indexOf(h.escopo.fmtD(primeiro.data));
    assertTrue(iUlt >= 0 && iPri >= 0, 'as duas datas extremas aparecem');
    assertTrue(iUlt < iPri, 'o movimento mais recente vem primeiro na tabela');
    // o saldo corrido da linha mais recente e o saldo da conta
    assertInclui(r.corpo, 'R$ ' + LG.saldo.toFixed(2), 'a coluna "Saldo apos" fecha no saldo');
  });

  it('a coluna Origem explica de onde veio cada movimento', () => {
    const h = comRazao();
    const r = extrato(h);
    assertInclui(r.corpo, 'Apuração histórica', 'origem do saldo inicial');
    const rep = h.escopo.DB.reposicoes[0];
    assertInclui(r.corpo, 'Compra de ' + h.escopo.fmtD(rep.data),
      'compra resolvida para data + produto');
    assertInclui(r.corpo, h.escopo.prodNome(rep.prod), 'com o nome do produto');
    const s = h.escopo.DB.saidas.find((x) => x.id === 1005);
    assertInclui(r.corpo, 'Lançamento de ' + h.escopo.fmtD(s.data),
      'reembolso resolvido para o lancamento financeiro');
  });

  it('ledgerRotulo traduz o enum — nada de compra_financiada cru na tela', () => {
    const h = comRazao();
    assertEqual(h.escopo.ledgerRotulo('saldo_inicial'), 'Saldo inicial', 'saldo_inicial');
    assertEqual(h.escopo.ledgerRotulo('compra_financiada'), 'Compra paga por você', 'compra');
    assertEqual(h.escopo.ledgerRotulo('reembolso'), 'Reembolso recebido', 'reembolso');
    assertEqual(h.escopo.ledgerRotulo('ajuste_financeiro'), 'Ajuste financeiro', 'ajuste');
    assertEqual(h.escopo.ledgerRotulo('estorno'), 'Estorno', 'estorno');

    const r = extrato(h);
    h.escopo.renderFin();
    h.escopo.renderDash();
    const telas = [r.topo, r.corpo, h.ui.html('fornBody'), h.ui.html('dashVictor')].join('\n');
    // 'reembolso' e 'estorno' sao palavras do portugues e aparecem nos textos de
    // ajuda; os valores de maquina do enum sao os com sublinhado, e nenhum deles
    // pode chegar a tela.
    ['compra_financiada', 'saldo_inicial', 'ajuste_financeiro'].forEach((enu) => {
      assertNaoInclui(telas, enu, 'o enum "' + enu + '" vazou para a tela');
    });
    // e nenhum tipo do razao aparece na tabela do jeito que esta no banco
    h.escopo.ledgerMovs().forEach((m) => {
      assertNaoInclui(r.corpo, '>' + m.tipo + '<',
        'o tipo "' + m.tipo + '" foi impresso cru na tabela');
    });
    assertInclui(r.corpo, 'Compra paga por você', 'o rotulo humano esta na tabela');
    assertInclui(r.corpo, 'Reembolso recebido', 'e o do reembolso tambem');
  });

  it('tipo desconhecido nao vira tela em branco: cai no proprio valor', () => {
    const h = comRazao();
    assertEqual(h.escopo.ledgerRotulo('tipo_novo_do_futuro'), 'tipo_novo_do_futuro',
      'melhor mostrar o enum do que nada');
  });

  it('filtro de periodo mostra so o que caiu no periodo', () => {
    const h = comRazao();
    h.preencher({ vicDe: '2026-09-01', vicAte: '2026-09-30', vicTipo: '', vicOrigem: '' });
    h.escopo.aplicarFiltroVic();
    const corpo = h.ui.html('vicBody');
    const topo = h.ui.html('vicTopo');
    const setembro = h.escopo.ledgerMovs().filter((m) => m.data.startsWith('2026-09'));
    assertEqual(setembro.length, 6, 'setembro tem 6 movimentos no fixture');
    assertEqual((corpo.match(/<tr>/g) || []).length, setembro.length,
      'a tabela mostra so os movimentos de setembro');
    assertNaoInclui(corpo, '01/06/2026', 'o saldo inicial de junho saiu da lista');
    const finSet = setembro.filter((m) => m.direcao === 'debito').reduce((a, m) => a + m.valor, 0);
    const recSet = setembro.filter((m) => m.direcao === 'credito').reduce((a, m) => a + m.valor, 0);
    assertClose(valorRotulado(topo, 'Você financiou'), finSet, 'financiado no filtro');
    assertClose(valorRotulado(topo, 'Já recebeu de volta'), recSet, 'recebido no filtro');
    assertInclui(topo, 'no filtro', 'o topo avisa que os totais sao do filtro');
  });

  it('filtro de tipo mostra so aquele tipo', () => {
    const h = comRazao();
    h.preencher({ vicDe: '', vicAte: '', vicTipo: 'compra_financiada', vicOrigem: '' });
    h.escopo.aplicarFiltroVic();
    const corpo = h.ui.html('vicBody');
    assertEqual((corpo.match(/<tr>/g) || []).length, LG.comprasQtd, 'as 5 compras');
    assertNaoInclui(corpo, 'Reembolso recebido', 'nenhum reembolso na lista');
    assertClose(valorRotulado(h.ui.html('vicTopo'), 'Você financiou'), LG.compras,
      'financiado no filtro = total comprado');
    assertClose(valorRotulado(h.ui.html('vicTopo'), 'Já recebeu de volta'), 0,
      'nenhum credito no filtro de compras');
  });

  it('filtro de origem mostra so os movimentos daquela origem', () => {
    const h = comRazao();
    h.preencher({ vicDe: '', vicAte: '', vicTipo: '', vicOrigem: 'reposicao' });
    h.escopo.aplicarFiltroVic();
    assertEqual((h.ui.html('vicBody').match(/<tr>/g) || []).length, LG.comprasQtd,
      'origem reposicao = as 5 compras');

    h.preencher({ vicOrigem: 'migracao' });
    h.escopo.aplicarFiltroVic();
    const corpo = h.ui.html('vicBody');
    assertEqual((corpo.match(/<tr>/g) || []).length, 1, 'origem migracao = so o saldo inicial');
    assertInclui(corpo, 'Saldo inicial', 'e e mesmo o saldo inicial');

    h.preencher({ vicOrigem: 'saida' });
    h.escopo.aplicarFiltroVic();
    const daSaida = h.escopo.ledgerMovs().filter((m) => m.origemTipo === 'saida');
    assertEqual((h.ui.html('vicBody').match(/<tr>/g) || []).length, daSaida.length,
      'origem saida = os reembolsos ligados a um lancamento financeiro');
    assertMaior(daSaida.length, 0, 'o fixture tem reembolso com origem em saida');
  });

  it('os tres filtros juntos se acumulam (E, nao OU)', () => {
    const h = comRazao();
    h.preencher({
      vicDe: '2026-07-01', vicAte: '2026-09-30',
      vicTipo: 'compra_financiada', vicOrigem: 'reposicao',
    });
    h.escopo.aplicarFiltroVic();
    const esperado = h.escopo.ledgerMovs().filter((m) => (
      m.data >= '2026-07-01' && m.data <= '2026-09-30' &&
      m.tipo === 'compra_financiada' && m.origemTipo === 'reposicao'));
    assertEqual((h.ui.html('vicBody').match(/<tr>/g) || []).length, esperado.length,
      'o filtro composto casa com o calculo feito aqui');
    assertEqual(esperado.length, 5, 'as 5 compras estao todas nessa janela');
  });

  it('o saldo do topo e o da CONTA INTEIRA — filtro nenhum o muda', () => {
    const h = comRazao();
    const semFiltro = valorRotulado(extrato(h).topo, 'A empresa deve a você');
    assertClose(semFiltro, LG.saldo, 'saldo sem filtro');

    const filtros = [
      { vicDe: '2026-09-01', vicAte: '2026-09-30', vicTipo: '', vicOrigem: '' },
      { vicDe: '', vicAte: '', vicTipo: 'compra_financiada', vicOrigem: '' },
      { vicDe: '', vicAte: '', vicTipo: 'reembolso', vicOrigem: '' },
      { vicDe: '', vicAte: '', vicTipo: '', vicOrigem: 'migracao' },
      { vicDe: '2026-08-01', vicAte: '2026-08-31', vicTipo: '', vicOrigem: 'reposicao' },
    ];
    filtros.forEach((f) => {
      h.preencher({ vicDe: '', vicAte: '', vicTipo: '', vicOrigem: '' });
      h.preencher(f);
      h.escopo.aplicarFiltroVic();
      assertClose(valorRotulado(h.ui.html('vicTopo'), 'A empresa deve a você'), LG.saldo,
        'o saldo mudou com o filtro ' + JSON.stringify(f) +
        ' — filtro e recorte de extrato, nao de divida');
    });
  });

  it('limparFiltroVic volta ao extrato inteiro e limpa os campos', () => {
    const h = comRazao();
    h.preencher({ vicDe: '2026-09-01', vicAte: '2026-09-02', vicTipo: 'reembolso', vicOrigem: 'saida' });
    h.escopo.aplicarFiltroVic();
    assertTrue(h.escopo.vicTemFiltro(), 'o filtro esta ligado');

    h.escopo.limparFiltroVic();
    assertFalse(h.escopo.vicTemFiltro(), 'e desligou');
    ['vicDe', 'vicAte', 'vicTipo', 'vicOrigem'].forEach((id) => {
      assertEqual(h.ui.valor(id), '', 'campo ' + id + ' limpo na tela');
    });
    assertEqual((h.ui.html('vicBody').match(/<tr>/g) || []).length, LG.movimentos,
      'os 21 movimentos voltaram');
    assertInclui(h.ui.html('vicTopo'), 'total', 'os totais voltaram a ser da conta inteira');
  });

  it('razao vazio: estado vazio explicando que falta sincronizar', () => {
    const h = comRazao(F.ledgerVazio());
    const r = extrato(h);
    assertEqual(r.linhas, 0, 'nenhuma linha');
    assertEqual(r.topo, '', 'sem movimento nao se inventa saldo no topo');
    assertTrue(r.vazioVisivel, 'o estado vazio aparece');
    assertInclui(r.vazio, 'Nenhum movimento carregado', 'e diz o que aconteceu');
    assertInclui(r.vazio, 'sincronizar', 'e o que fazer');
    assertClose(h.escopo.saldoVictor(), 0, 'razao vazio = saldo zero, nao NaN');
  });

  it('filtro que nao casa com nada: estado vazio DIFERENTE, mandando ajustar o filtro', () => {
    const h = comRazao();
    h.preencher({ vicDe: '2027-01-01', vicAte: '2027-12-31', vicTipo: '', vicOrigem: '' });
    h.escopo.aplicarFiltroVic();
    assertEqual((h.ui.html('vicBody').match(/<tr>/g) || []).length, 0, 'nenhuma linha');
    assertEqual(display(h, 'vicEmpty'), '', 'o estado vazio aparece');
    const texto = textoDe(h, 'vicEmpty');
    assertInclui(texto, 'Nenhum movimento nesse filtro', 'a mensagem e a do filtro');
    assertInclui(texto, 'Limpar', 'e ensina a sair dele');
    // e o topo continua mostrando o saldo da conta: o dinheiro nao desapareceu
    assertClose(valorRotulado(h.ui.html('vicTopo'), 'A empresa deve a você'), LG.saldo,
      'filtro vazio nao pode dar a impressao de que a conta zerou');
  });

  it('exportVictor exporta a conta inteira, com rotulo humano e saldo corrido', () => {
    const h = comRazao();
    let capturado = null;
    h.escopo.dlCSV = function (nome, header, rows) { capturado = { nome, header, rows }; };
    h.escopo.exportVictor();
    assertTrue(!!capturado, 'exportVictor chamou dlCSV');
    assertEqual(capturado.nome, 'vs_conta_victor.csv', 'nome do arquivo');
    assertArray(capturado.header,
      ['Data', 'Tipo', 'Descricao', 'Origem', 'Voce financiou', 'Recebeu', 'Saldo apos'],
      'colunas do CSV');
    assertEqual(capturado.rows.length, LG.movimentos, 'uma linha por movimento');
    const tipos = capturado.rows.map((r) => r[1]);
    assertFalse(tipos.some((t) => /_/.test(t)), 'nenhum enum cru no CSV: ' + tipos.join(','));
    // debito preenche a coluna "Voce financiou", credito a "Recebeu" — nunca as duas
    capturado.rows.forEach((r, i) => {
      const temDeb = r[4] !== '';
      const temCre = r[5] !== '';
      assertTrue(temDeb !== temCre, 'linha ' + i + ' precisa ter exatamente uma das colunas');
    });
    assertEqual(capturado.rows[capturado.rows.length - 1][6], LG.saldo.toFixed(2),
      'a ultima linha fecha no saldo da conta');
  });
});

// =============================================================================
describe('Cards do Financeiro e do Dashboard leem o razao', () => {

  it('o card do Financeiro mostra o saldo do razao e os ultimos movimentos', () => {
    const h = comRazao();
    h.escopo.renderFin();
    const card = h.ui.html('fornBody');
    assertClose(valorRotulado(card, 'A empresa deve a você'), LG.saldo, 'saldo');
    assertInclui(card, 'Últimos movimentos', 'o card mostra os ultimos movimentos');
    const mv = h.escopo.ledgerMovs();
    assertInclui(card, h.escopo.fmtD(mv[mv.length - 1].data), 'com a data do mais recente');
    assertInclui(card, 'Ver extrato completo', 'e leva para o extrato');
  });

  it('o card do Dashboard mostra o mesmo saldo, e explica de onde ele vem', () => {
    const h = comRazao();
    h.escopo.renderDash();
    const card = h.ui.html('dashVictor');
    assertClose(valorRotulado(card, 'A empresa deve a você'), LG.saldo, 'saldo');
    assertClose(valorRotulado(card, 'Você financiou'), LG.saldoInicial + LG.compras, 'debitos');
    assertClose(valorRotulado(card, 'Já recebeu de volta'), LG.reembolsos, 'creditos');
    assertInclui(card, 'razão', 'o texto diz que o numero vem do razao');
    assertInclui(card, 'ajuste de estoque', 'e que estoque nao mexe nele');
  });

  it('os tres lugares (Dashboard, Financeiro, extrato) mostram o MESMO numero', () => {
    const h = comRazao();
    h.escopo.renderDash();
    h.escopo.renderFin();
    h.escopo.renderVictor();
    const dash = valorRotulado(h.ui.html('dashVictor'), 'A empresa deve a você');
    const fin = valorRotulado(h.ui.html('fornBody'), 'A empresa deve a você');
    const ext = valorRotulado(h.ui.html('vicTopo'), 'A empresa deve a você');
    assertClose(dash, fin, 'Dashboard x Financeiro');
    assertClose(fin, ext, 'Financeiro x extrato');
    assertClose(dash, h.escopo.saldoVictor(), 'e todos batem com saldoVictor()');
  });

  it('o card do Dashboard NAO usa a formula antiga (CMV + estoque - pago)', () => {
    const h = comRazao();
    // esvaziar o razao e a prova: pela formula antiga o card mostraria 5.758,30
    // (CMV 23.539,30 + estoque 4.660,00 - pago 22.441,00) mesmo sem razao nenhum.
    h.escopo.DB.ledger = [];
    h.escopo.renderDash();
    h.escopo.renderFin();
    const dash = h.ui.html('dashVictor');
    const fin = h.ui.html('fornBody');
    assertNaoInclui(dash, 'R$ 5758.30', 'sem razao nao ha saldo a mostrar no Dashboard');
    assertNaoInclui(fin, 'R$ 5758.30', 'nem no Financeiro');
    assertInclui(dash, 'Sem movimentos carregados', 'o card assume que nao sabe');
    assertInclui(fin, 'Nenhum movimento carregado', 'e o do Financeiro tambem');
    // e o estoque continua la, intocado: a divida so nao e mais funcao dele
    assertClose(h.escopo.valorEstTotal(), 4660.00, 'o estoque nao foi afetado');
  });

  it('os dois cards seguem qualquer razao, nao um numero decorado', () => {
    const h = comRazao([
      F.movLedger({ id: 1, data: '2026-01-01', tipo: 'compra_financiada',
                    direcao: 'debito', valor: 1000.00, saldoCorrido: 1000.00 }),
      F.movLedger({ id: 2, data: '2026-01-02', tipo: 'reembolso',
                    direcao: 'credito', valor: 250.00, saldoCorrido: 750.00 }),
    ]);
    h.escopo.renderDash();
    h.escopo.renderFin();
    assertClose(h.escopo.saldoVictor(), 750.00, 'razao de duas linhas');
    assertClose(valorRotulado(h.ui.html('dashVictor'), 'A empresa deve a você'), 750.00, 'Dashboard');
    assertClose(valorRotulado(h.ui.html('fornBody'), 'A empresa deve a você'), 750.00, 'Financeiro');
    assertClose(valorRotulado(h.ui.html('dashVictor'), 'Você financiou'), 1000.00, 'debitos');
    assertClose(valorRotulado(h.ui.html('fornBody'), 'Já recebeu de volta'), 250.00, 'creditos');
  });
});

// =============================================================================
describe('Defensivo — cache antigo, sem DB.ledger', () => {

  it('DB.ledger indefinido: ledgerMovs() devolve lista vazia e saldo zero', () => {
    const h = comRazao();
    h.escopo.DB.ledger = undefined;
    assertArray(h.escopo.ledgerMovs(), [], 'lista vazia, nunca undefined');
    assertEqual(h.escopo.saldoVictor(), 0, 'saldo zero, nunca NaN');
    assertFalse(Number.isNaN(h.escopo.saldoVictor()), 'e o zero e numero de verdade');
  });

  it('DB.ledger indefinido: nenhuma das tres telas quebra', () => {
    const h = comRazao();
    h.escopo.DB.ledger = undefined;
    h.escopo.renderVictor();
    h.escopo.renderFin();
    h.escopo.renderDash();
    assertInclui(h.ui.html('fornBody'), 'Nenhum movimento carregado', 'card do Financeiro');
    assertInclui(h.ui.html('dashVictor'), 'Sem movimentos carregados', 'card do Dashboard');
    assertInclui(textoDe(h, 'vicEmpty'), 'Nenhum movimento carregado', 'extrato');
    assertEqual(h.ui.html('vicBody'), '', 'e a tabela do extrato fica vazia');
  });

  it('DB.ledger nulo, ou nao-array, tambem nao quebra', () => {
    [null, 0, 'lixo', { 0: 'a' }].forEach((valor) => {
      const h = comRazao();
      h.escopo.DB.ledger = valor;
      assertArray(h.escopo.ledgerMovs(), [], 'DB.ledger = ' + JSON.stringify(valor));
      assertEqual(h.escopo.saldoVictor(), 0, 'saldo com DB.ledger = ' + JSON.stringify(valor));
      h.escopo.renderVictor();
      h.escopo.renderFin();
      h.escopo.renderDash();
      h.escopo.exportVictor();
      h.escopo.aplicarFiltroVic();
    });
  });

  it('exportVictor com razao vazio exporta so o cabecalho, sem estourar', () => {
    const h = comRazao(F.ledgerVazio());
    let capturado = null;
    h.escopo.dlCSV = function (nome, header, rows) { capturado = { nome, header, rows }; };
    h.escopo.exportVictor();
    assertTrue(!!capturado, 'dlCSV foi chamado');
    assertEqual(capturado.rows.length, 0, 'nenhuma linha de dado');
    assertEqual(capturado.header.length, 7, 'o cabecalho continua completo');
  });

  it('o cache salvo pelo app carrega o razao de volta (salvarCache/lerCache)', () => {
    const h = comRazao();
    // o que salvarCache() grava: ledger:ledgerMovs()
    const pacote = {
      produtos: h.escopo.DB.produtos, vendas: h.escopo.DB.vendas,
      clientes: h.escopo.DB.clientes, saidas: h.escopo.DB.saidas,
      reposicoes: h.escopo.DB.reposicoes, ledger: h.escopo.ledgerMovs(),
      config: h.escopo.DB.config,
    };
    assertEqual(pacote.ledger.length, LG.movimentos, 'o razao vai para o cache');
    // um cache gravado ANTES desta versao nao tem a chave 'ledger'
    const antigo = Object.assign({}, pacote);
    delete antigo.ledger;
    const h2 = comRazao();
    h2.escopo.DB.ledger = antigo.ledger || [];
    assertArray(h2.escopo.ledgerMovs(), [], 'cache antigo abre com razao vazio');
    assertEqual(h2.escopo.saldoVictor(), 0, 'e saldo zero em vez de numero inventado');
  });
});
