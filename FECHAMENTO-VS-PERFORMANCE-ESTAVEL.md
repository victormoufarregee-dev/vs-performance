# VS Performance — Fechamento / Baseline estável (17/09/2026)

**Novos pedidos são bug, manutenção ou evolução específica. Não existe continuação automática da reconstrução.**

| | |
|---|---|
| SHA inicial da auditoria | `3e6333f` (produção = repositório, 257/257, 28/28 mutantes, Conferência SQL 35/35) |
| SHA final | o commit que contém este arquivo (ver `git log -1 -- FECHAMENTO-VS-PERFORMANCE-ESTAVEL.md`) |
| Banco | Supabase `sfgpwunpcrigdhlgrgdq`, migrations 000–008 aplicadas |
| App | `index.html` único, GitHub Pages (branch `main`) |

---

## 1. Arquitetura (como está)

* **App:** um `index.html` com o JavaScript inline, instalável (service worker `sw.js`), servido
  pelo GitHub Pages. Dinheiro em centavos inteiros nas contas novas (Conferência).
* **Banco:** PostgreSQL do Supabase via PostgREST. RLS em todas as tabelas com allowlist
  `usuarios_autorizados` (hoje: Victor e Stefany; cadastro público desligado).
* **Operações críticas** são **uma** função transacional cada (`SECURITY DEFINER`,
  `search_path = public, pg_temp`, autor resolvido pela sessão com `vsp_ator()`, idempotência por
  `op_id`): `vsp_registrar_venda`, `vsp_registrar_compra`, `vsp_cancelar_venda`,
  `vsp_estornar_compra`, `vsp_reembolsar_victor`, `vsp_registrar_conferencia_caixa`,
  `vsp_invalidar_conferencia_caixa`.
* **Conta do Victor = razão** `ledger_victor` (débito = a empresa passou a dever; crédito = pagou),
  lido pela view `v_ledger_victor` (`security_invoker`, sem SELECT para anon).
* **Fila offline:** venda e compra feitas sem internet ficam no IndexedDB com o `op_id` do clique e
  são enviadas quando há sessão e rede; nada é anunciado como enviado antes do 200.
* **Conferência de Caixa:** o banco calcula o esperado (`vsp_caixa_esperado`), a pessoa informa o
  real, grava-se uma foto imutável. Nunca cria lançamento de ajuste.

## 2. Migrations

| # | arquivo | estado |
|---|---|---|
| 000–005 | preflight, integridade, idempotência, RLS, RPC das operações, ator da sessão | aplicadas |
| 006 | razão do Victor + backfill | aplicada 16/09 |
| 007 | Conferência de Caixa | aplicada 17/09 |
| **008** | **integridade do razão e do caixa esperado** (triggers + allowlist no saldo + caixa até hoje) | **aplicada 17/09 nesta auditoria** |

Os arquivos **são** o banco de produção (Opção A). Detalhe de cada uma: `migrations/APLICADO.md`.

## 3. Contrato do banco

`node test/estatico.js` → `CONTRATO DO BANCO ok (22 funções)`: md5 do corpo, linguagem, definer,
volatilidade, `search_path` e EXECUTE de anon de cada `vsp_*` batem com a foto de produção
`test/sql/contrato_producao.json` (17/09 13:59). Divergência funcional real reprova; texto fora do
corpo da função (comentário, cabeçalho) não. Incidente desta rodada: o SQL Editor gravou `\r` no
corpo (CRLF) — reaplicado com LF, foto refeita, nenhuma `vsp_*` com `\r`.

## 4. Achados da auditoria e o que foi feito

Classificação: P0 = corrupção/perda, segurança crítica, dinheiro materialmente errado, operação
central quebrada · P1 = bug real reproduzível · P2 = melhoria · P3 = cosmético.

| # | achado | classe | reprodução → correção | prova |
|---|---|---|---|---|
| A | Pagamento ao fornecedor lançado **pelo Financeiro** não creditava a Conta do Victor | **P0** latente (nenhum dado afetado: 15 saídas fornecedor = 15 créditos) | SQL real 23/11 → trigger `trg_lv_saida_inserida` (008) | OPS 34/0 |
| B | Excluir pagamento ao fornecedor deixava o crédito | **P0** latente | trigger `trg_lv_saida_excluida` (008) | OPS O8/O8b |
| C | Estornar compra deixava o débito (+500 residual no ensaio) | **P0** latente | trigger `trg_lv_reposicao_excluida` (008) | OPS O5b, mutante RZ-M1 |
| — | Editar valor/data de saída fornecedor dessincronizaria o razão | P0 latente | bloqueado no banco (o app não tem edição de saída) | OPS O9 |
| D | `vsp_saldo_victor` / `vsp_ledger_estornar_origem` executáveis por conta autenticada fora da allowlist | **P1** (não existe conta assim; cadastro desligado) | allowlist no saldo; sem EXECUTE no estornar_origem | OPS O10, RZ-M3 |
| F | Lançamento com **data futura** entrava no "caixa esperado agora" | **P1** (nenhuma linha futura real) | banco e app só até hoje (São Paulo) | OPS O11, RZ-M2, RZ-M4 |
| G | Teste do extrato com contagem fixa (21) | **P1** manutenção | reescrito por propriedade | VIEW 9/0 |
| H | Depois da 008, pagar fornecedor / excluir pagamento / estornar compra deixavam a **tela** da Conta do Victor com o saldo antigo até "Atualizar" | **P1** (efeito da correção A–C no app) | app relê o extrato depois dessas três operações; se a releitura falhar, avisa | 5 casos em `ledger.test.js`, RZ-M5, RZ-M6 |
| I | Campos de dinheiro antigos (valor da venda, desconto, saída, custo de compra, preço) liam **"1.250" como R$ 1,25** | **P1** (reproduzível; aparece na prévia antes de salvar) | `numBR` lê ponto em grupos de 3 como milhar | 2 casos em `util.test.js`, NB-M1 |

Varredura do banco por I: nenhuma saída, compra ou produto com valor suspeito. Uma venda de
**R$ 1,00** (id 1785373046472, 29/07, Stefany, TG frasco, obs. "Parceria") — parece intencional;
**não alterada**. Fica para o Victor confirmar.

**P0 abertos: 0. P1 abertos: 0.**

## 5. Caixa esperado agora — significado final

`vsp_caixa_esperado_calc()` (banco) e `caixaEsperadoPartes()` (app) fazem a mesma conta:

> **Σ líquido das vendas válidas com data ≤ hoje − Σ saídas com data ≤ hoje**, desde o primeiro
> lançamento, "hoje" no fuso de São Paulo.

| caso | entra? | como |
|---|---|---|
| dinheiro, Pix, débito | sim | líquido, no dia da venda |
| crédito à vista e parcelado | sim, inteiro no dia da venda | Victor confirmou: cai tudo em 1–2 dias. A conferência mostra à parte o cartão de hoje e ontem ("pode ainda não ter caído") — **não** muda a conta |
| fiado em aberto | não | |
| fiado quitado | sim | líquido, pela **data da venda** (ver P2-1) |
| venda cancelada | não | |
| saídas (pró-labore, retirada, despesa, imposto, outros, fornecedor) | sim | pela data da saída |
| reembolso ao Victor | sim | é uma saída `fornecedor` (e credita o razão pelo trigger) |
| compra de mercadoria | não | quem paga é o Victor: vira débito no razão |
| venda/saída com data futura | **não** | aviso "N lançamento(s) com data futura ainda não entram"; entra quando o dia chega |

Hoje não há parcelado, fiado nem lançamento futuro no banco real, então o número canônico não
mudou: **−R$ 3,49**.

**A pergunta da conferência está certa:** "Quanto existe realmente agora? Todo o dinheiro da
empresa somado: bancos e espécie." compara com o que a empresa já deveria ter recebido até hoje. A
única ressalva real (cartão de hoje/ontem) é mostrada no próprio modal.

**Saldo inicial −3,49 × 0,00:** P2/P3 — divergência histórica sem saldo de abertura formal. A
primeira conferência vai mostrar +R$ 3,49 (se nada mais mudar) e essa foto é o registro. Nenhum
ajuste fictício foi criado.

## 6. Segurança (banco real, transação desfeita)

`test/sql/seguranca_rls.test.sql` — **102 ok, 0 falhas**: 12 tabelas × anon e intruso (conta
autenticada fora da allowlist) × SELECT/INSERT/UPDATE/DELETE → nada lido, nada gravado; intruso não
se inclui em `usuarios_autorizados`; Victor não altera a allowlist pela API; nenhuma `vsp_*` (fora
trigger) executável por anon. API pública sem login: tabelas vazias/negadas, extrato `42501`.

* **`usuarios_autorizados`:** RLS ligado, uma única política (SELECT para `authenticated`, que só
  devolve linhas a quem já é autorizado). Os GRANTs padrão do Supabase continuam lá (anon e
  authenticated com SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, como em todas as
  tabelas do `public`). Pela API: anon lê 0 e não grava; intruso lê 0 e não se inclui; Victor lê a
  lista e não insere/altera/apaga (provado). TRUNCATE não é exposto pelo PostgREST e ninguém de fora
  tem SQL direto. → **P2 endurecimento** (revogar os GRANTs desnecessários), não risco atual.
* `SECURITY DEFINER` todas com `search_path = public, pg_temp`; autor sempre pela sessão
  (impersonação pelo payload coberta pelos testes e mutantes M6/CX-M4/SM4).
* Extrato `v_ledger_victor`: `security_invoker`, anon negado, intruso 0 linhas, Victor e Stefany
  veem todas as linhas, saldo corrido final = `vsp_saldo_victor()` (VIEW 9/0).

## 7. Testes — placar final

| o quê | resultado |
|---|---|
| `node test/run.js` | **266 / 266** |
| `node test/estatico.js` | saída 0 (contrato 22 funções; RAZÃO E CAIXA ok) |
| `node test/mutantes.js` | **35 mortos / 35**, controle 266 verde |
| SQL operações e razão | **34 / 0** (antes da 008: 23 / 11) |
| SQL Conferência | **35 / 0** |
| SQL extrato | **9 / 0** |
| SQL segurança RLS | **102 / 0** |
| Celular 360 / 390 / 430 e desktop (localhost, sessão simulada, nenhuma chamada ao Supabase) | venda, Financeiro, Conta Victor, modal da Conferência (com aviso do cartão e dos futuros), barra da fila offline: sem rolagem lateral, modal e botões dentro da tela. A barra de abas rola na horizontal por desenho. |

## 8. Canônicos (banco real) — antes = depois

Conta do Victor **5.758,30** · estoque **4.660,00** (TG 8 cx, Reta Verde 0) · CMV **23.539,30** ·
recebido 51.066,00 − saídas 51.069,49 = caixa **−3,49** · vendas **65** (5 canceladas) · clientes
**21** · saídas **23** · reposições **5** · razão **21** movimentos · conferências **0** · md5 das
tabelas idênticos. Auditoria: +1 linha LOGIN legítima do Victor (não causada pela auditoria).
Nenhum dado real foi alterado para teste passar.

## 9. Fila offline

Sem mudança nesta rodada. 42 casos + 7 mutantes OF-M*; barra e painel conferidos em 360/390/430.
Risco conhecido (em `OFFLINE_FILA.md`): sessão só em memória; Safari/iOS não testado com aparelho real.

## 10. Backup

* **Banco (recuperação real):** Supabase faz backup físico **diário** — 8 cópias visíveis em 17/09
  (10/09 a 17/09, ~06:37 de Brasília). Restaurar volta o projeto inteiro para aquele dia. Sem PITR
  (add-on pago; não contratado).
* **Tela de backup do app:** existe cópia JSON semanal automática na tabela `backups` (12 mais
  recentes) e download manual. **Não existe restauração pelo app** e o JSON não leva conferências,
  config nem auditoria (o download manual também não leva o razão). → evolução, não bug: a
  recuperação de verdade é a do Supabase.

## 11. Depende do Victor

* `DEPENDE DO VICTOR — smoke venda/cancelamento autenticado`
* `DEPENDE DO VICTOR — smoke offline autenticado`
* `DEPENDE DO VICTOR — primeira conferência de caixa real`
* Confirmar se a venda de R$ 1,00 de 29/07 ("Parceria") é intencional.

## 12. P2 / P3 (backlog de manutenção, não feitos)

1. **P2 — Telas de período e fiado quitado:** "Caixa do mês", "Caixa do período", DRE e Relatórios
   contam o fiado quitado pela data da **venda**, não do pagamento. O total acumulado está certo.
   Sem fiado no banco hoje. Precisa de definição do Victor antes de mudar (ou só renomear).
2. **P2 — Revogar GRANTs desnecessários** (`usuarios_autorizados` e demais tabelas: TRUNCATE/REFERENCES/TRIGGER e escrita de anon). RLS já bloqueia pela API.
3. **P2 — Backup JSON do app** incompleto (sem conferências/config/auditoria; manual sem razão).
4. **P2 — `numBR("1,000")` = 1000** (vírgula com 3 dígitos lida como milhar). A Conferência usa
   leitor próprio que recusa o ambíguo; os campos antigos não.
5. **P2/P3 — Saldo inicial do caixa** (−3,49 × 0,00): resolvido pela primeira conferência, sem ajuste.
6. **P3 — `quitado_em`** é texto de exibição (data/hora BR), não `date`.

## 13. Backlog de evolução (avaliado, não iniciado)

| item | necessidade | impacto | risco | prioridade futura |
|---|---|---|---|---|
| Fiado parcial | baixa hoje (zero fiado no banco) | mexe em caixa, período e cobrança | médio: nova regra de dinheiro em telas de período | baixa |
| Devolução | média (produto volta ao estoque, dinheiro volta ao cliente) | estoque, custo médio, caixa, razão | alto: interage com estorno e custo médio | média |
| Troca | baixa/média | estoque de dois produtos numa operação | médio/alto | baixa |
| Contas a pagar | média (hoje só o que já foi pago) | caixa futuro, fornecedores | médio: não pode entrar no caixa esperado | média |
| Backup/restore no app | baixa (Supabase diário já recupera) | recuperação parcial por tabela | alto: restaurar por cima de dado vivo corrompe | baixa |


---

# Hardening pós-baseline (17/09/2026)

Rodada curta de engenharia/segurança sobre o baseline `757e559`. Nenhuma funcionalidade nova,
nenhum dado real criado, apagado ou ajustado. Canônicos idênticos antes e depois
(md5 das tabelas `25cdf18d22fa4d922da7f94bb23bc08b`).

## CI automático (GitHub Actions)

`.github/workflows/testes.yml` — roda em push e pull request para `main` (e sob demanda).
`permissions: contents: read`, sem segredo, sem credencial do Supabase, sem OneDrive: testa só
o que está versionado. Passos: `node test/run.js` → `node test/estatico.js` →
`node test/mutantes.js`, sem `continue-on-error`.

* **Verde provado:** run [35253852747](https://github.com/victormoufarregee-dev/vs-performance/actions/runs/35253852747)
  — 1m08, suíte 266/266, estáticos ok, mutantes 35/35 (na data do commit do workflow).
* **Vermelho provado:** run [35254067083](https://github.com/victormoufarregee-dev/vs-performance/actions/runs/35254067083)
  — branch temporária `ci-prova-vermelho` com o sinal do crédito invertido em `saldoVictor()`:
  a suíte falhou, o job ficou vermelho e os passos seguintes nem rodaram. A branch foi apagada;
  a `main` nunca recebeu a sabotagem.

## Proteção da `main`

Branch protection aplicada **depois** do primeiro CI verde: `allow_force_pushes: false`,
`allow_deletions: false`, `enforce_admins: true` (vale também para o dono — é ele quem mais
corre risco de apagar por acidente). Provado na prática: `git push --force` foi recusado
("Cannot force-push to this branch") e `git push --delete main` também; a `main` ficou intacta.

Sem exigência de PR: o fluxo normal (commit direto na `main`) continua funcionando, e o CI roda
em todo push. Exigir **CI verde antes de merge** só faz sentido junto com fluxo de PR, e com
`enforce_admins: true` isso passaria a bloquear o commit direto. Fica como opção do Victor:

`DEPENDE DO VICTOR — exigir CI verde antes de merge (opcional)`
Settings → Branches → Branch protection rules → `main` → marcar "Require status checks to pass
before merging" e escolher o check `suite`; a partir daí, mudanças na `main` passam a entrar por
Pull Request.

## `vsp_ledger_backfill` — fechado (migration 009)

Provado que ninguém do app a chama e que o backfill está completo; `revoke execute` de
`public`, `anon` e `authenticated`. Sobram `postgres` (owner) e `service_role`. O corpo não
mudou (mesmo md5). Detalhe em `migrations/APLICADO.md`, seção 009.

## Demais funções SECURITY DEFINER — WARNING aceito

As 11 portas do app (`vsp_registrar_venda`, `vsp_registrar_compra`, `vsp_cancelar_venda`,
`vsp_estornar_compra`, `vsp_reembolsar_victor`, `vsp_registrar_conferencia_caixa`,
`vsp_invalidar_conferencia_caixa`, `vsp_caixa_esperado`, `vsp_saldo_victor`, `vsp_autorizado`,
`vsp_ator`) **continuam** com EXECUTE para `authenticated`: é assim que o app trabalha. O que as
torna seguras está provado em `test/sql/portas_rpc.test.sql` — **49 ok, 0 falhas**: cada uma é
`security definer` com `search_path = public, pg_temp`, anon não executa, o intruso autenticado é
recusado em todas ("nao autorizado"), `vsp_ator()` não devolve nome de ninguém para ele, e nada
de negócio mudou depois de todas as tentativas. **Não** se mexe na arquitetura para zerar o
dashboard do Supabase.

## Leaked Password Protection — habilitada

Authentication → Sign In / Providers → Email → "Prevent use of leaked passwords" (atalho em
Attack Protection). Ligada em 17/09/2026. Só afeta **cadastro e troca de senha** (checa a senha
contra a base do HaveIBeenPwned); não altera senha, sessão, usuário nem método de login.
Conferido depois: 2 contas em `auth.users` (Victor e Stefany), ambas confirmadas, nenhuma
banida, últimos logins preservados; 2 autorizados ativos; cadastro público continua desligado.

## Grants amplos — P2 de defesa em profundidade (nada revogado)

Retrato de 17/09/2026: RLS ligado nas 12 tabelas. `conferencias_caixa` é a única já enxuta
(anon sem nada; authenticated só SELECT/REFERENCES/TRIGGER — a escrita passa pelas RPCs). As
outras 11 mantêm o grant padrão do Supabase para `anon` e `authenticated`
(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER), e quem barra é a RLS — provado
102/0. Como não há prova de benefício específico e revogar em massa quebraria o app se algum
caminho legítimo passar por tabela, **nada foi revogado**. Candidato natural quando houver
rodada para isso: tirar `anon` de tudo e TRUNCATE de `authenticated`.

## Migration history do Supabase — P2

A Management API não tem histórico dessas migrations; o repositório tem 000–009 e o
`APLICADO.md`. **Não** se fabrica histórico retroativo.
`P2 — formalizar baseline de migration history antes da próxima alteração estrutural relevante.`
O estado Git × banco já é provado pelo contrato (`node test/estatico.js`).

## Backup — as duas camadas, ditas com honestidade

1. **Recuperação de verdade: Supabase.** Backup físico diário do banco (8 cópias visíveis,
   10/09 a 17/09), restauração pelo painel. Sem PITR (add-on pago, não contratado).
2. **Cópia operacional do app:** JSON semanal automático na tabela `backups` (12 mais recentes)
   e download manual. Não inclui conferências, configuração nem auditoria (o download manual
   também não leva a Conta do Victor), e **o app não restaura** por ela.

O texto da tela de Config dizia "cópia completa" — corrigido nesta rodada para descrever o que
a cópia realmente é e apontar o backup do Supabase como recuperação. Caso novo em
`estatico.test.js` trava esse texto. Restore no app **não** foi implementado.

## Performance — nada otimizado por antecipação

Só itens INFO no advisor: FK `ledger_victor_estorna_id_fkey` sem índice dedicado; índices
`idx_cc_conferido` e `idx_reposicoes_prod` ainda sem uso; Auth com limite absoluto de conexões.
Com 65 vendas e 21 movimentos, nada disso é gargalo. **P3/P2 futuro**: reavaliar quando o volume
crescer (índice da FK só quando houver estorno em massa; não apagar índice novo por "sem uso
ainda"; não mexer na configuração de Auth).

## P2 estrutural registrado (não feito)

`P2 — servidor validar/calcular os campos financeiros críticos da venda (bruto, custo, taxa,
líquido, lucro, margem) em vez de aceitar o que o frontend mandou.` Hoje a RPC recebe esses
valores prontos; o custo médio, a baixa de estoque e a auditoria já são do servidor. Só voltar
a isso em rodada explícita.

## Placar desta rodada

| o quê | resultado |
|---|---|
| `node test/run.js` | 267 / 267 |
| `node test/estatico.js` | saída 0 (13 checagens; PERMISSOES nova) |
| `node test/mutantes.js` | 36 / 36 mortos (PERM-M1 novo) |
| SQL operações e razão | 34 / 0 |
| SQL Conferência | 35 / 0 |
| SQL extrato | 9 / 0 |
| SQL segurança RLS | 102 / 0 |
| SQL portas do app | 49 / 0 |
| Canônicos | idênticos |

## Continuam dependendo do Victor

* `DEPENDE DO VICTOR — smoke venda/cancelamento autenticado`
* `DEPENDE DO VICTOR — smoke offline autenticado`
* `DEPENDE DO VICTOR — primeira Conferência de Caixa real`
* `DEPENDE DO VICTOR — confirmar se a venda de R$ 1,00 de 29/07 ("Parceria") é intencional`
* `DEPENDE DO VICTOR — exigir CI verde antes de merge (opcional)`
