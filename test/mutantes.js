#!/usr/bin/env node
'use strict';
/* =============================================================================
 * mutantes.js — prova que a suite REALMENTE pega o erro que diz pegar.
 * =============================================================================
 *
 * Uma suite verde nao prova nada por si so: ela pode estar verde porque nao olha
 * para o lugar certo. Teste de mutante inverte o onus da prova — estraga o codigo
 * de proposito, de um jeito que um programador distraido estragaria de verdade, e
 * exige que ALGUM caso falhe. Mutante que sobrevive e um buraco na suite.
 *
 * COMO RODA
 *   Para cada mutante:
 *     1. cria uma pasta temporaria;
 *     2. copia index.html e migrations/ para dentro dela;
 *     3. aplica a mutacao NA COPIA (o arquivo real nunca e tocado — este script
 *        abre o index.html do repositorio em modo leitura e nada mais);
 *     4. roda `node test/run.js` e `node test/estatico.js` com
 *        VSP_INDEX / VSP_MIGRATIONS apontando para a copia;
 *     5. le a saida: codigo de saida != 0 = mutante MORTO, e anota qual caso o matou;
 *     6. apaga a pasta temporaria.
 *
 *   Antes de tudo roda um CONTROLE: a copia sem mutacao nenhuma tem de passar nos
 *   dois comandos. Se o controle falha, o resto nao significa nada e o script para.
 *
 *   node test/mutantes.js          roda todos
 *   node test/mutantes.js M3 M5    roda so esses
 *   node test/mutantes.js --manter nao apaga as pastas temporarias (para inspecao)
 * ========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const INDEX_REAL = path.join(RAIZ, 'index.html');
const MIGR_REAL = path.join(RAIZ, 'migrations');

const ESC = String.fromCharCode(27);
const semCor = process.argv.includes('--sem-cor') || !!process.env.NO_COLOR;
const COR = (!semCor && (process.stdout.isTTY || process.argv.includes('--cor'))) ? {
  reset: ESC + '[0m', neg: ESC + '[1m', fraco: ESC + '[2m',
  verde: ESC + '[32m', vermelho: ESC + '[31m', amarelo: ESC + '[33m', azul: ESC + '[36m',
} : new Proxy({}, { get: () => '' });
const c = (cor, t) => COR[cor] + t + COR.reset;

// =============================================================================
// OS MUTANTES
//
// `de` tem de casar EXATAMENTE `vezes` vez(es) no arquivo original. Se o codigo
// mudar e o trecho nao casar mais, o script para com erro em vez de dar um falso
// "morto" — um mutante que nao chegou a ser aplicado nao prova nada.
// =============================================================================

const LEDGER_MOVS =
  'function ledgerMovs(){return Array.isArray(DB.ledger)?DB.ledger:[];}';
const SALDO_VICTOR =
  "function saldoVictor(){return ledgerMovs().reduce((a,m)=>a+(m.direcao==='debito'?m.valor:-m.valor),0);}";

const ADOTA_MOVIMENTO = '  if(res&&res.movimento&&res.movimento.id){';
const EMPURRA_MOVIMENTO = '      DB.ledger.push(nm);';

const MUTANTES = [
  {
    id: 'M1',
    titulo: 'compra nao cria movimento no razao',
    oQueMuda:
      'confReposicao para de adotar o movimento que a vsp_registrar_compra criou na ' +
      'mesma transacao: a compra entra no estoque e o razao nao registra o debito',
    arquivo: 'index.html',
    trocas: [[ADOTA_MOVIMENTO, '  if(false){', 1]],
  },
  {
    id: 'M1b',
    titulo: 'o razao esquece as compras (variante)',
    oQueMuda:
      'ledgerMovs() filtra fora os movimentos de compra — o mesmo efeito visivel de M1, ' +
      'mas atingindo todo mundo que le o razao, nao so o caminho da compra nova',
    arquivo: 'index.html',
    trocas: [[
      LEDGER_MOVS,
      "function ledgerMovs(){return Array.isArray(DB.ledger)?DB.ledger.filter(m=>m.tipo!=='compra_financiada'):[];}",
      1,
    ]],
  },
  {
    id: 'M2',
    titulo: 'compra cria o movimento duas vezes',
    oQueMuda:
      'confReposicao empurra o movimento devolvido DUAS vezes (com ids diferentes, ' +
      'para escapar da guarda de duplicidade): a divida sobe o dobro da compra',
    arquivo: 'index.html',
    trocas: [[
      EMPURRA_MOVIMENTO,
      '      DB.ledger.push(nm);DB.ledger.push(Object.assign({},nm,{id:nm.id+1}));',
      1,
    ]],
  },
  {
    id: 'M2b',
    titulo: 'o razao conta cada compra em dobro (variante)',
    oQueMuda:
      'ledgerMovs() devolve os movimentos de compra duplicados — o retrato de um ' +
      'backfill rodado duas vezes sem o indice unico de origem',
    arquivo: 'index.html',
    trocas: [[
      LEDGER_MOVS,
      'function ledgerMovs(){var _l=Array.isArray(DB.ledger)?DB.ledger:[];' +
      "return _l.concat(_l.filter(m=>m.tipo==='compra_financiada'));}",
      1,
    ]],
  },
  {
    id: 'M3',
    titulo: 'reembolso soma em vez de subtrair',
    oQueMuda:
      'o sinal do credito invertido em saldoVictor(): pagar o Victor passaria a ' +
      'AUMENTAR a divida com ele',
    arquivo: 'index.html',
    trocas: [[
      SALDO_VICTOR,
      "function saldoVictor(){return ledgerMovs().reduce((a,m)=>a+(m.direcao==='debito'?m.valor:m.valor),0);}",
      1,
    ]],
  },
  {
    id: 'M4',
    titulo: 'ajuste de estoque altera o saldo',
    oQueMuda:
      'saldoVictor() volta a somar o valor do estoque — quebra, perda e sobra de ' +
      'inventario voltariam a mexer na divida com o socio',
    arquivo: 'index.html',
    trocas: [[
      SALDO_VICTOR,
      "function saldoVictor(){return ledgerMovs().reduce((a,m)=>a+(m.direcao==='debito'?m.valor:-m.valor),0)+valorEstTotal();}",
      1,
    ]],
  },
  {
    id: 'M5',
    titulo: 'Dashboard volta a usar a formula antiga (CMV + estoque - pago)',
    oQueMuda:
      'o card da Conta do Victor no Dashboard para de ler o razao e volta a ' +
      'DERIVAR a divida do estoque, como antes de 16/09/2026',
    arquivo: 'index.html',
    trocas: [[
      '      const svD=saldoVictor();',
      '      const svD=DB.vendas.filter(v=>!v.cancelada).reduce((a,v)=>a+v.custo,0)' +
      "+valorEstTotal()-DB.saidas.filter(s=>s.tipo==='fornecedor').reduce((a,s)=>a+s.val,0);",
      1,
    ]],
  },
  {
    id: 'M6',
    titulo: 'identidade volta a confiar no payload',
    oQueMuda:
      'as funcoes do razao param de resolver o autor por vsp_ator() (auth.uid() na ' +
      'allowlist) e passam a gravar o nome que o cliente mandar — a impersonacao ' +
      'corrigida em 15/09/2026 volta, agora no razao financeiro',
    arquivo: 'migrations/006_ledger_victor.sql',
    trocas: [
      // 3 usos desde 17/09/2026: estorno de origem, reembolso e a compra vigente (que passou a
      // morar na 006 quando o arquivo foi alinhado ao banco)
      ['public.vsp_ator()', "coalesce(nullif(btrim(p_usuario),''),'sistema')", 3],
      [
        'vsp_ledger_estornar_origem(p_origem_tipo text, p_origem_id bigint, p_motivo text)',
        'vsp_ledger_estornar_origem(p_origem_tipo text, p_origem_id bigint, p_motivo text, p_usuario text default null)',
        1,
      ],
      [
        'vsp_reembolsar_victor(p_valor numeric, p_data date, p_descricao text, p_pgto text, p_op_id text)',
        'vsp_reembolsar_victor(p_valor numeric, p_data date, p_descricao text, p_pgto text, p_op_id text, p_usuario text default null)',
        1,
      ],
    ],
  },

  // ---------------------------------------------------------------------------
  // FILA OFFLINE (17/09/2026). Cada um e um jeito realista de a fila "funcionar" na
  // demonstracao e perder ou duplicar venda na vida real.
  // ---------------------------------------------------------------------------
  {
    id: 'OF-M1',
    titulo: 'fila so em memoria',
    oQueMuda:
      'filaGuardar poe a intencao no array da tela e diz que guardou, sem gravar no ' +
      'IndexedDB — recarregar a pagina apaga a venda offline',
    arquivo: 'index.html',
    trocas: [['    const ok=await armazemFila.gravar(item);', '    fila.push(item);renderOffBar();return item;', 1]],
  },
  {
    id: 'OF-M2',
    titulo: 'retry gera op_id novo',
    oQueMuda:
      'a partir da segunda tentativa o envio inventa um op_id novo — se a primeira ' +
      'chegou ao banco e a resposta se perdeu, a venda entra duas vezes',
    arquivo: 'index.html',
    trocas: [[
      'const params=Object.assign({},item.payload,{p_op_id:item.op_id});',
      'const params=Object.assign({},item.payload,{p_op_id:(item.tentativas>1?novoOpId():item.op_id)});',
      1,
    ]],
  },
  {
    id: 'OF-M3',
    titulo: 'remove a intencao antes da confirmacao',
    oQueMuda:
      'o trabalhador apaga a intencao do aparelho assim que comeca a enviar — se a ' +
      'rede cai no meio, a venda some',
    arquivo: 'index.html',
    trocas: [['        if(!pego)continue;', '        if(!pego)continue;await armazemFila.apagar(pego.id_local);', 1]],
  },
  {
    id: 'OF-M4',
    titulo: 'estoque insuficiente tratado como sucesso',
    oQueMuda:
      'a recusa "Estoque insuficiente" do servidor e classificada como ok: a venda ' +
      'que nao entrou aparece como confirmada',
    arquivo: 'index.html',
    trocas: [[
      "  if(/estoque insuficiente|estoque mudou/i.test(msg))return 'conflito';",
      "  if(/estoque insuficiente|estoque mudou/i.test(msg))return 'ok';",
      1,
    ]],
  },
  {
    id: 'OF-M5',
    titulo: 'dois trabalhadores enviam a mesma intencao',
    oQueMuda:
      'a troca para "enviando" deixa de conferir se a intencao ainda esta livre — duas ' +
      'abas pegam e enviam a mesma venda',
    arquivo: 'index.html',
    trocas: [["          if(!(a.status==='pendente'||filaOrfao(a,Date.now())))return null;", '          /* sem conferir */', 1]],
  },
  {
    id: 'OF-M6',
    titulo: '403 com retry infinito',
    oQueMuda:
      '401/403 passam a ser "transitorio": a fila repete para sempre uma chamada que ' +
      'o servidor nunca vai aceitar',
    arquivo: 'index.html',
    trocas: [[
      "  if(status===408||status===425||status===429||status>=500)return 'transitorio';",
      "  if(status===401||status===403||status===408||status===425||status===429||status>=500)return 'transitorio';",
      1,
    ]],
  },
  {
    id: 'OF-M7',
    titulo: 'tela mostra sincronizado enquanto pendente',
    oQueMuda:
      'o painel chama de "Sincronizado" a venda que so esta guardada no aparelho — o ' +
      'usuario acha que foi e fecha o app sem internet',
    arquivo: 'index.html',
    trocas: [["pendente:'Guardado neste aparelho'", "pendente:'Sincronizado'", 1]],
  },

  // ---------------------------------------------------------------------------
  // CONFERÊNCIA DE CAIXA (17/09/2026) — lado do app. Os mesmos oito riscos do lado do
  // banco (SM1..SM7) são provados em SQL real: test/sql/montar.js + migrations/APLICADO.md.
  // ---------------------------------------------------------------------------
  {
    id: 'CX-M1',
    titulo: 'diferença vira esperado − real',
    oQueMuda: 'a prévia mostra "sobra" quando falta dinheiro e vice-versa',
    arquivo: 'index.html',
    trocas: [['  const dif=real-CONF.esperado,e=confEstado(dif);', '  const dif=CONF.esperado-real,e=confEstado(dif);', 1]],
  },
  {
    id: 'CX-M2',
    titulo: 'app manda o saldo esperado',
    oQueMuda: 'o app passa o esperado da prévia ao banco — quem decide a foto deixaria de ser o servidor',
    arquivo: 'index.html',
    trocas: [[
      "res=await sbRpc('vsp_registrar_conferencia_caixa',{p_saldo_real:centavosTexto(real),p_observacao:obs,p_op_id:CONF.op});",
      "res=await sbRpc('vsp_registrar_conferencia_caixa',{p_saldo_real:centavosTexto(real),p_saldo_esperado:centavosTexto(CONF.esperado),p_observacao:obs,p_op_id:CONF.op});",
      1,
    ]],
  },
  {
    id: 'CX-M3',
    titulo: 'retry gera op_id novo (segunda conferência)',
    oQueMuda: 'cada clique em Confirmar inventa um op_id: resposta perdida + nova tentativa = duas conferências',
    arquivo: 'index.html',
    trocas: [["  CONF.salvando=true;showLoading('Registrando conferência...');", "  CONF.salvando=true;CONF.op=novoOpId();showLoading('Registrando conferência...');", 1]],
  },
  {
    id: 'CX-M4',
    titulo: 'app manda o nome de quem conferiu',
    oQueMuda: 'o autor volta a viajar no payload — a porta da impersonação corrigida em 15/09',
    arquivo: 'index.html',
    trocas: [[
      "res=await sbRpc('vsp_registrar_conferencia_caixa',{p_saldo_real:centavosTexto(real),p_observacao:obs,p_op_id:CONF.op});",
      "res=await sbRpc('vsp_registrar_conferencia_caixa',{p_saldo_real:centavosTexto(real),p_observacao:obs,p_op_id:CONF.op,p_usuario:currentUser});",
      1,
    ]],
  },
  {
    id: 'CX-M5',
    titulo: 'histórico recalcula com o caixa de hoje',
    oQueMuda: 'a coluna Esperado do histórico mostra o caixa atual em vez da foto gravada',
    arquivo: 'index.html',
    trocas: [['<td style="text-align:right;white-space:nowrap">${brlCentavos(c.saldoEsperado)}</td>', '<td style="text-align:right;white-space:nowrap">${brlCentavos(esp)}</td>', 1]],
  },
  {
    id: 'CX-M6',
    titulo: 'centavos truncados',
    oQueMuda: 'Math.trunc no lugar de Math.round: 100,01 vira 100,00 (100.01*100 = 10000.999…)',
    arquivo: 'index.html',
    trocas: [[
      'function centavosDe(v){const n=Number(v);return isFinite(n)?Math.round(n*100):0;}',
      'function centavosDe(v){const n=Number(v);return isFinite(n)?Math.trunc(n*100):0;}',
      1,
    ]],
  },
  {
    id: 'CX-M7',
    titulo: 'registrar "ajusta" o caixa',
    oQueMuda: 'depois de registrar, o app lança uma saída de ajuste para o caixa esperado bater com o real',
    arquivo: 'index.html',
    trocas: [[
      '  if(i>=0)DB.conferencias[i]=c;else DB.conferencias.unshift(c);',
      "  if(i>=0)DB.conferencias[i]=c;else DB.conferencias.unshift(c);if(c.diferenca)DB.saidas.push({id:Date.now(),tipo:'outros',socio:null,desc:'Ajuste de conferência',data:today(),val:-c.diferenca/100,pgto:'pix'});",
      1,
    ]],
  },
  {
    id: 'CX-M8',
    titulo: 'conferência offline usa o caixa da cópia local',
    oQueMuda: 'sem rede, o modal assume o caixa calculado com os dados do aparelho em vez de recusar',
    arquivo: 'index.html',
    trocas: [[
      "    closeModal('confModal');",
      "    if(e.semRede){CONF.esperado=caixaEsperadoPartes().centavos;document.getElementById('confEsperado').textContent=brlCentavos(CONF.esperado);return;}closeModal('confModal');",
      1,
    ]],
  },

  // ---------------------------------------------------------------------------
  // DRIFT DO BANCO (17/09/2026). O repositório voltando a descrever um banco que não é o
  // de produção — exatamente o que a 004 fazia e o que quase derrubou a 007.
  // ---------------------------------------------------------------------------
  {
    id: 'DR-M1',
    titulo: 'RPC de venda no arquivo diverge da produção',
    oQueMuda: 'a guarda de estoque vira "< 0": o arquivo passa a descrever uma venda que vende sem estoque (desde a 011 quem define a venda e a 011, nao a 004)',
    arquivo: 'migrations/011_derivados_no_banco.sql',
    trocas: [['if v_afetou = 0 then', 'if v_afetou < 0 then', 1]],
  },
  {
    id: 'DR-M2',
    titulo: 'view do extrato volta a vazar',
    oQueMuda: 'a 006 recria v_ledger_victor sem security_invoker e com SELECT para anon',
    arquivo: 'migrations/006_ledger_victor.sql',
    trocas: [
      ['create or replace view public.v_ledger_victor with (security_invoker = true) as', 'create or replace view public.v_ledger_victor as', 1],
      ['revoke all on public.v_ledger_victor from public, anon;', 'grant select on public.v_ledger_victor to anon;', 1],
    ],
  },
  {
    id: 'DR-M3',
    titulo: 'ator da sessão deixa de olhar o uid',
    oQueMuda: 'a 005 resolve o nome pelo primeiro autorizado ativo, não pela sessão',
    arquivo: 'migrations/005_ator_da_sessao.sql',
    trocas: [[
      '(select nome from public.usuarios_autorizados where uid = auth.uid() and ativo),',
      '(select nome from public.usuarios_autorizados where ativo limit 1),',
      1,
    ]],
  },
  {
    id: 'DR-M4',
    titulo: 'app chama RPC que não existe no banco',
    oQueMuda: 'o modal da conferência chama vsp_caixa_atual, que nenhuma migration cria',
    arquivo: 'index.html',
    trocas: [["sbRpc('vsp_caixa_esperado',{})", "sbRpc('vsp_caixa_atual',{})", 1]],
  },
  {
    id: 'DR-M5',
    titulo: 'migration volta a depender de auxiliar fictício',
    oQueMuda: 'a 007 volta a chamar vsp_audit, que só existia no rascunho da 004',
    arquivo: 'migrations/007_conferencia_caixa.sql',
    trocas: [["perform public.vsp_cc_audit('CONFERENCIA_CAIXA',", "perform public.vsp_audit('CONFERENCIA_CAIXA',", 1]],
  },

  // ---------------------------------------------------------------------------
  // RAZÃO E CAIXA (008, auditoria de encerramento de 17/09/2026). O lado do banco foi
  // provado em SQL real: test/sql/operacoes_razao.test.sql deu 23 ok / 11 falhas ANTES da 008
  // e 34/0 depois — é o controle negativo de cada correção abaixo.
  // ---------------------------------------------------------------------------
  {
    id: 'RZ-M1',
    titulo: 'estornar compra volta a deixar o débito no razão',
    oQueMuda: 'a 008 deixa de criar o trigger de reposição excluída',
    arquivo: 'migrations/008_integridade_razao_caixa.sql',
    trocas: [['create trigger trg_lv_reposicao_excluida after delete on public.reposicoes', 'create trigger trg_lv_reposicao_excluida after update on public.reposicoes', 1]],
  },
  {
    id: 'RZ-M2',
    titulo: 'app volta a somar venda futura no caixa',
    oQueMuda: 'caixaEsperadoPartes ignora a data da venda',
    arquivo: 'index.html',
    trocas: [[
      '  const recebido=DB.vendas.filter(v=>valida(v)&&(!v.data||v.data<=lim)).reduce((a,v)=>a+(+v.liq||0),0);',
      '  const recebido=DB.vendas.filter(v=>valida(v)).reduce((a,v)=>a+(+v.liq||0),0);',
      1,
    ]],
  },
  {
    id: 'RZ-M5',
    titulo: 'pagar fornecedor volta a deixar a Conta do Victor com saldo velho',
    oQueMuda: 'regSaida para de reler o extrato depois do trigger da 008',
    arquivo: 'index.html',
    trocas: [[
      "  const razaoOk=tipo!=='fornecedor'||await recarregarRazao();",
      '  const razaoOk=true;',
      1,
    ]],
  },
  {
    id: 'RZ-M6',
    titulo: 'estornar compra volta a deixar a Conta do Victor com saldo velho',
    oQueMuda: 'estornarCompra para de reler o extrato',
    arquivo: 'index.html',
    trocas: [[
      '  const razaoOk=await recarregarRazao();',
      '  const razaoOk=true;',
      1,
    ]],
  },
  {
    id: 'NB-M1',
    titulo: '"1.250" volta a virar R$ 1,25',
    oQueMuda: 'numBR perde a leitura de milhar com ponto',
    arquivo: 'index.html',
    trocas: [[
      "    else if(grupos(t,'.')&&ps.slice(1).every(g=>/^\\d{3}$/.test(g))){inteiro=ps.join('');}",
      "    else if(false){inteiro=ps.join('');}",
      1,
    ]],
  },
  {
    id: 'PERM-M1',
    titulo: 'backfill do razão volta a ser executável pela API',
    oQueMuda: 'a 009 deixa de revogar vsp_ledger_backfill de authenticated',
    arquivo: 'migrations/009_backfill_fechado.sql',
    trocas: [[
      'revoke execute on function public.vsp_ledger_backfill() from public, anon, authenticated;',
      'revoke execute on function public.vsp_ledger_backfill() from public, anon;',
      1,
    ]],
  },
  {
    id: 'RZ-M3',
    titulo: 'saldo do Victor volta a ser legível fora da allowlist',
    oQueMuda: 'a 008 tira a checagem de autorização de vsp_saldo_victor',
    arquivo: 'migrations/008_integridade_razao_caixa.sql',
    trocas: [['  if public.vsp_uid_sessao() is not null and not public.vsp_autorizado() then', '  if false then', 1]],
  },
  {
    id: 'RZ-M4',
    titulo: 'banco volta a somar venda futura no caixa esperado',
    oQueMuda: 'vsp_caixa_esperado_calc perde o filtro de data das vendas',
    arquivo: 'migrations/008_integridade_razao_caixa.sql',
    trocas: [["                   and v.data <= (now() at time zone 'America/Sao_Paulo')::date), 0)", '                   ), 0)', 1]],
  },

  // ---------------------------------------------------------------- 010 e 011 ----
  {
    id: 'GR-M1',
    titulo: 'anon volta a ter privilégio bruto em todas as tabelas',
    oQueMuda: 'a 010 deixa de revogar os grants padrão de anon',
    arquivo: 'migrations/010_grants_minimos.sql',
    trocas: [['revoke all on all tables in schema public from anon;', '-- revogacao removida', 1]],
  },
  {
    id: 'GR-M2',
    titulo: 'tabela nova volta a nascer aberta para anon',
    oQueMuda: 'a 010 deixa de mexer no default privilege do schema public',
    arquivo: 'migrations/010_grants_minimos.sql',
    trocas: [['alter default privileges for role postgres in schema public revoke all on tables from anon;', '-- default privilege intocado', 1]],
  },
  {
    id: 'GR-M3',
    titulo: 'authenticated volta a poder escrever em qualquer coluna de vendas',
    oQueMuda: 'a 011 devolve o UPDATE amplo em vendas',
    arquivo: 'migrations/011_derivados_no_banco.sql',
    trocas: [['revoke update on public.vendas from authenticated;', '-- UPDATE amplo mantido', 1]],
  },
  {
    id: 'DV-M1',
    titulo: 'o banco volta a aceitar o bruto que o navegador mandar',
    oQueMuda: 'a 011 perde a checagem de coerência do bruto',
    arquivo: 'migrations/011_derivados_no_banco.sql',
    trocas: [[
      "  v_dito := (p_venda->>'bruto')::numeric;\n  if v_dito is not null and abs(v_dito - v_bruto) > 0.01 then\n    raise exception 'valor incoerente: bruto enviado %, calculado %', v_dito, v_bruto; end if;",
      '  -- checagem removida',
      1,
    ]],
  },
  {
    id: 'DV-M2',
    titulo: 'o custo da venda volta a vir do payload',
    oQueMuda: 'a 011 usa o custo enviado pelo cliente em vez do produto travado',
    arquivo: 'migrations/011_derivados_no_banco.sql',
    trocas: [['  v_custo     := round(v_qtd * v_unit, 2);', "  v_custo     := round(coalesce((p_venda->>'custo')::numeric, v_qtd * v_unit), 2);", 1]],
  },
  {
    id: 'DV-M3',
    titulo: 'a quitação do fiado volta a ser PATCH direto com lucro do navegador',
    oQueMuda: 'a tela troca a RPC por sbPatch em vendas',
    arquivo: 'index.html',
    trocas: [[
      "  let res;\n  try{res=await sbRpc('vsp_quitar_fiado',{p_id:id,p_pgto:pg,p_op_id:novoOpId()});}",
      "  let res;\n  try{const c=v.custo,liq=v.liq-c;res=await sbPatch('vendas',id,{quitado:true,pgto_quitado:pg,lucro_liq:liq,margem:margemPct(v.bruto,liq),quitado_em:getNow().display});}",
      1,
    ]],
  },
  {
    id: 'NB-M3',
    titulo: 'numBR volta a adivinhar que "1,000" é mil',
    oQueMuda: 'a vírgula com 3 dígitos vira separador de milhar de novo',
    arquivo: 'index.html',
    trocas: [[
      "    if(frac&&!/^\\d{1,2}$/.test(frac))return{ok:false,v:0,motivo:'centavos têm 1 ou 2 dígitos'};",
      "    if(frac&&/^\\d{3}$/.test(frac)){inteiro=inteiro+frac;frac='';}\n    else if(frac&&!/^\\d{1,2}$/.test(frac))return{ok:false,v:0,motivo:'centavos têm 1 ou 2 dígitos'};",
      1,
    ]],
  },
  {
    id: 'NB-M4',
    titulo: 'a venda deixa de conferir os campos de dinheiro',
    oQueMuda: 'valor ambíguo volta a virar 0 em silêncio na tela de venda',
    arquivo: 'index.html',
    trocas: [[
      "  const numErro=conferirNums([['vValOrig','preço unitário'],['vDesc','desconto']]);\n  if(numErro){showToast(numErro,'err');return;}",
      '  const numErro=0;',
      1,
    ]],
  },
  {
    id: 'CL-M1',
    titulo: 'excluir cliente volta a ser o DELETE que a RLS engole em silêncio',
    oQueMuda: 'a tela troca a inativação por sbDelete e volta a anunciar sucesso',
    arquivo: 'index.html',
    trocas: [[
      "  try{await sbPatch('clientes',id,{ativo:false});if(c)c.ativo=false;if(c)await audit('CLIENTE_INATIVADO',`${c.nome} inativado por ${currentUser}`);}",
      "  try{await sbDelete('clientes',id);DB.clientes=DB.clientes.filter(x=>x.id!=id);if(c)await audit('CLIENTE_REMOVIDO',`${c.nome} removido por ${currentUser}`);}",
      1,
    ]],
  },
];

// =============================================================================
// infraestrutura
// =============================================================================

function copiarPasta(de, para) {
  fs.mkdirSync(para, { recursive: true });
  fs.readdirSync(de, { withFileTypes: true }).forEach((e) => {
    const a = path.join(de, e.name);
    const b = path.join(para, e.name);
    if (e.isDirectory()) copiarPasta(a, b);
    else fs.copyFileSync(a, b);
  });
}

/** Monta a copia do repositorio e aplica a mutacao nela. Nunca escreve na raiz. */
function preparar(m) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-mutante-' + m.id + '-'));
  fs.copyFileSync(INDEX_REAL, path.join(dir, 'index.html'));
  copiarPasta(MIGR_REAL, path.join(dir, 'migrations'));

  if (m.trocas) {
    const alvo = path.join(dir, m.arquivo.split('/').join(path.sep));
    // LF sempre: no Windows o autocrlf do Git deixa CRLF na copia de trabalho, e um
    // trecho escrito aqui com quebra de linha simples passaria a "aparecer 0x" —
    // mutante NAO APLICADO, que e pior que mutante vivo: nao prova nada e nao
    // chama atencao sozinho.
    let texto = fs.readFileSync(alvo, 'utf8').replace(/\r\n/g, '\n');
    m.trocas.forEach(([de, para, vezes]) => {
      const achou = texto.split(de).length - 1;
      if (achou !== vezes) {
        throw new Error(
          m.id + ': o trecho a mutar apareceu ' + achou + 'x em ' + m.arquivo +
          ', esperava ' + vezes + 'x. O codigo mudou — reescreva a mutacao ' +
          'antes de confiar neste resultado.\n  trecho: ' + de.slice(0, 90)
        );
      }
      texto = texto.split(de).join(para);
    });
    fs.writeFileSync(alvo, texto);
  }
  return dir;
}

function rodar(script, dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      VSP_INDEX: path.join(dir, 'index.html'),
      VSP_MIGRATIONS: path.join(dir, 'migrations'),
      NO_COLOR: '1',
    }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    codigo: r.status,
    saida: String(r.stdout || '') + String(r.stderr || ''),
  };
}

/** Mapa suite -> arquivo, lido das linhas "» Suite  [arquivo]" do run.js. */
function arquivoPorSuite(saida) {
  const mapa = {};
  const re = /^» (.+?)\s+\[([^\]]+)\]$/gm;
  let m;
  while ((m = re.exec(saida)) !== null) mapa[m[1].trim()] = m[2];
  return mapa;
}

/**
 * Quais casos da suite falharam (le a secao FALHAS do run.js), com o arquivo de
 * cada um. Os de ledger.test.js vem primeiro: sao os casos escritos para ESTE
 * comportamento, e e mais util saber que "o razao tem 21 movimentos" caiu do que
 * saber que algum caso de regressao geral caiu junto.
 */
function casosQueFalharam(saida) {
  const i = saida.indexOf('FALHAS');
  if (i < 0) return [];
  const mapa = arquivoPorSuite(saida);
  const casos = [];
  const re = /^\s+\d+\)\s+(.+?)\s+›\s+(.+)$/gm;
  let m;
  const trecho = saida.slice(i);
  while ((m = re.exec(trecho)) !== null) {
    casos.push({ suite: m[1], caso: m[2], arquivo: mapa[m[1]] || '?' });
  }
  const peso = (x) => (x.arquivo === 'ledger.test.js' || x.arquivo === 'fila.test.js' || x.arquivo === 'conferencia.test.js' || x.arquivo === 'contrato.test.js' ? 0
    : x.arquivo === 'estatico.test.js' ? 1 : 2);
  return casos.map((x, k) => ({ x, k }))
    .sort((a, b) => (peso(a.x) - peso(b.x)) || (a.k - b.k))
    .map((o) => o.x);
}

const SINAIS_ESTATICO = [
  /^SINTAXE: FALHOU.*$/m,
  /^HANDLERS AUSENTES.*$/m,
  /^ORFAOS: (?!nenhum).*$/m,
  /^IDS INEXISTENTES.*$/m,
  /^CAMINHO ANTIGO VOLTOU.*$/m,
  /^RPC NAO CHAMADA.*$/m,
  /^FORMULA LEGADA VOLTOU.*$/m,
  /^CONSUMIDOR NAO MIGRADO.*$/m,
  /^IDENTIDADE DO RAZAO VOLTOU.*$/m,
  /^FILA OFFLINE QUEBRADA.*$/m,
  /^CONFERENCIA DE CAIXA QUEBRADA.*$/m,
  /^CONTRATO DO BANCO DIVERGE.*$/m,
  /^RAZAO E CAIXA QUEBRADO.*$/m,
  /^PERMISSOES QUEBRADAS.*$/m,
];

function sinaisEstatico(saida) {
  return SINAIS_ESTATICO.map((re) => (saida.match(re) || [])[0]).filter(Boolean);
}

function limpar(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignora */ }
}

// =============================================================================
// main
// =============================================================================

function main() {
  const manter = process.argv.includes('--manter');
  const filtros = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const lista = MUTANTES.filter((m) => !filtros.length || filtros.includes(m.id));

  console.log('');
  console.log(c('neg', 'VS Performance — provas de mutante') +
    c('fraco', '  (Node ' + process.version + ')'));
  console.log(c('fraco', 'index.html real:  ' + INDEX_REAL + '  (somente leitura)'));
  console.log(c('fraco', 'migrations reais: ' + MIGR_REAL + '  (somente leitura)'));
  console.log('');

  // ------------------------------------------------------------ controle ----
  const dirC = preparar({ id: 'M0', arquivo: 'index.html', trocas: null });
  const cRun = rodar('run.js', dirC);
  const cEst = rodar('estatico.js', dirC);
  if (!manter) limpar(dirC);
  const controleOk = cRun.codigo === 0 && cEst.codigo === 0;
  console.log(
    (controleOk ? c('verde', 'CONTROLE ok') : c('vermelho', 'CONTROLE FALHOU')) +
    c('fraco', ' — copia sem mutacao: run.js saiu ' + cRun.codigo +
      ', estatico.js saiu ' + cEst.codigo));
  if (!controleOk) {
    console.log('');
    console.log(c('vermelho',
      'A copia LIMPA do repositorio nao passa na suite. Enquanto isso for verdade, ' +
      'nenhum resultado de mutante significa nada — um mutante "morto" poderia estar ' +
      'morrendo pelo motivo errado. Conserte a suite primeiro.'));
    console.log(cRun.saida.split('\n').slice(-40).join('\n'));
    console.log(cEst.saida);
    process.exitCode = 1;
    return;
  }
  const casosControle = cRun.saida.match(/RESUMO\s+(\d+) passaram/);
  if (casosControle) {
    console.log(c('fraco', '  (' + casosControle[1] + ' casos verdes no controle)'));
  }
  console.log('');

  // ------------------------------------------------------------ mutantes ----
  const linhas = [];
  lista.forEach((m) => {
    process.stdout.write(c('azul', m.id) + ' ' + m.titulo + ' ... ');
    let dir;
    try {
      dir = preparar(m);
    } catch (e) {
      console.log(c('vermelho', 'NAO APLICADO'));
      linhas.push({ m, estado: 'NAO APLICADO', matou: e.message.split('\n')[0], detalhe: '' });
      return;
    }
    const rRun = rodar('run.js', dir);
    const rEst = rodar('estatico.js', dir);
    if (!manter) limpar(dir); else console.log('\n  copia em ' + dir);

    const falhas = casosQueFalharam(rRun.saida);
    const sinais = sinaisEstatico(rEst.saida);
    const morto = rRun.codigo !== 0 || rEst.codigo !== 0;

    const quem = [];
    if (falhas.length) {
      quem.push('run.js: "' + falhas[0].caso + '"' +
        (falhas.length > 1 ? ' (+' + (falhas.length - 1) + ')' : ''));
    }
    if (sinais.length) quem.push('estatico.js: ' + sinais[0].split(':')[0]);
    if (morto && !quem.length) {
      quem.push('run.js saiu ' + rRun.codigo + ', estatico.js saiu ' + rEst.codigo +
        ' (sem caso nomeado — provavelmente erro de carga)');
    }

    console.log(morto ? c('verde', 'MORTO') : c('vermelho', 'SOBREVIVEU'));
    linhas.push({
      m,
      estado: morto ? 'morto' : 'SOBREVIVEU',
      matou: quem.join('  ·  ') || '—',
      falhas,
      sinais,
      detalhe: 'run.js=' + rRun.codigo + ' estatico.js=' + rEst.codigo +
        ' · ' + falhas.length + ' caso(s) da suite falharam',
    });
  });

  // -------------------------------------------------------------- tabela ----
  console.log('');
  const larg = [8, 46, 62, 12];
  const corta = (s, n) => (s.length <= n ? s + ' '.repeat(n - s.length) : s.slice(0, n - 1) + '…');
  const risco = '─'.repeat(larg.reduce((a, b) => a + b + 3, 0) - 3);

  console.log(c('neg', 'TABELA DE MUTANTES'));
  console.log(risco);
  console.log([
    corta('MUTANTE', larg[0]), corta('O QUE MUDA', larg[1]),
    corta('QUEM MATOU', larg[2]), corta('RESULTADO', larg[3]),
  ].join(' │ '));
  console.log(risco);

  linhas.forEach((l) => {
    const oQue = l.m.titulo;
    const partes = [
      corta(l.m.id, larg[0]),
      corta(oQue, larg[1]),
      corta(l.matou, larg[2]),
      l.estado === 'morto' ? c('verde', corta('morto', larg[3]))
        : c('vermelho', corta(l.estado, larg[3])),
    ];
    console.log(partes.join(' │ '));
  });
  console.log(risco);

  console.log('');
  console.log(c('neg', 'DETALHE'));
  linhas.forEach((l) => {
    console.log('  ' + c('azul', l.m.id) + ' — ' + l.m.titulo);
    console.log('     arquivo mutado: ' + l.m.arquivo + c('fraco', '  (numa copia temporaria)'));
    console.log('     efeito: ' + l.m.oQueMuda);
    if (l.estado === 'morto') {
      console.log('     ' + c('verde', 'MORTO por:'));
      (l.falhas || []).slice(0, 3).forEach((f) => {
        console.log('       - ' + f.arquivo + ' › ' + f.suite + ' › "' + f.caso + '"');
      });
      if ((l.falhas || []).length > 3) {
        console.log('       ' + c('fraco', '  (e outros ' + (l.falhas.length - 3) + ' caso(s))'));
      }
      (l.sinais || []).forEach((s) => console.log('       - estatico.js › ' + s));
    } else {
      console.log('     ' + c('vermelho', l.estado + ' — ') + l.matou);
    }
    if (l.detalhe) console.log('     ' + c('fraco', l.detalhe));
  });

  const sobreviventes = linhas.filter((l) => l.estado !== 'morto');
  console.log('');
  console.log(c('neg', '─'.repeat(64)));
  console.log(
    c('neg', 'RESUMO  ') +
    c('verde', (linhas.length - sobreviventes.length) + ' morto(s)') + '  ' +
    (sobreviventes.length ? c('vermelho', sobreviventes.length + ' SOBREVIVEU/SOBREVIVERAM')
                          : c('fraco', '0 sobreviventes')) +
    c('fraco', '  ·  ' + linhas.length + ' mutante(s)'));
  if (sobreviventes.length) {
    console.log('');
    console.log(c('vermelho',
      'Mutante vivo = buraco na suite. Escreva o caso que falta e rode de novo:'));
    sobreviventes.forEach((l) => console.log('  - ' + l.m.id + ': ' + l.m.titulo));
    process.exitCode = 1;
  }
  console.log('');
  console.log(c('fraco',
    'Nenhum arquivo do repositorio foi alterado: cada mutacao viveu numa pasta ' +
    'temporaria, apontada por VSP_INDEX/VSP_MIGRATIONS, e foi apagada no fim.'));
  console.log('');
}

main();
