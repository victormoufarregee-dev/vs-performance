# Fechamento — hardening pós-baseline 2 (17/09/2026)

Rodada de validação, fechamento operacional e hardening estrutural rodada por inteiro sobre a
baseline estável de 17/09/2026. Este arquivo é o registro completo: o que estava lá antes, o
que mudou, por quê, com que prova, e o que continua dependendo do Victor.

Documento anterior: `FECHAMENTO-VS-PERFORMANCE-ESTAVEL.md` (baseline) — este continua de lá.

---

## 1. Estado inicial (fotografia antes de mexer)

**Repositório:** `victormoufarregee-dev/vs-performance`
**SHA inicial da `main`:** `f829d07c5aafe25b876e0fa03131f08ff25c591f`
**Árvore limpa**, `main` = `origin/main`, nenhum arquivo pendente (havia um arquivo lixo de
0 byte chamado `=`, removido nesta rodada).

**Testes locais, antes de qualquer alteração**

| comando | resultado |
|---|---|
| `node test/run.js` | **267 passaram · 0 falharam · 0 pendentes** |
| `node test/estatico.js` | **13 checagens, saída 0** |
| `node test/mutantes.js` | **36 mortos · 0 sobreviventes** |

**Testes SQL, no banco real, em transação desfeita**

| arquivo | resultado |
|---|---|
| `test/sql/operacoes_razao.test.sql` | 34 ok / 0 falhas |
| `test/sql/conferencia_caixa.test.sql` (007 + testes) | 35 ok / 0 falhas |
| `test/sql/view_ledger.test.sql` | 9 ok / 0 falhas |
| `test/sql/seguranca_rls.test.sql` | 102 ok / 0 falhas |
| `test/sql/portas_rpc.test.sql` | 49 ok / 0 falhas |

**Canônicos de produção — 17/09/2026 18:14 UTC**

| número | valor |
|---|---|
| Conta do Victor (`vsp_saldo_victor`) | **5.758,30** (débitos 28.199,30 − créditos 22.441,00) |
| Caixa esperado (`vsp_caixa_esperado_calc`) | **−3,49** |
| Vendas | **65** (5 canceladas, 60 ativas) |
| Soma líquida das vendas ativas | 51.066,00 |
| CMV das vendas ativas | 23.539,30 |
| Lucro líquido das vendas ativas | 27.526,70 |
| Fiado em aberto | 0,00 |
| Saídas | 23 · soma 51.069,49 |
| Reposições | 5 · soma 19.065,00 |
| Clientes ativos | 21 |
| Estoque (`produtos`) | TG 8 cx / 0 fr (custo caixa 582,50 · frasco 145,63) · RETA_VERDE 0/0 |
| Tabela legada `estoque` | 1 linha (2 cx / 3 fr) — não é a fonte do estoque |
| Razão (`ledger_victor`) | 21 lançamentos |
| Conferências de caixa | 0 — a primeira foi registrada no fim desta rodada (ver 10C) |
| Auditoria | 264 linhas · última 17/09/2026 16:44:49 UTC |

**md5 das tabelas (concatenação ordenada dos md5 de linha)**

| tabela | linhas | md5 |
|---|---|---|
| audit_log | 264 | `893c01f942137a7e2a9352601bf84db1` |
| backups | 9 | `33009e7781bf6ef553ce82d35844a0e3` |
| clientes | 21 | `d408a1e72f08de76ddacc56d8de0005c` |
| conferencias_caixa | 0 | `d41d8cd98f00b204e9800998ecf8427e` |
| config | 1 | `3eeb67cc2e76cf45f32f7d4a6c75f37c` |
| estoque | 1 | `d28f3f767e81343e0f40974914dd03e4` |
| ledger_victor | 21 | `c0080e2864395548e645af741717b079` |
| produtos | 2 | `0d42c309ad05e9f172cb8c7482c88387` |
| reposicoes | 5 | `ae4921f685314d405ba11e860890427b` |
| saidas | 23 | `cd3dcdf27754d3d937a51bfe6037d547` |
| usuarios_autorizados | 2 | `c23691c7c08b1faed58271d7864883a5` |
| vendas | 65 | `376a3b62bc1019701a6a9666bed7fbec` |

**Inventário do banco antes:** 12 tabelas + 1 view, RLS ligada nas 12 (force = false);
22 funções `vsp_*`, todas de `postgres`, todas com `search_path = public, pg_temp`;
5 triggers, todos habilitados; 31 policies, todas `TO authenticated` com `vsp_autorizado()`;
extensões `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`;
**nenhum job de cron** (o schema `cron` não existe); 2 contas em `auth.users`, 2 na allowlist
(Victor e Stefany, ambos ativos); `v_ledger_victor` com `security_invoker = true`.

**Produção × repositório, antes:** idênticos byte a byte —
`index.html` md5 `94b0b4d4d9facab5a22989a7619071cf` (368.365 bytes),
`sw.js` `a30d4459edae42bfd836310f9a20f471`, `manifest.json` `6a4beca20e656fd3580ae54dda9bfc33`,
`icon.svg` `02163532892e706410e6078304d74725`.

---

## 2. Achados desta rodada

Ordem por gravidade. Todos reproduzidos antes de corrigidos.

### A. `vsp_registrar_venda` gravava o dinheiro que o navegador mandasse — P1 estrutural

`val_final`, `bruto`, `custo`, `taxa_val`, `liq`, `lucro_liq` e `margem` iam do payload direto
para a tabela. O banco só conferia quantidade, tipo, produto e estoque. Duas consequências
reais: sessão adulterada grava `bruto=1` com `lucro=10000`; e bug de cliente (leitura de
número, ver **C**) grava dinheiro errado sem ninguém perceber.

**Corrigido na 011.** Prova: `test/sql/derivados.test.sql`, 30 checagens no banco real,
incluindo payload adulterado em cada campo.

### B. Quitação de fiado era `PATCH` direto em `vendas` com lucro do navegador — P1 estrutural

`confirmarQuitar()` mandava `quitado`, `pgto_quitado`, `lucro_liq`, `margem` e `quitado_em`
calculados no cliente. Qualquer sessão com `UPDATE` em `vendas` podia escrever qualquer coisa
em qualquer coluna, inclusive `liq` e `cancelada`.

**Corrigido na 011:** RPC `vsp_quitar_fiado`, e `authenticated` perde o `UPDATE` amplo
(sobra `UPDATE (vence_em)`).

### C. `numBR()` adivinhava número ambíguo e errava por 1000× — P1

Comportamento antigo, medido:

| digitado | virava | devia |
|---|---|---|
| `1,000` | **1000** | ambíguo — mil? ou 1 com três casas? |
| `0,001` | **1** | ambíguo (e 1000× errado) |
| `1,234,567` | **1.234** | ambíguo (`parseFloat` parava no 1º separador) |
| `1e3` | **13** | inválido (o filtro apagava o `e` e sobrava "13") |
| `1.2.3` | **1.2** | inválido |

**Corrigido:** `numBRx()` é uma gramática explícita que devolve `{ok, v, motivo}` e **recusa**
o ambíguo em vez de chutar. `numBR()` continua devolvendo número (0 na recusa) para não quebrar
os `|| 0` espalhados pelo app, e as quatro telas que gravam dinheiro (venda, saída, compra,
produto) passam a barrar a operação com o nome do campo — **antes** do "falta preencher", senão
o 0 da recusa se disfarçava de campo vazio. Tudo que já era lido certo continua igual
(`1.250`→1250, `1.250,50`→1250,50, `12.50`→12,50, `R$ 1.250,00`→1250, `12,345,678.90`→12345678,90).

### D. "Excluir cliente" mentia — P1 de confiança

A tela chamava `DELETE /clientes`. Não existe policy de DELETE em `clientes` (decisão da 003) e
`vendas.cli_id` tem FK `ON DELETE RESTRICT`. A RLS engolia em silêncio: **0 linhas afetadas,
HTTP 204**. O app tirava o cliente da lista local, escrevia `CLIENTE_REMOVIDO` na auditoria,
dizia "Cliente removido." — e o cliente voltava no próximo carregamento.

**Corrigido:** o botão passa a **inativar** (`PATCH ativo=false`), que é o que a 001 já previa
("inativação em vez de exclusão", coluna `clientes.ativo` existe desde lá e não era usada por
ninguém). Cliente inativo sai do seletor de venda, continua na lista com selo e botão
**Reativar**. Nenhum cadastro é apagado.

### E. `vsp_cc_protege()` executável por `PUBLIC` (e por `anon`) — P2

Única função `vsp_*` com o grant padrão de função. É trigger function e `SECURITY INVOKER`
(chamada direta só devolve "can only be called as a trigger"), então o risco prático era nulo —
mas era exatamente o tipo de exceção que a checagem de permissões abria de propósito
(`pg_get_function_result(p.oid) <> 'trigger'`) e por isso não via. **Revogada na 010**, e a
exceção saiu da checagem.

### F. Grants amplos padrão do Supabase — P2 (defesa em profundidade)

`anon` e `authenticated` com `ALL` em todas as tabelas de negócio. **Fechado na 010/011.**

### G. `mutantes.js` não aplicava mutação quando o arquivo estava em CRLF — P2 de teste

No Windows o `autocrlf` do Git deixa CRLF na cópia de trabalho; três mutantes novos saíram como
`NAO APLICADO` — pior que mutante vivo, porque não provam nada. **Corrigido:** o alvo é lido em
LF, como `estatico.js` já fazia.

### H. Vendas antigas com `margem` em outra convenção — histórico, não bug aberto

12 das 65 vendas gravaram *markup sobre o custo* em vez de *margem sobre a venda*
(ex.: venda `1780949070694`, bruto 1.400, lucro 790 → gravou 129,51% em vez de 56,43%). É campo
de exibição. **Não foi reescrito** — é história real. Da 011 em diante o banco calcula a margem
sobre a venda, sempre.

---

## 3. Banco — migrations aplicadas

| migration | o que faz | muda dado? |
|---|---|---|
| `010_grants_minimos.sql` | grants mínimos por tabela; `anon` zerado; `vsp_cc_protege` fechada; default privilege de tabela nova fechado para `anon` | **não** |
| `011_derivados_no_banco.sql` | venda calcula os derivados e recusa payload incoerente; `vsp_quitar_fiado`; `UPDATE` por coluna em `vendas` e `reposicoes` | **não** |

Detalhe completo, com a tabela de grants e a conferência das 65 vendas: `migrations/APLICADO.md`,
seções **010** e **011**.

**Matriz de grants depois (lida de produção):**

```
anon                 → NENHUM privilégio em NENHUMA tabela
authenticated        → audit_log INSERT,SELECT | backups DELETE,INSERT,SELECT
                       clientes INSERT,SELECT,UPDATE | conferencias_caixa SELECT
                       config SELECT,UPDATE | estoque SELECT | ledger_victor SELECT
                       produtos INSERT,SELECT,UPDATE | reposicoes SELECT
                       saidas DELETE,INSERT,SELECT | usuarios_autorizados SELECT
                       vendas SELECT | v_ledger_victor SELECT
UPDATE por coluna    → vendas(vence_em) · reposicoes(lote, nota_lote, validade)
```

**Funções:** 23 em produção (22 + `vsp_quitar_fiado`). `authenticated` executa **12 portas**
(as 11 de antes + `vsp_quitar_fiado`); `anon` não executa **nenhuma**.

**Migration history:** este projeto **nunca** foi gerenciado pelo Supabase CLI — o schema
`supabase_migrations` não existe. Inventar uma tabela de histórico com datas retroativas seria
falsificar; não foi feito. A rastreabilidade verificável é `test/sql/contrato_producao.json`
(md5/assinatura/`search_path`/EXECUTE das 23 funções **+ a matriz de grants**) comparada pelo
`node test/estatico.js`.

---

## 4. App — o que mudou em `index.html`

- `confirmarQuitar()` → `sbRpc('vsp_quitar_fiado', {p_id, p_pgto, p_op_id})`, adota a venda que
  o banco devolve, e não mente quando o banco recusa.
- `numBRx()` / `numBR()` / `valNumX()` / `conferirNums()` — gramática do dinheiro digitado.
- Venda, saída, compra e produto conferem os campos de dinheiro antes de gravar.
- `delCli()` inativa; `reativarCli()` novo; `renderCli()` mostra o selo *inativo* e o botão
  Reativar; `populateCliSelect()` esconde inativo.
- `montarDump()` ganha `conferencias`, `config` e um campo **`escopo`** que declara dentro do
  próprio arquivo o que entra, o que fica de fora e que **não há restauração**;
  `baixarBackup()` passa a usar `montarDump()` (antes a cópia baixada saía **sem** a Conta do
  Victor e a da nuvem saía com ela). Texto da tela de backup atualizado para bater com isso.

Nada de `sw.js`: ele já é *rede primeiro* para HTML, então a versão nova chega sem bump.

---

## 5. Testes

| | antes | depois |
|---|---|---|
| `node test/run.js` | 267 / 0 | **281 / 0** |
| `node test/estatico.js` | 13 checagens, saída 0 | **15 checagens, saída 0** |
| `node test/mutantes.js` | 36 mortos / 0 vivos | **45 mortos / 0 vivos** |

Nenhum teste foi removido, nenhum mutante enfraquecido, nenhum `continue-on-error`.

**Arquivos novos:** `test/derivados.test.js`, `test/sql/derivados.test.sql`,
`test/sql/grants.test.sql`.

**Checagens estáticas novas:** `GRANTS` (matriz de produção × alvo, + os `revoke`/`grant` das
010 e 011) e `DINHEIRO DERIVADO` (o banco calcula, a tela não quita por PATCH, `numBRx` existe,
a venda confere os campos, a tela não chama `DELETE /clientes`). A checagem `PERMISSOES` deixou
de abrir exceção para trigger function e passou a exigir **nenhuma** função executável por `anon`.

**Mutantes novos:** `GR-M1`, `GR-M2`, `GR-M3`, `DV-M1`, `DV-M2`, `DV-M3`, `NB-M3`, `NB-M4`,
`CL-M1`. Dois antigos foram re-apontados porque o alvo mudou de arquivo: `DR-M1` (a venda passou
a ser definida pela 011) e `NB-M1` (a leitura de milhar mudou de forma).

**SQL, no banco real, em transação desfeita — depois da 010 e da 011**

| arquivo | resultado |
|---|---|
| `operacoes_razao` | 34 ok / 0 |
| `conferencia_caixa` | 35 ok / 0 |
| `view_ledger` (extrato) | 9 ok / 0 |
| `seguranca_rls` | 102 ok / 0 |
| `portas_rpc` | 49 ok / 0 |
| `grants` (novo) | 19 ok / 0 |
| `derivados` (novo) | 30 ok / 0 |

Dois testes SQL precisaram acompanhar a 010, sem perder o que provavam:
`seguranca_rls` passou a aceitar `insufficient_privilege` onde antes esperava "0 linhas"
(as duas respostas provam a mesma coisa: pela API ninguém mexe na allowlist), e `operacoes_razao`
move a data da saída de teste como dono do banco em O11c, porque `authenticated` perdeu o
`UPDATE` em `saidas` (o app nunca editou saída — ele apaga e relança).

---

## 6. Segurança

**Supabase Security Advisor depois das mudanças:** **0 erros · 12 avisos · 0 sugestões.**
Os 12 avisos são todos do mesmo tipo — *"Signed-In Users Can Execute SECURITY DEFINER Function"* —
e são exatamente as 12 portas do app. É esperado e está provado porta por porta em
`test/sql/portas_rpc.test.sql` (49/0): cada uma é `security definer` com `search_path` fixo,
sem EXECUTE para `anon`, recusa intruso autenticado fora da allowlist, e nada de negócio muda
depois de todas as tentativas do intruso. O aviso de `vsp_cc_protege` **sumiu** com a 010.

Não há mais: view sem `security_invoker`, função com `search_path` mutável, RLS desligada,
nem função executável por `anon`.

---

## 7. Performance

Medido antes de mexer, e **nada foi mexido** — de propósito.

**Supabase Performance Advisor: 0 erros · 0 avisos · 4 sugestões (INFO):**

| sugestão | decisão |
|---|---|
| FK sem índice em `ledger_victor` | **não criar.** A tabela tem 21 linhas. Um índice aqui custa manutenção e não ganha nada: varrer 21 linhas é mais rápido que abrir índice. |
| Índice nunca usado em `conferencias_caixa` | **não remover.** É o `unique` de `op_id` — existe para *correção* (idempotência), não para velocidade. A tabela tem 0 linhas; "nunca usado" é consequência disso. |
| Índice nunca usado em `reposicoes` | **não remover.** Mesmo motivo (`op_id` único, 5 linhas). |
| Estratégia de conexão do Auth | infraestrutura do Supabase, não do repositório. |

A maior tabela do banco é `audit_log`, com **264 linhas**. Criar índice aqui seria otimização
por feeling, que é o que a regra da rodada proíbe. Fica anotado: **revisitar quando qualquer
tabela passar de ~50 mil linhas**.

---

## 8. Produção × repositório

Antes da rodada, produção e `main` eram idênticos byte a byte nos quatro arquivos servidos
(md5 na seção 1). O deploy é GitHub Pages a partir da `main`; o `sw.js` é *rede primeiro* para
HTML, então a versão nova chega sem bump de versão do service worker.

---

## 9. Git e CI

- Branch de trabalho: **`hardening-pos-baseline-2`** (a `main` não aceita mais push direto).
- Proteção da `main` endurecida nesta rodada:

| regra | antes | depois |
|---|---|---|
| force push | bloqueado | bloqueado |
| exclusão | bloqueada | bloqueada |
| `enforce_admins` | sim | sim |
| exigir Pull Request | **não** | **sim** (0 revisões — repositório individual, sem burocracia inútil) |
| exigir status check | **não** | **sim — `suite`** (o job real do workflow `testes`) |
| branch atualizada antes do merge | não | sim (`strict`) |
| resolver conversas antes do merge | não | sim |

**Provado, não declarado** (branch técnica `teste-protecao`, PR #1, ambos apagados depois):

1. `git push origin HEAD:main` → `GH006: Protected branch update failed` ·
   *"Changes must be made through a pull request"* · *"Required status check «suite» is expected"*.
2. Merge do PR com o check **em andamento** → `Required status check "suite" is in progress.`
3. Merge do PR com o check **VERMELHO** (quebra proposital) → `Required status check "suite" is
   failing.` — **inclusive com `--admin`**, porque `enforce_admins` está ligado.
4. PR fechado, branch remota e local apagadas, nenhum commit de teste entrou na `main`.

---

## 10. Smokes operacionais — o que ficou provado e o que é do Victor

### 10A. Venda e cancelamento autenticados

**Provado, no banco real, com as sessões do Victor e da Stefany simuladas como o PostgREST faz,
em transação desfeita** (`operacoes_razao` 34/0 + `derivados` 30/0): login/sessão, `op_id`,
criação da operação pela RPC, impacto em vendas, estoque, CMV, caixa esperado, auditoria e
razão, cancelamento, reversão completa pelo custo histórico, idempotência no retry, recusa do
intruso autenticado e do anônimo, e agora também a recusa de payload financeiro adulterado.
Na camada de chamada (`test/operacoes.test.js`), que o app manda o payload certo, com `op_id`
não vazio, não mexe em estoque/custo/receita antes da resposta e adota o estado canônico.

**Não feito de propósito:** venda real temporária em produção pela UI. Uma venda cancelada
ficaria **para sempre** na aba Cancelamentos, mais duas linhas de auditoria — dado fictício
persistido em produção, que é o que a regra desta rodada proíbe. O equivalente foi feito em
transação revertida.

**Falta do Victor (físico):** abrir o app logado, lançar uma venda de verdade, conferir a tela
depois da operação, dar refresh, sair e entrar de novo. É a única parte que nenhum teste
automatizado substitui.

### 10B. Offline autenticado

**Provado:** `test/fila.test.js` cobre a fila de intenções em IndexedDB — só venda, compra e
cliente novo entram; `op_id` estável; `sbFetch` não inventa 200 sem rede; reenvio cai na
idempotência; nada duplica; sessão expirada tratada. A checagem estática `FILA OFFLINE` impede
o retorno do `new Response(eco, {status:200})` e do array inteiro no `localStorage`.

**Falta do Victor (físico):** aparelho real, rede caindo de verdade, service worker,
atualização de versão, reentrada no app. `SMOKE_OFFLINE.md` tem o roteiro.

### 10C. Primeira Conferência de Caixa

**Tecnicamente validada de novo nesta rodada** (`conferencia_caixa` 35/0, com a 010 e a 011
aplicadas): função, esperado calculado no banco, diferença = real − esperado, imutabilidade
pelo trigger, invalidação, auditoria, fuso de São Paulo, venda e saída futuras fora do caixa de
hoje, cartão recente, saldo inicial, idempotência por `op_id`, e o autor vindo da sessão.

**FEITA em 17/09/2026 17:47:11** (fuso de São Paulo), pelo Victor, no app. Conferência **82**:

| campo | valor |
|---|---|
| escopo | consolidado |
| saldo esperado (calculado pelo banco) | **−3,49** |
| saldo real (contado pelo Victor) | **0,00** |
| diferença (real − esperado) | **+3,49** — sobra |
| observação | "Conta zerada" |
| autor | Victor, resolvido por `vsp_ator()` — não veio do payload |
| `op_id` | `af08773f-3597-4d64-b4f1-98bca5ee7066` |
| situação | valida |

Auditoria gravada na mesma transação (`audit_log` 1789678031161):
*"Esperado -R$ 3,49 · real R$ 0,00 · diferença R$ 3,49 · Conta zerada · conferência 82"*.

**O registro não corrigiu nada**, como projetado: o caixa esperado continua −3,49, e nenhuma
venda, saída ou lançamento do razão mudou (65 vendas, 23 saídas, 21 movimentos do razão,
iguais a antes). A auditoria foi de 264 para 267 linhas: dois LOGIN reais (Victor 17:35,
Stefany 17:39) e a própria conferência.

A foto 82 foi testada **depois** de gravada, em transação desfeita: **5 ok / 0 falhas** —
`UPDATE` e `DELETE` recusados no SQL Editor (dono do banco) e pela API como Victor, e a linha
segue intacta. É imutável de verdade, não por convenção.

**De onde vem o −3,49:** saídas 51.069,49 − recebido líquido 51.066,00. Nenhuma venda tem
centavos. Das 23 saídas, só três têm, e duas são pró-labore que se fecham em número redondo
(5.062,50 + 5.062,50 = 10.125,00). **Os 49 centavos vêm de uma única linha:** a despesa de
13/07, "Isopor + Gelinho = Victor comprou", de **R$ 105,49**. Os R$ 3,00 restantes são o
saldo acumulado entre o que saiu e o que entrou.

Caixa esperado negativo não existe fisicamente, então a leitura é: **saiu R$ 3,49 a mais do
que o sistema viu entrar**, sobre mais de R$ 51 mil movimentados — resíduo, não vazamento.
Fica registrado e documentado. A conferência **só verifica**: não criou lançamento de ajuste,
e nenhum foi criado à mão.

### 10D. A venda de R$ 1,00 de 29/07 — investigada, nada alterado

Venda `1785373046472`. **Correção de premissa:** a cliente é **Lupercio Souza**; *Stefany* é
quem lançou (`usuario`), não a compradora.

Campos: TG, **frasco**, qtd 1, `val_orig` 1,00, desconto 0, `val_final` 1,00, `bruto` 1,00,
`liq` 1,00, `custo` 150,91 → `lucro_liq` −149,91, `margem` −14991%. Pgto pix, **não cancelada**,
`op_id` nulo (anterior à idempotência), `created_at` 2026-07-30 00:57:26 UTC = 29/07 21:57 em
São Paulo, `obs` = **"Parceria"**.

Evidência na auditoria:

```
29/07/2026 21:55:49 | Stefany | LOGIN  | Stefany entrou via iPhone/iPad
29/07/2026 21:57:27 | Stefany | VENDA  | TG · Lupercio Souza · Frasco x1 · R$ 1.00 · pix
```

…e nada depois. Nenhum cancelamento, nenhuma venda de correção.

Contexto que pesa:

- **O padrão da casa para erro de lançamento é cancelar em segundos, com motivo.** Duas provas:
  a venda `1783975286473` (13/07, caixa a **R$ 13.000** — dez vezes o preço normal) foi
  cancelada **18 segundos** depois, por Stefany, motivo "Erro no lançamento"; e em 23/07 uma
  venda da Laura foi cancelada 20 segundos depois pelo mesmo motivo. A de R$ 1,00 está lá há
  50 dias.
- **O cliente é recorrente e tem preço conhecido:** Lupercio comprou frasco a R$ 350 em 08/07,
  09/07, 23/07, 25/07 e 27/07, e caixa a R$ 1.300 várias vezes. R$ 1,00 é o único frasco fora
  da faixa (histograma dos frascos: 1×**1**, 1×250, 3×300, 20×350, 1×375, 6×400, 2×1300).
- **A observação foi escrita à mão**: "Parceria". Erro de digitação não vem com justificativa.

**Conclusão técnica: não há evidência de erro; há evidência positiva de intenção.** Continua
como lançamento intencional, pendente apenas de confirmação do Victor. **Nada foi alterado.**

---

## 11. Confirmação sobre dado real

**Nenhum dado real foi alterado nesta rodada.** Nem uma venda, nem um centavo, nem um cliente,
nem uma linha de razão, nem um usuário, nem uma senha.

- As 010 e 011 mexem só em permissão e em corpo de função. Nenhum `INSERT`, `UPDATE` ou `DELETE`
  em tabela de negócio.
- Todo teste SQL termina em `raise exception` de propósito: a transação inteira é desfeita.
- Os canônicos relidos depois de tudo (seção 12) são **idênticos** aos da fotografia inicial,
  **incluindo o carimbo da última linha de auditoria** — 264 linhas, última às 16:44:49 UTC, a
  mesma de antes da rodada. Se algo tivesse gravado, esse carimbo teria andado.

---

## 12. Estado final

**Canônicos relidos depois da 010 e da 011 — todos idênticos à fotografia inicial:**

```
Conta do Victor 5.758,30 · caixa esperado −3,49 · vendas 65 (5 canceladas)
líquido 51.066,00 · CMV 23.539,30 · lucro 27.526,70 · fiado em aberto 0
saídas 23 (51.069,49) · reposições 5 · clientes ativos 21 · razão 21 · conferências 0
estoque TG 8 cx / 0 fr (582,50/145,63) · RETA_VERDE 0/0
auditoria 264 · última 2026-09-17T16:44:49.35Z   ← igual à de antes
```

---

## 13. Pendências humanas (só o que realmente exige o Victor)

1. ~~Primeira Conferência de Caixa real~~ — **feita em 17/09/2026** (conferência 82, diferença
   +3,49; ver 10C). Resta decidir se investiga os R$ 3,49 ou se ficam como resíduo documentado.
2. **Smoke de venda/cancelamento na UI**, com login real, refresh e reentrada.
3. **Smoke offline em aparelho real**, com rede caindo de verdade (roteiro em `SMOKE_OFFLINE.md`).
4. **Decidir sobre a venda de R$ 1,00 de 29/07** (seção 10D): confirmar que foi de propósito, ou
   pedir o cancelamento. Enquanto não decidir, fica como está.

## 14. Próximos passos recomendados (nenhum urgente)

- `vendas.quitado_em` e `vendas.cancelada_em` são **`text`** em formato brasileiro
  (`DD/MM/YYYY HH:MM:SS`). Funciona — o app e o banco escrevem e leem no mesmo formato e no mesmo
  fuso — mas não é comparável em SQL sem `to_timestamp`. Trocar o tipo mexe em linha real e não
  há bug aberto, então ficou fora desta rodada. Ver seção 15.
- Revisitar índices quando alguma tabela passar de ~50 mil linhas.
- Restauração a partir da exportação: **não implementar** enquanto não houver prévia,
  atomicidade, versionamento e confirmação explícita. Hoje o caminho de recuperação é o backup
  diário do Supabase.

## 15. `quitado_em` e fiado — auditado, decidido não mexer

Pergunta da rodada: o fiado deve ser reconhecido na venda ou no pagamento?

**Resposta encontrada no código: são duas métricas diferentes, e as duas já estão certas.**

- **Caixa esperado (acumulado)** — `vsp_caixa_esperado_calc` soma `liq` das vendas não
  canceladas com `pgto <> 'fiado' or quitado`, filtrando por **`data` da venda ≤ hoje**. Para um
  total desde o início, a data usada é indiferente: uma venda fiado só entra depois de quitada,
  e a data da venda é sempre ≤ a do pagamento. A única aresta (venda fiado com data futura,
  quitada hoje) não existe nos dados e não é um cenário real.
- **Relatórios por período** — o app usa `quitadoEm` para "fiado recebido no mês" e "quitado
  hoje". Ou seja: o período reconhece no **pagamento**, que é o correto para caixa.

Não há bug inequívoco, e mudar a regra sem evidência seria alterar critério gerencial por conta
própria. O que **foi** corrigido é o que era inequívoco: quem calcula o lucro da quitação agora
é o banco, pelo custo histórico da venda, e quem carimba a data é o banco, no fuso de São Paulo
(011). O tipo `text` da coluna fica anotado como dívida técnica, não como bug.
