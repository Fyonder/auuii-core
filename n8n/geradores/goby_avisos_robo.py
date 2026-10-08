# -*- coding: utf-8 -*-
"""
Gera n8n/workflows/goby-avisos-robo.json: os avisos que o robô da Goby prepara (painel do sócio,
"Robô do WhatsApp > Avisos no WhatsApp") saem pelo WhatsApp da Goby (instância `goby`).

O que são (instrução do sócio, 07/10/2026):
  - fila de reservas: "seu nome está chegando" (3 próximos) e "é a sua vez, 15 minutos";
  - reserva: 30 min antes, "você vai? SIM ou NÃO" (a resposta é tratada no fluxo da Nina,
    etapa 14 do nina_goby.py: rota=resposta);
  - código de login do app (tipo "codigo"), alertas pra equipe (tipo "equipe"), pedido
    cancelado, indicação premiada, mural marcado "mandar no WhatsApp".
O texto já vem pronto: aqui não se muda o texto.

── FILA COM PROTEÇÃO (dono, 08/10/2026) ─────────────────────────────────────────────────────
Em 08/10 o WhatsApp derrubou o número da Goby às 10:10 (Evolution: LOGOUT, statusReason 401).
Às 9h tinham saído 48 códigos de login pra 42 pessoas diferentes, 3 s entre um e outro, mais os
alertas "fulano não respondeu" (um por motoboy, pros 3 números da equipe). Dono: "os códigos
continuam, mas se o usuário pediu 2 vezes só manda 1, e espera um tempo de proteção".
Agora nada sai direto: tudo entra numa fila (dados estáticos do fluxo) e a cada minuto:
  - CÓDIGO: pediu de novo antes de sair → fica só o mais novo; já saiu um código pra esse
    número há menos de AVISOS_JANELA_CODIGO_MIN (5) → o novo não sai. Vence em 10 min na fila.
  - RITMO: no máximo AVISOS_POR_MINUTO (2) por rodada, 15 s entre eles, e AVISOS_POR_HORA (30).
    Cada rodada cabe em 46 s no pior caso (tempos limite curtos): rodadas não se sobrepõem.
  - ORDEM: código, reserva, os outros, e por último os alertas da equipe.
  - EQUIPE: os alertas na fila pro mesmo número da equipe saem numa mensagem só.
  - Tudo que não sai (vencido, repetido, sem telefone) volta pro robô como
    aviso_resultado ok:false com o motivo; o que sai, ok:true.
Os limites podem ser mudados no .env do Kali (repassado pelo compose) sem mexer no fluxo.

Fluxo (a cada 1 minuto):
  1. GET  <robô>?rota=avisos → { ok, avisos: [{ id, telefone, mensagem, tipo, ... }] } (cada aviso vem UMA vez)
  2. Fila com proteção (código): junta os novos na fila, descarta, escolhe o que sai agora;
  3. Um por envio → POST Evolution /message/sendText/goby, 20 s entre eles → Resultado por aviso;
     Um por descarte → direto pro resultado;
  4. POST <robô> { rota: "aviso_resultado", id, ok, erro? } — um por aviso.
Todas as chamadas ao robô levam o cabeçalho x-api-key (ROBO_GOBY_KEY). 401 = chave errada.

As rodadas são guardadas (saveDataSuccessExecution "all"): com "none" o n8n 2.39 deixava cada uma
marcada "em andamento" pra sempre (07/10). O nó de código voltou (a fila precisa de memória);
a causa do "em andamento" era o "none", não o código.

Uso: python n8n/geradores/goby_avisos_robo.py   (idempotente; mantém o id)
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
ARQ = RAIZ / 'n8n' / 'workflows' / 'goby-avisos-robo.json'
ID = 'gobyAvisosRobo01'

ROBO_URL = "={{ $env.ROBO_GOBY_URL || 'https://emcynyuzuafovconujwo.supabase.co/functions/v1/robo-goby' }}"
ROBO_HEADERS = {"parameters": [{"name": "x-api-key", "value": "={{ $env.ROBO_GOBY_KEY }}"}]}
# Uma rodada TEM que caber em 1 minuto: a fila é lida no começo e gravada no fim; se a rodada
# seguinte começar antes, ela parte da fila velha e manda o mesmo código de novo. Pior caso:
# busca 10 + envio 8 + intervalo 15 + envio 8 + confirma 5 = 46 s (revisão de 08/10).
INTERVALO_MS = 15000   # entre uma mensagem e outra
TIMEOUT_BUSCA_MS = 10000
TIMEOUT_ENVIO_MS = 8000
TIMEOUT_CONFIRMA_MS = 5000

JS_FILA = r"""// Fila com proteção do WhatsApp (dono, 08/10/2026): o número caiu por spam com 48 códigos em 1 h.
const num = (k, d) => { const v = Number($env[k]); return Number.isFinite(v) && v >= 0 ? v : d; };
// No máximo 2: mais que isso a rodada passa de 1 min e a seguinte repete código (a variável só diminui).
const POR_RODADA = Math.min(num('AVISOS_POR_MINUTO', 2), 2);
const POR_HORA = num('AVISOS_POR_HORA', 30);
const JANELA_CODIGO_MS = num('AVISOS_JANELA_CODIGO_MIN', 5) * 60000;
const VIDA_MS = { codigo: 10 * 60000, reserva: 25 * 60000, equipe: 30 * 60000 };
const VIDA_PADRAO = 60 * 60000;
const prioridade = (t) => (t === 'codigo' ? 0 : t === 'reserva' ? 1 : t === 'equipe' ? 3 : 2);
const MAX_TEXTO = 3500;

const agora = Date.now();
const st = $getWorkflowStaticData('global');
let fila = Array.isArray(st.fila) ? st.fila : [];
const enviados = (Array.isArray(st.enviados) ? st.enviados : []).filter((e) => agora - e.em < 3600000);
const descartar = [];
const tira = (a, erro) => descartar.push({ id: a.id, ok: false, erro });
const tel = (t) => String(t || '').replace(/\D/g, '');

// 1) Os novos entram na fila (cada aviso vem uma vez só do robô).
const r = $('Robô: avisos').first().json || {};
const novos = r.ok === true && Array.isArray(r.avisos) ? r.avisos : [];
novos.forEach((a, i) => {
  const t = tel(a.telefone);
  const m = String(a.mensagem || '');
  if (!t) return tira(a, 'aviso sem telefone');
  if (!m.trim()) return tira(a, 'aviso sem mensagem');
  if (fila.some((f) => f.id === a.id)) return;
  const exp = Date.parse(a.expira_em || a.expiraEm || '');
  const criado = Date.parse(a.criado_em || a.criadoEm || '');
  fila.push({ id: a.id, telefone: t, mensagem: m, tipo: String(a.tipo || 'outro'), em: agora,
    criado: Number.isFinite(criado) ? criado : agora + i, expira: Number.isFinite(exp) ? exp : null });
});

// 2) Vencidos saem (código de 10 min parado na fila não serve pra nada).
fila = fila.filter((f) => {
  const vida = VIDA_MS[f.tipo] ?? VIDA_PADRAO;
  if ((f.expira && f.expira < agora) || agora - f.em > vida) { tira(f, 'venceu esperando na fila de proteção do WhatsApp'); return false; }
  return true;
});

// 3) Código: um só por número.
const maisNovo = new Map();
for (const f of fila) if (f.tipo === 'codigo' && (!maisNovo.has(f.telefone) || f.criado >= maisNovo.get(f.telefone).criado)) maisNovo.set(f.telefone, f);
fila = fila.filter((f) => {
  if (f.tipo !== 'codigo') return true;
  const ja = enviados.find((e) => e.tipo === 'codigo' && e.telefone === f.telefone && agora - e.em < JANELA_CODIGO_MS);
  if (ja) { tira(f, 'já saiu um código pra este número há ' + Math.max(1, Math.round((agora - ja.em) / 60000)) + ' min; não manda outro (proteção do WhatsApp)'); return false; }
  if (maisNovo.get(f.telefone) !== f) { tira(f, 'pediu de novo antes de sair: vai só o código mais novo'); return false; }
  return true;
});

// 4) O que sai nesta rodada: prioridade, depois o mais antigo; alertas da equipe juntos.
fila.sort((a, b) => prioridade(a.tipo) - prioridade(b.tipo) || a.em - b.em || a.criado - b.criado);
const enviar = [];
for (const f of [...fila]) {
  if (enviar.length >= POR_RODADA || enviados.length >= POR_HORA) break;
  if (!fila.includes(f)) continue;
  let envio;
  if (f.tipo === 'equipe') {
    let texto = '';
    const ids = [];
    for (const g of fila.filter((x) => x.tipo === 'equipe' && x.telefone === f.telefone)) {
      const mais = (texto ? '\n\n' : '') + g.mensagem;
      if (texto && (texto + mais).length > MAX_TEXTO) break;
      texto += mais;
      ids.push(g.id);
    }
    envio = { ids, telefone: f.telefone, mensagem: texto, tipo: 'equipe' };
  } else {
    envio = { ids: [f.id], telefone: f.telefone, mensagem: f.mensagem, tipo: f.tipo };
  }
  enviar.push(envio);
  fila = fila.filter((g) => !envio.ids.includes(g.id));
  enviados.push({ em: agora, telefone: f.telefone, tipo: f.tipo });
}

st.fila = fila;
st.enviados = enviados;
return [{ json: { enviar, descartar, naFila: fila.length, naUltimaHora: enviados.length } }];
"""

JS_RESULTADO = r"""// Um resultado por aviso: o envio do alerta da equipe pode juntar vários.
const envios = $('Um por envio').all();
const saida = [];
$input.all().forEach((item, i) => {
  const r = item.json || {};
  const e = (envios[i] || {}).json || {};
  const ok = Number(r.statusCode) >= 200 && Number(r.statusCode) < 300 && !r.error;
  let erro = null;
  if (!ok) {
    const m = (r.error && (r.error.message || r.error)) || (r.body && r.body.response && r.body.response.message) || (r.body && r.body.message);
    erro = String(typeof m === 'string' ? m : JSON.stringify(m || '') || ('HTTP ' + r.statusCode)).slice(0, 300) || ('HTTP ' + r.statusCode);
  }
  for (const id of e.ids || []) saida.push({ json: { id, ok, erro } });
});
return saida;
"""

CORPO_RESULTADO = ("={{ JSON.stringify($json.ok === true ? { rota: 'aviso_resultado', id: $json.id, ok: true }"
                   " : { rota: 'aviso_resultado', id: $json.id, ok: false, erro: String($json.erro || 'não enviado') }) }}")


def _id(n):
    return f"a7150b0b-0000-4a00-9000-{n:012d}"


def montar():
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "minutes", "minutesInterval": 1}]}},
            "name": "A cada minuto", "type": "n8n-nodes-base.scheduleTrigger", "typeVersion": 1.2,
            "position": [0, 0], "id": _id(1),
        },
        {
            "parameters": {
                "url": ROBO_URL,
                "sendQuery": True,
                "queryParameters": {"parameters": [{"name": "rota", "value": "avisos"}]},
                "sendHeaders": True,
                "headerParameters": ROBO_HEADERS,
                "options": {"timeout": TIMEOUT_BUSCA_MS, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: avisos", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [220, 0], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "cada aviso vem uma vez só", "id": _id(2),
        },
        {
            "parameters": {"jsCode": JS_FILA},
            "name": "Fila com proteção", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [440, 0],
            "notesInFlow": True, "notes": "1 código por número, 2/min, 30/h; equipe junta",
            "id": _id(3),
        },
        {
            "parameters": {"fieldToSplitOut": "enviar", "options": {}},
            "name": "Um por envio", "type": "n8n-nodes-base.splitOut", "typeVersion": 1,
            "position": [660, -100], "id": _id(4),
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
                "options": {"timeout": TIMEOUT_ENVIO_MS,
                            "batching": {"batch": {"batchSize": 1, "batchInterval": INTERVALO_MS}},
                            "response": {"response": {"neverError": True, "fullResponse": True}}},
            },
            "name": "Manda no WhatsApp", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [880, -100], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "um por vez, 15 s entre eles; texto como veio", "id": _id(6),
        },
        {
            "parameters": {"jsCode": JS_RESULTADO},
            "name": "Resultado por aviso", "type": "n8n-nodes-base.code", "typeVersion": 2,
            "position": [1100, -100], "id": _id(7),
        },
        {
            "parameters": {"fieldToSplitOut": "descartar", "options": {}},
            "name": "Um por descarte", "type": "n8n-nodes-base.splitOut", "typeVersion": 1,
            "position": [880, 120], "id": _id(9),
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
                "options": {"timeout": TIMEOUT_CONFIRMA_MS, "response": {"response": {"neverError": True}}},
            },
            "name": "Robô: confirma", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2,
            "position": [1320, 0], "onError": "continueRegularOutput",
            "notesInFlow": True, "notes": "aviso_resultado (enviado, ou o motivo de não ter saído)", "id": _id(8),
        },
    ]
    liga = lambda dst, idx=0: {"node": dst, "type": "main", "index": idx}
    conn = {
        "A cada minuto": {"main": [[liga("Robô: avisos")]]},
        "Robô: avisos": {"main": [[liga("Fila com proteção")]]},
        "Fila com proteção": {"main": [[liga("Um por envio"), liga("Um por descarte")]]},
        "Um por envio": {"main": [[liga("Manda no WhatsApp")]]},
        "Manda no WhatsApp": {"main": [[liga("Resultado por aviso")]]},
        "Resultado por aviso": {"main": [[liga("Robô: confirma")]]},
        "Um por descarte": {"main": [[liga("Robô: confirma")]]},
    }
    return {
        "id": ID,
        "name": "Goby: avisos do robô (fila e reservas)",
        "nodes": nodes,
        "connections": conn,
        # Guarda as rodadas (o n8n apaga sozinho depois de 14 dias). Com "none", o n8n 2.39
        # deixava cada rodada marcada "em andamento" pra sempre (07/10).
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all", "saveDataErrorExecution": "all",
                     "saveExecutionProgress": False},
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
        assert not _n["type"].endswith(".splitInBatches"), f"sem loop: {_n['name']}"
    texto = json.dumps(f, ensure_ascii=False)
    assert ".item.json" not in texto
    assert "x-api-key" in texto and "aviso_resultado" in texto
    # Proteção do WhatsApp (08/10): nada sai sem passar pela fila, e nunca mais 3 s entre envios.
    assert f["connections"]["Robô: avisos"]["main"][0][0]["node"] == "Fila com proteção"
    _manda = next(n for n in f["nodes"] if n["name"] == "Manda no WhatsApp")
    assert _manda["parameters"]["options"]["batching"]["batch"]["batchInterval"] >= 15000
    assert f["settings"]["saveDataSuccessExecution"] == "all"
    # Rodada < 60 s no pior caso (senão duas rodadas leem a mesma fila e repetem o código).
    _t = {n["name"]: n["parameters"].get("options", {}).get("timeout", 0) for n in f["nodes"]}
    _por_rodada = 2
    _pior = _t["Robô: avisos"] + _por_rodada * _t["Manda no WhatsApp"] + (_por_rodada - 1) * INTERVALO_MS + _t["Robô: confirma"]
    assert _pior < 55000, f"rodada pode passar de 1 min: {_pior} ms"
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
