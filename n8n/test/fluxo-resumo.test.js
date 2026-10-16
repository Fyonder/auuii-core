// O fluxo "Suporte: resumo do dia" GERADO (n8n/workflows/resumo-dia.json): o código dos nós
// roda aqui. Rodar: node --test n8n/test/*.test.js
//
// O que cobre: só manda ligado, com destinatário válido, dentro da janela do horário e uma vez
// por dia (memória do fluxo); um item por pessoa, pelo número do suporte.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fluxo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'resumo-dia.json'), 'utf8'));
const no = Object.fromEntries(fluxo.nodes.map((n) => [n.name, n]));
const conn = fluxo.connections;
const destinos = (nome, saida = 0) => (conn[nome]?.main?.[saida] || []).map((d) => d.node);

function rodar(nomeNo, { env = {}, input = [], nos = {}, memoria = {} } = {}) {
    const $ = (nome) => ({ first: () => ({ json: nos[nome] }) });
    const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
    const f = new Function('$env', '$', '$input', '$getWorkflowStaticData', `return (async function () { ${no[nomeNo].parameters.jsCode} }).call(this);`);
    return f.call({}, env, $, $input, () => memoria);
}

// 16/10/2026 21:37 em Maringá (-03:00).
const AS = (hhmm, dia = '2026-10-16') => String(Date.parse(`${dia}T${hhmm}:00-03:00`));
const cfg = (extra = {}) => ({ success: true, resumoDiario: { ligado: true, horario: '21:30', destinatarios: [{ nome: 'Carlos', telefone: '5544999990001' }, { nome: 'Ana', telefone: '5544999990002' }], ...extra } });

test('estrutura: a cada 15 min → Automações → É hora? → Resumo → Uma por pessoa → Manda pelo suporte', () => {
    assert.deepEqual(destinos('A cada 15 minutos'), ['Automações']);
    assert.deepEqual(destinos('Automações'), ['É hora?']);
    assert.deepEqual(destinos('É hora?'), ['Resumo']);
    assert.deepEqual(destinos('Resumo'), ['Uma por pessoa']);
    assert.deepEqual(destinos('Uma por pessoa'), ['Manda no WhatsApp']);
    assert.equal(no['A cada 15 minutos'].parameters.rule.interval[0].minutesInterval, 15);
    assert.match(no['Automações'].parameters.url, /\/api\/suporte\/goby\/suporte\/automacoes$/);
    assert.match(no['Resumo'].parameters.url, /resumo-dia\?dia=\{\{ \$json\.dia \}\}/);
    assert.equal(no['Automações'].parameters.headerParameters.parameters[0].name, 'x-suporte-api-key');
    assert.match(no['Manda no WhatsApp'].parameters.url, /sendText\/goby-suporte$/);
    assert.equal(no['Manda no WhatsApp'].parameters.options.batching, undefined);
    assert.equal(fluxo.active, false);
});

test('É hora?: desligado, sem destinatário ou horário inválido → nada', async () => {
    const env = { RESUMO_AGORA: AS('21:37') };
    assert.deepEqual(await rodar('É hora?', { env, input: [cfg({ ligado: false })] }), []);
    assert.deepEqual(await rodar('É hora?', { env, input: [cfg({ destinatarios: [] })] }), []);
    assert.deepEqual(await rodar('É hora?', { env, input: [cfg({ destinatarios: [{ nome: 'x', telefone: '999' }] })] }), [], 'telefone sem país/DDD não vale');
    assert.deepEqual(await rodar('É hora?', { env, input: [cfg({ horario: '9h' })] }), []);
});

test('É hora?: dentro da janela de 15 min manda uma vez por dia; fora da janela, não', async () => {
    const memoria = {};
    assert.deepEqual(await rodar('É hora?', { env: { RESUMO_AGORA: AS('21:15') }, input: [cfg()], memoria }), [], 'antes da hora');
    const [ok] = await rodar('É hora?', { env: { RESUMO_AGORA: AS('21:37') }, input: [cfg()], memoria });
    assert.equal(ok.json.dia, '2026-10-16');
    assert.deepEqual(ok.json.destinatarios.map((d) => d.telefone), ['5544999990001', '5544999990002']);
    assert.deepEqual(await rodar('É hora?', { env: { RESUMO_AGORA: AS('21:50') }, input: [cfg()], memoria }), [], 'janela de 15 min já passou');
    // Ainda não mandou (o Uma por pessoa é quem marca); mas já marcado, não repete no dia.
    memoria.ultimoDia = '2026-10-16';
    assert.deepEqual(await rodar('É hora?', { env: { RESUMO_AGORA: AS('21:40') }, input: [cfg()], memoria }), [], 'já mandou hoje');
    const [amanha] = await rodar('É hora?', { env: { RESUMO_AGORA: AS('21:31', '2026-10-17') }, input: [cfg()], memoria });
    assert.equal(amanha.json.dia, '2026-10-17');
});

test('É hora?: o dia é o de Maringá — 23:50 local ainda é hoje, não amanhã (UTC)', async () => {
    const [r] = await rodar('É hora?', { env: { RESUMO_AGORA: AS('23:50') }, input: [cfg({ horario: '23:45' })], memoria: {} });
    assert.equal(r.json.dia, '2026-10-16');
});

test('Uma por pessoa: marca que mandou hoje e vira um item por destinatário com o texto do backend', async () => {
    const memoria = {};
    const hora = { dia: '2026-10-16', destinatarios: [{ nome: 'Carlos', telefone: '5544999990001' }, { nome: 'Ana', telefone: '5544999990002' }] };
    const saida = await rodar('Uma por pessoa', { nos: { 'É hora?': hora }, input: [{ success: true, texto: '📋 *Suporte Goby — resumo de 16/10/2026*\n• 2 conversas' }], memoria });
    assert.equal(memoria.ultimoDia, '2026-10-16');
    assert.deepEqual(saida.map((i) => [i.json.telefone, i.json.nome]), [['5544999990001', 'Carlos'], ['5544999990002', 'Ana']]);
    assert.match(saida[0].json.mensagem, /resumo de 16\/10\/2026/);
    assert.deepEqual(await rodar('Uma por pessoa', { nos: { 'É hora?': hora }, input: [{ success: true, texto: '' }], memoria: {} }), [], 'sem texto, não manda');
});
