# Subir o AUUII CORE na Oracle Cloud (Always Free)

O Always Free da Oracle dá uma VM ARM **Ampere A1 com até 4 vCPU e 24 GB de RAM**,
sem prazo de validade. É uma VPS de verdade: processo sempre acordado, IP público,
disco persistente. É o que a stack precisa — a Evolution mantém um WebSocket
permanente com o WhatsApp e não sobrevive em plataforma que suspende o processo
por ociosidade.

Nada no repo muda. As quatro imagens da stack têm build `linux/arm64`:

| Imagem | arm64 |
|---|---|
| `n8nio/n8n` | sim |
| `evoapicloud/evolution-api` | sim |
| `postgres:16-alpine` | sim |
| `caddy:2-alpine` | sim |

O `docker-compose.yml` + `docker-compose.prod.yml` sobem iguais. O
[DEPLOY-VPS.md](DEPLOY-VPS.md) continua valendo do passo "Docker" em diante — este
documento cobre só o que é específico da Oracle.

---

## 1. Criar a instância

**Compute → Instances → Create instance.**

| Campo | Valor |
|---|---|
| Image | Canonical Ubuntu 24.04 (a variante **aarch64**) |
| Shape | `VM.Standard.A1.Flex` |
| OCPUs | 4 |
| Memory | 24 GB |
| Boot volume | 50 GB (o padrão; o free dá 200 GB no total) |
| Networking | criar VCN nova, **com IPv4 público** |
| SSH keys | suba sua chave pública |

Confira que aparece **"Always Free eligible"** na shape antes de criar. Se sumir,
alguma opção saiu do free — normalmente OCPU ou memória acima do limite.

> As 4 OCPUs e os 24 GB são o total da conta, não por instância. Usando tudo numa
> VM só, você não cria outras A1 depois.

### "Out of capacity"

É o erro mais comum, e não é problema seu: a capacidade A1 vive esgotada nas
regiões populares. O que costuma resolver, em ordem:

1. Trocar o **Availability Domain** (AD-1, AD-2, AD-3) e tentar de novo.
2. Tentar em horários de baixa demanda.
3. Insistir. Muita gente só consegue na décima tentativa.

Existe um atalho: contas em **Pay As You Go** têm prioridade na fila de
capacidade, e os recursos Always Free continuam gratuitos mesmo nelas. Mas aí
sua conta passa a poder gerar cobrança se você criar algo fora do free — a
proteção do "não cobra nunca" some. Decida sabendo disso.

---

## 2. Abrir as portas — em dois lugares

Este é o passo onde todo mundo trava. A Oracle bloqueia tráfego em **duas
camadas independentes**, e abrir só uma não adianta.

### 2.1 Security List (a nuvem)

**Networking → Virtual Cloud Networks → sua VCN → Security Lists → Default →
Add Ingress Rules.**

| Source | Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | 80 |
| `0.0.0.0/0` | TCP | 443 |

A 22 já vem aberta. Não abra 5678, 8080 nem 5432: no modo `prod` esses serviços
só existem dentro da rede `auuii-net`.

### 2.2 iptables (o host)

As imagens Ubuntu da Oracle vêm com um ruleset de `iptables` próprio que rejeita
tudo o que não seja SSH. Ele é independente da Security List e do `ufw`.

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

O `-I` insere no topo da chain, antes da regra de REJECT que a Oracle deixa no
fim. Sem o `netfilter-persistent save`, as regras somem no próximo boot.

**Não use `ufw` aqui.** O [DEPLOY-VPS.md](DEPLOY-VPS.md) manda usar `ufw`, e numa
VPS comum está certo — mas na Oracle ele convive mal com o ruleset que já existe:
`ufw enable` pode te trancar para fora por SSH sem remover o REJECT da Oracle.
Nesta máquina, mexa só no `iptables` como acima.

---

## 3. DNS

Dois registros **A** apontando para o IP público da instância:

| Tipo | Nome | Valor |
|---|---|---|
| A | `n8n` | `IP_DA_INSTANCIA` |
| A | `evo` | `IP_DA_INSTANCIA` |

Confira antes de subir — o Caddy só emite certificado se o DNS já resolver:

```bash
dig +short n8n.auuii.com
dig +short evo.auuii.com
```

---

## 4. Docker e a stack

Daqui em diante é idêntico ao [DEPLOY-VPS.md](DEPLOY-VPS.md). O script de
instalação do Docker detecta ARM sozinho:

```bash
ssh ubuntu@IP_DA_INSTANCIA
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && exec newgrp docker
git clone https://github.com/Fyonder/auuii-core && cd auuii-core
cp .env.example .env
```

Edite o `.env` (`EVOLUTION_DB_PASSWORD`, `AUTHENTICATION_API_KEY`,
`N8N_ENCRYPTION_KEY`, os domínios e o `ACME_EMAIL`), e suba:

```bash
./deploy.sh prod
```

Confira que os quatro containers subiram em `arm64`:

```bash
docker compose ps
docker inspect auuii-n8n --format '{{.Os}}/{{.Architecture}}'   # linux/arm64
```

---

## 5. Se der erro

**O site não abre, mas o container está `Up`** — quase sempre é a camada de
firewall que faltou. Teste de dentro da máquina primeiro:

```bash
curl -I localhost:80
```

Se responder localmente e não de fora, o problema é Security List ou `iptables`
(passo 2). Se nem localmente responder, é o container.

**O Caddy não emite o certificado** — o DNS ainda não propagou, ou a porta 80 está
fechada. O desafio ACME entra pela 80, não pela 443: fechar a 80 quebra a emissão.

**`docker compose` reclama de plataforma** — não deveria acontecer, as quatro
imagens têm `arm64`. Se acontecer com alguma imagem nova, force a arquitetura no
serviço com `platform: linux/arm64` e reporte, porque significa que a tag mudou.

**A instância some depois de uns meses** — a Oracle recupera recursos Always Free
de contas ociosas. Uma stack rodando 24/7 com tráfego real não é considerada
ociosa, então na prática isso não te afeta; mas mantenha backup do
`.env` e do volume `n8n_data`.
