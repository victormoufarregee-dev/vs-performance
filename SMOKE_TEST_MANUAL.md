# Smoke test autenticado — o único elo que depende do Victor

**Por que existe:** eu consigo testar o código do app e as funções do banco separadamente, e testei
os dois. O que não consigo é logar no sistema com a sua sessão. Este roteiro fecha esse elo.

Leva uns 5 minutos. Faça num momento de calma, não no meio de um atendimento.

---

## Antes de começar

Anote o saldo que está na tela hoje, para comparar no fim:

> **A empresa deve a você: R$ ____________**

O valor esperado hoje é **R$ 5.758,30**.

---

## 1. Login e Conta do Víctor

1. Abra o app e faça login.
2. Toque em **Conta do Víctor** na barra de abas.
3. Confira:
   - [ ] O saldo no topo bate com o que você anotou
   - [ ] "Você financiou" mostra **R$ 28.199,30**
   - [ ] "Já recebeu de volta" mostra **R$ 22.441,00**
   - [ ] "Saldo inicial da conta" mostra **R$ 9.134,30** em 07/06/2026, marcado como *apuração histórica*
   - [ ] O extrato lista os movimentos, do mais recente para o mais antigo
   - [ ] Cada linha mostra o saldo depois daquele movimento
   - [ ] No celular aparecem **cartões**, não uma tabela que você precisa arrastar de lado

4. Teste os filtros:
   - [ ] Filtrar por *Reembolso recebido* mostra só os reembolsos
   - [ ] **O saldo do topo NÃO muda** ao filtrar — só os totais do período
   - [ ] "Limpar filtros" volta tudo

---

## 2. Venda controlada

Use um produto e um valor que você não se importe de cancelar em seguida.

5. Anote o estoque atual do produto: **______ caixas**
6. Lance uma venda de **1 caixa**.
7. Confira:
   - [ ] A venda aparece no Histórico **uma única vez**
   - [ ] O estoque caiu exatamente 1 caixa
   - [ ] A Auditoria registra a venda **no seu nome**

8. **Teste do retry:** volte à tela de venda e tente lançar a mesma venda de novo,
   tocando no botão duas vezes seguidas.
   - [ ] O app avisa que já está salvando, ou diz que a venda já estava salva
   - [ ] **Não aparecem duas vendas** no Histórico
   - [ ] O estoque caiu só 1 caixa no total

9. Volte à **Conta do Víctor**:
   - [ ] **O saldo continua o mesmo.** Vender não muda o que a empresa te deve.

---

## 3. Cancelamento

10. No Histórico, cancele a venda que você acabou de fazer.
11. Confira:
    - [ ] O estoque voltou ao número que você anotou no passo 5
    - [ ] A venda aparece como cancelada, com motivo
    - [ ] A Auditoria registra o cancelamento **no seu nome**

12. Volte à **Conta do Víctor**:
    - [ ] **O saldo continua o mesmo do início.** Cancelar também não muda a dívida.

---

## 4. Conferência final

13. Volte ao **Dashboard**:
    - [ ] O card "Conta do Víctor" mostra o mesmo saldo da aba
    - [ ] "Valor total em estoque" voltou ao valor de antes da venda

14. Vá em **Financeiro**:
    - [ ] O card "Conta do Víctor" mostra o mesmo saldo
    - [ ] O botão "Ver extrato completo" leva para a aba

15. Saldo final: **R$ ____________** — tem que ser igual ao do passo inicial.

---

## O que NÃO fazer neste teste

**Não lance um reembolso de verdade só para testar.** Reembolso movimenta dinheiro real e
reduz a dívida da empresa com você. Quando houver um reembolso legítimo para fazer, aí sim:
lance normalmente e confira que o saldo da Conta do Víctor cai exatamente aquele valor.

---

## Se algo não bater

Me diga **qual passo** e **o que apareceu na tela** em vez do esperado. Com o número do passo
eu consigo isolar rápido — cada um exercita uma parte diferente do sistema.
