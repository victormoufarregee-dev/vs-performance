const fs = require('fs');
const h = fs.readFileSync(require('path').join(__dirname,'..','index.html'), 'utf8');

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

process.exit(erros || ausentes.length || achados.length || semId.length || voltou.length || faltam.length ? 1 : 0);
