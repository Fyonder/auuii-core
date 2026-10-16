# -*- coding: utf-8 -*-
"""
Guardião: tudo de pé? (dono, 16/10/2026: "o 5 só pra mim")

A cada 5 minutos confere o que sustenta o atendimento e avisa UMA pessoa quando algo cai — e
quando volta. Enquanto continua caído, lembra a cada hora. Quem recebe: o 1º número de
SUPORTE_WHATSAPP (dono, 16/10/2026: "os números já vêm do servidor: o meu, o do meu sócio e o
do suporte" — nessa ordem), ou DONO_WHATSAPP se estiver no .env.

  1. Checa (código, chamadas HTTP com 8 s de limite cada):
       - Evolution: /instance/connectionState/goby e /goby-suporte → "open"
       - ponte: http://ponte:3100/saude → ok e conectada ao backend
       - backend (Render): AUUII_API_URL/health → 200
     O n8n não se checa: se ele cair, nada roda — por isso o guardião mora no n8n e não no
     backend (que está na nuvem e cairia junto com a internet de casa).
  2. Compara (código): guarda o estado anterior na memória do fluxo ($getWorkflowStaticData)
     e decide se há aviso: caiu (manda), continua caído há 60 min (lembra), voltou (manda).
  3. Manda no WhatsApp: Evolution sendText pelo número do suporte (goby-suporte); se ESSE for o
     que caiu, pelo número da Nina (goby). Se a Evolution inteira caiu, não tem por onde mandar:
     fica no log e no histórico do n8n (e a próxima rodada, quando voltar, avisa que voltou).

Sem nenhum dos dois no .env, o fluxo confere e registra, mas não manda nada.

Gerar: python n8n/geradores/guardiao.py   (grava n8n/workflows/guardiao.json)
Testar: node --test n8n/test/fluxo-guardiao.test.js
"""
import json
from pathlib import Path

ID = "guardiao00000001"
ARQ = Path(__file__).resolve().parent.parent / "workflows" / "guardiao.json"
INTERVALO_MIN = 5
LEMBRA_MIN = 60
TIMEOUT_CHECA_MS = 8000
TIMEOUT_ENVIO_MS = 15000

JS_CHECA = r"""// Confere cada peça. Nunca lança: o resultado de cada uma é ok/erro, e o Compara decide.
const evo = ($env.EVOLUTION_API_URL || 'http://evolution:8080').replace(/\/+$/, '');
const backend = ($env.AUUII_API_URL || 'https://ifood.onrender.com').replace(/\/+$/, '');
const ponte = ($env.PONTE_URL || 'http://ponte:3100').replace(/\/+$/, '');
const TIMEOUT = 8000;
const pede = async (url, headers = {}) => {
  try {
    const r = await this.helpers.httpRequest({ method: 'GET', url, headers, json: true, timeout: TIMEOUT, ignoreHttpStatusErrors: true, returnFullResponse: true });
    return { status: r.statusCode || r.status || 0, body: r.body ?? r };
  } catch (e) {
    return { status: 0, body: null, erro: String(e && e.message || e).slice(0, 160) };
  }
};
const instancia = async (nome) => {
  const r = await pede(`${evo}/instance/connectionState/${nome}`, { apikey: $env.EVOLUTION_API_KEY || '' });
  const estado = r.body && r.body.instance && r.body.instance.state;
  if (r.status === 0) return { ok: false, detalhe: `Evolution não respondeu (${r.erro || 'sem resposta'})` };
  if (r.status !== 200) return { ok: false, detalhe: `Evolution respondeu ${r.status}` };
  return estado === 'open' ? { ok: true, detalhe: 'conectado' } : { ok: false, detalhe: `WhatsApp ${estado || 'desconhecido'} (precisa ler o QR de novo)` };
};
const saude = async () => {
  const r = await pede(`${ponte}/saude`);
  if (r.status === 0) return { ok: false, detalhe: `ponte não respondeu (${r.erro || 'sem resposta'})` };
  if (r.status !== 200 || !r.body || r.body.ok !== true) return { ok: false, detalhe: `ponte respondeu ${r.status}` };
  if (r.body.conectada !== true) return { ok: false, detalhe: 'ponte de pé, mas sem ligação com o backend (as conversas não chegam ao painel)' };
  return { ok: true, detalhe: `conectada, fila ${r.body.fila || 0}` };
};
const health = async () => {
  const r = await pede(`${backend}/health`);
  if (r.status === 0) return { ok: false, detalhe: `backend não respondeu (${r.erro || 'sem resposta'})` };
  return r.status === 200 ? { ok: true, detalhe: 'ok' } : { ok: false, detalhe: `backend respondeu ${r.status}` };
};
const [goby, suporte, pt, bk] = await Promise.all([instancia('goby'), instancia('goby-suporte'), saude(), health()]);
return [{ json: { em: Date.now(), pecas: {
  'WhatsApp da Nina (goby)': goby,
  'WhatsApp do suporte (goby-suporte)': suporte,
  'Ponte (PC → painel)': pt,
  'Backend (Render)': bk,
} } }];
"""

JS_COMPARA = r"""// Memória entre rodadas: o estado anterior de cada peça e quando foi o último aviso.
const LEMBRA_MS = 60 * 60 * 1000;
const dados = $getWorkflowStaticData('global');
if (!dados.pecas) dados.pecas = {};
const agora = $input.first().json.em || Date.now();
const pecas = $input.first().json.pecas || {};
// O dono: DONO_WHATSAPP, ou o 1º de SUPORTE_WHATSAPP (ordem: dono, sócio, número do suporte).
const primeiroSuporte = String($env.SUPORTE_WHATSAPP || '').split(/[,;\s]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 12)[0] || '';
const destino = String($env.DONO_WHATSAPP || '').replace(/\D/g, '') || primeiroSuporte;
const caidas = [];
const voltaram = [];
const lembrar = [];
for (const [nome, r] of Object.entries(pecas)) {
  const antes = dados.pecas[nome] || { ok: true, desde: null, avisadoEm: null };
  if (!r.ok && antes.ok) {
    dados.pecas[nome] = { ok: false, desde: agora, avisadoEm: agora, detalhe: r.detalhe };
    caidas.push({ nome, detalhe: r.detalhe });
  } else if (!r.ok && !antes.ok) {
    if (agora - (antes.avisadoEm || 0) >= LEMBRA_MS) {
      dados.pecas[nome] = { ...antes, avisadoEm: agora, detalhe: r.detalhe };
      lembrar.push({ nome, detalhe: r.detalhe, haMin: Math.round((agora - (antes.desde || agora)) / 60000) });
    }
  } else if (r.ok && !antes.ok) {
    voltaram.push({ nome, ficouMin: Math.round((agora - (antes.desde || agora)) / 60000) });
    dados.pecas[nome] = { ok: true, desde: null, avisadoEm: null };
  } else {
    dados.pecas[nome] = { ok: true, desde: null, avisadoEm: null };
  }
}
const linhas = [];
if (caidas.length) linhas.push('🔴 *Caiu:*', ...caidas.map((c) => `• ${c.nome}: ${c.detalhe}`));
if (lembrar.length) linhas.push('⏳ *Continua fora:*', ...lembrar.map((c) => `• ${c.nome} há ${c.haMin} min: ${c.detalhe}`));
if (voltaram.length) linhas.push('🟢 *Voltou:*', ...voltaram.map((c) => `• ${c.nome} (ficou ${c.ficouMin} min fora)`));
if (!linhas.length) return [];
const hora = new Date(agora).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
const mensagem = [`🛡️ *Guardião · ${hora}*`, ...linhas].join('\n');
// Por qual número mandar: o do suporte; se ele caiu, o da Nina. Se os dois caíram, não há por onde.
const okSuporte = pecas['WhatsApp do suporte (goby-suporte)'] && pecas['WhatsApp do suporte (goby-suporte)'].ok;
const okNina = pecas['WhatsApp da Nina (goby)'] && pecas['WhatsApp da Nina (goby)'].ok;
const instancia = okSuporte ? 'goby-suporte' : okNina ? 'goby' : null;
if (!destino) return [{ json: { mensagem, semDestino: true, motivo: 'DONO_WHATSAPP e SUPORTE_WHATSAPP vazios no .env' } }];
if (!instancia) return [{ json: { mensagem, semDestino: true, motivo: 'os dois números estão fora: não há por onde mandar' } }];
return [{ json: { telefone: destino, instancia, mensagem } }];
"""


def _id(n):
    return f"5a0d1a00-0000-4000-9000-{n:012d}"


def montar():
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": INTERVALO_MIN}]}},
            "name": "A cada 5 minutos", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2,
            "position": [0, 0], "id": _id(1),
        },
        {
            "parameters": {"jsCode": JS_CHECA},
            "name": "Checa", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [220, 0], "notesInFlow": True, "notes": "Evolution (goby, goby-suporte), ponte, backend", "id": _id(2),
        },
        {
            "parameters": {"jsCode": JS_COMPARA},
            "name": "Compara", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [440, 0], "notesInFlow": True, "notes": "caiu / continua (1 h) / voltou; memória do fluxo", "id": _id(3),
        },
        {
            "parameters": {
                "conditions": {
                    "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                    "conditions": [{"id": _id(4) + "-c", "leftValue": "={{ !$json.semDestino && !!$json.telefone }}", "rightValue": "", "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
                    "combinator": "and",
                },
                "looseTypeValidation": True, "options": {},
            },
            "name": "Tem pra quem?", "type": "n8n-nodes-base.if", "typeVersion": 2.2,
            "position": [660, 0], "id": _id(4),
        },
        {
            "parameters": {
                "method": "POST",
                "url": "={{ $env.EVOLUTION_API_URL }}/message/sendText/{{ $json.instancia }}",
                "sendHeaders": True,
                "headerParameters": {"parameters": [
                    {"name": "apikey", "value": "={{ $env.EVOLUTION_API_KEY }}"},
                    {"name": "Content-Type", "value": "application/json"},
                ]},
                "sendBody": True, "specifyBody": "json",
                "jsonBody": "={{ JSON.stringify({ number: $json.telefone, text: $json.mensagem }) }}",
                "options": {"timeout": TIMEOUT_ENVIO_MS, "response": {"response": {"neverError": True}}},
            },
            "name": "Manda no WhatsApp", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [880, -100], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "pro DONO_WHATSAPP, pelo número que estiver de pé", "id": _id(5),
        },
    ]
    liga = lambda dst, idx=0: {"node": dst, "type": "main", "index": idx}
    conn = {
        "A cada 5 minutos": {"main": [[liga("Checa")]]},
        "Checa": {"main": [[liga("Compara")]]},
        "Compara": {"main": [[liga("Tem pra quem?")]]},
        "Tem pra quem?": {"main": [[liga("Manda no WhatsApp")], []]},
    }
    return {
        "id": ID,
        "name": "Guardião: tudo de pé?",
        "nodes": nodes,
        "connections": conn,
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all", "saveDataErrorExecution": "all",
                     "saveExecutionProgress": False, "timezone": "America/Sao_Paulo"},
        "pinData": {},
        "active": False,
    }


def conferir(f):
    nomes = {n["name"] for n in f["nodes"]}
    assert len(nomes) == len(f["nodes"]), "nome de nó repetido"
    for src, c in f["connections"].items():
        assert src in nomes, src
        for out in c["main"]:
            for d in out:
                assert d["node"] in nomes, d["node"]
    texto = json.dumps(f, ensure_ascii=False)
    import re
    assert not re.search(r"\b55\d{10,11}\b", texto), "telefone no fluxo"
    assert "gsk_" not in texto and "sk-" not in texto
    for n in f["nodes"]:
        if n["type"] == "n8n-nodes-base.httpRequest":
            assert "batching" not in n["parameters"].get("options", {}), "batching do nó HTTP trava (14/10/2026)"
    assert "$env.DONO_WHATSAPP" in texto and "SUPORTE_WHATSAPP" in texto, "o aviso vai só pro dono: DONO_WHATSAPP ou o 1º de SUPORTE_WHATSAPP"
    assert f["connections"]["Tem pra quem?"]["main"][1] == [], "sem destino não manda"


if __name__ == '__main__':
    f = montar()
    conferir(f)
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
