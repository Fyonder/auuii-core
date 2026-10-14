// O arquivo das mídias até o painel (midia.js): baixar da Evolution, subir pro backend, e
// o que acontece quando dá errado — a mensagem já foi pela fila; o arquivo é um extra.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LIMITE_BYTES, arquivoDoWebhook, baixarDaEvolution, subirProBackend, levarMidia } = require('../src/midia');

const ev = (extra = {}) => ({ id: 'MSG1', instancia: 'goby-suporte', tipo: 'audio', midia: { mime: 'audio/ogg', tamanho: 100, duracao: 3, nome: null, ptt: true }, ...extra });
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, json: async () => corpo });

test('arquivo que veio no webhook (base64) é aproveitado, com ou sem o prefixo data:', () => {
    assert.equal(arquivoDoWebhook({ message: { base64: Buffer.from('OGG').toString('base64') } }).toString(), 'OGG');
    assert.equal(arquivoDoWebhook({ message: { base64: `data:audio/ogg;base64,${Buffer.from('OGG').toString('base64')}` } }).toString(), 'OGG');
    assert.equal(arquivoDoWebhook({ message: {} }), null);
    assert.equal(arquivoDoWebhook(null), null);
});

test('Evolution: pede o arquivo pela chave da mensagem, na instância certa, com a apikey', async () => {
    let pedido;
    const fetchImpl = async (url, opts) => { pedido = { url, opts }; return resposta(201, { base64: Buffer.from('OGG').toString('base64'), mimetype: 'audio/ogg' }); };
    const r = await baixarDaEvolution({ evolutionUrl: 'http://evolution:8080', evolutionKey: 'K', instancia: 'goby suporte', key: { id: 'MSG1', remoteJid: 'x' }, fetchImpl });
    assert.equal(r.buffer.toString(), 'OGG');
    assert.equal(r.mime, 'audio/ogg');
    assert.equal(pedido.url, 'http://evolution:8080/chat/getBase64FromMediaMessage/goby%20suporte');
    assert.equal(pedido.opts.headers.apikey, 'K');
    assert.deepEqual(JSON.parse(pedido.opts.body), { message: { key: { id: 'MSG1', remoteJid: 'x' } }, convertToMp4: false });
});

test('Evolution: sem base64 na resposta é erro (não sobe arquivo vazio)', async () => {
    const fetchImpl = async () => resposta(404, { message: 'not found' });
    await assert.rejects(() => baixarDaEvolution({ evolutionUrl: 'u', evolutionKey: 'k', instancia: 'i', key: {}, fetchImpl }), /não entregou o arquivo \(404\)/);
});

test('backend: sobe os bytes com o tipo, o id e a instância, e a chave da ponte', async () => {
    let pedido;
    const fetchImpl = async (url, opts) => { pedido = { url, opts }; return resposta(200, { ok: true }); };
    await subirProBackend({ backend: 'https://api', chave: 'CH', ev: ev(), buffer: Buffer.from('OGG'), mime: 'audio/ogg', fetchImpl });
    assert.equal(pedido.url, 'https://api/api/ponte/midia?id=MSG1&instancia=goby-suporte');
    assert.equal(pedido.opts.headers['x-ponte-chave'], 'CH');
    assert.equal(pedido.opts.headers['Content-Type'], 'audio/ogg');
    assert.equal(pedido.opts.body.toString(), 'OGG');
});

test('backend recusou por regra (4xx): erro DEFINITIVO, não adianta tentar de novo', async () => {
    const fetchImpl = async () => resposta(413, { erro: 'Arquivo grande demais.' });
    await assert.rejects(() => subirProBackend({ backend: 'b', chave: 'c', ev: ev(), buffer: Buffer.from('x'), fetchImpl }),
        (err) => err.definitivo === true && /413: Arquivo grande demais/.test(err.message));
});

test('levar: baixa e sobe numa tentativa só quando dá certo', async () => {
    let obtidos = 0;
    let subidos = 0;
    const r = await levarMidia({ ev: ev(), obter: async () => { obtidos++; return { buffer: Buffer.from('OGG'), mime: 'audio/ogg' }; }, subir: async () => { subidos++; }, esperaMs: 0 });
    assert.deepEqual(r, { ok: true });
    assert.equal(obtidos, 1);
    assert.equal(subidos, 1);
});

test('levar: falha passageira (rede) tenta de novo e consegue', async () => {
    let n = 0;
    const r = await levarMidia({ ev: ev(), obter: async () => { n++; if (n < 2) throw new Error('ECONNRESET'); return { buffer: Buffer.from('OGG') }; }, subir: async () => {}, esperaMs: 0 });
    assert.equal(r.ok, true);
    assert.equal(n, 2);
});

test('levar: recusa definitiva para na hora; falha que não passa desiste depois das tentativas — e nunca lança', async () => {
    let subidas = 0;
    const definitivo = Object.assign(new Error('401'), { definitivo: true });
    const r1 = await levarMidia({ ev: ev(), obter: async () => ({ buffer: Buffer.from('x') }), subir: async () => { subidas++; throw definitivo; }, esperaMs: 0 });
    assert.equal(r1.ok, false);
    assert.equal(subidas, 1);
    let tentativas = 0;
    const r2 = await levarMidia({ ev: ev(), obter: async () => { tentativas++; throw new Error('fora do ar'); }, subir: async () => {}, tentativas: 3, esperaMs: 0 });
    assert.deepEqual(r2, { ok: false, motivo: 'fora do ar' });
    assert.equal(tentativas, 3);
});

test('levar: arquivo grande demais nem baixa (pelo tamanho anunciado) ou não sobe (pelo baixado)', async () => {
    let baixou = false;
    const r1 = await levarMidia({ ev: ev({ midia: { tamanho: LIMITE_BYTES + 1 } }), obter: async () => { baixou = true; }, subir: async () => {} });
    assert.equal(r1.motivo, 'grande_demais');
    assert.equal(baixou, false);
    let subiu = false;
    const r2 = await levarMidia({ ev: ev({ midia: { tamanho: null } }), obter: async () => ({ buffer: Buffer.alloc(LIMITE_BYTES + 1) }), subir: async () => { subiu = true; }, esperaMs: 0 });
    assert.equal(r2.motivo, 'grande_demais');
    assert.equal(subiu, false);
});

test('levar: mensagem sem mídia ou sem id não faz nada', async () => {
    assert.equal((await levarMidia({ ev: { id: 'x' }, obter: async () => {}, subir: async () => {} })).motivo, 'sem_midia');
    assert.equal((await levarMidia({ ev: null, obter: async () => {}, subir: async () => {} })).motivo, 'sem_midia');
});

test('levar: arquivo vazio não sobe', async () => {
    let subiu = false;
    const r = await levarMidia({ ev: ev(), obter: async () => ({ buffer: Buffer.alloc(0) }), subir: async () => { subiu = true; }, tentativas: 1, esperaMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(subiu, false);
});
