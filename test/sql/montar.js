#!/usr/bin/env node
'use strict';
/* =============================================================================
 * montar.js — monta o SQL de teste da Conferência de Caixa para o SQL Editor.
 * =============================================================================
 *
 *   node test/sql/montar.js            controle: migration 007 real + testes
 *   node test/sql/montar.js SM3        a mesma coisa com a mutação SM3 aplicada
 *   node test/sql/montar.js --todos    um arquivo por mutante + o controle
 *
 * Grava em test/sql/saida/<nome>.sql (pasta ignorada pelo git). Cada arquivo roda
 * inteiro numa transação e TERMINA com uma exceção proposital cuja mensagem é o
 * placar ("RESULTADO_CONFERENCIA: N ok, K falha(s) | ...") — a exceção desfaz a
 * migration, as conferências e as saídas de teste. Nada fica no banco.
 *
 * Esperado: controle = 0 falhas; cada mutante = pelo menos 1 falha. O resultado de
 * cada rodada fica anotado em migrations/APLICADO.md.
 *
 * Como em test/mutantes.js, cada trecho tem de casar o número exato de vezes; se não
 * casar, o script para (um mutante que não foi aplicado não prova nada).
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const MIGRATION = path.join(RAIZ, 'migrations', '007_conferencia_caixa.sql');
const TESTES = path.join(__dirname, 'conferencia_caixa.test.sql');
const SAIDA = path.join(__dirname, 'saida');

const MUTANTES = {
  SM1: {
    titulo: 'diferença vira esperado − real',
    trocas: [
      ['round(p_saldo_real, 2) - v_esp,', 'v_esp - round(p_saldo_real, 2),', 1],
      ['check (diferenca = saldo_real - saldo_esperado)', 'check (diferenca = saldo_esperado - saldo_real)', 1],
    ],
  },
  SM2: {
    titulo: 'o cliente consegue mandar o saldo esperado',
    trocas: [
      ['vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text)',
       'vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text, p_saldo_esperado numeric default null)', 1],
      ['vsp_registrar_conferencia_caixa(numeric,text,text)', 'vsp_registrar_conferencia_caixa(numeric,text,text,numeric)', 3],
      ['  v_esp := public.vsp_caixa_esperado_calc();', '  v_esp := coalesce(p_saldo_esperado, public.vsp_caixa_esperado_calc());', 1],
    ],
  },
  SM3: {
    titulo: 'retry cria uma segunda conferência',
    trocas: [
      ['  select * into v_c from public.conferencias_caixa where op_id = p_op_id;\n  if found then', '  if false then', 1],
      ['create unique index if not exists ux_cc_op_id', 'create index if not exists ux_cc_op_id', 1],
    ],
  },
  SM4: {
    titulo: 'Stefany consegue assinar como Victor',
    trocas: [
      ['vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text)',
       'vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text, p_usuario text default null)', 1],
      ['vsp_registrar_conferencia_caixa(numeric,text,text)', 'vsp_registrar_conferencia_caixa(numeric,text,text,text)', 3],
      ["  v_ator := public.vsp_ator();\n  if coalesce(btrim(v_ator),'') = '' then\n    raise exception 'nao foi possivel identificar quem esta conferindo'",
       "  v_ator := coalesce(nullif(btrim(p_usuario),''), public.vsp_ator());\n  if coalesce(btrim(v_ator),'') = '' then\n    raise exception 'nao foi possivel identificar quem esta conferindo'", 1],
    ],
  },
  SM5: {
    titulo: 'conferência histórica recalcula quando o caixa muda',
    trocas: [
      ['create trigger trg_cc_protege before update or delete on public.conferencias_caixa\n  for each row execute function public.vsp_cc_protege();',
       "create or replace function public.vsp_cc_recalcula() returns trigger language plpgsql security definer\n" +
       "set search_path = public, pg_temp as $m$ begin\n" +
       "  update public.conferencias_caixa set saldo_esperado = public.vsp_caixa_esperado_calc(),\n" +
       "         diferenca = saldo_real - public.vsp_caixa_esperado_calc();\n  return null; end $m$;\n" +
       "create trigger trg_cc_recalcula after insert or update or delete on public.saidas\n" +
       '  for each statement execute function public.vsp_cc_recalcula();', 1],
    ],
  },
  SM6: {
    titulo: 'erro de centavos (esperado inteiro, real arredondado)',
    trocas: [
      ['  v_esp  numeric(14,2);', '  v_esp  integer;', 1],
      ['  if p_saldo_real <> round(p_saldo_real, 2) then', '  if false then', 1],
      ['      (v_esp, round(p_saldo_real, 2), round(p_saldo_real, 2) - v_esp,', '      (v_esp, round(p_saldo_real), round(p_saldo_real) - v_esp,', 1],
    ],
  },
  SM7: {
    titulo: 'registrar a conferência "ajusta" o caixa esperado',
    trocas: [
      ["  perform public.vsp_cc_audit('CONFERENCIA_CAIXA',",
       "  if v_c.diferenca < 0 then  -- a falta vira uma saída de ajuste\n" +
       "    insert into public.saidas (id, tipo, socio, descricao, data, val, pgto)\n" +
       "    values ((select coalesce(max(id), 0) + 1 from public.saidas), 'outros', null, 'Ajuste de conferência', current_date, -v_c.diferenca, 'pix');\n" +
       "  end if;\n" +
       "  perform public.vsp_cc_audit('CONFERENCIA_CAIXA',", 1],
    ],
  },
};

function montar(id) {
  let sql = fs.readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  if (id) {
    const m = MUTANTES[id];
    if (!m) throw new Error('mutante desconhecido: ' + id);
    m.trocas.forEach(([de, para, vezes]) => {
      const achou = sql.split(de).length - 1;
      if (achou !== vezes) {
        throw new Error(id + ': trecho apareceu ' + achou + 'x, esperava ' + vezes + 'x — reescreva a mutacao.\n  ' + de.slice(0, 100));
      }
      sql = sql.split(de).join(para);
    });
  }
  const testes = fs.readFileSync(TESTES, 'utf8').replace(/\r\n/g, '\n');
  return '-- ' + (id ? 'MUTANTE ' + id + ': ' + MUTANTES[id].titulo : 'CONTROLE (migration 007 sem mutacao)') +
    '\n-- gerado por test/sql/montar.js — roda e desfaz tudo\n\n' + sql + '\n\n' + testes;
}

function gravar(id) {
  fs.mkdirSync(SAIDA, { recursive: true });
  const nome = (id || 'controle') + '.sql';
  fs.writeFileSync(path.join(SAIDA, nome), montar(id));
  return path.join(SAIDA, nome);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const ids = args.includes('--todos') ? [null].concat(Object.keys(MUTANTES)) : [args[0] || null];
  ids.forEach((id) => console.log((id || 'controle') + ' -> ' + gravar(id)));
}

module.exports = { MUTANTES, montar };
