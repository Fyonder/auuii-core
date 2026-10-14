const test = require('node:test');
const assert = require('node:assert');
const { metaParaEvolution, eventoDeEnvio, GraphMeta } = require('../src/meta');
const { Classificador } = require('../src/normalizar');

// Telefones fictícios (o repositório é público).
const TEL = '5544999990001';

function webhook(mensagens, contatos = [{ wa_id: TEL, profile: { name: 'Fulano Teste' } }]) {
    return {
        object: 'whatsapp_business_account',
        entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: contatos, messages: mensagens } }] }],
    };
}

test('texto vira messages.upsert da Evolution que o fluxo da Duda já lê', () => {
    const [ev] = metaParaEvolution(webhook([{ id: 'wamid.A', from: TEL, timestamp: '1760000000', type: 'text', text: { body: 'oi' } }]), 'goby');
    assert.deepStrictEqual(ev, {
        event: 'messages.upsert',
        instance: 'goby',
        data: {
            key: { remoteJid: `${TEL}@s.whatsapp.net`, fromMe: false, id: 'wamid.A' },
            pushName: 'Fulano Teste',
            message: { conversation: 'oi' },
            messageTimestamp: 1760000000,
        },
    });
});

test('mídia vira a chave da Evolution (a Duda pede pra escrever), legenda vai junto', () => {
    const evs = metaParaEvolution(webhook([
        { id: 'a', from: TEL, type: 'audio', audio: { id: 'm1' } },
        { id: 'b', from: TEL, type: 'image', image: { id: 'm2', caption: 'comprovante' } },
        { id: 'c', from: TEL, type: 'sticker', sticker: { id: 'm3' } },
    ]), 'goby');
    // O id da mídia na Meta vai junto (metaMidiaId): é por ele que a ponte baixa o arquivo
    // pro painel. O fluxo da Nina só olha a CHAVE (audioMessage…), então nada muda lá.
    assert.deepStrictEqual(evs.map((e) => e.data.message), [
        { audioMessage: { metaMidiaId: 'm1' } },
        { imageMessage: { caption: 'comprovante', metaMidiaId: 'm2' } },
        { stickerMessage: { metaMidiaId: 'm3' } },
    ]);
});

test('mídia da Meta leva os dados do arquivo: tipo, nome, se é áudio de voz', () => {
    const [aud, doc] = metaParaEvolution(webhook([
        { id: 'a', from: TEL, type: 'audio', audio: { id: 'm1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
        { id: 'd', from: TEL, type: 'document', document: { id: 'm4', mime_type: 'application/pdf', filename: 'nota.pdf', caption: 'segue' } },
    ]), 'goby');
    assert.deepStrictEqual(aud.data.message, { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, metaMidiaId: 'm1' } });
    assert.deepStrictEqual(doc.data.message, { documentMessage: { caption: 'segue', mimetype: 'application/pdf', fileName: 'nota.pdf', metaMidiaId: 'm4' } });
});

test('o classificador do painel leva os dados da mídia da Meta (com o id pra ponte baixar)', () => {
    const [ev] = metaParaEvolution(webhook([{ id: 'a', from: TEL, type: 'image', image: { id: 'm9', mime_type: 'image/jpeg' } }]), 'goby');
    const doPainel = new Classificador().classificar(ev);
    assert.strictEqual(doPainel.tipo, 'imagem');
    assert.deepStrictEqual(doPainel.midia, { mime: 'image/jpeg', tamanho: null, duracao: null, nome: null, ptt: false, metaId: 'm9' });
});

test('Graph: baixar mídia — pega o link pelo id e baixa com o token', async () => {
    const chamadas = [];
    const fetchImpl = async (url, opts) => {
        chamadas.push({ url, auth: opts.headers.Authorization });
        if (url.endsWith('/m9')) return { ok: true, status: 200, json: async () => ({ url: 'https://lookaside.fbsbx.com/arquivo', mime_type: 'image/jpeg' }) };
        return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('JPEG').buffer };
    };
    const g = new GraphMeta({ token: 'TK', phoneNumberId: '123', versao: 'v23.0', fetchImpl });
    const r = await g.baixarMidia('m9');
    assert.strictEqual(r.buffer.toString(), 'JPEG');
    assert.strictEqual(r.mime, 'image/jpeg');
    assert.deepStrictEqual(chamadas.map((c) => c.url), ['https://graph.facebook.com/v23.0/m9', 'https://lookaside.fbsbx.com/arquivo']);
    assert.ok(chamadas.every((c) => c.auth === 'Bearer TK'));
});

test('Graph: baixar mídia — id que a Meta não conhece vira erro legível', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Unsupported get request' } }) });
    const g = new GraphMeta({ token: 'TK', phoneNumberId: '123', fetchImpl });
    await assert.rejects(() => g.baixarMidia('nao-existe'), /Meta: Unsupported get request/);
});

test('botão e resposta de lista viram texto', () => {
    const evs = metaParaEvolution(webhook([
        { id: 'a', from: TEL, type: 'button', button: { text: 'Sim' } },
        { id: 'b', from: TEL, type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'x', title: 'Meu pedido' } } },
    ]), 'goby');
    assert.deepStrictEqual(evs.map((e) => e.data.message.conversation), ['Sim', 'Meu pedido']);
});

test('status, reação e outros campos ficam de fora', () => {
    const corpo = webhook([{ id: 'r', from: TEL, type: 'reaction', reaction: { emoji: '👍' } }]);
    corpo.entry[0].changes.push({ field: 'messages', value: { statuses: [{ id: 'wamid.A', status: 'read' }] } });
    corpo.entry[0].changes.push({ field: 'account_update', value: {} });
    assert.deepStrictEqual(metaParaEvolution(corpo, 'goby'), []);
    assert.deepStrictEqual(metaParaEvolution({}, 'goby'), []);
});

test('o classificador do painel entende o que a ponte gera: contato, IA e operador', () => {
    const c = new Classificador({});
    const [entrada] = metaParaEvolution(webhook([{ id: 'in1', from: TEL, type: 'text', text: { body: 'oi' } }]), 'goby');
    assert.strictEqual(c.classificar(entrada).autor, 'contato');
    assert.strictEqual(c.classificar(entrada).instancia, 'goby');

    const ia = c.classificar(eventoDeEnvio({ instancia: 'goby', id: 'out1', numero: TEL, texto: 'Olá! Sou a Duda.' }));
    assert.strictEqual(ia.autor, 'ia');

    c.registrarPendente({ reqId: 'r1', conversaId: 'c1', numero: TEL, texto: 'Já resolvo', instancia: 'goby' });
    const op = c.classificar(eventoDeEnvio({ instancia: 'goby', id: 'out2', numero: TEL, texto: 'Já resolvo' }));
    assert.strictEqual(op.autor, 'operador');
    assert.strictEqual(op.reqId, 'r1');
});

function fetchFalso(respostas) {
    const chamadas = [];
    const fn = async (url, opts) => {
        chamadas.push({ url, opts, corpo: JSON.parse(opts.body) });
        const [status, json] = respostas.shift();
        return { ok: status < 400, status, json: async () => json };
    };
    fn.chamadas = chamadas;
    return fn;
}

test('Graph: envia texto com o token no cabeçalho e devolve o wamid', async () => {
    const f = fetchFalso([[200, { messages: [{ id: 'wamid.OUT' }] }]]);
    const g = new GraphMeta({ token: 'tok', phoneNumberId: '123', fetchImpl: f });
    assert.strictEqual(await g.enviarTexto('+55 44 99999-0001', 'oi'), 'wamid.OUT');
    const [ch] = f.chamadas;
    assert.strictEqual(ch.url, 'https://graph.facebook.com/v23.0/123/messages');
    assert.strictEqual(ch.opts.headers.Authorization, 'Bearer tok');
    assert.deepStrictEqual(ch.corpo, { messaging_product: 'whatsapp', to: TEL, type: 'text', text: { body: 'oi' } });
});

test('Graph: marcar lida leva o "digitando"', async () => {
    const f = fetchFalso([[200, { success: true }]]);
    await new GraphMeta({ token: 't', phoneNumberId: '1', fetchImpl: f }).marcarLida('wamid.A');
    assert.deepStrictEqual(f.chamadas[0].corpo, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.A', typing_indicator: { type: 'text' } });
});

test('Graph: erros conhecidos viram frase que o painel mostra', async () => {
    const g = (r) => new GraphMeta({ token: 't', phoneNumberId: '1', fetchImpl: fetchFalso([r]) });
    await assert.rejects(g([400, { error: { code: 131030 } }]).enviarTexto(TEL, 'x'), /lista de destinatários/);
    await assert.rejects(g([400, { error: { code: 131047 } }]).enviarTexto(TEL, 'x'), /24 h/);
    await assert.rejects(g([401, { error: { code: 190, message: 'Token expirado' } }]).enviarTexto(TEL, 'x'), /Meta: Token expirado/);
});
