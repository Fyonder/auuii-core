# Como o n8n, a Evolution API e o backend da Auuii conversam

Os containers estão na rede `auuii-net`, então se chamam **pelo nome do serviço**.
Só a chamada ao backend da Auuii sai para a internet.

| De | Para | URL que você usa |
|---|---|---|
| n8n | Evolution | `http://evolution:8080` (`$env.EVOLUTION_API_URL`) |
| Evolution | n8n (webhook) | `http://n8n:5678/webhook/auuii` (número único; o perfil é descoberto pelo backend) |
| n8n | backend da Auuii | `$env.AUUII_API_URL` (`https://ifood.onrender.com`) + `/api/suporte/...` |
| Evolution | Postgres | `evolution-db` porta `5432` |

> Use `localhost` só no navegador. Dentro dos fluxos, **sempre** o nome do serviço
> ou a variável de ambiente.

---

## 1. Um número só, três públicos

Clientes, motoboys e restaurantes falam com o **mesmo número**. Uma instância na
Evolution, um webhook: `http://n8n:5678/webhook/auuii`. Quem descobre o perfil é
o nó **Identificar**, que pergunta ao backend (`GET /api/suporte/identificar`):

| Backend responde | O fluxo faz |
|---|---|
| `perfil: motoboy` (cadastro em `current`) | vai direto ao agente motoboy |
| `perfil: restaurante` (cadastro em `merchants`) | agente restaurante |
| `perfil: cliente` (escolheu no menu antes, ou tem pedido) | agente cliente |
| `perfil: null` | responde o **Menu** (1 cliente / 2 entregador / 3 restaurante) e grava a escolha com `PUT` na próxima mensagem |

Criar a instância já apontando o webhook para o n8n pela rede interna:

```bash
docker exec auuii-evolution sh -lc '
curl -s -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: $AUTHENTICATION_API_KEY" \
  -d "{
    \"instanceName\": \"auuii\",
    \"integration\": \"WHATSAPP-BAILEYS\",
    \"qrcode\": true,
    \"webhook\": {
      \"url\": \"http://n8n:5678/webhook/auuii\",
      \"byEvents\": false,
      \"base64\": true,
      \"events\": [\"MESSAGES_UPSERT\"]
    }
  }"'
```

Ou pelo painel: `http://localhost:8080/manager` (local) /
`https://evo.auuii.com/manager` (VPS), usando a `AUTHENTICATION_API_KEY`.

A resposta volta pela instância que recebeu a mensagem (`body.instance`);
`EVOLUTION_INSTANCE` no `.env` é o padrão para o modo teste e para o aviso de
handoff.

## 2. Ler o QR Code

```bash
curl -H "apikey: SUA_KEY" http://localhost:8080/instance/connect/auuii
```

Ou clique em **Connect** no manager. Status:

```bash
curl -H "apikey: SUA_KEY" http://localhost:8080/instance/connectionState/auuii
```

`./testar.sh qr` faz isso para a instância `EVOLUTION_INSTANCE` e salva o PNG.

---

## 3. Receber mensagens no n8n

Nó **Webhook**, método `POST`, path `auuii`. O corpo que a Evolution manda:

```jsonc
{
  "event": "messages.upsert",
  "instance": "auuii",
  "data": {
    "key": { "remoteJid": "5511999999999@s.whatsapp.net", "fromMe": false },
    "pushName": "Carlos",
    "message": { "conversation": "qual minha posição na fila?" }
  }
}
```

O nó `Normaliza` traduz isso (e também o corpo simples de teste
`{ "chatId", "message" }`) para os campos que o resto do fluxo usa:

| Campo | Expressão |
|---|---|
| `chatId` | `{{ $json.body?.data?.key?.remoteJid?.split('@')[0] ?? $json.body?.chatId ?? $json.sessionId }}` |
| `message` | `{{ $json.body?.data?.message?.conversation ?? $json.body?.data?.message?.extendedTextMessage?.text ?? $json.body?.message ?? $json.chatInput }}` |
| `nome` | `{{ $json.body?.data?.pushName ?? '' }}` |
| `canal` | `{{ $json.body?.data ? 'whatsapp' : 'teste' }}` |
| `instancia` | `{{ $json.body?.instance ?? $env.EVOLUTION_INSTANCE }}` |

Antes dele, o nó `E eco?` descarta mensagens do próprio bot
(`fromMe === true`) e mensagens sem texto (figurinha, áudio), respondendo `200`
com `{ ignorado: true }`.

---

## 4. Responder pelo n8n

Nó **HTTP Request** (`Enviar resposta`):

- Método: `POST`
- URL: `{{ $env.EVOLUTION_API_URL }}/message/sendText/{{ $json.instancia }}`
- Header: `apikey` = `{{ $env.EVOLUTION_API_KEY }}`
- Body (JSON): `{ "number": "<chatId>", "text": "<reply>" }`

> A `AUTHENTICATION_API_KEY` já é injetada no container do n8n como
> `EVOLUTION_API_KEY`, e a URL como `EVOLUTION_API_URL` — não precisa colar a
> chave dentro do fluxo.

Outros endpoints da Evolution que costumam ser úteis:

| Ação | Endpoint |
|---|---|
| Enviar mídia | `POST /message/sendMedia/<instancia>` |
| Enviar áudio | `POST /message/sendWhatsAppAudio/<instancia>` |
| "Digitando…" | `POST /chat/sendPresence/<instancia>` |
| Marcar como lida | `POST /chat/markMessageAsRead/<instancia>` |

---

## 5. O agente consultando o backend da Auuii

O agente **não acessa banco nenhum**. Cada tool é um nó *HTTP Request Tool* que
chama o backend real (repositório `Auuii-Backend`) em `/api/suporte/*`:

- URL: `{{ $env.AUUII_API_URL }}/api/suporte/<perfil>/<consulta>`
- Header: `x-suporte-api-key` = `{{ $env.AUUII_API_TOKEN }}`
- Query `telefone` = `{{ $('Normaliza').first().json.chatId }}` — fixo,
  nunca `$fromAI`. É isso que impede o modelo de consultar dados de terceiros.
- `$fromAI` só em parâmetros secundários: `status`, `raio`, `semana` e o
  desempate `loja` / `escolha`.

Contrato completo das rotas em [API.md](API.md). O que o fluxo espera:

| Resposta do backend | O que o agente faz |
|---|---|
| `encontrado: true` | responde com `statusTexto` e os campos devolvidos |
| `encontrado: false, motivo: nao_encontrado` / `sem_pedido` | diz que não há cadastro/pedido neste número e oferece o suporte |
| `encontrado: false, motivo: ambiguo, opcoes[]` | pergunta qual loja/cadastro e repete a tool com `loja` / `escolha` |
| `401` / `503` | o nó falha; o agente responde com `handoff: true` |

### Token

1. Gere um segredo: `openssl rand -hex 32`.
2. No Render (backend): variável `SUPORTE_API_KEY` = segredo.
3. No `.env` do auuii-core: `AUUII_API_TOKEN` = mesmo segredo, e
   `AUUII_API_URL=https://ifood.onrender.com`.
4. `docker compose up -d n8n` para o container reler o `.env`.

Memória da conversa: **Simple Memory** (janela de 12 mensagens por `chatId`), em
memória do n8n. Sem Postgres.

Saída do agente: o modelo responde em **texto puro** e, quando precisa de humano,
termina com a marca `[SUPORTE]`. O nó **Interpreta resposta** remove a marca e
monta `{ reply, handoff }`. Não pedimos JSON nem usamos o *Structured Output
Parser* do n8n: com tools ligadas, os modelos do Groq (gpt-oss e llama) tentam
entregar o JSON "chamando" uma tool inexistente (`format_final_json_response`,
`response`) e a API devolve `400 tool_use_failed`. Se o agente falhar mesmo
assim, o nó devolve uma resposta padrão com `handoff: true`.

---

## 6. Handoff

O agente responde em texto e marca `[SUPORTE]` quando precisa de humano (agressão,
acidente, dinheiro, app fora, fora do escopo). A ordem é:

1. **O cliente recebe a resposta primeiro** (`Enviar resposta`, pela Evolution).
2. Só depois o nó `Avisar suporte` manda para `SUPORTE_WHATSAPP` um resumo com
   perfil, nome, telefone, pergunta e a resposta que o cliente já recebeu, para
   o humano assumir a conversa. Se `SUPORTE_WHATSAPP` estiver vazio, o aviso é
   pulado. Se o envio ao cliente falhar, o aviso ao suporte sai mesmo assim.

No modo teste (Postman / `testar.sh`) a resposta volta no HTTP e o suporte não é
avisado.

## 7. Fluxo pronto

Importe [`../n8n/workflows/meu-sulporte-unico.json`](../n8n/workflows/meu-sulporte-unico.json)
no n8n (**Workflows → ⋯ → Import from File**), selecione a credencial do Groq no
nó *Groq Chat Model* e ligue a chave **Active**. Sem isso os webhooks de produção
não existem.

Webhook → E eco? → Normaliza → Identificar → Perfil? → Agente do perfil (Groq +
memória + tools) ou Menu → Interpreta resposta → Prepara envio → Canal e WhatsApp? → Enviar
resposta (WhatsApp) → Precisa de humano? → Avisar suporte; ou Resposta do teste (HTTP).

---

## Diagnóstico rápido

```bash
# o n8n enxerga a Evolution?
docker exec auuii-n8n wget -qO- http://evolution:8080 | head -c 200

# o n8n enxerga o backend?
docker exec auuii-n8n sh -c 'wget -qO- "$AUUII_API_URL/health" | head -c 200'

# a Evolution enxerga o n8n?
docker exec auuii-evolution sh -lc 'wget -qO- http://n8n:5678/healthz'

# quem está na rede
docker network inspect auuii-net --format '{{range .Containers}}{{.Name}} {{end}}'
```

| Sintoma | O que checar |
|---|---|
| Webhook não dispara | URL do webhook usando `localhost` em vez de `http://n8n:5678` |
| `404 webhook not registered` | fluxo não está **Active** (ou é `/webhook-test/` sem clicar em *Execute workflow*) |
| Todo mundo cai no menu | `Identificar` falhando (401/503/URL): veja a execução; `AUUII_API_TOKEN` ≠ `SUPORTE_API_KEY` ou backend sem deploy |
| `400 tool_use_failed` do Groq | fluxo antigo pedindo JSON/Structured Output Parser; importe o `meu-sulporte-unico.json` atual |
| Tool responde `401` | `AUUII_API_TOKEN` diferente de `SUPORTE_API_KEY` no Render |
| Tool responde `503` | `SUPORTE_API_KEY` não definida no Render |
| Tool sempre `encontrado:false` | telefone do WhatsApp não bate com o cadastro; veja `docs/API.md` |
| `401` ao enviar mensagem | header `apikey` ausente ou errado |
| Agente sem memória | `sessionKey` diferente a cada mensagem |
