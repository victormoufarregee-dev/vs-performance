'use strict';
/* =============================================================================
 * fila.test.js — fila offline persistente de intencoes
 * =============================================================================
 *
 *   PROVA — com o JavaScript REAL do index.html e um IndexedDB em memoria que
 *            garante o que o navegador garante (transacao atomica, serializada,
 *            assincrona; ver criarIndexedDB no harness):
 *            - a venda offline e GRAVADA e RELIDA antes de o app dizer "Salvo neste
 *              aparelho", e nunca e anunciada como registrada/sincronizada antes do 200;
 *            - ela sobrevive a recarregar a pagina e a fechar/abrir (outra carga do
 *              harness sobre o mesmo IndexedDB);
 *            - o op_id nasce uma vez e e o mesmo em todas as tentativas;
 *            - clique duplo, reenvio de algo que o servidor ja gravou, estoque que
 *              acabou, prazo estourado, 401/403, payload invalido, dois trabalhadores
 *              ao mesmo tempo, ordem e dependencia, offline prolongado, fila antiga
 *              (vsp_fila_v1) e armazenamento que recusa gravar.
 *
 *   NAO PROVA — o IndexedDB de verdade de cada navegador (isso foi exercitado no
 *            Chromium, ver OFFLINE_FILA.md), nem a RPC por dentro: o servidor aqui e
 *            um `fetch` falso que responde o que o caso mandar. A idempotencia real
 *            por op_id e provada em SQL (migrations/APLICADO.md).
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

const BANCO = 'vsp_offline';
const STORE = 'intencoes';
const ESTOQUE_ACABOU = {
  code: 'P0001',
  message: 'Estoque insuficiente de TG: tem 0 caixa(s) e 0 frasco(s) (= 0 frasco(s) equivalentes) e a venda pede 1 caixa(s).',
};

const CAMPOS_VENDA = {
  vProd: 'TG', vTipo: 'caixa', vQtd: '1', vValOrig: '1450', vDesc: '0',
  vData: '2026-09-17', vObs: '', vPgto: 'pix', vTaxa: '0', vTaxaQuem: 'nos',
  vCliSel: '4001', vCliNome: '', vCliWpp: '', vLote: '',
};

function dbVenda(caixas) {
  return F.dbMinimo({
    produtos: [F.produtoTG({ caixas: caixas == null ? 8 : caixas })],
    clientes: [{ id: 4001, nome: 'Cliente Teste', tel: '11999990000', obs: '' }],
  });
}

const tique = () => new Promise((r) => setImmediate(r));
async function ate(cond, msg) {
  for (let i = 0; i < 2000; i++) { if (cond()) return; await tique(); }
  throw new Error('esperei demais: ' + (msg || 'condicao'));
}

function resposta(status, corpo) {
  const texto = corpo === undefined ? '' : JSON.stringify(corpo);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: () => 'application/json' },
    async json() { return texto ? JSON.parse(texto) : null; },
    async text() { return texto; },
  };
}

/**
 * Uma "aba" do app: carga nova do index.html sobre o armazenamento compartilhado.
 * `armazem` = { idb, ls } — o mesmo objeto em duas abas = mesma origem no navegador.
 */
async function abrirAba(armazem, opts) {
  opts = opts || {};
  const h = H.carregar({ indexedDB: armazem.idb, guardaLS: armazem.ls, lsQuebrado: opts.lsQuebrado });
  h.logarComo(opts.usuario || 'Victor');
  h.carregarDB(dbVenda(opts.caixas));
  h.sincronizacoes = 0;
  h.escrever('sincronizar', async () => { h.sincronizacoes++; });
  // a carga do app ja disparou filaIniciar() (sem sessao, entao sem envio automatico);
  // aqui so espera ela terminar — iniciar de novo faria duas migracoes ao mesmo tempo
  await h.escopo.filaIniciar();
  await h.escopo.filaRecarregar();
  h.escrever('authToken', opts.semSessao ? '' : 'token-de-teste');
  return h;
}
function novoArmazem() { return { idb: H.criarIndexedDB(), ls: new Map() }; }
function registros(armazem) { return armazem.idb.registros(BANCO, STORE); }
function offline(h) { h.ctx.navigator.onLine = false; }
function online(h) { h.ctx.navigator.onLine = true; }

/** Servidor falso. `fn(chamada, n)` devolve {status, corpo} | 'rede' | 'pendurar'. */
function servidor(h, fn) {
  const chamadas = [];
  h.ctx.fetch = async (url, o) => {
    const c = {
      url: String(url), metodo: ((o && o.method) || 'GET').toUpperCase(),
      corpo: o && o.body ? JSON.parse(o.body) : null, signal: o && o.signal,
    };
    c.op = c.corpo && c.corpo.p_op_id;
    chamadas.push(c);
    const r = await fn(c, chamadas.length);
    if (r === 'rede') throw new TypeError('Failed to fetch');
    if (r === 'pendurar') {
      return new Promise((_, nok) => {
        if (c.signal) c.signal.addEventListener('abort', () => nok(new Error('AbortError')));
      });
    }
    return resposta(r.status || 200, r.corpo);
  };
  chamadas.rpc = () => chamadas.filter((c) => /\/rpc\//.test(c.url));
  return chamadas;
}

async function vendaOffline(h, campos) {
  offline(h);
  h.preencher(Object.assign({}, CAMPOS_VENDA, campos || {}));
  await h.escopo.regVenda();
}

async function rodarFila(h, manual) {
  online(h);
  const r = await h.escopo.processarFila(!!manual);
  return r;
}

// =============================================================================
describe('Fila offline — a venda offline e guardada de verdade', () => {

  it('offline: grava a intencao no IndexedDB ANTES de dizer "Salvo neste aparelho"', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    const rede = servidor(h, () => 'rede');
    await vendaOffline(h);

    const regs = registros(arm);
    assertEqual(regs.length, 1, 'uma intencao no IndexedDB');
    const it = regs[0];
    assertEqual(it.tipo, 'venda', 'tipo');
    assertEqual(it.status, 'pendente', 'nasce pendente');
    assertTrue(typeof it.op_id === 'string' && it.op_id.length > 5, 'op_id presente');
    assertEqual(it.versao_payload, 1, 'versao do payload');
    assertEqual(it.usuario, 'Victor', 'quem lancou');
    assertEqual(it.payload.p_venda.qtd, 1, 'payload da venda');
    assertEqual(it.payload.p_venda.prod, 'TG', 'produto');
    assertTrue(!!it.criado_em && !!it.atualizado_em, 'datas');
    assertEqual(it.tentativas, 0, 'nenhuma tentativa ainda');
    assertTrue(h.ui.toasts().some((t) => /Salvo neste aparelho/.test(t)), 'avisou que ficou no aparelho');
    assertFalse(h.ui.toasts().some((t) => /Venda registrada|registrada!/.test(t)), 'NAO anunciou venda registrada');
    assertEqual(h.escopo.DB.vendas.length, 0, 'nao inventou venda na lista');
    assertEqual(h.escopo.DB.produtos[0].caixas, 8, 'nao mexeu no estoque local');
    assertEqual(rede.rpc().length, 0, 'offline declarado: nem tentou a rede');
  });

  it('a rede cai NO MEIO da tentativa direta: guarda com o MESMO op_id da tentativa', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    const rede = servidor(h, () => 'rede');
    online(h);
    h.preencher(CAMPOS_VENDA);
    await h.escopo.regVenda();

    assertEqual(rede.rpc().length, 1, 'tentou direto uma vez');
    const regs = registros(arm);
    assertEqual(regs.length, 1, 'guardou a intencao');
    assertEqual(regs[0].op_id, rede.rpc()[0].op, 'o op_id guardado e o da tentativa que caiu');
    assertTrue(h.ui.toasts().some((t) => /Salvo neste aparelho/.test(t)), 'mensagem de guardado');
    assertFalse(h.ui.toasts().some((t) => /Venda registrada/.test(t)), 'sem sucesso falso');
  });

  it('sobrevive a recarregar a pagina: a aba nova le a mesma intencao, com o mesmo op_id', async () => {
    const arm = novoArmazem();
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    await vendaOffline(h1);
    const op = registros(arm)[0].op_id;

    const h2 = await abrirAba(arm);          // "F5": nova carga, memoria zerada
    assertEqual(h2.escopo.fila.length, 1, 'a fila da aba nova tem a venda');
    assertEqual(h2.escopo.fila[0].op_id, op, 'mesmo op_id');
    assertEqual(h2.escopo.fila[0].status, 'pendente', 'ainda pendente');
  });

  it('sobrevive a fechar e reabrir sem sessao: fica guardada ate alguem entrar', async () => {
    const arm = novoArmazem();
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    await vendaOffline(h1);

    const h2 = await abrirAba(arm, { semSessao: true });
    const rede = servidor(h2, () => ({ status: 200, corpo: {} }));
    const r = await rodarFila(h2);
    assertEqual(r, 'sem-sessao', 'sem sessao nao envia');
    assertEqual(rede.length, 0, 'nenhuma chamada');
    assertEqual(registros(arm)[0].status, 'pendente', 'continua guardada');
    assertMatch(h2.ui.html('offBar'), /Entre no app para enviar/, 'a barra explica o que falta');
  });

  it('armazenamento recusando gravar: NAO diz que salvou, mantem o formulario e o op_id', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    arm.idb.falharProximaEscrita();
    await vendaOffline(h);

    assertEqual(registros(arm).length, 0, 'nada guardado');
    assertFalse(h.ui.toasts().some((t) => /Salvo neste aparelho|Venda registrada/.test(t)), 'nenhum sucesso anunciado');
    assertTrue(h.ui.toasts().some((t) => /NÃO foi registrada/.test(t)), 'avisou que NAO registrou');
    assertEqual(h.ui.valor('vValOrig'), '1450', 'formulario preservado para tentar de novo');
    assertTrue(!!h.escopo.regVenda._op, 'op_id preservado para a proxima tentativa');
  });

  it('sem IndexedDB e sem localStorage: recusa com aviso, nada e prometido', async () => {
    const arm = { idb: undefined, ls: new Map() };
    const h = await abrirAba(arm, { lsQuebrado: true });
    servidor(h, () => 'rede');
    assertEqual(h.escopo.armazemFila.modo(), 'nenhum', 'detectou que nao ha onde guardar');
    await vendaOffline(h);
    assertFalse(h.ui.toasts().some((t) => /Salvo neste aparelho|Venda registrada/.test(t)), 'nenhum sucesso anunciado');
    assertMatch(h.ui.html('offBar'), /não está deixando o app guardar dados/, 'barra avisa');
  });

  it('sem IndexedDB mas com localStorage: guarda uma chave por intencao e sobrevive ao reload', async () => {
    const arm = { idb: undefined, ls: new Map() };
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    assertEqual(h1.escopo.armazemFila.modo(), 'ls', 'caiu no localStorage');
    await vendaOffline(h1);
    const chaves = [...arm.ls.keys()].filter((k) => k.startsWith('vsp_fila2:'));
    assertEqual(chaves.length, 1, 'uma chave por intencao (nao um array inteiro)');
    const h2 = await abrirAba(arm);
    assertEqual(h2.escopo.fila.length, 1, 'recarregou a intencao');
  });

  it('duas abas guardando ao mesmo tempo NAO apagam a venda uma da outra', async () => {
    const arm = novoArmazem();
    const a = await abrirAba(arm);
    const b = await abrirAba(arm);
    servidor(a, () => 'rede');
    servidor(b, () => 'rede');
    await Promise.all([vendaOffline(a), vendaOffline(b, { vValOrig: '1300' })]);
    const regs = registros(arm);
    assertEqual(regs.length, 2, 'as duas vendas estao guardadas');
    assertTrue(regs[0].op_id !== regs[1].op_id, 'op_ids distintos');
  });
});

// =============================================================================
describe('Fila offline — clique duplo e mesma intencao', () => {

  it('clique duplo offline guarda UMA intencao', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    offline(h);
    h.preencher(CAMPOS_VENDA);
    await Promise.all([h.escopo.regVenda(), h.escopo.regVenda()]);
    assertEqual(registros(arm).length, 1, 'uma so');
    assertTrue(h.ui.toasts().some((t) => /Já estou salvando/.test(t)), 'o segundo clique foi barrado');
  });

  it('guardar de novo o mesmo tipo + op_id devolve a intencao existente', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    const a = await h.escopo.filaGuardar('venda', 'op-fixo', { p_venda: { prod: 'TG', qtd: 1, tipo: 'caixa' } });
    const b = await h.escopo.filaGuardar('venda', 'op-fixo', { p_venda: { prod: 'TG', qtd: 1, tipo: 'caixa' } });
    assertEqual(registros(arm).length, 1, 'nao duplicou');
    assertEqual(a.id_local, b.id_local, 'mesma intencao');
  });

  it('a ultima caixa nao pode ser vendida duas vezes offline no mesmo aparelho', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm, { caixas: 1 });
    servidor(h, () => 'rede');
    await vendaOffline(h);
    await vendaOffline(h, { vValOrig: '1300' });
    assertEqual(registros(arm).length, 1, 'so a primeira ficou guardada');
    assertMatch(h.ui.ultimoToast(), /Estoque insuficiente — já há venda/, 'explica o motivo');
  });
});

// =============================================================================
describe('Fila offline — envio, confirmacao e retry', () => {

  it('reconexao: envia, so confirma com 200 e o op_id enviado e o guardado', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const op = registros(arm)[0].op_id;

    let statusNaHoraDoEnvio = null;
    let barraNaHoraDoEnvio = null;
    const rede = servidor(h, (c) => {
      statusNaHoraDoEnvio = registros(arm)[0].status;
      barraNaHoraDoEnvio = h.ui.html('offBar');
      return { status: 200, corpo: { venda: Object.assign({}, c.corpo.p_venda, { id: 91 }), repetida: false } };
    });
    const placar = await rodarFila(h);

    assertEqual(rede.rpc().length, 1, 'uma chamada');
    assertMatch(rede.rpc()[0].url, /rpc\/vsp_registrar_venda$/, 'pela RPC transacional');
    assertEqual(rede.rpc()[0].op, op, 'o op_id guardado');
    assertEqual(statusNaHoraDoEnvio, 'enviando', 'marcou enviando antes de enviar');
    assertMatch(barraNaHoraDoEnvio, /Sincronizando/, 'a barra mostra Sincronizando… durante o envio');
    const it = registros(arm)[0];
    assertEqual(it.status, 'confirmado', 'confirmado so depois do 200');
    assertEqual(it.tentativas, 1, 'uma tentativa');
    assertEqual(it.resultado.venda_id, 91, 'guardou o resultado do servidor');
    assertEqual(placar.confirmados, 1, 'placar');
    assertTrue(h.ui.toasts().some((t) => /confirmadas pelo servidor/.test(t)), 'avisou a confirmacao');
    assertEqual(h.sincronizacoes, 1, 'recarregou os dados do banco depois');
  });

  it('servidor ja tinha gravado (repetida:true): confirma sem duplicar', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const rede = servidor(h, () => ({ status: 200, corpo: { repetida: true, venda: { id: 91 } } }));
    await rodarFila(h);
    assertEqual(rede.rpc().length, 1, 'uma chamada');
    assertEqual(registros(arm)[0].status, 'confirmado', 'confirmado');
    assertTrue(registros(arm)[0].resultado.repetida, 'marcado como repetida');
    await rodarFila(h);
    assertEqual(rede.rpc().length, 1, 'confirmado nao e reenviado');
  });

  it('o op_id e o MESMO em todas as tentativas (rede, 503, sucesso)', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const op = registros(arm)[0].op_id;
    const rede = servidor(h, (c, n) => (n === 1 ? 'rede' : n === 2 ? { status: 503, corpo: { message: 'indisponivel' } } : { status: 200, corpo: {} }));
    await rodarFila(h, true);
    assertEqual(registros(arm)[0].status, 'pendente', 'queda de rede: continua pendente');
    await rodarFila(h, true);
    assertEqual(registros(arm)[0].status, 'pendente', '503: continua pendente');
    assertEqual(registros(arm)[0].erro_tipo, 'transitorio', 'classificado como transitorio');
    await rodarFila(h, true);
    assertEqual(registros(arm)[0].status, 'confirmado', 'terceira confirma');
    assertEqual(rede.rpc().length, 3, 'tres tentativas');
    rede.rpc().forEach((c, i) => assertEqual(c.op, op, 'tentativa ' + (i + 1) + ' com o op_id original'));
    assertEqual(registros(arm)[0].tentativas, 3, 'contou as tentativas');
  });

  it('transitorio respeita espera: o trabalhador automatico nao martela o servidor', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const rede = servidor(h, () => ({ status: 500, corpo: { message: 'erro' } }));
    await rodarFila(h);
    const depois = registros(arm)[0];
    assertTrue(Date.parse(depois.proxima_tentativa_em) > Date.now(), 'agendou a proxima tentativa no futuro');
    await rodarFila(h);                       // automatico, antes da hora
    assertEqual(rede.rpc().length, 1, 'nao reenviou antes da hora');
    await rodarFila(h, true);                 // "Enviar agora" ignora a espera
    assertEqual(rede.rpc().length, 2, 'manual reenviou');
  });

  it('prazo estourado (servidor nao responde): volta a pendente, com a mensagem certa', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    h.ctx.AbortController = AbortController;
    servidor(h, () => 'pendurar');
    online(h);
    const rodada = h.escopo.processarFila(true);
    let prazo = null;
    await ate(() => (prazo = h.ui.timers.find((t) => t.ms === h.escopo.SB_PRAZO_ESCRITA_MS)), 'timer do prazo');
    assertEqual(registros(arm)[0].status, 'enviando', 'estava enviando');
    prazo.fn();                               // o prazo de 20 s "passa"
    await rodada;
    const it = registros(arm)[0];
    assertEqual(it.status, 'pendente', 'volta a pendente, nao some e nao falha');
    assertMatch(it.ultimo_erro, /demorou demais/, 'explica que foi o prazo');
    assertEqual(it.tentativas, 1, 'contou a tentativa');
  });

  it('offline prolongado: dezenas de quedas de rede nunca viram falha nem apagam', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    for (let i = 0; i < 30; i++) await rodarFila(h, true);
    const it = registros(arm)[0];
    assertEqual(registros(arm).length, 1, 'continua la');
    assertEqual(it.status, 'pendente', 'continua pendente');
    assertEqual(it.tentativas, 30, '30 tentativas');
    assertTrue(!it.tentativas_servidor, 'queda de rede nao conta como recusa do servidor');
  });

  it('5xx repetido para de insistir sozinho e pede atencao', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    servidor(h, () => ({ status: 502, corpo: {} }));
    for (let i = 0; i < 12; i++) await rodarFila(h, true);
    assertEqual(registros(arm)[0].status, 'falhou', 'depois de 12 recusas, falhou');
  });
});

// =============================================================================
describe('Fila offline — recusas definitivas', () => {

  it('estoque acabou enquanto estava offline: conflito, nao some, nao repete sozinho', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const rede = servidor(h, () => ({ status: 400, corpo: ESTOQUE_ACABOU }));
    const placar = await rodarFila(h);
    const it = registros(arm)[0];
    assertEqual(it.status, 'conflito', 'virou conflito');
    assertMatch(it.ultimo_erro, /o estoque mudou enquanto você estava offline/, 'mensagem em linguagem simples');
    assertEqual(placar.confirmados, 0, 'nada confirmado');
    assertFalse(h.ui.toasts().some((t) => /confirmadas pelo servidor/.test(t)), 'nenhum sucesso anunciado');
    await rodarFila(h);
    await rodarFila(h, true);
    assertEqual(rede.rpc().length, 1, 'nao reenviou sozinho, nem no "Enviar agora"');
    assertEqual(registros(arm).length, 1, 'continua guardado para o usuario decidir');
    assertMatch(h.ui.html('offBar'), /precisa\(m\) da sua atenção/, 'barra pede atencao');
  });

  it('um conflito NAO bloqueia a venda independente que vem depois (FIFO sem trava de cabeca)', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    await vendaOffline(h, { vValOrig: '1300' });
    const [primeira, segunda] = registros(arm).sort((a, b) => a.seq - b.seq);
    const ordem = [];
    servidor(h, (c) => {
      ordem.push(c.op);
      return c.op === primeira.op_id ? { status: 400, corpo: ESTOQUE_ACABOU } : { status: 200, corpo: {} };
    });
    await rodarFila(h);
    assertEqual(ordem.join(','), primeira.op_id + ',' + segunda.op_id, 'enviou na ordem em que foram lancadas');
    const porOp = {};
    registros(arm).forEach((r) => { porOp[r.op_id] = r.status; });
    assertEqual(porOp[primeira.op_id], 'conflito', 'a primeira em conflito');
    assertEqual(porOp[segunda.op_id], 'confirmado', 'a segunda passou');
  });

  it('401/403 (sessao sem permissao): falhou, sem retry infinito', async () => {
    for (const status of [401, 403]) {
      const arm = novoArmazem();
      const h = await abrirAba(arm);
      servidor(h, () => 'rede');
      await vendaOffline(h);
      const rede = servidor(h, () => ({ status, corpo: { message: 'permission denied' } }));
      await rodarFila(h);
      await rodarFila(h);
      await rodarFila(h, true);
      assertEqual(registros(arm)[0].status, 'falhou', status + ': falhou');
      assertMatch(registros(arm)[0].ultimo_erro, /Entre no app de novo/, status + ': diz o que fazer');
      assertEqual(rede.rpc().length, 1, status + ': uma tentativa so');
    }
  });

  it('payload invalido e produto inexistente: falhou (nao conflito, nao retry)', async () => {
    const casos = [
      { status: 400, corpo: { code: 'P0001', message: 'Quantidade tem de ser maior que zero.' } },
      { status: 409, corpo: { code: '23503', message: 'Produto XYZ nao existe.' } },
    ];
    for (const caso of casos) {
      const arm = novoArmazem();
      const h = await abrirAba(arm);
      servidor(h, () => 'rede');
      await vendaOffline(h);
      const rede = servidor(h, () => caso);
      await rodarFila(h);
      await rodarFila(h, true);
      const it = registros(arm)[0];
      assertEqual(it.status, 'falhou', caso.corpo.message + ': falhou');
      assertInclui(it.ultimo_erro, caso.corpo.message, 'mostra o motivo do servidor');
      assertEqual(rede.rpc().length, 1, 'nao insistiu');
    }
  });

  it('"Tentar de novo" num conflito reenvia com o MESMO op_id (ex.: chegou mercadoria)', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const op = registros(arm)[0].op_id;
    const rede = servidor(h, (c, n) => (n === 1 ? { status: 400, corpo: ESTOQUE_ACABOU } : { status: 200, corpo: {} }));
    await rodarFila(h);
    online(h);
    await h.escopo.tentarIntencao(registros(arm)[0].id_local);
    assertEqual(registros(arm)[0].status, 'confirmado', 'confirmou na segunda');
    assertEqual(rede.rpc()[1].op, op, 'mesmo op_id');
  });

  it('cancelar a intencao apaga so do aparelho, com confirmacao', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    servidor(h, () => ({ status: 400, corpo: ESTOQUE_ACABOU }));
    await rodarFila(h);
    h.confirmar(false);
    await h.escopo.cancelarIntencao(registros(arm)[0].id_local);
    assertEqual(registros(arm).length, 1, 'recusou o confirm: nada apagado');
    h.confirmar(true);
    await h.escopo.cancelarIntencao(registros(arm)[0].id_local);
    assertEqual(registros(arm).length, 0, 'apagou');
    assertMatch(h.ui.confirms[h.ui.confirms.length - 1], /NÃO será enviada/, 'avisou que nao sera enviada');
  });
});

// =============================================================================
describe('Fila offline — um trabalhador so, ordem e dependencia', () => {

  it('duas abas processando ao mesmo tempo enviam cada intencao UMA vez', async () => {
    const arm = novoArmazem();
    const a = await abrirAba(arm);
    servidor(a, () => 'rede');
    await vendaOffline(a);
    await vendaOffline(a, { vValOrig: '1300' });
    const b = await abrirAba(arm);
    const enviados = [];
    const lento = async (c) => { enviados.push(c.op); await tique(); await tique(); return { status: 200, corpo: {} }; };
    servidor(a, lento);
    servidor(b, lento);
    online(a); online(b);
    await Promise.all([a.escopo.processarFila(true), b.escopo.processarFila(true)]);
    assertEqual(enviados.length, 2, 'duas intencoes, dois envios — nenhum em dobro');
    assertEqual(new Set(enviados).size, 2, 'sem repeticao');
    assertTrue(registros(arm).every((r) => r.status === 'confirmado'), 'as duas confirmadas');
  });

  it('dentro da mesma aba, uma segunda rodada simultanea nao comeca', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    const rede = servidor(h, async () => { await tique(); return { status: 200, corpo: {} }; });
    online(h);
    const [r1, r2] = await Promise.all([h.escopo.processarFila(true), h.escopo.processarFila(true)]);
    assertEqual(rede.rpc().length, 1, 'um envio');
    assertEqual(r2, 'ocupado', 'a segunda rodada devolveu ocupado');
    assertEqual(r1.confirmados, 1, 'a primeira confirmou');
  });

  it('"enviando" orfao (aba fechou no meio) volta a ser enviado, com o mesmo op_id', async () => {
    const arm = novoArmazem();
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    await vendaOffline(h1);
    const id = registros(arm)[0].id_local;
    await h1.escopo.armazemFila.atualizar(id, (a) => Object.assign({}, a, {
      status: 'enviando', dono: 'aba-morta', ultima_tentativa_em: new Date(Date.now() - 10 * 60e3).toISOString(),
    }));
    const h2 = await abrirAba(arm);
    const rede = servidor(h2, () => ({ status: 200, corpo: { repetida: true } }));
    await rodarFila(h2, true);
    assertEqual(rede.rpc().length, 1, 'reenviou');
    assertEqual(rede.rpc()[0].op, registros(arm)[0].op_id, 'mesmo op_id (o banco reconhece se ja gravou)');
    assertEqual(registros(arm)[0].status, 'confirmado', 'confirmado');
  });

  it('"enviando" recente de outra aba viva NAO e tomado', async () => {
    const arm = novoArmazem();
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    await vendaOffline(h1);
    const id = registros(arm)[0].id_local;
    await h1.escopo.armazemFila.atualizar(id, (a) => Object.assign({}, a, {
      status: 'enviando', dono: 'aba-viva', ultima_tentativa_em: new Date().toISOString(),
    }));
    const h2 = await abrirAba(arm);
    const rede = servidor(h2, () => ({ status: 200, corpo: {} }));
    await rodarFila(h2, true);
    assertEqual(rede.rpc().length, 0, 'nao mexeu no que outra aba esta enviando');
  });

  it('cliente novo offline: o cadastro vai antes e a venda depende dele', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h, { vCliSel: '', vCliNome: 'Maria Nova', vCliWpp: '11977776666' });
    const regs = registros(arm).sort((a, b) => a.seq - b.seq);
    assertEqual(regs.map((r) => r.tipo).join(','), 'cliente,venda', 'duas intencoes, cliente primeiro');
    assertEqual(regs[1].depende_de[0], regs[0].id_local, 'a venda depende do cadastro');
    assertEqual(regs[1].payload.p_venda.cli_id, regs[0].payload.id, 'a venda aponta para o id do cliente novo');
    assertTrue(h.escopo.DB.clientes.some((c) => c.nome === 'Maria Nova' && c._pendente), 'cliente aparece como pendente na lista');

    const ordem = [];
    servidor(h, (c) => { ordem.push(c.url.includes('/rpc/') ? 'venda' : 'cliente'); return { status: 201, corpo: [c.corpo] }; });
    await rodarFila(h);
    assertEqual(ordem.join(','), 'cliente,venda', 'enviou na ordem da dependencia');
    assertTrue(registros(arm).every((r) => r.status === 'confirmado'), 'os dois confirmados');
  });

  it('cadastro do cliente recusado: a venda que depende dele falha, sem ser enviada', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h, { vCliSel: '', vCliNome: 'Maria Nova', vCliWpp: '11977776666' });
    const rede = servidor(h, () => ({ status: 400, corpo: { message: 'new row violates check constraint' } }));
    await rodarFila(h);
    const porTipo = {};
    registros(arm).forEach((r) => { porTipo[r.tipo] = r; });
    assertEqual(porTipo.cliente.status, 'falhou', 'cadastro falhou');
    assertEqual(porTipo.venda.status, 'falhou', 'venda nao foi adiante');
    assertEqual(rede.rpc().length, 0, 'a venda nunca foi enviada');
    assertMatch(porTipo.venda.ultimo_erro, /não foi concluída/, 'explica a dependencia');
  });

  it('409 no cadastro: so confirma se o cliente existente for o MESMO (telefone bate)', async () => {
    for (const [tel, esperado] of [['11977776666', 'confirmado'], ['11900000000', 'conflito']]) {
      const arm = novoArmazem();
      const h = await abrirAba(arm);
      servidor(h, () => 'rede');
      await vendaOffline(h, { vCliSel: '', vCliNome: 'Maria Nova', vCliWpp: '11977776666' });
      servidor(h, (c) => {
        if (c.metodo === 'POST' && /\/clientes$/.test(c.url)) return { status: 409, corpo: { code: '23505' } };
        if (c.metodo === 'GET') return { status: 200, corpo: [{ id: 1, nome: 'x', tel }] };
        return { status: 200, corpo: {} };
      });
      await rodarFila(h);
      const cli = registros(arm).find((r) => r.tipo === 'cliente');
      assertEqual(cli.status, esperado, 'telefone ' + tel + ' -> ' + esperado);
    }
  });

  it('intencao de outra pessoa espera o login dela', async () => {
    const arm = novoArmazem();
    const h1 = await abrirAba(arm);
    servidor(h1, () => 'rede');
    await vendaOffline(h1);
    const h2 = await abrirAba(arm, { usuario: 'Stefany' });
    const rede = servidor(h2, () => ({ status: 200, corpo: {} }));
    await rodarFila(h2, true);
    assertEqual(rede.rpc().length, 0, 'nao enviou a venda do Victor com a sessao da Stefany');
    assertEqual(registros(arm)[0].status, 'pendente', 'continua pendente');
  });
});

// =============================================================================
describe('Fila offline — tela nunca mostra sincronizado antes da hora', () => {

  it('pendente: barra e painel dizem "guardado", nunca confirmado/sincronizado', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    h.escopo.renderOffBar();
    h.escopo.abrirFila();
    const barra = h.ui.html('offBar');
    const painel = h.ui.html('filaBody');
    assertMatch(barra, /1 operação\(ões\) salvas neste aparelho/, 'barra conta a pendente');
    assertMatch(painel, /Guardado neste aparelho/, 'painel diz guardado');
    assertFalse(/confirmad|sincronizad/i.test(barra), 'barra nao diz confirmado/sincronizado');
    assertFalse(/confirmad|sincronizad/i.test(painel.replace(/Confirmado pelo servidor<\/strong>/, '')), 'painel nao diz confirmado');
    assertMatch(painel, /Cancelar esta operação/, 'acao de cancelar');
    assertMatch(painel, /Tentar de novo/, 'acao de tentar de novo');
    assertInclui(painel, registros(arm)[0].op_id, 'contexto: codigo da operacao');
  });

  it('confirmado: some da barra e aparece em "Enviados recentemente"', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    await vendaOffline(h);
    servidor(h, () => ({ status: 200, corpo: {} }));
    await rodarFila(h);
    h.escopo.renderFilaModal();
    assertEqual(h.escopo.filaAbertos().length, 0, 'nada aberto');
    assertMatch(h.ui.html('filaBody'), /Enviados recentemente \(1\)/, 'lista de enviados');
    assertMatch(h.ui.html('filaBody'), /Confirmado pelo servidor/, 'status certo');
  });

  it('o payload guardado nao vaza HTML no painel', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    await h.escopo.filaGuardar('venda', 'op-x', { p_venda: { prod: 'TG', qtd: 1, tipo: 'caixa' } }, { resumo: '<img src=x onerror=alert(1)>' });
    h.escopo.renderFilaModal();
    assertNaoInclui(h.ui.html('filaBody'), '<img', 'escapado');
  });
});

// =============================================================================
describe('Fila offline — fila antiga, limpeza e o que NAO vai para a fila', () => {

  it('migra a vsp_fila_v1: venda vira intencao pendente com o op_id original; PATCH antigo fica para revisao', async () => {
    const arm = novoArmazem();
    const URL = 'https://sfgpwunpcrigdhlgrgdq.supabase.co/rest/v1/';
    arm.ls.set('vsp_fila_v1', JSON.stringify([
      { url: URL + 'rpc/vsp_registrar_venda', method: 'POST', body: JSON.stringify({ p_venda: { prod: 'TG', tipo: 'caixa', qtd: 1, cliente: 'Ana', val_orig: 1450 }, p_op_id: 'op-antigo-1' }), quando: '16/09/2026 10:00:00', erro: '' },
      { url: URL + 'produtos?id=eq.TG', method: 'PATCH', body: '{"caixas":3}', quando: '16/09/2026 10:01:00', erro: '' },
    ]));
    const h = await abrirAba(arm);
    const regs = registros(arm).sort((a, b) => a.seq - b.seq);
    assertEqual(regs.length, 2, 'as duas migradas');
    assertEqual(regs[0].tipo, 'venda', 'venda reconhecida');
    assertEqual(regs[0].op_id, 'op-antigo-1', 'op_id original preservado');
    assertEqual(regs[0].status, 'pendente', 'venda segue para envio');
    assertEqual(regs[1].tipo, 'legado', 'PATCH vira legado');
    assertEqual(regs[1].status, 'falhou', 'legado NAO e enviado sozinho');
    assertFalse(arm.ls.has('vsp_fila_v1'), 'chave antiga removida depois de migrar tudo');

    const rede = servidor(h, () => ({ status: 200, corpo: {} }));
    await rodarFila(h);
    assertEqual(rede.length, 1, 'so a venda foi enviada');
    assertEqual(rede[0].op, 'op-antigo-1', 'com o op_id antigo');
  });

  it('fila antiga corrompida nao derruba o app', async () => {
    const arm = novoArmazem();
    arm.ls.set('vsp_fila_v1', '{isto nao e json');
    const h = await abrirAba(arm);
    assertEqual(h.escopo.fila.length, 0, 'fila vazia');
  });

  it('migracao que nao consegue gravar mantem a chave antiga (nada se perde)', async () => {
    const arm = novoArmazem();
    arm.ls.set('vsp_fila_v1', JSON.stringify([
      { url: 'x/rest/v1/rpc/vsp_registrar_venda', method: 'POST', body: JSON.stringify({ p_venda: { prod: 'TG' }, p_op_id: 'op-a' }) },
    ]));
    arm.idb.falharProximaEscrita();
    await abrirAba(arm);
    assertTrue(arm.ls.has('vsp_fila_v1'), 'a fila antiga continua la');
  });

  it('confirmados antigos sao limpos; recentes e pendentes ficam', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    const velho = new Date(Date.now() - 8 * 24 * 3600e3).toISOString();
    const base = { versao_payload: 1, tipo: 'venda', payload: { p_venda: {} }, tentativas: 1, depende_de: [], usuario: 'Victor' };
    await h.escopo.armazemFila.gravar(Object.assign({}, base, { id_local: 'a', seq: 1, op_id: 'a', status: 'confirmado', criado_em: velho, atualizado_em: velho }));
    await h.escopo.armazemFila.gravar(Object.assign({}, base, { id_local: 'b', seq: 2, op_id: 'b', status: 'confirmado', criado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }));
    await h.escopo.armazemFila.gravar(Object.assign({}, base, { id_local: 'c', seq: 3, op_id: 'c', status: 'conflito', criado_em: velho, atualizado_em: velho }));
    servidor(h, () => ({ status: 200, corpo: {} }));
    await rodarFila(h);
    const ids = registros(arm).map((r) => r.id_local).sort().join(',');
    assertEqual(ids, 'b,c', 'saiu so o confirmado velho; conflito velho fica');
  });

  it('compra offline tambem e guardada, com o mesmo cuidado', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    offline(h);
    h.preencher({ repProd: 'TG', repTipo: 'caixa', repQtd: '8', repCustUnit: '582.50', repForn: 'Victor', repData: '2026-09-17', repObs: '', repFrete: '', repLote: '', repValidade: '', repNota: '' });
    await h.escopo.confReposicao();
    const regs = registros(arm);
    assertEqual(regs.length, 1, 'guardada');
    assertEqual(regs[0].tipo, 'compra', 'tipo compra');
    assertEqual(h.escopo.DB.reposicoes.length, 0, 'nao inventou compra na lista');
    assertTrue(h.ui.toasts().some((t) => /Salvo neste aparelho/.test(t)), 'mensagem certa');
    assertFalse(h.ui.toasts().some((t) => /Compra registrada/.test(t)), 'sem sucesso falso');
    const rede = servidor(h, () => ({ status: 200, corpo: {} }));
    await rodarFila(h);
    assertMatch(rede.rpc()[0].url, /vsp_registrar_compra$/, 'enviada pela RPC da compra');
    assertEqual(rede.rpc()[0].op, regs[0].op_id, 'com o op_id guardado');
  });

  it('o que nao e seguro offline (saida no financeiro) falha com aviso e NAO entra na fila', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    h.preencher({ fTipo: 'despesa', fSocio: 'Victor', fDesc: 'Frete', fData: '2026-09-17', fVal: '50', fPgto: 'pix' });
    await h.escopo.regSaida();
    assertEqual(registros(arm).length, 0, 'nada guardado');
    assertTrue(h.ui.toasts().some((t) => /sem internet/.test(t)), 'avisou');
    assertFalse(h.ui.toasts().some((t) => /Lançamento registrado/.test(t)), 'sem sucesso falso (antes era um 200 inventado)');
    assertEqual(h.escopo.DB.saidas.length, 0, 'nao inventou lancamento');
  });

  it('sbFetch sem rede lanca erro marcado, nunca devolve 200 inventado', async () => {
    const arm = novoArmazem();
    const h = await abrirAba(arm);
    servidor(h, () => 'rede');
    let erro = null;
    try { await h.escopo.sbFetch('https://x/rest/v1/saidas', { method: 'POST', body: '{"a":1}' }); } catch (e) { erro = e; }
    assertTrue(!!erro, 'lancou');
    assertTrue(erro.semRede === true, 'marcado como sem rede');
    assertEqual(registros(arm).length, 0, 'nao enfileirou nada por baixo');
  });
});
