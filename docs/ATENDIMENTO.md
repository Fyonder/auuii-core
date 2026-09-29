# Atendimento WhatsApp no painel (Duda + equipe)

A aba **Atendimento** do Goby Suporte mostra o WhatsApp da Auuii ao vivo: o que clientes,
motoboys e lojas escrevem, o que a **Duda** (a IA) responde e o que a equipe responde pelo
painel. Dá pra pausar a Duda por conversa, puxar conversa com motoboy e editar o que ela
sabe da empresa.

## Como as peças se falam

```
WhatsApp ⇄ Evolution (este PC)
   ├─ webhook da instância ─→ n8n (a Duda)              caminho da IA, não mudou
   └─ webhook global ───────→ ponte (este PC)           só pro painel
                                │ socket.io de SAÍDA (namespace /ponte, PONTE_API_KEY)
                                ▼
                    Auuii-Backend (Render) ── Firestore whatsapp_conversas
                                │ socket.io, sala room:whatsapp
                                ▼
                    Goby Suporte (Vercel) — aba Atendimento
```

- **O PC continua sem porta aberta.** A ponte é quem liga pra fora; o backend manda os
  envios do painel de volta pela mesma conexão.
- **Se a ponte cair, a Duda segue atendendo.** Só o painel deixa de ver ao vivo e de
  enviar. A fila da ponte fica em disco e entrega o atraso quando ela volta.
- **Quem decide se a Duda está pausada é o backend**, não o n8n. O n8n pergunta no
  `identificar` (antes de marcar como lida) e de novo logo antes de enviar.

## Pausa da Duda

| Quem pausa | Por quanto tempo |
|---|---|
| Botão no painel | 20 min, 1 h ou até retomar (você escolhe) |
| Operador responde pelo painel | 20 min, renova a cada mensagem |
| Alguém digita no celular do Auuii | 20 min, renova a cada mensagem |
| A Duda chama humano (handoff) | 20 min + alerta "precisa de humano" no painel |

A pausa automática nunca encurta uma pausa maior nem desfaz a "até retomar".
"Retomar Duda" limpa tudo.

## Ligar

No `.env` deste PC:

```env
COMPOSE_PROFILES=ponte
PONTE_ATIVA=true
PONTE_API_KEY=<o mesmo valor configurado no Render, serviço do backend>
PONTE_WEBHOOK_SECRET=<openssl rand -hex 16 — fica só aqui>
```

Depois:

```bash
docker compose up -d --build
```

Isso constrói a ponte e recria a Evolution (pra ela ler o webhook global). O WhatsApp
reconecta sozinho em alguns segundos; a sessão fica salva no volume.

## Conferir

```bash
docker logs --tail 20 auuii-ponte          # "conectada ao backend"
docker exec auuii-ponte wget -qO- http://127.0.0.1:3100/saude
```

`/saude` mostra se está conectada e quantos itens há na fila. Fila crescendo = backend fora.

## Quando dá errado

**Log da ponte diz "o backend recusou a chave"** — a `PONTE_API_KEY` daqui é diferente da
do Render. Tem que ser idêntica nos dois.

**Painel mostra "WhatsApp do escritório desconectado"** — a ponte não está conectada. Veja
o log dela. A Duda continua atendendo pelo WhatsApp enquanto isso.

**Mensagem do painel fica "enviando" e vira "não enviada"** — a ponte recebeu, mas a
Evolution recusou. O motivo aparece na bolha (ex.: "Este número não tem WhatsApp").

**Desligar o painel sem mexer na IA** — `PONTE_ATIVA=false` e tire `ponte` do
`COMPOSE_PROFILES`, depois `docker compose up -d`. Nunca deixe `PONTE_ATIVA=true` sem a
ponte de pé: a Evolution fica tentando reenviar cada evento pra ela.

## Código

- `ponte/` — este serviço (Node, sem dependência além do socket.io-client). Testes:
  `cd ponte && npm test`.
- Backend: `Auuii-Backend/src/services/whatsappInboxService.js` (regras),
  `ponteGateway.js` (namespace /ponte), `routes/whatsappAdminRoutes.js` (painel).
- Painel: `goby-suporte/src/pages/Admin/AtendimentoView.jsx` e `atendimento/`.
- Fluxo da Duda: `n8n/workflows/meu-sulporte-unico.json`.
