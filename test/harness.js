'use strict';
/* =============================================================================
 * harness.js — roda o JavaScript REAL do index.html do VS Performance
 *              dentro do Node, sem navegador e sem rede.
 * =============================================================================
 *
 * COMO FUNCIONA
 *   1. le o index.html do disco (texto, nunca escreve nele);
 *   2. extrai todos os blocos <script> SEM atributo src (os inline);
 *   3. cria um contexto `vm` com um ambiente de navegador falso (ver ESTUFA);
 *   4. roda cada bloco inline nesse contexto, na ordem em que aparecem no HTML;
 *   5. devolve um `escopo` por onde o teste le e escreve as variaveis e chama
 *      as funcoes do app.
 *
 * O QUE E CODIGO REAL (nao reescrito, nao copiado)
 *   - TODAS as funcoes e variaveis do index.html: valorEstTotal, dadosFechamento,
 *     dadosDRE, confReposicao, estornarCompra, regVenda, R, margemPct, fmtD,
 *     today, sbFetch/sbGet/sbPost/sbPatch/sbDelete, audit, render*, export*...
 *   - a ordem de execucao e o escopo lexico sao os mesmos do navegador: os blocos
 *     rodam no mesmo contexto global, um depois do outro.
 *
 * O QUE E STUB (escrito aqui, falso de proposito)  -->  ESTUFA
 *   - `document`: getElementById/querySelector devolvem SEMPRE um elemento falso
 *     (nunca null) com .value/.innerHTML/.textContent/.style/.classList. Isso faz
 *     o app rodar os caminhos de render em vez de sair pelo `if(!el)return`.
 *     Consequencia: o harness NAO prova que o HTML tem esses ids — isso e papel
 *     do estatico.test.js e do olho humano.
 *   - `window`/`self` = o proprio global do contexto; addEventListener e no-op.
 *   - `fetch`: por padrao LANCA (`modo:'proibida'`). Nenhum teste toca a rede.
 *     `rede.fake()` troca por respostas 2xx canned, gravando cada chamada.
 *   - `espiarRpc(resposta)`: troca a `sbRpc` REAL por um gravador. As quatro
 *     operacoes criticas (venda, compra, cancelamento, estorno) sao uma chamada
 *     a uma funcao transacional do PostgreSQL, e o espiao devolve o que o teste
 *     mandar. Logo, o harness prova a CHAMADA (funcao, payload, op_id, uso da
 *     resposta) e NAO a conta que o banco faz dentro da transacao.
 *   - `localStorage`: Map em memoria.
 *   - `setTimeout`/`setInterval`: NAO agendam nada. Devolvem um id e registram a
 *     chamada. Logo, nada que dependa de timer (esconder toast, expirar sessao,
 *     tour, polling do service worker) e exercitado.
 *   - `confirm`/`alert`/`prompt`: gravam a mensagem; confirm devolve
 *     `ui.respostaConfirm` (true por padrao).
 *   - `navigator`: sem `serviceWorker` de proposito, para `registrarSW()` sair na
 *     primeira linha. `onLine:true`, `userAgent` fixo, `clipboard.writeText` no-op.
 *   - `location`, `Blob`, `URL.createObjectURL`, `Chart`, `open()`: no-ops.
 *   - `Response`: o do proprio Node (sbFetch faz `new Response(...)` no caminho
 *     offline).
 *
 * UMA LINHA INJETADA NO CODIGO DO APP
 *   O harness concatena ao FIM de cada bloco inline exatamente esta linha:
 *
 *     ;globalThis.__vspEvals.push(function(__vspCode){return eval(__vspCode);});
 *
 *   Ela existe porque `let DB=...`, `const SOCIOS=[...]` etc. sao bindings
 *   lexicais do bloco e NAO viram propriedades do global — sem esse gancho o
 *   teste nao conseguiria popular o `DB`. E um `eval` direto, entao ele ve todo o
 *   escopo de topo do bloco. Nada mais do arquivo e alterado, e o
 *   estatico.test.js valida a sintaxe dos blocos ORIGINAIS, sem a linha.
 *
 * QUAL index.html?
 *   Ordem: env VSP_INDEX  >  ../index.html do repositorio  >  copia do OneDrive.
 *   O runner imprime no cabecalho qual arquivo foi carregado — nao confie no
 *   resultado sem ler essa linha, porque existem duas copias do app no disco.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CAMINHO_CANONICO =
  'C:\\Users\\victo\\OneDrive\\VS Performance - 25 - JULHO - 2026\\index.html';
const CAMINHO_IRMAO = path.join(__dirname, '..', 'index.html');

const EPILOGO =
  '\n;globalThis.__vspEvals=(globalThis.__vspEvals||[]);' +
  'globalThis.__vspEvals.push(function(__vspCode){return eval(__vspCode);});\n';

const NOME_VALIDO = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// ---------------------------------------------------------------- arquivo ----

function resolverIndex(preferido) {
  const tentativas = [
    preferido,
    process.env.VSP_INDEX,
    // O index.html do PROPRIO repositorio vem primeiro. Ele estava depois da copia do
    // OneDrive, e a suite rodava contra o codigo antigo dando verde falso nas correcoes.
    CAMINHO_IRMAO,
    CAMINHO_CANONICO,
  ].filter(Boolean);
  for (const t of tentativas) {
    try {
      if (fs.statSync(t).isFile()) return t;
    } catch (e) { /* proxima */ }
  }
  throw new Error(
    'index.html nao encontrado. Tentei:\n  ' + tentativas.join('\n  ') +
    '\nDefina VSP_INDEX=<caminho> para apontar na mao.'
  );
}

function infoArquivo(preferido) {
  const caminho = resolverIndex(preferido);
  const st = fs.statSync(caminho);
  const html = fs.readFileSync(caminho, 'utf8');
  const blocos = extrairScripts(html);
  let irmao = null;
  try {
    if (path.resolve(caminho) !== path.resolve(CAMINHO_IRMAO)) {
      const outro = fs.readFileSync(CAMINHO_IRMAO, 'utf8');
      irmao = {
        caminho: CAMINHO_IRMAO,
        igual: outro.replace(/\r/g, '') === html.replace(/\r/g, ''),
      };
    }
  } catch (e) { /* sem copia irma */ }
  return {
    caminho,
    bytes: st.size,
    mtime: st.mtime,
    linhas: html.split('\n').length,
    blocosInline: blocos.filter((b) => !b.externo).length,
    blocosExternos: blocos.filter((b) => b.externo).length,
    irmao,
  };
}

// --------------------------------------------------------------- extracao ----

function extrairScripts(html) {
  const blocos = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = (m[1] || '').trim();
    const corpo = m[2];
    const linha = html.slice(0, m.index).split('\n').length;
    blocos.push({
      externo: /\bsrc\s*=/i.test(attrs),
      attrs,
      corpo,
      linha,
      bytes: Buffer.byteLength(corpo, 'utf8'),
    });
  }
  return blocos;
}

// ------------------------------------------------------------------ ESTUFA ----

function novoElemento(id, escritas, fabrica) {
  let _text = '';
  let _html = '';
  const el = {
    id: String(id || ''),
    tagName: 'DIV',
    value: '',
    checked: false,
    disabled: false,
    href: '',
    download: '',
    src: '',
    style: {},
    dataset: {},
    filhos: [],
    classList: (() => {
      const s = new Set();
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        toggle: (c) => (s.has(c) ? s.delete(c) : s.add(c)),
        contains: (c) => s.has(c),
        get length() { return s.size; },
      };
    })(),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    appendChild(c) { el.filhos.push(c); return c; },
    removeChild(c) {
      el.filhos = el.filhos.filter((x) => x !== c);
      return c;
    },
    remove() {},
    insertAdjacentHTML(_pos, h) { _html += String(h); },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    focus() {},
    blur() {},
    select() {},
    click() {},
    scrollIntoView() {},
    closest() { return null; },
    getContext() { return { fillRect() {}, clearRect() {}, fillStyle: '' }; },
    querySelector(sel) { return fabrica(el.id + ' ' + sel); },
    querySelectorAll() { return []; },
    get className() { return ''; },
    set className(v) {
      escritas.push({ id: el.id, prop: 'className', valor: String(v) });
    },
    get outerHTML() { return '<div id="' + el.id + '">' + _html + '</div>'; },
  };
  Object.defineProperty(el, 'textContent', {
    enumerable: true,
    get: () => _text,
    set(v) {
      _text = v == null ? '' : String(v);
      escritas.push({ id: el.id, prop: 'textContent', valor: _text });
    },
  });
  Object.defineProperty(el, 'innerHTML', {
    enumerable: true,
    get: () => _html,
    set(v) {
      _html = v == null ? '' : String(v);
      escritas.push({ id: el.id, prop: 'innerHTML', valor: _html });
    },
  });
  return el;
}

function criarEstufa(opts) {
  const escritas = [];
  const elementos = new Map();
  const fabrica = (chave) => {
    if (!elementos.has(chave)) {
      elementos.set(chave, novoElemento(chave, escritas, fabrica));
    }
    return elementos.get(chave);
  };

  const documento = {
    getElementById: (id) => fabrica(String(id)),
    querySelector: (sel) => fabrica(String(sel)),
    querySelectorAll: () => [],
    createElement: (tag) => fabrica('<' + tag + ':' + elementos.size + '>'),
    createTextNode: (t) => ({ texto: String(t) }),
    addEventListener() {},
    removeEventListener() {},
    execCommand() { return true; },
    write() {},
    close() {},
    get body() { return fabrica('body'); },
    get documentElement() { return fabrica('html'); },
    readyState: 'complete',
  };

  const guardaLS = new Map();
  const localStorage = {
    getItem: (k) => (guardaLS.has(String(k)) ? guardaLS.get(String(k)) : null),
    setItem: (k, v) => { guardaLS.set(String(k), String(v)); },
    removeItem: (k) => { guardaLS.delete(String(k)); },
    clear: () => guardaLS.clear(),
    key: (i) => [...guardaLS.keys()][i] ?? null,
    get length() { return guardaLS.size; },
    __mapa: guardaLS,
  };

  const ui = {
    escritas,
    elementos,
    confirms: [],
    alerts: [],
    prompts: [],
    timers: [],
    respostaConfirm: true,
    respostaPrompt: '',
    // toasts que o showToast REAL escreveu no elemento #toast
    toasts() {
      return escritas
        .filter((e) => e.id === 'toast' && e.prop === 'textContent')
        .map((e) => e.valor);
    },
    ultimoToast() {
      const t = ui.toasts();
      return t.length ? t[t.length - 1] : null;
    },
    html(id) { return fabrica(String(id)).innerHTML; },
    valor(id) { return fabrica(String(id)).value; },
    setValor(id, v) { fabrica(String(id)).value = v == null ? '' : String(v); },
    limpar() {
      escritas.length = 0;
      ui.confirms.length = 0;
      ui.alerts.length = 0;
      ui.prompts.length = 0;
      ui.timers.length = 0;
      ui.respostaConfirm = true;
    },
  };

  // ------------------------------------------------------------- rede ------
  const rede = {
    modo: 'proibida', // 'proibida' (fetch lanca) | 'fake' (2xx canned)
    chamadas: [],
    respostas: [], // fila opcional: {status, corpo}
    proibir() { rede.modo = 'proibida'; return rede; },
    fake() { rede.modo = 'fake'; return rede; },
    responder(status, corpo) { rede.respostas.push({ status, corpo }); return rede; },
    limpar() {
      rede.chamadas.length = 0;
      rede.respostas.length = 0;
      return rede;
    },
    por(metodo, pedaco) {
      return rede.chamadas.filter(
        (c) => c.metodo === metodo && String(c.url).includes(pedaco)
      );
    },
  };

  function corpoFake(url, opts) {
    // o Supabase com Prefer:return=representation devolve um array de linhas
    const m = (opts && opts.method ? opts.method : 'GET').toUpperCase();
    if (m === 'DELETE') return '';
    if (opts && opts.body) {
      const b = String(opts.body);
      return b.trim().startsWith('[') ? b : '[' + b + ']';
    }
    return '[]';
  }

  const fetchFalso = async function (url, opts) {
    const metodo = ((opts && opts.method) || 'GET').toUpperCase();
    const registro = {
      url: String(url),
      metodo,
      corpo: opts && opts.body ? String(opts.body) : null,
      headers: (opts && opts.headers) || null,
      tabela: (String(url).match(/\/rest\/v1\/([^?]+)/) || [])[1] || null,
    };
    rede.chamadas.push(registro);
    if (rede.modo === 'proibida') {
      registro.bloqueada = true;
      throw new Error(
        'HARNESS: rede bloqueada (' + metodo + ' ' + url + '). ' +
        'Use rede.fake() se o teste precisa do caminho online.'
      );
    }
    const pronta = rede.respostas.length ? rede.respostas.shift() : null;
    const status = pronta ? pronta.status : 200;
    const texto = pronta
      ? (typeof pronta.corpo === 'string' ? pronta.corpo : JSON.stringify(pronta.corpo))
      : corpoFake(url, opts);
    registro.status = status;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      async json() { return texto ? JSON.parse(texto) : null; },
      async text() { return texto; },
    };
  };

  class BlobFalso {
    constructor(partes, o) {
      this.partes = partes;
      this.type = (o && o.type) || '';
      this.size = String(partes && partes[0] ? partes[0] : '').length;
    }
  }
  class URLFalsa extends URL {}
  URLFalsa.createObjectURL = () => 'blob:harness';
  URLFalsa.revokeObjectURL = () => {};

  class ChartFalso {
    constructor(ctx, cfg) { this.ctx = ctx; this.cfg = cfg; }
    destroy() {}
    update() {}
  }

  let idTimer = 0;
  const sandbox = {
    document: documento,
    localStorage,
    sessionStorage: localStorage,
    navigator: {
      userAgent: 'Harness/Node ' + process.version + ' (Windows)',
      onLine: true,
      language: 'pt-BR',
      clipboard: { writeText: async () => {} },
      // sem serviceWorker de proposito: registrarSW() sai na primeira linha
    },
    location: {
      protocol: 'file:',
      href: 'file:///harness/index.html',
      host: '',
      hostname: '',
      pathname: '/harness/index.html',
      search: '',
      hash: '',
      reload() {},
      replace() {},
      assign() {},
    },
    console: opts.silencioso === false ? console : {
      log() {}, info() {}, warn() {}, error() {}, debug() {}, table() {},
    },
    fetch: fetchFalso,
    Response,
    Headers: typeof Headers !== 'undefined' ? Headers : undefined,
    Blob: BlobFalso,
    URL: URLFalsa,
    Chart: ChartFalso,
    alert(m) { ui.alerts.push(String(m)); },
    confirm(m) { ui.confirms.push(String(m)); return ui.respostaConfirm; },
    prompt(m) { ui.prompts.push(String(m)); return ui.respostaPrompt; },
    open() {
      return {
        document: { write() {}, close() {} },
        focus() {}, print() {}, close() {},
      };
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setTimeout(fn, ms) {
      ui.timers.push({ tipo: 'timeout', ms: ms || 0, fn });
      return ++idTimer;
    },
    setInterval(fn, ms) {
      ui.timers.push({ tipo: 'interval', ms: ms || 0, fn });
      return ++idTimer;
    },
    clearTimeout() {},
    clearInterval() {},
    requestAnimationFrame(fn) {
      ui.timers.push({ tipo: 'raf', ms: 0, fn });
      return ++idTimer;
    },
    cancelAnimationFrame() {},
    getComputedStyle() { return {}; },
    matchMedia() { return { matches: false, addEventListener() {} }; },
  };

  return { sandbox, ui, rede, fabrica, elementos };
}

// ----------------------------------------------------------------- carregar ----

function carregar(opts) {
  opts = opts || {};
  const arquivo = resolverIndex(opts.arquivo);
  const html = fs.readFileSync(arquivo, 'utf8');
  const blocos = extrairScripts(html);
  const inline = blocos.filter((b) => !b.externo);
  if (!inline.length) throw new Error('nenhum <script> inline em ' + arquivo);

  const estufa = criarEstufa(opts);
  const ctx = vm.createContext(estufa.sandbox, { name: 'vsp-index' });
  vm.runInContext(
    'globalThis.window=globalThis;globalThis.self=globalThis;' +
    'globalThis.globalThis=globalThis;globalThis.__vspEvals=[];',
    ctx
  );

  const nomeBase = path.basename(arquivo);
  inline.forEach((b, i) => {
    const script = new vm.Script(b.corpo + EPILOGO, {
      filename: nomeBase + ' <script#' + (i + 1) + '@linha' + b.linha + '>',
      lineOffset: b.linha - 1,
    });
    script.runInContext(ctx, { timeout: opts.timeout || 30000 });
  });

  const avaliadores = ctx.__vspEvals;
  // o ultimo bloco inline e o script principal do app (as ~2200 linhas)
  const avaliar = avaliadores[avaliadores.length - 1];

  function ler(nome) {
    return avaliar(nome);
  }
  function escrever(nome, valor) {
    ctx.__vspTmp = valor;
    try {
      avaliar(nome + '=globalThis.__vspTmp');
    } catch (e) {
      if (/constant/i.test(e.message)) {
        throw new Error(
          "HARNESS: '" + nome + "' e const no index.html — nao da para substituir."
        );
      }
      throw e;
    }
    return valor;
  }

  const escopo = new Proxy(Object.create(null), {
    get(_t, nome) {
      if (nome === '__ctx') return ctx;
      if (nome === '__ler') return ler;
      if (nome === '__escrever') return escrever;
      if (typeof nome !== 'string' || !NOME_VALIDO.test(nome)) return ctx[nome];
      try {
        return ler(nome);
      } catch (e) {
        return undefined;
      }
    },
    set(_t, nome, valor) {
      if (typeof nome !== 'string' || !NOME_VALIDO.test(nome)) {
        ctx[nome] = valor;
        return true;
      }
      escrever(nome, valor);
      return true;
    },
    has(_t, nome) {
      if (typeof nome !== 'string' || !NOME_VALIDO.test(nome)) return nome in ctx;
      try {
        return avaliar('typeof ' + nome) !== 'undefined';
      } catch (e) {
        return false;
      }
    },
    ownKeys() {
      return Reflect.ownKeys(ctx);
    },
    getOwnPropertyDescriptor(_t, nome) {
      let valor;
      try { valor = typeof nome === 'string' && NOME_VALIDO.test(nome) ? ler(nome) : ctx[nome]; }
      catch (e) { valor = undefined; }
      return { value: valor, writable: true, enumerable: true, configurable: true };
    },
  });

  const h = {
    arquivo,
    html,
    blocos,
    blocosInline: inline,
    escopo,
    ctx,
    ui: estufa.ui,
    rede: estufa.rede,
    ler,
    escrever,

    /** Popula o DB do app com uma copia funda do fixture e zera o ambiente. */
    carregarDB(db) {
      escrever('DB', structuredClone(db));
      h.reset();
      return escopo.DB;
    },

    /** Zera o estado de ambiente entre casos (UI, rede, fila offline). */
    reset() {
      estufa.ui.limpar();
      estufa.rede.limpar();
      estufa.rede.proibir();
      try { escrever('semRede', false); } catch (e) {}
      try { escrever('fila', []); } catch (e) {}
      try { escrever('loadErros', []); } catch (e) {}
      return h;
    },

    /** Quem esta logado (usado por audit e pelo campo `usuario` das vendas). */
    logarComo(nome) {
      escrever('currentUser', nome);
      escrever('loggedIn', true);
      return h;
    },

    /** Preenche os inputs do formulario: {repQtd:'8', repCustUnit:'582.50', ...} */
    preencher(campos) {
      Object.keys(campos).forEach((id) => estufa.ui.setValor(id, campos[id]));
      return h;
    },

    /** Resposta do confirm() nativo para o proximo dialogo. */
    confirmar(resposta) {
      estufa.ui.respostaConfirm = resposta !== false;
      return h;
    },

    /** Foto do estoque/custo de cada produto AGORA (copia, nao referencia). */
    estoqueAgora() {
      const db = ler('DB') || {};
      return (db.produtos || []).map((p) => ({
        id: p.id, caixas: p.caixas, frascos: p.frascos,
        custoCaixa: p.custoCaixa, custoFrasco: p.custoFrasco,
      }));
    },

    /**
     * Espiao em sbRpc: troca a funcao REAL por um gravador e devolve o array de
     * chamadas. Serve para provar a CAMADA DE CHAMADA — qual funcao do banco o app
     * chama, com que payload, com que op_id, e o que ele faz com a resposta.
     *
     * O que essas funcoes executam DENTRO do PostgreSQL (custo medio ponderado,
     * baixa de estoque com trava, auditoria na mesma transacao, idempotencia de
     * verdade pelo op_id) NAO e exercitado aqui. Isso e testado em SQL, contra o
     * banco real, em transacao revertida — ver migrations/APLICADO.md e a secao
     * "O que esta suite NAO testa" do test/README.md. O espiao responde o que o
     * teste mandar: ele prova a conversa, nunca a conta.
     *
     *   const rpc = h.espiarRpc({ venda: row, produto: prodCanonico });
     *   const rpc = h.espiarRpc((fn, params, n) => { if (n === 1) throw new Error('x'); return {...}; });
     *
     * Cada registro e { fn, params, op, estoque, resposta }, onde `estoque` e a foto
     * do DB no INSTANTE da chamada — e assim que se prova que o app nao mexeu no
     * estoque local antes de o banco responder.
     */
    espiarRpc(resposta) {
      const chamadas = [];
      let real;
      try { real = ler('sbRpc'); } catch (e) { real = undefined; }
      if (typeof real !== 'function') {
        throw new Error(
          'HARNESS: este index.html nao tem sbRpc() — ele e ANTERIOR a migracao das ' +
          'quatro operacoes para as funcoes transacionais do PostgreSQL. Nao ha o que ' +
          'espionar. Aponte VSP_INDEX para a copia migrada (' + arquivo + ' e a atual).'
        );
      }
      chamadas.real = real;
      chamadas.por = (fn) => chamadas.filter((c) => c.fn === fn);
      chamadas.ultima = () => (chamadas.length ? chamadas[chamadas.length - 1] : null);
      chamadas.ops = () => chamadas.map((c) => c.op);
      escrever('sbRpc', async function (fn, params) {
        const reg = {
          fn,
          params: params || {},
          op: (params || {}).p_op_id,
          estoque: h.estoqueAgora(),
        };
        chamadas.push(reg);
        reg.resposta = typeof resposta === 'function'
          ? await resposta(fn, params, chamadas.length)
          : resposta;
        return reg.resposta;
      });
      return chamadas;
    },

    /**
     * Troca as funcoes de render por gravadores. Nao e usado por padrao: os
     * testes rodam os render* de verdade (com o document stub) para pegar erro
     * de runtime neles tambem. Existe para isolar um caso se um render quebrar.
     */
    silenciarRender(nomes) {
      const alvos = nomes || [
        'renderAll', 'renderAlertas', 'renderDash', 'renderEst', 'renderLotes',
        'renderPrevisao', 'populateLotes', 'renderHist', 'renderCli',
        'renderInteligencia', 'renderFiado', 'renderFin', 'renderFechamento',
        'renderCancelamentos', 'renderProdutos', 'renderRecontato',
        'updateFiadoBadge', 'montarAjudas', 'renderGraficos', 'renderDRE',
      ];
      const chamados = [];
      alvos.forEach((n) => {
        try {
          escrever(n, function () { chamados.push(n); });
        } catch (e) { /* nao existe: ignora */ }
      });
      return chamados;
    },
  };

  return h;
}

module.exports = {
  carregar,
  resolverIndex,
  infoArquivo,
  extrairScripts,
  CAMINHO_CANONICO,
  CAMINHO_IRMAO,
  EPILOGO,
};
