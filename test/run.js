#!/usr/bin/env node
'use strict';
/* =============================================================================
 * run.js — runner proprio (Node puro, zero dependencia)
 * =============================================================================
 *
 *   node test/run.js                 roda tudo
 *   node test/run.js financeiro      roda so as suites cujo arquivo casa com o filtro
 *   node test/run.js --cor           forca cor mesmo sem TTY
 *   node test/run.js --sem-cor       desliga cor
 *   VSP_INDEX=... node test/run.js   aponta para outro index.html
 *
 * API que os arquivos *.test.js usam (injetada em `global`):
 *
 *   describe(nome, fn)
 *   it(nome, fn)                     fn pode ser async; falha = lancar
 *   it.pendente(nome, esperado, fn)  caso que HOJE falha de proposito. Ele nao
 *                                    derruba a suite: documenta uma divergencia
 *                                    conhecida e avisa em alto e bom som quando
 *                                    passar a passar (= a correcao entrou).
 *   it.pular(nome, motivo)           nao roda
 *   antesDeCada(fn) / antesDeTudo(fn)
 *
 *   assertEqual(atual, esperado, msg)        ===
 *   assertClose(atual, esperado, msg, tol)   tolerancia de centavo (padrao 0,005)
 *   assertTrue / assertFalse / assertNull
 *   assertMatch(texto, regex, msg)
 *   assertInclui(texto, pedaco, msg)
 *   assertLanca(fn, msg) / assertRejeita(fnAsync, msg)
 *   assertMaior(a, b, msg) / assertArray(atual, esperado, msg)
 *
 * Codigo de saida: 1 se qualquer caso falhar (pendentes NAO contam como falha),
 * ou se um arquivo de teste nao puder ser carregado.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------- cores ----

const ESC = String.fromCharCode(27); // \u001b, sem byte de controle no fonte
const forcaCor = process.argv.includes('--cor');
const semCor = process.argv.includes('--sem-cor') || !!process.env.NO_COLOR;
const COR = (!semCor && (forcaCor || process.stdout.isTTY)) ? {
  reset: ESC + '[0m',
  neg: ESC + '[1m',
  fraco: ESC + '[2m',
  verde: ESC + '[32m',
  vermelho: ESC + '[31m',
  amarelo: ESC + '[33m',
  azul: ESC + '[36m',
  roxo: ESC + '[35m',
} : new Proxy({}, { get: () => '' });

const c = (cor, t) => COR[cor] + t + COR.reset;

// ------------------------------------------------------------------ estado ----

const suites = [];
let suiteAtual = null;
const resultados = { ok: 0, falhas: 0, pendentes: 0, pendentesPassando: 0, pulados: 0 };
const falhas = [];
const avisos = [];

// ------------------------------------------------------------------- erros ----

class FalhaAssercao extends Error {
  constructor(msg, atual, esperado) {
    super(msg);
    this.name = 'FalhaDeAssercao';
    this.atual = atual;
    this.esperado = esperado;
    this.temValores = arguments.length > 1;
  }
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6).replace(/0+$/, '');
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return '[' + v.map(fmt).join(', ') + ']';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return String(v);
}

// ------------------------------------------------------------------- API ------

function describe(nome, fn) {
  const s = { nome, casos: [], antesDeCada: [], antesDeTudo: [], arquivo: arquivoAtual };
  suites.push(s);
  const anterior = suiteAtual;
  suiteAtual = s;
  try {
    fn();
  } finally {
    suiteAtual = anterior;
  }
}

function registrar(caso) {
  if (!suiteAtual) throw new Error('it() fora de describe(): ' + caso.nome);
  suiteAtual.casos.push(caso);
}

function it(nome, fn) {
  registrar({ nome, fn, tipo: 'normal' });
}
it.pendente = function (nome, esperado, fn) {
  registrar({ nome, fn, tipo: 'pendente', esperado });
};
it.pular = function (nome, motivo) {
  registrar({ nome, tipo: 'pulado', motivo: motivo || '' });
};

function antesDeCada(fn) { suiteAtual.antesDeCada.push(fn); }
function antesDeTudo(fn) { suiteAtual.antesDeTudo.push(fn); }

// -------------------------------------------------------------- asserções ----

function assertEqual(atual, esperado, msg) {
  if (atual !== esperado) {
    throw new FalhaAssercao(msg || 'valores diferentes', atual, esperado);
  }
}

function assertClose(atual, esperado, msg, tol) {
  const t = tol == null ? 0.005 : tol; // meio centavo
  const a = Number(atual);
  const e = Number(esperado);
  if (!Number.isFinite(a) || Math.abs(a - e) > t) {
    const f = new FalhaAssercao(
      (msg || 'fora da tolerancia') + ' (tolerancia ' + t + ')', atual, esperado);
    f.diferenca = Number.isFinite(a) ? a - e : NaN;
    throw f;
  }
}

function assertTrue(cond, msg) {
  if (cond !== true && !cond) {
    throw new FalhaAssercao(msg || 'esperava verdadeiro', cond, true);
  }
}
function assertFalse(cond, msg) {
  if (cond) throw new FalhaAssercao(msg || 'esperava falso', cond, false);
}
function assertNull(v, msg) {
  if (v !== null && v !== undefined) {
    throw new FalhaAssercao(msg || 'esperava null/undefined', v, null);
  }
}
function assertMatch(texto, regex, msg) {
  if (!regex.test(String(texto))) {
    throw new FalhaAssercao(
      msg || 'texto nao casa com ' + regex, String(texto).slice(0, 300), String(regex));
  }
}
function assertInclui(texto, pedaco, msg) {
  if (!String(texto).includes(pedaco)) {
    throw new FalhaAssercao(
      msg || 'texto nao contem o pedaco', String(texto).slice(0, 300), pedaco);
  }
}
function assertNaoInclui(texto, pedaco, msg) {
  if (String(texto).includes(pedaco)) {
    throw new FalhaAssercao(
      msg || 'texto contem algo que nao deveria', String(texto).slice(0, 300), 'sem ' + pedaco);
  }
}
function assertMaior(a, b, msg) {
  if (!(Number(a) > Number(b))) {
    throw new FalhaAssercao(msg || 'esperava maior', a, '> ' + b);
  }
}
function assertArray(atual, esperado, msg) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new FalhaAssercao(msg || 'arrays diferentes', atual, esperado);
}
function assertLanca(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new FalhaAssercao(msg || 'esperava que lancasse', 'nao lancou', 'Error');
}
async function assertRejeita(fn, msg) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new FalhaAssercao(msg || 'esperava que rejeitasse', 'resolveu', 'rejeicao');
}

// ---------------------------------------------------------------- execucao ----

let arquivoAtual = '';

function primeiraLinhaUtil(stack) {
  const linhas = String(stack || '').split('\n').slice(1);
  const alvo = linhas.find((l) => /\.test\.js/.test(l)) ||
               linhas.find((l) => !/run\.js/.test(l)) || '';
  return alvo.trim();
}

async function rodarCaso(suite, caso) {
  if (caso.tipo === 'pulado') {
    resultados.pulados++;
    console.log('  ' + c('amarelo', '~') + ' ' + caso.nome +
      (caso.motivo ? c('fraco', ' — ' + caso.motivo) : ''));
    return;
  }
  for (const fn of suite.antesDeCada) await fn();
  const t0 = Date.now();
  let erro = null;
  try {
    await caso.fn();
  } catch (e) {
    erro = e;
  }
  const ms = Date.now() - t0;
  const tempo = ms >= 30 ? c('fraco', ' (' + ms + 'ms)') : '';

  if (caso.tipo === 'pendente') {
    if (erro) {
      resultados.pendentes++;
      console.log('  ' + c('roxo', 'P') + ' ' + caso.nome + tempo);
      console.log('    ' + c('roxo', 'pendente — divergencia conhecida, ainda aberta'));
      if (caso.esperado) console.log('    ' + c('fraco', 'esperado quando entrar: ' + caso.esperado));
      console.log('    ' + c('fraco', 'hoje: ' + descreverErro(erro)));
    } else {
      resultados.pendentesPassando++;
      const aviso = 'PENDENTE AGORA PASSA: "' + caso.nome + '" (' + suite.nome + ')' +
        ' — a correcao entrou; tire o marcador it.pendente e transforme em it().';
      avisos.push(aviso);
      console.log('  ' + c('amarelo', '!') + ' ' + caso.nome + tempo);
      console.log('    ' + c('amarelo', 'PENDENTE AGORA PASSA — remova o marcador it.pendente'));
    }
    return;
  }

  if (erro) {
    resultados.falhas++;
    falhas.push({ suite: suite.nome, caso: caso.nome, erro });
    console.log('  ' + c('vermelho', 'X') + ' ' + caso.nome + tempo);
    console.log('    ' + c('vermelho', descreverErro(erro)));
    const onde = primeiraLinhaUtil(erro.stack);
    if (onde) console.log('    ' + c('fraco', onde));
  } else {
    resultados.ok++;
    console.log('  ' + c('verde', 'v') + ' ' + caso.nome + tempo);
  }
}

function descreverErro(e) {
  if (e instanceof FalhaAssercao && e.temValores) {
    let s = e.message + '\n      obtido:   ' + fmt(e.atual) +
            '\n      esperado: ' + fmt(e.esperado);
    if (e.diferenca != null && Number.isFinite(e.diferenca)) {
      s += '\n      diferenca: ' + (e.diferenca > 0 ? '+' : '') + e.diferenca.toFixed(4);
    }
    return s;
  }
  return (e && e.stack ? String(e.message) : String(e));
}

// ------------------------------------------------------------------ main -----

async function main() {
  const inicio = Date.now();
  const filtros = process.argv.slice(2).filter((a) => !a.startsWith('-'));

  // API global para os arquivos de teste
  Object.assign(global, {
    describe, it, antesDeCada, antesDeTudo,
    assertEqual, assertClose, assertTrue, assertFalse, assertNull,
    assertMatch, assertInclui, assertNaoInclui, assertMaior, assertArray,
    assertLanca, assertRejeita,
    COR, c,
  });

  const arquivos = fs.readdirSync(__dirname)
    .filter((f) => /\.test\.js$/.test(f))
    .filter((f) => !filtros.length || filtros.some((x) => f.includes(x)))
    .sort();

  // cabecalho: QUAL index.html esta sob teste (existem duas copias no disco)
  console.log('');
  console.log(c('neg', 'VS Performance — suite de testes') + c('fraco', '  (Node ' + process.version + ')'));
  try {
    const harness = require('./harness.js');
    const info = harness.infoArquivo();
    console.log(c('fraco', 'arquivo sob teste: ') + info.caminho);
    console.log(c('fraco',
      '  ' + info.bytes + ' bytes · ' + info.linhas + ' linhas · ' +
      info.blocosInline + ' bloco(s) <script> inline · alterado em ' +
      info.mtime.toLocaleString('pt-BR')));
    if (info.irmao && !info.irmao.igual) {
      console.log(c('amarelo',
        '  atencao: a copia em ' + info.irmao.caminho + ' DIFERE desta. ' +
        'Use VSP_INDEX para testar a outra.'));
    }
  } catch (e) {
    console.log(c('vermelho', 'nao consegui inspecionar o index.html: ' + e.message));
    process.exitCode = 1;
    return;
  }
  console.log('');

  if (!arquivos.length) {
    console.log(c('vermelho', 'nenhum arquivo *.test.js encontrado em ' + __dirname));
    process.exitCode = 1;
    return;
  }

  let erroDeCarga = false;
  for (const f of arquivos) {
    arquivoAtual = f;
    try {
      require(path.join(__dirname, f));
    } catch (e) {
      erroDeCarga = true;
      console.log(c('vermelho', 'nao consegui carregar ' + f + ': ' + (e && e.stack || e)));
    }
  }
  arquivoAtual = '';

  for (const suite of suites) {
    console.log(c('azul', '» ' + suite.nome) + c('fraco', '  [' + suite.arquivo + ']'));
    let erroAntes = null;
    for (const fn of suite.antesDeTudo) {
      try { await fn(); } catch (e) { erroAntes = e; break; }
    }
    if (erroAntes) {
      resultados.falhas++;
      falhas.push({ suite: suite.nome, caso: '(antesDeTudo)', erro: erroAntes });
      console.log('  ' + c('vermelho', 'X antesDeTudo: ' + descreverErro(erroAntes)));
      console.log('');
      continue;
    }
    for (const caso of suite.casos) await rodarCaso(suite, caso);
    console.log('');
  }

  // ------------------------------------------------------------- resumo ----
  const seg = ((Date.now() - inicio) / 1000).toFixed(2);
  const total = resultados.ok + resultados.falhas + resultados.pendentes +
                resultados.pendentesPassando + resultados.pulados;

  console.log(c('neg', '─'.repeat(64)));
  console.log(
    c('neg', 'RESUMO  ') +
    c('verde', resultados.ok + ' passaram') + '  ' +
    (resultados.falhas ? c('vermelho', resultados.falhas + ' falharam')
                       : c('fraco', '0 falharam')) + '  ' +
    c('roxo', resultados.pendentes + ' pendentes') +
    (resultados.pendentesPassando ? '  ' + c('amarelo', resultados.pendentesPassando + ' pendentes-que-passaram') : '') +
    (resultados.pulados ? '  ' + c('amarelo', resultados.pulados + ' pulados') : '') +
    c('fraco', '  ·  ' + total + ' casos em ' + seg + 's')
  );

  if (falhas.length) {
    console.log('');
    console.log(c('vermelho', c('neg', 'FALHAS')));
    falhas.forEach((f, i) => {
      console.log('  ' + (i + 1) + ') ' + f.suite + ' › ' + f.caso);
      console.log('     ' + descreverErro(f.erro).split('\n').join('\n     '));
    });
  }
  if (avisos.length) {
    console.log('');
    console.log(c('amarelo', c('neg', 'ATENCAO')));
    avisos.forEach((a) => console.log('  - ' + a));
  }
  if (resultados.pendentes) {
    console.log('');
    console.log(c('roxo',
      'Os ' + resultados.pendentes + ' pendente(s) sao divergencias conhecidas e ' +
      'documentadas — nao derrubam a suite. Quando a correcao entrar, o runner avisa.'));
  }
  console.log('');

  if (resultados.falhas || erroDeCarga) process.exitCode = 1;
}

main().catch((e) => {
  console.error(c('vermelho', 'runner explodiu: ' + (e && e.stack || e)));
  process.exitCode = 1;
});
