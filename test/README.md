# Suíte de testes do VS Performance

Node puro, zero dependência, nada de `npm install`. O app continua sendo um único
`index.html` com o JavaScript inline — o teste não o reescreve nem o copia: ele
**extrai e executa o script real** dentro de um `vm` do Node, com um navegador
falso em volta.

```bash
node test/run.js                  # roda tudo
node test/run.js financeiro       # só as suítes cujo arquivo casa com o filtro
node test/run.js util estatico    # vários filtros
node test/run.js --sem-cor        # sem ANSI (log, CI, redirecionamento)
node test/run.js --cor            # força cor mesmo sem TTY

node test/estatico.js             # as travas de texto, fora do runner (9 checagens)
node test/mutantes.js             # provas de mutante: estraga o código e exige falha
node test/mutantes.js M3 M5       # só esses mutantes
```

São **186 casos** hoje: 33 no financeiro, **56 no razão da Conta do Victor**, 36 nas
operações, 34 nos utilitários e 26 estáticos. Sai com código **1** se algum caso falhar
(ou se um arquivo de teste não carregar), e **0** quando está tudo verde. Hoje não há
nenhum pendente: as duas divergências abertas em 16/09 foram corrigidas no mesmo
dia. Testado no Windows 11 com Git Bash e Node 24.

Três comandos, três perguntas diferentes:

| comando | o que responde |
|---|---|
| `node test/run.js` | o código real do `index.html` produz os números certos? |
| `node test/estatico.js` | o **texto** do arquivo (e das migrations) ainda respeita as travas? |
| `node test/mutantes.js` | a suíte **pega** o erro que ela diz pegar, ou está verde olhando para o lado? |

## Leia isto antes de confiar no verde: metade do sistema não está em JavaScript

Venda, compra, cancelamento e estorno **não gravam mais tabela por tabela pelo
frontend**. Cada uma é **uma** chamada a uma função transacional no PostgreSQL:

| operação | função no banco |
|---|---|
| venda | `vsp_registrar_venda(p_venda jsonb, p_op_id text)` |
| compra | `vsp_registrar_compra(p_rep jsonb, p_op_id text)` |
| cancelamento | `vsp_cancelar_venda(p_id bigint, p_motivo text, p_usuario text, p_op_id text)` |
| estorno | `vsp_estornar_compra(p_id bigint, p_usuario text, p_op_id text)` |

O **custo médio ponderado**, a **baixa de estoque com trava de linha**, a **auditoria** e
a **idempotência pelo `op_id`** saíram do JavaScript e vivem dentro dessas funções
(`migrations/004_rpc_operacoes.sql`). Consequência direta para esta suíte:

* **o harness cobre a camada de chamada.** Qual função o app chama, com que payload, com
  que `op_id`, se o `op_id` é reusado no retry, o que ele faz com a resposta e o que ele
  **deixa de fazer** sozinho (não decrementa estoque, não recalcula custo, não duplica
  linha). Isso é o `operacoes.test.js`, e essas perguntas se respondem sem banco.
* **a aritmética, a atomicidade e a concorrência são testadas em SQL**, contra o banco
  real, em **transação revertida**, e o resultado está registrado em
  `migrations/APLICADO.md`: custo médio, retry com o mesmo `op_id`, venda maior que o
  estoque, chamada de usuário fora da allowlist, auditoria gravada dentro da transação, e
  duas conexões simultâneas disputando a última caixa. **Nada disso roda no
  `node test/run.js`.**

Nos testes de operação o `sbRpc` fica **espionado** (`h.espiarRpc`): ele devolve o que o
teste mandar. Um caso aqui que afirmasse "8 caixas a 582,50 dão custo 582,50" estaria
conferindo o próprio fixture, não o banco — por isso os 11 casos que faziam isso foram
**reescritos ou removidos** em 15/09, e não devem voltar. Do lado JavaScript sobraram, e
continuam testados de verdade: as validações locais (que barram **antes** de sair do app),
o texto do aviso de estorno e o mapeamento da resposta
(`mapProd`/`mapVenda`/`mapRep`).

## Qual `index.html` está sendo testado

Existem **duas cópias do app no disco**, e nada garante que estejam iguais:

| cópia | papel |
|---|---|
| `<repo>\index.html` (ao lado de `test/`) | cópia publicável, onde as correções C* entram — é o **alvo padrão** da suíte |
| `C:\Users\victo\OneDrive\VS Performance - 25 - JULHO - 2026\index.html` | pasta de trabalho do OneDrive, para onde a versão publicável é copiada |

O runner **imprime no cabeçalho** qual arquivo abriu, com tamanho, número de linhas
e data de alteração, e avisa em amarelo quando a outra cópia difere. Nunca leia o
resumo sem olhar essa linha.

Para apontar para outro arquivo:

```bash
VSP_INDEX="C:\caminho\para\index.html" node test/run.js
```

A ordem de resolução é: `VSP_INDEX` → `../index.html` (o do repositório) → cópia do
OneDrive. O repositório vem primeiro de propósito: ele é o que está sendo corrigido, e
rodar contra a cópia velha do OneDrive dá **verde falso** nas correções.

Em 16/09/2026 as duas cópias voltaram a ser **idênticas** (mesmo tamanho, mesmo
conteúdo) e a suíte passa nas duas. O aviso amarelo continua valendo para o dia em que
divergirem de novo — e o `h.espiarRpc` continua sabendo reconhecer uma cópia anterior à
migração das quatro operações: ele falha com
`este index.html nao tem sbRpc() — ele e ANTERIOR a migracao`, em vez de um erro obscuro.
Isso é a suíte funcionando: ela sabe dizer qual cópia está velha.

## O que cada suíte cobre

### `financeiro.test.js` — o dinheiro que ainda é calculado em JavaScript (33 casos)

* **Regressão da baseline de 15/09/2026.** Com o fixture de produção, o código real
  tem de devolver: `valorEstTotal()` = **4.660,00**, custo já vendido = **23.539,30**,
  você financiou = **28.199,30**, já recebeu de volta = **22.441,00**,
  dívida com Victor = **5.758,30**, recebido = **51.066,00**, saídas = **51.069,49**,
  resultado de caixa = **−3,49**, total comprado = **19.065,00** e a diferença
  explicada de **9.134,30**. Estes números não podem mudar sem uma decisão
  consciente — se mudarem, a suíte cai.
* **Sete casos foram reescritos em 16/09/2026.** Eles raspavam os rótulos da fórmula
  antiga no card do Financeiro — "Custo já vendido", "Mercadoria fornecida", "Já pago
  aos fornecedores", "Falta pagar", "Custo do estoque atual". Esses rótulos não existem
  mais: a dívida com o Victor **saiu do estoque** e virou razão. O card mostra hoje
  "Você financiou", "Já recebeu de volta" e "A empresa deve a você", todos lidos de
  `saldoVictor()`. Os números canônicos continuam os mesmos; a **fonte** mudou. Um dos
  casos novos existe só para isso: exige que **nenhum** dos cinco rótulos antigos volte
  ao card, e prova que a fórmula velha não é mais a fonte mexendo no estoque e
  verificando que o saldo não se move. A diferença de **9.134,30**, que era uma
  subtração inferida (mercadoria − comprado), agora é um **movimento explícito** do
  razão: o saldo inicial, datado no dia anterior à 1ª venda.
  Como parte desses valores só existe dentro de `renderFin()`, o teste **lê o número
  do HTML que o próprio app escreveu** (o `R()` formata sempre `R$ 1234.50`, então a
  raspagem é estável). É o app calculando, não o teste.
* **Fechamento × DRE do mesmo mês** e **retirada "Ambos"** — ver "Divergências
  documentadas" abaixo.
* **Fechamento por sócio**: venda sem vendedor entra no lucro total e em ninguém;
  fiado em aberto nasce com lucro 0 e não conta como recebido; direito = resultado ×
  porcentagem; mês vazio não inventa número.
* **DRE**: taxa de maquininha paga por nós sai do líquido e aparece como taxa; taxa
  repassada ao cliente não; virada de ano no `mesAnterior`.

Custo médio ponderado e estorno **não estão mais neste arquivo**. Eram 11 casos que
afirmavam efeitos locais (`p.custoCaixa`, `DB.reposicoes`) que o JavaScript deixou de
produzir. Há uma nota no meio do `financeiro.test.js`, onde eles ficavam, explicando por
que não devem voltar. Caso a caso, isto foi o destino de cada um:

| caso antigo | destino |
|---|---|
| `8 caixas a 582,50 -> custoCaixa 582,50 EXATO` | **removido.** É aritmética da `vsp_registrar_compra`; com o `sbRpc` espionado, o número viria do próprio teste. Testado em SQL. |
| `o valor em estoque bate com o dinheiro gasto: 4.660,00` | **removido.** Idem — o que sobrou no lado do app é o `cust_total` do payload, que é testado. |
| `a segunda compra pondera com o estoque que ja existia` | **removido.** É a média ponderada, 100% SQL. |
| `o custo da caixa NAO e 582,52` | **migrou para `estatico.test.js`** como checagem do texto do `migrations/004_rpc_operacoes.sql`: a regra do arredondamento tem de continuar escrita lá. |
| `o frete entra no custo da mercadoria` | **reescrito**: o frete tem de aparecer no payload e `cust_total = qtd × cust_unit + frete`. |
| `custo digitado com virgula ("582,50")` | **reescrito**: os 582,50 têm de chegar ao `cust_unit`. |
| `a compra NAO lanca saida no Financeiro` | **preservado** (é estado local). |
| `sem quantidade, custo ou data a compra e bloqueada` | **preservado**, mais forte: agora também exige que a RPC **não** seja chamada. |
| estorno — `caso limpo`, `REGRESSAO com venda depois`, `venda ANTERIOR`, `saida automatica legada` | **reescritos** em torno da resposta do banco e do aviso local; as decisões de custo e a exclusão da saída são da transação. |
| estorno — bloqueios (`estoque insuficiente`, `confirm` recusado, `compra inexistente`, `produto apagado`) e os dois casos do texto do aviso | **preservados** (é tudo JavaScript que ficou). |

Nenhum desses casos foi transformado em "verde por construção": o que não podia ser
provado sem banco foi **apagado do harness**, não afrouxado.

### `ledger.test.js` — a Conta do Victor, lida do razão (56 casos)

Até 15/09/2026 a dívida da empresa com o Victor era **derivada do estoque**:

```
dívida = CMV + valor do estoque − pago a fornecedores
```

Isso misturava dois conceitos que não têm relação. Quebrar um frasco, achar caixa
sobrando no inventário ou corrigir um custo médio mexia numa dívida entre duas pessoas
**sem que um centavo trocasse de mão**. Desde 16/09/2026 a dívida vem de um razão — a
tabela `ledger_victor` — onde cada linha é um fato financeiro: compra que o Victor
bancou (débito) ou reembolso que ele recebeu (crédito). O app carrega a view
`v_ledger_victor` em `DB.ledger` e lê por `ledgerMovs()` / `saldoVictor()`.

**Convenção única, válida em todo o sistema:** saldo **positivo** = a empresa **deve**
ao Victor; débito aumenta a dívida, crédito reduz.

* **O razão de produção, 21 movimentos.** 1 saldo inicial de **9.134,30** + 5 compras
  somando **19.065,00** + 15 reembolsos somando **22.441,00** = saldo **5.758,30**. Os
  casos conferem cada bloco, o `saldoVictor()`, o **saldo corrido linha a linha** (a soma
  com sinal até cada movimento, na ordem `(data, id)` da view) e que os cinco débitos de
  compra são, ao centavo, o `custTotal` da reposição de origem. A ordem dos ids do
  backfill **não** é cronológica (id 1 = saldo inicial, 2..6 = compras, 7..21 =
  reembolsos) e há um caso que exige que continue assim: se alguém trocar a ordenação
  para id, o saldo corrido muda e a suíte grita.
* **Compra.** Um movimento de compra sobe o saldo pelo valor exato; uma compra gera
  **um** movimento, nunca dois (um caso conta os movimentos por origem); `confReposicao`
  chama `vsp_registrar_compra` com `op_id` e **adota o movimento devolvido** pela mesma
  transação, em vez de inventar o débito por conta própria.
* **Reembolso.** Reduz o saldo pelo valor exato; reembolsar o saldo inteiro zera a conta
  ao centavo; dois créditos seguidos não arredondam no meio.
* **Estoque NÃO altera o razão — o bloco mais importante do arquivo.** Nove casos mexem
  no estoque de todas as maneiras que a vida mexe (caixa a mais, quebra, estoque zerado,
  custo médio alterado, uma venda com baixa de estoque e CMV, o cancelamento dessa
  venda) e exigem que `saldoVictor()` **não mude um centavo**. Cada um desses casos
  também prova que o cenário realmente mexeu no estoque — senão o teste estaria vazio.
  Os dois cards e o extrato entram no mesmo bloco: nenhum deles pode reagir a estoque.
* **Estorno.** Correção de razão financeiro é por **compensação**, nunca por `DELETE`: o
  movimento original fica com `estornadoEm` preenchido e continua visível no extrato, e
  um movimento de sinal oposto aparece apontando para ele (`estornaId`). O saldo depois
  do estorno é o de antes de o movimento estornado existir. Apagar a compra do histórico
  de estoque **não** apaga o razão: a coluna Origem passa a dizer "Compra #2005 (já
  estornada)" em vez de quebrar.
* **Extrato e filtros (`renderVictor`).** O topo mostra o saldo, o financiado, o recebido
  e o saldo inicial; a tabela lista os 21 movimentos do mais recente para o mais antigo;
  os filtros de período, tipo e origem funcionam e **se acumulam** (E, não OU). O caso
  que mais importa: **o saldo do topo é o da conta inteira e nenhum filtro o muda** —
  filtro é recorte de extrato, não de dívida, e cinco combinações são testadas uma a uma.
  Há dois estados vazios **diferentes**: sem movimento nenhum ("toque em sincronizar") e
  com filtro que não casa ("ajuste o período ou toque em Limpar"); no segundo o topo
  continua mostrando o saldo, para não dar a impressão de que a conta zerou.
* **`ledgerRotulo` traduz o enum.** Nenhum valor de máquina (`compra_financiada`,
  `saldo_inicial`, `ajuste_financeiro`) pode chegar à tela, em nenhum dos quatro lugares
  que renderizam o razão, nem ao CSV do `exportVictor` — e um tipo desconhecido cai no
  próprio valor em vez de virar tela em branco.
* **Cards do Financeiro e do Dashboard.** Os três lugares mostram o **mesmo** número; os
  dois cards seguem qualquer razão (um razão de duas linhas inventadas tem de aparecer na
  tela), o que é a prova de que não há número decorado; e com o razão vazio eles dizem
  que não sabem, em vez de cair na fórmula antiga — que, com o fixture de produção, daria
  **exatamente** os mesmos 5.758,30 e passaria batido.
* **Defensivo.** `DB.ledger` indefinido, nulo, número, string ou objeto: `ledgerMovs()`
  devolve `[]`, `saldoVictor()` devolve `0` (nunca `NaN`) e as três telas, o export e o
  filtro rodam sem quebrar. É o caso de quem abre o app com um cache salvo antes desta
  versão.

### `operacoes.test.js` — as quatro operações transacionais (36 casos)

Testa a **conversa com o banco**, nunca a conta que o banco faz. Cada caso instala
`h.espiarRpc(resposta)`, que troca o `sbRpc` real por um gravador e responde o que o
teste mandar. Fica provado:

* **payload e destino.** `confReposicao()` chama `vsp_registrar_compra` com `prod`,
  `tipo`, `qtd`, `cust_unit`, `frete`, `cust_total`, `data`, `forn`, `lote`, `validade`
  e `usuario`, mais um `p_op_id` **não vazio** — e `cust_total` é sempre
  `qtd × cust_unit + frete` (4.660,00 sem frete; 4.760,00 com 100,00 de frete; e
  `582,50` digitado com vírgula chega como 582,50, não 582,00). `regVenda()` chama
  `vsp_registrar_venda` com a venda inteira, incluindo o **custo histórico gravado na
  própria venda**. `confirmarCancelamento()` chama `vsp_cancelar_venda` com id, motivo
  (`motivo — observação`) e usuário. `estornarCompra()` chama `vsp_estornar_compra` com
  o id da compra e um `op_id`.
* **idempotência do lado do cliente.** A primeira tentativa falha e o usuário repete: a
  segunda chamada sai com o **mesmo `op_id`** — é isso que permite ao banco devolver o
  que já existe em vez de gravar outra vez. Uma compra nova ganha `op_id` novo, e dois
  estornos seguidos usam `op_id`s diferentes. **Duplo clique** dispara **uma** RPC só,
  com aviso no segundo.
* **o app não decide mais nada sozinho.** Com o espião devolvendo um envelope vazio,
  `p.caixas`, `p.custoCaixa`, `p.custoFrasco`, `DB.vendas`, `DB.reposicoes` e o
  `cancelada` da venda ficam **exatamente como estavam**. Cada registro do espião guarda
  a foto do estoque no **instante** da chamada, e é ela que prova que a venda não
  decrementou o estoque local antes de o banco responder.
* **estado canônico.** Quando a resposta traz `produto` (ou `venda`/`compra`), o app
  adota. Os fixtures usam de propósito números que o JavaScript **não** calcularia
  (41 caixas, custo 777,77): se o app estivesse recalculando, o caso cairia.
* **`repetida:true` não duplica.** Nem em `DB.vendas`, nem em `DB.reposicoes`, nem
  transformando um cancelamento em duas linhas — e o usuário lê "já estava lançada" /
  "já estava salva" / "já estava cancelada".
* **validação local continua local.** Falta quantidade/custo/data, estoque insuficiente,
  compra inexistente, produto apagado, motivo de cancelamento em branco, `confirm()`
  recusado: nada disso chega a chamar o banco.
* **o aviso do estorno**, que ainda é montado em JavaScript com a guarda
  `podeRecalcular`, continua dizendo ao usuário o que vai acontecer, inclusive a
  contagem de vendas posteriores — e uma venda **anterior** à compra não entra nela. O
  aviso é uma **previsão local**; o número que vale é o que o banco devolve depois.
* **falha da RPC.** O app avisa ("nada foi gravado pela metade") e **não** altera o
  estado local.

O que este arquivo **não** prova: que o custo médio resultante está certo, que a
transação é atômica, que a trava de linha funciona, que o `op_id` é de fato único no
banco, que a auditoria foi gravada. Isso é SQL — `migrations/APLICADO.md`.

### `util.test.js` — as funções pequenas (34 casos)

`R()` (incluindo os casos feios: `null`, `NaN`, texto → `R$ NaN`, e a ausência de
separador de milhar / vírgula decimal), `margemPct` × `calcMarg` (margem sobre a
venda × markup sobre o custo — são coisas diferentes e o teste deixa isso escrito),
`mPill`, `fmtD`, `today`/`ymd`/`addDias` (inclusive a prova de que `today()` usa a
data **local** e não UTC, que era o bug das 21h virando o dia), `brDateTimeToDate`,
os helpers de produto (`fpcOf`, `totFP`, `cuProd`, `valorEstProd`, `estStatus`,
`slugify`, `cfgNum`/`cfgTxt`, `statusValidade`) e a **leitura de número**:

```js
parseFloat('150,00')   === 150      // trunca na vírgula, sem avisar
parseFloat('1.234,56') === 1.234    // no formato brasileiro cheio fica grotesco
Number('150,00')       // NaN — comportamento diferente do parseFloat
```

O caso ponta-a-ponta (digitar `582,50` no campo de custo e o valor sair **inteiro no
payload** da `vsp_registrar_compra`) está em `operacoes.test.js`. A prova acima é de
linguagem e vale para sempre; a do app depende de o `numBR()` continuar no lugar.

### `fila.test.js` — a fila offline persistente (42 casos)

Roda o JavaScript real do `index.html` sobre um **IndexedDB em memória**
(`H.criarIndexedDB()`), que garante o que o navegador garante e a fila depende: transação
atômica (trabalha numa cópia e publica no fim), serializada (uma por vez — é o que torna a
troca de status atômica) e assíncrona (`setImmediate` real). O **mesmo** objeto passado a
duas cargas do harness (`H.carregar({ indexedDB, guardaLS })`) é uma segunda aba ou um
reload na mesma origem. `falharProximaEscrita()` simula armazenamento cheio; `lsQuebrado`
faz o `localStorage` lançar.

O servidor é um `fetch` falso por caso (`servidor(h, fn)`), que responde `{status, corpo}`,
`'rede'` (lança como sem internet) ou `'pendurar'` (só termina quando o `AbortController`
do prazo abortar — o teste dispara o timer de 20 s à mão, porque os timers do harness não
agendam nada).

Prova: gravar e reler **antes** de dizer "Salvo neste aparelho"; nunca "Venda registrada"
nem "sincronizado" antes do 200; sobreviver a reload e a fechar/abrir; op_id idêntico em
todas as tentativas; clique duplo; `repetida:true`; conflito de estoque sem trava de cabeça
e sem retry; 401/403 e payload inválido sem retry; espera entre tentativas; prazo; offline
prolongado; dois trabalhadores; órfão; dependência cliente → venda; intenção de outra
pessoa; migração da `vsp_fila_v1`; limpeza de confirmados; compra offline; o que **não** vai
para a fila. Detalhe e evidência do navegador real em `OFFLINE_FILA.md`.

Não prova: o IndexedDB de cada navegador (Safari/iOS fica para o smoke do Victor,
`SMOKE_OFFLINE.md`) nem a RPC por dentro.

### `conferencia.test.js` — Conferência de Caixa, lado do app (22 casos)

A conta do caixa esperado com um fixture em que **cada fórmula errada provável** (fiado em
aberto, venda cancelada, bruto no lugar do líquido, compra de estoque, dívida do Victor,
estoque, sem reembolso) dá outro número — calculadas de verdade sobre o mesmo DB, não
somando constantes. Centavos inteiros, leitura pt-BR, prévia (inclusive 19,99 e 0,29, que
perdem o centavo em ponto flutuante), parâmetros enviados à RPC, retry, clique duplo, foto
no histórico, não alteração do resto, offline. O lado do banco é SQL real:
`test/sql/conferencia_caixa.test.sql`, montado por `node test/sql/montar.js` (controle e
mutantes SM1..SM7) e rodado no SQL Editor numa transação que termina desfeita. Detalhes em
`CONFERENCIA_CAIXA.md`.

### `contrato.test.js` — o repositório descreve o banco de produção? (7 casos)

Até 17/09/2026 a `004_rpc_operacoes.sql` descrevia RPCs com outra assinatura e seis
auxiliares que nunca existiram; a 007 quase foi aplicada dependendo deles. Agora
`test/sql/contrato.js` extrai das migrations o contrato de cada função (última definição
vence, `drop` respeitado, exemplo comentado ignorado): assinatura, linguagem,
`SECURITY DEFINER`, volatilidade, `search_path` e **md5 do corpo** — e compara com a foto de
produção `test/sql/contrato_producao.json` (tirada no SQL Editor com
`node test/sql/contrato.js --sql`). O `estatico.js` roda essa comparação na checagem
`CONTRATO DO BANCO`, junto com "o app só chama RPC que existe" e "a view do extrato tem
`security_invoker` e nada para anon".

Os casos testam o **verificador**, com migrations inventadas em pasta temporária: migration
posterior substitui, `drop` remove, assinatura trocada sai, cada tipo de divergência é
acusado (corpo, só no arquivo, só em produção, definer, `search_path`, anon), trigger com
EXECUTE de PUBLIC não é exposição, CRLF não muda o md5 — e, com as migrations reais, 0
divergências e nenhuma chamada a `vsp_*` inexistente.

Não prova que a foto é a de hoje: ela só muda quando alguém a atualiza. Para o banco,
`node test/sql/reconstrucao.js` gera o SQL que recria as funções a partir das migrations e
confere md5 e `xmin` dentro do banco, desfazendo tudo (17/17 em 17/09/2026). Detalhe e matriz
de drift: `migrations/APLICADO.md`, seção "Drift 004 × produção".

### `estatico.test.js` — o texto do arquivo (26 casos)

Não executa nada (fora o parse). Pega justamente o que o harness **não** pega:

* sintaxe de **todos** os blocos `<script>` inline, via `new Function` (sem executar);
* chaves balanceadas, nenhum bloco truncado, e o único script externo é o Chart.js
  do cdnjs;
* nenhuma referência órfã a `repPagar`, `toggleRepPgto` ou `lancarFin`;
* **toda** função chamada em `onclick=`/`onchange=`/`oninput=`/... existe de fato como
  `function nome` ou `const/let/var nome` (105 nomes hoje);
* **todo id usado em `getElementById('...')` existe no HTML** (256 ids hoje) e nenhum
  id está duplicado — esta é a checagem que cobre o ponto cego do `document` falso;
* nenhum `console.log` (nem `console.warn/error/...`), nenhum `debugger`, nenhum
  `alert('teste')`;
* as correções de 15/09 continuam no código, **onde elas moram hoje**: `confReposicao`
  **não** escreve mais `p.custoCaixa`/`p.custoFrasco`/`p.caixas` (a conta saiu do
  cliente) e chama `vsp_registrar_compra` com `op_id`; e a regra do arredondamento
  ("cada um arredondado uma vez, os dois a partir do valor não arredondado") é conferida
  no **SQL vigente** (004 + 006, alinhadas ao banco por md5 em 17/09/2026): nos três
  caminhos que recalculam custo (compra, cancelamento, estorno) tem de existir
  `custo_frasco = round(v_raw, 2)` e `custo_caixa = round(v_raw * v_fpc, 2)`, e **não** a
  caixa derivada do frasco já arredondado, que era o bug dos 582,52. Até 17/09 este caso
  lia o **rascunho** da 004 (`v_cf`/`v_cc`), que nunca rodou — ou seja, protegia um texto
  que não era o do banco. Se a regra desaparecer da migration, **nenhum** teste do harness
  veria — o harness não roda SQL;
* a guarda `podeRecalcular` no estorno (que hoje só monta o **aviso** ao usuário: quem
  decide o custo é o banco), o botão de estorno ligado na interface e a compra sem saída
  automática;
* **o razão da Conta do Victor, na `migrations/006_ledger_victor.sql`** (três casos
  novos): a tabela existe, a convenção de sinal está **escrita no arquivo**, o banco não
  aceita `direcao` inventada nem `valor <= 0`, não há policy de `DELETE` (histórico
  financeiro não se apaga), a identidade determinística da origem (`ux_lv_origem`) impede
  a mesma compra de entrar duas vezes, e — o mais importante — **quem escreve no razão é
  a sessão, nunca o payload**: `vsp_ator()` (que resolve o nome por `auth.uid()` na
  allowlist) tem de ser usado nas funções que escrevem, e `p_usuario` / `->>'usuario'`
  não podem reaparecer. Foi exatamente essa a vulnerabilidade corrigida em 15/09/2026,
  quando a Stefany conseguiu assinar uma venda e uma auditoria como "Victor" só mandando
  o nome no payload;
* higiene: doctype, título, charset, `APP_VERSION` declarada uma única vez, e a chave
  do Supabase no arquivo é a **anon** (o teste decodifica o JWT e confere `role`) —
  nunca a `service_role`.

`test/estatico.js` é o mesmo espírito **fora do runner**: 10 checagens que imprimem uma
linha cada e saem com código 1 na primeira reprovação. Duas nasceram com o
razão — a **fórmula legada** (`custoTot+valorEstTotal()`, `mercadoriaFornecida`,
`faltaPagar`, `filter(s=>s.tipo==='fornecedor').reduce`) não pode voltar ao `index.html`,
e a **identidade do razão** não pode voltar ao payload. A última nasceu com a fila offline:
`FILA OFFLINE` reprova se o 200 inventado (`new Response(eco`) ou a fila de array inteiro
(`enfileirar(`, `lsSet(FILA_KEY`) voltarem, ou se `indexedDB.open(`, `p_op_id:item.op_id`,
a troca para `enviando` ou `filaGuardar(` sumirem. Tanto ele quanto o
`estatico.test.js` honram `VSP_INDEX` e `VSP_MIGRATIONS`, que é como o `test/mutantes.js`
roda essas mesmas travas contra uma cópia mutada sem tocar nos arquivos reais.

## Provas de mutante (`node test/mutantes.js`)

Uma suíte verde não prova nada por si só: ela pode estar verde porque **não olha para o
lugar certo**. Teste de mutante inverte o ônus da prova — estraga o código de propósito,
do jeito que um programador distraído estragaria de verdade, e exige que **algum** caso
falhe. Mutante que sobrevive é um buraco na suíte, e o script sai com código 1.

Para cada mutante: cria uma pasta temporária, copia `index.html` e `migrations/` para
dentro dela, aplica a mutação **na cópia**, roda `node test/run.js` e
`node test/estatico.js` com `VSP_INDEX`/`VSP_MIGRATIONS` apontando para lá, lê a saída e
apaga a pasta. **Nenhum arquivo do repositório é alterado** — o `index.html` real é aberto
somente para leitura. Antes de tudo roda um **controle** (cópia sem mutação nenhuma): se o
controle falha, o script para, porque aí um mutante "morto" poderia estar morrendo pelo
motivo errado.

Se o trecho a mutar não casar exatamente o número de vezes esperado, o script **não** diz
"morto": ele diz `NAO APLICADO` e manda reescrever a mutação. Um mutante que nunca chegou
a ser aplicado não prova nada.

Resultado de 17/09/2026 (fechamento do drift) — **28 mutantes, 28 mortos, 0 sobreviventes**
(controle: 257 casos verdes). Os oito primeiros são do razão (16/09), os sete `OF-M*` da fila
offline, os oito `CX-M*` da Conferência de Caixa (lado do app; o lado do banco, `SM1..SM7`,
roda em SQL real — `migrations/APLICADO.md`, seção 007) e os cinco `DR-M*` do drift do banco:

| mutante | arquivo mutado | o que muda | quem matou | resultado |
|---|---|---|---|---|
| **M1** | `index.html` | `confReposicao` para de adotar o movimento que a `vsp_registrar_compra` criou na mesma transação: a compra entra no estoque e o razão não registra o débito | `ledger.test.js` › "a compra traz o movimento do razão e o app adota o saldo novo" | **morto** |
| **M1b** | `index.html` | `ledgerMovs()` filtra fora os movimentos de compra — mesmo efeito visível, atingindo todo mundo que lê o razão | `ledger.test.js` › "o razão tem 21 movimentos…" (+44 casos) | **morto** |
| **M2** | `index.html` | `confReposicao` empurra o movimento devolvido **duas** vezes, com ids diferentes para escapar da guarda de duplicidade: a dívida sobe o dobro da compra | `ledger.test.js` › "a compra traz o movimento do razão e o app adota o saldo novo" | **morto** |
| **M2b** | `index.html` | `ledgerMovs()` devolve as compras duplicadas — o retrato de um backfill rodado duas vezes sem o índice único de origem | `ledger.test.js` › "o razão tem 21 movimentos…" (+42 casos) | **morto** |
| **M3** | `index.html` | sinal do crédito invertido em `saldoVictor()`: pagar o Victor passaria a **aumentar** a dívida com ele | `ledger.test.js` › "saldoVictor() = R$ 5.758,30 — e é débitos menos créditos" (+23 casos) | **morto** |
| **M4** | `index.html` | `saldoVictor()` volta a somar o valor do estoque — quebra, perda e sobra de inventário voltariam a mexer na dívida com o sócio | `ledger.test.js` › "saldoVictor() = R$ 5.758,30…" (+27 casos) | **morto** |
| **M5** | `index.html` | o card do Dashboard para de ler o razão e volta a derivar a dívida de `CMV + estoque − pago` | `ledger.test.js` › "os dois cards (Financeiro e Dashboard) também ignoram o estoque" **e** `estatico.js` › `FORMULA LEGADA VOLTOU` | **morto** |
| **M6** | `migrations/006_ledger_victor.sql` | as funções do razão param de resolver o autor por `vsp_ator()` e passam a gravar o nome que o cliente mandar — a impersonação corrigida em 15/09 volta, agora no razão financeiro | `estatico.test.js` › "quem escreve no razão é a SESSÃO, nunca o nome vindo no payload" **e** `estatico.js` › `IDENTIDADE DO RAZAO VOLTOU AO PAYLOAD` | **morto** |
| **OF-M1** | `index.html` | fila só em memória: `filaGuardar` diz que guardou sem gravar no IndexedDB | `fila.test.js` › "offline: grava a intenção no IndexedDB ANTES de dizer…" (+33 casos) | **morto** |
| **OF-M2** | `index.html` | a partir da 2ª tentativa o envio inventa op_id novo | `fila.test.js` › "o op_id é o MESMO em todas as tentativas" **e** `estatico.js` › `FILA OFFLINE QUEBRADA` | **morto** |
| **OF-M3** | `index.html` | o trabalhador apaga a intenção assim que começa a enviar | `fila.test.js` › "reconexão: envia, só confirma com 200…" (+18 casos) | **morto** |
| **OF-M4** | `index.html` | "Estoque insuficiente" classificado como sucesso | `fila.test.js` › "estoque acabou enquanto estava offline: conflito…" (+3 casos) | **morto** |
| **OF-M5** | `index.html` | a troca para `enviando` não confere se a intenção está livre: duas abas enviam a mesma | `fila.test.js` › "duas abas processando ao mesmo tempo enviam cada intenção UMA vez" | **morto** |
| **OF-M6** | `index.html` | 401/403 viram transitório: retry infinito | `fila.test.js` › "401/403 (sessão sem permissão): falhou, sem retry infinito" | **morto** |
| **OF-M7** | `index.html` | o painel chama a intenção pendente de "Sincronizado" | `fila.test.js` › "pendente: barra e painel dizem guardado, nunca confirmado/sincronizado" | **morto** |
| **CX-M1** | `index.html` | prévia com diferença = esperado − real | `conferencia.test.js` › "prévia: diferença = real − esperado…" | **morto** |
| **CX-M2** | `index.html` | app manda `p_saldo_esperado` | `conferencia.test.js` › "só saldo real, observação e op_id…" | **morto** |
| **CX-M3** | `index.html` | cada confirmar gera op_id novo | `conferencia.test.js` › "retry usa o MESMO op_id…" | **morto** |
| **CX-M4** | `index.html` | app manda `p_usuario` | `conferencia.test.js` › "só saldo real, observação e op_id…" | **morto** |
| **CX-M5** | `index.html` | histórico mostra o caixa de hoje no lugar da foto | `conferencia.test.js` › "o histórico mostra a FOTO…" | **morto** |
| **CX-M6** | `index.html` | centavos truncados (`Math.trunc`) | `conferencia.test.js` › "prévia…" (19,99 · 0,29 · 4,35) | **morto** |
| **CX-M7** | `index.html` | registrar lança saída de ajuste | `conferencia.test.js` › "registrar não altera…" | **morto** |
| **CX-M8** | `index.html` | sem rede, usa o caixa da cópia local | `conferencia.test.js` › "rede cai ao consultar o esperado…" | **morto** |
| **DR-M1** | `migrations/004_rpc_operacoes.sql` | guarda de estoque da venda vira `< 0` | `contrato.test.js` › "as migrations reais batem com a foto de producao" **e** `estatico.js` › `CONTRATO DO BANCO DIVERGE` | **morto** |
| **DR-M2** | `migrations/006_ledger_victor.sql` | view do extrato sem `security_invoker` e com SELECT para anon | `estatico.js` › `CONTRATO DO BANCO DIVERGE` | **morto** |
| **DR-M3** | `migrations/005_ator_da_sessao.sql` | `vsp_ator()` deixa de olhar o uid | `contrato.test.js` › "as migrations reais…" **e** `estatico.js` | **morto** |
| **DR-M4** | `index.html` | app chama `vsp_caixa_atual`, que não existe | `estatico.js` › `CONTRATO DO BANCO DIVERGE` (+ casos da conferência) | **morto** |
| **DR-M5** | `migrations/007_conferencia_caixa.sql` | 007 volta a chamar `vsp_audit` (fictício) | `contrato.test.js` › "nenhuma migration… chama auxiliar que nao existe" **e** `estatico.js` | **morto** |

Dois detalhes que valem registro:

* **M5 é o mutante que justifica o fixture "razão inventado".** Com o fixture de produção,
  a fórmula antiga dá **exatamente** os mesmos 5.758,30 — os dois cards mostrariam o número
  certo pelo motivo errado e o mutante sobreviveria. O que o mata é o caso que carrega um
  razão de duas linhas (1.000,00 de débito, 250,00 de crédito → saldo 750,00): aí os dois
  números divergem e a fórmula velha aparece.
* **M6 é o único que mora fora do `index.html`.** Ele existe porque o razão é escrito
  dentro do PostgreSQL, e nenhum teste do harness veria essa regressão — o harness não roda
  SQL. A trava é sobre o **texto** da migration, nos dois lugares (o caso do
  `estatico.test.js` e a checagem 8 do `estatico.js`).

## Divergências documentadas (`it.pendente`)

Um caso `it.pendente(nome, oQueEsperar, fn)` afirma o comportamento **correto**, que
ainda não acontece. Ele **não derrubar a suíte** é de propósito: a divergência fica
registrada, com o valor certo escrito no relatório de toda rodada, e quando a correção
entra o runner grita `PENDENTE AGORA PASSA — remova o marcador`. É o contrário de
esconder o problema. Use este marcador para a próxima divergência conhecida em vez de
comentar o teste ou escrever o número errado como se fosse o certo.

**Hoje não há nenhuma divergência aberta: 0 pendentes.** Os dois casos que nasceram
pendentes junto com a suíte do razão, em 16/09/2026, foram corrigidos no mesmo dia. Ficam
registrados aqui porque **os dois eram bugs reais que ninguém tinha visto**, e é o melhor
argumento a favor de escrever o caso antes de ter a correção:

1. **A compra não atualizava a Conta do Victor até alguém sincronizar.** A
   `vsp_registrar_compra` insere o movimento `compra_financiada` na mesma transação, mas o
   `confReposicao` só adotava `res.compra` e `res.produto` — o razão local ficava parado.
   Você lançava uma compra de 4.660,00 e "A empresa deve a você" continuava mostrando o
   saldo de antes, no Financeiro **e** no Dashboard. Corrigido: o `confReposicao` adota
   `res.movimento`, com guarda de duplicidade pelo id. O caso virou
   `ledger.test.js` › "a compra traz o movimento do razão e o app adota o saldo novo", e é
   ele que mata o mutante **M1**.
2. **O estorno descontava o valor duas vezes.** `vsp_ledger_estornar_origem` faz **duas**
   coisas: insere um movimento de sinal oposto **e** marca `estornado_em` no original. Só
   que `vsp_saldo_victor()` e a view `v_ledger_victor` filtravam
   `where estornado_em is null` — e é essa view que o app carrega em `DB.ledger`. O valor
   saía da conta uma vez por exclusão e outra pela compensação: estornar a compra de
   **4.105,00** levaria o saldo de 5.758,30 para **−2.451,70** em vez de **1.653,30**, ou
   seja, a tela diria que o **Victor** deve à empresa. Corrigido na migration: o saldo e a
   view deixaram de filtrar `estornado_em` (o par soma zero, e o extrato passa a mostrar o
   erro **e** a correção, que é o que se espera de um razão). O `where estornado_em is null`
   continua onde faz sentido: dentro do laço que impede estornar duas vezes o mesmo
   movimento.

### Já fechadas antes (o ciclo completo do mecanismo)

Os quatro casos abaixo **nasceram como `it.pendente`** contra a cópia do OneDrive e
foram convertidos em `it()` normais quando as correções entraram no repositório — o
ciclo completo do mecanismo. Continuam aqui como regressão: se qualquer um voltar a
divergir, a suíte cai.

1. **C1 — `dadosFechamento` descontava o pagamento de fornecedor do lucro.** Na cópia
   velha o "resultado a dividir" de 09/2026 dava **3.882,70**; o correto é **8.238,70**,
   que é exatamente o `operacional` do `dadosDRE` do mesmo mês. A diferença era
   **4.356,00** — o pagamento de fornecedor de setembro. O custo da mercadoria já foi
   descontado no lucro de cada venda; descontar o reembolso de novo tira o mesmo
   dinheiro duas vezes e reduz o direito dos dois sócios.
2. **Retirada "Ambos" dividida por 2 fixo.** Com split 60/40 e retirada conjunta de
   1.200,00, Victor absorve 720,00 e Stefany 480,00 — na cópia velha os dois ficavam
   com 600,00. A divisão está escrita **em dois lugares** (`dadosFechamento` e o painel
   por sócio do `renderFin`) e os dois precisam mudar juntos: existe um caso separado
   (`o rateio da "Ambos" e o MESMO...`) só para garantir que os dois números continuem
   concordando. Foi ele que pegou a correção aplicada em um lugar só.
3. **Custo digitado com vírgula.** `582,50` no campo de custo entrava como 582,00
   (`parseFloat` para de ler na vírgula). Hoje o repositório tem `numBR()`/`valNum()` e
   o teste exige que os 582,50 cheguem ao `cust_unit` do payload
   (`operacoes.test.js`) — a prova no nível da linguagem continua em `util.test.js`,
   porque `parseFloat('150,00') === 150` não muda nunca.
4. **Texto de ajuda desatualizado.** Quatro trechos (tour, ajuda de Compras, ajuda de
   Saídas e a nota do painel de compras) falavam da caixinha "já paguei", removida em
   15/09: o texto mandava o usuário procurar um controle que não existe mais. O caso
   exige zero ocorrências de "paguei" no arquivo.

## De onde vêm os dados de teste

`fixtures.js` tem dois tipos de fixture:

* **`producao()`** — reproduz, **ao centavo**, os agregados de
  `BASELINE_2026-09-15.md`: 2 produtos, 65 vendas (60 ativas, 5 canceladas), 21
  clientes, 23 saídas, 5 reposições. O dump linha-a-linha do Supabase não está no
  repositório, então as linhas individuais são **sintéticas**: o fixture prova tudo
  sobre os **totais** (que é o que a baseline congelou) e **nada** sobre uma venda
  real específica. Toda a aritmética é feita em centavos inteiros, e duas linhas são
  rotuladas no próprio dado como **linha de ajuste** (a última venda recebida, ~20
  centavos, e uma saída de "outros" em julho) — nenhum número foi encaixado às
  escondidas. `producao()` chama `verificar()` a cada chamada e **explode** se o
  fixture deixar de bater com a baseline.
* **`ledgerProducao()`** — o razão da Conta do Victor, 21 movimentos, já dentro de
  `producao()` como `DB.ledger`. Mesma regra: **exato no agregado, sintético no detalhe**.
  Os 5 débitos de compra são exatos (cada um é o `custTotal` da reposição de mesmo id, e a
  origem aponta para ela) e o saldo inicial é exato (**9.134,30**, origem `migracao`,
  datado no dia anterior à 1ª venda ativa). Os 15 reembolsos somam exatamente
  **22.441,00**, mas as `saidas` do fixture comprimem esses 15 pagamentos em 5 linhas do
  tipo `fornecedor` — que também somam 22.441,00 —, então cinco movimentos apontam para
  essas saídas (a coluna Origem mostra data e forma de pagamento, nunca valor) e os outros
  dez entram como `manual`, que é um `origem_tipo` legítimo da tabela. Só o último
  (**4.356,00** em 15/09, o pagamento restaurado) casa valor **e** saída. Uma linha é
  rotulada no próprio dado como **linha de ajuste**.
  `verificar()` recalcula o razão em centavos inteiros por conta própria e confere as
  contagens, os três subtotais, o saldo, a ordem `(data, id)` e o `saldoCorrido` de **cada**
  linha. A `divida com Victor` que ele checava pela fórmula antiga
  (`CMV + estoque − pago`) foi substituída pelo `saldo do razão`: a coincidência entre os
  dois números é história, não definição.
  `ledgerComEstorno(movs, origemTipo, origemId, motivo)` faz o que a
  `vsp_ledger_estornar_origem` faz: marca `estornadoEm` e acrescenta o movimento
  compensatório. `movLedger(over)` monta um movimento solto e `ledgerVazio()` é o razão de
  quem ainda não sincronizou.
* **fixtures pequenos** — `dbEstoqueZero`, `dbEstorno('limpo'|'vendaDepois'|'insuficiente')`,
  `dbSplit(60,40)`, `dbComTaxa`, `dbMinimo` — números redondos, conferíveis de cabeça,
  um caso isolado cada.

Os objetos estão no formato **pós-mapeamento**
(`mapProd`/`mapVenda`/`mapSaida`/`mapRep`/`mapLedger`), igual ao que o `DB` do app fica
depois do `loadAll()`.

## Como o harness funciona (e o que nele é falso)

`harness.js` lê o `index.html`, extrai os blocos `<script>` sem `src`, monta um
contexto `vm` e roda cada bloco **na ordem do arquivo, no mesmo contexto** — como o
navegador faria.

**É código real:** todas as funções e variáveis do `index.html`. Nada foi copiado
para dentro do teste. Se o `index.html` mudar, a suíte sente.

**É stub (escrito no harness, falso de propósito):**

| stub | comportamento |
|---|---|
| `document` | `getElementById`/`querySelector` devolvem **sempre** um elemento falso, nunca `null`, com `.value`/`.innerHTML`/`.textContent`/`.style`/`.classList`. Todo texto escrito é gravado, e é assim que o teste lê os toasts e os painéis. |
| `fetch` | por padrão **lança**. Nenhum teste toca a rede. `rede.fake()` troca por respostas 2xx canned. Toda chamada fica registrada em `rede.chamadas`. |
| `sbRpc` (só via `h.espiarRpc`) | troca a função **real** por um gravador que devolve o que o teste mandar. Guarda `{fn, params, op, estoque, resposta}`, com `estoque` = foto do `DB` no instante da chamada. **Nenhuma conta do banco acontece.** Se o `index.html` sob teste não tiver `sbRpc`, falha dizendo exatamente isso. |
| `localStorage` | `Map` em memória |
| `setTimeout`/`setInterval` | **não agendam nada** — registram e devolvem um id |
| `confirm`/`alert`/`prompt` | gravam a mensagem; `confirm` devolve `ui.respostaConfirm` |
| `navigator` | de propósito **sem** `serviceWorker`, para o `registrarSW()` sair na primeira linha |
| `window`, `location`, `Blob`, `URL`, `Chart`, `open()` | no-ops |

**Uma linha é injetada no código do app**, no fim de cada bloco:

```js
;globalThis.__vspEvals.push(function(__vspCode){return eval(__vspCode);});
```

Ela existe porque `let DB = ...` e `const SOCIOS = [...]` são bindings lexicais e
**não** viram propriedades do global — sem esse gancho o teste não conseguiria popular
o `DB`. É um `eval` direto, então enxerga todo o escopo de topo do bloco. Nada mais do
arquivo é alterado, e o `estatico.test.js` valida a sintaxe dos blocos **originais**,
sem a linha.

Com o `fetch` bloqueado, as gravações caem no **modo offline real do app** (`sbFetch`
enfileira e devolve um `Response` 200 falso), então as funções rodam até o fim,
incluindo `renderAll()`. Os `render*` **não** são silenciados: eles rodam de verdade, e
um erro de runtime dentro deles derruba o teste — que é o que se quer.

Esse modo offline é justamente **o motivo de as quatro operações usarem `h.espiarRpc` em
vez do `fetch` falso**: uma RPC com a rede bloqueada é enfileirada e recebe de volta um
eco do próprio corpo enviado, que **não** é o envelope (`{venda, produto, repetida}`) que
o app espera. O teste ficaria verde sem provar nada. Com o espião, a resposta é
explícita, escrita no caso, e dá para exercitar retry, `repetida:true` e falha da RPC de
propósito.

## O que esta suíte NÃO testa

Não confunda 186 casos verdes com cobertura. Fica de fora, e **continua precisando de
olho humano, de teste em SQL e de teste no app publicado**:

* **A matemática do custo médio ponderado, a atomicidade e a idempotência de verdade.**
  Elas são SQL hoje (`vsp_registrar_compra`, `vsp_cancelar_venda`,
  `vsp_estornar_compra`). O harness prova que o app **chama** a função com o payload e o
  `op_id` certos, e nada sobre o que acontece dentro da transação: se a média ponderada
  estiver errada no banco, a suíte continua verde. Essas contas são testadas **em SQL,
  contra o banco real, em transação revertida** — o registro está em
  `migrations/APLICADO.md`, e quem mexer em `migrations/004_rpc_operacoes.sql` tem de
  refazer aqueles testes lá, não aqui. O que a suíte **prova** sobre o SQL desde 17/09/2026
  é que o texto das migrations é o de produção (`CONTRATO DO BANCO`, abaixo).
* **Rede e Supabase.** Nenhuma requisição real acontece. Não se prova que a tabela
  existe, que a coluna tem o nome certo, que o `PATCH` de fato gravou, que a função
  `vsp_*` existe com essa assinatura, nem que o `jsonb` enviado é aceito (um campo com
  nome errado dentro de `p_rep` passa aqui e estoura em produção). Um `sbPost` para uma
  tabela inexistente também passaria.
* **RLS e autenticação.** As políticas de segurança do Supabase, o login, a expiração
  de sessão e o `testarSeguranca()` não são exercitados. Se o RLS for desligado por
  acidente, esta suíte não vê.
* **Concorrência real.** Dois aparelhos lançando ao mesmo tempo, `id = Date.now()`
  colidindo, fila offline reenviando em ordem errada, a trava de linha do
  `update ... where caixas >= qtd` — nada disso é simulado. O harness é de uma thread e
  determinístico. O que ele cobre é o **duplo clique no mesmo aparelho** (a trava
  `_emAndamento`, em `operacoes.test.js`) e o **retry reusando o `op_id`**; a disputa
  entre duas sessões foi testada no banco, com duas conexões simultâneas, e está em
  `migrations/APLICADO.md`.
* **Layout, CSS e a interface de verdade.** O `document` falso aceita qualquer coisa:
  elemento fora de lugar, botão escondido, modal que não abre, tabela ilegível no
  celular — tudo passa. Os ids são conferidos estaticamente (`estatico.test.js`), mas
  a existência de um id não garante que o usuário consiga usar a tela.
* **Timers e o que depende deles.** Nada agendado executa: toast que não desaparece,
  sessão que não expira, `setInterval` do service worker, tour automático.
* **Service worker, PWA, cache e atualização de versão.** O `registrarSW` sai na
  primeira linha de propósito.
* **Chart.js, geração de PDF/CSV/impressão e o QR Code do Pix** — as funções existem e
  algumas são exercitadas de raspão pelos `render*`, mas o resultado visual (gráfico,
  impressão, QR legível pelo banco) não é verificado. O código do Pix (`pixCodigo`,
  `_crc16`) não tem caso próprio: precisa ser validado contra o app de um banco real,
  não contra um teste que repetiria a mesma implementação.
* **Os dados reais de produção.** O fixture reproduz os **totais** da baseline, não as
  65 vendas verdadeiras. Um erro numa venda específica do banco não aparece aqui.
* **`loadAll`, `enviarFila`, `sincronizar`, backup na nuvem, auditoria no servidor** —
  dependem de rede e ficaram fora. O `audit()` é chamado de verdade pelos casos, mas
  só até o `sbPost`, que é interceptado.

Nada aqui é teste falso: onde não foi possível isolar a função de verdade (rede, RLS,
concorrência, visual, a conta que agora é SQL), preferimos escrever nesta lista — ou
apagar o caso — em vez de fingir um caso verde. Em 15/09, quando as quatro operações
viraram funções do PostgreSQL, **3 casos foram removidos e 1 migrou para o estático**
porque só podiam ser honestos contra o banco; o resto foi reescrito para testar a
chamada. O número de casos subiu (106 → 125), mas a leitura correta não é "cobre mais":
é que o harness passou a cobrir **outra coisa**, e a parte que ele perdeu está coberta em
SQL, fora daqui.
