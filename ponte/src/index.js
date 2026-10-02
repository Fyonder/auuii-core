/**
 * ============================================================
 *  PONTE — WhatsApp do PC de casa ⇄ Auuii-Backend (Render)
 * ============================================================
 *
 * O PC não tem porta aberta pra internet, e não deve ter: a Evolution API tem uma chave
 * global que apaga a instância do WhatsApp. Então é o PC quem liga pra fora:
 *
 *   Evolution ──webhook global──▶ ponte ──socket.io de saída──▶ backend (/ponte)
 *   Evolution ◀──sendText──────── ponte ◀──'enviar'─────────── backend (painel)
 *
 * O caminho da IA (Evolution → n8n) não passa por aqui: se a ponte cair, a Duda
 * continua atendendo; só o painel deixa de ver ao vivo — e a fila em disco entrega o
 * atraso quando a ponte volta.
 *
 * A ponte só transporta. Quem é quem, o que grava, pausa da IA: tudo no backend.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');
const { Classificador } = require('./normalizar');
const { version: VERSAO } = require('../package.json');

const cfg = {
    porta: Number(process.env.PORT || 3100),
    segredo: process.env.PONTE_WEBHOOK_SECRET || '',
    backend: (process.env.BACKEND_URL || '').replace(/\/+$/, ''),
    chave: process.env.PONTE_API_KEY || '',
    evolutionUrl: (process.env.EVOLUTION_API_URL || 'http://evolution:8080').replace(/\/+$/, ''),
    evolutionKey: process.env.EVOLUTION_API_KEY || '',
    instancia: process.env.EVOLUTION_INSTANCE || 'auuii',
    suporte: process.env.SUPORTE_WHATSAPP || '',
    pastaDados: process.env.PONTE_DADOS || '/data',
};

function log(...partes) {
    console.log(new Date().toISOString(), ...partes);
}

const faltando = [
    ['BACKEND_URL', cfg.backend], ['PONTE_API_KEY', cfg.chave], ['PONTE_WEBHOOK_SECRET', cfg.segredo], ['EVOLUTION_API_KEY', cfg.evolutionKey],
].filter(([, v]) => !v).map(([k]) => k);
if (faltando.length) {
    log(`❌ faltam variáveis de ambiente: ${faltando.join(', ')} — a ponte não sobe sem elas.`);
    process.exit(1);
}
if (cfg.segredo.length < 16) {
    log('❌ PONTE_WEBHOOK_SECRET curto demais (mínimo 16 caracteres).');
    process.exit(1);
}

const classificador = new Classificador({ suporteWhatsapp: cfg.suporte });
const desde = Date.now();
// Espera antes de tentar de novo quando o backend RECUSA a conexão (configurável pra teste).
const ESPERA_RECUSA_MS = Number(process.env.PONTE_ESPERA_RECUSA_MS || 60000);
let ultimaMensagemEm = null;

// ─── Fila em disco ─────────────────────────────────────────────────────────────────
//
// Tudo que vai pro backend passa por aqui e só sai depois do ack. Em disco porque o
// motivo mais comum de a ponte perder a conexão é justamente reiniciar (queda de luz,
// docker compose up) — uma fila só em memória perderia exatamente essas mensagens.

const MAX_FILA = 1000;
const ARQUIVO_FILA = path.join(cfg.pastaDados, 'fila.json');
let fila = carregarFila();
let gravacaoPendente = null;

function carregarFila() {
    try {
        fs.mkdirSync(cfg.pastaDados, { recursive: true });
        const lida = JSON.parse(fs.readFileSync(ARQUIVO_FILA, 'utf8'));
        if (Array.isArray(lida)) {
            if (lida.length) log(`📦 fila recuperada do disco: ${lida.length} item(ns)`);
            return lida;
        }
    } catch (err) {
        if (err.code !== 'ENOENT') log(`⚠️ fila em disco ilegível (${err.message}) — começando vazia`);
    }
    return [];
}

function gravarFilaAgora() {
    try {
        const tmp = `${ARQUIVO_FILA}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(fila));
        fs.renameSync(tmp, ARQUIVO_FILA);
    } catch (err) {
        log(`⚠️ não deu pra gravar a fila: ${err.message}`);
    }
}

function persistir() {
    if (gravacaoPendente) return;
    gravacaoPendente = setTimeout(() => { gravacaoPendente = null; gravarFilaAgora(); }, 300);
}

function enfileirar(tipo, dados) {
    fila.push({ tipo, dados, tentativas: 0 });
    if (fila.length > MAX_FILA) {
        const fora = fila.splice(0, fila.length - MAX_FILA);
        log(`⚠️ fila cheia: ${fora.length} item(ns) mais antigos descartados — o backend está fora faz tempo?`);
    }
    persistir();
    drenar();
}

// ─── Conexão com o backend ─────────────────────────────────────────────────────────

const socket = io(`${cfg.backend}/ponte`, {
    path: '/tracking',
    transports: ['websocket'],
    auth: { chave: cfg.chave, versao: VERSAO },
    reconnectionDelay: 2000,
    reconnectionDelayMax: 30000,
});

socket.on('connect', () => {
    log(`🔌 conectada ao backend (${cfg.backend})`);
    enviarEstado();
    drenar();
});
// O socket.io-client só reconecta sozinho quando a conexão CAIU. Quando o servidor
// RECUSA (chave errada, ou a chave ainda não foi posta no Render) ou derruba a conexão de
// propósito, ele desiste e fica parado pra sempre — e a ponte parecia de pé, só que surda.
// Aqui ela volta a tentar sozinha, devagar: recusa não se resolve em segundos.
let tentativaManual = null;
function tentarDeNovo(ms, motivo) {
    if (tentativaManual || socket.connected) return;
    log(`🔌 nova tentativa em ${Math.round(ms / 1000)} s (${motivo})`);
    tentativaManual = setTimeout(() => { tentativaManual = null; socket.connect(); }, ms);
}

socket.on('disconnect', (motivo) => {
    log(`🔌 desconectada: ${motivo}`);
    if (motivo === 'io server disconnect') tentarDeNovo(Math.min(30000, ESPERA_RECUSA_MS), 'o backend encerrou a conexão');
});
socket.on('connect_error', (err) => {
    if (err?.data?.code === 'PONTE_CHAVE_INVALIDA') {
        log('❌ o backend recusou a chave: PONTE_API_KEY daqui é diferente da do Render.');
    } else {
        log(`🔌 sem conexão com o backend: ${err.message}`);
    }
    if (!socket.active) tentarDeNovo(ESPERA_RECUSA_MS, 'conexão recusada');
});
socket.on('enviar', (pedido) => { atenderEnvio(pedido); });

function dormir(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

let drenando = false;
async function drenar() {
    if (drenando || !socket.connected || fila.length === 0) return;
    drenando = true;
    try {
        while (fila.length && socket.connected) {
            const item = fila[0];
            let resposta;
            try {
                resposta = await socket.timeout(15000).emitWithAck(item.tipo, item.dados);
            } catch (_) {
                break; // sem ack a tempo: tenta de novo na próxima volta
            }
            if (resposta?.ok) {
                fila.shift();
                persistir();
                continue;
            }
            // O backend recebeu e recusou. Tentar pra sempre travaria a fila inteira
            // atrás de uma mensagem com defeito; 5 tentativas e ela sai com log.
            item.tentativas = (item.tentativas || 0) + 1;
            if (item.tentativas >= 5) {
                log(`❌ desistindo de ${item.tipo} ${item.dados?.id || item.dados?.reqId || ''}: ${resposta?.erro || 'recusado'}`);
                fila.shift();
                persistir();
                continue;
            }
            log(`⚠️ backend recusou ${item.tipo} (tentativa ${item.tentativas}): ${resposta?.erro || '?'}`);
            await dormir(3000);
        }
    } finally {
        drenando = false;
        if (fila.length && socket.connected) setTimeout(drenar, 3000);
    }
}

function enviarEstado() {
    if (!socket.connected) return;
    socket.emit('estado', { versao: VERSAO, fila: fila.length, desde, ultimaMensagemEm });
}
setInterval(enviarEstado, 30000).unref();

// ─── Envio pedido pelo painel ──────────────────────────────────────────────────────

// O `enviar` vem por broadcast (várias instâncias no Render); um mesmo pedido chegando
// duas vezes não pode virar duas mensagens no WhatsApp do motoboy.
const pedidosVistos = new Map();
function jaAtendido(reqId) {
    const agora = Date.now();
    for (const [id, em] of pedidosVistos) if (agora - em > 10 * 60000) pedidosVistos.delete(id);
    if (pedidosVistos.has(reqId)) return true;
    pedidosVistos.set(reqId, agora);
    return false;
}

function motivoDaEvolution(corpo, status) {
    const r = corpo?.response?.message;
    if (Array.isArray(r) && r.some((x) => x && x.exists === false)) return 'Este número não tem WhatsApp.';
    if (Array.isArray(r) && r.length) return String(r[0]?.message || r[0]).slice(0, 200);
    if (typeof r === 'string') return r.slice(0, 200);
    return `A Evolution respondeu ${status}.`;
}

async function atenderEnvio(pedido) {
    const { reqId, conversaId, numero, texto } = pedido || {};
    if (!reqId || !numero || !texto || jaAtendido(reqId)) return;
    // Cada conversa responde pelo número dela (auuii, goby...). Sem instância, a padrão.
    const instancia = /^[A-Za-z0-9_-]{1,40}$/.test(pedido.instancia || '') ? pedido.instancia : cfg.instancia;

    // ANTES do sendText: o SEND_MESSAGE da Evolution chega enquanto a chamada ainda
    // não voltou, e é por este pendente que ele é reconhecido como do operador.
    classificador.registrarPendente({ reqId, conversaId, numero, texto, instancia });
    try {
        const resp = await fetch(`${cfg.evolutionUrl}/message/sendText/${encodeURIComponent(instancia)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', apikey: cfg.evolutionKey },
            body: JSON.stringify({ number: String(numero).split('@')[0].replace(/\D/g, ''), text: texto }),
            signal: AbortSignal.timeout(20000),
        });
        const corpo = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(motivoDaEvolution(corpo, resp.status));
        const id = corpo?.key?.id || null;
        classificador.marcarIdDeEnvio(id);
        enfileirar('enviado', { reqId, conversaId, id, jid: corpo?.key?.remoteJid || null });
        log(`📤 enviado ${reqId} → ${id}`);
    } catch (err) {
        classificador.esquecerPendente(reqId);
        enfileirar('enviado', { reqId, conversaId, erro: err.message });
        log(`❌ envio ${reqId} falhou: ${err.message}`);
    }
}

// ─── Webhook da Evolution ──────────────────────────────────────────────────────────

const LIMITE_CORPO = 25 * 1024 * 1024; // mídia vem em base64 no webhook

function lerCorpo(req) {
    return new Promise((resolve, reject) => {
        const partes = [];
        let tamanho = 0;
        req.on('data', (c) => {
            tamanho += c.length;
            if (tamanho > LIMITE_CORPO) { reject(new Error('corpo grande demais')); req.destroy(); return; }
            partes.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
        req.on('error', reject);
    });
}

const caminhoDoWebhook = `/evolution/${cfg.segredo}`;

const servidor = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/saude') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, versao: VERSAO, conectada: socket.connected, fila: fila.length, desde, ultimaMensagemEm }));
        return;
    }
    // Segredo no caminho porque o webhook global da Evolution não manda cabeçalho de
    // autenticação. Caminho errado responde 404 igual a qualquer rota inexistente.
    if (req.method !== 'POST' || !req.url.startsWith(caminhoDoWebhook)) {
        res.writeHead(404);
        res.end();
        return;
    }
    let bruto;
    try {
        bruto = await lerCorpo(req);
    } catch (err) {
        res.writeHead(413);
        res.end();
        return;
    }
    // Responde já: a Evolution espera essa resposta, e ela não deve ficar pendurada
    // no backend. O que importa daqui pra frente é a fila.
    res.writeHead(200);
    res.end();

    let body;
    try { body = JSON.parse(bruto); } catch (_) { return; }
    const eventos = Array.isArray(body?.data) ? body.data.map((data) => ({ ...body, data })) : [body];
    for (const e of eventos) {
        const ev = classificador.classificar(e);
        if (!ev) continue;
        ultimaMensagemEm = Date.now();
        enfileirar('evento', ev);
    }
});

servidor.listen(cfg.porta, () => log(`🌉 ponte ${VERSAO} ouvindo a Evolution na porta ${cfg.porta}`));

function encerrar(sinal) {
    log(`⏹️ ${sinal}: gravando a fila (${fila.length}) e saindo`);
    if (gravacaoPendente) clearTimeout(gravacaoPendente);
    gravarFilaAgora();
    socket.close();
    servidor.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
