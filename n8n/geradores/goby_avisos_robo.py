# -*- coding: utf-8 -*-
"""
Gera n8n/workflows/goby-avisos-robo.json: os avisos que o robô da Goby prepara (painel do sócio,
"Robô do WhatsApp > Avisos no WhatsApp") saem pelo WhatsApp da Goby (instância `goby`).

O que são (instrução do sócio, 07/10/2026):
  - fila de reservas: "seu nome está chegando" (3 próximos) e "é a sua vez, 15 minutos";
  - reserva: 30 min antes, "você vai? SIM ou NÃO" (a resposta é tratada no fluxo da Nina,
    etapa 14 do nina_goby.py: rota=resposta);
  - pedido cancelado que estava com ele, indicação premiada, mural marcado "mandar no WhatsApp".
O texto já vem pronto. A Go By decide quem recebe e quando: aqui não se repete, não se reenvia
e não se muda o texto.

Fluxo (a cada 1 minuto, porque aviso não buscado em poucos minutos é descartado):
  1. GET  <robô>?rota=avisos          → { ok, avisos: [{ id, telefone, mensagem, tipo, esperaResposta }] }
     Cada aviso vem UMA vez só (até 15 por vez, os urgentes primeiro). Nada de testar na mão:
     buscar sem mandar perde o aviso.
  2. tem aviso? → um item por aviso (Split Out);
  3. POST Evolution /message/sendText/goby { number, text }, um por vez, 3 s entre eles
     (batching do próprio nó: rajada faz o WhatsApp bloquear o número);
  4. POST <robô> { rota: "aviso_resultado", id, ok: true } ou { ..., ok: false, erro }.
Todas as chamadas ao robô levam o cabeçalho x-api-key (ROBO_GOBY_KEY). 401 = chave errada.

Sem nó de código (07/10, 16:32): as rodadas ficavam "em andamento" para sempre, e o log do n8n
mostrava o executor de código recusando tarefa ("Offer expired"). Split Out, IF e expressões não
passam pelo executor. Também sem loop (splitInBatches), que travava sem aviso.

Substitui o goby_vez_na_fila.py (que esperava uma rota "vez" que o sócio não criou).

Uso: python n8n/geradores/goby_avisos_robo.py   (idempotente; mantém o id)
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
ARQ = RAIZ / 'n8n' / 'workflows' / 'goby-avisos-robo.json'
ID = 'gobyAvisosRobo01'

ROBO_URL = "={{ $env.ROBO_GOBY_URL || 'https://emcynyuzuafovconujwo.supabase.co/functions/v1/robo-goby' }}"
ROBO_HEADERS = {"parameters": [{"name": "x-api-key", "value": "={{ $env.ROBO_GOBY_KEY }}"}]}

# O aviso que gerou este envio (mesma ordem: o item i do envio é o aviso i).
AVISO = "$('Um item por aviso').all()[$itemIndex].json"
ENVIOU = "(Number($json.statusCode) >= 200 && Number($json.statusCode) < 300 && !$json.error)"
ERRO = ("(() => { const b = $json.body || {}; const m = $json.error?.message || $json.error || b.response?.message || b.message || b.error;"
        " const a = " + AVISO + ";"
        " if (!String(a.telefone || '').replace(/\\D/g, '')) return 'aviso sem telefone';"
        " if (!String(a.mensagem || '').trim()) return 'aviso sem mensagem';"
        " return String(typeof m === 'string' ? m : JSON.stringify(m || '') || ('HTTP ' + $json.statusCode)).slice(0, 300); })()")
CORPO_RESULTADO = ("={{ JSON.stringify(" + ENVIOU + " ? { rota: 'aviso_resultado', id: " + AVISO + ".id, ok: true }"
                   " : { rota: 'aviso_resultado', id: " + AVISO + ".id, ok: false, erro: " + ERRO + " }) }}")


def _id(n):
    return f"a7150b0b-0000-4a00-9000-{n:012d}"


def montar():
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}},
            "name": "A cada minuto",
            "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2,
            "position": [0, 0],
            "id": _id(1),
        },
        {
            "parameters": {
                "url": ROBO_URL,
                "sendQuery": True,
                "queryParameters": {"parameters": [{"name": "rota", "value": "avisos"}]},
                "sendHeaders": True,
                "headerParameters": ROBO_HEADERS,
                "options": {"timeout": 15000, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: avisos",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [220, 0],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "cada aviso vem uma vez só",
            "id": _id(2),
        },
        {
            "parameters": {
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                    "conditions": [{
                        "id": "tem1",
                        "leftValue": "={{ $json.ok === true && Array.isArray($json.avisos) && $json.avisos.length > 0 }}",
                        "rightValue": "",
                        "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                    }],
                    "combinator": "and",
                },
                "options": {},
            },
            "name": "Tem aviso?",
            "type": "n8n-nodes-base.if",
            "typeVersion": 2.2,
            "position": [440, 0],
            "id": _id(3),
        },
        {
            "parameters": {"fieldToSplitOut": "avisos", "options": {}},
            "name": "Um item por aviso",
            "type": "n8n-nodes-base.splitOut",
            "typeVersion": 1,
            "position": [660, -20],
            "id": _id(4),
        },
        {
            "parameters": {
                "method": "POST",
                "url": "={{ $env.EVOLUTION_API_URL }}/message/sendText/goby",
                "sendHeaders": True,
                "headerParameters": {"parameters": [
                    {"name": "apikey", "value": "={{ $env.EVOLUTION_API_KEY }}"},
                    {"name": "Content-Type", "value": "application/json"},
                ]},
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ number: String($json.telefone || '').replace(/\\D/g, ''), text: String($json.mensagem || '') }) }}",
                # Um por vez, 3 s entre um e outro (rajada faz o WhatsApp bloquear o número).
                "options": {"timeout": 20000,
                            "batching": {"batch": {"batchSize": 1, "batchInterval": 3000}},
                            "response": {"response": {"neverError": True, "fullResponse": True}}},
            },
            "name": "Manda no WhatsApp",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [880, -20],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "um por vez, 3 s entre eles; texto como veio",
            "id": _id(6),
        },
        {
            "parameters": {
                "method": "POST",
                "url": ROBO_URL,
                "sendHeaders": True,
                "headerParameters": ROBO_HEADERS,
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": CORPO_RESULTADO,
                "options": {"timeout": 10000, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: confirma",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1100, -20],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "aviso_resultado (enviado ou o erro)",
            "id": _id(8),
        },
    ]
    liga = lambda dst, idx=0: {"node": dst, "type": "main", "index": idx}
    conn = {
        "A cada minuto": {"main": [[liga("Robô: avisos")]]},
        "Robô: avisos": {"main": [[liga("Tem aviso?")]]},
        "Tem aviso?": {"main": [[liga("Um item por aviso")], []]},
        "Um item por aviso": {"main": [[liga("Manda no WhatsApp")]]},
        "Manda no WhatsApp": {"main": [[liga("Robô: confirma")]]},
    }
    return {
        "id": ID,
        "name": "Goby: avisos do robô (fila e reservas)",
        "nodes": nodes,
        "connections": conn,
        # Roda de minuto em minuto: execução sem aviso não fica guardada. O progresso fica
        # gravado pra, se travar de novo, dar pra ver em que nó parou.
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "none", "saveDataErrorExecution": "all",
                     "saveExecutionProgress": True},
        "pinData": {},
    }


if __name__ == '__main__':
    import uuid as _uuid
    f = montar()
    nomes = {n["name"] for n in f["nodes"]}
    assert len(nomes) == len(f["nodes"])
    for src, c in f["connections"].items():
        assert src in nomes, src
        for out in c["main"]:
            for d in out:
                assert d["node"] in nomes, d["node"]
    for _n in f["nodes"]:
        _uuid.UUID(_n["id"])
        assert not _n["type"].endswith((".code", ".splitInBatches")), f"sem nó de código nem loop: {_n['name']}"
    texto = json.dumps(f, ensure_ascii=False)
    assert ".item.json" not in texto
    assert "x-api-key" in texto and "aviso_resultado" in texto
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
