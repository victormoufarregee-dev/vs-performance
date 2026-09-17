#!/usr/bin/env node
'use strict';
/* =============================================================================
 * reconstrucao.js — as migrations, EXECUTADAS, geram os mesmos corpos de produção?
 * =============================================================================
 *
 * contrato.js prova que o TEXTO das migrations tem o mesmo md5 que pg_proc.prosrc.
 * Este script fecha a outra ponta: monta um SQL com todos os `create or replace function`
 * das migrations 003 → 007 (na ordem, a última definição vence) seguidos de um bloco que
 * confere md5(prosrc) de cada função DENTRO do banco e termina com exceção — tudo é
 * desfeito. Enquanto a transação roda, as outras sessões seguem vendo as funções atuais.
 *
 * Não roda DDL de tabela, policy, índice ou dado: só funções.
 *
 *   node test/sql/reconstrucao.js     grava test/sql/saida/reconstrucao_funcoes.sql
 *
 * Esperado no SQL Editor:
 *   RESULTADO_RECONSTRUCAO: 17 funcoes conferidas, divergentes: nenhuma
 * DEPENDE DE ACESSO AO SUPABASE para rodar o SQL gerado.
 * ========================================================================== */

const fs = require('fs');
const path = require('path');
const { extrair } = require('./contrato.js');

const DIR = process.env.VSP_MIGRATIONS || path.join(__dirname, '..', '..', 'migrations');

function montar() {
  const arquivos = fs.readdirSync(DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f >= '003').sort();
  const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas\s+\$(\w*)\$([\s\S]*?)\$\4\$\s*;/gi;
  let sql = '-- ENSAIO gerado por test/sql/reconstrucao.js: recria as funcoes das migrations e confere o md5\n' +
            '-- dentro do banco. Termina em excecao: nada fica.\n\n';
  let n = 0;
  for (const arq of arquivos) {
    const texto = fs.readFileSync(path.join(DIR, arq), 'utf8').replace(/\r\n/g, '\n');
    let m;
    while ((m = re.exec(texto)) !== null) {
      const ini = texto.lastIndexOf('\n', m.index) + 1;
      if (/^\s*--/.test(texto.slice(ini, m.index))) continue;
      if (/^vsp_mig_/.test(m[1])) continue;            // auxiliares temporarios das migrations
      sql += '-- de ' + arq + '\n' + m[0] + '\n\n';
      n++;
    }
  }
  const contrato = extrair(DIR);
  const valores = Object.entries(contrato)
    .map(([k, v]) => "    ('" + k.replace(/'/g, "''") + "', '" + v.md5 + "')").join(',\n');
  // `reescritas`: quantas linhas de pg_proc foram gravadas POR ESTA transacao (xmin). Sem isso
  // o ensaio passaria mesmo que os create nao tivessem rodado, porque o esperado e o de producao.
  sql += 'do $ensaio$\ndeclare n int; falhas text; reescritas int;\nbegin\n' +
    "  select count(*), string_agg(x.k, ' | ') filter (where p.md5 is distinct from x.md5),\n" +
    "         count(*) filter (where p.xmin = (pg_current_xact_id()::text)::xid)\n" +
    '    into n, falhas, reescritas\n  from (values\n' + valores + '\n  ) x(k, md5)\n' +
    "  left join (select f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')' as k, md5(f.prosrc) as md5, f.xmin\n" +
    "               from pg_proc f join pg_namespace s on s.oid = f.pronamespace where s.nspname = 'public') p on p.k = x.k;\n" +
    "  raise exception 'RESULTADO_RECONSTRUCAO: % funcoes conferidas, % reescritas por esta transacao, divergentes: %', n, reescritas, coalesce(falhas, 'nenhuma');\n" +
    'end\n$ensaio$;\n';
  return { sql, criadas: n, conferidas: Object.keys(contrato).length };
}

if (require.main === module) {
  const r = montar();
  const saida = path.join(__dirname, 'saida');
  fs.mkdirSync(saida, { recursive: true });
  fs.writeFileSync(path.join(saida, 'reconstrucao_funcoes.sql'), r.sql);
  console.log('create or replace: ' + r.criadas + ' · funcoes conferidas: ' + r.conferidas + ' · ' + r.sql.length + ' bytes');
}

module.exports = { montar };
