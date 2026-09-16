'use strict';
/* =============================================================================
 * estatico.test.js — checagens sobre o TEXTO do index.html.
 * =============================================================================
 * Nada e executado aqui (fora do parse de sintaxe). Estes casos pegam justamente
 * o que o harness NAO pega: id que nao existe no HTML, handler de onclick que
 * aponta para uma funcao apagada, sobra de debug, bloco de script quebrado.
 * O `document` falso do harness devolve elemento para qualquer id, entao sem
 * esta suite um `getElementById('idQueNaoExiste')` passaria batido.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const H = require('./harness.js');

const ARQUIVO = H.resolverIndex();
const HTML = fs.readFileSync(ARQUIVO, 'utf8');
const BLOCOS = H.extrairScripts(HTML);
const INLINE = BLOCOS.filter((b) => !b.externo);

// palavras que aparecem como `nome(` num handler mas nao sao funcao do app
const NAO_SAO_FUNCOES_DO_APP = new Set([
  // palavras-chave da linguagem
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete',
  'void', 'in', 'of', 'do', 'else', 'try', 'function', 'await', 'yield', 'throw',
  // globais do navegador / da linguagem
  'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout',
  'parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'isNaN', 'encodeURIComponent',
  'decodeURIComponent', 'fetch', 'require',
]);

function nomesChamadosEmHandlers() {
  const achados = new Map(); // nome -> exemplo do handler
  const reAttr = /\son(?:click|change|input|submit|keydown|keyup|blur|focus|dblclick)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = reAttr.exec(HTML)) !== null) {
    const codigo = m[2] != null ? m[2] : m[3];
    const reCall = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let n;
    while ((n = reCall.exec(codigo)) !== null) {
      const nome = n[2];
      if (NAO_SAO_FUNCOES_DO_APP.has(nome)) continue;
      if (!achados.has(nome)) achados.set(nome, codigo.slice(0, 80));
    }
  }
  return achados;
}

function nomesDefinidos() {
  const def = new Set();
  let m;
  const reFn = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(HTML)) !== null) def.add(m[1]);
  const reVar = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  while ((m = reVar.exec(HTML)) !== null) def.add(m[1]);
  return def;
}

function idsDeclarados() {
  const ids = new Map();
  const re = /\sid\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) {
    ids.set(m[1], (ids.get(m[1]) || 0) + 1);
  }
  return ids;
}

function idsUsadosEmGetElementById() {
  const usados = new Map(); // id -> quantas vezes
  const re = /getElementById\(\s*(["'])([^"']+)\1\s*\)/g;
  let m;
  while ((m = re.exec(HTML)) !== null) {
    usados.set(m[2], (usados.get(m[2]) || 0) + 1);
  }
  return usados;
}

function linhasCom(regex) {
  const achadas = [];
  HTML.split('\n').forEach((l, i) => {
    if (regex.test(l)) achadas.push((i + 1) + ': ' + l.trim().slice(0, 140));
  });
  return achadas;
}

// =============================================================================
describe('Sintaxe dos blocos <script>', () => {

  it('o arquivo tem os blocos que o harness espera (2 inline + 1 externo)', () => {
    assertEqual(INLINE.length, 2, 'blocos inline');
    assertEqual(BLOCOS.length - INLINE.length, 1, 'blocos com src');
    assertMaior(INLINE[INLINE.length - 1].bytes, 100000,
      'o bloco principal do app tem de ser o ultimo e o maior');
  });

  it('todo bloco inline compila (new Function, sem executar)', () => {
    INLINE.forEach((b, i) => {
      try {
        // eslint-disable-next-line no-new-func
        new Function(b.corpo);
      } catch (e) {
        throw new Error(
          'bloco inline #' + (i + 1) + ' (linha ' + b.linha + ' do index.html) ' +
          'nao compila: ' + e.message
        );
      }
    });
  });

  it('nenhum bloco inline esta vazio ou truncado', () => {
    INLINE.forEach((b, i) => {
      assertMaior(b.corpo.trim().length, 10, 'bloco #' + (i + 1) + ' vazio');
      const abre = (b.corpo.match(/\{/g) || []).length;
      const fecha = (b.corpo.match(/\}/g) || []).length;
      assertEqual(abre, fecha,
        'bloco #' + (i + 1) + ': chaves desbalanceadas (' + abre + ' x ' + fecha + ')');
    });
  });

  it('o unico script externo e o Chart.js do cdnjs', () => {
    const externos = BLOCOS.filter((b) => b.externo);
    externos.forEach((b) => {
      assertMatch(b.attrs, /cdnjs\.cloudflare\.com/,
        'script externo de origem inesperada: ' + b.attrs);
      assertMatch(b.attrs, /chart\.umd\.js/, 'script externo inesperado: ' + b.attrs);
    });
  });
});

// =============================================================================
describe('Referencias orfas', () => {

  it('nao sobrou nenhuma mencao a repPagar, toggleRepPgto ou lancarFin', () => {
    ['repPagar', 'toggleRepPgto', 'lancarFin'].forEach((nome) => {
      const ocorrencias = linhasCom(new RegExp('\\b' + nome + '\\b'));
      assertEqual(ocorrencias.length, 0,
        nome + ' ainda aparece em:\n      ' + ocorrencias.join('\n      '));
    });
  });

  it('toda funcao chamada num handler on*= existe de fato', () => {
    const chamadas = nomesChamadosEmHandlers();
    const definidas = nomesDefinidos();
    assertMaior(chamadas.size, 50, 'a extracao tem de achar os handlers (' + chamadas.size + ')');
    const faltando = [...chamadas.keys()].filter((n) => !definidas.has(n));
    assertEqual(faltando.length, 0,
      'handler aponta para funcao que nao existe: ' +
      faltando.map((n) => n + '()  em  ' + chamadas.get(n)).join(' | '));
  });

  it('todo id usado em getElementById("...") existe no HTML', () => {
    // este e o teste que cobre o ponto cego do harness: o document falso devolve
    // elemento para qualquer id, o navegador devolve null e o app explode
    const declarados = idsDeclarados();
    const usados = idsUsadosEmGetElementById();
    assertMaior(usados.size, 100, 'a extracao tem de achar os ids (' + usados.size + ')');
    const faltando = [...usados.keys()].filter((id) => !declarados.has(id));
    assertEqual(faltando.length, 0,
      'getElementById de id que nao existe no HTML: ' + faltando.join(', '));
  });

  it('nenhum id duplicado no HTML', () => {
    const dup = [...idsDeclarados().entries()].filter(([, n]) => n > 1);
    assertEqual(dup.length, 0,
      'ids repetidos (getElementById pega so o primeiro): ' +
      dup.map(([id, n]) => id + ' x' + n).join(', '));
  });
});

// =============================================================================
describe('Sobras de desenvolvimento', () => {

  it('nenhum console.log esquecido', () => {
    const ocorrencias = linhasCom(/console\s*\.\s*log\s*\(/);
    assertEqual(ocorrencias.length, 0,
      'console.log em:\n      ' + ocorrencias.join('\n      '));
  });

  it('nenhum outro console.* (warn/error/debug/table) tambem', () => {
    const ocorrencias = linhasCom(/console\s*\.\s*(warn|error|info|debug|table|trace|dir)\s*\(/);
    assertEqual(ocorrencias.length, 0,
      'console.* em:\n      ' + ocorrencias.join('\n      '));
  });

  it('nenhum `debugger`', () => {
    const ocorrencias = linhasCom(/(^|[^\w$])debugger\s*;?\s*$/);
    assertEqual(ocorrencias.length, 0, 'debugger em:\n      ' + ocorrencias.join('\n      '));
  });

  it('nenhum `alert(` de depuracao com texto de teste', () => {
    const ocorrencias = linhasCom(/alert\s*\(\s*["'](teste|test|aqui|oi|xxx|1)["']/i);
    assertEqual(ocorrencias.length, 0, 'alert de teste em:\n      ' + ocorrencias.join('\n      '));
  });
});

// =============================================================================
describe('As correcoes de 15/09/2026 continuam no codigo', () => {

  it('o custo medio ponderado saiu do JavaScript (e nao voltou por outra porta)', () => {
    // Esta checagem era o contrario: exigia a linha `p.custoCaixa=+(novoCustoFrasco*
    // fpcOf(p)).toFixed(2)` dentro de confReposicao. A conta mudou de casa — vive na
    // vsp_registrar_compra — entao o que se verifica agora e que ela NAO esta mais aqui.
    const i = HTML.indexOf('async function confReposicao()');
    assertMaior(i, 0, 'confReposicao existe');
    const corpo = HTML.slice(i, HTML.indexOf('\nfunction ', i + 10));
    assertNaoInclui(corpo, 'p.custoCaixa=', 'o cliente nao escreve mais o custo da caixa');
    assertNaoInclui(corpo, 'p.custoFrasco=', 'nem o custo do frasco');
    assertNaoInclui(corpo, 'p.caixas+=', 'nem soma estoque por conta propria');
    assertNaoInclui(HTML, 'novoCustoFrasco', 'a variavel da conta antiga nao ficou para tras');
    assertInclui(corpo, "sbRpc('vsp_registrar_compra'", 'a compra e uma RPC so');
    assertInclui(corpo, 'p_op_id:opId', 'com op_id, que e o que torna o retry seguro');
  });

  it('a regra do arredondamento continua escrita — agora em SQL', () => {
    // O bug de 582,52 era derivar o custo da caixa do custo do frasco JA arredondado.
    // A regra ("cada um arredondado uma vez, os dois a partir do valor nao arredondado")
    // mudou de arquivo junto com a conta. Se ela desaparecer da migration, o bug volta
    // — e nenhum teste do harness veria, porque o harness nao roda SQL.
    const sql = H.lerMigration('004_rpc_operacoes.sql');
    assertInclui(sql, 'v_cf := round(v_cf_raw, 2);',
      'o custo do frasco sai do valor nao arredondado');
    assertInclui(sql, 'v_cc := round(v_cf_raw * v_fpc, 2);',
      'e o custo da caixa TAMBEM sai do valor nao arredondado');
    assertNaoInclui(sql, 'round(v_cf * v_fpc',
      'esta e a forma bugada: multiplicar o frasco ja arredondado');
    assertNaoInclui(sql, 'v_cc := v_cf * v_fpc', 'e esta e a mesma coisa com outro nome');
    assertTrue(sql.split('v_cc := round(v_cf_raw * v_fpc, 2);').length - 1 >= 2,
      'a regra vale nos dois caminhos que recalculam custo (compra e estorno)');
  });

  it('estornarCompra mantem a guarda podeRecalcular', () => {
    assertInclui(HTML, 'const podeRecalcular=', 'a guarda existe');
    assertInclui(HTML, 'vendasDepois===0', 'ela considera vendas posteriores');
    assertInclui(HTML, 'unRest>0&&valRest>0', 'e nao aceita estoque/valor zerado');
  });

  it('o botao de estorno de compra esta ligado na interface', () => {
    assertMatch(HTML, /onclick="estornarCompra\(/, 'o botao chama estornarCompra');
  });

  it('a compra nao cria mais saida automatica no Financeiro', () => {
    // a funcao confReposicao nao pode ter POST em saidas
    const i = HTML.indexOf('async function confReposicao()');
    assertMaior(i, 0, 'confReposicao existe');
    const corpo = HTML.slice(i, HTML.indexOf('\nfunction ', i + 10));
    assertNaoInclui(corpo, "sbPost('saidas'", 'a compra nao lanca saida');
    assertInclui(corpo, 'A compra NÃO lança saída no Financeiro',
      'o comentario que explica a decisao continua ali');
  });

  it(
    'a ajuda embutida ainda fala da caixinha "ja paguei", que foi removida',
    () => {
      const ocorrencias = linhasCom(/paguei/i);
      assertEqual(ocorrencias.length, 0,
        'texto de ajuda desatualizado em:\n      ' + ocorrencias.join('\n      '));
    }
  );
});

// =============================================================================
describe('O razao da Conta do Victor (migration 006)', () => {

  it('a divida sai do razao, e o razao tem a convencao de sinal escrita', () => {
    const sql = H.lerMigration('006_ledger_victor.sql');
    assertInclui(sql, 'create table if not exists public.ledger_victor',
      'a tabela do razao existe na migration');
    assertInclui(sql, 'saldo POSITIVO = a empresa DEVE a Victor',
      'a convencao de sinal esta escrita no arquivo, nao so na cabeca de alguem');
    assertInclui(sql, "check (direcao in ('debito','credito'))",
      'o banco nao aceita direcao inventada');
    assertInclui(sql, 'check (valor > 0)', 'valor sempre positivo: o sinal e a direcao');
    assertInclui(sql, "when direcao='debito' then valor else -valor end",
      'o saldo e debito menos credito');
  });

  it('o razao nao se apaga: sem DELETE, correcao por compensacao', () => {
    const sql = H.lerMigration('006_ledger_victor.sql');
    assertNaoInclui(sql, 'for delete to authenticated',
      'historico financeiro nao pode ter policy de DELETE');
    assertInclui(sql, 'vsp_ledger_estornar_origem',
      'a correcao e por movimento compensatorio');
    assertInclui(sql, 'ux_lv_origem',
      'identidade deterministica da origem: a mesma compra nao entra duas vezes');
  });

  it('quem escreve no razao e a SESSAO, nunca o nome vindo no payload', () => {
    // Esta e a correcao 005 de migrations/APLICADO.md, provada explorando: com o
    // token da Stefany, mandar usuario:'Victor' no payload fazia o banco gravar
    // "Victor" na venda e na auditoria. vsp_ator() resolve o nome por auth.uid()
    // na allowlist. O razao nasceu depois e tem de seguir a mesma regra.
    const sql = H.lerMigration('006_ledger_victor.sql');
    const usos = sql.split('public.vsp_ator()').length - 1;
    assertTrue(usos >= 2,
      'vsp_ator() tem de resolver o ator nas funcoes que escrevem no razao ' +
      '(estorno e reembolso); achei ' + usos + ' uso(s)');
    ["p_usuario", "p_created_by", "->>'usuario'", "->>'created_by'"].forEach((t) => {
      assertNaoInclui(sql, t,
        'o razao voltou a aceitar identidade pelo payload (' + t + ')');
    });
    assertInclui(sql, 'check (btrim(created_by) <> \'\')',
      'e nenhuma linha do razao pode ficar sem autor');
  });
});

// =============================================================================
describe('Higiene geral do arquivo unico', () => {

  it('o arquivo abre e fecha html/body e tem o titulo do app', () => {
    assertMatch(HTML, /^<!DOCTYPE html>/i, 'doctype');
    assertInclui(HTML, '<title>VS Performance</title>', 'titulo');
    assertInclui(HTML, '</body>', 'fecha body');
    assertInclui(HTML, '</html>', 'fecha html');
    assertInclui(HTML, 'charset="UTF-8"', 'charset declarado');
  });

  it('a versao do app esta declarada num lugar so', () => {
    const m = HTML.match(/const APP_VERSION='([^']+)'/);
    assertTrue(!!m, 'APP_VERSION existe');
    assertEqual(HTML.split('APP_VERSION=').length - 1, 1, 'declarada uma unica vez');
  });

  it('a chave do Supabase no arquivo e a anon (nunca a service_role)', () => {
    assertInclui(HTML, "const SB_KEY='", 'a chave esta no arquivo (e publica por design)');
    assertNaoInclui(HTML, 'service_role', 'chave de servico NUNCA pode ir para o front');
    const m = HTML.match(/const SB_KEY='([^']+)'/);
    const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64').toString('utf8'));
    assertEqual(payload.role, 'anon', 'o papel do token tem de ser anon');
  });

  it('o service worker e o manifest estao referenciados no HTML', () => {
    assertInclui(HTML, "navigator.serviceWorker.register('sw.js')", 'registro do sw');
    assertMatch(HTML, /href="manifest\.json/, 'link do manifest');
    assertMatch(HTML, /href="icon\.svg"/, 'icone');
  });

  it('a pasta do index esta publicavel por inteiro, ou nao e uma raiz de publicacao', () => {
    // a pasta de trabalho no OneDrive so tem o index.html; a raiz publicada
    // (o repositorio) tem sw.js, manifest.json e icon.svg. O que nao pode
    // existir e meio caminho: index publicado sem o sw/manifest que ele pede.
    const dir = path.dirname(ARQUIVO);
    const irmaos = ['sw.js', 'manifest.json', 'icon.svg'];
    const presentes = irmaos.filter((f) => fs.existsSync(path.join(dir, f)));
    assertTrue(presentes.length === 0 || presentes.length === irmaos.length,
      'pasta ' + dir + ' esta pela metade: tem ' + presentes.join(', ') +
      ' e falta ' + irmaos.filter((f) => !presentes.includes(f)).join(', '));
  });
});
