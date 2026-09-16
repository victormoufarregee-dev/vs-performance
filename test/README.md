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
```

São **125 casos** hoje: 32 no financeiro, 36 nas operações, 34 nos utilitários e 23
estáticos. Sai com código **1** se algum caso falhar (ou se um arquivo de teste não
carregar), e **0** quando está tudo verde. Testado no Windows 11 com Git Bash e Node 24.

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

Existem **duas cópias do app no disco** e elas divergem:

| cópia | papel |
|---|---|
| `<repo>\index.html` (ao lado de `test/`) | cópia publicável, onde as correções C* entram — é o **alvo padrão** da suíte |
| `C:\Users\victo\OneDrive\VS Performance - 25 - JULHO - 2026\index.html` | pasta de trabalho do OneDrive, hoje **atrás** do repositório |

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

Rodando contra a cópia do OneDrive hoje, **37 casos falham**: ela é **anterior à
migração** das quatro operações — não tem `sbRpc`, não chama nenhuma RPC e ainda calcula
o custo médio no cliente. O `h.espiarRpc` detecta isso e falha com
`este index.html nao tem sbRpc() — ele e ANTERIOR a migracao`, em vez de um erro
obscuro. Isso é a suíte funcionando: ela sabe dizer qual cópia está velha.

## O que cada suíte cobre

### `financeiro.test.js` — o dinheiro que ainda é calculado em JavaScript (32 casos)

* **Regressão da baseline de 15/09/2026.** Com o fixture de produção, o código real
  tem de devolver: `valorEstTotal()` = **4.660,00**, custo já vendido = **23.539,30**,
  mercadoria fornecida = **28.199,30**, pago a fornecedores = **22.441,00**,
  dívida com Victor = **5.758,30**, recebido = **51.066,00**, saídas = **51.069,49**,
  resultado de caixa = **−3,49**, total comprado = **19.065,00** e a diferença
  explicada de **9.134,30**. Estes números não podem mudar sem uma decisão
  consciente — se mudarem, a suíte cai.
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

### `estatico.test.js` — o texto do arquivo (23 casos)

Não executa nada (fora o parse). Pega justamente o que o harness **não** pega:

* sintaxe de **todos** os blocos `<script>` inline, via `new Function` (sem executar);
* chaves balanceadas, nenhum bloco truncado, e o único script externo é o Chart.js
  do cdnjs;
* nenhuma referência órfã a `repPagar`, `toggleRepPgto` ou `lancarFin`;
* **toda** função chamada em `onclick=`/`onchange=`/`oninput=`/... existe de fato como
  `function nome` ou `const/let/var nome` (103 nomes hoje);
* **todo id usado em `getElementById('...')` existe no HTML** (244 ids hoje) e nenhum
  id está duplicado — esta é a checagem que cobre o ponto cego do `document` falso;
* nenhum `console.log` (nem `console.warn/error/...`), nenhum `debugger`, nenhum
  `alert('teste')`;
* as correções de 15/09 continuam no código, **onde elas moram hoje**: `confReposicao`
  **não** escreve mais `p.custoCaixa`/`p.custoFrasco`/`p.caixas` (a conta saiu do
  cliente) e chama `vsp_registrar_compra` com `op_id`; e a regra do arredondamento
  ("cada um arredondado uma vez, os dois a partir do valor não arredondado") é conferida
  no **SQL**: `migrations/004_rpc_operacoes.sql` tem de conter
  `v_cc := round(v_cf_raw * v_fpc, 2)` e **não** `round(v_cf * v_fpc)`, que era o bug
  dos 582,52. É o único caso da suíte que lê um arquivo que não é o `index.html`, e
  existe porque, se essa linha desaparecer da migration, **nenhum** teste do harness
  veria — o harness não roda SQL;
* a guarda `podeRecalcular` no estorno (que hoje só monta o **aviso** ao usuário: quem
  decide o custo é o banco), o botão de estorno ligado na interface e a compra sem saída
  automática;
* higiene: doctype, título, charset, `APP_VERSION` declarada uma única vez, e a chave
  do Supabase no arquivo é a **anon** (o teste decodifica o JWT e confere `role`) —
  nunca a `service_role`.

## Divergências documentadas (`it.pendente`)

Um caso `it.pendente(nome, oQueEsperar, fn)` afirma o comportamento **correto**, que
ainda não acontece. Ele **não derrubar a suíte** é de propósito: a divergência fica
registrada, com o valor certo escrito no relatório de toda rodada, e quando a correção
entra o runner grita `PENDENTE AGORA PASSA — remova o marcador`. É o contrário de
esconder o problema. Use este marcador para a próxima divergência conhecida em vez de
comentar o teste ou escrever o número errado como se fosse o certo.

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
* **fixtures pequenos** — `dbEstoqueZero`, `dbEstorno('limpo'|'vendaDepois'|'insuficiente')`,
  `dbSplit(60,40)`, `dbComTaxa`, `dbMinimo` — números redondos, conferíveis de cabeça,
  um caso isolado cada.

Os objetos estão no formato **pós-mapeamento** (`mapProd`/`mapVenda`/`mapSaida`/`mapRep`),
igual ao que o `DB` do app fica depois do `loadAll()`.

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

Não confunda 125 casos verdes com cobertura. Fica de fora, e **continua precisando de
olho humano, de teste em SQL e de teste no app publicado**:

* **A matemática do custo médio ponderado, a atomicidade e a idempotência de verdade.**
  Elas são SQL hoje (`vsp_registrar_compra`, `vsp_cancelar_venda`,
  `vsp_estornar_compra`). O harness prova que o app **chama** a função com o payload e o
  `op_id` certos, e nada sobre o que acontece dentro da transação: se a média ponderada
  estiver errada no banco, a suíte continua verde. Essas contas são testadas **em SQL,
  contra o banco real, em transação revertida** — o registro está em
  `migrations/APLICADO.md`, e quem mexer em `migrations/004_rpc_operacoes.sql` tem de
  refazer aqueles testes lá, não aqui.
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
