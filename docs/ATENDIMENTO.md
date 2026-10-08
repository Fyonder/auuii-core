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

## Duda tira o pedido do motoboy

O motoboy diz que não vai conseguir fazer a corrida. A Duda pergunta o motivo e chama a tool
"Retirar pedido" (`POST /api/suporte/motoboy/retirada`). Só vale **antes da coleta**: com o
pedido coletado, ela chama um humano.

| Situação do motivo | O que acontece |
|---|---|
| Ainda sem autonomia | Fica pendente 15 min. Cartão na conversa + faixa no painel + aviso no WhatsApp do suporte com um código |
| O suporte aprova | Painel ("Aprovar e buscar outro", exige `orders.write`) ou `SIM AB12` no WhatsApp: o pedido sai da tela do motoboy e entra na busca de outro entregador (que não chama o mesmo motoboy) |
| O suporte nega | `NAO AB12` ou "Negar": o pedido fica com ele, a Duda avisa e um atendente assume |
| Ninguém responde em 15 min | Vira atendimento humano; não conta como negada |
| Motivo com autonomia | 5 aprovações seguidas do mesmo motivo liberam; a Duda retira sozinha e só avisa o suporte. Uma negada zera |

"Acidente" e "Outro motivo" nunca ganham autonomia. No painel, **Atendimento → Retiradas**
mostra o progresso de cada motivo, desliga um motivo ou desliga tudo.

`SIM/NAO <código>` só vale vindo do número em `SUPORTE_WHATSAPP`, e precisa estar **no
Render também** (o backend confere). Sem ela, a decisão pelo WhatsApp responde "não
configurado" e o painel continua funcionando.

## Dois números: Auuii (Duda) e Goby (Nina)

Cada instância da Evolution é uma empresa, com IA, conhecimento e conversas próprios.

| | Auuii | Goby |
|---|---|---|
| Instância da Evolution | `auuii` | `goby` |
| Fluxo no n8n | Meu Sulporte (`/webhook/auuii`) | Atendimento Goby (Nina) (`/webhook/goby`) |
| IA | Duda | Nina |
| Quem ela reconhece | motoboy, loja, cliente (Firestore) | entregador (telefone ou nome) e restaurante (CNPJ) da Goby — Postgres do PickNGo |
| O que consulta | semana, fila, corrida, pedido, retirada | entregador: cadastro, corridas, dia, semana, uma corrida, retirada (se ligada). Restaurante: pedidos em andamento, um pedido, semana |
| Chave no backend | `AUUII_API_TOKEN` = `SUPORTE_API_KEY` | `AUUII_API_TOKEN_GOBY` = `SUPORTE_API_KEY_GOBY` (só dados da Goby) |
| Conhecimento | `settings/whatsappIA` | `settings/whatsappIA_goby` |

A ponte manda a instância em cada evento; o backend separa as conversas por ela (a mesma
pessoa falando com os dois números são duas conversas) e responde pelo número certo. No
painel: filtro **Todas / Auuii / Goby** e "O que a IA sabe" com uma aba por empresa.

A cota da Groq (8 mil tokens/min por modelo) é a MESMA para as duas IAs.

## Número da API oficial (Meta) — Duda

Um terceiro número, só na API oficial do WhatsApp (Meta Cloud API), atendido pela mesma
Duda, com o mesmo conhecimento (`settings/whatsappIA`). Instância **`meta`**: conversas
próprias no painel (a mesma pessoa no número da Evolution e no da Meta são duas conversas).

```
Meta ──HTTPS──▶ backend (Render) /webhook/whatsapp-meta     confere X-Hub-Signature-256
                   └─ socket /ponte 'meta' (com ack) ─▶ ponte (este PC)
                                                         ├─▶ n8n /webhook/auuii  (traduzido pro formato da Evolution)
                                                         └─▶ painel (como qualquer mensagem)
n8n ─/message/sendText/meta─▶ ponte ─▶ graph.facebook.com
```

- **A ponte se faz de Evolution pra instância `meta`.** O fluxo da Duda continua lendo
  `messages.upsert` e chamando `sendText`; só os nós de envio escolhem a URL: `meta` vai
  pra `PONTE_URL`, o resto pra Evolution. Marcar como lida já leva o "digitando…".
- **O backend só responde 200 à Meta depois que a ponte confirma.** Ponte fora = 503, e a
  Meta reenvia sozinha por dias. A ponte lembra o que já entregou ao n8n por 24 h, então
  reenvio não faz a Duda responder duas vezes.
- **O aviso interno pro suporte sai sempre pela Evolution**, mesmo em conversa da Meta:
  pela Meta, fora da janela de 24 h do suporte, só template.
- **Limites da Meta:** a Duda e o painel só respondem até 24 h depois da última mensagem do
  contato (depois disso, só template pago; "puxar conversa" com motoboy pelo número da
  Meta não funciona). Com o número de teste, só os destinatários cadastrados no painel da
  Meta recebem (erro 131030); o token temporário vence em ~24 h.

Ligar (precisa da ponte já ligada):

1. **Render (backend):** `META_VERIFY_TOKEN` (uma senha que você inventa) e
   `META_APP_SECRET` (painel da Meta → Configurações do app → Básico → Chave secreta).
2. **`.env` deste PC:** `META_WHATSAPP_TOKEN` e `META_PHONE_NUMBER_ID`, depois
   `docker compose up -d --build ponte n8n`. O log da ponte diz "número da Meta ligado".
3. **Fluxo da Duda** atualizado no n8n (reimportar `meu-sulporte-unico.json`).
4. **Painel da Meta → Webhooks:** URL `https://ifood.onrender.com/webhook/whatsapp-meta`,
   o mesmo `META_VERIFY_TOKEN`, "Verificar e salvar", e assinar o campo `messages`.

### O que a Nina consulta (só leitura, só do entregador que está falando)

| Ferramenta no n8n | Rota | Parâmetro |
|---|---|---|
| Meu cadastro | `GET /api/suporte/goby/motoboy/perfil` | — |
| Minhas corridas | `GET /api/suporte/goby/motoboy/corrida` | — |
| Meu dia | `GET /api/suporte/goby/motoboy/dia` | `dia`: vazio, `ontem` ou `AAAA-MM-DD` |
| Minha semana | `GET /api/suporte/goby/motoboy/semana` | `semana`: vazio, `passada` ou uma data |
| Buscar corrida | `GET /api/suporte/goby/motoboy/pedido` | `codigo`: só o número |

| Me identificar | `POST /api/suporte/goby/motoboy/vincular` | body `nome` (nome e sobrenome) |
| Retirar pedido | `POST /api/suporte/goby/motoboy/retirada` | body `codigo`, `motivo` |
| Identificar restaurante | `POST /api/suporte/goby/loja/vincular` | body `cnpj` (14 números) |
| Pedidos da loja | `GET /api/suporte/goby/loja/pedidos` | — |
| Pedido da loja | `GET /api/suporte/goby/loja/pedido` | `codigo` |
| Semana da loja | `GET /api/suporte/goby/loja/semana` | `semana`: vazio, `passada` ou uma data |

Todas levam `?telefone=` (o chatId) e o header `x-suporte-api-key`. Com a chave da Goby o
backend força `instancia=goby` em identificar, pausa e handoff e responde **403** em
qualquer rota da Auuii: a Nina nunca lê dado da Auuii, mesmo que a IA erre o parâmetro.
"Ganhos" é a soma das taxas das corridas entregues, não extrato: o acerto é com a Goby.

### Robô da Goby: quem é e os dados do motoboy (04/10/2026)

O sistema da Goby (do sócio) tem um robô que responde direto: Supabase Edge Function
`robo-goby`, `GET ?telefone=<chatId>&rota=<rota>`, cabeçalho `x-api-key`. No Kali, a URL e a
chave ficam em `ROBO_GOBY_URL` e `ROBO_GOBY_KEY` (no `.env`; o compose repassa ao n8n). A
chave é gerada e revogada no painel do sócio, só serve para as rotas do robô (não é senha do
banco) e cada consulta aparece no "Registro" dele.

| Rota | O que traz |
|---|---|
| `quem` | `tipo`: motoboy, loja, equipe ou desconhecido; `nome`, `codigo` |
| `perfil` | patente, moedas, total de entregas, categoria |
| `fila` | posição na fila da vez, quem está na vez (`sem_ciclo` = fila parada) |
| `reservas` | turnos que ele reservou |
| `vagas` | turnos abertos (reservar é pelo app, na vez dele) |
| `desempenho` | 30 dias (entregas, diárias, % no prazo, km) e entregas por dia da semana |
| `ranking` | top 5 da semana e a posição dele |

No fluxo: **Robô: quem** roda logo depois do `identificar` e decide o perfil; o backend Auuii
(telefone, nome, CNPJ) só vale quando o robô diz desconhecido ou está fora do ar (8 s de
limite, erro não derruba nada). O **Monta contexto** passa a ser a fonte do perfil para os IFs
e para o agente. O agente do entregador tem uma ferramenta só, **Robô da Goby**, com a rota
como parâmetro; "Meu cadastro" e "Minha semana" saíram. Equipe vai para o agente geral,
avisado de que é colega.

**Trava do financeiro** (regra do robô, adotada em toda a Nina): nenhuma resposta tem valor em
R$ — taxa, ganho, acerto, fatura, Pix. Dinheiro é com a equipe; a Nina oferece um atendente.

### Nina: triagem de entregadores e restaurantes (03/10/2026)

O `identificar` da Goby devolve, além de quem é e da pausa, o que a Nina precisa pra fazer a
triagem numa chamada só (o nó **Monta contexto** transforma em texto pro prompt):

| Campo | O que é | O que a Nina faz |
|---|---|---|
| `corridas` | pedidos em aberto com ele (código, loja, etapa; até 5) | Na primeira mensagem, cumprimento ou pedido vago, lista os números e pergunta com qual precisa de ajuda |
| `pendentes` | mensagens dele das últimas 24 h que **ninguém** respondeu (até 3; o n8n manda `&msgId=` da atual pra ela não contar) | Responde cada uma em uma frase, junto com a atual |
| `aguardandoHumano` | já foi escalado e ninguém respondeu | Diz que a equipe já foi avisada, sem chamar de novo |
| `retiradaPelaIA` | o interruptor do painel | Ver abaixo |

**Pendentes** só valem com a ponte conectada (sem ela, nada do que a IA/equipe respondeu
chega ao backend e tudo pareceria sem resposta); mensagens de menos de 90 s não contam (é a
rajada que outra execução ainda está respondendo); envio do painel que falhou não conta como
resposta; mídia sem texto e nota interna são puladas.

**Primeiro contato: "O que você precisa?"** O `identificar` devolve `primeiroContato`: ninguém
(IA, painel ou celular) falou com a pessoa nas últimas 12 h. Se a mensagem é só cumprimento
ou pedido vago ("oi", "bom dia", "preciso de ajuda"), o fluxo responde **sem IA** (IF
**Resposta pronta?** → **Saudação**): "Oi, Carlos! Aqui é a Nina, da Goby. O que você
precisa?", e pro entregador ou restaurante já identificado, os pedidos em aberto na linha de
baixo. Se a pessoa já disse o que precisa, a Nina cumprimenta em poucas palavras e resolve.
Depois do primeiro contato ela não cumprimenta de novo. Com a ponte fora, `primeiroContato`
vem nulo e a Nina não força a saudação.

**Modo suporte** (dono, 04/10/2026). Quando o número em `SUPORTE_WHATSAPP` (o mesmo que
recebe os avisos da Nina) escreve pro número da Goby, a Nina vira ferramenta de consulta da
equipe (**Agente Nina (suporte)**, IF **Suporte?**): sem menu, sem chamar atendente. Ela
consulta entregadores e lojas pelo nome, parte do nome, código ou CNPJ (nome completo,
código, telefone, ativo, corridas em andamento), as corridas em aberto de um entregador e
qualquer pedido pelo número. As rotas `GET /api/suporte/goby/suporte/{cadastro,corridas,pedido}`
conferem no backend que quem pergunta é o `SUPORTE_WHATSAPP` (o do Render): outro número
recebe 403, mesmo que a IA erre. Sem valores em R$. Se a consulta falhar, ela diz que não
respondeu, e não "não achei".

**Dia dos motoboys e vagas** (dono, 04/10/2026, "em vez de buscar 1 a 1 na lista"). Duas
ferramentas a mais no modo suporte:
- **Dia dos motoboys** → `GET /api/suporte/goby/suporte/dia?dia=hoje|ontem|AAAA-MM-DD&loja=`:
  todos os entregadores do dia, um por linha, com corridas entregues/canceladas/em aberto e
  as vagas (loja, das, até, se chegou), mais os totais (chegaram, atrasados, não chegaram).
  `loja` deixa só quem tem vaga naquela loja. Demora uns 5-10 s (o dia inteiro da operação).
- **Motoboy no dia** → `GET /api/suporte/goby/suporte/motoboy?entregador=&dia=`: um entregador,
  com a lista das corridas do dia, as em aberto agora e as vagas com endereço.
- **Vagas do dia** (dono, 05/10/2026) → `GET /api/suporte/goby/suporte/vagas?dia=hoje|amanha|ontem|AAAA-MM-DD&loja=&periodo=manha|almoco|tarde|noite|agora&livres=sim&nomes=sim`:
  TODAS as vagas do dia (a operação vai das 5:30 à meia-noite), livres e ocupadas. Totais
  (vagas, posições, ocupadas, livres, livres que ainda dá tempo) e uma linha por vaga:
  `18:00-22:30 Saborê · 1 livre de 3 · rolando agora`. Com `loja` ou `periodo` traz quem
  está em cada vaga (sem filtro não, pelo limite de tokens da Groq). `posicoes` de
  `vagas_vagas` = quantos cabem; cada `vagas_reservas` ocupa uma. Backend PR #64.

De onde vem (`gobyVagas.js` no backend; o espelho passou a ler `vagas_reservas`, `vagas_vagas`
e `diarias_publico`, sem nenhuma coluna de valor): a vaga é `vagas_vagas` (horário de
Brasília; fim antes do início = vira a meia-noite), quem pegou é `vagas_reservas`, e o "já
chegou" é `data_chegou_estabelecimento` da diária do PickNGo, casada pela loja e pelo início
do turno (até 90 min). Sem chegada marcada mas com corrida daquela loja no turno =
`trabalhando`. Diária do PickNGo sem vaga no app também entra (`fonte: diaria_pickngo`, sem
horário de fim; em 04/10 não havia vaga no app e havia 94 diárias). Se as vagas falharem, o
resto responde e a Nina diz que as vagas não responderam.

**Menu pra número desconhecido** (dono, 04/10/2026). Quem o robô e o backend não conhecem
recebe, a qualquer mensagem: "Pra eu te ajudar, me diz quem é você: 1 - Motoboy,
2 - Restaurante". "1" → "Me manda seu nome completo"; "2" → "Me manda o CNPJ da loja". A
mensagem seguinte vai pra IA com a instrução de identificar (nome ou CNPJ). O assunto da
primeira mensagem fica guardado e é resolvido depois. A etapa de cada telefone fica nos
dados estáticos do fluxo (`menuNina`) por 30 min. Quem responde outra coisa ao menu (ex.:
cliente) é atendido pela IA. Tudo isso sai sem IA, menos a identificação.

**Quem é.** Quando o que a pessoa precisa envolve pedido, corrida, cadastro ou pagamento, a
Nina pergunta se é entregador ou restaurante e identifica. O que ela precisa fica guardado:
depois de identificar, a Nina resolve isso, sem recomeçar. No n8n, o
IF **Entregador?** manda o entregador pro agente dele; o novo IF **Restaurante?** manda a loja
pro **Agente Nina (loja)**; o resto fica no agente geral, que é quem identifica.

**Restaurante.** `empresas` da Goby não tem telefone, então a loja se identifica pelo
**CNPJ** (tool "Identificar restaurante"). Nome de loja não serve: é público, e daria a
qualquer um o movimento dela. O vínculo fica em `goby_vinculos/{telefone}` com `tipo: 'loja'`
(30 dias, mesmas 3 falhas em 24 h), a conversa ganha o selo **identificado pelo CNPJ** e o
mesmo botão Desfazer. Identificada, a loja vê os pedidos em andamento (número, etapa e só o
primeiro nome do entregador), um pedido dela pelo número e a semana (entregues, canceladas,
soma das taxas e quanto por dia). Pedido de outra loja volta sem nenhum detalhe. Problema que
precisa de alguém (entregador sumido, cancelar, cobrança) vira `[SUPORTE]` com
`RESUMO: loja · pedido N · o que aconteceu`.

**Número que não está no cadastro.** Se a pessoa diz que é entregador, a Nina pede nome e
sobrenome e chama "Me identificar". O backend casa com um cadastro **ativo** cujo primeiro
nome é igual e cujas outras palavras estão no nome (sem acento, sem de/da/do); o vínculo fica
em `goby_vinculos/{telefone}` por 30 dias e todas as ferramentas passam a funcionar pra ele.
Travas: 3 falhas em 24 h bloqueiam (`goby_vinculos_tentativas`), telefone que já é de alguém
nunca troca de dono, `ambiguo` não cita nomes. No painel a conversa ganha o selo
**identificado pelo nome** e o botão **Desfazer** (`whatsapp.config`), que apaga o vínculo.
Decisão do dono, ciente de que quem souber o nome de um entregador veria as corridas dele.

**Tirar pedido da tela** — botão **Configurações** na aba Atendimento:

| Interruptor | O que a Nina faz quando ele quer largar/tirar um pedido |
|---|---|
| Desligado (padrão) | **Triagem**: pergunta qual pedido (se há mais de um) e o que aconteceu, termina com `[SUPORTE]` e uma última linha `RESUMO: pedido N · motivo`. O resumo vira o motivo do handoff no painel e vai no aviso ao `SUPORTE_WHATSAPP` |
| Ligado | Chama "Retirar pedido": o backend zera `entregador_id`, `data_aceito`, `data_visualizado` e `data_despachado` em `pedidos` no Postgres da Goby — só se o pedido é dele e ainda não foi coletado. Nota na conversa + alerta no painel |

Ligar exige a **senha do Postgres do Supabase** (Database password do projeto), digitada no
painel pelo administrador: o backend conecta, confere `has_table_privilege(..., 'pedidos',
'UPDATE')` e, se der certo, guarda cifrada em `segredos/goby_db` (AES-256-GCM, chave
`OD_SECRET_KEY` do Render — a mesma do Open Delivery). A senha nunca volta pro painel nem
pro log. O host direto `db.<ref>.supabase.co` é só IPv6: se o Render não alcançar, o
formulário aceita o pooler (`aws-0-<regiao>.pooler.supabase.com`, usuário
`postgres.<ref>`) e a mensagem de erro diz isso.

> **Aviso.** A tabela `pedidos` do Supabase é uma cópia feita por ETL a partir do PickNGo a
> cada ~2 min. Enquanto o motoboy usar o app do PickNGo, a retirada feita aqui **não aparece
> pra ele** e pode ser desfeita no próximo ciclo. O interruptor existe pra quando a Goby
> estiver no auuii-motoboy (decisão do dono, 03/10/2026). Por isso ele nasce desligado.

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
