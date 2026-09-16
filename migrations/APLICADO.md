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

## 004 — Operações transacionais 🔄 em andamento

`vsp_registrar_venda(p_venda jsonb, p_op_id text)` ✅ criada e testada.

Grava a venda e baixa o estoque no mesmo statement. O decremento tem guarda no próprio
`UPDATE` (`where caixas >= v_qtd`): sem saldo, nenhuma linha é afetada e a transação inteira
é desfeita — duas sessões não conseguem vender a mesma última unidade. A auditoria é gravada
pelo banco, dentro da transação, não por uma segunda chamada do frontend.

**Testado em transação revertida:**

| Caso | Resultado |
|---|---|
| 1ª venda, `op_id` novo | estoque 8 → 7 |
| Retry com o **mesmo** `op_id` | `repetida=true`, 1 venda gravada, estoque continua 7 |
| Venda de 999 caixas (há 8) | recusada, estoque intacto |
| Chamada por usuário fora da allowlist | recusada |
| Auditoria | gravada pelo servidor |

Pendentes: `vsp_registrar_compra`, `vsp_cancelar_venda`, `vsp_estornar_compra`, e o
frontend passar a chamar as RPCs em vez de gravar em tabelas separadas.

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
