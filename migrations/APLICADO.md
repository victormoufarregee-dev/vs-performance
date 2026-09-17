# Migrations aplicadas na produção — 15/09/2026 a 17/09/2026

> Desde 17/09/2026 os arquivos em `migrations/` representam o banco de produção (ver a
> última seção, "Drift 004 × produção"). O texto das seções abaixo é o registro de cada
> etapa no dia em que foi aplicada.

Projeto Supabase `sfgpwunpcrigdhlgrgdq` (vs-performance). Aplicado pelo SQL Editor,
com validação e reconferência dos números canônicos após cada etapa.

## Preflight — nenhuma violação bloqueante

43 checagens, todas somente leitura. **Zero** registros incompatíveis com as constraints
planejadas: sem estoque negativo, sem valor negativo, sem FK órfã, sem nulo em coluna-chave,
sem domínio inválido em `pgto` ou `saidas.tipo`.

Um achado de atenção, tratado sem alterar dado:

> **Dois clientes reais com o mesmo telefone** — `Stefany de Souza Silva` (1780038994785) e
> `Roberto peixinho` (1782149352594), ambos com `35992745598`. São pessoas diferentes.
> **Nenhum UNIQUE foi criado em `clientes.tel`**, porque compartilhar número é legítimo.
> A tela passou a perguntar em vez de fundir cadastros (commit `00a6f78`).

## 001 — Integridade ✅

- 15 CHECK constraints de não-negatividade em `produtos`, `vendas`, `saidas`, `reposicoes`
- 3 FKs, todas `ON DELETE RESTRICT`, todas validadas:
  `vendas.prod → produtos`, `reposicoes.prod → produtos`, `vendas.cli_id → clientes`
- `NOT NULL` em `produtos.nome`, `vendas.data`, `saidas.data`, `reposicoes.data`
- Coluna `clientes.ativo boolean not null default true` — inativação em vez de exclusão

## 002 — Idempotência ✅

Coluna `op_id text` + índice único parcial (`where op_id is not null`) + CHECK contra vazio,
em `vendas`, `saidas`, `reposicoes`, `clientes`.

**Testado em transação revertida:** 1ª gravação passa · 2ª com o mesmo `op_id` é recusada
pelo banco · `op_id` em branco é recusado.

## 003 — RLS por allowlist ✅

Tabela `usuarios_autorizados(uid, nome, ativo)` populada a partir de `auth.users` (2 contas
reais, nenhum uid digitado à mão). Função `vsp_autorizado()` — `stable security definer`,
`search_path = public, pg_temp`.

As 10 policies `vsp_auth_*` ("qualquer autenticado pode tudo") foram substituídas por policy
dedicada por tabela e por comando:

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| produtos | ✅ | ✅ | ✅ | — |
| vendas | ✅ | ✅ | ✅ | — (cancelamento é UPDATE) |
| clientes | ✅ | ✅ | ✅ | — (inativação) |
| saidas | ✅ | ✅ | ✅ | ✅ |
| reposicoes | ✅ | ✅ | ✅ | ✅ |
| audit_log | ✅ | ✅ | — | — |
| config | ✅ | — | ✅ | — |
| backups | ✅ | ✅ | — | ✅ |
| usuarios_autorizados | ✅ | — | — | — |

**Validação com três perfis**, simulando o JWT de cada um:

| Perfil | Resultado |
|---|---|
| Victor (allowlist) | 65 vendas, 21 clientes |
| Stefany (allowlist) | 65 vendas |
| Victor tentando `delete` em venda | nada apagado |
| Victor tentando `update` em auditoria | nenhuma linha afetada |
| Autenticado fora da allowlist | 0 vendas, 0 clientes, 0 saídas |
| Anônimo (chave pública) | leitura vazia; `DELETE` em massa não apagou nada |

Login real dos dois donos confirmado funcionando após a troca.

## 004 — Operações transacionais ✅

Cinco funções `security definer` com `set search_path = public, pg_temp`, todas validando
autorização pela allowlist, exigindo `op_id`, idempotentes, e gravando a auditoria dentro
da própria transação:

| Função | O que faz numa transação só |
|---|---|
| `vsp_registrar_venda(jsonb, text)` | grava a venda + baixa o estoque com trava + audita |
| `vsp_registrar_compra(jsonb, text)` | grava a reposição + soma estoque + recalcula custo médio + audita |
| `vsp_cancelar_venda(bigint, text, text, text)` | marca cancelada + devolve estoque pelo **custo histórico da venda** + audita |
| `vsp_estornar_compra(bigint, text, text)` | apaga a reposição + devolve estoque + preserva custo se houve venda depois + remove a saída ligada + audita |
| `vsp_autorizado()` | allowlist de uid, usada por todas as policies e RPCs |

O decremento de estoque tem a guarda no próprio `UPDATE` (`where caixas >= qtd`): sem saldo,
nenhuma linha é afetada e a transação inteira é desfeita.

### Teste de concorrência real

Duas conexões independentes (duas abas do SQL Editor), produto isolado `ZZ_TESTE_CONC`.
A conexão A trava a linha do produto e segura por 12 s dentro da mesma transação; a conexão B
dispara no meio da janela — foi confirmado pelo carimbo de tempo que B partiu 8,7 s depois
de A, com A ainda dentro da janela.

**Cenário 1 — estoque inicial 1, Victor e Stefany disputando a última caixa:**

| Verificação | Exigido | Obtido |
|---|---|---|
| Vendas criadas | 1 | **1** (Victor) |
| Operações recusadas | 1 | **1** (Stefany — `estoque insuficiente`) |
| Estoque final | 0 | **0** |
| Estoque negativo | nenhum | **nenhum** |
| Venda duplicada | nenhuma | **nenhuma** |
| `op_id` duplicado | nenhum | **nenhum** |
| Efeito financeiro duplicado | nenhum | **nenhum** |

**Cenário 2 — estoque inicial 2, duas vendas simultâneas:**

| Verificação | Exigido | Obtido |
|---|---|---|
| Vendas aprovadas | 2 | **2** |
| Estoque final | 0 | **0** |
| Comportamento de B | não pode ser recusada por engano | **esperou 4,8 s na trava e vendeu** |

Cenário limpo depois: 0 produtos de teste, 0 vendas de teste, 0 linhas de auditoria de teste.

### Outros testes da RPC (em transação revertida)

| Caso | Resultado |
|---|---|
| Venda normal | estoque 8 → 7 |
| Retry com o mesmo `op_id` | `repetida=true`, 1 venda gravada, estoque não baixa de novo |
| Venda de 999 caixas (há 8) | recusada, estoque intacto |
| Chamada por usuário fora da allowlist | recusada (`nao autorizado`) |
| Auditoria | gravada pelo servidor, dentro da transação |

### Frontend migrado

`regVenda`, `confReposicao`, `confirmarCancelamento` e `estornarCompra` passaram a chamar
exclusivamente as RPCs via `sbRpc()`, com `op_id` gerado por `novoOpId()` e **reusado no
retry** — é isso que faz o retry ser seguro. O app não mexe mais em estoque nem em custo
por conta própria: adota o estado canônico devolvido pelo banco. Cada operação tem trava
de duplo clique.

**Caminho antigo removido**, não apenas desativado: não existe mais `sbPost('vendas')`,
`sbPost('reposicoes')`, `sbDelete('reposicoes')` nem o patch de cancelamento no arquivo.
`test/estatico.js` falha se qualquer um deles voltar, e também se alguma das quatro RPCs
deixar de ser chamada.

## 005 — Auditoria de segurança das SECURITY DEFINER ✅

Auditoria função por função das 5 RPCs.

**O que já estava correto:**

| Item | Resultado |
|---|---|
| `search_path` | `public, pg_temp` explícito nas 5 |
| Dono | `postgres` |
| `EXECUTE` | só `authenticated` e `service_role` |
| `PUBLIC` | **sem permissão** |
| `anon` | **sem permissão** |
| Autorização interna | `vsp_autorizado()` em todas, por `auth.uid()` |
| SQL dinâmico | nenhum nas RPCs de negócio |
| Injeção por parâmetro | não há concatenação de SQL; tudo por bind |

### 🔴 Vulnerabilidade encontrada e corrigida: impersonação do ator

As RPCs gravavam o **nome do usuário enviado pelo frontend** — `p_venda->>'usuario'`,
`p_rep->>'usuario'`, `p_usuario` — tanto em `vendas.usuario` e `vendas.cancelada_por`
quanto em `audit_log.usuario`.

**Explorável, e provado:** Stefany, autenticada com o token dela, enviou `usuario: 'Victor'`
no payload. O banco gravou **"Victor"** na venda e na auditoria.

Impacto: a auditoria existe para dar transparência entre os dois sócios, e qualquer um deles
podia assinar no nome do outro. A atribuição "quem vendeu" do Fechamento também era forjável.

**Correção:** função `vsp_ator()` (`stable security definer`, `search_path` fixo) que resolve
o nome a partir de `auth.uid()` na allowlist. As 4 RPCs passaram a usá-la; o nome vindo do
payload é **ignorado** — o parâmetro `p_usuario` continua na assinatura por compatibilidade,
mas não tem efeito.

**Prova depois da correção**, mesma transação revertida:

> Sessão real = Stefany. Payload mandou Victor em tudo.
> `[vendas.usuario=Stefany]` `[audit_log.usuario=Stefany]` `[cancelada_por=Stefany]`
> **VEREDITO: BLOQUEADO em todos os 3 — a sessão manda**

### Validações de entrada acrescentadas

`tipo` fora de (`caixa`,`frasco`), `qtd <= 0` ou nula, `cust_unit <= 0`, `frete < 0`,
`op_id` vazio, `id` nulo, produto inexistente — todas com mensagem clara e sem vazar
estrutura interna.

## Números canônicos — reconferidos direto no banco após cada etapa

| Indicador | Baseline | Depois de 001/002/003/004 |
|---|---|---|
| Dívida com Victor | R$ 5.758,30 | R$ 5.758,30 |
| Estoque | R$ 4.660,00 | R$ 4.660,00 |
| CMV | R$ 23.539,30 | R$ 23.539,30 |
| Caixa | −R$ 3,49 | −R$ 3,49 |
| Vendas / clientes / saídas / reposições | 65 / 21 / 23 / 5 | 65 / 21 / 23 / 5 |

## Rollback

```sql
-- RLS: volta à policy permissiva (use só em emergência)
-- do $$ declare t text; begin
--   foreach t in array array['produtos','vendas','clientes','saidas','reposicoes','audit_log','config','backups'] loop
--     execute format('drop policy if exists vsp_select_%s on public.%I', t, t);  -- idem insert/update/delete
--     execute format('create policy vsp_auth_%s on public.%I for all to authenticated using (true) with check (true)', t, t);
--   end loop; end $$;
```

Backup diário automático do Supabase cobre o pior caso (8 cópias, 08/09 a 15/09).

## 007 — Conferência de Caixa ✅ (17/09/2026)

Aplicada pelo SQL Editor depois de ensaiada no próprio banco, em transação desfeita.

### Canônicos — antes, depois do ensaio e depois de aplicar

| Indicador | Antes | Depois de aplicar |
|---|---|---|
| Conta do Victor (`vsp_saldo_victor`) | R$ 5.758,30 | R$ 5.758,30 |
| Estoque | R$ 4.660,00 (TG 8 cx, RETA_VERDE 0) | idem |
| CMV | R$ 23.539,30 | R$ 23.539,30 |
| Caixa (recebido − saídas) | −R$ 3,49 (51.066,00 − 51.069,49) | −R$ 3,49 (`vsp_caixa_esperado_calc()` = −3,49) |
| Vendas / canceladas / clientes / saídas / reposições | 65 / 5 / 21 / 23 / 5 | 65 / 5 / 21 / 23 / 5 |
| Reposições (total) / receita bruta / fiado aberto | 19.065,00 / 51.066,00 / 0,00 | idem |
| Razão do Victor / auditoria | 21 / 263 | 21 / 263 |
| md5 de vendas, saídas, clientes, reposições, produtos, ledger_victor, config | registrados | **idênticos** |
| Conferências | — | 0 (nenhuma criada; a primeira é do Victor) |

Colunas `vendas.liq` e `saidas.val` são `numeric`; nenhuma linha com mais de 2 casas.

### Achado no ensaio: auxiliares do arquivo 004 não existem no banco

`vsp_brl`, `vsp_audit`, `vsp_novo_id`, `vsp_display`, `vsp_uid` e `vsp_exige_autorizacao`
estão em `migrations/004_rpc_operacoes.sql`, mas **não existem em produção** — as RPCs reais
gravam a auditoria com `insert` direto e usam `vsp_autorizado()`/`vsp_ator()`. A primeira
versão da 007 chamava `vsp_brl` e falhou no ensaio (desfeito, nada aplicado). A 007 passou a
ter auxiliares próprios e privados (`vsp_cc_brl`, `vsp_cc_audit`), e o `test/estatico.js`
reprova a 007 se ela voltar a chamar algum dos inexistentes. **O arquivo 004 continua
divergente do banco** — registrado como risco, não corrigido nesta etapa.

`vsp_ator()` em produção: `coalesce((select nome from usuarios_autorizados where uid = auth.uid() and ativo), '(sessao desconhecida)')`.

### Testes em SQL real (`test/sql/conferencia_caixa.test.sql`, 35 verificações)

| Rodada | Resultado |
|---|---|
| Controle, antes de aplicar (migration + testes, desfeito) | **35 ok, 0 falhas** |
| Controle, contra a 007 aplicada (só testes, desfeito) | **35 ok, 0 falhas** — 0 conferências e auditoria 263 depois |

Cobre: assinatura só com saldo real/observação/op_id; `SECURITY DEFINER` + `search_path` nas 4
funções; anon sem `EXECUTE` e sem `SELECT`; conta interna fechada; RLS ligada; intruso logado
fora da allowlist recusado e sem ver linhas; Victor igual (0), falta (−50,00), sobra (+50,00),
−0,01, +0,10, 3 casas recusadas; mesmo op_id devolve a primeira (1 linha); registrar não muda
caixa, vendas, saídas, razão, saldo do Victor nem estoque; auditoria com o ator da sessão;
insert/update direto recusados; **Stefany com observação "Victor" grava Stefany**; `p_usuario` e
`p_saldo_esperado` não existem; foto não muda quando entra uma saída; esperado forçado a −3,49
com real 0 → +3,49; invalidação exige motivo, preserva números, é idempotente e auditada; o dono
do banco não reescreve, não apaga e não "desinvalida"; `check` recusa diferença fora da convenção.

Pela API pública, sem login: `vsp_caixa_esperado`, `vsp_caixa_esperado_calc`,
`vsp_registrar_conferencia_caixa`, `vsp_invalidar_conferencia_caixa` e `vsp_cc_audit` →
`42501 permission denied`; `conferencias_caixa` → `42501`; chamada com `p_saldo_esperado` →
`PGRST202` (a função não aceita esse parâmetro).

### Mutantes em SQL real (cada um: migration mutada + testes, desfeito)

| Mutante | Resultado | Quem matou |
|---|---|---|
| SM1 diferença = esperado − real | **morto** (28 ok, 7 falhas) | T22 falta virou +50,00; T23… |
| SM2 cliente manda o esperado | **morto** (32 ok, 3 falhas) | T01 assinatura; **T42 esperado ditado = 1,00** |
| SM3 retry cria segunda | **morto** (34 ok, 1 falha) | T27 `n=2` |
| SM4 Stefany assina como Victor | **morto** (32 ok, 3 falhas) | T01; **T41 "IMPERSONACAO: Stefany gravou como Victor"** |
| SM5 foto recalcula | **morto** (31 ok, 4 falhas) | T50 foto foi a −13,49; T70–T72 |
| SM6 centavos | **morto** (27 ok, 8 falhas) | T21 esperado −3,00 no lugar de −3,49; T24… |
| SM7 registrar "ajusta" o caixa | **morto** (30 ok, 5 falhas) | T23 esperado foi de −3,49 a −53,49 |

Duas rodadas iniciais de SM1/SM2 e uma de SM7 morreram por **quebra do script** (literal sem
tipo em `text[] ||`; consulta de assinatura inexistente; saída negativa barrada por
`chk_saida_val`) — não contaram como prova. O teste e o SM7 foram corrigidos e as três
rodaram de novo, mortas por comportamento. O controle foi repetido depois da correção: 35/0.

## Drift 004 × produção — fechado em 17/09/2026

**Pergunta:** reconstruindo a partir do repositório, as migrations levam ao mesmo contrato
de banco que está em produção? **Antes: não. Agora: sim para as funções (provado por md5 e
por reconstrução no banco); para tabelas, índices, constraints, policies e view, conferido
por catálogo (listas abaixo).**

### Método

1. Inventário de `pg_proc` (17 funções `vsp_*`: assinatura, linguagem, `SECURITY DEFINER`,
   volatilidade, `search_path`, dono, ACL, md5 de `prosrc`) e dos catálogos de índice,
   constraint, policy, RLS, trigger, view e grants.
2. Corpos reais extraídos em **base64** (a grade do SQL Editor colapsa espaços) e conferidos
   por md5 antes de entrar em arquivo — nenhuma linha de SQL foi redigitada.
3. `test/sql/contrato.js` extrai o contrato das migrations (última definição vence, `drop`
   respeitado) e compara com a foto `test/sql/contrato_producao.json`.
4. **Reconstrução controlada** (`test/sql/reconstrucao.js`): os 17 `create or replace` saídos
   das migrations rodados no banco numa transação que termina desfeita, conferindo lá dentro
   md5 e `xmin` → **17 conferidas, 17 reescritas por esta transação, 0 divergentes**. Controle
   negativo (um espaço a mais em `vsp_saldo_victor`) → **acusou `vsp_saldo_victor()`**. Depois
   dos ensaios: 17/17 funções de produção inalteradas.
   Não existe PostgreSQL isolado disponível; nenhum DDL de tabela/policy foi ensaiado.

### Convenção adotada — Opção A (arquivo = o que está aplicado)

Precedente: commit `095bcca` ("Alinha a migration 006 com o que está aplicado no banco"),
com teste lendo o texto da migration para impedir deriva. Seguido aqui. O que nunca rodou
saiu da sequência numerada e ficou em
`historico/004_rpc_operacoes_RASCUNHO_NAO_APLICADO.sql`, com cabeçalho "NÃO APLICAR".
O corpo original das RPCs de 15/09 (antes da 005) não existe em lugar nenhum e **não foi
reconstruído** — a 004 traz o texto vigente e diz isso no cabeçalho.

### Matriz de drift (funções)

| Objeto | Repositório (antes) | Produção | Igual? | Explicação / o que foi feito |
|---|---|---|---|---|
| `vsp_uid()` | 004 | não existe | — | **rascunho nunca aplicado** → só no histórico |
| `vsp_exige_autorizacao()` | 004 | não existe | — | idem (as RPCs usam `vsp_autorizado()` da 003) |
| `vsp_brl(numeric)` | 004 | não existe | — | idem (a 007 usa `vsp_cc_brl`, privada) |
| `vsp_display()` | 004 | não existe | — | idem |
| `vsp_audit(text,text,text)` | 004 | não existe | — | idem (RPCs auditam com `insert` direto; a 007 com `vsp_cc_audit`) |
| `vsp_novo_id(text)` | 004 | não existe | — | idem |
| `vsp_registrar_venda` | 004, **19 parâmetros soltos** | `(p_venda jsonb, p_op_id text)` | não | **arquivo histórico incorreto** → 004 reescrita com o corpo real |
| `vsp_cancelar_venda` | 004, `(p_venda_id, p_motivo, p_usuario, p_recalcular_custo)` | `(p_id bigint, p_motivo text, p_usuario text, p_op_id text)` | não | idem |
| `vsp_estornar_compra` | 004, `(p_reposicao_id, p_usuario, p_excluir_saida)` | `(p_id bigint, p_usuario text, p_op_id text)` | não | idem |
| `vsp_registrar_compra` | 004 com **14 parâmetros**; 006 só "ver o corpo no banco" | `(p_rep jsonb, p_op_id text)`, grava débito no razão | não | **substituída pela 006 sem representação** → corpo real agora na 006 |
| `vsp_ator()` | **nenhum arquivo** | existe (15/09, etapa 005) | — | **produção sem Git** → novo `005_ator_da_sessao.sql` |
| `vsp_autorizado()` | 003 (`coalesce(u.ativo, false)`) | `... and ativo` | mesmo efeito, md5 diferente | 003 alinhada (ativo nulo continua não autorizando) |
| `vsp_saldo_victor()` | 006 (comentário dentro do corpo) | sem comentário | mesmo efeito, md5 diferente | 006 alinhada; comentário movido para fora |
| `vsp_ledger_backfill()` | 006 | comentários explicativos no corpo | mesmo efeito, md5 diferente | 006 alinhada |
| `vsp_reembolsar_victor(...)` | 006 | linhas em branco diferentes | mesmo efeito, md5 diferente | 006 alinhada |
| `vsp_ledger_estornar_origem(...)` | 006 | igual | **sim** | — |
| 7 funções da 007 | 007 | iguais | **sim** | 007 não mudou; SM1..SM7 e 35/0 seguem valendo |

Todas: `search_path = public, pg_temp`, dono `postgres`, sem `EXECUTE` para `anon`;
`SECURITY DEFINER` em todas exceto `vsp_cc_brl` e o trigger `vsp_cc_protege`. O trigger tem
`EXECUTE` para PUBLIC (padrão do Supabase), sem efeito: função de trigger não pode ser
chamada diretamente.

### Matriz de drift (demais objetos)

| Objeto | Repositório (antes) | Produção | Feito |
|---|---|---|---|
| Índices de idempotência (002) | `uq_<tabela>_op_id` | `ux_<tabela>_op_id` (parciais) | 002 alinhada |
| Checks de `op_id` vazio (002) | `ck_<tabela>_op_id_nao_vazio`, `length(btrim(op_id)) > 0` | `chk_<tabela>_op_id`, `btrim(op_id) <> ''` | 002 alinhada (mesma regra) |
| Comentários de coluna `op_id` (002) | `comment on column` | não existem | 002: virou comentário SQL |
| `usuarios_autorizados` (003) | `revoke insert, update, delete ... from authenticated, anon` | grants padrão do Supabase presentes | **drift aberto, anotado na 003**: proteção efetiva é a RLS (só policy de SELECT); nada mudado |
| Grants de tabela para `anon` (tabelas de negócio) | não descritos | grants padrão do Supabase | proteção pela RLS (policies só para `authenticated` + allowlist); anon lê vazio — provado pela API |
| `ledger_victor` (006): 5 checks, FK, `ux_lv_origem`, `ux_lv_op_id`, `idx_lv_data`, RLS, policies select/insert/update | 006 | iguais | — |
| `conferencias_caixa` (007): 6 checks, índices, trigger, RLS, policy, grants | 007 | iguais | — |
| **`v_ledger_victor` (006)** | `grant select to authenticated` | **SELECT para anon e sem `security_invoker`** | **vazamento corrigido em produção** (abaixo) e 006 alinhada |

### 🔴 Vulnerabilidade encontrada no inventário e corrigida: extrato do Victor público

A view `v_ledger_victor` rodava com as permissões da dona (`postgres`), que ignora RLS, e
`anon` tinha `SELECT` nela (grant padrão do Supabase para objeto novo). **Qualquer pessoa com a
chave pública — que está no `index.html` publicado — lia o extrato inteiro da Conta do Victor
pela API**, com valores e descrições; qualquer conta logada fora da allowlist também (21
linhas). Existia desde a 006 (16/09/2026). As tabelas não vazavam.

Correção autorizada pelo Victor em 17/09/2026:

```sql
alter view public.v_ledger_victor set (security_invoker = true);
revoke all on public.v_ledger_victor from public, anon;
grant select on public.v_ledger_victor to authenticated;
```

| Prova (`test/sql/view_ledger.test.sql`) | Antes | Ensaio (desfeito) | Depois de aplicar |
|---|---|---|---|
| Placar | **3 ok, 3 falhas** (sem security_invoker · anon leu · intruso viu 21) | 6 ok, 0 falhas | **6 ok, 0 falhas** |
| API pública sem login, `GET /v_ledger_victor` | extrato completo (200) | — | `42501 permission denied` (401) |
| Victor logado (simulado no banco) | 21 linhas | 21 | 21, saldo corrido final 5.758,30 |

O app lê o extrato com a sessão logada: nada muda para o Victor e a Stefany.

### Canônicos — antes e depois desta rodada

Conta do Victor 5.758,30 · estoque 4.660,00 (TG 8 cx) · CMV 23.539,30 · caixa −3,49 ·
vendas/canceladas/clientes/saídas/reposições 65/5/21/23/5 · razão 21 · conferências 0 ·
auditoria 263 · md5 de vendas, saídas, clientes, reposições, produtos, razão, config e
conferências — **idênticos antes e depois** (0 diferenças). Teste SQL da Conferência de Caixa
depois de tudo: **35 ok, 0 falhas**.

### Como evitar nova deriva

* `node test/estatico.js` → `CONTRATO DO BANCO`: reprova se o texto das migrations divergir
  da foto de produção, se o app chamar RPC que nenhuma migration cria, ou se a view do extrato
  perder `security_invoker` / ganhar SELECT para anon.
* `test/contrato.test.js` (7 casos) testa o próprio verificador com migrations inventadas.
* Mutantes `DR-M1..DR-M5` (todos mortos): RPC de venda divergente, view vazando de novo, ator
  sem uid, app chamando RPC inexistente, migration dependendo de auxiliar fictício.
* **Regra:** mudou função no banco → mude o arquivo **e** atualize a foto
  (`node test/sql/contrato.js --sql` no SQL Editor → `test/sql/contrato_producao.json`).
  Antes de aplicar SQL novo, ensaie no banco numa transação que termina em exceção.
