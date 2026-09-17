# Rodar o AUUII CORE no PC de casa

Testado como referência em Ubuntu 22.04/24.04. Este guia cobre a máquina
fazendo três coisas ao mesmo tempo: o agente, o DNS com bloqueio de anúncios e o
compartilhamento de arquivos da rede.

---

## Por que aqui não precisa de domínio nem porta aberta

Diferente da VPS, **nada de fora precisa alcançar esta máquina**. O caminho da
mensagem é todo de saída ou interno à rede do Docker:

| Trecho | Direção |
|---|---|
| WhatsApp → Evolution | a Evolution abre o WebSocket **de dentro pra fora** (Baileys) |
| Evolution → n8n | `http://n8n:5678/webhook/auuii`, dentro da rede `auuii-net` |
| n8n → backend | saída para `https://ifood.onrender.com` |

Consequência prática: **não use `./deploy.sh prod`**. Aquele modo sobe o Caddy,
pede domínio e emite certificado — trabalho inútil aqui, e ele ainda ocuparia a
porta 80 que o AdGuard quer. Use o `./deploy.sh` puro.

Também não importa se sua operadora usa CGNAT ou se o IP é dinâmico. Isso
normalmente inviabiliza hospedar em casa; neste desenho, não toca no problema.

---

## Mapa de portas

| Porta | Quem usa | Observação |
|---|---|---|
| 53 | AdGuard | ocupada pelo `systemd-resolved`, tem que liberar |
| 445, 139 | Samba | nativo, não em container |
| 3000 | AdGuard | só o assistente da primeira instalação |
| 5678 | n8n | painel do agente |
| 8080 | Evolution | API do WhatsApp |
| 8081 | AdGuard | painel, definido durante a instalação |
| 8082 | File Browser | |

---

## 1. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && exec newgrp docker
sudo systemctl enable docker
```

O `enable` importa: sem ele os containers não voltam sozinhos depois de um
reinício, e o `restart: unless-stopped` dos compose não adianta nada.

---

## 2. IP fixo para esta máquina

Faça uma **reserva de DHCP** no roteador amarrando o MAC desta placa a um IP fixo
(ex.: `192.168.1.10`). Não é frescura: quando esta máquina virar o DNS da rede,
o IP dela vai estar escrito na configuração do roteador. Se ele mudar, a rede
inteira fica sem internet.

---

## 3. Liberar a porta 53

Todo Ubuntu roda o `systemd-resolved` escutando na 53, e o AdGuard não sobe
enquanto ela estiver ocupada. Procedimento oficial do AdGuard:

```bash
sudo mkdir -p /etc/systemd/resolved.conf.d
sudo tee /etc/systemd/resolved.conf.d/adguardhome.conf > /dev/null <<'EOF'
[Resolve]
DNS=127.0.0.1
DNSStubListener=no
EOF
sudo mv /etc/resolv.conf /etc/resolv.conf.backup
sudo ln -s /run/systemd/resolve/resolv.conf /etc/resolv.conf
sudo systemctl reload-or-restart systemd-resolved
```

Confira que a 53 ficou livre antes de seguir:

```bash
sudo ss -lnup | grep :53   # não deve retornar nada
```

---

## 4. A stack do agente

```bash
git clone https://github.com/Fyonder/auuii-core && cd auuii-core
cp .env.example .env
```

No `.env`, preencha `EVOLUTION_DB_PASSWORD`, `AUTHENTICATION_API_KEY`,
`N8N_ENCRYPTION_KEY`, `AUUII_API_TOKEN` e `SUPORTE_WHATSAPP`. As URLs públicas
ficam como estão (`http://localhost:...`) — aqui não há domínio.

```bash
./deploy.sh
```

Sem o `prod`. Confira:

```bash
docker compose ps
curl -s localhost:8080 | head -c 100   # Welcome to the Evolution API
```

O painel do n8n fica em `http://192.168.1.10:5678` de qualquer aparelho da rede.

### Conectar o WhatsApp

```bash
curl -X POST localhost:8080/instance/create \
  -H "apikey: SUA_AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"auuii","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```

Depois aponte o webhook da instância para **o nome interno**, não para localhost:

```
http://n8n:5678/webhook/auuii
```

Os dois containers estão na mesma rede `auuii-net`; usar `localhost` aqui faria a
Evolution chamar ela mesma.

---

## 5. AdGuard Home e File Browser

```bash
cd casa
cp .env.example .env
```

Crie a pasta compartilhada e ajuste o `.env` (`PASTA_ARQUIVOS`, e `PUID`/`PGID`
com o resultado de `id -u` e `id -g`):

```bash
sudo mkdir -p /srv/arquivos
sudo chown $USER:$USER /srv/arquivos
docker compose up -d
```

Abra `http://192.168.1.10:3000` e siga o assistente. Duas escolhas importantes:

- **Interface de administração: porta 8081.** O padrão sugerido é 80; deixe 80
  livre, é onde o AdGuard responde a bloqueios.
- **Servidor DNS: porta 53**, em todas as interfaces.

Terminado o assistente, a 3000 não é mais usada e o painel passa a ser
`http://192.168.1.10:8081`.

O File Browser sobe em `http://192.168.1.10:8082`. O usuário inicial é
`admin` / `admin` — **troque na primeira entrada.**

---

## 6. Samba

Este é o único que não vai em container. Em Docker ele exige rede host e ainda
atrapalha a descoberta automática no Windows; nativo é mais simples e mais
confiável.

```bash
sudo apt install -y samba
sudo tee -a /etc/samba/smb.conf > /dev/null <<'EOF'

[arquivos]
   path = /srv/arquivos
   browseable = yes
   read only = no
   valid users = SEU_USUARIO
EOF
sudo smbpasswd -a $USER          # define a senha de acesso à pasta
sudo systemctl restart smbd
```

Troque `SEU_USUARIO` pelo seu login. A pasta aparece como `\192.168.1.10\arquivos`
no Windows e em qualquer app de arquivos do Android com suporte a SMB.

Use o **mesmo usuário** do `PUID`/`PGID` do File Browser. Se forem diferentes, um
grava arquivos que o outro não consegue apagar.

---

## 7. Apontar a rede para o AdGuard

No roteador, em DHCP, troque o **servidor DNS primário** para `192.168.1.10`.
Os aparelhos pegam a configuração nova ao reconectar.

**Não preencha um DNS secundário público** (1.1.1.1, 8.8.8.8 e afins). Parece
prudente, mas os aparelhos alternam entre os dois livremente: metade das
consultas escapa do bloqueio e você não entende por que anúncio ainda aparece.

O preço dessa decisão é real e você deve saber dele: **se este PC cair, a rede
inteira fica sem resolver nome** — ou seja, sem internet para todo mundo da casa,
mesmo com o link funcionando. Se isso for inaceitável, a saída não é DNS
secundário público, é um segundo AdGuard em outra máquina.

---

## 8. Conferir que tudo volta sozinho

Teste agora, não no dia do apagão:

```bash
sudo reboot
```

Depois que voltar:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

Devem estar de pé: `auuii-n8n`, `auuii-evolution`, `auuii-evolution-db`,
`casa-adguard`, `casa-filebrowser`. Se algum não voltou, foi o
`systemctl enable docker` do passo 1.

---

## Se der erro

**O AdGuard não sobe, erro de bind na 53** — o `systemd-resolved` voltou a ocupar
a porta. Refaça o passo 3 e confirme com `sudo ss -lnup | grep :53`.

**A rede ficou sem internet depois de apontar o DNS** — entre no roteador por IP
(não por nome) e volte o DNS para o padrão. Depois investigue com calma: quase
sempre é o AdGuard fora do ar ou o IP da máquina que mudou por falta da reserva
de DHCP (passo 2).

**O agente parou depois de uma queda de luz** — a sessão do WhatsApp cai quando a
Evolution é desligada abruptamente. Veja o estado e, se preciso, leia o QR de novo:

```bash
curl -s localhost:8080/instance/connectionState/auuii -H "apikey: SUA_CHAVE"
```

**O n8n não responde mas o container está `Up`** — ele demora uns 30 s no primeiro
boot. Acompanhe com `docker logs -f auuii-n8n`.
