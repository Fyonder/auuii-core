// O fluxo "Guardião: tudo de pé?" GERADO (n8n/workflows/guardiao.json): o código dos nós roda
// aqui com Evolution, ponte e backend de mentira. Rodar: node --test n8n/test/*.test.js
//
// O que cobre: cada peça vira ok/erro sem lançar; o controle e os destinos são autenticados;
// caiu avisa uma vez; continua caído lembra só depois de 1 h; voltou avisa.
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
const ENV = { EVOLUTION_API_URL: 'http://evolution:8080', EVOLUTION_API_KEY: 'k', AUUII_API_URL: 'https://backend', AUUII_API_TOKEN_GOBY: 'goby-key' };
const NOMES = ['WhatsApp da Nina (goby)', 'WhatsApp do suporte (goby-suporte)', 'Ponte (PC → painel)', 'Backend (Render)'];

test('estrutura: controle pausa antes de Checa; fluxo ativo compara e só manda com destino', () => {
    assert.deepEqual(destinos('A cada 5 minutos'), ['Consulta controle']);
    assert.deepEqual(destinos('Consulta controle'), ['Monitor ligado?']);
    assert.deepEqual(destinos('Monitor ligado?', 0), ['Checa']);
    assert.deepEqual(destinos('Monitor ligado?', 1), []);
    assert.deepEqual(destinos('Checa'), ['Compara']);
    assert.deepEqual(destinos('Compara'), ['Tem pra quem?']);
    assert.deepEqual(destinos('Tem pra quem?', 0), ['Manda no WhatsApp']);
    assert.deepEqual(destinos('Tem pra quem?', 1), []);
    assert.equal(no['A cada 5 minutos'].parameters.rule.interval[0].minutesInterval, 5);
    assert.equal(no['Manda no WhatsApp'].parameters.options.batching, undefined);
    assert.equal(fluxo.active, false);
});

test('Consulta controle: desligado no painel interrompe o fluxo antes das verificações', async () => {
    let chamada;
    const memoria = {};
    const [saida] = await rodar('Consulta controle', {
        env: ENV,
        memoria,
        helpers: { httpRequest: async (req) => { chamada = req; return { statusCode: 200, body: { ativo: false, destinatarios: ['5544999990001'] } }; } },
    });
    assert.equal(chamada.url, 'https://backend/api/suporte/goby/suporte/guardiao');
    assert.equal(chamada.headers['x-suporte-api-key'], 'goby-key');
    assert.deepEqual(saida.json, { ativo: false, consultou: true });
    assert.deepEqual(memoria.destinatarios, ['5544999990001']);
});

test('Consulta controle: ligado ou backend indisponível mantém as verificações funcionando', async () => {
    const memoria = {};
    const ligado = await rodar('Consulta controle', {
        env: ENV,
        memoria,
        helpers: { httpRequest: async () => ({ statusCode: 200, body: { ativo: true, destinatarios: ['5544999990001', '5544999990002', '5544999990001'] } }) },
    });
    assert.deepEqual(ligado[0].json, { ativo: true, consultou: true });
    assert.deepEqual(memoria.destinatarios, ['5544999990001', '5544999990002']);

    const indisponivel = await rodar('Consulta controle', {
        env: ENV,
        memoria,
        helpers: { httpRequest: async () => { throw new Error('timeout'); } },
    });
    assert.equal(indisponivel[0].json.ativo, true);
    assert.equal(indisponivel[0].json.consultou, false);
    assert.match(indisponivel[0].json.erro, /timeout/);
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
    const memoria = { destinatarios: ['5544999990001', '5544999990002'] };
    const ruim = { 'Backend (Render)': 'backend não respondeu (timeout)' };
    const caiu = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas(ruim) }], memoria });
    assert.equal(caiu.length, 2);
    assert.deepEqual(caiu.map((x) => x.json.telefone), memoria.destinatarios);
    assert.equal(caiu[0].json.instancia, 'goby', 'manda pelo número da Nina (dono, 16/10/2026: "o WhatsApp que a Nina responde, não o outro")');
    assert.match(caiu[0].json.mensagem, /🔴 \*Caiu:\*\n• Backend \(Render\): backend não respondeu/);
    assert.match(caiu[0].json.mensagem, /Guardião · \d{2}:\d{2}/);

    assert.deepEqual(await rodar('Compara', { env: ENV, input: [{ em: T0 + 5 * 60000, pecas: pecas(ruim) }], memoria }), [], 'ainda caído, sem repetir');

    const lembra = await rodar('Compara', { env: ENV, input: [{ em: T0 + 61 * 60000, pecas: pecas(ruim) }], memoria });
    assert.equal(lembra.length, 2);
    assert.match(lembra[0].json.mensagem, /⏳ \*Continua fora:\*\n• Backend \(Render\) há 61 min/);

    const voltou = await rodar('Compara', { env: ENV, input: [{ em: T0 + 90 * 60000, pecas: pecas() }], memoria });
    assert.equal(voltou.length, 2);
    assert.match(voltou[0].json.mensagem, /🟢 \*Voltou:\*\n• Backend \(Render\) \(ficou 90 min fora\)/);
    assert.ok(memoria.pecas['Backend (Render)'].ok);
});

test('Compara: todos destinatários recebem pelo WhatsApp de pé; se os dois caem, não manda', async () => {
    const memoria = { destinatarios: ['5544999990001', '5544999990002'] };
    const m = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas({ 'WhatsApp da Nina (goby)': 'WhatsApp close' }) }], memoria });
    assert.deepEqual(m.map((x) => x.json.telefone), memoria.destinatarios);
    assert.ok(m.every((x) => x.json.instancia === 'goby-suporte'));
    const n = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas({ 'WhatsApp do suporte (goby-suporte)': 'x', 'WhatsApp da Nina (goby)': 'y' }) }], memoria });
    assert.equal(n.length, 1);
    assert.equal(n[0].json.semDestino, true);
    assert.match(n[0].json.motivo, /os dois números/);
});

test('Compara: sem destinatários selecionados, registra e não manda para números antigos do .env', async () => {
    const [n] = await rodar('Compara', { env: ENV, input: [{ em: T0, pecas: pecas({ 'Ponte (PC → painel)': 'fora' }) }], memoria: {} });
    assert.equal(n.json.semDestino, true);
    assert.match(n.json.motivo, /destinatários selecionados no Resumo do dia/);
    assert.equal(n.json.telefone, undefined);
});
