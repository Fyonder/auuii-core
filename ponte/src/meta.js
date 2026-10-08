/**
 * Número da API oficial do WhatsApp (Meta Cloud API) atendido pela Duda.
 *
 * A Duda (n8n) só conhece a Evolution: lê o webhook `messages.upsert` e responde por
 * `/message/sendText/<instancia>`. Em vez de ensinar a Meta pra cada nó do fluxo, a ponte
 * se faz de Evolution pra instância `meta`:
 *
 *   Meta ─▶ backend (Render) ─socket 'meta'─▶ ponte ─▶ n8n   (traduzido pra Evolution)
 *   n8n ─/message/sendText/meta─▶ ponte ─▶ graph.facebook.com
 *
 * Aqui ficam as funções puras (tradução) e o cliente da Graph API; quem liga isso no
 * servidor e no socket é o index.js.
 */

const TIPOS_MIDIA = {
    image: 'imageMessage',
    audio: 'audioMessage',
    video: 'videoMessage',
    document: 'documentMessage',
    sticker: 'stickerMessage',
    location: 'locationMessage',
    contacts: 'contactMessage',
};

function digitos(v) {
    return v == null ? '' : String(v).replace(/\D/g, '');
}

/** O conteúdo da mensagem da Meta no formato `message` da Evolution (Baileys). */
function mensagemEvolution(msg) {
    switch (msg.type) {
        case 'text':
            return { conversation: String(msg.text?.body || '') };
        case 'button':
            return { conversation: String(msg.button?.text || '') };
        case 'interactive': {
            const i = msg.interactive || {};
            const r = i.button_reply || i.list_reply || {};
            return { conversation: String(r.title || '') };
        }
        default: {
            const chave = TIPOS_MIDIA[msg.type];
            if (!chave) return null; // reaction, unsupported, system...
            const corpo = msg[msg.type] || {};
            return { [chave]: corpo.caption ? { caption: String(corpo.caption) } : {} };
        }
    }
}

/**
 * Webhook da Meta → lista de corpos no formato do webhook da Evolution (`messages.upsert`),
 * um por mensagem recebida. Status (enviada/entregue/lida) e o que não é mensagem ficam
 * de fora: a Duda não faz nada com eles.
 */
function metaParaEvolution(corpo, instancia) {
    const saida = [];
    for (const entry of corpo?.entry || []) {
        for (const change of entry?.changes || []) {
            if (change?.field !== 'messages') continue;
            const v = change.value || {};
            const nomes = new Map((v.contacts || []).map((c) => [digitos(c.wa_id), c.profile?.name || '']));
            for (const msg of v.messages || []) {
                const tel = digitos(msg?.from);
                if (!msg?.id || !tel) continue;
                const message = mensagemEvolution(msg);
                if (!message) continue;
                saida.push({
                    event: 'messages.upsert',
                    instance: instancia,
                    data: {
                        key: { remoteJid: `${tel}@s.whatsapp.net`, fromMe: false, id: msg.id },
                        pushName: nomes.get(tel) || '',
                        message,
                        messageTimestamp: Number(msg.timestamp) || Math.floor(Date.now() / 1000),
                    },
                });
            }
        }
    }
    return saida;
}

/** O que a Evolution mandaria no SEND_MESSAGE de um envio nosso (o painel vê a resposta). */
function eventoDeEnvio({ instancia, id, numero, texto }) {
    return {
        event: 'send.message',
        instance: instancia,
        data: {
            key: { remoteJid: `${digitos(numero)}@s.whatsapp.net`, fromMe: true, id },
            message: { conversation: String(texto || '') },
            messageTimestamp: Math.floor(Date.now() / 1000),
        },
    };
}

function erroDaGraph(corpo, status) {
    const e = corpo?.error || {};
    // 131030 = número fora da lista de destinatários do número de teste; 131047 = passou
    // de 24 h desde a última mensagem do contato (aí só template).
    if (e.code === 131030) return 'Número fora da lista de destinatários do número de teste da Meta.';
    if (e.code === 131047) return 'Passou de 24 h da última mensagem do contato: a Meta só aceita template.';
    const msg = e.error_data?.details || e.message;
    return msg ? `Meta: ${String(msg).slice(0, 200)}` : `A Meta respondeu ${status}.`;
}

class GraphMeta {
    constructor({ token, phoneNumberId, versao = 'v23.0', fetchImpl = fetch } = {}) {
        this.token = token;
        this.url = `https://graph.facebook.com/${versao}/${encodeURIComponent(phoneNumberId)}/messages`;
        this.fetch = fetchImpl;
    }

    async _post(corpo) {
        const resp = await this.fetch(this.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messaging_product: 'whatsapp', ...corpo }),
            signal: AbortSignal.timeout(20000),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(erroDaGraph(json, resp.status));
        return json;
    }

    /** Devolve o id (wamid) da mensagem enviada. */
    async enviarTexto(numero, texto) {
        const r = await this._post({ to: digitos(numero), type: 'text', text: { body: String(texto) } });
        return r?.messages?.[0]?.id || null;
    }

    /** Marca como lida e mostra "digitando…" (a Meta só faz os dois juntos, pelo id). */
    async marcarLida(id, digitando = true) {
        return this._post({ status: 'read', message_id: id, ...(digitando ? { typing_indicator: { type: 'text' } } : {}) });
    }
}

module.exports = { metaParaEvolution, mensagemEvolution, eventoDeEnvio, erroDaGraph, GraphMeta };
