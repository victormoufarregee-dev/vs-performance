# Migrations aplicadas na produção — 15/09/2026

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
