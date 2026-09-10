#!/usr/bin/env bash
# ==========================================================
#  AUUII CORE — sobe a stack completa
#    ./deploy.sh          -> modo local (portas abertas no host)
#    ./deploy.sh prod     -> modo VPS (Caddy + HTTPS automático)
# ==========================================================
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-local}"
FILES=(-f docker-compose.yml)

if [ ! -f .env ]; then
	echo "!! .env não encontrado. Rode: cp .env.example .env && edite o arquivo"
	exit 1
fi

if [ "$MODE" = "prod" ]; then
	FILES+=(-f docker-compose.prod.yml)
	echo ">> modo PRODUÇÃO (Caddy + HTTPS)"
	for v in N8N_DOMAIN EVOLUTION_DOMAIN ACME_EMAIL; do
		grep -q "^${v}=." .env || { echo "!! defina ${v} no .env"; exit 1; }
	done
else
	echo ">> modo LOCAL"
fi

docker compose "${FILES[@]}" pull
docker compose "${FILES[@]}" up -d
echo
docker compose "${FILES[@]}" ps
echo
if [ "$MODE" = "prod" ]; then
	echo ">> n8n:       https://$(grep '^N8N_DOMAIN=' .env | cut -d= -f2)"
	echo ">> evolution: https://$(grep '^EVOLUTION_DOMAIN=' .env | cut -d= -f2)"
else
	echo ">> n8n:       http://localhost:${N8N_PORT:-5678}"
	echo ">> evolution: http://localhost:${EVOLUTION_PORT:-8080}"
fi
