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

process.exit(erros || !filaOk || !identidadeOk || ausentes.length || achados.length || semId.length || voltou.length || faltam.length || legadoVoltou.length || semLedger.length ? 1 : 0);
