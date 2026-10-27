# Portal da Logística na Cloudflare (Pages + Functions + D1)

**Estado:** código pronto na branch `claude/worker-d1-senha`, aguardando teste no preview da Cloudflare.
O GitHub Pages (`github.io`) segue com Firebase e não é afetado: o caminho Cloudflare só liga em `*.pages.dev`.

## Arquitetura
- **Pages** publica a pasta `static/` (o front).
- **Pages Functions** em `functions/api/[[route]].js` é a API `/api/*`.
- **D1** guarda `usuarios` (perfil, ferramentas, senha com hash), `acoes`, `acoes_log` e `tentativas` (limite de tentativas). Schema em `db/schema.sql`.
- **Login:** e-mail + senha conferidos pelo Worker (PBKDF2, 100k iterações). A sessão é um cookie assinado, `HttpOnly`, `Secure`, `SameSite=Strict`, válido 12 h.
- Quem não está em `usuarios` não entra (403). Administradores iniciais (`v.tozeti@`, `m.milani@`) são sempre TI.

## Passo a passo de deploy
1. **D1:** crie o banco `portal-logistica` e rode o `db/schema.sql` (ou só o `ALTER TABLE usuarios ADD COLUMN senha TEXT;` + o `CREATE TABLE tentativas` se as tabelas já existirem).
2. **Pages:** projeto ligado ao repo, build vazio, saída `static`.
3. **Bindings:** D1 com nome `DB`.
4. **Secrets** (Settings → Variables and secrets, tipo *Secret*):
   - `SESSION_SECRET`: string longa aleatória (ex.: 64 caracteres).
   - `TOKEN_SECRET`: outra string longa aleatória.
5. Remova as variáveis `ACCESS_TEAM` e `ACCESS_AUD` se criou no passo antigo (não são usadas).
6. Faça um redeploy (as variáveis só valem no próximo deploy).
7. **Primeiro acesso:** abra o endereço, digite `v.tozeti@pharmaesthetics.com.br` e uma senha de 8+ caracteres. Esse campo define a senha da primeira vez. Depois, entre normalmente.

## Contrato da API
| Rota | Quem | Descrição |
|---|---|---|
| `POST /api/login` | público | `{email, senha}` → cookie de sessão. Erros: `credenciais`, `primeiro-acesso` (409), `bloqueado` (429) |
| `POST /api/primeiro-acesso` | público (só conta sem senha) | `{email, senha}` define a senha e entra |
| `POST /api/logout` | — | apaga o cookie |
| `GET /api/me` | logado | `{email, perfil, ferramentas, acessoCusto}` |
| `POST /api/senha` | logado | `{atual, nova}` |
| `GET /api/token` | logado | `{token, exp}` assinado com `TOKEN_SECRET`, 5 min (para a Azure) |
| `GET /api/usuarios` | ti | lista |
| `PUT /api/usuarios/{email}` | ti | `{perfil?, ferramentas?, acessoCusto?, resetar_senha?}` |
| `POST /api/usuarios/lote` | ti | `{itens:[...]}` |
| `DELETE /api/usuarios/{email}` | ti | remove |
| `GET /api/acoes` | logado | NFs ignoradas/tratadas |
| `PUT /api/acoes/{id}` | logistica/ti | `{tipo, motivo, nf, filial}`; grava o log |
| `DELETE /api/acoes/{id}` | logistica/ti | reativa; grava o log |
| `GET /api/acoes/log?id=` | ti | última mudança da NF |
| `GET /api/perfis` | admin | `{catalogo, perfis}`: o catálogo de ferramentas e, por perfil, a lista `permissoes` e quantas pessoas têm |
| `PUT /api/perfis/{nome}` | só v.tozeti | cria/altera `{rotulo, permissoes:[ids do catálogo]}`; `ti` sempre pode tudo |
| `DELETE /api/perfis/{nome}` | só v.tozeti | apaga perfil sem pessoas; os padrão (ti, logistica, leitor) não se apagam |

**Perfis (26/10, permissões por ferramenta desde 27/10):** o perfil diz o que a pessoa **pode fazer**, com **uma permissão por
ferramenta** (catálogo `CATALOGO` no Worker): `nf_ignorar` (ignorar/reativar NF), `nf_ver_ocultas` (ver as notas ocultas, com motivo)
e `admin` (Usuários e log). As ferramentas que ela **abre** continuam marcadas por pessoa. Sem nenhuma permissão do Monitor, a pessoa
só vê as travadas e as que subiram; `/api/acoes` devolve a ela só o `id` das ocultas (sem motivo). **Ferramenta nova** (ex.: "limpar
notas"): 1 linha no `CATALOGO` + `exigir(u, "<id>")` na rota + `PortalGate.pode("<id>")` na tela; a caixinha aparece sozinha.
Padrão: TI (tudo), Logística (`nf_ignorar`, `nf_ver_ocultas`), Somente leitura e Faturamento (nada). Ficam na tabela `perfis`
(coluna `permissoes` em JSON); rode a **migração** de `db/schema.sql`. Sem ela o Worker usa os 4 padrão e recusa perfil novo com
`409 migracao-pendente`.

`resetar_senha: true` (tela Usuários, via `PUT`) apaga a senha; a pessoa define outra no próximo acesso.

## Pendências (não feitas)
- **Azure:** `firebase_auth.py` ainda só aceita o token do Firebase. Precisa aceitar o `/api/token` validando a assinatura com `TOKEN_SECRET` (guardado no Key Vault). Mudança de produção: branch, teste e só depois a `main`.
- **Trocar senha pela tela:** a API existe (`POST /api/senha`), mas ainda não há botão no site.
- **Migração dos dados:** `usuarios` pelos 10 INSERTs do chat; `acoes` ainda não migradas (aguardando exportação do Firestore).
- **Risco aceito:** no primeiro acesso, qualquer pessoa que souber o e-mail de uma conta autorizada **sem senha** pode definir a senha antes do dono. Mitigação: ativar as senhas logo após o deploy e usar `resetar_senha` se alguém fizer isso.
- **Arquivos estáticos** (HTML/JS) são públicos, como já eram no Pages. Os dados passam pela API, que exige login.

## Teste feito (26/10)
Só o front, com servidor simulado: login sem API mostra "Não foi possível falar com o servidor", e o formulário aparece. Modo Cloudflare com `/api/me` simulado: painel, ações e usuários funcionam. **Não testado:** o Worker real (sem Node/Wrangler nesta máquina), o D1 e o fluxo completo de login. Isso só se testa no preview do Pages.
