'use strict';
/* =============================================================================
 * contrato.test.js — o verificador de drift do banco funciona?
 * =============================================================================
 *
 *   PROVA — com migrations INVENTADAS numa pasta temporária, que test/sql/contrato.js:
 *     - pega a ÚLTIMA definição de cada função (migration posterior substitui);
 *     - respeita `drop function` (auxiliares temporários não entram no contrato);
 *     - ignora exemplo comentado;
 *     - trata assinatura trocada como função que deixou de existir;
 *     - acusa corpo diferente, função só no arquivo, função só em produção, definer,
 *       search_path e EXECUTE de anon — e não acusa trigger por EXECUTE de PUBLIC;
 *     - e, com as migrations REAIS, bate com a foto de produção de 17/09/2026.
 *
 *   NAO PROVA — que a foto ainda é a de hoje. Ela é tirada no SQL Editor
 *     (node test/sql/contrato.js --sql) e só muda quando alguém a atualiza.
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('./sql/contrato.js');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');

function pasta(arquivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-contrato-'));
  Object.entries(arquivos).forEach(([n, t]) => fs.writeFileSync(path.join(dir, n), t));
  return dir;
}
const fn = (nome, args, corpo, extra) =>
  'create or replace function public.' + nome + '(' + args + ')\nreturns int\nlanguage plpgsql\n' +
  (extra || 'security definer\nset search_path = public, pg_temp\n') + 'as $fn$' + corpo + '$fn$;\n';
const foto = (corpo, over) => Object.assign({
  lang: 'plpgsql', secdef: true, vol: 'v', search_path: 'public, pg_temp', md5: md5(corpo), ret: 'integer', anon: false,
}, over || {});

describe('Contrato do banco — o verificador', () => {

  it('a migration posterior substitui a anterior, e drop remove', () => {
    const dir = pasta({
      '001_a.sql': fn('vsp_x', 'p_a int', '\nbegin return 1; end ') + fn('vsp_mig_tmp', '', '\nbegin return 0; end ') +
        'drop function if exists public.vsp_mig_tmp();\n',
      '002_b.sql': fn('vsp_x', 'p_a int', '\nbegin return 2; end '),
    });
    const c = C.extrair(dir);
    assertEqual(Object.keys(c).join(','), 'vsp_x(p_a integer)', 'so vsp_x, com int normalizado');
    assertEqual(c['vsp_x(p_a integer)'].md5, md5('\nbegin return 2; end '), 'o corpo da 002');
    assertEqual(c['vsp_x(p_a integer)'].arquivo, '002_b.sql', 'arquivo de origem');
  });

  it('exemplo comentado nao entra; assinatura trocada sai do contrato', () => {
    const dir = pasta({
      '001_a.sql': '-- create or replace function public.vsp_fantasma() returns int as $fn$ x $fn$;\n' +
        fn('vsp_y', 'p_a text, p_b text', '\nbegin return 1; end '),
      '002_b.sql': fn('vsp_y', 'p_payload jsonb', '\nbegin return 1; end '),
    });
    const c = C.extrair(dir);
    assertEqual(Object.keys(c).join(','), 'vsp_y(p_payload jsonb)', 'so a assinatura nova');
  });

  it('acusa cada tipo de drift', () => {
    const corpo = '\nbegin return 1; end ';
    const dir = pasta({ '001_a.sql': fn('vsp_a', '', corpo) + fn('vsp_so_arquivo', '', corpo) + fn('vsp_def', '', corpo) + fn('vsp_sp', '', corpo) });
    const c = C.extrair(dir);
    const p = C.comparar(c, {
      'vsp_a()': foto(corpo + ' '),                                   // corpo diferente
      'vsp_so_producao()': foto(corpo),                               // nao esta no repo
      'vsp_def()': foto(corpo, { secdef: false }),                    // definer diferente
      'vsp_sp()': foto(corpo, { search_path: 'public', anon: true }),  // search_path e anon
    }).join('\n');
    assertMatch(p, /vsp_a\(\): md5/, 'corpo');
    assertMatch(p, /vsp_so_arquivo\(\): está em 001_a\.sql e NÃO existe em produção/, 'so no arquivo');
    assertMatch(p, /vsp_so_producao\(\): existe em produção e NÃO está/, 'so em producao');
    assertMatch(p, /vsp_def\(\): secdef/, 'definer');
    assertMatch(p, /vsp_sp\(\): search_path/, 'search_path');
    assertMatch(p, /vsp_sp\(\): anon/, 'anon executa');
  });

  it('trigger com EXECUTE de PUBLIC nao e exposicao (nao se chama trigger direto)', () => {
    const corpo = '\nbegin return new; end ';
    const dir = pasta({ '001_a.sql': fn('vsp_trg', '', corpo, 'set search_path = public, pg_temp\n') });
    const p = C.comparar(C.extrair(dir), { 'vsp_trg()': foto(corpo, { secdef: false, ret: 'trigger', anon: true }) });
    assertEqual(p.length, 0, 'sem problema');
  });

  it('CRLF no arquivo nao muda o md5 (o banco guarda LF)', () => {
    const corpo = '\nbegin\n  return 1;\nend ';
    const dir = pasta({ '001_a.sql': fn('vsp_crlf', '', corpo).replace(/\n/g, '\r\n') });
    assertEqual(C.extrair(dir)['vsp_crlf()'].md5, md5(corpo), 'md5 do corpo com LF');
  });

  it('as migrations reais batem com a foto de producao', () => {
    const fotoReal = JSON.parse(fs.readFileSync(path.join(__dirname, 'sql', 'contrato_producao.json'), 'utf8'));
    const dir = process.env.VSP_MIGRATIONS || path.join(__dirname, '..', 'migrations');
    const p = C.comparar(C.extrair(dir), fotoReal.funcoes);
    assertEqual(p.join(' | '), '', 'sem drift');
    assertEqual(Object.keys(fotoReal.funcoes).length, 17, '17 funcoes em producao em 17/09/2026');
  });

  it('nenhuma migration do contrato chama auxiliar que nao existe em producao', () => {
    const fotoReal = JSON.parse(fs.readFileSync(path.join(__dirname, 'sql', 'contrato_producao.json'), 'utf8'));
    const existentes = new Set(Object.keys(fotoReal.funcoes).map((k) => k.split('(')[0]));
    const dir = process.env.VSP_MIGRATIONS || path.join(__dirname, '..', 'migrations');
    const chamadas = new Set();
    fs.readdirSync(dir).filter((f) => /^00[4-9]_.*\.sql$/.test(f)).forEach((f) => {
      const t = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
      for (const m of t.matchAll(/public\.(vsp_\w+)\s*\(/g)) chamadas.add(m[1]);
    });
    const faltam = [...chamadas].filter((n) => !existentes.has(n));
    assertEqual(faltam.join(','), '', 'toda vsp_* chamada existe em producao');
  });
});
