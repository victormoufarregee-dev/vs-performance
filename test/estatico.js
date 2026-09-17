const fs = require('fs');
// VSP_INDEX permite apontar para uma copia mutada, para provar que estas checagens
// realmente reprovam. Sem isso a trava seria intestavel.
const path = require('path');
const ALVO = process.env.VSP_INDEX || path.join(__dirname, '..', 'index.html');
// VSP_MIGRATIONS faz o mesmo pela pasta das migrations: as checagens sobre o texto
// do SQL tambem precisam poder rodar contra uma copia mutada, e nao so contra a real.
const MIGRACOES = process.env.VSP_MIGRATIONS || path.join(__dirname, '..', 'migrations');
const h = fs.readFileSync(ALVO, 'utf8');
console.log('arquivo sob teste:', ALVO);
console.log('migrations sob teste:', MIGRACOES);

// 1) sintaxe de todos os blocos de script
const blocos = [...h.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)];
let erros = 0;
blocos.forEach(b => { try { new Function(b[1]); } catch (e) { erros++; console.log('ERRO SINTAXE:', e.message); } });
console.log(erros ? 'SINTAXE: FALHOU' : 'SINTAXE: ok (' + blocos.length + ' blocos)');

// 2) toda funcao usada em onclick/onchange/oninput existe de fato
const usadas = new Set();
for (const m of h.matchAll(/on(?:click|change|input|submit)="([a-zA-Z_$][\w$]*)\(/g)) usadas.add(m[1]);
const ausentes = [...usadas].filter(f => {
  const re = new RegExp('(?:async\\s+)?function\\s+' + f + '\\s*\\(|(?:const|let|var)\\s+' + f + '\\s*=');
  return !re.test(h);
});
console.log(ausentes.length
  ? 'HANDLERS AUSENTES (' + ausentes.length + '): ' + ausentes.join(', ')
  : 'HANDLERS: ok, todas as ' + usadas.size + ' funcoes existem');

// 3) restos de codigo removido
const orfaos = ['repPagar', 'toggleRepPgto', 'lancarFin', 'repPgtoWrap'];
const achados = orfaos.filter(t => h.includes(t));
console.log(achados.length ? 'ORFAOS: ' + achados.join(', ') : 'ORFAOS: nenhum');

// 4) console.log esquecido
const logs = (h.match(/console\.log\(/g) || []).length;
console.log('console.log esquecidos:', logs);

// 5) ids referenciados por getElementById que nao existem no HTML
const ids = new Set();
for (const m of h.matchAll(/id="([^"]+)"/g)) ids.add(m[1]);
const refs = new Set();
for (const m of h.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);
const semId = [...refs].filter(r => !ids.has(r));
console.log(semId.length ? 'IDS INEXISTENTES (' + semId.length + '): ' + semId.join(', ') : 'IDS: ok, todos os ' + refs.size + ' referenciados existem');

// 6) as 4 operacoes criticas nao podem voltar a gravar tabela por tabela
const proibidos = ["sbPost('vendas'", "sbPost('reposicoes'", "sbDelete('reposicoes'", "cancelada:true"];
const voltou = proibidos.filter(t => h.includes(t));
console.log(voltou.length ? "CAMINHO ANTIGO VOLTOU: " + voltou.join(", ") : "FONTE CANONICA: ok, venda/compra/cancelamento/estorno so via RPC");
const rpcs = ["vsp_registrar_venda","vsp_registrar_compra","vsp_cancelar_venda","vsp_estornar_compra"];
const faltam = rpcs.filter(r => !h.includes(r));
console.log(faltam.length ? "RPC NAO CHAMADA: " + faltam.join(", ") : "RPCs: as 4 sao chamadas pelo app");

// 7) a Conta do Victor nao pode voltar a ser calculada por estoque
//    A formula legada era: custo ja vendido + valor do estoque - pago a fornecedores.
//    Qualquer reintroducao dela como fonte operacional reprova a build.
const formulaLegada = [
  'custoTot+valorEstTotal()',
  'mercadoriaFornecida',
  'faltaPagar',
  "filter(s=>s.tipo==='fornecedor').reduce",
];
const legadoVoltou = formulaLegada.filter(t => h.includes(t));
console.log(legadoVoltou.length
  ? 'FORMULA LEGADA VOLTOU: ' + legadoVoltou.join(', ')
  : 'LEDGER: ok, a divida com Victor nao e mais calculada por estoque');

// e os consumidores precisam de fato ler o razao
const consumidores = ['saldoVictor()', 'DB.ledger', 'v_ledger_victor', 'dashVictor', 'renderVictor'];
const semLedger = consumidores.filter(t => !h.includes(t));
console.log(semLedger.length
  ? 'CONSUMIDOR NAO MIGRADO: ' + semLedger.join(', ')
  : 'CONSUMIDORES: ok, Dashboard, Financeiro e extrato leem o ledger');

// 8) o razao nao pode voltar a confiar no nome que o frontend manda.
//    A vulnerabilidade de 15/09/2026 (item 005 de migrations/APLICADO.md): as RPCs
//    gravavam `p_usuario`/`usuario` do payload, e Stefany conseguiu assinar como
//    Victor na venda E na auditoria. A correcao foi vsp_ator(), que resolve o nome
//    a partir de auth.uid() na allowlist. O razao nasceu depois disso e tem de
//    seguir a mesma regra: quem escreve no ledger e a SESSAO, nunca o payload.
const sqlLedger = fs.readFileSync(path.join(MIGRACOES, '006_ledger_victor.sql'), 'utf8');
const usosAtor = sqlLedger.split('public.vsp_ator()').length - 1;
const confiaNoPayload = ["p_usuario", "p_created_by", "->>'usuario'", "->>'created_by'"]
  .filter(t => sqlLedger.includes(t));
const identidadeOk = usosAtor >= 2 && confiaNoPayload.length === 0;
console.log(identidadeOk
  ? 'IDENTIDADE DO RAZAO: ok, created_by vem de vsp_ator() (' + usosAtor + ' usos), nunca do payload'
  : 'IDENTIDADE DO RAZAO VOLTOU AO PAYLOAD: vsp_ator() usado ' + usosAtor + 'x' +
    (confiaNoPayload.length ? '; payload confiado em ' + confiaNoPayload.join(', ') : ''));

// 9) fila offline: sem sucesso inventado, persistida de verdade, op_id do registro.
//    Antes de 17/09/2026 o sbFetch devolvia um `new Response(eco,{status:200})` com o
//    proprio corpo quando a rede caia: a venda offline aparecia como "Venda registrada!"
//    e a fila era um array inteiro no localStorage, regravado por cada aba.
const filaProibido = ['new Response(eco', 'enfileirar(', 'lsSet(FILA_KEY'];
const filaObrigatorio = ['indexedDB.open(', 'p_op_id:item.op_id', "status:'enviando'", 'filaGuardar('];
const filaVoltou = filaProibido.filter(t => h.includes(t));
const filaFalta = filaObrigatorio.filter(t => !h.includes(t));
const filaOk = !filaVoltou.length && !filaFalta.length;
console.log(filaOk
  ? 'FILA OFFLINE: ok, intencoes em IndexedDB, op_id do registro, sem 200 inventado'
  : 'FILA OFFLINE QUEBRADA:' + (filaVoltou.length ? ' voltou ' + filaVoltou.join(', ') : '') +
    (filaFalta.length ? ' falta ' + filaFalta.join(', ') : ''));

// 10) conferencia de caixa: verificacao, nunca correcao.
//     O banco calcula e fotografa o esperado; o cliente so manda o que contou.
const sql007 = fs.readFileSync(path.join(MIGRACOES, '007_conferencia_caixa.sql'), 'utf8').replace(/\r\n/g, '\n');
const corpoSql007 = sql007.replace(/^\s*--.*$/gm, '');   // comentarios nao contam
const confProblemas = [];
if (!corpoSql007.includes('vsp_registrar_conferencia_caixa(p_saldo_real numeric, p_observacao text, p_op_id text)'))
  confProblemas.push('assinatura da RPC aceita mais que saldo real/observacao/op_id');
if (/p_saldo_esperado|p_diferenca|p_usuario|p_created_by/.test(corpoSql007))
  confProblemas.push('o cliente pode ditar esperado/diferenca/autor');
if (!corpoSql007.includes('check (diferenca = saldo_real - saldo_esperado)'))
  confProblemas.push('convencao diferenca = real - esperado');
if (!/create unique index if not exists ux_cc_op_id/.test(corpoSql007))
  confProblemas.push('op_id unico');
if (!/create trigger trg_cc_protege before update or delete on public\.conferencias_caixa/.test(corpoSql007))
  confProblemas.push('trigger de imutabilidade');
if (/insert\s+into\s+public\.(saidas|vendas|ledger_victor|reposicoes|produtos)|update\s+public\.(saidas|vendas|ledger_victor|reposicoes|produtos)|delete\s+from\s+public\./i.test(corpoSql007))
  confProblemas.push('a 007 grava em tabela de negocio (a conferencia so pode ler)');
// o banco de produção NÃO tem estes auxiliares (estão no arquivo 004, mas não foram
// aplicados assim — descoberto no ensaio de 17/09/2026). Usar qualquer um derruba a 007.
if (/public\.vsp_(brl|audit|novo_id|display|uid|exige_autorizacao)\(/.test(corpoSql007))
  confProblemas.push('a 007 depende de auxiliar que nao existe no banco (vsp_brl/vsp_audit/vsp_novo_id...)');
if ((corpoSql007.match(/public\.vsp_ator\(\)/g) || []).length < 2)
  confProblemas.push('autor fora de vsp_ator()');
if (!corpoSql007.includes('revoke all on function public.vsp_caixa_esperado_calc() from public, anon, authenticated'))
  confProblemas.push('conta interna exposta');
const chamadaConf = (h.match(/sbRpc\('vsp_registrar_conferencia_caixa',\{[^}]*\}/) || [''])[0];
if (!chamadaConf) confProblemas.push('app nao chama vsp_registrar_conferencia_caixa');
else if (/p_saldo_esperado|p_diferenca|p_usuario|created_by/.test(chamadaConf)) confProblemas.push('app manda esperado/diferenca/autor');
const confOk = !confProblemas.length;
console.log(confOk
  ? 'CONFERENCIA DE CAIXA: ok, esperado e autor no banco, foto imutavel, 007 so le o negocio'
  : 'CONFERENCIA DE CAIXA QUEBRADA: ' + confProblemas.join('; '));

// 11) contrato do banco: as migrations descrevem o banco de producao?
//     Ate 17/09/2026 a 004 descrevia RPCs com outra assinatura e auxiliares que nunca
//     existiram, e a 007 quase foi aplicada dependendo deles. contrato.js compara o que as
//     migrations criam (ultima definicao vence) com a foto de producao gravada em
//     test/sql/contrato_producao.json: corpo (md5), assinatura, linguagem, definer,
//     volatilidade, search_path e EXECUTE de anon.
const contratoLib = require('./sql/contrato.js');
const fotoContrato = JSON.parse(fs.readFileSync(path.join(__dirname, 'sql', 'contrato_producao.json'), 'utf8'));
const contrato = contratoLib.extrair(MIGRACOES);
const contratoProblemas = contratoLib.comparar(contrato, fotoContrato.funcoes);
// o app so pode chamar RPC que existe no contrato
const rpcsDoApp = [...new Set([...h.matchAll(/sbRpc\('(\w+)'/g)].map((m) => m[1]))];
const nomesContrato = new Set(Object.keys(contrato).map((k) => k.split('(')[0]));
rpcsDoApp.filter((r) => !nomesContrato.has(r)).forEach((r) => contratoProblemas.push('o app chama ' + r + ', que nao existe nas migrations'));
// a view do extrato tem de respeitar a RLS (vazou para anon ate 17/09/2026)
const sql006 = fs.readFileSync(path.join(MIGRACOES, '006_ledger_victor.sql'), 'utf8').replace(/\r\n/g, '\n');
if (!/create or replace view public\.v_ledger_victor with \(security_invoker = true\)/.test(sql006) ||
    !/revoke all on public\.v_ledger_victor from public, anon;/.test(sql006))
  contratoProblemas.push('v_ledger_victor sem security_invoker ou com SELECT para anon');
const contratoOk = !contratoProblemas.length;
console.log(contratoOk
  ? 'CONTRATO DO BANCO: ok, ' + Object.keys(contrato).length + ' funcoes das migrations = producao (' + (fotoContrato.tirada_em || '?') + '); ' + rpcsDoApp.length + ' RPCs do app existem; view do extrato protegida'
  : 'CONTRATO DO BANCO DIVERGE: ' + contratoProblemas.join('; '));

// 12) o razao acompanha TODO lancamento (008). Ate 17/09/2026 estornar compra, lancar ou
//     excluir pagamento ao fornecedor pelo Financeiro nao mexia na Conta do Victor.
//     O contrato compara corpo de funcao; os triggers em si sao conferidos aqui.
const sql008 = fs.readFileSync(path.join(MIGRACOES, '008_integridade_razao_caixa.sql'), 'utf8').replace(/\r\n/g, '\n')
  .replace(/^\s*--.*$/gm, '');
const razaoProblemas = [
  ['create trigger trg_lv_saida_inserida after insert on public.saidas', 'pagamento ao fornecedor nao credita o razao'],
  ['create trigger trg_lv_saida_excluida after delete on public.saidas', 'excluir pagamento nao estorna o credito'],
  ['create trigger trg_lv_saida_editada before update on public.saidas', 'pagamento ao fornecedor editavel'],
  ['create trigger trg_lv_reposicao_excluida after delete on public.reposicoes', 'estornar compra nao estorna o debito'],
  ['revoke execute on function public.vsp_ledger_estornar_origem(text,bigint,text) from authenticated', 'estorno do razao executavel pela API'],
].filter(([t]) => !sql008.includes(t)).map(([, m]) => m);
if (!/v\.data <= \(now\(\) at time zone 'America\/Sao_Paulo'\)::date/.test(sql008) ||
    !/s\.data <= \(now\(\) at time zone 'America\/Sao_Paulo'\)::date/.test(sql008))
  razaoProblemas.push('caixa esperado volta a somar lancamento futuro');
const razaoOk = !razaoProblemas.length;
console.log(razaoOk
  ? 'RAZAO E CAIXA: ok, triggers do razao em saidas/reposicoes, estorno fechado para a API, caixa so ate hoje'
  : 'RAZAO E CAIXA QUEBRADO: ' + razaoProblemas.join('; '));

process.exit(erros || !razaoOk || !contratoOk || !confOk || !filaOk || !identidadeOk || ausentes.length || achados.length || semId.length || voltou.length || faltam.length || legadoVoltou.length || semLedger.length ? 1 : 0);
