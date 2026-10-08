# -*- coding: utf-8 -*-
"""
Gera n8n/workflows/goby-vez-na-fila.json — a Nina avisa o motoboy quando chega a vez dele de
escolher a vaga (dono, 04/10/2026: "quando a fila tiver rodando a Nina tem que mandar
mensagem pro motoboy: sua vez de escolher sua vaga").

Por que é o n8n que pergunta (e não o sistema da Goby que avisa): o n8n roda no PC Kali, sem
porta aberta — nada de fora alcança ele. Então, a cada minuto, ele pergunta ao robô da Goby
quem está na vez e manda a mensagem pela instância `goby` da Evolution. A ponte grava o envio
na conversa (aba Atendimento), como qualquer mensagem da Nina.

DEPENDE de uma rota nova no robô do sócio (hoje não existe):
    GET <ROBO_GOBY_URL>?rota=vez        cabeçalho x-api-key (sem telefone)
    → { ok: true, estado: "rodando" | "sem_ciclo",
        naVez: [ { telefone: "5544999990000", nome: "MARIA ...", desde: ISO, ate: ISO } ] }
`naVez` pode vir objeto ou lista. Enquanto a rota não existir, o robô responde ok:false e
nada é enviado. O fluxo é importado DESLIGADO; liga quando a rota existir.

Uso: python n8n/geradores/goby_vez_na_fila.py   (idempotente; mantém o id)
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
ARQ = RAIZ / 'n8n' / 'workflows' / 'goby-vez-na-fila.json'
ID = 'gobyVezNaFila001'

ROBO_URL = "={{ $env.ROBO_GOBY_URL || 'https://emcynyuzuafovconujwo.supabase.co/functions/v1/robo-goby' }}"

# Lógica de quem avisar. Cada vez (telefone + início) é avisada UMA vez; a lembrança fica nos
# dados estáticos do fluxo por 6 h. Sem nome, sem horário: a mensagem se ajusta.
JS_QUEM_AVISAR = r"""// Robô da Goby (rota vez) → quem acabou de entrar na vez de escolher vaga.
const r = $input.first().json || {};
const st = $getWorkflowStaticData('global');
const avisados = st.avisados || (st.avisados = {});
const agora = Date.now();
for (const [k, em] of Object.entries(avisados)) if (agora - em > 6 * 3600 * 1000) delete avisados[k];

if (r.ok !== true || String(r.estado || '').toLowerCase() !== 'rodando') return [];
const lista = Array.isArray(r.naVez) ? r.naVez : (r.naVez ? [r.naVez] : []);

const titulo = (t) => String(t || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const hora = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : null;
};

const saida = [];
for (const v of lista) {
  const tel = String(v.telefone || '').replace(/\D/g, '');
  if (tel.length < 10) continue;
  const numero = tel.startsWith('55') ? tel : '55' + tel;
  const chave = numero + '|' + (v.desde || v.inicio || '');
  if (avisados[chave]) continue;
  avisados[chave] = agora;
  const nome = titulo(String(v.nome || '').split(/\s+-\s+|\s+/)[0]);
  const ate = hora(v.ate || v.fim);
  const min = Number(r.tempoMaximoDaVezMin || v.minutos) || null;
  const prazo = ate ? ` até as ${ate}` : (min ? ` nos próximos ${min} min` : '');
  saida.push({ json: {
    number: numero,
    text: `Oi${nome ? ', ' + nome : ''}! Chegou a sua vez de escolher sua vaga na Go By. Abre o app e reserva${prazo}. 🛵`,
  } });
}
return saida;
"""


def montar():
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}},
            "name": "A cada minuto",
            "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2,
            "position": [0, 0],
            "id": "c1a0f5e2-0b1e-4d2a-9f00-000000000001",
        },
        {
            "parameters": {
                "url": ROBO_URL,
                "sendQuery": True,
                "queryParameters": {"parameters": [{"name": "rota", "value": "vez"}]},
                "sendHeaders": True,
                "headerParameters": {"parameters": [{"name": "x-api-key", "value": "={{ $env.ROBO_GOBY_KEY }}"}]},
                "options": {"timeout": 8000, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: quem está na vez",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [220, 0],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "rota vez do robô da Goby (precisa existir)",
            "id": "c1a0f5e2-0b1e-4d2a-9f00-000000000002",
        },
        {
            "parameters": {"jsCode": JS_QUEM_AVISAR},
            "name": "Quem avisar",
            "type": "n8n-nodes-base.code",
            "typeVersion": 2,
            "position": [440, 0],
            "notesInFlow": True,
            "notes": "cada vez é avisada uma vez só",
            "id": "c1a0f5e2-0b1e-4d2a-9f00-000000000003",
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
                "jsonBody": "={{ JSON.stringify({ number: $json.number, text: $json.text }) }}",
                "options": {},
            },
            "name": "Avisar no WhatsApp",
            "type": "n8n-nodes-base.httpRequest",
            "typeVersion": 4.2,
            "position": [660, 0],
            "onError": "continueRegularOutput",
            "notesInFlow": True,
            "notes": "número da Goby (instância goby)",
            "id": "c1a0f5e2-0b1e-4d2a-9f00-000000000004",
        },
    ]
    conn = {
        "A cada minuto": {"main": [[{"node": "Robô: quem está na vez", "type": "main", "index": 0}]]},
        "Robô: quem está na vez": {"main": [[{"node": "Quem avisar", "type": "main", "index": 0}]]},
        "Quem avisar": {"main": [[{"node": "Avisar no WhatsApp", "type": "main", "index": 0}]]},
    }
    return {
        "id": ID,
        "name": "Goby: sua vez na fila (Nina)",
        "nodes": nodes,
        "connections": conn,
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "none"},
        "pinData": {},
    }


if __name__ == '__main__':
    f = montar()
    nomes = {n["name"] for n in f["nodes"]}
    for src, c in f["connections"].items():
        assert src in nomes
        for out in c["main"]:
            for d in out:
                assert d["node"] in nomes
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
