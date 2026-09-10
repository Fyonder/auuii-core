# API que o agente consulta

O agente identifica quem fala **só pelo número do WhatsApp** e consulta o backend
real da Auuii (repositório `Auuii-Backend`, Express + Firestore) pelas rotas **`/api/suporte/*`**: só leitura, chaveadas por telefone,
devolvendo o mínimo que o agente precisa para responder.

| De onde | URL base (`AUUII_API_URL`) |
|---|---|
| Produção (Render) | `https://ifood.onrender.com` |
| Backend rodando na sua máquina, visto pelo n8n no Docker | `http://host.docker.internal:3002` |

> Não existe API dentro do `auuii-core`. A stack sobe n8n, Evolution e o postgres
> da Evolution — nada mais. Quem tem os dados é o seu backend.

Autenticação: header `x-suporte-api-key: <AUUII_API_TOKEN>` (o backend também
aceita `Authorization: Bearer`). No backend a mesma chave se chama
`SUPORTE_API_KEY`. Sem ela definida no servidor, as rotas respondem `503`.

O código está em `src/routes/suporteRoutes.js` e `src/services/suporteService.js`
do Auuii-Backend.

---

## Contrato que o agente depende

- **"Não achei" é resposta, não erro.** Toda rota devolve `200` com
  `{ "encontrado": false, "motivo": "..." }` quando o telefone não tem cadastro ou
  pedido. O agente trata como informação ("não há pedido neste número").
- **Telefone em mais de um cadastro** (dono com duas lojas, cadastro duplicado):
  `{ "encontrado": false, "motivo": "ambiguo", "opcoes": [{ "id", "nome" }] }`.
  O agente pergunta qual e repete a chamada com `&loja=<nome ou id>` (loja) ou
  `&escolha=<nome ou id>` (motoboy).
- **`statusTexto`** já vem em português ("saiu para entrega", "pronto para
  retirada", "procurando entregador"). O agente repete a frase, não o enum.
- **Nada sensível sai:** primeiro nome de terceiros, nunca telefone, CPF, CNPJ,
  saldo, token ou documento.
- `telefone` aceita qualquer formato (`+55 (44) 9 9999-8888`, `5544999998888`,
  `44999998888`, sem o 9º dígito). O backend normaliza e casa pelos 8 dígitos
  finais com checagem de DDD.

---

## Rotas

Todas com `?telefone=`. Só `identificar` tem `PUT`/`DELETE`; o resto é `GET`.

### Identificação (número único)

| Rota | Devolve |
|---|---|
| `GET /api/suporte/identificar` | `perfil`: `motoboy` (cadastro em `current`) · `restaurante` (cadastro em `merchants`) · escolha gravada no menu · `cliente` (tem pedido) · `null` (desconhecido → o fluxo mostra o menu); `nome`; `origem`: `cadastro` · `menu` · `pedido` |
| `PUT /api/suporte/identificar` | body `{ "perfil": "cliente|motoboy|restaurante", "nome"? }` — grava a escolha do menu em `suporte_contatos/{telefone}` |
| `DELETE /api/suporte/identificar` | esquece a escolha (para testar o menu de novo) |

Motoboys e lojas cadastrados nunca veem o menu. É a única escrita do módulo, numa
coleção própria; nada do painel é tocado.

### Cliente

| Rota | Devolve |
|---|---|
| `/api/suporte/cliente/pedido` | pedido em andamento (ou o mais recente dos últimos 2 dias): `codigo`, `loja`, `status`, `statusTexto`, `emAndamento`, `enderecoEntrega`, `alocacao { statusTexto, motoboy { primeiroNome } }`, `cancelado { motivo }`, mais `outrosEmAndamento[]` |

```json
{
  "success": true, "encontrado": true, "origem": "vivos",
  "pedido": {
    "codigo": "1234", "loja": "Pizzaria do Ze",
    "status": "DISPATCHED", "statusTexto": "saiu para entrega", "emAndamento": true,
    "enderecoEntrega": "Rua das Flores, 10 - Zona 7",
    "alocacao": { "status": "ASSIGNED", "statusTexto": "entregador definido", "motoboy": { "primeiroNome": "Carlos" } },
    "cancelado": null
  },
  "outrosEmAndamento": []
}
```

### Motoboy

| Rota | Devolve |
|---|---|
| `/api/suporte/motoboy/perfil` | `nome`, `online`, `ativo`, `bloqueadoAte`, `statusCadastro`, `cidade`, `veiculo` |
| `/api/suporte/motoboy/fila` | `naFila`, `base { id, nome }`, `posicao`, `totalNaFila`, `esperandoDesdeMin`, `online`; quando fora: `motivo` = `offline` · `fora_das_bases` · `fila_indisponivel` |
| `/api/suporte/motoboy/corrida` | `emCorrida`, `corridas[] { codigo, loja, statusTexto, enderecoColeta, enderecoEntrega, clientePrimeiroNome }`, `paradas[]` da rota |
| `/api/suporte/motoboy/semana?semana=` | `semana` (`week_YYYY-MM-DD`), `temMovimento`, `corridas`, `totalCorridas`, `totalAjustes`, `total`, `status` (`OPEN`/`PAID`). `semana` vazio = atual, `passada` = anterior |

Desempate: `&escolha=<nome ou id>`.

### Restaurante

| Rota | Devolve |
|---|---|
| `/api/suporte/loja/perfil` | `nome`, `cidade`, `aprovada`, `posPago`, `baseId` |
| `/api/suporte/loja/pedidos?status=` | `total`, `emAndamento`, `pedidos[] { codigo, statusTexto, alocacao, motoboyPrimeiroNome, clientePrimeiroNome, bairro, criadoEm }` (até 15). `status`: `andamento` (padrão) · `prontos` · `sem_entregador` · `entregues` · `cancelados` · `todos` · ou um enum |
| `/api/suporte/loja/entregadores?raio=` | contagens: `naFilaDaBase`, `pertoDaLoja` (dentro de `raioKm`, padrão 5), `onlineNaCidade`, `onlineTotal`, `algumOnline`; `motivo` = `loja_sem_coordenada` · `localizacao_indisponivel` |
| `/api/suporte/loja/semana?semana=` | `entregas`, `totalTaxas`, `totalRepasseMotoboys`, `totalPlataforma`, `totalAjustes`, `status` da fatura |

Desempate: `&loja=<nome ou id>`.

---

## Códigos de erro

| Código | Quando |
|---|---|
| `400` | `telefone` ausente ou com menos de 8 dígitos |
| `401` | chave ausente ou errada |
| `503` | `SUPORTE_API_KEY` não definida no servidor |
| `200 encontrado:false` | telefone sem cadastro/pedido (`nao_encontrado`, `sem_pedido`) ou em mais de um cadastro (`ambiguo`) |

Os campos que dependem do Redis (fila, localização) voltam `null` com `motivo`
quando o Redis está fora; a rota nunca cai por isso.

---

## Testar

### Postman

1. **Import** → [`postman/auuii-core.postman_collection.json`](../postman/auuii-core.postman_collection.json)
2. Pasta **6. Backend Auuii (/api/suporte)**: preencha `suporteKey` (valor de
   `AUUII_API_TOKEN` do seu `.env`) e ajuste `apiUrl` se não for produção.
3. Pasta **5. Agente (n8n webhooks)**: POST em `{{n8nUrl}}/webhook/<perfil>` com
   `{ "chatId": "<telefone>", "message": "..." }` devolve `reply` e `handoff`.
   Fluxo precisa estar **Active**. As rotas `/webhook-test/...` só aceitam uma
   chamada após clicar em *Execute workflow* no editor.

### Terminal

```bash
./testar.sh api          # bate nas 9 rotas /api/suporte com os telefones de teste do .env
./testar.sh motoboy      # pergunta ao agente como motoboy
./testar.sh              # tudo
```

Os telefones usados vêm de `TESTE_TEL_CLIENTE`, `TESTE_TEL_MOTOBOY` e
`TESTE_TEL_LOJA` no `.env` (números reais cadastrados no backend).

### Backend na sua máquina

Para testar rotas novas antes do deploy, suba o Auuii-Backend local na porta
3002 com Redis local e polling desligado (para não consumir filas de produção):

```bash
docker run -d --name redis-dev -p 6379:6379 redis:7-alpine
```

```bash
cd ../Auuii-Backend && NODE_ENV=production ENABLE_POLLING=false ENABLE_ANOTA_AI_POLLING=false ENABLE_AIQFOME_POLLING=false ENABLE_GOBY_MIRROR=false REDIS_URL=redis://127.0.0.1:6379 SUPORTE_API_KEY=dev-key PORT=3002 node server.js
```

E no `.env` do auuii-core: `AUUII_API_URL=http://host.docker.internal:3002`,
`AUUII_API_TOKEN=dev-key`, depois `docker compose up -d n8n`.

---

## O mock foi removido

Existia uma pasta `api/` com um CRUD Postgres (motoboys, lojas, fila, pedidos) e
um serviço `api` no compose, feitos para testar o agente antes do backend real
estar ligado. Foram removidos: o serviço dos dois arquivos de compose, o
container `auuii-api`, a imagem, a pasta e o banco `auuii_agent` que só ele usava.
A coleção do Postman também perdeu as pastas que batiam em `localhost:3000`.

Nada disso afetava o agente — ele já consultava `/api/suporte/*` no seu backend.
