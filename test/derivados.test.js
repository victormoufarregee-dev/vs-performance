'use strict';
/* =============================================================================
 * derivados.test.js — dinheiro que o app NÃO decide mais, e número que ele
 * se recusa a adivinhar.
 * =============================================================================
 *
 * Três mudanças do hardening pós-baseline 2 têm de continuar valendo:
 *
 *   1) numBR virou gramática explícita e RECUSA entrada ambígua. Antes,
 *      "1,000" virava 1000, "0,001" virava 1, "1,234,567" virava 1.234 e
 *      "1e3" virava 13 — tudo em silêncio, e tudo dinheiro.
 *   2) a quitação de fiado deixou de ser PATCH direto em `vendas` com
 *      lucro_liq e margem calculados aqui: virou vsp_quitar_fiado, com op_id.
 *   3) excluir cliente era um DELETE que a RLS engolia (0 linhas, HTTP 204) e
 *      o app anunciava "removido"; virou inativação (PATCH ativo=false).
 *
 * O que NÃO se prova aqui: nenhuma conta do banco. O sbRpc está espionado.
 * A aritmética da 011 é provada em SQL, no banco real, em transação revertida
 * (test/sql/derivados.test.sql).
 * ========================================================================== */

const H = require('./harness.js');
const F = require('./fixtures.js');

let h0;
function escopo() {
  if (!h0) { h0 = H.carregar(); h0.carregarDB(F.dbMinimo()); }
  return h0.escopo;
}
function novo(db) {
  const h = H.carregar();
  h.logarComo('Victor');
  if (db) h.carregarDB(db);
  return h;
}

// =============================================================================
describe('numBRx() — a gramática do dinheiro digitado', () => {

  it('lê o que é inequívoco, em pt-BR e no estilo dos EUA', () => {
    const e = escopo();
    const bons = [
      ['1.250', 1250], ['1.000.000', 1000000], ['1.250,50', 1250.5], ['1250,50', 1250.5],
      ['1250', 1250], ['12.50', 12.5], ['1,5', 1.5], ['0,99', 0.99], ['R$ 1.250,00', 1250],
      ['12.345.678,90', 12345678.9], ['12,345,678.90', 12345678.9], ['-1.000', -1000],
      ['-50,5', -50.5], [',5', 0.5], ['5,', 5], ['', 0], ['  1.000  ', 1000],
    ];
    bons.forEach(([txt, esperado]) => {
      const r = e.numBRx(txt);
      assertEqual(r.ok, true, JSON.stringify(txt) + ' devia ser aceito (' + r.motivo + ')');
      assertClose(r.v, esperado, JSON.stringify(txt));
    });
  });

  it('RECUSA em vez de adivinhar — os quatro casos que davam número errado em silêncio', () => {
    const e = escopo();
    // vírgula com 3 dígitos: mil? ou 1 com três casas? Não dá para saber.
    assertEqual(e.numBRx('1,000').ok, false, '"1,000" era 1000');
    assertEqual(e.numBRx('0,001').ok, false, '"0,001" era 1 — erro de 1000x');
    // vírgula repetida sem ponto: parseFloat parava no primeiro separador
    assertEqual(e.numBRx('1,234,567').ok, false, '"1,234,567" era 1.234');
    // o filtro antigo apagava o "e" e sobrava "13"
    assertEqual(e.numBRx('1e3').ok, false, '"1e3" era 13');
  });

  it('RECUSA milhar quebrado, sinal solto e lixo', () => {
    const e = escopo();
    ['1.2.3', '10.5.3', '1.0000', '--5', '5-', ',', '.', '-', 'abc', '1,00,00'].forEach((txt) => {
      assertEqual(e.numBRx(txt).ok, false, JSON.stringify(txt) + ' devia ser recusado');
    });
  });

  it('toda recusa vem com motivo em português, e numBR continua devolvendo 0', () => {
    const e = escopo();
    const r = e.numBRx('1,000');
    assertTrue(typeof r.motivo === 'string' && r.motivo.length > 3, 'recusa sem motivo');
    assertEqual(e.numBR('1,000'), 0, 'numBR devolve 0 no lugar de adivinhar');
    assertEqual(e.numBR('1.250'), 1250, 'numBR continua lendo o que e claro');
  });

  it('número já numérico passa direto; Infinity e NaN não', () => {
    const e = escopo();
    assertEqual(e.numBRx(1250.5).v, 1250.5, 'number');
    assertEqual(e.numBRx(Infinity).ok, false, 'Infinity');
    assertEqual(e.numBRx(NaN).ok, false, 'NaN');
  });

  it('conferirNums aponta o campo pelo nome que o usuário vê', () => {
    const h = novo(F.dbMinimo());
    h.preencher({ vValOrig: '1,000', vDesc: '0' });
    const msg = h.escopo.conferirNums([['vValOrig', 'preço unitário'], ['vDesc', 'desconto']]);
    assertTrue(/preço unitário/.test(msg), 'a mensagem tem de citar o campo: ' + msg);
    h.preencher({ vValOrig: '1.000' });
    assertEqual(h.escopo.conferirNums([['vValOrig', 'preço unitário']]), '', 'valor claro nao reclama');
  });
});

// =============================================================================
describe('Venda — campo de dinheiro ambíguo não vira zero calado', () => {

  it('preço ambíguo barra a venda antes de qualquer chamada ao banco', async () => {
    const h = novo(F.dbComEstoque ? F.dbComEstoque() : F.dbMinimo());
    const rpc = h.espiarRpc({ repetida: false, venda: {}, produto: {} });
    h.rede.proibir();
    h.preencher({
      vProd: 'TG', vTipo: 'caixa', vQtd: '1', vValOrig: '1,000', vDesc: '0',
      vData: '2026-09-17', vPgto: 'pix', vTaxa: '0', vTaxaQuem: 'nos', vCliSel: '1',
    });
    await h.escopo.regVenda();
    assertEqual(rpc.length, 0, 'nao pode ter chamado o banco');
    assertTrue(h.ui.toasts().some((t) => /Não entendi o preço unitário/.test(t)),
      'toast devia explicar o campo: ' + JSON.stringify(h.ui.toasts()));
  });
});

// =============================================================================
describe('Quitação de fiado — quem calcula é o banco', () => {

  it('chama vsp_quitar_fiado com id, forma de pagamento e op_id, e não faz PATCH em vendas', async () => {
    const h = novo(F.dbMinimo());
    const venda = {
      id: 7001, prod: 'TG', tipo: 'caixa', qtd: 1, val_orig: 900, desconto: 0, val_final: 900,
      bruto: 900, custo: 582.5, taxa: 0, taxa_val: 0, taxa_quem: 'nos', liq: 900,
      lucro_liq: 0, margem: 0, cliente: 'Fulano', wpp: '', cli_id: null, data: '2026-09-01',
      obs: '', pgto: 'fiado', parcelas: null, quitado: false, cancelada: false,
    };
    h.escopo.DB.vendas.push(h.escopo.mapVenda(venda));
    const quitada = Object.assign({}, venda, {
      quitado: true, pgto_quitado: 'pix', lucro_liq: 317.5, margem: 35.2778,
      quitado_em: '17/09/2026 15:00:00',
    });
    const rpc = h.espiarRpc({ repetida: false, venda: quitada });
    h.rede.proibir();
    h.preencher({ qVendaId: '7001', qPgto: 'pix' });
    await h.escopo.confirmarQuitar();

    assertEqual(rpc.length, 1, 'uma chamada');
    assertEqual(rpc[0].fn, 'vsp_quitar_fiado', 'a funcao certa');
    assertEqual(rpc[0].params.p_id, 7001, 'id da venda');
    assertEqual(rpc[0].params.p_pgto, 'pix', 'forma de pagamento');
    assertTrue(String(rpc[0].params.p_op_id || '').trim().length > 0, 'op_id nao pode ser vazio');
    assertEqual(h.rede.por('PATCH', '/vendas').length, 0, 'nada de PATCH direto em vendas');

    const v = h.escopo.DB.vendas.find((x) => x.id === 7001);
    assertEqual(v.quitado, true, 'adota o estado do banco');
    assertClose(v.lucroLiq, 317.5, 'lucro veio do banco, nao daqui');
  });

  it('erro do banco não marca a venda como quitada na tela', async () => {
    const h = novo(F.dbMinimo());
    h.escopo.DB.vendas.push(h.escopo.mapVenda({
      id: 7002, prod: 'TG', tipo: 'caixa', qtd: 1, bruto: 900, custo: 582.5, liq: 900,
      cliente: 'Beltrano', data: '2026-09-01', pgto: 'fiado', quitado: false, cancelada: false,
    }));
    h.espiarRpc(() => { throw new Error('nao autorizado'); });
    h.rede.proibir();
    h.preencher({ qVendaId: '7002', qPgto: 'pix' });
    await h.escopo.confirmarQuitar();
    const v = h.escopo.DB.vendas.find((x) => x.id === 7002);
    assertEqual(v.quitado, false, 'a tela nao pode mentir que quitou');
    assertTrue(h.ui.toasts().some((t) => /Não consegui quitar/.test(t)), 'tem de avisar');
  });
});

// =============================================================================
describe('Cliente — inativação em vez de DELETE que a RLS engole', () => {

  it('inativar faz PATCH ativo=false e nunca DELETE', async () => {
    const h = novo(F.dbMinimo());
    h.escopo.DB.clientes.push({ id: 5001, nome: 'Cliente Teste', tel: '35999990000', obs: '', ativo: true });
    h.rede.fake();
    h.ui.respostaConfirm = true;
    await h.escopo.delCli(5001);
    assertEqual(h.rede.por('DELETE', '/clientes').length, 0, 'DELETE em clientes nunca funcionou: nao pode ser chamado');
    const patches = h.rede.por('PATCH', '/clientes');
    assertEqual(patches.length, 1, 'um PATCH');
    assertTrue(/"ativo":false/.test(patches[0].corpo), 'o PATCH tem de inativar: ' + patches[0].corpo);
    const c = h.escopo.DB.clientes.find((x) => x.id === 5001);
    assertEqual(c.ativo, false, 'o cadastro continua, inativo');
  });

  it('cliente inativo sai do seletor de venda mas fica na lista', async () => {
    const h = novo(F.dbMinimo());
    h.escopo.DB.clientes.push({ id: 5002, nome: 'Ativo', tel: '35911111111', obs: '', ativo: true });
    h.escopo.DB.clientes.push({ id: 5003, nome: 'Inativo', tel: '35922222222', obs: '', ativo: false });
    h.escopo.populateCliSelect();
    const opcoes = h.ui.html('vCliSel');
    assertTrue(/Ativo/.test(opcoes), 'ativo tem de aparecer no seletor');
    assertTrue(!/Inativo/.test(opcoes), 'inativo nao pode aparecer no seletor');
    h.preencher({ fCli: '' });
    h.escopo.renderCli();
    const lista = h.ui.html('cliList');
    assertTrue(/Inativo/.test(lista), 'inativo continua na lista de clientes');
    assertTrue(/reativarCli\(5003\)/.test(lista), 'tem de dar para reativar');
  });

  it('reativar volta ativo=true', async () => {
    const h = novo(F.dbMinimo());
    h.escopo.DB.clientes.push({ id: 5004, nome: 'Volta', tel: '35933333333', obs: '', ativo: false });
    h.rede.fake();
    await h.escopo.reativarCli(5004);
    const patches = h.rede.por('PATCH', '/clientes');
    assertEqual(patches.length, 1, 'um PATCH');
    assertTrue(/"ativo":true/.test(patches[0].corpo), 'o PATCH tem de reativar: ' + patches[0].corpo);
    assertEqual(h.escopo.DB.clientes.find((x) => x.id === 5004).ativo, true, 'ativo de novo');
  });
});

// =============================================================================
describe('Exportação operacional — o arquivo diz o que é e o que não é', () => {

  it('as duas cópias (nuvem e download) têm o mesmo conteúdo', () => {
    const h = novo(F.dbMinimo());
    const dump = h.escopo.montarDump();
    ['produtos', 'vendas', 'clientes', 'saidas', 'reposicoes', 'ledger', 'conferencias', 'config']
      .forEach((k) => assertTrue(k in dump, 'falta ' + k + ' na exportacao'));
    // baixarBackup() passou a montar o arquivo pela mesma funcao: sem isso o download
    // saia sem a Conta do Victor, e a nuvem saia com ela.
    const fonte = require('fs').readFileSync(
      process.env.VSP_INDEX || require('path').join(__dirname, '..', 'index.html'), 'utf8');
    assertTrue(/async function baixarBackup\(\)\{const dump=montarDump\(\);/.test(fonte),
      'o download tem de reusar montarDump()');
  });

  it('declara o escopo dentro do próprio arquivo e não leva segredo nenhum', () => {
    const h = novo(F.dbMinimo());
    const dump = h.escopo.montarDump();
    assertTrue(!!dump.escopo && Array.isArray(dump.escopo.inclui) && Array.isArray(dump.escopo.fora),
      'o arquivo tem de declarar o escopo');
    assertMatch(String(dump.escopo.restauracao), /nao ha/, 'tem de dizer que nao restaura');
    // o `escopo` fala DE segredo ("senha/token (o app nao tem)"), entao sai da varredura:
    // o que se procura e segredo nos DADOS.
    const semEscopo = Object.assign({}, dump); delete semEscopo.escopo;
    const texto = JSON.stringify(semEscopo).toLowerCase();
    ['senha', 'password', 'token', 'service_role', 'apikey', 'secret', 'usuarios_autorizados']
      .forEach((p) => assertTrue(!texto.includes(p), 'a exportacao nao pode conter "' + p + '"'));
  });
});
