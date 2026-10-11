// O chat da Nina pela ponte: o corpo que vai pro fluxo e o que volta pro backend — com o
// segredo da entrada de teste, e sem deixar passar pedido malformado.
const test = require('node:test');
const assert = require('node:assert/strict');
const { corpoPraNina, perguntarANina } = require('../src/nina');

// Telefones e passes fictícios (o repositório é público).
const TEL = '5544999990001';
const PASSE = 'a'.repeat(48);
const cfg = { n8nNinaWeb: 'http://n8n:5678/webhook/goby-teste', ninaTesteSegredo: 's'.repeat(32) };

test('site (restaurante/equipe): telefone só dígitos vira o chatId, com o nome', () => {
    assert.deepEqual(corpoPraNina({ telefone: '(44) 99999-0001', texto: '  oi  ', nome: 'Loja' }), { chatId: '44999990001', message: 'oi', nome: 'Loja' });
    assert.deepEqual(corpoPraNina({ telefone: TEL, texto: 'oi' }), { chatId: TEL, message: 'oi' });
});

test('painel: canal, chatId painel_<uid> e o passe; nome vai junto', () => {
    assert.deepEqual(corpoPraNina({ canal: 'painel', chatId: 'painel_U1-x_2', passe: PASSE, texto: 'como foi hoje?', nome: 'Carlos' }),
        { canal: 'painel', chatId: 'painel_U1-x_2', passe: PASSE, message: 'como foi hoje?', nome: 'Carlos' });
});

test('painel recusa chatId sem o prefixo (ninguém vira telefone por aqui) e passe fora do formato', () => {
    assert.equal(corpoPraNina({ canal: 'painel', chatId: TEL, passe: PASSE, texto: 'x' }), null);
    assert.equal(corpoPraNina({ canal: 'painel', chatId: 'painel_u1', passe: 'curto', texto: 'x' }), null);
    assert.equal(corpoPraNina({ canal: 'painel', chatId: 'painel_u1', passe: 'A'.repeat(48), texto: 'x' }), null); // maiúsculas não são hex
    assert.equal(corpoPraNina({ canal: 'painel', chatId: 'painel_', passe: PASSE, texto: 'x' }), null);
    assert.equal(corpoPraNina({ canal: 'painel', chatId: 'painel_' + 'u'.repeat(65), passe: PASSE, texto: 'x' }), null);
});

test('sem texto, telefone curto, ou nada: null', () => {
    assert.equal(corpoPraNina({ telefone: TEL, texto: '   ' }), null);
    assert.equal(corpoPraNina({ telefone: '123', texto: 'oi' }), null);
    assert.equal(corpoPraNina({ telefone: '55449999900019999', texto: 'oi' }), null);
    assert.equal(corpoPraNina(null), null);
    assert.equal(corpoPraNina(undefined), null);
    assert.equal(corpoPraNina({}), null);
});

test('texto e nome são cortados (2000 e 80), não recusados', () => {
    const c = corpoPraNina({ telefone: TEL, texto: 'x'.repeat(5000), nome: 'n'.repeat(200) });
    assert.equal(c.message.length, 2000);
    assert.equal(c.nome.length, 80);
});

function fetchFalso(status, corpo, chamadas = []) {
    return async (url, opts) => {
        chamadas.push({ url, opts });
        return { ok: status >= 200 && status < 300, status, json: async () => { if (corpo === 'invalido') throw new Error('json'); return corpo; } };
    };
}

test('perguntar: manda com o segredo e devolve a resposta e o handoff', async () => {
    const chamadas = [];
    const r = await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: fetchFalso(200, { reply: 'Oi!', handoff: true }, chamadas) });
    assert.deepEqual(r, { ok: true, resposta: 'Oi!', handoff: true });
    assert.equal(chamadas[0].url, cfg.n8nNinaWeb);
    assert.equal(chamadas[0].opts.headers['x-nina-segredo'], cfg.ninaTesteSegredo);
    assert.deepEqual(JSON.parse(chamadas[0].opts.body), { chatId: TEL, message: 'oi' });
});

test('perguntar: pedido malformado nem chega no n8n', async () => {
    const chamadas = [];
    const r = await perguntarANina({ telefone: '12', texto: 'oi' }, { cfg, fetch: fetchFalso(200, {}, chamadas) });
    assert.equal(r.ok, false);
    assert.match(r.erro, /obrigat/);
    assert.equal(chamadas.length, 0);
});

test('perguntar: sem o segredo configurado (ou curto), não chama o n8n', async () => {
    const chamadas = [];
    for (const segredo of ['', 'curtinho', undefined]) {
        const r = await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg: { ...cfg, ninaTesteSegredo: segredo }, fetch: fetchFalso(200, {}, chamadas) });
        assert.equal(r.ok, false);
        assert.match(r.erro, /NINA_TESTE_SEGREDO/);
    }
    assert.equal(chamadas.length, 0);
});

test('perguntar: n8n respondeu erro HTTP, ou recusou o segredo', async () => {
    assert.deepEqual(await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: fetchFalso(502, {}) }), { ok: false, erro: 'n8n respondeu 502' });
    const r = await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: fetchFalso(200, { ignorado: true, motivo: 'sem segredo' }) });
    assert.equal(r.ok, false);
    assert.match(r.erro, /recusou/);
});

test('perguntar: corpo que não é JSON, ou sem reply: resposta vazia, sem quebrar', async () => {
    assert.deepEqual(await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: fetchFalso(200, 'invalido') }), { ok: true, resposta: '', handoff: false });
    assert.deepEqual(await perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: fetchFalso(200, {}) }), { ok: true, resposta: '', handoff: false });
});

test('perguntar: rede caiu / tempo esgotou: a exceção sobe (o index devolve erro no ack)', async () => {
    await assert.rejects(perguntarANina({ telefone: TEL, texto: 'oi' }, { cfg, fetch: async () => { throw new Error('TimeoutError'); } }), /TimeoutError/);
});
