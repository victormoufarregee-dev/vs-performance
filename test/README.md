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

São 106 casos hoje: 50 no financeiro, 34 nos utilitários e 22 estáticos.
Sai com código **1** se algum caso falhar (ou se um arquivo de teste não carregar),
e **0** quando está tudo verde. Testado no Windows 11 com Git Bash e Node 24.

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

Rodando contra a cópia do OneDrive hoje, **4 casos falham** — são exatamente as quatro
correções que já entraram no repositório e ainda não foram copiadas para lá (C1,
rateio da "Ambos", leitura de número com vírgula e o texto de ajuda da caixinha
"já paguei"). Isso é a suíte funcionando: ela sabe dizer qual cópia está velha.

## O que cada suíte cobre

### `financeiro.test.js` — o dinheiro (50 casos)

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
* **Custo médio ponderado (`confReposicao`)**: 8 caixas a 582,50 com estoque zerado
  tem de dar `custoCaixa` **582,50 cravado** (e explicitamente **não** 582,52, que era
  o bug de multiplicar o frasco já arredondado); segunda compra ponderando com o
  estoque que já existia; frete entrando no custo; compra que não gera saída no
  Financeiro; bloqueio quando falta quantidade/custo/data.
* **Estorno de compra (`estornarCompra`)**: caso limpo devolve estoque **e** custo
  médio; caso com venda posterior devolve o estoque e **mantém** o custo (regressão
  do bug que zerava o custo e travava a venda seguinte); estoque insuficiente é
  bloqueado sem tocar em nada nem na rede; `confirm()` recusado não faz nada;
  compra inexistente, produto apagado e a saída automática legada (id = compra+1).
* **Fechamento × DRE do mesmo mês** e **retirada "Ambos"** — ver "Divergências
  documentadas" abaixo.
* **Fechamento por sócio**: venda sem vendedor entra no lucro total e em ninguém;
  fiado em aberto nasce com lucro 0 e não conta como recebido; direito = resultado ×
  porcentagem; mês vazio não inventa número.
* **DRE**: taxa de maquininha paga por nós sai do líquido e aparece como taxa; taxa
  repassada ao cliente não; virada de ano no `mesAnterior`.

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

O caso ponta-a-ponta (digitar `582,50` no campo de custo e o valor chegar inteiro ao
banco) está em `financeiro.test.js`. A prova acima é de linguagem e vale para sempre;
a do app depende de o `numBR()` continuar no lugar.

### `estatico.test.js` — o texto do arquivo (22 casos)

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
* as correções de 15/09 continuam no código: `custoCaixa` derivado do valor **não**
  arredondado, a guarda `podeRecalcular` no estorno, o botão de estorno ligado na
  interface e a compra sem saída automática;
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
   (`parseFloat` para de ler na vírgula). Hoje o repositório tem `numBR()`/`valNum()`
   e o teste exige os 582,50 — a prova no nível da linguagem continua em
   `util.test.js`, porque `parseFloat('150,00') === 150` não muda nunca.
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
enfileira e devolve um `Response` 200 falso), então funções como `confReposicao`
rodam até o fim, incluindo `renderAll()`. Os `render*` **não** são silenciados: eles
rodam de verdade, e um erro de runtime dentro deles derruba o teste — que é o que se
quer.

## O que esta suíte NÃO testa

Não confunda 102 casos verdes com cobertura. Fica de fora, e **continua precisando de
olho humano e de teste no app publicado**:

* **Rede e Supabase.** Nenhuma requisição real acontece. Não se prova que a tabela
  existe, que a coluna tem o nome certo, que o `PATCH` de fato gravou, nem que o
  payload é aceito pelo PostgREST. Um `sbPost` para uma tabela inexistente passaria
  aqui e falharia em produção.
* **RLS e autenticação.** As políticas de segurança do Supabase, o login, a expiração
  de sessão e o `testarSeguranca()` não são exercitados. Se o RLS for desligado por
  acidente, esta suíte não vê.
* **Concorrência real.** Dois aparelhos lançando ao mesmo tempo, `id = Date.now()`
  colidindo, fila offline reenviando em ordem errada, venda gravada duas vezes por
  toque duplo — nada disso é simulado. O harness é de uma thread e determinístico.
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
concorrência, visual), preferimos escrever nesta lista em vez de fingir um caso verde.
