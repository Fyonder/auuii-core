# Subir o AUUII CORE no Render

## Por que o build falhou

```
failed to read dockerfile: open Dockerfile: no such file or directory
```

O serviço no Render está no runtime **Docker**, que procura um `Dockerfile` na
raiz do repo. Esse repo não tinha nenhum — ele é só `docker-compose` apontando
para imagens que já existem no registry (`n8nio/n8n` e `evoapicloud/evolution-api`).

Dois pontos que mudam o desenho em relação à VPS:

- O Render **não executa `docker-compose`**. Cada serviço do compose vira um
  serviço separado no Render.
- Não existe a rede interna `auuii-net`. O n8n fala com a Evolution pela URL
  pública `https://auuii-evolution.onrender.com`, não por `http://evolution:8080`.

A solução são os dois `Dockerfile` na raiz. Eles não constroem nada:

```dockerfile
FROM docker.n8n.io/n8nio/n8n:latest
```

É só um ponteiro para a mesma imagem que o compose já usa. O build no Render
vira um pull de poucos segundos, e `ENTRYPOINT`, `CMD` e `USER` vêm todos da
imagem oficial. Existem porque o runtime Docker exige um `Dockerfile` — inclusive
em serviço criado à mão pelo painel, que sempre nasce nesse runtime.

| Arquivo | Serviço |
|---|---|
| `Dockerfile.n8n` | `auuii-n8n` |
| `Dockerfile.evolution` | `auuii-evolution` |

---

## 1. Criar o Blueprint

No Render: **New → Blueprint** → escolha o repo `Fyonder/auuii-core` → `Apply`.

Ele lê o `render.yaml` e cria três coisas:

| Recurso | O que é |
|---|---|
| `auuii-n8n` | painel + webhooks do agente (porta 5678) |
| `auuii-evolution` | ponte com o WhatsApp (porta 8080) |
| `auuii-evolution-db` | postgres da Evolution — a v2 não sobe sem |

O primeiro deploy vai subir com algumas variáveis vazias. Isso é esperado: as
URLs públicas só existem depois que o Render cria os serviços.

---

## 2. Ou consertar um serviço que já existe

Se você já criou os serviços à mão e não quer refazer, o `render.yaml` não vai
ajudar: **ele só vale para serviços criados por um Blueprint.** Serviço feito à
mão ignora esse arquivo para sempre.

Nesse caso, aponte o Dockerfile na unha, em **Settings → Docker Build Context /
Dockerfile Path** de cada serviço:

| Serviço | Dockerfile Path |
|---|---|
| o do n8n | `./Dockerfile.n8n` |
| o da Evolution | `./Dockerfile.evolution` |

E preencha as variáveis do passo 3 na mão — inclusive as que o Blueprint geraria
sozinho (`N8N_ENCRYPTION_KEY` e `AUTHENTICATION_API_KEY`, com
`openssl rand -hex 32`), mais `PORT`/`N8N_PORT` = `5678` no n8n e
`PORT`/`SERVER_PORT` = `8080` na Evolution.

Só não esqueça: a `AUTHENTICATION_API_KEY` da Evolution tem que ser colada como
`EVOLUTION_API_KEY` no n8n. No Blueprint isso é automático; à mão, não.

---

## 3. Preencher as variáveis que faltam

Anote as duas URLs que o Render gerou (`Settings → URL` em cada serviço) e
preencha em **Environment**:

Em `auuii-evolution`:

```env
SERVER_URL=https://auuii-evolution.onrender.com
```

Em `auuii-n8n`:

```env
N8N_HOST=auuii-n8n.onrender.com
N8N_PUBLIC_URL=https://auuii-n8n.onrender.com
N8N_WEBHOOK_URL=https://auuii-n8n.onrender.com
N8N_EDITOR_BASE_URL=https://auuii-n8n.onrender.com
EVOLUTION_API_URL=https://auuii-evolution.onrender.com
AUUII_API_URL=https://ifood.onrender.com
AUUII_API_TOKEN=<mesmo valor de SUPORTE_API_KEY no backend>
SUPORTE_WHATSAPP=<DDI+DDD+numero, só dígitos>
```

`N8N_ENCRYPTION_KEY` e `AUTHENTICATION_API_KEY` são geradas pelo próprio Render
(`generateValue`). O n8n puxa a chave da Evolution automaticamente, então
`{{ $env.EVOLUTION_API_KEY }}` continua funcionando dentro dos nós, igual na VPS.

Salve — cada serviço redeploya sozinho.

---

## 4. Conectar o WhatsApp

Com a Evolution no ar, crie a instância e leia o QR code:

```bash
curl -X POST https://auuii-evolution.onrender.com/instance/create \
  -H "apikey: SUA_AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"auuii","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```

Depois aponte o webhook da instância para o n8n
(`https://auuii-n8n.onrender.com/webhook/...`), como no fluxo em
`n8n/workflows/meu-sulporte-unico.json`.

---

## Custo e limites

Isso **não roda no plano free**. Dois motivos:

- O plano free não tem disco. Sem disco, a Evolution perde a sessão do WhatsApp
  e o n8n perde os fluxos e credenciais a cada deploy.
- Serviço free dorme depois de 15 min sem tráfego. Um agente de WhatsApp
  precisa estar acordado o tempo todo.

Contas: 2 × Starter ($7/mês cada) + 2 × disco de 1 GB ($0,25/mês cada) +
postgres `basic-256mb`. Se quiser cortar, o postgres `free` funciona, mas
expira em 30 dias.

Para comparação, a VPS única (`docs/DEPLOY-VPS.md`) roda os três containers com
HTTPS pelo Caddy por volta do mesmo preço, e com a rede interna que o compose
espera.

---

## Se der erro

**n8n com `EACCES` no `/home/node/.n8n`** — o disco do Render subiu com dono
`root` e o n8n roda como `node`. Nesse caso, troque o SQLite por postgres: crie
um segundo banco no Render e ponha no `auuii-n8n`:

```env
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=<host do banco>
DB_POSTGRESDB_PORT=5432
DB_POSTGRESDB_DATABASE=n8n
DB_POSTGRESDB_USER=n8n
DB_POSTGRESDB_PASSWORD=<senha>
DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false
```

E remova o bloco `disk:` do `auuii-n8n` no `render.yaml`.

**Evolution reiniciando com erro de migration** — confira se o
`DATABASE_CONNECTION_URI` está apontando para a *Internal Database URL* do
postgres, não a externa.

**`Port scan timeout`** — o Render não achou a porta aberta. Verifique se `PORT`
bate com `N8N_PORT` (5678) ou `SERVER_PORT` (8080) no serviço em questão.

**`failed to read dockerfile: open Dockerfile: no such file or directory`** — o
serviço está procurando `Dockerfile` na raiz, que não existe (são
`Dockerfile.n8n` e `Dockerfile.evolution`). Ou o serviço foi criado à mão e não
lê o `render.yaml` — veja o passo 2.
