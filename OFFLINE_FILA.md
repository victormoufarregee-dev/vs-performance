# Fila offline persistente — 17/09/2026

Objetivo: **uma operação feita sem internet nunca some** ao recarregar, fechar ou reabrir o
app, **nunca é anunciada como registrada antes de o servidor confirmar**, e **nunca entra
duas vezes**.

SHA inicial: `f557b5b` (árvore limpa, suíte 186/186, `estatico.js` exit 0, produção igual ao
repositório ignorando CRLF).

---

## 1. Como era ANTES (reproduzido no navegador, antes de qualquer correção)

Reprodução no Chromium do painel do app, servindo o `index.html` de `f557b5b` em
`localhost:8130`, sessão simulada (`authToken` falso), `fetch` forçado a falhar. Nenhuma
chamada chegou ao Supabase; nenhuma venda real foi criada.

| # | cenário | o que aconteceu | evidência |
|---|---|---|---|
| 1 | venda offline | toast **"Venda registrada!"**; a venda **não** aparece na lista; estoque local não baixa; formulário limpo | `toasts:["Venda registrada!"]`, `DB.vendas.length:0`, `caixas:1` |
| 2 | onde ficou | `localStorage['vsp_fila_v1']` = array com `{url:'rpc/vsp_registrar_venda', method:'POST', body, quando, erro:''}` (713 bytes); `p_op_id` só existia dentro do `body` | `op: bf568b73-…` |
| 3 | vender a mesma última caixa de novo, offline | aceitou de novo, **"Venda registrada!"** | 2 itens na fila, estoque local 1 |
| 4 | recarregar a página | a fila sobreviveu (mesmos op_id), mas `authToken` só vive em memória: nada é enviado até logar | `filaMem:2`, `authToken:false` |
| 5 | fechar a aba e abrir outra | a fila sobreviveu | mesmos 2 op_id |
| 6 | reconectar: 1ª aceita, 2ª "estoque insuficiente", 3ª independente | 1ª enviada; 2ª ficou com `erro:"HTTP 400: estoque insuficiente"` **na cabeça da fila** e a 3ª (independente) **ficou presa**; a rodada seguinte reenviou a 2ª de novo | `chamadas:[2ª]`, `filaTam:2` |
| 7 | armazenamento cheio / modo privado (`setItem` lança) | toast **"Venda registrada!"**; item só em memória; **recarregar = venda perdida** | `noArmazenamento:null` → após reload `fila:0` |
| 8 | servidor não responde (fetch pendurado) | `enviando=true` para sempre, fila travada até recarregar; "Enviar agora" ignorado em silêncio | `enviandoApos3s:true` |
| 9 | duas abas enviando | a **mesma** venda enviada **duas vezes** | `enviosAoServidor:["op-duas-abas","op-duas-abas"]` |
| 10 | duas abas lançando offline | a aba B regravou o array inteiro com a cópia antiga: **a venda da aba A sumiu** | `armazenado:["venda-aba-B"]` |

Outros pontos lidos no código: `409` tratado como "já enviado" (mas a RPC devolve 409 para
**produto inexistente**, código 23503); qualquer gravação (saída no financeiro, ajuste de
estoque com valor absoluto, estorno) também entrava nessa fila com o mesmo 200 inventado;
sem prazo de resposta; sem estado de conflito; sem descarte por item.

### Causa da perda

1. `sbFetch` **fingia sucesso**: sem rede, devolvia `new Response(eco,{status:200})` com o
   próprio corpo. Quem chamava achava que tinha gravado.
2. A fila era **um array inteiro** num único `localStorage.setItem`, cujo retorno era
   ignorado — falha de quota perdia em silêncio, e duas abas sobrescreviam uma à outra.
3. A trava de envio era uma variável **por aba**, e a fila não tinha estados: erro
   definitivo bloqueava tudo atrás e era repetido sem fim.

---

## 2. Como ficou

### Armazenamento e esquema

* **IndexedDB** `vsp_offline` (versão 1), store `intencoes`, `keyPath: id_local`. **Um
  registro por intenção**, cada escrita numa transação própria — duas abas não se
  sobrescrevem. A gravação só é considerada feita no `oncomplete` **e depois de relida**.
* Sem IndexedDB: `localStorage` com **uma chave por intenção** (`vsp_fila2:<id_local>`),
  também relida após gravar.
* Sem nenhum dos dois: modo `nenhum` — a venda offline é **recusada** com aviso ("este
  aparelho não conseguiu guardar… NÃO foi registrada") e a barra avisa. Nada é prometido.
* Após guardar, pede `navigator.storage.persist()` (reduz o risco de o navegador despejar).

Registro (`versao_payload: 1`):

```
id_local, seq, op_id, tipo, payload, versao_payload, criado_em, atualizado_em,
status, tentativas, tentativas_servidor, ultima_tentativa_em, proxima_tentativa_em,
ultimo_erro, erro_tipo, usuario, depende_de[], resumo, resultado, dono
```

É uma **intenção**, não regra de negócio: o payload é o que a RPC recebe. Estoque, custo e
razão continuam sendo decididos **só no banco**, na hora em que a intenção chega.

### Estados

`pendente → enviando → confirmado | falhou | conflito`

| estado | texto na tela | quem sai dele |
|---|---|---|
| pendente | "Guardado neste aparelho" | o trabalhador |
| enviando | "Sincronizando…" | o trabalhador (ou, se a aba fechou no meio, vira órfão após 2 min e volta a ser enviado com o mesmo op_id) |
| confirmado | "Confirmado pelo servidor" | limpeza (7 dias ou além dos 50 mais recentes, nunca se algo aberto depende dele) |
| falhou | "Não enviado" + motivo | só o usuário: "Tentar de novo" ou "Cancelar esta operação" |
| conflito | "Conflito" + "Não foi possível concluir: o estoque mudou enquanto você estava offline." | só o usuário |

### op_id

Nasce **uma vez**, no clique (`regVenda._op` / `confReposicao._op`), e é o mesmo:
na tentativa direta, na intenção guardada, em **todas** as tentativas do trabalhador
(`p_op_id` vem sempre de `item.op_id`), e no "Tentar de novo". Se a tentativa direta caiu
depois de o servidor gravar, o reenvio cai na idempotência da RPC (`repetida:true`) em vez
de duplicar.

### Classificação da resposta

| resposta | classe | efeito |
|---|---|---|
| 2xx | ok | `confirmado`, guarda `resultado` (ids, `repetida`) |
| sem rede, prazo estourado (20 s escrita / 30 s leitura, `AbortController`) | transitório | volta a `pendente`, espera crescente (5 s … 5 min); **interrompe a rodada** (os seguintes cairiam igual) |
| 408, 425, 429, 5xx | transitório | `pendente` com espera; depois de **12** recusas do servidor vira `falhou` (queda de rede não conta) |
| mensagem "Estoque insuficiente" / "Estoque mudou" | conflito | `conflito`, sem retry automático |
| 401/403 (depois de tentar renovar o token) | permanente | `falhou`: "Entre no app de novo e toque em Tentar de novo" |
| 400/404/409/422 e demais 4xx (payload inválido, produto inexistente…) | permanente | `falhou` com a mensagem do servidor |
| cadastro de cliente com 409 | verificado | lê o cliente com aquele id: telefone igual → `confirmado`; diferente → `conflito` |

### Um trabalhador só

Três camadas: `filaTrabalhando` (a aba não inicia duas rodadas), `navigator.locks`
(`vsp_fila_envio`, `ifAvailable` — só uma aba trabalha) e, a que realmente garante, a **troca
atômica de status**: pegar a intenção é ler-decidir-gravar na **mesma transação** do
IndexedDB, e só troca para `enviando` se ela ainda estiver `pendente` (ou órfã). O resultado
só é gravado se o registro ainda for `enviando` **desta** aba.

### Ordem e dependência

FIFO por `seq` (desempate por `id_local`). Uma recusa **não** segura as intenções
independentes que vêm depois. Dependência é explícita: cliente novo cadastrado offline vira
uma intenção `cliente`, e a venda guarda `depende_de:[id_local do cliente]` (porque
`vendas.cli_id` tem FK). A venda só sai depois de o cadastro ser confirmado; se o cadastro
falhar, a venda vira `falhou` sem ser enviada. Cancelar o cadastro cancela junto quem
depende dele (com aviso).

Uma intenção de outra pessoa (`usuario` diferente do logado) **espera o login dela** — a
RPC grava o autor pela sessão, e a venda do Victor não pode sair com a sessão da Stefany.

### Estoque prometido

Antes de guardar uma venda, o app desconta do estoque local o que já está prometido por
vendas guardadas e não confirmadas **neste aparelho**. Não dá mais para vender offline a
mesma última caixa duas vezes no mesmo aparelho. Entre aparelhos diferentes, quem decide é o
banco (a segunda vira `conflito`).

### Tela

* Barra do topo (aparece inclusive na tela de login): "📴 Sem internet." · "N operação(ões)
  salvas neste aparelho. Serão enviadas quando a conexão voltar." (ou "Entre no app para
  enviar.") · "Sincronizando…" · "N precisa(m) da sua atenção" · botão **Ver**.
* Painel "Operações guardadas neste aparelho": cada intenção com tipo, resumo, hora,
  tentativas, autor, motivo em português, **Detalhes** (código da operação, datas,
  dependência), **Tentar de novo** e **Cancelar esta operação** (com confirmação; se uma
  tentativa anterior caiu no meio, avisa que o servidor pode já ter recebido e sugere tentar
  antes). "Enviados recentemente" lista os confirmados.
* Toasts: "Salvo neste aparelho. Será enviado quando a conexão voltar." ·
  "N operação(ões) guardada(s) no aparelho foram enviadas e confirmadas pelo servidor." ·
  "N operação(ões) não puderam ser concluídas. Toque em "Ver" na barra azul."

### Fila antiga

Na abertura, `vsp_fila_v1` é convertida: venda e compra por RPC viram intenções `pendente`
**com o op_id original**; `POST clientes` vira intenção `cliente`; qualquer outra coisa
(PATCH, DELETE, saída…) vira `legado` em **`falhou`** — não é enviada sozinha; o usuário
revisa e decide. A chave antiga só é apagada quando **todos** os itens foram gravados e
relidos. JSON corrompido não derruba o app.

### sbFetch

Não finge mais sucesso: sem rede ou sem resposta no prazo, **lança** um erro com
`semRede:true` (e `prazo:true` se foi o prazo). Quem sabe guardar para depois é a própria
operação.

---

## 3. Todas as gravações do app, classificadas

| operação (função) | chamada | offline agora? | por quê |
|---|---|---|---|
| Venda (`regVenda`) | RPC `vsp_registrar_venda` | **sim** | idempotente por op_id; estoque decidido no banco → conflito |
| Cliente novo dentro da venda | `POST clientes` | **sim** | id nasce no aparelho; 409 conferido por telefone; dependência explícita |
| Compra (`confReposicao`) | RPC `vsp_registrar_compra` | **sim** | idempotente por op_id; não depende de estoque |
| Cancelar venda (`confirmarCancelamento`) | RPC `vsp_cancelar_venda` | precisa adaptação | op_id nasce a cada clique (não por intenção); falta regra para cancelar venda que ainda está na fila |
| Saída no financeiro (`regSaida`) | `POST saidas` | precisa adaptação | sem op_id; id por `Date.now()`; financeiro |
| Quitar fiado (`confirmarQuitar`) | `PATCH vendas` | precisa adaptação | recalcula lucro a partir do estado local e sobrescreve |
| Vencimento do fiado (`salvarVencimento`) | `PATCH vendas` | precisa adaptação | última gravação vence |
| Editar/cadastrar cliente (`salvarCli`) | `PATCH/POST clientes` | precisa adaptação | edição concorrente sobrescreve |
| Lote/validade (`salvarLote`) | `PATCH reposicoes` | precisa adaptação | última gravação vence |
| Estorno de compra (`estornarCompra`) | RPC `vsp_estornar_compra` | **não** | destrutivo; depende do estado do servidor |
| Ajuste de estoque (`confEntrada`) | `PATCH produtos` com valor **absoluto** | **não** | apagaria vendas feitas em outro aparelho |
| Produto (`salvarProduto`) | `PATCH/POST produtos` | **não** | custo e cadastro |
| Excluir saída/cliente (`delSaida`, `delCli`) | `DELETE` | **não** | exclusão |
| Configurações (Pix, previsão, validade, divisão, metas) | `PATCH config` | **não** | configuração global |
| Backup na nuvem (`gravarBackupNuvem`, `baixarBackup`) | `POST backups`, `PATCH config`, `DELETE backups` | **não** | já pula quando sem rede |
| Produtos iniciais (`seedProdutos`) | `POST produtos` | **não** | só em banco vazio |
| Auditoria (`audit`) | `POST audit_log` | não enfileira | melhor esforço; as RPCs gravam a própria auditoria na transação |

**Mudança de comportamento visível:** o que não é "sim" agora, sem internet, mostra erro
("sem internet no momento") em vez do falso "registrado". Antes esses itens iam para a fila
antiga — e alguns (ajuste com valor absoluto) eram perigosos de reenviar.

---

## 4. Testes

* `test/fila.test.js` — **42 casos**, JavaScript real do `index.html` sobre um IndexedDB em
  memória que garante atomicidade, serialização e assincronia (`criarIndexedDB` no harness).
  Cobre: persistência antes do aviso, queda no meio da tentativa direta, reload,
  fechar/reabrir sem sessão, gravação recusada, sem IndexedDB e sem localStorage, fallback
  localStorage, duas abas guardando, clique duplo, mesma intenção, última caixa, reconexão,
  `repetida:true`, op_id estável (rede/503/200), espera entre tentativas, prazo estourado,
  offline prolongado (30 quedas), 5xx repetido, conflito de estoque, conflito sem trava de
  cabeça, 401/403, payload inválido e produto inexistente, "Tentar de novo" em conflito,
  cancelar com confirmação, dois trabalhadores, rodada dupla na mesma aba, órfão, não tomar
  de aba viva, dependência cliente→venda (sucesso, recusa, 409 mesmo/outro cliente),
  intenção de outra pessoa, tela nunca "sincronizado" antes da hora, confirmados na lista,
  escape de HTML, migração da fila antiga (inclusive corrompida e sem conseguir gravar),
  limpeza, compra offline, saída recusada sem fila, `sbFetch` sem 200 inventado.
* `test/estatico.js` — checagem 10 `FILA OFFLINE`: reprova se `new Response(eco`,
  `enfileirar(` ou `lsSet(FILA_KEY` voltarem, ou se `indexedDB.open(`,
  `p_op_id:item.op_id`, a troca para `enviando` ou `filaGuardar(` sumirem.
* Suíte: **186 → 228** casos, todos verdes.

### Mutantes da fila (`node test/mutantes.js OF-M1 … OF-M7`)

| mutante | o que muda | quem matou |
|---|---|---|
| OF-M1 | fila só em memória (não grava no IndexedDB) | `fila.test.js` › "offline: grava a intenção no IndexedDB ANTES de dizer…" (+33) |
| OF-M2 | retry gera op_id novo | `fila.test.js` › "o op_id é o MESMO em todas as tentativas" (+1) **e** `estatico.js` › `FILA OFFLINE QUEBRADA` |
| OF-M3 | apaga a intenção antes da confirmação | `fila.test.js` › "reconexão: envia, só confirma com 200…" (+18) |
| OF-M4 | "Estoque insuficiente" tratado como sucesso | `fila.test.js` › "estoque acabou enquanto estava offline: conflito…" (+3) |
| OF-M5 | troca para `enviando` sem conferir se está livre (dois trabalhadores) | `fila.test.js` › "duas abas processando ao mesmo tempo enviam cada intenção UMA vez" |
| OF-M6 | 401/403 viram transitório (retry infinito) | `fila.test.js` › "401/403 (sessão sem permissão): falhou, sem retry infinito" |
| OF-M7 | painel chama pendente de "Sincronizado" | `fila.test.js` › "pendente: barra e painel dizem guardado, nunca confirmado/sincronizado" |

Cada mutante roda numa cópia temporária; o controle (cópia sem mutação) passa com exit 0 —
é o "restaurado dá 0". Resultado completo em `test/README.md`.

### Navegador real (Chromium do painel, IndexedDB e `navigator.locks` de verdade)

Mesmo servidor local, sessão simulada, `fetch` substituído (nada chegou ao Supabase):

* a fila antiga que sobrou da reprodução (`vsp_fila_v1` com 1 venda) foi migrada para o
  IndexedDB e a chave antiga removida;
* venda offline → "Salvo neste aparelho…", 1 registro `pendente`; a 2ª venda da última caixa
  foi barrada ("já há venda(s) guardada(s)…");
* **recarregar**: mesma intenção, mesmo op_id, barra "Entre no app para enviar" já na tela
  de login; **fechar a aba e abrir outra**: idem;
* reconexão com 1 venda aceita + 1 "Estoque insuficiente" + 1 independente: enviadas na
  ordem, `confirmado / conflito / confirmado`, mensagem de conflito em português, rodada
  automática seguinte **não** reenviou o conflito, barra "1 precisa(m) da sua atenção";
* duas abas (iframes da mesma origem) guardando ao mesmo tempo: **as duas** vendas ficaram;
  enviando ao mesmo tempo: **cada uma uma vez** (a segunda aba achou a trava ocupada);
* celular: 360, 390 e 430 px sem rolagem horizontal (`scrollWidth` = largura), botões do
  painel dentro do cartão, textos longos quebram; desktop ok. Dados de teste apagados do
  `localhost` no fim.

---

## 5. Riscos que continuam

1. **Sessão só em memória.** Depois de recarregar/fechar, nada é enviado até alguém entrar
   no app. É proposital (não enviar com sessão de outra pessoa), mas se ninguém entrar
   naquele aparelho a venda fica guardada lá.
2. **Safari/iOS não foi testado.** O navegador pode despejar dados de site não instalado
   após dias sem uso. `navigator.storage.persist()` é pedido, mas o iOS pode negar. Instalar
   o app na tela inicial reduz o risco. → smoke do Victor.
3. **Venda guardada não aparece nos relatórios, no Dashboard nem no histórico** até ser
   confirmada. Proposital (não mostrar como registrada o que não está), mas o estoque exibido
   não desconta a venda guardada — só a validação da venda desconta.
4. **Dois aparelhos offline** vendendo a mesma última unidade: um confirma, o outro vira
   `conflito` — a decisão fica com a pessoa.
5. **Conexão lenta (>20 s):** a venda pode ir para a fila mesmo que o servidor tenha
   gravado; o reenvio volta `repetida:true` e confirma sem duplicar.
6. **Modo offline pela cópia local** usa o usuário salvo na cópia; se outra pessoa usar o
   aparelho sem entrar, as intenções levam o nome da cópia.
7. **Itens `legado`** da fila antiga precisam de revisão manual (não são enviados sozinhos).
8. **Cancelamento, saída, quitação e edições** exigem internet (tabela da seção 3).
9. Ordem entre abas diferentes no **mesmo milissegundo** é determinística, mas não
   necessariamente a ordem do clique.
