# Conferência de Caixa — 17/09/2026

**Estado:** app e migration escritos e testados localmente; **migration 007 NÃO aplicada**;
**não publicado**. Falta: `DEPENDE DO VICTOR — autenticar Supabase para reconciliação`.

SHA inicial: `86be916` (produção igual ao repositório, 228/228).

---

## 1. De onde vem hoje o "caixa"

Mapeado antes de construir qualquer coisa. Há **uma** conta de caixa acumulado e **cinco**
telas que usam a mesma expressão em janelas de tempo diferentes.

| onde | função | janela | conta |
|---|---|---|---|
| Financeiro → "Resultado (caixa)" | `renderFin()` | **desde sempre** | Σ `liq` (não cancelada, não fiado ou fiado quitado) − Σ `val` de todas as saídas |
| Dashboard → "Caixa do mês" | `renderDash()` | mês atual por `data` | a mesma |
| Dashboard → bloco "Hoje / período" | `renderDash()` | período escolhido por `data` | a mesma |
| DRE → "Caixa do mês" | `dadosDRE()` | mês por `data` | a mesma |
| Relatórios → "Resultado (caixa)" | `gerarRel()` | de/até por `data` | a mesma (filtro de pagamento opcional) |

O **−R$ 3,49** é o do Financeiro: recebido total R$ 51.066,00 − saídas totais R$ 51.069,49
(conferido no banco em 15/09/2026, `migrations/APLICADO.md`). É o único que é **saldo**; os
outros são **fluxo** de um período.

**O que entra:** vendas pagas (Pix, débito, crédito, parcelado, dinheiro) pelo **líquido**
(`liq` = bruto − taxa quando a taxa é "nossa"); fiado **só quando quitado**; **todas** as
saídas — pró-labore, retirada, despesa, imposto, outros e "fornecedor". O **reembolso ao
Victor** entra porque `vsp_reembolsar_victor` grava uma saída `fornecedor`.

**O que não entra:** compra de mercadoria (quem paga é o Victor — vira débito no
`ledger_victor`, não saída de caixa), estoque, CMV, lucro, dívida com o Victor, fiado em
aberto, venda cancelada. Estorno de compra e cancelamento de venda só mexem no caixa pela
exclusão da venda cancelada.

**Duas fórmulas de caixa acumulado?** Não. Não foi preciso reconciliar fórmulas antes de
construir.

**Divergências antigas encontradas (não corrigidas nesta etapa, registradas):**

1. **Fiado quitado é datado pelo dia da venda**, não pelo dia do pagamento, nas telas de
   período (Dashboard mês, DRE, Relatórios, bloco "Hoje"). O dinheiro de um fiado vendido em
   agosto e pago em setembro aparece no caixa de **agosto**. O saldo acumulado não é afetado.
   O próprio bloco "Hoje" já mostra "Fiado quitado" pela data de quitação — dentro da mesma
   tela as duas datas convivem.
2. **Parcelado entra inteiro no dia da venda.** Se a maquininha repassa em parcelas, o banco
   só vai ter parte do valor — uma conferência logo depois de uma venda parcelada deve mostrar
   **falta**, e isso não é erro de lançamento.
3. **Sem saldo inicial.** A conta começa do zero no primeiro lançamento. Em 15/09 o Victor
   disse que o banco estava em R$ 0,00 enquanto o sistema dizia −R$ 3,49; a primeira
   conferência deve mostrar essa diferença (+R$ 3,49 se nada mais mudou). A conferência
   **não** cria saldo inicial para "fazer bater".
4. **Datas futuras contam.** Venda ou saída com data à frente já entra no esperado de hoje
   (o Financeiro nunca filtrou por data). Mantido igual para não criar uma segunda regra.
5. `numBR("1.000")` devolve **1**, não mil (usado nos formulários antigos). A conferência
   **não** usa `numBR`: tem leitor próprio (`dinheiroParaCentavos`) que entende `1.000` como
   mil e recusa o que é ambíguo (`12,345`).

## 2. A Conferência

`diferenca = saldo_real − saldo_esperado` · 0 = confere · positivo = sobra · negativo = falta.

### Banco (`migrations/007_conferencia_caixa.sql`)

* `vsp_caixa_esperado_calc()` — a conta acima, somando em `numeric` e arredondando uma vez.
  Sem permissão para ninguém da API.
* `vsp_caixa_esperado()` — a mesma, para quem está na allowlist (`vsp_autorizado()`).
* Tabela `conferencias_caixa`: `id`, `conferido_em`, `escopo` (`'consolidado'`; preparado
  para contas separadas no futuro), `saldo_esperado`, `saldo_real`, `diferenca`
  (`numeric(14,2)`), `observacao`, `situacao` (`valida`/`invalidada`), `invalidada_em`,
  `invalidada_por`, `motivo_invalidacao`, `op_id` (único), `created_at`, `created_by`.
  `check (diferenca = saldo_real - saldo_esperado)`.
* **Foto imutável:** trigger `trg_cc_protege` recusa `DELETE` e qualquer mudança nos números,
  datas, autor e op_id — inclusive para o dono do banco. Só a situação muda, uma vez, de
  `valida` para `invalidada`, com motivo.
* **RLS:** allowlist lê; ninguém grava pela API (sem insert/update/delete para
  `authenticated`, nada para `anon`).
* `vsp_registrar_conferencia_caixa(p_saldo_real, p_observacao, p_op_id)` — `SECURITY DEFINER`,
  `search_path = public, pg_temp`, `vsp_autorizado()`, autor por `vsp_ator()`, op_id
  obrigatório, mesmo op_id devolve a existente (inclusive na corrida, por `unique_violation`),
  até 2 casas decimais, calcula o esperado **dentro da transação**, calcula a diferença,
  grava, audita (`CONFERENCIA_CAIXA`) e devolve a foto. **Não existe parâmetro** para
  esperado, diferença ou autor.
* `vsp_invalidar_conferencia_caixa(p_id, p_motivo)` — motivo obrigatório, idempotente,
  auditado (`CONFERENCIA_CAIXA_INVALIDADA`).
* A 007 **não escreve** em vendas, saídas, razão, reposições nem produtos (o `estatico.js`
  reprova se escrever).

### App (`index.html`)

* `caixaEsperadoPartes()` — a única conta de caixa acumulado do app; o Financeiro passou a
  usá-la (o número dele não mudou: 228 casos antigos seguem verdes).
* Card no Financeiro: caixa esperado agora, última conferência válida (data/hora, real,
  diferença, "Confere"/"Existe diferença"), botão **Conferir caixa**, histórico com filtro por
  período (tabela no desktop, cartões no celular), invalidadas visíveis com motivo.
* Modal: consulta o esperado **no servidor**, pede "Quanto existe realmente agora?", observação
  opcional, prévia com esperado/real/diferença e frase em português. O esperado gravado é o
  que o banco calcular na hora de confirmar; se mudou desde a prévia, o aviso diz.
* Tudo em **centavos inteiros**.
* **Offline:** recusa com "A conferência de caixa precisa de conexão para comparar com o saldo
  atual do sistema." Não usa a fila offline nem o caixa da cópia local.

## 3. Testes

* `test/conferencia.test.js` — 22 casos (app): fórmula com fixture onde cada fórmula errada
  provável dá outro número, −R$ 3,49 dos dados de 15/09, leitura pt-BR, formatação, prévia
  (igual, falta, sobra, 0,01, 0,10, 100,01, negativo, erros de ponto flutuante), parâmetros
  enviados, adoção da foto do servidor, retry com mesmo op_id, clique duplo, recusa do
  servidor, valor inválido, não altera nada, foto no histórico, histórico com divergência e
  invalidada + filtro, invalidar, offline, rede caindo, fila offline intocada, carga falhando.
* `test/estatico.js` — checagem `CONFERENCIA DE CAIXA` sobre o texto da 007 e a chamada do app.
* `test/sql/conferencia_caixa.test.sql` + `node test/sql/montar.js` — **SQL real no Supabase**,
  numa transação que termina desfeita: estrutura e privilégios, anon, intruso, Victor (igual,
  falta, sobra, 0,01, 0,10, 3 casas recusadas), idempotência, não altera caixa/vendas/saídas/
  razão/estoque, auditoria, gravação direta recusada, **Stefany com payload "Victor"**, `p_usuario`
  e `p_saldo_esperado` inexistentes, foto que não muda quando entra uma saída, esperado
  **−3,49** forçado, invalidação, imutabilidade até para o dono do banco, convenção pelo
  `check`. **Ainda não rodado: depende do login.**
* Suíte: **228 → 250**, todos verdes.

### Mutantes

| # | pedido | app (harness) | banco (SQL real) |
|---|---|---|---|
| M1 | diferença = esperado − real | CX-M1 **morto** | SM1 — pendente de rodar |
| M2 | cliente manda o esperado | CX-M2 **morto** | SM2 — pendente |
| M3 | retry cria segunda | CX-M3 **morto** | SM3 — pendente |
| M4 | Stefany assina como Victor | CX-M4 **morto** (autor no payload) | SM4 — pendente |
| M5 | histórico recalcula | CX-M5 **morto** | SM5 — pendente |
| M6 | erro de centavos | CX-M6 **morto** (depois de acrescentar 19,99 / 0,29 / 1,15 / 4,35 — com 100,01 ele sobrevivia, porque 100.01×100 é exato em ponto flutuante) | SM6 — pendente |
| M7 | registrar altera o caixa | CX-M7 **morto** | SM7 — pendente |
| M8 | offline usa saldo antigo | CX-M8 **morto** | não se aplica (é do app) |

Suíte inteira: **23 mutantes, 23 mortos** (8 do razão, 7 da fila, 8 da conferência). O
`estatico.js` sozinho também reprova SM1, SM2, SM3, SM4, SM5 e SM7 pelo texto; SM6 só o SQL
rodando pega.

### Navegador (Chromium, localhost, RPC simulada — nada chegou ao Supabase)

Fluxo completo (abrir, prévia −3,49 × 1.250,00 = +1.253,49, confirmar, parâmetros enviados
só `p_saldo_real:"1250.00"`, `p_observacao`, `p_op_id`, linha nova no histórico), recusa
offline sem chamada, 360/390/430 px sem rolagem lateral (histórico em cartões, modal e botões
dentro da tela), desktop com tabela.

## 4. Falta para publicar

1. `DEPENDE DO VICTOR — autenticar Supabase para reconciliação` (login feito por ele).
2. Ler os canônicos **antes** (Conta Victor, estoque, CMV, caixa, vendas, clientes,
   financeiro, reposições) e anotar `vsp_ator()`, os tipos de `vendas.liq`/`saidas.val` e se
   alguma linha tem mais de 2 casas.
3. Rodar `controle.sql` (esperado: 0 falhas) e `SM1..SM7.sql` (esperado: cada um ≥ 1 falha).
4. Aplicar a 007, rodar `controle.sql` de novo contra a 007 aplicada.
5. Ler os canônicos **depois** — têm de ser iguais.
6. Publicar o app e validar em produção.
7. `DEPENDE DO VICTOR — primeira conferência de caixa real`.
