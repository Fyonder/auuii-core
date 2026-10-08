/**
 * Transforma o webhook da Evolution API numa mensagem que o backend entende, e decide
 * QUEM escreveu. Funções puras + um classificador com memória curta; sem rede.
 *
 * Quem escreveu, pela ordem em que é decidido:
 *   - fromMe=false                        → contato (cliente, motoboy, loja)
 *   - SEND_MESSAGE que bate com um envio   → operador (foi o painel que pediu)
 *     pendente do painel (mesmo destino e
 *     mesmo texto)
 *   - SEND_MESSAGE pro SUPORTE_WHATSAPP    → sistema (o aviso interno de handoff)
 *     com "AVISO INTERNO"
 *   - demais SEND_MESSAGE                  → ia (o n8n responde pela API)
 *   - MESSAGES_UPSERT com fromMe           → aparelho (alguém digitou no celular do
 *                                            Auuii), a não ser que o id já tenha
 *                                            passado num SEND_MESSAGE: aí é eco.
 *
 * Por que o casamento do operador é por TEXTO e não pelo id: a Evolution dispara o
 * SEND_MESSAGE de dentro do sendText, ANTES de a resposta HTTP voltar com o id. Quando
 * o evento chega, a ponte ainda não sabe qual id é o dela. Destino + texto, numa janela
 * de 1 minuto, é o que se tem na mão naquele instante.
 */

const TIPOS = {
    conversation: 'texto',
    extendedTextMessage: 'texto',
    imageMessage: 'imagem',
    audioMessage: 'audio',
    pttMessage: 'audio',
    videoMessage: 'video',
    ptvMessage: 'video',
    documentMessage: 'documento',
    documentWithCaptionMessage: 'documento',
    stickerMessage: 'figurinha',
    locationMessage: 'localizacao',
    liveLocationMessage: 'localizacao',
    contactMessage: 'contato',
    contactsArrayMessage: 'contato',
    buttonsResponseMessage: 'texto',
    listResponseMessage: 'texto',
    templateButtonReplyMessage: 'texto',
};

// Não viram mensagem na conversa: reação, apagar/editar, chamada perdida, etc.
const IGNORADOS = new Set(['reactionMessage', 'protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'call', 'pollUpdateMessage']);

function digitos(v) {
    return v == null ? '' : String(v).replace(/\D/g, '');
}

/** Mesma chave do backend (whatsappInboxService.chaveCanonica): ignora o 9º dígito. */
function chaveCanonica(v) {
    let d = digitos(String(v || '').split('@')[0]);
    if (d.length === 10 || d.length === 11) d = `55${d}`;
    if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `55${d.slice(2, 4)}${d.slice(-8)}`;
    return d;
}

function nomeDoEvento(body) {
    return String(body?.event || '').toLowerCase().replace(/[_-]/g, '.');
}

/**
 * De quem é a conversa. O WhatsApp passou a endereçar parte das conversas por LID
 * (`...@lid`), um id que NÃO é o telefone; nesses casos o telefone vem em
 * remoteJidAlt/senderPn. Sem isso a conversa virava um número que não identifica
 * ninguém e o cliente caía no menu.
 */
function destinoDaMensagem(data) {
    const key = data?.key || {};
    const jid = String(key.remoteJid || '');
    if (!jid || /@(g\.us|newsletter|broadcast)$/.test(jid) || jid === 'status@broadcast') return null;
    if (jid.endsWith('@s.whatsapp.net')) return { jid, telefone: digitos(jid.split('@')[0]), lid: null };
    if (jid.endsWith('@lid')) {
        const alternativas = [key.remoteJidAlt, key.senderPn, data.senderPn, key.participantAlt];
        const pn = alternativas.find((a) => typeof a === 'string' && a.includes('@s.whatsapp.net'))
            || alternativas.find((a) => digitos(a).length >= 10);
        const telefone = pn ? digitos(String(pn).split('@')[0]) : null;
        return {
            jid: telefone ? `${telefone}@s.whatsapp.net` : jid,
            telefone: telefone || null,
            lid: digitos(jid.split('@')[0]),
        };
    }
    return null;
}

function tipoETexto(data) {
    const msg = data?.message || {};
    const chave = data?.messageType && msg[data.messageType] !== undefined
        ? data.messageType
        : Object.keys(msg).find((k) => !IGNORADOS.has(k) && k !== 'messageContextInfo');
    if (!chave || IGNORADOS.has(chave) || IGNORADOS.has(data?.messageType)) return null;
    const corpo = msg[chave] || {};
    const texto = typeof corpo === 'string'
        ? corpo
        : corpo.text || corpo.caption || corpo.selectedDisplayText || corpo.title
            || corpo.message?.documentMessage?.caption || '';
    return { tipo: TIPOS[chave] || 'outro', texto: String(texto || '').slice(0, 4096) };
}

function emMs(ts) {
    if (ts == null) return Date.now();
    const n = typeof ts === 'object' ? Number(ts.low ?? ts.toString?.()) : Number(ts);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    return n < 1e12 ? n * 1000 : n; // a Evolution manda em segundos
}

class Classificador {
    constructor({ suporteWhatsapp = '', janelaPendenteMs = 60000, janelaIdsMs = 10 * 60000, agora = () => Date.now() } = {}) {
        // SUPORTE_WHATSAPP pode ter vários números separados por vírgula ou ponto e vírgula
        // (dono, 05/10/2026). O aviso interno pra qualquer um deles é "sistema".
        this.suportes = new Set(String(suporteWhatsapp || '').split(/[,;\n]+/).map(chaveCanonica).filter((k) => k.length >= 10));
        this.janelaPendenteMs = janelaPendenteMs;
        this.janelaIdsMs = janelaIdsMs;
        this.agora = agora;
        this.pendentes = [];          // envios do painel esperando o SEND_MESSAGE
        this.idsDeEnvio = new Map();  // id → quando viu (pra reconhecer eco)
    }

    registrarPendente({ reqId, conversaId, numero, texto, instancia = null }) {
        this._limpar();
        this.pendentes.push({ reqId, conversaId, instancia, chave: chaveCanonica(numero), texto: String(texto || '').trim(), em: this.agora() });
    }

    esquecerPendente(reqId) {
        this.pendentes = this.pendentes.filter((p) => p.reqId !== reqId);
    }

    marcarIdDeEnvio(id) {
        if (id) this.idsDeEnvio.set(id, this.agora());
    }

    _limpar() {
        const t = this.agora();
        this.pendentes = this.pendentes.filter((p) => t - p.em < this.janelaPendenteMs);
        for (const [id, em] of this.idsDeEnvio) if (t - em > this.janelaIdsMs) this.idsDeEnvio.delete(id);
    }

    /**
     * Webhook da Evolution → evento pro backend, ou null quando não é mensagem de
     * conversa (grupo, reação, eco, evento de outro tipo).
     */
    classificar(body) {
        this._limpar();
        const evento = nomeDoEvento(body);
        if (evento !== 'messages.upsert' && evento !== 'send.message') return null;
        const data = Array.isArray(body.data) ? body.data[0] : body.data;
        if (!data?.key?.id) return null;

        const destino = destinoDaMensagem(data);
        if (!destino) return null;
        const conteudo = tipoETexto(data);
        if (!conteudo) return null;

        const base = {
            id: data.key.id,
            // Qual número (empresa) recebeu ou mandou: auuii, goby... O webhook global da
            // Evolution manda TODAS as instâncias pra cá; o backend separa as conversas por isto.
            instancia: body.instance || null,
            jid: destino.jid,
            telefone: destino.telefone,
            lid: destino.lid,
            texto: conteudo.texto,
            tipo: conteudo.tipo,
            em: emMs(data.messageTimestamp),
        };

        if (!data.key.fromMe) return { ...base, autor: 'contato', nome: data.pushName || null };

        if (evento === 'send.message') {
            this.marcarIdDeEnvio(data.key.id);
            const chave = chaveCanonica(destino.telefone || destino.jid);
            const texto = conteudo.texto.trim();
            // Mesma instância também: o painel pode estar mandando o mesmo "ok" pro mesmo
            // contato pelos dois números ao mesmo tempo.
            const i = this.pendentes.findIndex((p) => p.texto === texto && p.chave === chave
                && (!p.instancia || !base.instancia || p.instancia === base.instancia));
            if (i >= 0) {
                const [p] = this.pendentes.splice(i, 1);
                return { ...base, autor: 'operador', reqId: p.reqId, conversaId: p.conversaId };
            }
            if (this.suportes.has(chave) && /AVISO INTERNO/i.test(texto)) {
                return { ...base, autor: 'sistema' };
            }
            return { ...base, autor: 'ia' };
        }

        // messages.upsert com fromMe: digitado no celular — ou eco de um envio da API.
        if (this.idsDeEnvio.has(data.key.id)) return null;
        return { ...base, autor: 'aparelho' };
    }
}

module.exports = { Classificador, chaveCanonica, destinoDaMensagem, tipoETexto, emMs, nomeDoEvento };
