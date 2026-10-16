// O fluxo "Guardião: tudo de pé?" GERADO (n8n/workflows/guardiao.json): o código dos nós roda
// aqui com Evolution, ponte e backend de mentira. Rodar: node --test n8n/test/*.test.js
//
// O que cobre: cada peça vira ok/erro sem lançar; caiu avisa uma vez; continua caído lembra só
// depois de 1 h; voltou avisa; sem DONO_WHATSAPP ou sem número de pé, não manda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fluxo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'guardiao.json'), 'utf8'));
const no = Object.fromEntries(fluxo.nodes.map((n) => [n.name, n]));
const conn = fluxo.connections;
const destinos = (nome, saida = 0) => (conn[nome]?.main?.[saida] || []).map((d) => d.node);

function rodar(nomeNo, { env = {}, input = [], helpers = {}, memoria = {} } = {}) {
    const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
    const f = new Function('$env', '$input', '$getWorkflowStaticData', `return (async function () { ${no[nomeNo].parameters.jsCode} }).call(this);`);
    return f.call({ helpers }, env, $input, () => memoria);
}

// Mundo de mentira: cada URL responde com o que o teste mandar.
function mundo(respostas) {
    return {
        httpRequest: async ({ url }) => {
            const r = Object.entries(respostas).find(([k]) => url.includes(k));
            if (!r) throw new Error(`connect ECONNREFUSED ${url}`);
            const [, v] = r;
            if (v instanceof Error) throw v;
            return { statusCode: v.status ?? 200, body: v.body };
        },
    };
}
const TUDO_OK = {
    '/instance/connectionState/goby-suporte': { body: { instance: { instanceName: 'goby-suporte', state: 'open' } } },
    '/instance/connectionState/goby': { body: { instance: { instanceName: 'goby', state: 'open' } } },
    '/saude': { body: { ok: true, conectada: true, fila: 0 } },
    '/health': { status: 200, body: { status: 'ok' } },
};
const ENV = { EVOLUTION_API_URL: 'http://evolution:8080', EVOLUTION_API_KEY: 'k', AUUII_API_URL: 'https://backend', DONO_WHATSAPP: '5544999990000' };
const NOMES = ['WhatsApp da Nina (goby)', 'WhatsApp do suporte (goby-suporte)', 'Ponte (PC → painel)', 'Backend (Render)'];

test('estrutura: a cada 5 min → Checa → Compara → Tem pra quem? → Manda; sem destino não manda', () => {
    assert.deepEqual(destinos('A cada 5 minutos'), ['Checa']);
    assert.deepEqual(destinos('Checa'), ['Compara']);
    assert.deepEqual(destinos('Compara'), ['Tem pra quem?']);
    assert.deepEqual(destinos('Tem pra quem?', 0), ['Manda no WhatsApp']);
    assert.deepEqual(destinos('Tem pra quem?', 1), []);
    assert.equal(no['A cada 5 minutos'].parameters.rule.interval[0].minutesInterval, 5);
    assert.equal(no['Manda no WhatsApp'].parameters.options.batching, undefined);
    assert.equal(fluxo.active, false);
});

test('Checa: tudo de pé → quatro peças ok', async () => {
    const [saida] = await rodar('Checa', { env: ENV, helpers: mundo(TUDO_OK) });
    assert.deepEqual(Object.keys(saida.json.pecas), NOMES);
    assert.ok(NOMES.every((n) => saida.json.pecas[n].ok), JSON.stringify(saida.json.pecas));
});

test('Checa: WhatsApp fechado, ponte sem backend, backend fora — cada um com o motivo, sem lançar', async () => {
    const [saida] = await rodar('Checa', { env: ENV, helpers: mundo({
        ...TUDO_OK,
        '/instance/connectionState/goby-suporte': { body: { instance: { state: 'close' } } },
        '/saude': { body: { ok: true, conectada: false } },
        '/health': new Error('timeout of 8000ms exceeded'),
    }) });
    const p = saida.json.pecas;
    assert.equal(p['WhatsApp da Nina (goby)'].ok, true);
    assert.equal(p['WhatsApp do suporte (goby-suporte)'].ok, false);
    assert.match(p['WhatsApp do suporte (goby-suporte)'].detalhe, /close.*QR/);
    assert.equal(p['Ponte (PC → painel)'].ok, false);
    assert.match(p['Ponte (PC → painel)'].detalhe, /sem ligação com o backend/);
    assert.equal(p['Backend (Render)'].ok, false);
    assert.match(p['Backend (Render)'].detalhe, /não respondeu.*timeout/);
});

test('Checa: Evolution inteira fora → os dois WhatsApps caem com "Evolution não respondeu"', async () => {
    const [saida] = await rodar('Checa', { env: ENV, helpers: mundo({ '/saude': TUDO_OK['/saude'], '/health': TUDO_OK['/health'] }) });
    assert.match(saida.json.pecas['WhatsApp da Nina (goby)'].detalhe, /Evolution não respondeu/);
    assert.match(saida.json.pecas['WhatsApp do suporte (goby-suporte)'].detalhe, /Evolution não respondeu/);
});

const pecas = (ruins = {}) => Object.fromEntries(NOMES.map((n) => [n, ruins[n] ? { ok: false, detalhe: ruins[n] } : { ok: true, detalhe: 'ok' }]));
const T0 = 1_792_000_000_000;

test('Compara: tudo ok e nada na memória → nada a dizer', async () => {
    const memoria = {};
    assert.deepEqual(await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas() }], memoria }), []);
    assert.ok(NOMES.every((n) => memoria.pecas[n].ok));
});

test('Compara: caiu avisa uma vez; 5 min depois, nada; 1 h depois, lembra; voltou, avisa', async () => {
    const memoria = {};
    const ruim = { 'Backend (Render)': 'backend não respondeu (timeout)' };
    const [caiu] = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas(ruim) }], memoria });
    assert.equal(caiu.json.telefone, '5544999990000');
    assert.equal(caiu.json.instancia, 'goby-suporte', 'manda pelo número do suporte quando ele está de pé');
    assert.match(caiu.json.mensagem, /🔴 \*Caiu:\*\n• Backend \(Render\): backend não respondeu/);
    assert.match(caiu.json.mensagem, /Guardião · \d{2}:\d{2}/);

    assert.deepEqual(await rodar('Compara', { env: ENV, input: [{ em: T0 + 5 * 60000, pecas: pecas(ruim) }], memoria }), [], 'ainda caído, sem repetir');

    const [lembra] = await rodar('Compara', { env: ENV, input: [{ em: T0 + 61 * 60000, pecas: pecas(ruim) }], memoria });
    assert.match(lembra.json.mensagem, /⏳ \*Continua fora:\*\n• Backend \(Render\) há 61 min/);

    const [voltou] = await rodar('Compara', { env: ENV, input: [{ em: T0 + 90 * 60000, pecas: pecas() }], memoria });
    assert.match(voltou.json.mensagem, /🟢 \*Voltou:\*\n• Backend \(Render\) \(ficou 90 min fora\)/);
    assert.ok(memoria.pecas['Backend (Render)'].ok);
});

test('Compara: caiu o número do suporte → manda pelo da Nina; os dois → não tem por onde', async () => {
    const memoria = {};
    const [m] = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas({ 'WhatsApp do suporte (goby-suporte)': 'WhatsApp close' }) }], memoria });
    assert.equal(m.json.instancia, 'goby');
    const [n] = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas({ 'WhatsApp do suporte (goby-suporte)': 'x', 'WhatsApp da Nina (goby)': 'y' }) }], memoria: {} });
    assert.equal(n.json.semDestino, true);
    assert.match(n.json.motivo, /os dois números/);
});

test('Compara: sem DONO_WHATSAPP no .env → registra, mas não manda', async () => {
    const [m] = await rodar('Compara', { env: { ...ENV, DONO_WHATSAPP: '' }, input: [{ em: T0, pecas: pecas({ 'Ponte (PC → painel)': 'fora' }) }], memoria: {} });
    assert.equal(m.json.semDestino, true);
    assert.match(m.json.motivo, /DONO_WHATSAPP/);
    assert.equal(m.json.telefone, undefined);
});
