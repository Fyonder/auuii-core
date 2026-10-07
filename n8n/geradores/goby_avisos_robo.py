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
  2. um por vez, 3 s entre eles (batching do nó de envio; sem loop, que travava sem aviso);
  3. POST Evolution /message/sendText/goby { number, text };
  4. POST <robô> { rota: "aviso_resultado", id, ok: true } ou { ..., ok: false, erro }.
Todas as chamadas ao robô levam o cabeçalho x-api-key (ROBO_GOBY_KEY). 401 = chave errada.

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

JS_SEPARA = r"""// Robô da Goby (rota avisos) → um item por aviso. Cada aviso vem UMA vez só: nada é
// descartado aqui. Sem telefone ou sem texto, o envio falha e o robô fica sabendo pelo
// aviso_resultado. Sem id não dá pra confirmar: esse fica de fora.
const r = $input.first().json || {};
if (r.ok !== true || !Array.isArray(r.avisos)) return [];
return r.avisos
  .filter((a) => a && a.id)
  .map((a) => ({ json: {
    id: String(a.id),
    telefone: String(a.telefone || '').replace(/\D/g, ''),
    mensagem: String(a.mensagem || ''),
    tipo: String(a.tipo || ''),
  } }));
"""

JS_RESULTADO = r"""// Respostas da Evolution → o que o robô precisa saber (aviso_resultado), um por aviso.
// O envio sai na mesma ordem dos avisos: o item i daqui é o aviso i do Separa avisos.
const avisos = $('Separa avisos').all();
return $input.all().map((it, i) => {
  const aviso = (avisos[i] || {}).json || {};
  const r = it.json || {};
  const status = Number(r.statusCode || 0);
  const ok = status >= 200 && status < 300 && !r.error;
  if (ok) return { json: { rota: 'aviso_resultado', id: aviso.id, ok: true } };
  const b = r.body || {};
  const msg = r.error?.message || r.error || b.response?.message || b.message || b.error;
  let erro = (typeof msg === 'string' ? msg : JSON.stringify(msg || '')) || ('HTTP ' + status);
  if (!aviso.telefone) erro = 'aviso sem telefone';
  else if (!String(aviso.mensagem || '').trim()) erro = 'aviso sem mensagem';
  return { json: { rota: 'aviso_resultado', id: aviso.id, ok: false, erro: String(erro).slice(0, 300) } };
});
"""


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
            "parameters": {"jsCode": JS_SEPARA},
            "name": "Separa avisos",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
            "id": _id(3),
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
                "jsonBody": "={{ JSON.stringify({ number: $json.telefone, text: $json.mensagem }) }}",
                # Um por vez, 3 s entre um e outro (rajada faz o WhatsApp bloquear o número).
                # Sem loop: o loop (splitInBatches) ficava esperando para sempre quando não havia aviso.
                "options": {"timeout": 20000,
                            "batching": {"batch": {"batchSize": 1, "batchInterval": 3000}},
                            "response": {"response": {"neverError": True, "fullResponse": True}}},
            },
            "name": "Manda no WhatsApp",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1100, 120],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "um por vez, 3 s entre eles; texto como veio",
            "id": _id(6),
        },
        {
            "parameters": {"jsCode": JS_RESULTADO},
            "name": "Resultado do envio",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [1320, 120],
            "id": _id(7),
        },
        {
            "parameters": {
                "method": "POST",
                "url": ROBO_URL,
                "sendHeaders": True,
                "headerParameters": ROBO_HEADERS,
                "sendBody": True,
                "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify($json) }}",
                "options": {"timeout": 10000, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: confirma",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [1540, 120],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "aviso_resultado (enviado ou o erro)",
            "id": _id(8),
        },
    ]
    liga = lambda dst, idx=0: {"node": dst, "type": "main", "index": idx}
    conn = {
        "A cada minuto": {"main": [[liga("Robô: avisos")]]},
        "Robô: avisos": {"main": [[liga("Separa avisos")]]},
        "Separa avisos": {"main": [[liga("Manda no WhatsApp")]]},
        "Manda no WhatsApp": {"main": [[liga("Resultado do envio")]]},
        "Resultado do envio": {"main": [[liga("Robô: confirma")]]},
    }
    return {
        "id": ID,
        "name": "Goby: avisos do robô (fila e reservas)",
        "nodes": nodes,
        "connections": conn,
        # Roda de minuto em minuto: execução sem aviso não fica guardada.
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "none", "saveDataErrorExecution": "all"},
        "pinData": {},
    }


if __name__ == '__main__':
    f = montar()
    nomes = {n["name"] for n in f["nodes"]}
    assert len(nomes) == len(f["nodes"])
    for src, c in f["connections"].items():
        assert src in nomes, src
        for out in c["main"]:
            for d in out:
                assert d["node"] in nomes, d["node"]
    texto = json.dumps(f, ensure_ascii=False)
    assert ".item.json" not in texto
    import uuid as _uuid
    for _n in f["nodes"]:
        _uuid.UUID(_n["id"])
        if "webhookId" in _n:
            _uuid.UUID(_n["webhookId"])
    assert "x-api-key" in texto and "aviso_resultado" in texto and "rota" in texto
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
