# -*- coding: utf-8 -*-
"""
Gera n8n/workflows/nina-aprende-suporte.json: a Nina APRENDE com o número do suporte.

Dono (13/10/2026): "a Nina aprende a conversar com as mensagens do número do suporte" (o
Goby.delivery, instância `goby-suporte` da Evolution — lá a Nina NÃO responde, é só a equipe).
Decisões dele no mesmo dia: o gerente aprova antes de valer; lê também o histórico (90 dias);
o texto pode ir pra Groq desde que limpo antes.

Toda madrugada (03:30, horário de Brasília):
  1. GET backend /api/suporte/goby/aprender/estado      até onde já leu (ultimoTs, historicoAte)
     GET backend /api/suporte/goby/aprender/existentes  o que a Nina já sabe ou foi recusado
  2. Monta lotes (código): lê a Evolution (findMessages, da mais nova pra mais antiga, com busca
     binária pra achar a página da data), fica só com conversa PRIVADA que a equipe respondeu,
     separa em atendimentos (6 h sem mensagem = outro atendimento), TROCA dado pessoal por
     marcador ([nome], [telefone], [valor], [placa], [endereço], [cpf], [email], [link],
     [número]) e junta em lotes. Primeiro o que chegou desde a última rodada; com a sobra, uma
     fatia do histórico (NINA_APRENDE_FATIA_DIAS por noite, até NINA_APRENDE_HISTORICO_DIAS).
  3. Groq lê cada lote (um por vez, com intervalo): tira regras "Quando…, …" e o jeito de falar.
  4. Junta o que achou → Groq junta as parecidas e tira o que a Nina já sabe (devolve QUAIS
     candidatas cada regra junta; quem soma as conversas é o código, não a IA).
  5. Prepara envio: só regra que apareceu em NINA_APRENDE_MIN_CONVERSAS (3) conversas, sem
     marcador sobrando, no máximo 30 → POST backend /aprender/sugestoes. Lá elas viram
     SUGESTÃO: só valem quando um gerente aprova no painel (O que a Nina aprendeu).
  6. Salva até onde leu (POST /aprender/estado). Se mais da metade dos lotes falhou, ou a junção
     falhou, NÃO avança: a mesma janela é lida de novo na noite seguinte.

"Testar leitura (sem IA)" (gatilho manual, é o que o `n8n execute --id` roda): faz o passo 2 e
para — devolve só contagens (mensagens, atendimentos, lotes). Nenhum texto sai, nada é gravado.

Nada de segredo aqui (o repositório é público): Evolution, backend e Groq vêm do .env do Kali
e da credencial "Groq account" do n8n.

Uso: python n8n/geradores/nina_aprende_suporte.py   (idempotente; mantém o id)
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
ARQ = RAIZ / 'n8n' / 'workflows' / 'nina-aprende-suporte.json'
ID = 'ninaAprendeSup01'
GROQ_CRED = {"groqApi": {"id": "gaY6xZiXOm9LALP6", "name": "Groq account"}}
GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
BACKEND = "={{ $env.AUUII_API_URL }}/api/suporte/goby/aprender/"
CHAVE = {"parameters": [{"name": "x-suporte-api-key", "value": "={{ $env.AUUII_API_TOKEN_GOBY }}"}]}
# COTA DA GROQ (13/10/2026, 1ª rodada): a conta está no plano grátis — o gpt-oss-120b (o modelo
# da Nina) tem 8.000 tokens/minuto e um teto por dia, e cada lote gasta ~7 mil. 14 dos 23 lotes
# voltaram 429 e, pior, a rodada comia a cota do DIA da Nina. Decisão do dono: o aprendizado usa
# um modelo SÓ DELE (MODELO_PADRAO, cota própria) e vai devagar: 1 lote por minuto, resposta
# curta, e uma pausa antes da junção. Trocar o modelo: NINA_APRENDE_MODELO no .env do Kali.
# Modelo SÓ do aprendizado, com cota própria (a Groq conta tokens por modelo). Não é o da Nina
# (gpt-oss-120b). O Llama 4 Scout saiu do catálogo da Groq: em 14/10/2026 a rodada das 03:30
# levou 404 "model_not_found" nos 30 lotes. O gpt-oss-20b a conta já usa (reserva da Nina).
MODELO_PADRAO = 'openai/gpt-oss-20b'
# Entre um lote e outro: a Groq conta tokens POR MINUTO. Fica abaixo de 65 s de propósito: a
# partir de 65 s o nó Wait do n8n grava a execução como "esperando" e depende do relógio
# interno pra voltar; abaixo disso ele espera em memória, simples. 61 s já vira o minuto.
GROQ_INTERVALO_S = 61
GROQ_MAX_RESPOSTA = 3000
PAUSA_ANTES_DA_JUNCAO_S = 65
GROQ_TIMEOUT_MS = 120000

PROMPT_LOTE = """Você analisa conversas do SUPORTE HUMANO da Goby, um app de entregas (delivery). \
Quem escreve (M) é motoboy/entregador ou restaurante/loja; quem responde (S) é a equipe de suporte. \
Os dados pessoais já foram trocados por marcadores como [nome], [telefone], [valor], [placa], [endereço], [número].

Objetivo: ensinar a Nina, a assistente virtual da Goby, a atender casos PARECIDOS do jeito que a equipe atende.

Tire do lote:
1. "regras": situações que se repetem e o que a equipe faz, responde ou pergunta de volta. Cada regra:
   - em português, 1 ou 2 frases, até 300 caracteres, começando com "Quando";
   - geral: nunca cite nome, telefone, valor em dinheiro, placa, endereço, número de pedido, nome de loja ou bairro;
   - só o que a equipe de fato fez: não invente política, prazo nem valor;
   - fora: assunto interno da equipe, brincadeira, conversa pessoal, caso que só fez sentido uma vez;
   - "tema": 1 a 3 palavras (ex.: retirada, pedido junto, cliente não atende, pagamento, app, cadastro, corridas e vagas);
   - "conversas": os números das conversas deste lote em que a situação aparece.
2. "jeito": até 3 frases curtas sobre o JEITO de a equipe falar (tom, tamanho, como cumprimenta, como encerra), se der pra ver.

Responda SÓ JSON: {"regras":[{"texto":"...","tema":"...","conversas":[1,4]}],"jeito":["..."]}. \
Sem regra boa no lote: {"regras":[],"jeito":[]}."""

PROMPT_JUNTA = """Você junta regras de atendimento tiradas de vários lotes de conversas do suporte da Goby (delivery), \
pra ensinar a Nina, a assistente virtual. Você recebe:
- JÁ SABE: o que a Nina já sabe, ou que um gerente já recusou. Não devolva nada com o mesmo sentido.
- CANDIDATAS: numeradas a partir de 0, com o tema e em quantas conversas apareceram.

Faça:
1. Junte as candidatas com o MESMO sentido numa regra só e liste os números delas em "de". Temas diferentes \
(transferir vaga, cliente que não atende, código do pedido, maquininha, app...) são regras DIFERENTES: nunca \
resuma vários temas numa regra só.
2. Toda candidata com 3 conversas ou mais tem que estar no "de" de alguma regra (juntada ou sozinha), a não \
ser que caia no item 5. Devolver poucas regras quando há muitas candidatas é ERRO.
3. Reescreva cada regra clara e geral, em português, começando com "Quando", até 300 caracteres. Sem nome, \
telefone, valor em dinheiro, placa, endereço, número de pedido ou nome de loja, e sem marcadores como [nome].
4. Do jeito de falar (tema "jeito de falar"), no máximo 2 regras, começando com "Ao responder".
5. Descarte o que for caso isolado, confuso, contraditório entre as candidatas, ou que prometa valor, prazo ou \
política que a equipe não deixou claro.
6. No máximo 30 regras, as mais úteis primeiro.

Responda SÓ JSON: {"regras":[{"texto":"...","tema":"...","de":[0,3,7]}]}. Nada pra ensinar: {"regras":[]}."""

# ─── Código dos nós ──────────────────────────────────────────────────────────────────────────
# Strings cruas (r"""): o JS vai como está. Os testes (n8n/test/fluxo-aprende.test.js) rodam
# este código com uma Evolution de mentira.

JS_MONTA = r"""// Lê o número do suporte na Evolution e monta os lotes pra Groq. Só texto LIMPO sai daqui.
const num = (k, d) => { const v = Number($env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const INSTANCIA = $env.NINA_APRENDE_INSTANCIA || 'goby-suporte';
const DIAS_HISTORICO = num('NINA_APRENDE_HISTORICO_DIAS', 90);
const FATIA_DIAS = num('NINA_APRENDE_FATIA_DIAS', 5);
const MAX_LOTES = num('NINA_APRENDE_MAX_LOTES', 30);
const LOTE_CHARS = num('NINA_APRENDE_LOTE_CHARS', 12000);
const PAGINA = 1000;
const NOVO_ATENDIMENTO_S = 6 * 3600;   // 6 h sem mensagem: é outro atendimento
const TURNO_MAX = 300;                 // letras por fala (várias mensagens seguidas = uma fala)
const ATENDIMENTO_MAX = 2500;          // letras por atendimento
let seco = false;
try { seco = !!$('Testar leitura (sem IA)').isExecuted; } catch (e) { seco = false; }

const estado = ($('Estado').first().json || {}).estado || {};
const agora = Math.floor(Date.now() / 1000);
const recenteDe = Number.isInteger(estado.ultimoTs) ? estado.ultimoTs : agora - 86400;
const alvoHistorico = agora - DIAS_HISTORICO * 86400;
const histAte = Number.isInteger(estado.historicoAte) ? estado.historicoAte : recenteDe;
const querHistorico = !estado.historicoCompleto && histAte > alvoHistorico;
const histDe = Math.max(alvoHistorico, histAte - FATIA_DIAS * 86400);

// ── Evolution: da mais nova pra mais antiga. Acha a página da data por busca binária. ──
const pedir = async (page) => {
  const r = await this.helpers.httpRequest({
    method: 'POST',
    url: `${$env.EVOLUTION_API_URL}/chat/findMessages/${INSTANCIA}`,
    headers: { apikey: $env.EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
    body: { page, offset: PAGINA },
    json: true,
    timeout: 60000,
  });
  const m = (r && r.messages) || {};
  return { pages: Number(m.pages) || 0, records: Array.isArray(m.records) ? m.records : [] };
};
let primeira = null;
const paginas = new Map();
const pagina = async (p) => {
  if (!paginas.has(p)) paginas.set(p, (await pedir(p)).records);
  return paginas.get(p);
};
const tsDe = (r) => Number(r && r.messageTimestamp) || 0;
const maisVelha = (recs) => (recs.length ? tsDe(recs[recs.length - 1]) : -Infinity);
async function lerJanela(de, ate) {
  if (!primeira) { primeira = await pedir(1); paginas.set(1, primeira.records); }
  const total = primeira.pages;
  if (!total || de > ate) return [];
  let lo = 1, hi = total;
  while (lo < hi) {
    const meio = Math.floor((lo + hi) / 2);
    if (maisVelha(await pagina(meio)) <= ate) hi = meio; else lo = meio + 1;
  }
  const saida = [];
  for (let p = lo; p <= total; p++) {
    const recs = await pagina(p);
    for (const r of recs) { const ts = tsDe(r); if (ts >= de && ts <= ate) saida.push(r); }
    if (maisVelha(recs) < de) break;
  }
  return saida;
}

// ── Limpeza de dado pessoal (antes de qualquer coisa sair do Kali) ──
const TROCAS = [
  [/https?:\/\/\S+|www\.\S+/gi, '[link]'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]'],
  [/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, '[cnpj]'],
  [/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[cpf]'],
  [/(?:\+?55[\s.-]?)?\(?\b\d{2}\)?[\s.-]?9?[\s.-]?\d{4}[\s.-]?\d{4}\b/g, '[telefone]'],
  [/R\$\s?\d[\d.,]*|\b\d+(?:[.,]\d{1,2})?\s?(?:reais|real|conto|pila)\b|\b\d+,\d{2}\b/gi, '[valor]'],
  [/\b[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}\b/g, '[placa]'],
  [/\b(?:rua|r\.|av\.?|avenida|travessa|tv\.|alameda|rodovia|estrada)\s+[^,\n.!?]{2,40}(?:,?\s*(?:n[ºo°]?\.?\s*)?\d+)?/gi, '[endereço]'],
  [/\b\d{5,}\b/g, '[número]'],
];
const escapa = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function limpar(texto, nomes) {
  let t = String(texto || '');
  for (const [re, marca] of TROCAS) t = t.replace(re, marca);
  for (const n of nomes) t = t.replace(new RegExp(`(^|[^\\p{L}])${escapa(n)}(?=$|[^\\p{L}])`, 'giu'), `$1[nome]`);
  return t.replace(/\s+/g, ' ').trim();
}
// Palavras do nome do WhatsApp de quem escreveu (≥ 3 letras). Também tira "Goby", que
// aparece em todo canto e não é dado pessoal — não deixa virar [nome].
const LIVRES = new Set(['goby', 'delivery', 'suporte', 'motoboy', 'entregas', 'loja']);
const nomesDe = (pushName) => String(pushName || '').split(/[^\p{L}]+/u)
  .filter((p) => p.length >= 3 && !LIVRES.has(p.toLowerCase()));

const MIDIA = {
  audioMessage: '[áudio]', imageMessage: '[foto]', stickerMessage: '[figurinha]', videoMessage: '[vídeo]',
  locationMessage: '[localização]', liveLocationMessage: '[localização]', documentMessage: '[documento]',
  contactMessage: '[contato]', ptvMessage: '[vídeo]',
};
function textoDe(r) {
  const m = r.message || {};
  const t = m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text)
    || (m.imageMessage && m.imageMessage.caption) || (m.videoMessage && m.videoMessage.caption) || '';
  return t ? String(t) : (MIDIA[r.messageType] || '');
}
const privado = (jid) => !!jid && !/@g\.us$|@broadcast$|@newsletter$/.test(jid);

// ── Atendimentos: conversa privada, cortada a cada 6 h de silêncio, com resposta da equipe ──
function atendimentos(registros) {
  const porChat = new Map();
  const vistos = new Set();
  for (const r of registros) {
    const k = r.key || {};
    if (!privado(k.remoteJid) || vistos.has(k.id || r.id)) continue;
    vistos.add(k.id || r.id);
    const texto = textoDe(r);
    if (!texto) continue;
    if (!porChat.has(k.remoteJid)) porChat.set(k.remoteJid, []);
    porChat.get(k.remoteJid).push({ ts: tsDe(r), eu: k.fromMe === true, texto, nome: k.fromMe ? '' : r.pushName });
  }
  const saida = [];
  for (const msgs of porChat.values()) {
    msgs.sort((a, b) => a.ts - b.ts);
    const nomes = [...new Set(msgs.flatMap((m) => nomesDe(m.nome)))];
    let atual = null;
    const fecha = () => {
      if (!atual) return;
      const temPergunta = atual.falas.some((f) => !f.eu);
      const respondeu = atual.falas.some((f, i) => f.eu && atual.falas.slice(0, i).some((g) => !g.eu));
      if (temPergunta && respondeu) saida.push(atual);
      atual = null;
    };
    for (const m of msgs) {
      if (!atual || m.ts - atual.fim > NOVO_ATENDIMENTO_S) { fecha(); atual = { inicio: m.ts, fim: m.ts, falas: [] }; }
      atual.fim = m.ts;
      const limpo = limpar(m.texto, nomes);
      const ult = atual.falas[atual.falas.length - 1];
      if (ult && ult.eu === m.eu) ult.texto = `${ult.texto} / ${limpo}`.slice(0, TURNO_MAX);
      else atual.falas.push({ eu: m.eu, texto: limpo.slice(0, TURNO_MAX) });
    }
    fecha();
  }
  return saida;
}
const comoTexto = (a, n) => `Conversa ${n}:\n${a.falas.map((f) => `${f.eu ? 'S' : 'M'}: ${f.texto}`).join('\n')}`.slice(0, ATENDIMENTO_MAX);

// ── Recente primeiro (em ordem), depois o histórico (do mais novo pro mais velho) ──
const recentes = atendimentos(await lerJanela(recenteDe, agora)).sort((a, b) => a.inicio - b.inicio);
const historico = querHistorico
  ? atendimentos(await lerJanela(histDe, histAte - 1)).sort((a, b) => b.inicio - a.inicio)
  : [];

const lotes = [];
let lote = null;
let n = 0;
const cabe = (txt) => lote && lote.texto.length + txt.length + 2 <= LOTE_CHARS;
function poe(a, origem) {
  const txt = comoTexto(a, n + 1);
  if (!cabe(txt)) {
    if (lotes.length >= MAX_LOTES) return false;
    lote = { texto: '', conversas: 0, origem };
    lotes.push(lote);
  }
  n += 1;
  lote.texto += (lote.texto ? '\n\n' : '') + comoTexto(a, n);
  lote.conversas += 1;
  return true;
}
// Estourou a cota: para a noite ali. O que ficou é lido na próxima (o marcador para antes).
let novoUltimoTs = agora;
let cheio = false;
for (const a of recentes) { if (!poe(a, 'recente')) { novoUltimoTs = a.inicio - 1; cheio = true; break; } }
let novoHistoricoAte = querHistorico ? histDe : histAte;
if (cheio) novoHistoricoAte = histAte;
else for (const a of historico) { if (!poe(a, 'historico')) { novoHistoricoAte = a.fim + 1; break; } }

const meta = {
  estado: {
    ultimoTs: Math.max(novoUltimoTs, recenteDe),
    historicoAte: Math.min(novoHistoricoAte, histAte),
    historicoCompleto: estado.historicoCompleto === true || Math.min(novoHistoricoAte, histAte) <= alvoHistorico,
  },
  resumo: {
    atendimentosRecentes: recentes.length,
    atendimentosHistorico: historico.length,
    conversas: n,
    lotes: lotes.length,
    paginasLidas: paginas.size,
  },
  seco,
};
if (seco) return [{ json: { seco: true, meta } }];
if (!lotes.length) return [{ json: { vazio: true, meta } }];
return lotes.map((l, i) => ({ json: { lote: i + 1, texto: l.texto, conversas: l.conversas, origem: l.origem, meta } }));
"""

JS_JUNTA = r"""// Junta as regras de todos os lotes numa lista de candidatas, pra Groq juntar as parecidas.
const lotes = $('Monta lotes').all().map((i) => i.json);
const respostas = $input.all();
const candidatas = [];
let falhas = 0;
respostas.forEach((it, i) => {
  const conteudo = it.json && it.json.choices && it.json.choices[0] && it.json.choices[0].message && it.json.choices[0].message.content;
  let j = null;
  try { j = JSON.parse(conteudo); } catch (e) { j = null; }
  if (!j || typeof j !== 'object') { falhas += 1; return; }
  const noLote = (lotes[i] && lotes[i].conversas) || 0;
  for (const r of Array.isArray(j.regras) ? j.regras : []) {
    const texto = String((r && r.texto) || '').replace(/\s+/g, ' ').trim();
    if (texto.length < 10) continue;
    const ids = new Set((Array.isArray(r.conversas) ? r.conversas : []).map(Number).filter(Number.isFinite));
    candidatas.push({ texto: texto.slice(0, 400), tema: String(r.tema || '').slice(0, 40), conversas: Math.max(1, Math.min(ids.size, noLote || ids.size)) });
  }
  for (const t of Array.isArray(j.jeito) ? j.jeito.slice(0, 3) : []) {
    const texto = String(t || '').replace(/\s+/g, ' ').trim();
    // O jeito de falar vale pro lote inteiro: conta as conversas dele.
    if (texto.length >= 10) candidatas.push({ texto: texto.slice(0, 400), tema: 'jeito de falar', conversas: Math.max(1, noLote) });
  }
});
candidatas.sort((a, b) => b.conversas - a.conversas);
const top = candidatas.slice(0, 200);
const conhecidos = (($('Existentes').first().json || {}).conhecidos || []).slice(0, 100).map((t) => String(t).slice(0, 160));
const pedido = [
  'JÁ SABE:',
  conhecidos.length ? conhecidos.map((t) => `- ${t}`).join('\n') : '(nada ainda)',
  '',
  'CANDIDATAS:',
  top.map((c, i) => `${i}. [${c.tema || 'sem tema'}] ${c.texto} (${c.conversas} conversas)`).join('\n'),
].join('\n');
return [{ json: { candidatas: top, falhas, lotes: respostas.length, pedido } }];
"""

JS_PREPARA = r"""// O que vai pro backend: só regra que apareceu em conversas o bastante, sem marcador sobrando.
const num = (k, d) => { const v = Number($env[k]); return Number.isFinite(v) && v > 0 ? v : d; };
const MIN = num('NINA_APRENDE_MIN_CONVERSAS', 3);
const junta = $('Junta o que achou').first().json;
const resposta = $input.first().json || {};
const conteudo = resposta.choices && resposta.choices[0] && resposta.choices[0].message && resposta.choices[0].message.content;
let j = null;
try { j = JSON.parse(conteudo); } catch (e) { j = null; }
const consolidou = !!(j && Array.isArray(j.regras));
const MARCADOR = /\[(?:nome|telefone|valor|placa|endere[cç]o|cpf|cnpj|email|link|n[uú]mero)\]/i;
const porTexto = new Map();
for (const r of consolidou ? j.regras : []) {
  const texto = String((r && r.texto) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (texto.length < 10 || MARCADOR.test(texto)) continue;
  const de = [...new Set((Array.isArray(r.de) ? r.de : []).map(Number))]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < junta.candidatas.length);
  const conversas = de.reduce((s, i) => s + junta.candidatas[i].conversas, 0);
  if (conversas < MIN) continue;
  const tema = String(r.tema || (de.length ? junta.candidatas[de[0]].tema : '') || '').slice(0, 40);
  const ja = porTexto.get(texto);
  if (!ja || ja.conversas < conversas) porTexto.set(texto, { texto, tema, conversas });
}
// Rede de segurança (14/10/2026: a Groq juntou 143 candidatas numa regra só de "jeito de falar"
// e descartou o resto): candidata com conversas o bastante que a junção NÃO citou vai mesmo
// assim, uma por tema (a mais vista) — fora "jeito de falar", que a junção já resume.
const citadas = new Set();
for (const r of consolidou ? j.regras : []) for (const i of Array.isArray(r.de) ? r.de : []) citadas.add(Number(i));
const temaChave = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0].replace(/s$/, '');
const porTema = new Map();
if (consolidou) {
  junta.candidatas.forEach((c, i) => {
    const texto = String((c && c.texto) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const tema = String((c && c.tema) || '').slice(0, 40);
    if (citadas.has(i) || (c.conversas || 0) < MIN || texto.length < 10 || MARCADOR.test(texto)) return;
    if (/jeito de falar/i.test(tema) || porTexto.has(texto)) return;
    const k = temaChave(tema) || texto.slice(0, 30);
    const ja = porTema.get(k);
    if (!ja || ja.conversas < c.conversas) porTema.set(k, { texto, tema, conversas: c.conversas, semJuncao: true });
  });
}
const sugestoes = [...porTexto.values(), ...porTema.values()].sort((a, b) => b.conversas - a.conversas).slice(0, 30);
// Avança o marcador só se a noite rendeu: junção ok e no máximo metade dos lotes com erro.
const avancar = consolidou && junta.falhas <= junta.lotes / 2;
return [{ json: { sugestoes, avancar, falhas: junta.falhas, candidatas: junta.candidatas.length } }];
"""

JS_ESTADO = r"""// Fecha a rodada: até onde leu (se a noite rendeu) e o resumo pra quem abrir o banco.
const monta = $('Monta lotes').first().json;
const meta = monta.meta || {};
if (meta.seco) return [];
const executou = (nome) => { try { return !!$(nome).isExecuted; } catch (e) { return false; } };
const prep = executou('Prepara envio') ? $('Prepara envio').first().json : null;
const junta = executou('Junta o que achou') ? $('Junta o que achou').first().json : null;
const envio = executou('Manda sugestões') ? ($('Manda sugestões').first().json || {}) : {};
let avancar;
if (monta.vazio) avancar = true;                                    // nada pra ler: anda
else if (prep) avancar = prep.avancar;
else avancar = !!junta && junta.falhas <= junta.lotes / 2;           // leu, mas nada virou candidata
const corpo = avancar ? { ...meta.estado } : {};
corpo.ultimaRodada = {
  ...(meta.resumo || {}),
  candidatas: junta ? junta.candidatas.length : 0,
  falhas: junta ? junta.falhas : 0,
  sugeridas: prep ? prep.sugestoes.length : 0,
  criadas: Number(envio.criadas) || 0,
  somadas: Number(envio.somadas) || 0,
  avancou: avancar ? 1 : 0,
};
return [{ json: corpo }];
"""


# "Rodar agora" (13/10/2026): o `n8n execute` pela linha de comando trava com o n8n no ar, então
# a rodada manual entra por um webhook — o MESMO segredo da entrada de teste da Nina
# (NINA_TESTE_SEGREDO, só no .env do Kali). Sem a variável ou com header errado: não roda nada.
SEGREDO_CONFERE = (
    "={{ (() => { const s = String($env.NINA_TESTE_SEGREDO || ''); "
    "const h = String(($json.headers || {})['x-nina-segredo'] || ''); "
    "return s.length >= 16 && h === s; })() }}"
)


def http_backend(nome, metodo, rota, pos, corpo=None, nid=''):
    p = {
        "method": metodo,
        "url": BACKEND + rota,
        "sendHeaders": True,
        "headerParameters": CHAVE,
        "options": {"timeout": 30000},
    }
    if corpo:
        p.update({"sendBody": True, "specifyBody": "json", "jsonBody": corpo})
    return {
        "parameters": p,
        "name": nome,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": pos,
        "id": nid,
    }


def http_groq(nome, prompt, entrada, pos, nid, raciocinio='low'):
    # `reasoning_effort` só existe nos gpt-oss: mandado pro Llama, a Groq devolve 400.
    modelo = "($env.NINA_APRENDE_MODELO || '" + MODELO_PADRAO + "')"
    corpo = (
        "={{ JSON.stringify(Object.assign({ model: " + modelo + ", temperature: 0.2, "
        "max_completion_tokens: " + str(GROQ_MAX_RESPOSTA) + ", "
        "response_format: { type: 'json_object' }, messages: [ { role: 'system', content: "
        + json.dumps(prompt, ensure_ascii=False)
        + " }, { role: 'user', content: " + entrada + " } ] }, "
        + modelo + ".startsWith('openai/gpt-oss') ? { reasoning_effort: $env.NINA_APRENDE_RACIOCINIO || '" + raciocinio + "' } : {})) }}"
    )
    return {
        "parameters": {
            "method": "POST",
            "url": GROQ_URL,
            "authentication": "predefinedCredentialType",
            "nodeCredentialType": "groqApi",
            "sendBody": True,
            "specifyBody": "json",
            "jsonBody": corpo,
            # SEM "batching" do nó HTTP: em 14/10/2026 (n8n 2.39) o nó com batching de 1 a cada
            # 65 s começou e NUNCA terminou (duas rodadas, 80 e 50 min, sem conexão aberta, CPU
            # zero). O ritmo de 1 lote por minuto é o laço "Um lote por vez" + "Espera a cota".
            "options": {"timeout": GROQ_TIMEOUT_MS},
        },
        "name": nome,
        "type": "n8n-nodes-base.httpRequest",
        "typeVersion": 4.2,
        "position": pos,
        "credentials": GROQ_CRED,
        "retryOnFail": True,
        "maxTries": 3,
        "waitBetweenTries": 5000,
        # Um lote que falha não derruba a noite: segue sem ele (Junta conta as falhas).
        "onError": "continueRegularOutput",
        "id": nid,
    }


def codigo(nome, js, pos, nid, nota=''):
    n = {
        "parameters": {"jsCode": js},
        "name": nome,
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": pos,
        "id": nid,
    }
    if nota:
        n.update({"notesInFlow": True, "notes": nota})
    return n


def se(nome, expr, pos, nid):
    return {
        "parameters": {
            "conditions": {
                "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "loose", "version": 2},
                "conditions": [{
                    "id": nid + "-c",
                    "leftValue": expr,
                    "rightValue": "",
                    "operator": {"type": "boolean", "operation": "true", "singleValue": True},
                }],
                "combinator": "and",
            },
            "looseTypeValidation": True,
            "options": {},
        },
        "name": nome,
        "type": "n8n-nodes-base.if",
        "typeVersion": 2.2,
        "position": pos,
        "id": nid,
    }


def montar():
    base = "7a1e0c3b-5d2f-4e8a-9b10-0000000000"
    nodes = [
        {
            "parameters": {"rule": {"interval": [{"field": "cronExpression", "expression": "30 3 * * *"}]}},
            "name": "Toda madrugada",
            "type": "n8n-nodes-base.scheduleTrigger",
            "typeVersion": 1.2,
            "position": [0, 0],
            "notesInFlow": True,
            "notes": "03:30 (horário do Kali, America/Sao_Paulo)",
            "id": base + "01",
        },
        {
            "parameters": {},
            "name": "Testar leitura (sem IA)",
            "type": "n8n-nodes-base.manualTrigger",
            "typeVersion": 1,
            "position": [0, 200],
            "notesInFlow": True,
            "notes": "só conta: não chama a Groq nem grava nada",
            "id": base + "02",
        },
        http_backend("Estado", "GET", "estado", [220, 100], nid=base + "03"),
        http_backend("Existentes", "GET", "existentes", [440, 100], nid=base + "04"),
        codigo("Monta lotes", JS_MONTA, [660, 100], base + "05", "lê a Evolution, limpa dado pessoal, monta lotes"),
        se("Tem lote?", "={{ !!$json.texto }}", [880, 100], base + "06"),
        # Um lote por vez: Loop Over Items (saída 0 = acabou, saída 1 = o lote da vez). Cada
        # volta passa pela Groq e espera o minuto virar; no fim, "acabou" entrega todas as
        # respostas juntas pro "Junta o que achou", na ordem dos lotes.
        {
            "parameters": {"batchSize": 1, "options": {}},
            "name": "Um lote por vez",
            "type": "n8n-nodes-base.splitInBatches",
            "typeVersion": 3,
            "position": [1100, 100],
            "notesInFlow": True,
            "notes": "1 lote por minuto: Groq → espera → volta",
            "id": base + "18",
        },
        http_groq("Groq lê o lote", PROMPT_LOTE, "$json.texto", [1320, 260], base + "07"),
        {
            "parameters": {"resume": "timeInterval", "amount": GROQ_INTERVALO_S, "unit": "seconds"},
            "name": "Espera a cota",
            "type": "n8n-nodes-base.wait",
            "typeVersion": 1.1,
            "position": [1540, 260],
            "notesInFlow": True,
            "notes": "deixa o minuto da Groq virar antes do próximo lote",
            "webhookId": "7a1e0c3b-5d2f-4e8a-9b10-0000000000w3",
            "id": base + "19",
        },
        codigo("Junta o que achou", JS_JUNTA, [1320, 0], base + "08"),
        se("Tem candidata?", "={{ $json.candidatas.length > 0 }}", [1540, 0], base + "09"),
        {
            "parameters": {"resume": "timeInterval", "amount": PAUSA_ANTES_DA_JUNCAO_S, "unit": "seconds"},
            "name": "Respira a cota",
            "type": "n8n-nodes-base.wait",
            "typeVersion": 1.1,
            "position": [1650, -100],
            "notesInFlow": True,
            "notes": "a Groq conta tokens por minuto: deixa o minuto virar antes da junção",
            "webhookId": "7a1e0c3b-5d2f-4e8a-9b10-0000000000w1",
            "id": base + "15",
        },
        # A junção é UMA chamada por noite e decide o que chega ao gerente: pensa mais (medium).
        http_groq("Groq junta parecidas", PROMPT_JUNTA, "$json.pedido", [1760, -100], base + "10", raciocinio='medium'),
        {
            "parameters": {"httpMethod": "POST", "path": "nina-aprende-rodar", "responseMode": "onReceived", "options": {}},
            "name": "Rodar agora",
            "type": "n8n-nodes-base.webhook",
            "typeVersion": 2,
            "position": [0, 400],
            "notesInFlow": True,
            "notes": "POST com x-nina-segredo = NINA_TESTE_SEGREDO: roda uma vez, de verdade (com a Groq)",
            "webhookId": "7a1e0c3b-5d2f-4e8a-9b10-0000000000w2",
            "id": base + "16",
        },
        se("Segredo confere?", SEGREDO_CONFERE, [220, 400], base + "17"),
        codigo("Prepara envio", JS_PREPARA, [1980, -100], base + "11", "mín. de conversas, sem marcador, até 30"),
        http_backend("Manda sugestões", "POST", "sugestoes", [2200, -100],
                     corpo="={{ JSON.stringify({ sugestoes: $json.sugestoes }) }}", nid=base + "12"),
        codigo("Fecha a rodada", JS_ESTADO, [2420, 100], base + "13", "avança o marcador só se a noite rendeu"),
        http_backend("Salva até onde leu", "POST", "estado", [2640, 100],
                     corpo="={{ JSON.stringify($json) }}", nid=base + "14"),
    ]

    def c(*destinos):
        return {"main": [[{"node": d, "type": "main", "index": 0} for d in saida] for saida in destinos]}

    conn = {
        "Toda madrugada": c(["Estado"]),
        "Testar leitura (sem IA)": c(["Estado"]),
        "Rodar agora": c(["Segredo confere?"]),
        "Segredo confere?": c(["Estado"], []),
        "Estado": c(["Existentes"]),
        "Existentes": c(["Monta lotes"]),
        "Monta lotes": c(["Tem lote?"]),
        "Tem lote?": c(["Um lote por vez"], ["Fecha a rodada"]),
        "Um lote por vez": c(["Junta o que achou"], ["Groq lê o lote"]),
        "Groq lê o lote": c(["Espera a cota"]),
        "Espera a cota": c(["Um lote por vez"]),
        "Junta o que achou": c(["Tem candidata?"]),
        "Tem candidata?": c(["Respira a cota"], ["Fecha a rodada"]),
        "Respira a cota": c(["Groq junta parecidas"]),
        "Groq junta parecidas": c(["Prepara envio"]),
        "Prepara envio": c(["Manda sugestões"]),
        "Manda sugestões": c(["Fecha a rodada"]),
        "Fecha a rodada": c(["Salva até onde leu"]),
    }
    return {
        "id": ID,
        "name": "Nina aprende com o suporte",
        "nodes": nodes,
        "connections": conn,
        # "all": com "none" o n8n 2.39 deixava rodada "em andamento" pra sempre (goby_avisos_robo).
        "settings": {"executionOrder": "v1", "saveDataSuccessExecution": "all", "timezone": "America/Sao_Paulo"},
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
    # Repositório público: nenhum número de telefone nem chave no fluxo.
    import re
    assert not re.search(r"\b55\d{10,11}\b", texto), "telefone no fluxo"
    assert "apikey: $env.EVOLUTION_API_KEY" in texto and "sk-" not in texto and "gsk_" not in texto
    for n in f["nodes"]:
        if n["name"].startswith("Groq"):
            assert n["credentials"] == GROQ_CRED and n["parameters"]["nodeCredentialType"] == "groqApi"
            assert "batching" not in n["parameters"]["options"], "batching do nó HTTP trava (14/10/2026)"
        if n["type"] == "n8n-nodes-base.httpRequest" and not n["name"].startswith("Groq"):
            assert n["parameters"]["headerParameters"] == CHAVE, n["name"]
            assert "/api/suporte/goby/aprender/" in n["parameters"]["url"], n["name"]
    # O ritmo da Groq é o laço: Loop → Groq → Espera → Loop; "acabou" vai pra junção.
    assert f["connections"]["Um lote por vez"]["main"][0][0]["node"] == "Junta o que achou"
    assert f["connections"]["Um lote por vez"]["main"][1][0]["node"] == "Groq lê o lote"
    assert f["connections"]["Groq lê o lote"]["main"][0][0]["node"] == "Espera a cota"
    assert f["connections"]["Espera a cota"]["main"][0][0]["node"] == "Um lote por vez"
    espera = [n for n in f["nodes"] if n["name"] == "Espera a cota"][0]["parameters"]
    assert 60 <= espera["amount"] < 65 and espera["unit"] == "seconds"
    # Só o que a Nina pode ensinar: o prompt de cada lote proíbe dado pessoal e valor.
    assert [n for n in f["nodes"] if n["name"] == "Segredo confere?"][0]["parameters"]["conditions"]["conditions"][0]["leftValue"] == SEGREDO_CONFERE
    assert f["connections"]["Segredo confere?"]["main"][1] == [], "segredo errado não pode seguir"
    for p in (PROMPT_LOTE, PROMPT_JUNTA):
        assert "valor em dinheiro" in p and "telefone" in p and "JSON" in p
        # Vai dentro de uma expressão {{ }} do n8n: chaves duplas fechariam a expressão.
        assert "{{" not in p and "}}" not in p


if __name__ == '__main__':
    f = montar()
    conferir(f)
    ARQ.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ok: {ARQ.name} ({len(f['nodes'])} nós, id {ID})")
