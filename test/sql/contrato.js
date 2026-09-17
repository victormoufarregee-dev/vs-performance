#!/usr/bin/env node
'use strict';
/* =============================================================================
 * contrato.js — o repositório representa o banco de produção?
 * =============================================================================
 *
 * Lê as migrations NA ORDEM (000 → 007), extrai cada `create or replace function
 * public.X(...)` — a última definição de um nome vence, como no banco — e monta o
 * CONTRATO que os arquivos descrevem: assinatura, linguagem, SECURITY DEFINER,
 * volatilidade, search_path e o md5 do corpo (o texto entre os $tag$, com quebras de
 * linha normalizadas para LF, que é o que o PostgreSQL guarda em pg_proc.prosrc).
 *
 *   node test/sql/contrato.js            compara com a foto de produção gravada em
 *                                        test/sql/contrato_producao.json (sai 1 se divergir)
 *   node test/sql/contrato.js --sql      imprime a consulta que gera essa foto: rode no
 *                                        SQL Editor e grave o resultado no .json
 *   node test/sql/contrato.js --manifesto  imprime o contrato extraído dos arquivos
 *
 * O que NÃO é contrato (e não é comparado): dono da função, OID, grants do service_role
 * (padrão do Supabase), formatação de pg_get_functiondef. Grants que importam
 * (anon/PUBLIC sem EXECUTE; authenticated com EXECUTE só no que o app chama) vêm na foto.
 *
 * DEPENDE DE ACESSO AO SUPABASE só para ATUALIZAR a foto. A comparação roda offline.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.VSP_MIGRATIONS || path.join(__dirname, '..', '..', 'migrations');
const FOTO = process.env.VSP_CONTRATO || path.join(__dirname, 'contrato_producao.json');

const TIPOS = { int: 'integer', int4: 'integer', int8: 'bigint', bool: 'boolean', float8: 'double precision' };

function normArgs(lista) {
  // "p_id bigint, p_motivo text default null" -> "p_id bigint, p_motivo text"
  const partes = [];
  let prof = 0, atual = '';
  for (const ch of lista) {
    if (ch === '(') prof++;
    if (ch === ')') prof--;
    if (ch === ',' && prof === 0) { partes.push(atual); atual = ''; } else atual += ch;
  }
  if (atual.trim()) partes.push(atual);
  return partes.map((p) => {
    const semDefault = p.replace(/\s+default\s+[\s\S]*$/i, '').replace(/\s*:=[\s\S]*$/, '').trim().replace(/\s+/g, ' ');
    const [nome, ...tipo] = semDefault.split(' ');
    const t = tipo.join(' ').toLowerCase();
    return nome + ' ' + (TIPOS[t] || t);
  }).join(', ');
}

function extrair(dir) {
  const arquivos = fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const contrato = {};
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+\$(\w*)\$([\s\S]*?)\$\4\$/gi;
  for (const arq of arquivos) {
    const texto = fs.readFileSync(path.join(dir, arq), 'utf8').replace(/\r\n/g, '\n');
    let m;
    // eventos na ordem do arquivo: criar ou derrubar (os vsp_mig_* nascem e morrem na mesma migration)
    const eventos = [];
    const reDrop = /^[ \t]*drop\s+function\s+if\s+exists\s+public\.(\w+)\s*\(/gim;
    while ((m = reDrop.exec(texto)) !== null) eventos.push({ pos: m.index, drop: m[1] });
    while ((m = re.exec(texto)) !== null) eventos.push({ pos: m.index, m });
    eventos.sort((x, y) => x.pos - y.pos);
    for (const ev of eventos) {
      if (ev.drop) { Object.keys(contrato).filter((k) => k.startsWith(ev.drop + '(')).forEach((k) => delete contrato[k]); continue; }
      m = ev.m;
      const inicioLinha = texto.lastIndexOf('\n', m.index) + 1;
      if (/^\s*--/.test(texto.slice(inicioLinha, m.index))) continue;   // exemplo comentado
      const cab = m[3].toLowerCase();
      const corpo = m[5];
      const chave = m[1] + '(' + normArgs(m[2]) + ')';
      Object.keys(contrato).filter((k) => k.startsWith(m[1] + '(') && k !== chave)
        .forEach((k) => { contrato[k].sobrescritaPor = arq; });
      contrato[chave] = {
        arquivo: arq,
        lang: (cab.match(/language\s+(\w+)/) || [])[1] || '?',
        secdef: /security\s+definer/.test(cab),
        vol: /\bimmutable\b/.test(cab) ? 'i' : /\bstable\b/.test(cab) ? 's' : 'v',
        search_path: (cab.match(/set\s+search_path\s*=\s*([^\n]*?)\s*$/m) || [])[1] || null,
        md5: crypto.createHash('md5').update(corpo, 'utf8').digest('hex'),
        len: corpo.length,
      };
    }
  }
  // assinaturas trocadas (mesmo nome, outros parametros) nao existem mais no banco
  Object.keys(contrato).forEach((k) => { if (contrato[k].sobrescritaPor) delete contrato[k]; });
  return contrato;
}

const SQL_FOTO = `select jsonb_object_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
  jsonb_build_object(
    'lang', l.lanname, 'secdef', p.prosecdef, 'vol', p.provolatile,
    'search_path', (select substring(c from 'search_path=(.*)') from unnest(p.proconfig) c where c like 'search_path=%'),
    'md5', md5(p.prosrc), 'len', length(p.prosrc), 'ret', pg_get_function_result(p.oid),
    'anon', has_function_privilege('anon', p.oid, 'execute'),
    'authenticated', has_function_privilege('authenticated', p.oid, 'execute')
  ))::text as contrato
from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
where n.nspname = 'public' and p.proname like 'vsp%';`;

function comparar(contrato, foto) {
  const problemas = [];
  const nomes = new Set([...Object.keys(contrato), ...Object.keys(foto)]);
  for (const k of [...nomes].sort()) {
    const a = contrato[k], b = foto[k];
    if (!a) { problemas.push(k + ': existe em produção e NÃO está em nenhuma migration'); continue; }
    if (!b) { problemas.push(k + ': está em ' + a.arquivo + ' e NÃO existe em produção'); continue; }
    const campos = ['lang', 'secdef', 'vol', 'md5'];
    campos.forEach((c) => { if (a[c] !== b[c]) problemas.push(k + ': ' + c + ' no arquivo ' + a[c] + ' ≠ produção ' + b[c] + ' (' + a.arquivo + ')'); });
    const sp = (s) => String(s || '').replace(/['"\s]/g, '');
    if (sp(a.search_path) !== sp(b.search_path)) problemas.push(k + ': search_path ' + a.search_path + ' ≠ ' + b.search_path);
    // funcao de trigger nao pode ser chamada direto (o PostgreSQL recusa fora de um trigger)
    if (b.anon && b.ret !== 'trigger') problemas.push(k + ': anon (ou PUBLIC) pode executar em produção');
  }
  return problemas;
}

if (require.main === module) {
  const contrato = extrair(DIR);
  if (process.argv.includes('--sql')) { console.log(SQL_FOTO); process.exit(0); }
  if (process.argv.includes('--manifesto')) { console.log(JSON.stringify(contrato, null, 2)); process.exit(0); }
  let foto;
  try { foto = JSON.parse(fs.readFileSync(FOTO, 'utf8')); }
  catch (e) { console.log('CONTRATO: sem foto de produção em ' + FOTO + ' — DEPENDE DE ACESSO AO SUPABASE'); process.exit(1); }
  const funcoes = foto.funcoes || foto;
  const problemas = comparar(contrato, funcoes);
  console.log('migrations: ' + DIR);
  console.log('foto de produção: ' + FOTO + (foto.tirada_em ? ' (' + foto.tirada_em + ')' : ''));
  console.log('funções no repositório: ' + Object.keys(contrato).length + ' · em produção: ' + Object.keys(funcoes).length);
  if (problemas.length) {
    console.log('CONTRATO DIVERGE (' + problemas.length + '):');
    problemas.forEach((p) => console.log('  - ' + p));
    process.exit(1);
  }
  console.log('CONTRATO: ok, cada função de produção está nas migrations com o mesmo corpo, assinatura, linguagem, definer, volatilidade e search_path; nenhuma executável por anon');
}

module.exports = { extrair, comparar, normArgs, SQL_FOTO };
