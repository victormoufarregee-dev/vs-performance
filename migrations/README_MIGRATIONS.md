# VS Performance — migrations SQL (Supabase / PostgreSQL)

Escritas a partir de `ATUALIZACAO_v4.sql`, de `ESQUEMA_COMPLETO_BANCO.sql`
(está dentro de `VS_PERFORMANCE_v4_1.zip`, não solto na pasta) e das funções
`regVenda`, `confReposicao`, `cancelarVenda`/`confirmarCancelamento`,
`estornarCompra`, `confEntrada`, `confirmarQuitar`, `regSaida`, `delSaida` e
`delCli` do `index.html`.

Banco em produção com dado real: **65 vendas, 21 clientes, 23 saídas,
5 reposições, 2 produtos**. Nada aqui apaga ou corrige registro.

---

## Ordem de aplicação

| # | Arquivo | Muda dado? | Pode travar o app? |
|---|---------|-----------|--------------------|
| 0 | `000_preflight.sql` | não (só SELECT) | não |
| 1 | `001_integridade.sql` | não (só schema) | não |
| 2 | `002_idempotencia.sql` | não (só schema) | não |
| 3 | `003_rls.sql` | não | **sim — leia antes** |
| 4 | `004_rpc_operacoes.sql` | não (só cria funções) | não |
| 5 | `005_ator_da_sessao.sql` | não (só cria função) | não |
| 6 | `006_ledger_victor.sql` | **sim — cria o razão e roda o backfill** | não |
| 7 | `007_conferencia_caixa.sql` | não (tabela nova, vazia) | não |
| 8 | `008_integridade_razao_caixa.sql` | não (triggers e funções; não reescreve linha) | não — editar valor/data de saída `fornecedor` passa a ser recusado (exclua e lance de novo) |
| 9 | `009_backfill_fechado.sql` | não (só permissão) | não — `vsp_ledger_backfill()` deixa de ser executável pela API |
| 10 | `010_grants_minimos.sql` | não (só permissão) | não — `anon` perde tudo e `authenticated` fica no mínimo; a RPC não muda |
| 11 | `011_derivados_no_banco.sql` | não (só funções e permissão) | **sim — leia antes**: o app antigo quita fiado por `PATCH` em `vendas`, e o `UPDATE` amplo sai. Aplique junto com o `index.html` desta rodada |

> **Desde 17/09/2026 estes arquivos representam o banco de PRODUÇÃO** (mesma convenção do
> commit `095bcca`, que alinhou a 006). As funções foram copiadas de `pg_proc.prosrc` e
> conferidas por md5. `node test/estatico.js` reprova se o texto divergir da foto de produção
> (`test/sql/contrato_producao.json`). Ao mudar uma função no banco, mude o arquivo **e**
> atualize a foto (`node test/sql/contrato.js --sql`). O rascunho antigo da 004, que nunca
> rodou, está em `historico/` — **não aplicar**. Detalhes: `APLICADO.md`, seção
> "Drift 004 × produção".

**Pré-requisito:** o `ATUALIZACAO_v4.sql` tem de já estar aplicado. Estas
migrations partem do schema dele (`produtos.preco_padrao`,
`produtos.estoque_minimo`/`estoque_critico`, `reposicoes.frete`,
`vendas.vence_em`, colunas novas de `config`, tabela `backups`). Se aparecer
`column ... does not exist`, rode o `ATUALIZACAO_v4.sql` primeiro — ele é
aditivo e pode rodar de novo sem risco.

Rode **um por vez**, no SQL Editor do Supabase (New query → colar o arquivo
inteiro → Run), e leia o resultado antes de passar para o próximo. Todos são
idempotentes: rodar duas vezes não duplica nem quebra nada.

Entre o 002 e o 003 é bom mandar o app fazer um backup
(Config → "Gravar cópia na nuvem agora") e baixar o arquivo.

---

## 000_preflight.sql — diagnóstico

Somente `SELECT`. Procura tudo que violaria as regras planejadas:
estoque negativo, valores negativos, `vendas.cli_id` órfão, `vendas.prod` e
`reposicoes.prod` órfãos, NULL em coluna que vira `NOT NULL`, duplicata que
impediria `UNIQUE`, e as contagens de conferência.

**Como rodar:** cole o arquivo inteiro e rode. O diagnóstico é um único
`SELECT` de propósito — o SQL Editor mostra só o resultado do último comando.

**Como ler o resultado:**

- `registros` = quantas linhas já existentes estão naquele estado.
- `efeito`:
  - **BLOQUEIA** — a constraint não vai validar. O 001 cria ela como
    `NOT VALID`: protege toda gravação nova e não reprova o passado.
    O dado antigo continua como está até alguém decidir.
  - **ATENCAO** — não bloqueia, mas muda comportamento do app.
  - **INFO** — conferência.
- Todas as linhas **BLOQUEIA** com `registros = 0` → o 001 entra limpo.
- Confira as linhas 90 a 94 contra 2 / 65 / 21 / 23 / 5. Se não bater, você
  está em outro projeto Supabase ou já houve gravação depois do levantamento.
- Linha **53** é a mais importante: é a contagem de clientes que deixam de
  poder ser apagados (ver DECISÃO 3).

No fim do arquivo há consultas de detalhamento **comentadas** (quais vendas
estão órfãs, quais clientes travam, foto do estoque antes de mexer).
Descomente uma por vez quando algum BLOQUEIA vier maior que zero.

**Reverter:** nada a reverter, não escreve nada.

---

## 001_integridade.sql — constraints

- `CHECK` de não-negatividade: `produtos.caixas/frascos/custo_caixa/custo_frasco/preco_padrao`,
  `vendas.qtd > 0` e valores ≥ 0, `vendas.taxa` entre 0 e 100,
  `saidas.val ≥ 0`, `reposicoes.qtd > 0` e custos/frete ≥ 0,
  `produtos.frascos_por_caixa ≥ 1` (é divisor do custo médio).
  `lucro_liq` e `margem` ficam **sem** constraint: prejuízo negativo é legítimo.
- `FK` com **ON DELETE RESTRICT** (nunca CASCADE em dado financeiro):
  `vendas.prod` e `reposicoes.prod` → `produtos.id`; `vendas.cli_id` → `clientes.id`.
- `NOT NULL` só onde é seguro, e **só se não houver NULL** na coluna. Se houver,
  a migration **pula e avisa** em vez de inventar valor.
- `DEFAULT` onde o app já grava sempre o mesmo (desconto 0, taxa 0,
  `taxa_quem` 'nos', `quitado`/`cancelada` false, `frete` 0, `audit_log.ts` now()).
- Índices que as novas regras precisam (`vendas(cli_id)`, `vendas(prod, data)`).

**Não corrige dado.** Se houver violação, a constraint entra como `NOT VALID`:
vale para gravação nova, não reprova o histórico. Depois de o responsável
decidir o que fazer com a linha antiga:

```sql
alter table public.<tabela> validate constraint <nome>;
```

Os dois últimos itens do arquivo: um `SELECT` de conferência com o estado de
cada constraint (`OK` / `NOT VALID` / `FALTANDO`) — **leia esse resultado** —
e o rollback completo comentado.

**Reverter:** descomente o bloco final do arquivo (uma linha
`alter table ... drop constraint if exists ...` por constraint).

---

## 002_idempotencia.sql — `op_id`

Adiciona `op_id text` (nullable) em `vendas`, `saidas`, `reposicoes` e
`clientes`, com índice único **parcial** (`where op_id is not null`) e um
`CHECK` que proíbe `op_id` vazio.

Por que nullable: as 65 vendas / 21 clientes / 23 saídas / 5 compras que já
existem não têm `op_id` e nunca vão ter. O índice parcial nem indexa elas.

Por que isso importa: o app é PWA com fila offline (`enviarFila`). Perder o
sinal no meio do POST pode gravar a venda e o app achar que falhou — e
reenviar, dobrando venda e baixa de estoque.

**O 002 sozinho não protege nada.** Quem gera o `op_id` é o app, uma vez por
formulário, reusando o mesmo valor em todo retry (ver DECISÃO 8).

**Reverter:** `drop index` dos quatro `uq_*_op_id` (inofensivo). Derrubar as
colunas também é possível, mas o 004 usa `vendas.op_id` e `reposicoes.op_id` —
derrube as funções primeiro. Rollback comentado no fim do arquivo.

---

## 003_rls.sql — substitui a policy permissiva

Hoje cada tabela tem `for all to authenticated using (true) with check (true)`:
qualquer conta autenticada no projeto pode ler, gravar, alterar e **apagar**
tudo, inclusive vendas e a própria auditoria.

Depois: tabela `usuarios_autorizados(uid, nome, ativo)` + função
`vsp_autorizado()`, e policy **por tabela e por comando**:

| tabela | comandos liberados |
|---|---|
| produtos | SELECT INSERT UPDATE |
| vendas | SELECT INSERT UPDATE — **sem DELETE** (venda se cancela) |
| clientes | SELECT INSERT UPDATE DELETE |
| saidas | SELECT INSERT UPDATE DELETE |
| reposicoes | SELECT INSERT UPDATE DELETE |
| audit_log | **SELECT INSERT só** — sem UPDATE, sem DELETE |
| config | SELECT UPDATE |
| backups | SELECT INSERT DELETE |
| estoque (legada) | SELECT |

DELETE ficou só em `saidas`, `reposicoes`, `backups` e `clientes` — exatamente
os quatro `sbDelete` que existem no `index.html`. Além da policy, o arquivo
também faz `REVOKE` do privilégio de DELETE em `vendas` e de UPDATE/DELETE em
`audit_log`, para que um `drop policy` acidental amanhã não reabra o buraco.

### Este arquivo roda em DUAS passadas

1. **Primeira passada:** cria a allowlist e **para com erro**, porque ela está
   vazia. Aplicar as policies com allowlist vazia trancaria você fora do banco.
   Nada nas policies é alterado nessa passada.
2. **Popular a allowlist** (seção 2 do arquivo, comentada): rode
   `select id, email from auth.users ...`, copie os UUID reais e insira.
   **Não há UUID inventado no arquivo e não deve haver.**
3. **Segunda passada:** rode o arquivo inteiro de novo. Agora ele aplica as
   policies e imprime a tabela de conferência (seção 7) — confira contra a
   tabela acima, com `rls_ligada = true` e `permissiva_antiga = 0` em todas.

Depois de aplicar: saia e entre de novo no app, e use
Config → "Testar segurança do banco" e Config → "Diagnóstico da nuvem".

**Reverter:** o topo do arquivo tem o rollback comentado, pronto para colar —
ele derruba as policies granulares, devolve os GRANTs e recria a policy
permissiva antiga. Emergência total (último recurso):
`alter table public.<tabela> disable row level security;`

Para tirar o acesso de alguém sem apagar histórico:
`update public.usuarios_autorizados set ativo = false where nome = '...';`

---

## 004_rpc_operacoes.sql — operações transacionais

Quatro funções `security definer` com `set search_path = public, pg_temp`.
Cada uma faz a operação inteira — registro + estoque + auditoria — em **uma**
transação, e grava a linha de auditoria dentro dela (no app de hoje o
`audit()` é uma chamada HTTP separada com `catch` vazio: se falha, a venda
entra sem rastro).

- **`vsp_registrar_venda`** — insere a venda e baixa o estoque no mesmo
  `UPDATE`, com a guarda no `WHERE`
  (`... set caixas = caixas - n where id = p and caixas >= n`). Sem saldo, erro
  claro dizendo quanto tem e quanto foi pedido. Venda de frasco abre caixa com
  a mesma conta do app, também em um statement só. Respeita `op_id`: se já
  existe, devolve a venda existente (`duplicada: true`) e **não** baixa estoque
  de novo — inclusive na corrida entre dois envios simultâneos.
- **`vsp_registrar_compra`** — insere a reposição, soma o estoque e recalcula o
  custo médio ponderado no banco, com a fórmula **idêntica** à de
  `confReposicao`: valor anterior = `caixas × custo_caixa + frascos × custo_frasco`;
  novo custo do frasco = `(valor anterior + qtd × custo_unit + frete) ÷
  (unidades anteriores + unidades novas)`; `custo_caixa` = custo do frasco
  **sem arredondar** × `frascos_por_caixa`, cada um arredondado uma única vez.
  Lê o produto com `FOR UPDATE` — sem isso, duas compras simultâneas leem o
  mesmo "valor anterior" e uma delas desaparece da média. Idempotente por `op_id`.
- **`vsp_cancelar_venda`** — marca cancelada e devolve o estoque com a mesma
  normalização do app (frasco que completa caixa volta a virar caixa).
  Idempotente pelo próprio campo `cancelada`. Sobre custo, ver DECISÃO 6.
- **`vsp_estornar_compra`** — espelha `estornarCompra`, inclusive a guarda
  `podeRecalcular` (só recalcula o custo se **nenhuma** venda daquele produto
  aconteceu a partir da data da compra, e se sobram unidade e valor), o
  bloqueio quando parte da compra já foi vendida, e a exclusão da saída
  pareada no Financeiro (`saidas.id = reposicoes.id + 1`, tipo fornecedor,
  valor igual a menos de 1 centavo).

Todas conferem a allowlist do 003 por conta própria — `security definer` passa
por cima da RLS, então sem essa checagem elas seriam um buraco. `EXECUTE` é
revogado de `public` e concedido só a `authenticated`, para a chave anon não
operar o financeiro sem login.

O fim do arquivo tem o `SELECT` de conferência (4 funções, `definer = true`,
`search_path_fixo = true`, `executa_anon` nunca true), um exemplo de chamada
do app (`sbRpc`) e um teste manual dentro de `begin; ... rollback;`.

**O 004 não muda o app sozinho** — enquanto o `index.html` não chamar as RPCs,
as funções ficam paradas no banco sem efeito nenhum (ver DECISÃO 7).

**Reverter:** `drop function if exists ...` com a assinatura completa
(rollback comentado no fim do arquivo). Não toca em dado. Se o `index.html` já
estiver usando as RPCs, reverta o app **antes**.

---

## O que o operador precisa decidir antes de aplicar

1. **Ponto de retorno.** Fazer backup (Config → gravar cópia na nuvem + baixar) e, de preferência, testar tudo num projeto Supabase de cópia antes da produção.
2. **Dado que o preflight marcar BLOQUEIA:** deixar a constraint `NOT VALID` (protege só o futuro) ou corrigir a linha antiga à mão e depois `validate constraint`. A migration nunca corrige por conta própria.
3. **FK `vendas.cli_id` (a mais impactante):** com `ON DELETE RESTRICT`, o botão "remover cliente" (`delCli`) passa a **falhar** para quem tem venda — hoje ele apaga o cadastro mesmo com fiado em aberto. Alternativas no 001: `ON DELETE SET NULL` (mantém o botão, perde o vínculo) ou a coluna `clientes.ativo` para arquivar em vez de apagar.
4. **Domínios de texto** (`vendas.pgto`, `taxa_quem`, `saidas.tipo`, `saidas.pgto`) vêm **comentados**: travar engessa o app se amanhã surgir uma forma de pagamento nova. Decidir se descomenta.
5. **Contas em `auth.users`:** se houver mais de duas, decidir quem entra na allowlist — quem ficar de fora perde o acesso na hora em que o 003 for aplicado.
6. **`vsp_cancelar_venda` e o custo:** o padrão (`p_recalcular_custo = false`) devolve só a quantidade, igual ao app de hoje. Em `true`, devolve também o valor usando o **custo histórico gravado na venda** — mais correto contabilmente, mas muda o custo médio atual dos produtos.
7. **Adotar as RPCs no `index.html`:** decidir se e quando trocar os `sbPost + sbPatch + audit` por uma chamada `sbRpc`. Sem isso o 004 fica inerte.
8. **Gerar `op_id` no app:** um por formulário, reusado em todo retry. Se o app gerar um novo a cada tentativa, o 002 não protege nada.
9. **Cortar a role `anon`** de todas as tabelas (bloco opcional no 003): mais seguro, mas muda a mensagem de erro do "Testar segurança do banco".
10. **Fuso horário:** as RPCs gravam `display`/`cancelada_em` em `America/Sao_Paulo` (o banco roda em UTC e essas colunas são texto). Confirmar que é o fuso da operação.
