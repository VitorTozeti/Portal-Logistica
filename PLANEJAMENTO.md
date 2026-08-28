# Portal da Logística — Planejamento

> **Documento vivo.** É a fonte da verdade do plano do projeto. Atualizado a cada avanço.
> Última atualização: **2026-08-28**.
> Conhecimento detalhado (engenharia reversa do robô, decisões, dados) mora no vault Obsidian,
> projeto `proj/portal-logistica` (hub `portal-logistica-portal`).

---

## 1. O que é o portal

Portal web interno (**Logística + TI**) que mostra, **ao vivo**, o estado das NFs:

- **NFs que subiram** — processaram com sucesso.
- **NFs travadas** — com **qual é o problema** e **há quanto tempo** estão paradas.

Regras de negócio de "o que é uma NF com problema" = **engenharia reversa completa do robô de
expedição** (3 motores, todos os filtros). Está no vault: `portal-logistica-nfs-problema`.

Versão atual: **B4You**. Depois: **Unilog** (troca só a família de códigos; o encanamento não muda).

---

## 2. Arquitetura de deploy — 3 camadas, CUSTO ZERO (fechada 28/08, aval do gestor)

O problema central: o front vai estar **público no GitHub**, e o navegador do usuário (na
internet) **não alcança** as fontes internas (`O:\`, SAP HANA, B4You) — elas só existem dentro
da rede da Pharmaesthetics. A ponte:

```
  SERVIDOR PHARMA (rede interna)        AZURE — rg-logistica-volumetria (já existe)     GITHUB PAGES
 ┌────────────────────────┐           ┌────────────────────────────────────────────┐  ┌───────────┐
 │ 1. AGENTE COLETOR       │           │ 2. Storage Account stescolhasfrete          │  │ 4. Front  │
 │   (os *_feed.py de hoje)│──POST────▶│    └─ tabela NOVA: nfsportal (a criar)      │  │  estático │
 │   lê O:\, HANA, B4You   │ HTTPS ↑   │                                             │  │ (público) │
 │   SÓ FAZ SAÍDA          │ (saída)   │ 3. Container App ca-calculadora-frete       │◀─│ live conn │
 │   nada entra na rede    │           │    └─ rotas NOVAS /v1/portal/* (SSE) + auth │SSE│          │
 └────────────────────────┘           └────────────────────────────────────────────┘  └───────────┘
```

**Por que custa zero:** nenhum recurso Azure novo. A Storage Account e o Container App **já
existem** (são da calculadora de frete) e já rodam 24/7 pagos. Só se acrescenta uma **tabela**
nova (Table Storage é schemaless por tabela, custo só de transação — centavos) e **rotas** novas.

**Por que funciona sem VPN:** o firewall interno bloqueia **entrada** mas libera **saída**.
Então quem está dentro (o coletor) **empurra** o dado pra fora; nada precisa entrar na rede.
É o padrão webhook/mensageria (megaBrain).

### Recursos Azure reais (já existentes)
| Recurso | Nome | Uso no portal |
|---|---|---|
| Storage Account | `stescolhasfrete` | tabela nova `nfsportal` guarda o estado das NFs + ignorar/ações |
| Container App | `ca-calculadora-frete` | rotas novas `/v1/portal/*` (SSE + POST de ingestão) |
| Resource Group | `rg-logistica-volumetria` | (eastus) |
| Key Vault | `kv-logistica-frete` | segredos (auth), se necessário |

### ⚠️ Regras invioláveis da arquitetura
1. **Somente leitura nas fontes.** O portal NUNCA grava `transferencias.csv`, NUNCA cancela na
   B4You, NUNCA gera etiqueta de marketing. Só lê e diagnostica.
2. **Independente do robô.** O coletor lê as fontes sozinho; não depende do robô estar rodando.
3. **Auth obrigatória** na `/v1/portal/*` — o front é público; sem auth, as NFs da Pharma
   ficariam visíveis na internet. Mínimo: HTTP Basic (já usado pela API). Depois: Entra ID.
4. **Identidade da NF é composta `filial:nf`.** O número da NF colide entre Varejo (BPLId 3) e
   Atacado (BPLId 4) — séries independentes. Toda chave (hub, front, diff, tabela) usa `filial:nf`.
5. **Rotas isoladas** sob `/v1/portal/*` — não misturar com as rotas da calculadora de frete
   (que é API crítica e síncrona do ERP).

---

## 3. As 4 fontes de dado (os feeds) — 100% reais, só-leitura

Reproduzem exatamente os 4 grupos do email de alerta do robô:

| Feed (arquivo) | Grupo | Fonte read-only | Espelha (no robô) |
|---|---|---|---|
| `feed.py` | log mestre (Motor 2) | `controle_pedidos_mestre.csv` (Varejo+Atacado, em `O:\Logística\0 - B4YOU\`) | `gerar_excel_validacao` (regra 2 strikes) |
| `sap_feed.py` | 🚨 barradas/transferências (Motor 1) | SAP HANA (SELECT) + B4You `GET /pedido/listar` | `buscar_notas_barradas_sap` — sem gravar transferencias.csv |
| `marketing_feed.py` | 🏷️ etiquetas marketing | `controle_etiquetas_marketing.csv` (Status=ERRO) | `etiqueta_marketing` — só LÊ, não gera |
| `canc_feed.py` | ↩️ cancelamento | SAP HANA canceladas (SELECT) + B4You (GET) | diagnóstico de `processar_cancelamentos` — sem DELETE |

Credenciais: por padrão o coletor empresta o `.env` do robô (mesma máquina), sem depender do
robô rodar. Detalhe de onde cada dado vive: vault `portal-logistica-dados`.

---

## 4. Fases do projeto

### ✅ Fase 0 — Validar local (EM ANDAMENTO)
O portal rodando na sua máquina (`127.0.0.1:8000`), lendo as fontes reais, para você conferir
que o dado bate 100% com o email do robô — **antes** de montar a ponte Azure.

- [x] Live connection SSE ponta-a-ponta (hub + feed + front `EventSource`)
- [x] Feed 100% real (os 4 feeds, batendo com o email de alerta)
- [x] Identidade `filial:nf` (colisão Varejo/Atacado resolvida)
- [x] Limpeza de resolvidas (NF que volta ao normal sai da tela)
- [x] **Versionar o código** (git init + `.gitignore`) — feito 28/08
- [x] **Cronômetro "travada há X"** no front (usa `travada_desde`; fica vermelho ≥4h) — feito 28/08
- [x] **Detalhe da NF em painel lateral (drawer)** — clicar no card abre um painel à direita no
  formato do mockup do gestor (28/08): eyebrow "Nota travada" + NF, pills **categoria** +
  **Responsável**, linhas Transportadora/Pedido/Cliente/Travada há, **alerta colorido** com
  título+texto do problema, seção **Soluções rápidas** (cards contextuais) e rodapé.
- [x] **Cor por tipo de erro nas tags** (28/08) — cada categoria/grupo tem uma cor
  (financeiro âmbar, faturamento azul, barrada SAP vermelho, marketing rosa, B4You teal,
  transportadora laranja, cancelamento cinza, rastreio índigo); tinge a tag do card, a borda
  esquerda e o alerta do painel. Mapa em `CORES` no `index.html`.
- [x] **Cronômetro em segundos** ao vivo (atualiza no lugar, sem reconstruir o card).
- [~] **Ações e soluções ainda INATIVAS (por decisão, 28/08)** — os botões **🚫 Ignorar nota**
  e os cards de **Soluções rápidas** existem no painel mas não têm ação (aviso "em breve").
  Backend de ocultar pronto (`acoes.py` + rotas `/acoes/*`); religar quando for a hora.
- [ ] **Puxar Pedido e Cliente via SAP** (hoje "—") — **não existem no log mestre** (17 colunas
  canônicas, sem Cliente/Pedido — `tools/reparar_log_mestre.py`); só vêm do SAP (`OINV.CardName`
  + nº do pedido) por NF. Enriquecer o feed com um lookup HANA read-only (reusa `sap_feed`).
  **Adiado por decisão (28/08)**: o drawer da nota que subiu mostra Transportadora/Filial/NF/
  Subiu em; Cliente/Pedido entram quando o lookup SAP for ligado.
- [x] **Filtro por tipo de erro** na coluna Travadas (28/08) — chips clicáveis por
  `problema_categoria` (Faturamento, Arquivos, Correios, Financeiro, B4You, Transportadora,
  Transferência, Auditoria SAP, Marketing, Cancelamento), cada um com contagem e cor;
  toggle liga/desliga, "limpar filtro" reativa todos, contador vira "visíveis/total"
- [x] **Filtro refatorado (genérico p/ as 2 colunas) (28/08)** — mesmo renderer de chips serve
  Travadas (por tipo de erro) e Subiram (por semana).
- [x] **Subiram = notas reais clicáveis + filtro por semana (28/08)** — seletor de semana ISO
  (Esta semana / Semana passada / semanas com contagem / Todas), default = semana atual; clicar
  abre o drawer com Transportadora/Filial/NF/Subiu em. `MAX_SUBIRAM` 40→400 (env
  `PORTAL_MAX_SUBIRAM`) p/ haver histórico de semanas.
- [x] **Boleto (`BOLETO_AUSENTE`) só-aviso (28/08)** — o drawer mostra "Resolve sozinha" (some
  quando o boleto for salvo; ação do Contas a Receber) e **não** oferece botão de solução nem
  "Ignorar".
- [x] **Paleta Pharmaesthetics — modo automático (28/08)** — segue o `prefers-color-scheme` do
  sistema: **claro** = paleta nova Pharma (Azul Pharma `#0A3AAE` + navy `#134E7A` + acento
  `#008CFF`); **escuro** = a paleta escura antiga (bg `#0c1016`, subiu verde `#41c47e`, brand
  azul claro `#5b9bff`). Fonte Montserrat (Google Fonts, fallback system-ui). Portal e login.
- [ ] Ajuste fino do front (responsividade mobile)

**Fase 0 essencialmente fechada** — falta só ajuste fino. Validado ao vivo em 28/08: 12
travadas batendo com o email (boleto, transferência, marketing), cronômetro e ações OK.

### ⬜ Fase 1 — A ponte (multiusuário)
Expor o portal para o time via a arquitetura da seção 2.

- [ ] Criar a tabela `nfsportal` na `stescolhasfrete` (via Python SDK — a máquina não tem `az`)
- [ ] Adicionar as rotas `/v1/portal/*` no `ca-calculadora-frete` (GET estado + SSE + POST ingestão)
- [ ] **Auth** nas rotas (HTTP Basic no mínimo)
- [ ] Adaptar os feeds para o modo **coletor**: em vez de publicar no hub local, dar POST na Azure
- [ ] Instalar o coletor como serviço/tarefa agendada no servidor do robô (de pé 24/7)
- [ ] Publicar o front no **GitHub Pages** apontando para a API da Azure
- [ ] ⚠️ Validar o deploy com cuidado (a API é compartilhada com a calculadora, que é crítica)

### ⬜ Fase 2 — Unilog + extras
- [ ] Versão **Unilog** (troca a família de códigos B4You; SAP/log/encanamento não mudam)
- [x] **Login interino** (senha compartilhada via `.env`→GitHub Secrets, 2 perfis TI/Logística) — feito 28/08, ver `auth.py`
- [ ] Login **Entra ID** (restrito a Logística/TI) — substitui o login interino acima
- [ ] Página de **OTIF** (reaproveita as medidas DAX do robô OTIF)
- [ ] Botões de solução rápida por nota (re-rotear, reprocessar etiqueta, etc.)

---

## 5. Estrutura do código (Fase 0)

```
Portal Logistica/
├── app.py            # FastAPI: /login+/logout, middleware auth, /stream (SSE), /api/nfs, /acoes/*, / (front)
├── auth.py           # login 2 perfis (TI compartilhado + Logística cadastrada); .env; cookie HMAC
├── .env.example      # template das credenciais de acesso (viram GitHub Secrets no deploy)
├── hub.py            # pub/sub em memória (chave = filial:nf); não sabe nada de SAP/B4You
├── feed.py           # orquestrador + Motor 2 (log mestre); chama os outros feeds a cada 20s
├── sap_feed.py       # Motor 1 — barradas/transferências (SAP HANA + B4You)
├── marketing_feed.py # etiquetas marketing (CSV Status=ERRO)
├── canc_feed.py      # cancelamentos que precisam de ação manual
├── static/login.html # tela de login (Usuário/Senha + seletor Logística/TI)
├── static/index.html # front (EventSource) — Travadas / Subiram
├── requirements.txt
├── README.md
└── PLANEJAMENTO.md   # este arquivo
```

- Rodar: `pip install -r requirements.txt` → `uvicorn app:app --reload` → `http://127.0.0.1:8000`
- `PORTAL_POLL_SEGUNDOS` (default 20) controla o intervalo do polling.

---

## 6. Estado atual e próxima ação

- **Feito:** os 4 grupos do email reproduzidos ao vivo, 100% reais, read-only, batendo com o
  email do robô. Arquitetura de deploy fechada com o gestor (seção 2).
- **Agora (Fase 0):** versionar o código, cronômetro "travada há X" e ações por nota (ignorar/tratada).
- **Depois (Fase 1):** a ponte Azure — só quando o dado local estiver 100% validado por você.
