# Subir o AUUII CORE numa VPS

Testado em Ubuntu 22.04/24.04. Recomendado: **2 vCPU / 4 GB RAM / 40 GB SSD**.

> Se a VPS for a ARM gratuita do Oracle Always Free, comece por
> [DEPLOY-ORACLE.md](DEPLOY-ORACLE.md): a criação da instância e o firewall são
> diferentes lá. Do passo "Docker" em diante, este guia vale igual.

---

## 1. DNS

No painel do seu domínio, crie dois registros **A** apontando para o IP da VPS:

| Tipo | Nome | Valor |
|---|---|---|
| A | `n8n` | `IP_DA_VPS` |
| A | `evo` | `IP_DA_VPS` |

Confira antes de continuar (o Caddy só emite o certificado se o DNS já resolver):

```bash
dig +short n8n.auuii.com
dig +short evo.auuii.com
```

---

## 2. Docker na VPS

```bash
curl -fsSL https://get.docker.com | sh
docker compose version   # precisa ser v2.24 ou maior
```

---

## 3. Firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Nada de abrir 5678, 8080 ou 5432 — no modo `prod` esses serviços só existem
dentro da rede `auuii-net`.

---

## 4. Código e configuração

```bash
git clone SEU_REPO auuii-core
cd auuii-core
cp .env.example .env
```

Edite o `.env`:

```env
EVOLUTION_DB_PASSWORD=<openssl rand -hex 16>
AUTHENTICATION_API_KEY=<openssl rand -hex 32>
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>

N8N_DOMAIN=n8n.auuii.com
EVOLUTION_DOMAIN=evo.auuii.com
ACME_EMAIL=voce@auuii.com

N8N_HOST=n8n.auuii.com
N8N_PROTOCOL=https
N8N_PUBLIC_URL=https://n8n.auuii.com
EVOLUTION_PUBLIC_URL=https://evo.auuii.com
```

> `N8N_PUBLIC_URL` e `EVOLUTION_PUBLIC_URL` precisam ser os endereços **https**
> reais: é com eles que o n8n monta as URLs de webhook e a Evolution monta os
> links de mídia.

---

## 5. Subir

```bash
./deploy.sh prod
```

Equivale a:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Acompanhe a emissão dos certificados:

```bash
docker compose logs -f caddy
```

Pronto:

- https://n8n.auuii.com — crie a conta de dono no primeiro acesso
- https://evo.auuii.com/manager — painel da Evolution (use a `AUTHENTICATION_API_KEY`)

---

## 6. Subir de novo depois de mudar algo

```bash
git pull
./deploy.sh prod
```

---

## 7. Backup automático (opcional)

> O n8n desta stack usa SQLite. Aguenta bem a operação de um agente, mas o
> backup do volume `auuii_n8n_data` passa a ser obrigatório — é lá que moram os
> fluxos e as credenciais.

```bash
mkdir -p /opt/auuii-backups
crontab -e
```

```cron
0 3 * * * docker exec auuii-evolution-db pg_dumpall -U evolution > /opt/auuii-backups/auuii-$(date +\%F).sql
0 4 * * 0 find /opt/auuii-backups -name '*.sql' -mtime +30 -delete
```

Copie também os volumes `auuii_n8n_data` (os fluxos ficam em SQLite ali dentro)
e `auuii_evolution_instances` (sessões do WhatsApp) — sem eles o backup do
banco não te devolve o agente funcionando.

---

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Caddy não emite certificado | DNS ainda não propagou, ou porta 80 bloqueada |
| n8n gera webhook com `localhost` | `N8N_PUBLIC_URL` / `N8N_HOST` sem o domínio real |
| Evolution não conecta no banco | `EVOLUTION_DB_PASSWORD` mudou depois do 1º boot — o volume guarda a senha antiga |
| `!reset` inválido no compose | Docker Compose abaixo da v2.24 — atualize o plugin |
| n8n reclama de credencial corrompida | `N8N_ENCRYPTION_KEY` foi trocada |
