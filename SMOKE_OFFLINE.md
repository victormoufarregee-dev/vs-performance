# Smoke test offline — roteiro para o Victor

**Status: `DEPENDE DO VICTOR — smoke offline autenticado`**

Precisa da sessão real (login feito por você) e de um celular de verdade. Nenhum destes
testes foi feito por mim em produção: eu não crio venda real para testar. Use um produto e
um cliente de teste, e **cancele as vendas de teste no fim** (Vendas → Cancelar), anotando o
motivo "Teste offline".

Antes de começar: abra o app com internet, entre, e confirme que a barra do topo mostra a
versão nova (se aparecer "Nova versão do app disponível", toque em **Atualizar agora**).

---

## Teste A — online (nada mudou para o uso normal)

1. Com internet, lance uma venda de teste de 1 frasco/caixa.
2. **Esperado:** toast "Venda registrada!", a venda aparece em Vendas, o estoque baixa.
3. Nenhuma barra de "guardado neste aparelho" aparece.

## Teste B — offline de verdade (12 passos)

1. Com internet, anote o estoque do produto de teste.
2. Ligue o **modo avião** (ou desligue Wi-Fi e dados).
3. **Esperado:** barra do topo "📴 Sem internet."
4. Lance uma venda de teste.
5. **Esperado:** toast **"Salvo neste aparelho. Será enviado quando a conexão voltar."**
   — **não** pode aparecer "Venda registrada!".
6. **Esperado:** barra "1 operação(ões) salvas neste aparelho." e botão **Ver**.
7. Toque em **Ver**: a venda aparece como **"Guardado neste aparelho"**.
8. **Feche o app por completo** (tire da lista de apps abertos). Espere 1 minuto.
9. Abra o app de novo, ainda em modo avião. **Esperado:** a barra continua mostrando 1
   operação salva (na tela de login ela diz "Entre no app para enviar").
10. Desligue o modo avião e entre no app (se pedir login, faça o login).
11. **Esperado:** em alguns segundos, toast "1 operação(ões) guardada(s) no aparelho foram
    enviadas e confirmadas pelo servidor."; a barra some; a venda aparece em Vendas **uma
    vez só**; o estoque baixou **uma vez só**.
12. Toque no ícone de atualizar 🔄 e confira de novo: continua **uma** venda.

## Teste C — clique duplo

1. Modo avião ligado.
2. Preencha uma venda e toque **duas vezes rápido** em Registrar.
3. **Esperado:** no máximo o aviso "Já estou salvando esta venda — aguarde."; em **Ver**
   aparece **uma** operação.
4. Desligue o modo avião. **Esperado:** **uma** venda em Vendas.

## Teste D (opcional) — conflito de estoque

Só se tiver um produto de teste com **1** unidade:

1. No celular, modo avião, venda dessa última unidade → "Salvo neste aparelho".
2. No computador (com internet), venda a mesma última unidade → "Venda registrada!".
3. Desligue o modo avião no celular.
4. **Esperado:** toast "1 operação(ões) não puderam ser concluídas…"; em **Ver**, a venda
   aparece como **Conflito** com "Não foi possível concluir: o estoque mudou enquanto você
   estava offline."; ela **não** some e **não** é reenviada sozinha. Toque em **Cancelar esta
   operação** para descartar.

---

## O que me mandar

Para cada teste: ✅ ou ❌, e print da tela no passo que deu diferente. Diga também o
aparelho e o navegador (ex.: iPhone 13, Safari, app instalado na tela inicial ou não).
