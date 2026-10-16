# -*- coding: utf-8 -*-
"""
Suporte: resumo do dia (dono, 16/10/2026: "o 2 é só pra 2 adms do painel")

Todo dia, no horário que o painel escolher (Configurações → WhatsApp e Nina → Número do
suporte), manda por WhatsApp um resumo do número do suporte pra até 2 pessoas cadastradas lá.
Quem monta o texto é o backend (suporteAutomacoes.js: conversas, 1ª resposta, quem espera,
Nina); o n8n só pergunta a hora certa e manda.

  1. A cada 15 minutos → GET /api/suporte/goby/suporte/automacoes (chave da Goby).
  2. É hora? (código): ligado, com destinatários, dentro da janela de 15 min do horário, e
     ainda não mandou hoje (memória do fluxo). Senão, para.
  3. GET /api/suporte/goby/suporte/resumo-dia?dia=hoje → texto pronto.
  4. Uma por pessoa (código): marca "mandou hoje" e vira um item por destinatário.
  5. Manda no WhatsApp pelo número do suporte (goby-suporte).

Gerar: python n8n/geradores/resumo_dia.py   (grava n8n/workflows/resumo-dia.json)
Testar: node --test n8n/test/fluxo-resumo.test.js
"""
import json
from pathlib import Path

ID = "resumoDia0000001"
ARQ = Path(__file__).resolve().parent.parent / "workflows" / "resumo-dia.json"
INTERVALO_MIN = 15
TIMEOUT_MS = 30000
TIMEOUT_ENVIO_MS = 15000
BACKEND = "={{ $env.AUUII_API_URL }}/api/suporte/goby/suporte/"
CHAVE = {"parameters": [{"name": "x-suporte-api-key", "value": "={{ $env.AUUII_API_TOKEN_GOBY || $env.AUUII_API_TOKEN }}"}]}

JS_E_HORA = r"""// Só segue se for a hora e ainda não mandou hoje. A janela tem o tamanho do intervalo
// do gatilho (15 min): o horário "21:30" dispara na rodada entre 21:30 e 21:44.
const JANELA_MIN = 15;
const cfg = ($input.first().json || {}).resumoDiario || {};
if (!cfg.ligado) return [];
const destinatarios = (Array.isArray(cfg.destinatarios) ? cfg.destinatarios : [])
  .map((d) => ({ nome: String(d.nome || '').trim(), telefone: String(d.telefone || '').replace(/\D/g, '') }))
  .filter((d) => d.telefone.length >= 12);
if (!destinatarios.length) return [];
const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(cfg.horario || ''));
if (!m) return [];
const alvo = Number(m[1]) * 60 + Number(m[2]);
const agora = $env.RESUMO_AGORA ? Number($env.RESUMO_AGORA) : Date.now();
const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(agora));
const p = (t) => partes.find((x) => x.type === t).value;
const hoje = `${p('year')}-${p('month')}-${p('day')}`;
const minuto = Number(p('hour')) * 60 + Number(p('minute'));
if (minuto < alvo || minuto >= alvo + JANELA_MIN) return [];
const dados = $getWorkflowStaticData('global');
if (dados.ultimoDia === hoje) return [];
return [{ json: { dia: hoje, destinatarios } }];
"""

JS_UMA_POR_PESSOA = r"""// Marca que mandou hoje ANTES de enviar: se o envio falhar, não fica tentando a cada 15 min
// (quem quiser confere no histórico do n8n). Um item por destinatário.
const hora = $('É hora?').first().json;
const resumo = $input.first().json || {};
const texto = String(resumo.texto || '').trim();
if (!texto) return [];
const dados = $getWorkflowStaticData('global');
dados.ultimoDia = hora.dia;
return hora.destinatarios.map((d) => ({ json: { telefone: d.telefone, nome: d.nome, mensagem: texto } }));
"""


def _id(n):
    return f"0e5d0d1a-0000-4000-9000-{n:012d}"


def montar():
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": INTERVALO_MIN}]}},
            "name": "A cada 15 minutos", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2,
            "position": [0, 0], "id": _id(1),
        },
        {
            "parameters": {"method": "GET", "url": BACKEND + "automacoes", "sendHeaders": True, "headerParameters": CHAVE, "options": {"timeout": TIMEOUT_MS}},
            "name": "Automações", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [220, 0], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "o que o painel configurou (horário, destinatários); backend fora = rodada em branco", "id": _id(2),
        },
        {
            "parameters": {"jsCode": JS_E_HORA},
            "name": "É hora?", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [440, 0], "notesInFlow": True, "notes": "ligado, na janela do horário, 1 vez por dia", "id": _id(3),
        },
        {
            "parameters": {"method": "GET", "url": "={{ $env.AUUII_API_URL }}/api/suporte/goby/suporte/resumo-dia?dia={{ $json.dia }}", "sendHeaders": True, "headerParameters": CHAVE, "options": {"timeout": TIMEOUT_MS}},
            "name": "Resumo", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [660, 0], "notesInFlow": True, "notes": "o backend monta o texto", "id": _id(4),
        },
        {
            "parameters": {"jsCode": JS_UMA_POR_PESSOA},
            "name": "Uma por pessoa", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [880, 0], "id": _id(5),
        },
        {
            "parameters": {
                "method": "POST",
                "url": "={{ $env.EVOLUTION_API_URL }}/message/sendText/goby-suporte",
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
            "position": [1100, 0], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "pelo número do suporte, pra cada destinatário", "id": _id(6),
        },
    ]
    liga = lambda dst, idx=0: {"node": dst, "type": "main", "index": idx}
    conn = {
        "A cada 15 minutos": {"main": [[liga("Automações")]]},
        "Automações": {"main": [[liga("É hora?")]]},
        "É hora?": {"main": [[liga("Resumo")]]},
        "Resumo": {"main": [[liga("Uma por pessoa")]]},
        "Uma por pessoa": {"main": [[liga("Manda no WhatsApp")]]},
    }
    return {
        "id": ID,
        "name": "Suporte: resumo do dia",
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
            if n["name"] != "Manda no WhatsApp":
                assert n["parameters"]["headerParameters"] == CHAVE, n["name"]
    assert "sendText/goby-suporte" in texto, "o resumo sai pelo número do suporte"


if __name__ == '__main__':
    f = montar()
    conferir(f)
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
