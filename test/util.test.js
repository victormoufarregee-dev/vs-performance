'use strict';
/* =============================================================================
 * util.test.js — as funcoes pequenas que todo o resto usa.
 * =============================================================================
 * Tambem documenta o comportamento ATUAL de leitura de numero (parseFloat), que
 * nao e um detalhe: e por onde um valor digitado com virgula entra errado no
 * banco e nunca mais sai.
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

let h;

function escopo() {
  if (!h) {
    h = H.carregar();
    h.carregarDB(F.dbMinimo());
  }
  return h.escopo;
}

// =============================================================================
describe('R() — formatacao de dinheiro', () => {

  it('formata com duas casas e prefixo R$', () => {
    const e = escopo();
    assertEqual(e.R(0), 'R$ 0.00', 'zero');
    assertEqual(e.R(1), 'R$ 1.00', 'inteiro');
    assertEqual(e.R(1.5), 'R$ 1.50', 'uma casa');
    assertEqual(e.R(145.625), 'R$ 145.63', 'arredonda para cima no meio centavo');
    assertEqual(e.R(582.5), 'R$ 582.50', 'custo da caixa do TG');
  });

  it('trata valor negativo', () => {
    assertEqual(escopo().R(-3.49), 'R$ -3.49', 'o resultado de caixa da baseline');
  });

  it('nulo, undefined e NaN viram zero', () => {
    const e = escopo();
    assertEqual(e.R(null), 'R$ 0.00', 'null');
    assertEqual(e.R(undefined), 'R$ 0.00', 'undefined');
    assertEqual(e.R(NaN), 'R$ 0.00', 'NaN (por causa do `||0`)');
    assertEqual(e.R(''), 'R$ 0.00', 'string vazia');
  });

  it('DOCUMENTADO: texto nao numerico vira "R$ NaN" na tela', () => {
    assertEqual(escopo().R('abc'), 'R$ NaN',
      'Number("abc") e NaN e o `||0` nao pega, porque NaN nao e falsy aqui — ' +
      'so acontece com dado sujo vindo do banco');
  });

  it('DOCUMENTADO: nao ha separador de milhar nem virgula decimal', () => {
    const e = escopo();
    assertEqual(e.R(51069.49), 'R$ 51069.49',
      'o padrao brasileiro seria R$ 51.069,49 — o app usa toFixed(2) cru');
    assertEqual(e.R(1234567.891), 'R$ 1234567.89', 'idem para valores grandes');
  });

  it('e consistente com o que os testes financeiros raspam do HTML', () => {
    const e = escopo();
    const m = e.R(23539.3).match(/^R\$ (\d+\.\d{2})$/);
    assertTrue(!!m, 'o formato tem de continuar raspavel por /R\\$ (\\d+\\.\\d{2})/');
    assertEqual(Number(m[1]), 23539.30, 'valor de volta');
  });
});

// =============================================================================
describe('margemPct() e calcMarg() — as duas margens do app', () => {

  it('margemPct e a margem sobre a venda (lucro / bruto)', () => {
    const e = escopo();
    assertClose(e.margemPct(100, 25), 25, '25 de lucro em 100 vendidos');
    assertClose(e.margemPct(1000, 417.50), 41.75, 'caso da venda com taxa');
    assertClose(e.margemPct(400, 254.37), 63.5925, 'venda de frasco do fixture');
  });

  it('bruto zero devolve 0 em vez de dividir por zero', () => {
    const e = escopo();
    assertEqual(e.margemPct(0, 500), 0, 'bruto zero');
    assertEqual(e.margemPct(null, 500), 0, 'bruto nulo');
  });

  it('lucro negativo devolve margem negativa', () => {
    assertClose(escopo().margemPct(100, -20), -20, 'venda no prejuizo');
  });

  it('calcMarg e a margem sobre o CUSTO (markup) — nao confundir', () => {
    const e = escopo();
    assertClose(e.calcMarg(200, 100), 100, 'dobrar o custo = 100% sobre o custo');
    assertClose(e.margemPct(200, 100), 50, 'o mesmo caso da 50% sobre a venda');
    assertEqual(e.calcMarg(200, 0), 0, 'custo zero devolve 0');
  });

  it('mPill pinta a faixa da margem (verde >= 40, ambar >= 20, vermelho abaixo)', () => {
    const e = escopo();
    assertInclui(e.mPill(45), 'mp-green', '45%');
    assertInclui(e.mPill(40), 'mp-green', 'limite de 40');
    assertInclui(e.mPill(39.9), 'mp-amber', 'logo abaixo de 40');
    assertInclui(e.mPill(20), 'mp-amber', 'limite de 20');
    assertInclui(e.mPill(19.9), 'mp-red', 'logo abaixo de 20');
    assertInclui(e.mPill(45), '45.0%', 'uma casa decimal');
  });
});

// =============================================================================
describe('Datas — fmtD, today, ymd, addDias', () => {

  it('fmtD vira ISO em dd/mm/aaaa', () => {
    const e = escopo();
    assertEqual(e.fmtD('2026-09-15'), '15/09/2026', 'data da baseline');
    assertEqual(e.fmtD('2026-01-01'), '01/01/2026', 'virada de ano');
  });

  it('fmtD com entrada vazia devolve string vazia (nao "undefined")', () => {
    const e = escopo();
    assertEqual(e.fmtD(''), '', 'vazio');
    assertEqual(e.fmtD(null), '', 'null');
    assertEqual(e.fmtD(undefined), '', 'undefined');
  });

  it('DOCUMENTADO: fmtD nao normaliza — ISO sem zero a esquerda sai torto', () => {
    assertEqual(escopo().fmtD('2026-9-5'), '5/9/2026',
      'ele so troca a ordem dos pedacos; quem grava a data e o <input type=date>, ' +
      'que sempre manda 2026-09-05');
  });

  it('today() usa a data LOCAL, nao UTC (era o bug das 21h virando o dia)', () => {
    const e = escopo();
    const hoje = today_local();
    assertEqual(e.today(), hoje, 'today() tem de ser a data do relogio da maquina');
    assertMatch(e.today(), /^\d{4}-\d{2}-\d{2}$/, 'formato ISO curto');
    // se usasse toISOString(), depois das 21h no Brasil o dia adiantaria
    const iso = new Date().toISOString().slice(0, 10);
    assertTrue(e.today() === hoje,
      'local=' + hoje + ' / UTC=' + iso + ' — o app tem de seguir o local');
  });

  it('ymd formata qualquer Date com zero a esquerda', () => {
    const e = escopo();
    assertEqual(e.ymd(new Date(2026, 0, 5)), '2026-01-05', '5 de janeiro');
    assertEqual(e.ymd(new Date(2026, 11, 31)), '2026-12-31', 'ultimo dia do ano');
  });

  it('addDias atravessa mes e ano sem escorregar de fuso', () => {
    const e = escopo();
    assertEqual(e.addDias('2026-09-15', 15), '2026-09-30', 'vencimento padrao do fiado');
    assertEqual(e.addDias('2026-08-25', 10), '2026-09-04', 'vira o mes');
    assertEqual(e.addDias('2026-12-28', 5), '2027-01-02', 'vira o ano');
    assertEqual(e.addDias('2026-09-15', 0), '2026-09-15', 'zero dia');
    assertEqual(e.addDias('2026-09-15', -15), '2026-08-31', 'para tras');
  });

  it('mesAtualISO e o mes de today()', () => {
    const e = escopo();
    assertEqual(e.mesAtualISO(), e.today().slice(0, 7), 'mes corrente');
  });

  it('brDateTimeToDate le o "15/09/2026 10:00:00" do log de auditoria', () => {
    const e = escopo();
    const d = e.brDateTimeToDate('15/09/2026 10:00:00');
    assertEqual(d.getFullYear(), 2026, 'ano');
    assertEqual(d.getMonth(), 8, 'mes (0 = janeiro)');
    assertEqual(d.getDate(), 15, 'dia');
    assertNull(e.brDateTimeToDate(''), 'vazio devolve null');
    assertNull(e.brDateTimeToDate('sem data'), 'lixo devolve null');
  });

  function today_local() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
});

// =============================================================================
describe('Leitura de numero — parseFloat/parseInt como o app usa', () => {

  it('PROVA: parseFloat("150,00") devolve 150 — a virgula e os centavos somem', () => {
    assertEqual(parseFloat('150,00'), 150,
      'parseFloat para de ler na virgula e NAO avisa ninguem');
    assertEqual(parseFloat('582,50'), 582, 'o custo da caixa perderia 50 centavos');
    assertEqual(parseFloat('0,99'), 0, 'noventa e nove centavos viram zero');
  });

  it('PROVA: no formato brasileiro cheio o erro fica grotesco', () => {
    assertEqual(parseFloat('1.234,56'), 1.234,
      'mil duzentos e trinta e quatro reais viram um real e vinte e tres centavos');
    assertEqual(parseFloat('51.069,49'), 51.069, 'o total de saidas da baseline');
  });

  it('Number() rejeita a virgula em vez de truncar (comportamentos diferentes)', () => {
    assertTrue(Number.isNaN(Number('150,00')), 'Number devolve NaN');
    assertEqual(parseFloat('150,00'), 150, 'parseFloat devolve 150');
    assertTrue(Number.isNaN(Number('R$ 150')), 'com prefixo tambem e NaN');
    assertTrue(Number.isNaN(parseFloat('R$ 150')), 'parseFloat tambem nao le prefixo');
  });

  it('o idioma do `|| 0` do app: vazio e lixo viram zero, nunca NaN', () => {
    assertEqual(parseFloat('') || 0, 0, 'campo vazio');
    assertEqual(parseFloat('abc') || 0, 0, 'texto');
    assertEqual(parseInt('', 10) || 0, 0, 'parseInt vazio');
    // e por isso que confReposicao consegue barrar com "Preencha quantidade..."
  });

  it('parseInt trunca a quantidade sem reclamar', () => {
    assertEqual(parseInt('8', 10), 8, 'inteiro');
    assertEqual(parseInt('8.9', 10), 8, 'decimal com ponto');
    assertEqual(parseInt('8,9', 10), 8, 'decimal com virgula');
    assertEqual(parseInt('08', 10), 8, 'zero a esquerda');
  });

  it('DOCUMENTADO: o HTML segura o caso comum, o placeholder nao ajuda', () => {
    // os campos de dinheiro sao <input type="number">, que no navegador ja
    // impede a virgula no teclado fisico. Mas o placeholder mostra "0,00" e
    // texto colado / teclado de celular ainda chegam com virgula — e ai o
    // parseFloat trunca calado. O caso ponta-a-ponta esta em financeiro.test.js
    // ("digitar 582,50 com virgula perde os centavos").
    const html = require('fs').readFileSync(H.resolverIndex(), 'utf8');
    const i = html.indexOf('id="repCustUnit"');
    assertMaior(i, 0, 'o campo de custo unitario existe');
    const trecho = html.slice(i - 200, i + 200);
    assertInclui(trecho, 'type="number"', 'o campo e numerico');
    assertInclui(html.slice(html.indexOf('id="vValOrig"') - 200, html.indexOf('id="vValOrig"') + 200),
      'placeholder="0,00"', 'e o placeholder ensina virgula');
  });
});

// =============================================================================
describe('Helpers de produto e estoque', () => {

  it('fpcOf devolve 1 quando o produto nao tem frascos por caixa', () => {
    const e = escopo();
    assertEqual(e.fpcOf({ fpc: 4 }), 4, 'com fpc');
    assertEqual(e.fpcOf({}), 1, 'sem fpc');
    assertEqual(e.fpcOf(null), 1, 'sem produto');
    assertEqual(e.fpcOf({ fpc: 0 }), 1, 'fpc zero nao pode zerar divisao');
  });

  it('totFP converte tudo para frascos equivalentes', () => {
    const e = escopo();
    assertEqual(e.totFP({ caixas: 8, frascos: 0, fpc: 4 }), 32, '8 caixas de 4');
    assertEqual(e.totFP({ caixas: 8, frascos: 3, fpc: 4 }), 35, 'com frascos soltos');
    assertEqual(e.totFP({ caixas: 0, frascos: 0, fpc: 4 }), 0, 'vazio');
  });

  it('cuProd escolhe o custo pelo tipo vendido', () => {
    const e = escopo();
    const p = F.produtoTG();
    assertClose(e.cuProd(p, 'caixa', 2), 1165.00, '2 caixas a 582,50');
    assertClose(e.cuProd(p, 'frasco', 3), 436.89, '3 frascos a 145,63');
  });

  it('valorEstProd usa caixas x custoCaixa (o dinheiro gasto, nao o frasco)', () => {
    const e = escopo();
    assertClose(e.valorEstProd(F.produtoTG()), 4660.00, '8 x 582,50');
    assertClose(e.valorEstProd(F.produtoTG({ frascos: 2 })), 4660.00 + 291.26, 'mais 2 frascos');
    assertClose(e.valorEstProd(F.produtoTGZerado()), 0, 'zerado');
  });

  it('estStatus classifica pelo numero de caixas equivalentes', () => {
    const e = escopo();
    assertEqual(e.estStatus(F.produtoTG({ caixas: 8 })).label, 'Bom', '8 caixas');
    assertEqual(e.estStatus(F.produtoTG({ caixas: 4 })).label, 'Baixo', 'no minimo');
    assertEqual(e.estStatus(F.produtoTG({ caixas: 2 })).label, 'Crítico', 'no critico');
    assertEqual(e.estStatus(F.produtoTG({ caixas: 0 })).label, 'Sem estoque', 'zerado');
  });

  it('tipoLabel e prodNome dao o nome que o usuario le', () => {
    const e = escopo();
    assertEqual(e.tipoLabel('caixa'), 'Caixa', 'caixa');
    assertEqual(e.tipoLabel('frasco'), 'Frasco', 'frasco');
    assertEqual(e.prodNome('TG'), 'TG', 'produto que existe');
    assertEqual(e.prodNome('NAO_EXISTE'), 'NAO_EXISTE', 'produto sumido cai no proprio id');
  });

  it('slugify transforma o nome digitado em id de produto', () => {
    const e = escopo();
    assertEqual(e.slugify('Reta Verde'), 'RETA_VERDE', 'espaco vira underline');
    assertEqual(e.slugify('Ação 2!'), 'ACAO_2', 'tira acento e pontuacao');
    assertEqual(e.slugify('   '), 'PROD', 'vazio tem fallback');
  });

  it('cfgNum e cfgTxt caem no padrao quando a config esta vazia', () => {
    const e = escopo();
    assertEqual(e.cfgNum('lead_time', 7), 7, 'valor do fixture');
    assertEqual(e.cfgNum('nao_existe', 42), 42, 'chave inexistente');
    assertEqual(e.cfgTxt('nao_existe', 'x'), 'x', 'texto inexistente');
    assertEqual(e.leadTime(), 7, 'leadTime');
    assertEqual(e.coberturaAlvo(), 45, 'coberturaAlvo');
    assertEqual(e.janelaMedia(), 30, 'janelaMedia');
  });

  it('statusValidade classifica pelo prazo e ignora lote sem validade', () => {
    const e = escopo();
    assertNull(e.statusValidade(''), 'sem validade nao inventa alerta');
    assertEqual(e.statusValidade(e.addDias(e.today(), 10)).n, 'crit', 'vence em 10 dias');
    assertEqual(e.diasAte(e.today()), 0, 'hoje = 0 dias');
    assertEqual(e.diasAte(e.addDias(e.today(), 5)), 5, 'daqui 5 dias');
  });
});

// =============================================================================
// numBR é quem lê valor da venda, desconto, saída, custo de compra e preço. Em 17/09/2026
// (auditoria de encerramento) "1.250" virava R$ 1,25: ponto com grupos de 3 dígitos é
// milhar no jeito brasileiro de escrever.
describe('numBR() — dinheiro digitado do jeito brasileiro', () => {
  const casos = [
    ['1.250', 1250], ['1.165', 1165], ['1.000.000', 1000000], ['R$ 1.250,00', 1250],
    ['1.234,56', 1234.56], ['51.069,49', 51069.49], ['150,00', 150], ['582,50', 582.5],
    ['0,99', 0.99], ['12.50', 12.5], ['1.5', 1.5], ['470.5', 470.5], ['300', 300], ['', 0], ['abc', 0],
  ];
  it('ponto com grupos de 3 dígitos é milhar; vírgula ou ponto com 1–2 dígitos é centavo', () => {
    casos.forEach(([txt, esperado]) => assertClose(escopo().numBR(txt), esperado, JSON.stringify(txt)));
  });
  it('o campo de saída lê "1.250" como mil duzentos e cinquenta', () => {
    const e = escopo();
    h.preencher({ fVal: '1.250' });
    assertClose(e.valNum('fVal'), 1250, 'valNum');
  });
});
