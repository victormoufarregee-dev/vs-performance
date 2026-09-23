# Backup semanal — como funciona e como restaurar

## O que existe

| camada | onde fica | quanto tempo | quem restaura |
|---|---|---|---|
| backup diário do Supabase (plano Pro) | dentro do Supabase | 7 dias (conferir em Database → Backups) | painel do Supabase, 1 clique |
| **backup semanal fora do Supabase** | GitHub Actions → workflow `backup` → artifacts | 90 dias | este roteiro |

O semanal existe para o dia em que o problema **é** o Supabase: conta bloqueada, projeto
apagado, cobrança suspensa, erro de alguém no painel. Ele roda toda segunda às 06:00 (São Paulo)
e pode ser disparado à mão em **Actions → backup → Run workflow**.

Cada execução:

1. copia o schema `public` inteiro (tabelas, dados, funções, policies, triggers, grants);
2. criptografa com AES-256 usando a senha `BACKUP_PASSPHRASE`;
3. **restaura a cópia num Postgres limpo e confere** contagem de cada tabela, caixa esperado,
   dívida com o Victor e valor do estoque contra a produção no mesmo instante. Se um número
   não bater, o workflow fica vermelho e o GitHub manda e-mail.

O resumo de cada execução mostra os números lado a lado (produção | restaurado).

**Fora do backup semanal:** as contas de login (`auth.users`). Elas continuam no backup diário
do Supabase. Numa perda total, Victor e Stefany criam a conta de novo e o `uid` novo entra em
`usuarios_autorizados`. Os dados do negócio não dependem do login.

## A senha

`BACKUP_PASSPHRASE` fica em dois lugares: no segredo do GitHub (para o workflow) e **num lugar
seu fora do GitHub** (gerenciador de senhas). Sem ela o arquivo não abre, nem para você, nem
para ninguém. Se trocar a senha, os backups antigos continuam abrindo só com a senha antiga.

## Restaurar (emergência)

1. GitHub → Actions → `backup` → execução mais recente verde → baixe o artifact
   `vsp-backup-AAAA-MM-DD` e descompacte.
2. Confira a integridade:
   `sha256sum -c vsp-backup-AAAA-MM-DD.sha256`
3. Abra a cópia (vai pedir a senha):
   `gpg --output vsp.dump --decrypt vsp-backup-AAAA-MM-DD.dump.gpg`
4. Num projeto Supabase **novo** (nunca por cima do atual sem decidir antes), pegue a string do
   Session pooler e rode:
   `pg_restore --dbname="<string do pooler>" --no-owner --clean --if-exists vsp.dump`
5. Crie os logins do Victor e da Stefany no Auth do projeto novo, ponha os `uid` em
   `usuarios_autorizados`, troque `SB_URL` e `SB_KEY` no `index.html` pelo projeto novo e
   publique.
6. Confira pelo app: Conta do Victor, caixa esperado e estoque têm de bater com o resumo da
   execução de onde veio o backup.

Apague o `vsp.dump` em claro quando terminar.
