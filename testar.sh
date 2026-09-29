#!/usr/bin/env bash
# ==========================================================
#  AUUII CORE — testa o agente sem precisar do WhatsApp
#
#    ./testar.sh            testa o backend e os 3 perfis
#    ./testar.sh api        so as rotas /api/suporte do backend (nao precisa do n8n)
#    ./testar.sh cliente    pergunta ao agente como cliente (idem motoboy, restaurante)
#    ./testar.sh menu       numero desconhecido: recebe o menu, escolhe 2 e e registrado
#    ./testar.sh qr         gera um QR Code novo da Evolution
#
#  Precisa no .env:
#    AUUII_API_URL      base do backend (https://ifood.onrender.com ou host.docker.internal:3002)
#    AUUII_API_TOKEN    = SUPORTE_API_KEY do backend (nunca e impresso aqui)
#    TESTE_TEL_CLIENTE / TESTE_TEL_MOTOBOY / TESTE_TEL_LOJA   telefones reais cadastrados
#
#  Para os perfis funcionarem, o fluxo "Meu Sulporte" precisa
#  estar ATIVO no n8n (chave Active ligada, canto superior direito).
# ==========================================================
set -uo pipefail
cd "$(dirname "$0")"

N8N=http://localhost:5678
EVO=http://localhost:8080

env_get() { grep "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r'; }
API=$(env_get AUUII_API_URL)
API_TOKEN=$(env_get AUUII_API_TOKEN)
EVO_KEY=$(env_get AUTHENTICATION_API_KEY)
EVO_INST=$(env_get EVOLUTION_INSTANCE); EVO_INST=${EVO_INST:-auuii}
TEL_CLIENTE=$(env_get TESTE_TEL_CLIENTE)
TEL_MOTOBOY=$(env_get TESTE_TEL_MOTOBOY)
TEL_LOJA=$(env_get TESTE_TEL_LOJA)

# dentro do Docker o n8n usa host.docker.internal; daqui do PC e localhost
API_LOCAL=${API/host.docker.internal/localhost}

azul()  { printf '\033[36m%s\033[0m\n' "$1"; }
verde() { printf '\033[32m%s\033[0m\n' "$1"; }
vermelho() { printf '\033[31m%s\033[0m\n' "$1"; }
mascara() { printf '%s' "$1" | sed -E 's/^(..).*(....)$/\1*****\2/'; }

# ---------- pergunta a um perfil ----------
perguntar() {
	local perfil="$1" telefone="$2" texto="$3"

	azul "── agente: $perfil ─────────────────────────────────"
	if [ -z "$telefone" ]; then
		vermelho "   x TESTE_TEL_$(printf '%s' "$perfil" | tr a-z A-Z | sed 's/RESTAURANTE/LOJA/') vazio no .env"
		return 1
	fi
	echo "   telefone: $(mascara "$telefone")"
	echo "   pergunta: $texto"

	local corpo resposta http
	corpo=$(printf '{"chatId":"%s","message":"%s"}' "$telefone" "$texto")
	resposta=$(curl -s -m 120 -w '\n%{http_code}' -X POST "$N8N/webhook/auuii" \
		-H 'Content-Type: application/json' -d "$corpo")
	http=$(printf '%s' "$resposta" | tail -n1)
	resposta=$(printf '%s' "$resposta" | sed '$d')

	if [ "$http" = "404" ]; then
		vermelho "   x webhook /auuii nao registrado"
		echo "     Ligue a chave Active no fluxo Meu Sulporte e rode de novo."
		return 1
	fi
	if [ "$http" != "200" ]; then
		vermelho "   x HTTP $http"
		echo "     $resposta"
		return 1
	fi

	printf '%s' "$resposta" | PYTHONIOENCODING=utf-8 python -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('   resposta crua:', sys.stdin.read()[:300]); raise SystemExit
if isinstance(d, list):
    d = d[0] if d else {}
if d.get('ignorado'):
    print('   ignorado:', d.get('motivo')); raise SystemExit
reply = d.get('reply')
if reply is None:
    print('   resposta:', json.dumps(d, ensure_ascii=False)[:400])
else:
    print('   resposta: ' + reply)
    print('   handoff : ' + str(d.get('handoff')))
"
	echo
}

# ---------- backend /api/suporte ----------
rota() {
	local caminho="$1" nome="$2"
	local code corpo
	corpo=$(curl -s -m 30 -w '\n%{http_code}' -H "x-suporte-api-key: $API_TOKEN" "$API_LOCAL/api/suporte/$caminho")
	code=$(printf '%s' "$corpo" | tail -n1)
	corpo=$(printf '%s' "$corpo" | sed '$d')
	if [ "$code" = "200" ]; then
		local resumo
		resumo=$(printf '%s' "$corpo" | PYTHONIOENCODING=utf-8 python -c "
import sys, json
d = json.load(sys.stdin)
if 'perfil' in d and 'encontrado' not in d:
    print('perfil=' + str(d.get('perfil')) + ' · origem=' + str(d.get('origem')))
elif d.get('encontrado'):
    chaves = [k for k in d if k not in ('success','encontrado')]
    print('encontrado · ' + ', '.join(chaves[:6]))
else:
    print('encontrado:false · motivo=' + str(d.get('motivo')))
" 2>/dev/null)
		printf '   \033[32mok\033[0m   %-22s %s\n' "$nome" "$resumo"
		return 0
	fi
	printf '   \033[31m%s\033[0m  %-22s %s\n' "$code" "$nome" "$(printf '%s' "$corpo" | cut -c1-120)"
	return 1
}

testar_api() {
	azul "── backend $API_LOCAL/api/suporte ──────────────────"
	if [ -z "$API" ]; then vermelho "   x AUUII_API_URL vazio no .env"; return 1; fi
	if [ -z "$API_TOKEN" ]; then vermelho "   x AUUII_API_TOKEN vazio no .env"; return 1; fi
	local falhas=0
	# sem chave tem que dar 401 (ou 503 se o servidor nao tem SUPORTE_API_KEY)
	local sem
	sem=$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$API_LOCAL/api/suporte/motoboy/perfil?telefone=5500000000000")
	if [ "$sem" = "401" ]; then printf '   \033[32mok\033[0m   %-22s %s\n' "sem chave" "401 como esperado"
	elif [ "$sem" = "503" ]; then vermelho "   x servidor sem SUPORTE_API_KEY (503)"; falhas=$((falhas+1))
	else vermelho "   x sem chave respondeu $sem (esperado 401)"; falhas=$((falhas+1)); fi

	for t in "$TEL_CLIENTE" "$TEL_MOTOBOY" "$TEL_LOJA"; do
		[ -n "$t" ] && { rota "identificar?telefone=$t" "identificar" || falhas=$((falhas+1)); }
	done
	if [ -n "$TEL_CLIENTE" ]; then
		rota "cliente/pedido?telefone=$TEL_CLIENTE" "cliente/pedido" || falhas=$((falhas+1))
	else echo "   -    cliente/pedido        (TESTE_TEL_CLIENTE vazio)"; fi
	if [ -n "$TEL_MOTOBOY" ]; then
		for r in perfil fila corrida semana; do
			rota "motoboy/$r?telefone=$TEL_MOTOBOY" "motoboy/$r" || falhas=$((falhas+1))
		done
	else echo "   -    motoboy/*             (TESTE_TEL_MOTOBOY vazio)"; fi
	if [ -n "$TEL_LOJA" ]; then
		rota "loja/perfil?telefone=$TEL_LOJA" "loja/perfil" || falhas=$((falhas+1))
		rota "loja/pedidos?telefone=$TEL_LOJA&status=andamento" "loja/pedidos" || falhas=$((falhas+1))
		rota "loja/entregadores?telefone=$TEL_LOJA&raio=5" "loja/entregadores" || falhas=$((falhas+1))
		rota "loja/semana?telefone=$TEL_LOJA" "loja/semana" || falhas=$((falhas+1))
	else echo "   -    loja/*                (TESTE_TEL_LOJA vazio)"; fi
	echo
	[ "$falhas" -eq 0 ] && verde "   backend ok" || vermelho "   $falhas rota(s) com problema"
	echo
}

# ---------- menu: numero desconhecido ----------
testar_menu() {
	local tel="5500999000001"
	azul "── menu: numero desconhecido ───────────────────────"
	# garante que o backend nao lembra dele
	curl -s -m 30 -o /dev/null -X DELETE -H "x-suporte-api-key: $API_TOKEN" "$API_LOCAL/api/suporte/identificar?telefone=$tel"
	local r1 r2
	r1=$(curl -s -m 120 -X POST "$N8N/webhook/auuii" -H 'Content-Type: application/json' -d "{\"chatId\":\"$tel\",\"message\":\"oi\"}")
	if printf '%s' "$r1" | grep -q "1 - Cliente"; then verde "   ok   menu apareceu para numero desconhecido"
	else vermelho "   x esperava o menu, veio: $(printf '%s' "$r1" | cut -c1-200)"; return 1; fi
	r2=$(curl -s -m 120 -X POST "$N8N/webhook/auuii" -H 'Content-Type: application/json' -d "{\"chatId\":\"$tel\",\"message\":\"2\"}")
	if printf '%s' "$r2" | grep -q "registrei"; then verde "   ok   escolha 2 registrada como Entregador"
	else vermelho "   x esperava confirmacao, veio: $(printf '%s' "$r2" | cut -c1-200)"; return 1; fi
	local id
	id=$(curl -s -m 30 -H "x-suporte-api-key: $API_TOKEN" "$API_LOCAL/api/suporte/identificar?telefone=$tel")
	printf '%s' "$id" | grep -q '"perfil":"motoboy"' && verde "   ok   backend lembra: perfil motoboy (origem menu)" || vermelho "   x backend nao gravou: $id"
	curl -s -m 30 -o /dev/null -X DELETE -H "x-suporte-api-key: $API_TOKEN" "$API_LOCAL/api/suporte/identificar?telefone=$tel"
	echo
}

# ---------- QR Code ----------
gerar_qr() {
	azul "── Evolution: QR Code ($EVO_INST) ───────────────────"
	local estado
	estado=$(curl -s -m 10 -H "apikey: $EVO_KEY" "$EVO/instance/connectionState/$EVO_INST")
	echo "   estado atual: $estado"

	# a instancia precisa existir; se nao existir, cria apontando para o webhook do motoboy
	if printf '%s' "$estado" | grep -q '"status":404'; then
		echo "   criando instancia $EVO_INST..."
		curl -s -m 30 -X POST "$EVO/instance/create" \
			-H 'Content-Type: application/json' -H "apikey: $EVO_KEY" \
			-d "{\"instanceName\":\"$EVO_INST\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true,
			     \"webhook\":{\"url\":\"http://n8n:5678/webhook/motoboy\",\"byEvents\":false,
			     \"base64\":true,\"events\":[\"MESSAGES_UPSERT\"]}}" >/dev/null
	fi

	curl -s -m 30 -H "apikey: $EVO_KEY" "$EVO/instance/connect/$EVO_INST" \
		| PYTHONIOENCODING=utf-8 python -c "
import sys, json, base64, re
d = json.load(sys.stdin)
if d.get('instance', {}).get('state') == 'open':
    print('   ja conectado, nao precisa de QR'); raise SystemExit
b64 = d.get('base64') or ''
if not b64:
    print('   sem QR na resposta:', json.dumps(d, ensure_ascii=False)[:300]); raise SystemExit
open('qrcode-auuii.png', 'wb').write(base64.b64decode(re.sub(r'^data:image/\w+;base64,', '', b64)))
print('   qrcode-auuii.png gerado — escaneie em ate 40s')
print('   WhatsApp > Aparelhos conectados > Conectar aparelho')
"
	echo
}

# ---------- main ----------
case "${1:-todos}" in
api)   testar_api ;;
menu)  testar_menu ;;
qr)    gerar_qr ;;
cliente)     perguntar cliente     "$TEL_CLIENTE" "oi, onde esta meu pedido?" ;;
motoboy)     perguntar motoboy     "$TEL_MOTOBOY" "qual minha posicao na fila?" ;;
restaurante) perguntar restaurante "$TEL_LOJA"    "tem entregador perto da loja agora?" ;;
todos)
	testar_api
	perguntar cliente     "$TEL_CLIENTE" "oi, onde esta meu pedido?"
	perguntar motoboy     "$TEL_MOTOBOY" "qual minha posicao na fila?"
	perguntar restaurante "$TEL_LOJA"    "tem entregador perto da loja agora?"
	testar_menu
	;;
*)
	echo "uso: ./testar.sh [todos|api|menu|qr|cliente|motoboy|restaurante]"
	exit 1
	;;
esac
