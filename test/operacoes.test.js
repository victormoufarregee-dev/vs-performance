'use strict';
/* =============================================================================
 * operacoes.test.js — as quatro operacoes transacionais, pela CAMADA DE CHAMADA.
 * =============================================================================
 *
 * Venda, compra, cancelamento e estorno nao gravam mais tabela por tabela pelo
 * frontend. Cada uma e UMA chamada a uma funcao no PostgreSQL:
 *
 *   vsp_registrar_venda(p_venda jsonb, p_op_id text)
 *   vsp_registrar_compra(p_rep jsonb, p_op_id text)
 *   vsp_cancelar_venda(p_id bigint, p_motivo text, p_usuario text, p_op_id text)
 *   vsp_estornar_compra(p_id bigint, p_usuario text, p_op_id text)
 *
 * O custo medio ponderado, a baixa de estoque com trava, a auditoria e a
 * idempotencia pelo op_id SAIRAM do JavaScript e vivem dentro dessas funcoes.
 *
 * ENTAO O QUE ESTE ARQUIVO PROVA, E O QUE NAO PROVA:
 *
 *   PROVA  — que o app chama a funcao certa, com o payload certo, com um op_id
 *            nao vazio; que o mesmo op_id e reusado no retry e um novo nasce para
 *            uma operacao nova; que o app NAO mexe em estoque, custo ou receita
 *            antes da resposta; que ele adota o estado canonico devolvido pelo
 *            banco; que uma resposta `repetida:true` nao duplica linha nenhuma;
 *            e que as validacoes locais barram a chamada antes de sair do app.
 *
 *   NAO PROVA — nenhuma conta do banco. O `sbRpc` esta espionado (h.espiarRpc):
 *            ele devolve o que ESTE arquivo mandar. Custo medio ponderado,
 *            atomicidade, trava de linha e concorrencia sao testados em SQL,
 *            contra o banco real, em transacao revertida (migrations/APLICADO.md).
 *            Um teste aqui que "verificasse" o custo medio estaria verificando o
 *            proprio fixture.
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

// --------------------------------------------------------------- utilidades ----

function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  if (db) h.carregarDB(db);
  return h;
}

/** Algum toast da rodada casa com o regex? (o sincronizar() posterior sobrescreve o ultimo) */
function algumToast(h, regex) {
  return h.ui.toasts().some((t) => regex.test(t));
}

const CAMPOS_COMPRA = {
  repProd: 'TG', repTipo: 'caixa', repQtd: '', repCustUnit: '', repForn: 'Victor',
  repData: '2026-09-15', repObs: '', repFrete: '', repLote: '', repValidade: '',
  repNota: '',
};

const COMPRA_8x582 = Object.assign({}, CAMPOS_COMPRA, {
  repQtd: '8', repCustUnit: '582.50', repLote: 'L260915', repValidade: '2027-09-15',
});

const CAMPOS_VENDA = {
  vProd: 'TG', vTipo: 'caixa', vQtd: '1', vValOrig: '1450', vDesc: '0',
  vData: '2026-09-15', vObs: '', vPgto: 'pix', vTaxa: '0', vTaxaQuem: 'nos',
  vCliSel: '4001', vCliNome: '', vCliWpp: '', vLote: '',
};

/** DB com um cliente ja cadastrado: a venda nao precisa criar cliente (zero rede). */
function dbVenda(over) {
  return F.dbMinimo(Object.assign({
    clientes: [{ id: 4001, nome: 'Cliente Teste', tel: '11999990000', obs: '' }],
  }, over || {}));
}

/** Um produto como o banco devolve (snake_case), com numeros que o JS nao calcularia. */
function produtoDoBanco(over) {
  return Object.assign({
    id: 'TG', nome: 'TG', vende_frasco: true, frascos_por_caixa: 4,
    custo_caixa: 777.77, custo_frasco: 194.44, preco_padrao: 1450,
    estoque_minimo: 4, estoque_critico: 2, caixas: 41, frascos: 3, ativo: true,
  }, over || {});
}

// =============================================================================
describe('Compra — confReposicao chama vsp_registrar_compra', () => {

  it('uma unica chamada, com o payload completo e um op_id nao vazio', async () => {
    const h = novo(F.dbEstoqueZero());
    const rpc = h.espiarRpc({});
    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();

    assertEqual(rpc.length, 1, 'uma operacao = uma chamada');
    const c = rpc[0];
    assertEqual(c.fn, 'vsp_registrar_compra', 'a funcao chamada no banco');
    const rep = c.params.p_rep;
    assertEqual(rep.prod, 'TG', 'produto');
    assertEqual(rep.tipo, 'caixa', 'tipo comprado');
    assertEqual(rep.qtd, 8, 'quantidade');
    assertClose(rep.cust_unit, 582.50, 'custo unitario');
    assertClose(rep.frete, 0, 'frete');
    assertClose(rep.cust_total, 4660.00, 'total = 8 x 582,50 + 0');
    assertEqual(rep.data, '2026-09-15', 'data da compra');
    assertEqual(rep.forn, 'Victor', 'fornecedor');
    assertEqual(rep.lote, 'L260915', 'lote');
    assertEqual(rep.validade, '2027-09-15', 'validade do lote');
    assertEqual(rep.usuario, 'Victor', 'quem lancou');
    assertTrue(typeof c.op === 'string' && c.op.length > 0, 'p_op_id nao pode ser vazio');
    assertEqual(h.rede.chamadas.length, 0, 'nada de gravacao tabela por tabela');
  });

  it('cust_total e sempre qtd x cust_unit + frete (o frete entra na mercadoria)', async () => {
    const h = novo(F.dbEstoqueZero());
    const rpc = h.espiarRpc({});
    h.preencher(Object.assign({}, COMPRA_8x582, { repFrete: '100' }));
    await h.escopo.confReposicao();

    const rep = rpc[0].params.p_rep;
    assertClose(rep.frete, 100.00, 'o frete digitado vai no payload');
    assertClose(rep.cust_total, 4760.00, '8 x 582,50 + 100,00');
    assertClose(rep.cust_total, rep.qtd * rep.cust_unit + rep.frete,
      'a identidade do total tem de valer para qualquer entrada');
  });

  it('custo digitado com virgula ("582,50") chega ao banco como 582,50', async () => {
    const h = novo(F.dbEstoqueZero());
    const rpc = h.espiarRpc({});
    h.preencher(Object.assign({}, COMPRA_8x582, { repCustUnit: '582,50' }));
    await h.escopo.confReposicao();

    const rep = rpc[0].params.p_rep;
    assertClose(rep.cust_unit, 582.50, 'valNum()/numBR() leem a virgula');
    assertClose(rep.cust_total, 4660.00, 'e o total nao vira 4.656,00');
  });

  it('o app NAO calcula custo medio nem soma estoque por conta propria', async () => {
    // o espiao devolve um envelope vazio: se o JavaScript ainda fizesse a conta,
    // custoCaixa/caixas mudariam aqui. Eles nao podem mudar.
    const h = novo(F.dbEstoqueZero());
    const rpc = h.espiarRpc({});
    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();

    const p = h.escopo.getProd('TG');
    assertEqual(rpc.length, 1, 'a chamada saiu');
    assertEqual(p.caixas, 0, 'estoque local intocado: quem soma e o banco');
    assertEqual(p.custoCaixa, 0, 'custo da caixa intocado: a media ponderada e SQL');
    assertEqual(p.custoFrasco, 0, 'custo do frasco intocado');
    assertEqual(h.escopo.DB.reposicoes.length, 0,
      'sem linha devolvida pelo banco, nada entra no historico local');
    assertEqual(rpc[0].estoque[0].caixas, 0, 'no instante da chamada tambem estava 0');
  });

  it('adota o estado canonico do produto devolvido pelo banco', async () => {
    const h = novo(F.dbEstoqueZero());
    h.espiarRpc((fn, params) => ({
      compra: Object.assign({}, params.p_rep),
      produto: produtoDoBanco(),
    }));
    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();

    const p = h.escopo.getProd('TG');
    assertEqual(p.caixas, 41, 'o estoque e o que o banco disse, nao uma conta local');
    assertEqual(p.frascos, 3, 'frascos idem');
    assertClose(p.custoCaixa, 777.77, 'custo da caixa vem do banco');
    assertClose(p.custoFrasco, 194.44, 'custo do frasco vem do banco');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra devolvida entrou no historico');
    assertClose(h.escopo.DB.reposicoes[0].custTotal, 4660.00, 'mapeada pelo mapRep');
    assertMatch(h.ui.ultimoToast(), /Compra registrada/, 'confirmacao ao usuario');
  });

  it('o mesmo op_id e reusado no retry; uma compra nova ganha op_id novo', async () => {
    // e isto que protege contra duplicar: se a primeira tentativa gravou no banco e a
    // resposta se perdeu, a segunda chega com o MESMO op_id e o banco devolve o que ja existe.
    const h = novo(F.dbEstoqueZero());
    let gravada = null;
    const rpc = h.espiarRpc((fn, params, n) => {
      if (n === 1) { gravada = Object.assign({}, params.p_rep); throw new Error('conexao caiu'); }
      return { repetida: n === 2, compra: gravada || params.p_rep, produto: produtoDoBanco() };
    });

    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();                       // 1a tentativa: falhou
    assertTrue(algumToast(h, /Não consegui salvar a compra/), 'avisou que nada foi gravado');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'nada entrou no historico local');

    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();                       // o usuario repete
    assertEqual(rpc.length, 2, 'duas chamadas');
    assertEqual(rpc[0].op, rpc[1].op, 'MESMO op_id no retry — e o que impede a duplicata');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'uma linha, nao duas');

    h.preencher(Object.assign({}, COMPRA_8x582, { repQtd: '2', repData: '2026-09-16' }));
    await h.escopo.confReposicao();                       // compra DIFERENTE
    assertEqual(rpc.length, 3, 'a terceira chamada saiu');
    assertFalse(rpc[2].op === rpc[1].op, 'op_id novo para uma compra nova');
    assertTrue(rpc[2].op.length > 0, 'e nao vazio');
  });

  it('resposta repetida:true nao duplica a linha em DB.reposicoes', async () => {
    const db = F.dbEstorno('limpo'); // ja tem a compra id 3000 no historico
    const h = novo(db);
    h.espiarRpc((fn, params) => ({
      repetida: true,
      compra: Object.assign({}, params.p_rep, { id: 3000 }),
      produto: produtoDoBanco(),
    }));
    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();

    assertEqual(h.escopo.DB.reposicoes.length, 1, 'continua UMA compra no historico');
    assertEqual(h.escopo.DB.reposicoes[0].id, 3000, 'e e a mesma linha');
    assertMatch(h.ui.ultimoToast(), /já estava lançada/, 'o usuario e avisado, sem duplicar');
  });

  it('a compra NAO lanca saida no Financeiro (a mercadoria e divida com Victor)', async () => {
    const h = novo(F.dbEstoqueZero());
    h.espiarRpc((fn, params) => ({ compra: params.p_rep, produto: produtoDoBanco() }));
    h.preencher(COMPRA_8x582);
    await h.escopo.confReposicao();

    assertEqual(h.escopo.DB.saidas.length, 0,
      'a opcao "ja paguei esta compra" foi removida em 15/09: nada de saida automatica');
    assertEqual(h.rede.por('POST', '/saidas').length, 0, 'nenhum POST em saidas');
  });

  it('sem quantidade, custo ou data nem chega a chamar o banco', async () => {
    const h = novo(F.dbEstoqueZero());
    const rpc = h.espiarRpc({});
    h.preencher(Object.assign({}, CAMPOS_COMPRA, { repQtd: '', repCustUnit: '582.50' }));
    await h.escopo.confReposicao();

    assertMatch(h.ui.ultimoToast(), /Preencha quantidade, custo e data/, 'mensagem de bloqueio');
    assertEqual(rpc.length, 0, 'a validacao local barra antes da RPC');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'nada foi gravado');
    assertEqual(h.escopo.getProd('TG').caixas, 0, 'estoque intacto');
    assertEqual(h.rede.chamadas.length, 0, 'nao chamou a rede');
  });

  it('duplo clique: a segunda chamada avisa e NAO dispara uma segunda RPC', async () => {
    const h = novo(F.dbEstoqueZero());
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const rpc = h.espiarRpc(async (fn, params) => {
      await espera;
      return { compra: params.p_rep, produto: produtoDoBanco() };
    });

    h.preencher(COMPRA_8x582);
    const primeira = h.escopo.confReposicao();
    const segunda = h.escopo.confReposicao();   // o usuario clica de novo
    liberar();
    await primeira;
    await segunda;

    assertEqual(rpc.length, 1, 'uma RPC so, apesar dos dois cliques');
    assertTrue(algumToast(h, /aguarde/i), 'o segundo clique recebe um aviso');
  });
});

// =============================================================================
describe('Venda — regVenda chama vsp_registrar_venda', () => {

  it('uma chamada com a venda inteira no payload e um op_id nao vazio', async () => {
    const h = novo(dbVenda());
    const rpc = h.espiarRpc({});
    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();

    assertEqual(rpc.length, 1, 'uma venda = uma chamada');
    const c = rpc[0];
    assertEqual(c.fn, 'vsp_registrar_venda', 'a funcao chamada no banco');
    const v = c.params.p_venda;
    assertEqual(v.prod, 'TG', 'produto');
    assertEqual(v.tipo, 'caixa', 'tipo');
    assertEqual(v.qtd, 1, 'quantidade');
    assertClose(v.bruto, 1450.00, 'bruto = qtd x valor final');
    assertClose(v.custo, 582.50, 'custo historico gravado NA venda');
    // o cli_id sai do <select> como TEXTO; o banco converte no cast do jsonb.
    assertEqual(String(v.cli_id), '4001', 'cliente ja cadastrado, sem criar outro');
    assertEqual(h.escopo.DB.clientes.length, 1, 'nenhum cliente duplicado nasceu');
    assertEqual(v.data, '2026-09-15', 'data');
    assertEqual(v.usuario, 'Victor', 'quem vendeu');
    assertTrue(typeof c.op === 'string' && c.op.length > 0, 'p_op_id nao pode ser vazio');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma gravacao direta em tabela');
  });

  it('NAO mexe em p.caixas antes da resposta do banco', async () => {
    const h = novo(dbVenda());
    const rpc = h.espiarRpc({});          // envelope vazio: nada a adotar
    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();

    const p = h.escopo.getProd('TG');
    assertEqual(rpc[0].estoque[0].caixas, 8,
      'no instante da chamada o estoque local ainda era 8 — a baixa e do banco');
    assertEqual(p.caixas, 8, 'e continua 8: o app nao decrementa por conta propria');
    assertEqual(h.escopo.DB.vendas.length, 0,
      'sem venda devolvida pelo banco, nada entra em DB.vendas');
  });

  it('adota o produto e a venda canonicos devolvidos pelo banco', async () => {
    const h = novo(dbVenda());
    h.espiarRpc((fn, params) => ({
      venda: Object.assign({}, params.p_venda),
      produto: produtoDoBanco({ caixas: 7, frascos: 0 }),
    }));
    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();

    const p = h.escopo.getProd('TG');
    assertEqual(p.caixas, 7, 'o estoque passou a ser o do banco');
    assertClose(p.custoCaixa, 777.77, 'o custo tambem vem do banco');
    assertEqual(h.escopo.DB.vendas.length, 1, 'a venda devolvida entrou em DB.vendas');
    assertClose(h.escopo.DB.vendas[0].bruto, 1450.00, 'mapeada pelo mapVenda');
    assertMatch(h.ui.ultimoToast(), /Venda registrada/, 'confirmacao ao usuario');
  });

  it('retry com o mesmo op_id grava UMA venda, nao duas', async () => {
    const h = novo(dbVenda());
    let gravada = null;
    const rpc = h.espiarRpc((fn, params, n) => {
      if (n === 1) { gravada = Object.assign({}, params.p_venda); throw new Error('conexao caiu'); }
      return { repetida: true, venda: gravada, produto: produtoDoBanco({ caixas: 7, frascos: 0 }) };
    });

    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();                     // perdeu a resposta
    assertTrue(algumToast(h, /Não consegui salvar/), 'avisou que nada ficou pela metade');
    assertEqual(h.escopo.DB.vendas.length, 0, 'nada lancado ainda');

    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();                     // o usuario repete
    assertEqual(rpc.length, 2, 'duas chamadas');
    assertEqual(rpc[0].op, rpc[1].op, 'MESMO op_id: o banco reconhece a operacao');
    assertEqual(h.escopo.DB.vendas.length, 1, 'uma venda so');
    assertEqual(h.escopo.DB.vendas[0].id, gravada.id, 'e com o id da PRIMEIRA tentativa');
    assertMatch(h.ui.ultimoToast(), /já estava salva/, 'o usuario e avisado');
  });

  it('resposta repetida:true com linha que ja esta no DB nao empilha', async () => {
    const h = novo(dbVenda({ vendas: [F.vendaSimples({ id: 555, data: '2026-09-10' })] }));
    h.espiarRpc((fn, params) => ({
      repetida: true,
      venda: Object.assign({}, params.p_venda, { id: 555 }),
      produto: produtoDoBanco({ caixas: 7, frascos: 0 }),
    }));
    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();

    assertEqual(h.escopo.DB.vendas.length, 1, 'continua UMA venda');
    assertEqual(h.escopo.DB.vendas[0].id, 555, 'a mesma linha');
  });

  it('estoque insuficiente e barrado no app, sem chamar o banco', async () => {
    const h = novo(dbVenda());
    const rpc = h.espiarRpc({});
    h.preencher(Object.assign({}, CAMPOS_VENDA, { vQtd: '99' }));
    await h.escopo.regVenda();

    assertMatch(h.ui.ultimoToast(), /Estoque insuficiente/, 'mensagem de bloqueio');
    assertEqual(rpc.length, 0, 'nao chamou a RPC');
    assertEqual(h.rede.chamadas.length, 0, 'nem a rede');
  });

  it('duplo clique na venda: uma RPC so', async () => {
    const h = novo(dbVenda());
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const rpc = h.espiarRpc(async (fn, params) => {
      await espera;
      return { venda: params.p_venda, produto: produtoDoBanco({ caixas: 7, frascos: 0 }) };
    });

    h.preencher(CAMPOS_VENDA);
    const primeira = h.escopo.regVenda();
    const segunda = h.escopo.regVenda();
    liberar();
    await primeira;
    await segunda;

    assertEqual(rpc.length, 1, 'uma RPC so, apesar dos dois cliques');
    assertEqual(h.escopo.DB.vendas.length, 1, 'e uma venda so');
    assertTrue(algumToast(h, /aguarde/i), 'o segundo clique recebe um aviso');
  });
});

// =============================================================================
describe('Cancelamento — confirmarCancelamento chama vsp_cancelar_venda', () => {

  function dbCancel() {
    return F.dbMinimo({ vendas: [F.vendaSimples({ id: 777, data: '2026-09-10' })] });
  }

  it('chama com id, motivo, usuario e um op_id nao vazio', async () => {
    const h = novo(dbCancel());
    const rpc = h.espiarRpc({});
    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: 'sem uso' });
    h.confirmar(true);
    await h.escopo.confirmarCancelamento();

    assertEqual(rpc.length, 1, 'uma chamada');
    const c = rpc[0];
    assertEqual(c.fn, 'vsp_cancelar_venda', 'a funcao chamada no banco');
    assertEqual(c.params.p_id, 777, 'o id da venda');
    assertEqual(c.params.p_motivo, 'Cliente desistiu — sem uso',
      'motivo + observacao, como o usuario escreveu');
    assertEqual(c.params.p_usuario, 'Victor', 'quem cancelou');
    assertTrue(typeof c.op === 'string' && c.op.length > 0, 'p_op_id nao pode ser vazio');
    assertEqual(h.rede.chamadas.length, 0, 'sem PATCH direto na venda');
  });

  it('sem motivo, e com o confirm() recusado, nao chama nada', async () => {
    const h = novo(dbCancel());
    const rpc = h.espiarRpc({});
    h.preencher({ cancelVendaId: '777', cancelMotivo: '', cancelObs: '' });
    await h.escopo.confirmarCancelamento();
    assertMatch(h.ui.ultimoToast(), /Selecione o motivo/, 'pede o motivo');
    assertEqual(rpc.length, 0, 'nao chamou o banco');

    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: '' });
    h.confirmar(false);
    await h.escopo.confirmarCancelamento();
    assertEqual(h.ui.confirms.length, 1, 'perguntou');
    assertEqual(rpc.length, 0, 'e desistiu sem chamar o banco');
    assertFalse(h.escopo.DB.vendas[0].cancelada, 'a venda continua ativa');
  });

  it('nao marca a venda como cancelada antes da resposta', async () => {
    const h = novo(dbCancel());
    const rpc = h.espiarRpc({});          // envelope vazio
    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: '' });
    h.confirmar(true);
    await h.escopo.confirmarCancelamento();

    assertEqual(rpc.length, 1, 'a chamada saiu');
    assertFalse(h.escopo.DB.vendas[0].cancelada,
      'sem venda devolvida pelo banco o app nao inventa o cancelamento');
    assertEqual(h.escopo.getProd('TG').caixas, 8, 'e nao devolve estoque por conta propria');
  });

  it('adota a venda e o produto canonicos devolvidos pelo banco', async () => {
    const h = novo(dbCancel());
    h.espiarRpc({
      venda: {
        id: 777, prod: 'TG', tipo: 'caixa', qtd: 1, bruto: 1450, custo: 582.50,
        cancelada: true, cancelada_por: 'Victor', cancelada_em: '15/09/2026 10:00:00',
        cancelada_motivo: 'Cliente desistiu', data: '2026-09-10', pgto: 'pix',
      },
      produto: produtoDoBanco({ caixas: 9, frascos: 0 }),
    });
    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: '' });
    h.confirmar(true);
    await h.escopo.confirmarCancelamento();

    const v = h.escopo.DB.vendas[0];
    assertEqual(h.escopo.DB.vendas.length, 1, 'a venda nao foi duplicada, foi atualizada');
    assertTrue(v.cancelada, 'marcada como cancelada pelo banco');
    assertEqual(v.canceladaPor, 'Victor', 'quem cancelou veio do banco');
    assertEqual(v.canceladaEm, '15/09/2026 10:00:00', 'carimbo do servidor');
    assertEqual(h.escopo.getProd('TG').caixas, 9, 'estoque restaurado pelo banco');
    assertMatch(h.ui.ultimoToast(), /Venda cancelada/, 'confirmacao ao usuario');
  });

  it('resposta repetida:true avisa e nao duplica a venda', async () => {
    const h = novo(dbCancel());
    h.espiarRpc({
      repetida: true,
      venda: { id: 777, prod: 'TG', tipo: 'caixa', qtd: 1, bruto: 1450, cancelada: true, data: '2026-09-10' },
      produto: produtoDoBanco({ caixas: 9, frascos: 0 }),
    });
    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: '' });
    h.confirmar(true);
    await h.escopo.confirmarCancelamento();

    assertEqual(h.escopo.DB.vendas.length, 1, 'uma venda so');
    assertMatch(h.ui.ultimoToast(), /já estava cancelada/, 'o usuario e avisado');
  });

  it('falha na RPC: avisa, e a venda local nao e alterada', async () => {
    const h = novo(dbCancel());
    const rpc = h.espiarRpc(() => { throw new Error('deadlock'); });
    h.preencher({ cancelVendaId: '777', cancelMotivo: 'Cliente desistiu', cancelObs: '' });
    h.confirmar(true);
    await h.escopo.confirmarCancelamento();

    assertEqual(rpc.length, 1, 'tentou');
    assertTrue(algumToast(h, /Não consegui cancelar/), 'avisou o usuario');
    assertTrue(algumToast(h, /Nada foi alterado pela metade/), 'e disse que nada ficou torto');
    assertFalse(h.escopo.DB.vendas[0].cancelada, 'a venda local segue ativa');
  });
});

// =============================================================================
describe('Estorno de compra — estornarCompra chama vsp_estornar_compra', () => {

  it('chama com o id da compra, o usuario e um op_id nao vazio', async () => {
    const h = novo(F.dbEstorno('limpo'));
    const rpc = h.espiarRpc({});
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    assertEqual(rpc.length, 1, 'uma chamada');
    const c = rpc[0];
    assertEqual(c.fn, 'vsp_estornar_compra', 'a funcao chamada no banco');
    assertEqual(c.params.p_id, 3000, 'o id da compra');
    assertEqual(c.params.p_usuario, 'Victor', 'quem estornou');
    assertTrue(typeof c.op === 'string' && c.op.length > 0, 'p_op_id nao pode ser vazio');
    assertEqual(h.rede.por('DELETE', '/reposicoes').length, 0,
      'nao apaga a linha direto: quem apaga e a transacao no banco');
  });

  it('dois estornos seguidos usam op_ids diferentes', async () => {
    const db = F.dbEstorno('limpo');
    // uma segunda compra pequena, que caiba no estoque que sobra depois do 1o estorno
    db.reposicoes.push(Object.assign({}, db.reposicoes[0], {
      id: 3010, qtd: 1, custTotal: 582.50, data: '2026-09-03',
    }));
    const h = novo(db);
    const rpc = h.espiarRpc(() => ({ produto: produtoDoBanco({ caixas: 2, frascos: 0 }) }));
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);
    h.confirmar(true);
    await h.escopo.estornarCompra(3010);

    assertEqual(rpc.length, 2, 'duas operacoes');
    assertFalse(rpc[0].op === rpc[1].op, 'cada estorno e uma operacao propria');
    assertEqual(rpc[1].params.p_id, 3010, 'o id da segunda compra');
  });

  it('adota o produto canonico do banco e tira a compra do historico local', async () => {
    const h = novo(F.dbEstorno('limpo'));
    h.espiarRpc({
      produto: produtoDoBanco({ caixas: 2, frascos: 0, custo_caixa: 500.00, custo_frasco: 125.00 }),
      recalculou_custo: true,
    });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const p = h.escopo.getProd('TG');
    assertEqual(p.caixas, 2, 'estoque devolvido — pelo banco');
    assertClose(p.custoCaixa, 500.00, 'custo da caixa: o que o banco recalculou');
    assertClose(p.custoFrasco, 125.00, 'custo do frasco idem');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'a compra saiu do historico local');
    assertMatch(h.ui.ultimoToast(), /Estoque e custo médio voltaram/,
      'o toast reflete recalculou_custo=true');
  });

  it('quando o banco NAO recalcula o custo, o app nao recalcula nada tampouco', async () => {
    // cenario com venda depois da compra: o banco preserva o custo medio e diz que
    // preservou. O JavaScript nao tem mais opiniao sobre isso.
    const h = novo(F.dbEstorno('vendaDepois'));
    h.espiarRpc({
      produto: produtoDoBanco({ caixas: 0, frascos: 1, custo_caixa: 566.00, custo_frasco: 141.50 }),
      recalculou_custo: false,
    });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const p = h.escopo.getProd('TG');
    assertClose(p.custoFrasco, 141.50, 'o custo ficou o que o banco devolveu');
    assertClose(p.custoCaixa, 566.00, 'idem para a caixa');
    assertMaior(p.custoFrasco, 0, 'custo zerado travaria a venda do produto');
    assertEqual(p.caixas, 0, 'estoque de caixas devolvido pelo banco');
    assertEqual(p.frascos, 1, 'frascos nao sao mexidos numa compra de caixas');
    assertMatch(h.ui.ultimoToast(), /custo médio foi mantido/,
      'o toast reflete recalculou_custo=false');
  });

  it('o aviso do confirm() ainda explica o efeito antes de chamar o banco', async () => {
    const h = novo(F.dbEstorno('limpo'));
    h.espiarRpc({ produto: produtoDoBanco({ caixas: 2, frascos: 0 }) });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const aviso = h.ui.confirms[0];
    assertInclui(aviso, 'Estornar esta compra?', 'cabecalho do aviso');
    assertInclui(aviso, 'volta de R$ 141.50 para R$ 125.00', 'o aviso mostra o custo novo');
    assertInclui(aviso, 'Estoque volta de 10 para 2', 'o aviso mostra o estoque');
    // o aviso e uma PREVISAO local para o usuario decidir; o numero que vale e o que
    // o banco devolve depois. As duas coisas nao podem se contradizer no caso limpo.
  });

  it('e o aviso explica por que o custo nao pode ser recalculado', async () => {
    const h = novo(F.dbEstorno('vendaDepois'));
    h.espiarRpc({ produto: produtoDoBanco({ caixas: 0, frascos: 1, custo_caixa: 566, custo_frasco: 141.5 }) });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const aviso = h.ui.confirms[0];
    assertInclui(aviso, 'continua R$ 141.50', 'o aviso diz que o custo fica');
    assertInclui(aviso, 'houve 1 venda(s)', 'o aviso conta as vendas posteriores');
  });

  it('venda ANTERIOR a compra nao entra na contagem do aviso', async () => {
    const h = novo(F.dbEstorno('limpo')); // venda em 15/08, compra em 02/09
    assertEqual(h.escopo.DB.vendas.length, 1, 'o fixture tem de ter a venda anterior');
    h.espiarRpc({ produto: produtoDoBanco({ caixas: 2, frascos: 0 }) });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const aviso = h.ui.confirms[0];
    assertInclui(aviso, 'volta de R$ 141.50 para R$ 125.00',
      'o aviso promete o recalculo: a venda anterior nao conta');
    assertNaoInclui(aviso, 'houve 1 venda(s)', 'e nao acusa venda posterior que nao existe');
  });

  it('estoque insuficiente: bloqueia, nao mexe em nada e nem chama o banco', async () => {
    const h = novo(F.dbEstorno('insuficiente'));
    const rpc = h.espiarRpc({});
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    const p = h.escopo.getProd('TG');
    assertMatch(h.ui.ultimoToast(), /Não dá para estornar/, 'mensagem de bloqueio');
    assertInclui(h.ui.ultimoToast(), 'o estoque tem 3 caixa(s) e a compra foi de 8',
      'a mensagem diz os numeros');
    assertEqual(rpc.length, 0, 'nao chamou o banco');
    assertEqual(p.caixas, 3, 'estoque intacto');
    assertEqual(p.custoFrasco, 141.50, 'custo intacto');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra continua no historico');
    assertEqual(h.ui.confirms.length, 0, 'nem chegou a perguntar');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma chamada de rede');
  });

  it('se o usuario cancelar o confirm(), nada acontece', async () => {
    const h = novo(F.dbEstorno('limpo'));
    const rpc = h.espiarRpc({});
    h.confirmar(false);
    await h.escopo.estornarCompra(3000);

    const p = h.escopo.getProd('TG');
    assertEqual(h.ui.confirms.length, 1, 'perguntou');
    assertEqual(rpc.length, 0, 'nao chamou o banco');
    assertEqual(p.caixas, 10, 'estoque intacto');
    assertEqual(p.custoFrasco, 141.50, 'custo intacto');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra continua no historico');
    assertEqual(h.rede.chamadas.length, 0, 'nenhuma chamada de rede');
  });

  it('compra inexistente: avisa e sai', async () => {
    const h = novo(F.dbEstorno('limpo'));
    const rpc = h.espiarRpc({});
    await h.escopo.estornarCompra(999999);
    assertMatch(h.ui.ultimoToast(), /Compra não encontrada/, 'mensagem');
    assertEqual(rpc.length, 0, 'nao chamou o banco');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'nada removido');
  });

  it('compra de produto que nao existe mais: avisa e sai', async () => {
    const db = F.dbEstorno('limpo');
    db.reposicoes[0].prod = 'PRODUTO_QUE_SUMIU';
    const h = novo(db);
    const rpc = h.espiarRpc({});
    await h.escopo.estornarCompra(3000);
    assertMatch(h.ui.ultimoToast(), /produto desta compra não existe mais/, 'mensagem');
    assertEqual(rpc.length, 0, 'nao chamou o banco');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'nada removido');
  });

  it('saida automatica legada (id = compra+1, mesmo valor) sai junto', async () => {
    // caminho de compatibilidade: compras lancadas antes de 15/09 podiam ter criado
    // uma saida "ja paguei" com id sequencial. Quem apaga no banco e a transacao do
    // estorno; aqui se prova que o app tira a linha do estado local e avisa antes.
    const db = F.dbEstorno('limpo');
    db.saidas = [{
      id: 3001, tipo: 'fornecedor', socio: 'Victor',
      desc: 'Compra de estoque (lancada junto)', data: '2026-09-02',
      val: 4660.00, pgto: 'pix',
    }];
    const h = novo(db);
    h.espiarRpc({ produto: produtoDoBanco({ caixas: 2, frascos: 0 }) });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    assertInclui(h.ui.confirms[0], 'saída de R$ 4660.00', 'o aviso menciona a saida');
    assertEqual(h.escopo.DB.saidas.length, 0, 'a saida saiu do estado local');
    assertEqual(h.rede.por('DELETE', '/saidas').length, 0,
      'sem DELETE avulso: a exclusao acontece dentro da transacao do estorno');
  });

  it('falha na RPC: avisa, e nem a compra nem o estoque local mudam', async () => {
    const h = novo(F.dbEstorno('limpo'));
    const rpc = h.espiarRpc(() => { throw new Error('serializacao'); });
    h.confirmar(true);
    await h.escopo.estornarCompra(3000);

    assertEqual(rpc.length, 1, 'tentou');
    assertTrue(algumToast(h, /Não consegui estornar/), 'avisou o usuario');
    assertTrue(algumToast(h, /Nada foi alterado/), 'e disse que nada mudou');
    assertEqual(h.escopo.DB.reposicoes.length, 1, 'a compra continua no historico');
    assertEqual(h.escopo.getProd('TG').caixas, 10, 'estoque intacto');
  });
});
