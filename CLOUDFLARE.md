# Migração opcional para Cloudflare (Pages + Access + Worker)

**Estado: front PREPARADO, backend ainda não existe.** O GitHub Pages + Firebase segue sendo o único ambiente
ativo; nada muda para quem usa hoje. O código novo só liga em hosts `*.pages.dev`
(ou `portal.pharmaesthetics.com.br`) — ver `HOSTS_CF` em `static/portal-auth-cf.js`.

## Como o front escolhe o backend
`static/portal-auth.js` é o único que as telas usam (`window.PortalGate`). No início ele pergunta a
`PortalGateCF.quer()`: se o host é Cloudflare, devolve `PortalGateCF.montar(...)` (mesma interface, via `/api/*`);
senão segue o Firebase de sempre. `github.io`, arquivo local e servidor interno **não são afetados**.
`PortalGate.modo()` devolve `"firebase"` ou `"cloudflare"` (as telas de cadastro/senha usam isso).

## O que falta para ligar (fases)
1. **Cloudflare Pages**: projeto ligado ao repo, pasta de saída `static`, sem build. Gera `*.pages.dev`.
2. **Worker `/api/*`** (rota no mesmo projeto Pages, Functions) + **D1** (ou KV) com as 3 coleções abaixo.
3. **Cloudflare Access** na frente do site inteiro: política "e-mails `@pharmaesthetics.com.br`" (login Microsoft
   ou código por e-mail). O Worker valida o JWT do cabeçalho `Cf-Access-Jwt-Assertion` em TODA rota `/api/*`.
4. **Migrar os dados** do Firestore (tela Usuários → exportar; `acoes` e `acoes_log`) para o D1.
5. **Azure**: `firebase_auth.py` passa a aceitar também o JWT do Access (JWKS do time Cloudflare) para as rotas
   `/v1/cobertura/*`; as duas verificações coexistem até o desligamento do Firebase.
6. Testar com login real em `*.pages.dev`, só então apontar o domínio e desligar o Firebase.

**Reversão:** basta não usar o host Cloudflare; o GitHub Pages continua publicando a cada push na `main`.

## Contrato do Worker (o que `portal-auth-cf.js` espera)
Identidade vem SÓ do cabeçalho do Access (o front nunca manda e-mail). Administradores iniciais
(`v.tozeti@`, `m.milani@`) são sempre `ti`, igual a `boot()` de `firestore.rules`. Sem registro em `usuarios` = 403.

| Rota | Quem | Resposta |
|---|---|---|
| `GET /api/me` | qualquer autorizado | `{email, perfil, ferramentas?, acessoCusto?}`; carimba `ultimoAcesso` |
| `GET /api/usuarios` | ti | `[{email, perfil, ferramentas?, acessoCusto?, ultimoAcesso(ms)}]` |
| `PUT /api/usuarios/{email}` | ti | corpo parcial `{perfil?, ferramentas?, acessoCusto?}` (perfil ∈ logistica/ti/leitor; ferramentas ≤ 20) |
| `POST /api/usuarios/lote` | ti | `{itens:[{email, perfil?, ferramentas?, acessoCusto?}]}` |
| `DELETE /api/usuarios/{email}` | ti | 204 |
| `GET /api/acoes` | qualquer autorizado | `[{id, tipo, motivo, nf, filial, em}]` |
| `PUT /api/acoes/{id}` | logistica/ti | `{tipo: ignorada\|tratada, motivo, nf, filial}`; Worker grava `em` e a linha do log com o e-mail do Access |
| `DELETE /api/acoes/{id}` | logistica/ti | 204; grava log "reativar" |
| `GET /api/acoes/log?id=` | ti | última mudança `{acao, por, motivo, em(ms)}` |
| `GET /api/token` | qualquer autorizado | `{token: <JWT do Access>, exp}` — usado como Bearer na API da Azure |

401/403 → o front trata como "sem acesso". Regras de negócio idênticas às de `firestore.rules`.

## Testado (26/10, local)
Servidor de teste simulando `/api/*` com o host liberado: painel, lista de ferramentas, `ocultar`, `ouvirAcoes`
e `listarUsuarios` funcionam em modo Cloudflare; em host comum o modo continua `firebase`. **Não testado:** o
Worker real, o Access e o login Firebase em `github.io` (a mudança ali é inerte).
