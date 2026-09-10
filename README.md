# AUUII CORE

Stack do **AUUII** — o agente autônomo que atende clientes, entregadores e
restaurantes no WhatsApp, consultando o backend da Auuii.

Sobe com **um comando**, em containers na **mesma rede Docker** (`auuii-net`),
na sua máquina ou numa VPS.

```
┌──────────────── auuii-net (rede Docker) ─────────────────┐
│                                                           │
│  Caddy ──► n8n:5678  ◄───── webhook ─────  evolution:8080 │
│  (HTTPS)   (cérebro)  ────── envia msg ──►  (WhatsApp)    │
│               │                                 │         │
│               │                    evolution-db:5432      │
│               │                    (só a Evolution usa)   │
└───────────────┼───────────────────────────────────────────┘
                │  HTTPS
                ▼
   seu backend hospedado — AUUII_API_URL/api/suporte/*
```

| Serviço | Container | Endereço interno | O que faz |
|---|---|---|---|
| n8n | `auuii-n8n` | `http://n8n:5678` | fluxos, IA, ferramentas do agente |
| Evolution API | `auuii-evolution` | `http://evolution:8080` | conexão com o WhatsApp |
| PostgreSQL | `auuii-evolution-db` | `evolution-db:5432` | banco interno da Evolution |
| Caddy | `auuii-caddy` | — | HTTPS automático (só no modo produção) |

**A API de negócio não está aqui.** É o seu backend já hospedado, em
`AUUII_API_URL`. O n8n chama `/api/suporte/*` nele pela internet — nada de
CRUD duplicado dentro da stack.

> Como estão na mesma rede, os containers se enxergam **pelo nome do serviço**.
> Dentro do n8n você chama a Evolution em `http://evolution:8080` — sem passar
> pela internet, sem precisar de domínio, sem CORS.

O n8n guarda os fluxos em **SQLite** dentro do volume `auuii_n8n_data`. Sem
banco externo, menos peça para dar problema.

---

## Pré-requisitos

- Docker Engine 24+ e Docker **Compose v2.24+** (`docker compose version`)

---

## Subir na sua máquina

```bash
cp .env.example .env   # se ainda não existir
./deploy.sh
```

- n8n → http://localhost:5678
- Evolution → http://localhost:8080 (painel em `/manager`)

## Subir numa VPS

```bash
./deploy.sh prod
```

Antes, aponte os DNS para o IP da VPS e preencha `N8N_DOMAIN`,
`EVOLUTION_DOMAIN` e `ACME_EMAIL` no `.env`. O Caddy emite os certificados
sozinho. Passo a passo em [docs/DEPLOY-VPS.md](docs/DEPLOY-VPS.md).

No modo `prod` as portas 5678 e 8080 **deixam de ser publicadas**: só 80/443
ficam expostas. O banco nunca é exposto.

### Na Oracle Cloud (Always Free)

A VM ARM Ampere A1 do Always Free (até 4 vCPU / 24 GB, sem prazo) roda a stack
inteira de graça — as quatro imagens têm build `arm64`, então nada no repo muda.
O que é específico da Oracle (shape, as duas camadas de firewall, "Out of
capacity") está em [docs/DEPLOY-ORACLE.md](docs/DEPLOY-ORACLE.md); do Docker em
diante vale o guia da VPS.

### Em PaaS (Render e afins)

Não recomendado, e o [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md) explica por
quê: cada peça vira um serviço separado, some a rede interna `auuii-net`, o n8n
não cabe em 512 MB e qualquer plano que suspenda o processo por ociosidade
derruba a sessão do WhatsApp. Os arquivos `render.yaml` e `Dockerfile.*` existem
para esse caminho.

---

## Variáveis principais (`.env`)

| Variável | Para que serve |
|---|---|
| `EVOLUTION_DB_PASSWORD` | senha do postgres (usuário e banco são fixos: `evolution`) |
| `AUTHENTICATION_API_KEY` | chave global da Evolution (header `apikey`) |
| `N8N_ENCRYPTION_KEY` | criptografa as credenciais do n8n — **não mude depois** |
| `N8N_DOMAIN` / `EVOLUTION_DOMAIN` / `ACME_EMAIL` | domínios e e-mail do HTTPS |
| `N8N_PUBLIC_URL` / `EVOLUTION_PUBLIC_URL` | URLs públicas usadas nos webhooks |
| `AUUII_API_URL` | base do backend da Auuii que o agente consulta (`https://ifood.onrender.com`) |
| `AUUII_API_TOKEN` | chave das rotas `/api/suporte/*` — mesmo valor de `SUPORTE_API_KEY` no Render |
| `SUPORTE_WHATSAPP` | número que recebe o aviso de handoff (só dígitos, com DDI+DDD); vazio = sem aviso |
| `TESTE_TEL_CLIENTE` / `TESTE_TEL_MOTOBOY` / `TESTE_TEL_LOJA` | telefones reais usados por `./testar.sh api` |

O `.env` deste repositório já vem com senha e chaves **geradas aleatoriamente**.
Para gerar outras: `openssl rand -hex 32`.

> `EVOLUTION_DB_PASSWORD` é gravada no volume no primeiro boot. Se mudar depois,
> o banco continua com a senha antiga e a Evolution para de conectar.

---

## Onde cada coisa é guardada

| O quê | Onde |
|---|---|
| Fluxos e credenciais do n8n | SQLite no volume `auuii_n8n_data` |
| Sessão do WhatsApp | volume `auuii_evolution_instances` |
| Mensagens, contatos e chats do WhatsApp | banco `evolution` (a Evolution manda nele, não mexa na mão) |
| Memória da conversa do agente | RAM do n8n (Simple Memory) — reinicia junto com o container |
| Clientes, pedidos, entregadores, fila | **seu backend** — nada disso vive aqui |

Abrir o banco da Evolution, se precisar:

```bash
docker exec -it auuii-evolution-db psql -U evolution -d evolution
```

---

## Conectar o WhatsApp ao n8n

Guia detalhado em [docs/INTEGRACAO.md](docs/INTEGRACAO.md). Resumo:

1. Crie a instância na Evolution apontando o webhook para o n8n **pela rede
   interna** (`http://n8n:5678/webhook/auuii`).
2. Leia o QR Code.
3. Importe o fluxo de exemplo
   [`n8n/workflows/meu-sulporte-unico.json`](n8n/workflows/meu-sulporte-unico.json).

---

## Dar ferramentas ao agente

O agente consulta o **backend real da Auuii** (repositório `Auuii-Backend`) pelas
rotas `GET /api/suporte/*`: só leitura, chaveadas pelo telefone de quem fala,
protegidas por `SUPORTE_API_KEY`. Identidade vem do número do WhatsApp, nunca do
modelo. "Não achei" volta `200 {encontrado:false}` para o agente tratar como
resposta.

- contrato das rotas e como testar → [docs/API.md](docs/API.md)
- coleção do Postman → [postman/auuii-core.postman_collection.json](postman/auuii-core.postman_collection.json) (preencha `suporteKey` na aba Variables)
- fluxo com as tools já ligadas → [n8n/workflows/meu-sulporte-unico.json](n8n/workflows/meu-sulporte-unico.json) (número único; o perfil é descoberto pelo backend, desconhecido recebe um menu)

```bash
curl -H "x-suporte-api-key: $(grep ^AUUII_API_TOKEN= .env | cut -d= -f2)"   "$(grep ^AUUII_API_URL= .env | cut -d= -f2)/api/suporte/motoboy/perfil?telefone=5544999998888"
```

---

## Comandos do dia a dia

```bash
docker compose ps                      # status
docker compose logs -f n8n             # logs do n8n
docker compose logs -f evolution       # logs da Evolution
docker compose restart n8n             # reiniciar um serviço
docker compose down                    # parar tudo (dados preservados)
docker compose pull && ./deploy.sh     # atualizar imagens
```

Backup:

```bash
# banco da Evolution
docker exec auuii-evolution-db pg_dumpall -U evolution > backup-$(date +%F).sql

# fluxos do n8n (SQLite) e sessões do WhatsApp
docker run --rm -v auuii_n8n_data:/d -v "$PWD":/b alpine tar czf /b/n8n-$(date +%F).tgz -C /d .
docker run --rm -v auuii_evolution_instances:/d -v "$PWD":/b alpine tar czf /b/instances-$(date +%F).tgz -C /d .
```

---

## Estrutura

```
auuii-core/
├── docker-compose.yml         # a stack (local)
├── docker-compose.prod.yml    # camada de produção: Caddy + portas fechadas
├── Caddyfile                  # proxy reverso / HTTPS
├── deploy.sh                  # ./deploy.sh [prod]
├── render.yaml                # blueprint do Render (o compose não roda lá)
├── Dockerfile.n8n             # ponteiro p/ a imagem oficial — o Render exige um
├── Dockerfile.evolution       # idem, para a Evolution
├── .env / .env.example        # configuração
├── testar.sh                  # ./testar.sh [api|menu|cliente|motoboy|restaurante|qr]
├── n8n/workflows/             # o fluxo do agente, pronto para colar no canvas
├── postman/                   # n8n + backend hospedado
└── docs/                      # deploy (VPS, Oracle, Render), integração e contrato da API
```
