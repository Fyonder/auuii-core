// O fluxo "Nina aprende com o suporte" GERADO (n8n/workflows/nina-aprende-suporte.json): o
// código dos nós roda aqui com uma Evolution de mentira, como o n8n rodaria.
// Rodar: node --test n8n/test/*.test.js
//
// O que cobre: o que entra (conversa privada que a equipe respondeu), a LIMPEZA de dado pessoal
// antes de ir pra Groq, os lotes (recente primeiro, histórico com a sobra), o marcador de até
// onde leu, a junção das regras (quem soma as conversas é o código) e quando NÃO avança.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fluxo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'nina-aprende-suporte.json'), 'utf8'));
const no = Object.fromEntries(fluxo.nodes.map((n) => [n.name, n]));
const conn = fluxo.connections;
const destinos = (nome, saida = 0) => (conn[nome]?.main?.[saida] || []).map((d) => d.node);

// Roda o JS de um nó de código. `nos`: saída dos nós anteriores ({ nome: json | [json] }).
function rodar(nomeNo, { nos = {}, env = {}, input = [], helpers = {} } = {}) {
    const $ = (nome) => {
        if (!(nome in nos)) return { isExecuted: false, first() { throw new Error(`nó não rodou: ${nome}`); }, all: () => [] };
        const itens = [].concat(nos[nome]).map((json) => ({ json }));
        return { isExecuted: true, first: () => itens[0], all: () => itens };
    };
    const $input = { all: () => input.map((json) => ({ json })), first: () => ({ json: input[0] }) };
    const f = new Function('$env', '$', '$input', `return (async function () { ${no[nomeNo].parameters.jsCode} }).call(this);`);
    return f.call({ helpers }, env, $, $input);
}

// ── Evolution de mentira: findMessages paginado, da mais nova pra mais antiga ──
const AGORA = () => Math.floor(Date.now() / 1000);
const TEL = (n) => `5544900000${String(n).padStart(3, '0')}@s.whatsapp.net`; // fictícios
let seq = 0;
const msg = (ts, jid, texto, { eu = false, nome = 'Fulano Teste', tipo = 'conversation', message } = {}) => ({
    key: { id: `m${++seq}`, remoteJid: jid, fromMe: eu },
    pushName: eu ? 'Goby' : nome,
    messageType: tipo,
    message: message || (tipo === 'conversation' ? { conversation: texto } : {}),
    messageTimestamp: ts,
});
function evolution(registros) {
    const ordenados = [...registros].sort((a, b) => b.messageTimestamp - a.messageTimestamp);
    const chamadas = [];
    return {
        chamadas,
        helpers: {
            httpRequest: async (op) => {
                chamadas.push(op);
                const { page, offset } = op.body;
                const ini = (page - 1) * offset;
                return { messages: { total: ordenados.length, pages: Math.ceil(ordenados.length / offset), currentPage: page, records: ordenados.slice(ini, ini + offset) } };
            },
        },
    };
}
const ENV = { EVOLUTION_API_URL: 'http://evo', EVOLUTION_API_KEY: 'k' };
const monta = (registros, { estado = {}, env = {}, seco = false } = {}) => {
    const evo = evolution(registros);
    const nos = { Estado: { success: true, estado }, Existentes: { conhecidos: [] } };
    if (seco) nos['Testar leitura (sem IA)'] = {};
    return rodar('Monta lotes', { nos, env: { ...ENV, ...env }, helpers: evo.helpers }).then((saida) => ({ saida, evo }));
};
const textoDosLotes = (saida) => saida.map((i) => i.json.texto).join('\n\n');

// ─── Estrutura ────────────────────────────────────────────────────────────────────────────
test('estrutura: os dois gatilhos levam ao Estado; Groq com a credencial e um lote por vez', () => {
    assert.deepEqual(destinos('Toda madrugada'), ['Estado']);
    assert.deepEqual(destinos('Testar leitura (sem IA)'), ['Estado']);
    assert.equal(no['Toda madrugada'].parameters.rule.interval[0].expression, '30 3 * * *');
    // Um lote por minuto é um LAÇO (Loop → Groq → espera → Loop), não o "batching" do nó HTTP:
    // com batching o nó começava e nunca terminava (14/10/2026, n8n 2.39, duas rodadas).
    assert.deepEqual(destinos('Tem lote?', 0), ['Um lote por vez']);
    assert.deepEqual(destinos('Tem lote?', 1), ['Fecha a rodada']);
    assert.equal(no['Um lote por vez'].type, 'n8n-nodes-base.splitInBatches');
    assert.equal(no['Um lote por vez'].parameters.batchSize, 1);
    assert.deepEqual(destinos('Um lote por vez', 0), ['Junta o que achou'], 'acabou: todas as respostas juntas');
    assert.deepEqual(destinos('Um lote por vez', 1), ['Groq lê o lote'], 'o lote da vez');
    assert.deepEqual(destinos('Groq lê o lote'), ['Espera a cota']);
    assert.deepEqual(destinos('Espera a cota'), ['Um lote por vez']);
    assert.ok(no['Espera a cota'].parameters.amount >= 60 && no['Espera a cota'].parameters.amount < 65, 'vira o minuto, mas espera em memória (< 65 s)');
    assert.deepEqual(destinos('Tem candidata?', 0), ['Respira a cota'], 'pausa antes da junção');
    assert.deepEqual(destinos('Respira a cota'), ['Groq junta parecidas']);
    assert.ok(no['Respira a cota'].parameters.amount >= 60, 'deixa o minuto da Groq virar');
    assert.deepEqual(destinos('Tem candidata?', 1), ['Fecha a rodada']);
    assert.deepEqual(destinos('Manda sugestões'), ['Fecha a rodada']);
    assert.deepEqual(destinos('Fecha a rodada'), ['Salva até onde leu']);
    for (const nome of ['Groq lê o lote', 'Groq junta parecidas']) {
        const p = no[nome].parameters;
        assert.equal(p.nodeCredentialType, 'groqApi');
        assert.equal(no[nome].credentials.groqApi.name, 'Groq account');
        assert.equal(p.options.batching, undefined, 'sem batching do nó HTTP: ele trava');
        assert.equal(no[nome].onError, 'continueRegularOutput');
        assert.match(p.jsonBody, /json_object/);
    }
    for (const [nome, metodo, rota] of [['Estado', 'GET', 'estado'], ['Existentes', 'GET', 'existentes'], ['Manda sugestões', 'POST', 'sugestoes'], ['Salva até onde leu', 'POST', 'estado']]) {
        const p = no[nome].parameters;
        assert.equal(p.method, metodo, nome);
        assert.equal(p.url, `={{ $env.AUUII_API_URL }}/api/suporte/goby/aprender/${rota}`);
        assert.equal(p.headerParameters.parameters[0].name, 'x-suporte-api-key');
    }
    assert.equal(fluxo.active, false, 'nasce desligado: liga no Kali depois do backend');
});

const corpoDaGroq = (env = {}) => {
    const expr = no['Groq lê o lote'].parameters.jsonBody.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    return JSON.parse(new Function('$json', '$env', `return (${expr});`)({ texto: 'Conversa 1:\nM: oi\nS: oi' }, env));
};

test('modelo SÓ do aprendizado (não o da Nina), resposta curta, reasoning_effort só nos gpt-oss', () => {
    const corpo = corpoDaGroq();
    // 14/10/2026: o Llama 4 Scout saiu do catálogo da Groq (404); o gpt-oss-20b é a reserva da
    // Nina e tem teto por DIA (200 mil) que duas rodadas esgotaram. Fica o Qwen, só nosso.
    assert.equal(corpo.model, 'qwen/qwen3.8-27b');
    assert.ok(!/gpt-oss/.test(corpo.model), 'os gpt-oss são da Nina (120b) e da reserva dela (20b): cota por dia dividida');
    assert.ok(corpo.max_completion_tokens <= 1000, 'plano grátis: tokens de saída por minuto (Qwen: 1000) — acima disso a Groq recusa o pedido inteiro');
    assert.equal(corpo.reasoning_effort, undefined, 'reasoning_effort só existe nos gpt-oss');
    const gpt = corpoDaGroq({ NINA_APRENDE_MODELO: 'openai/gpt-oss-20b' });
    assert.equal(gpt.reasoning_effort, 'low');
    const juncao = JSON.parse(new Function('$json', '$env', `return (${no['Groq junta parecidas'].parameters.jsonBody.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '')});`)({ pedido: 'x' }, { NINA_APRENDE_MODELO: 'openai/gpt-oss-20b' }));
    assert.equal(juncao.reasoning_effort, 'medium', 'num gpt-oss, a junção (uma chamada por noite) pensa mais que os lotes');
    assert.match(no['Groq junta parecidas'].parameters.jsonBody, /Temas diferentes/);
    const llama = corpoDaGroq({ NINA_APRENDE_MODELO: 'llama-3.3-70b-versatile' });
    assert.equal(llama.model, 'llama-3.3-70b-versatile');
    assert.equal(llama.reasoning_effort, undefined, 'a Groq devolve 400 pro Llama com reasoning_effort');
});

test('"Rodar agora" só roda com o segredo; sem ele, para no portão', () => {
    assert.equal(no['Rodar agora'].type, 'n8n-nodes-base.webhook');
    assert.equal(no['Rodar agora'].parameters.path, 'nina-aprende-rodar');
    assert.deepEqual(destinos('Rodar agora'), ['Segredo confere?']);
    assert.deepEqual(destinos('Segredo confere?', 0), ['Estado']);
    assert.deepEqual(destinos('Segredo confere?', 1), []);
    const expr = no['Segredo confere?'].parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    const confere = (headers, env) => new Function('$json', '$env', `return (${expr});`)({ headers }, env);
    const S = 'x'.repeat(32);
    assert.equal(confere({ 'x-nina-segredo': S }, { NINA_TESTE_SEGREDO: S }), true);
    assert.equal(confere({ 'x-nina-segredo': 'errado' }, { NINA_TESTE_SEGREDO: S }), false);
    assert.equal(confere({}, { NINA_TESTE_SEGREDO: S }), false);
    assert.equal(confere({ 'x-nina-segredo': '' }, {}), false, 'sem a variável no .env, recusa tudo');
    assert.equal(confere({ 'x-nina-segredo': 'curto' }, { NINA_TESTE_SEGREDO: 'curto' }), false, 'segredo curto não vale');
});

test('o corpo da Groq vira um JSON válido, com o lote no lugar certo', () => {
    const corpo = corpoDaGroq();
    assert.equal(corpo.messages[0].role, 'system');
    assert.match(corpo.messages[0].content, /SUPORTE HUMANO da Goby/);
    assert.equal(corpo.messages[1].content, 'Conversa 1:\nM: oi\nS: oi');
});

// ─── Monta lotes ──────────────────────────────────────────────────────────────────────────
test('entra só conversa PRIVADA que a equipe respondeu', async () => {
    const t = AGORA() - 3600;
    const { saida } = await monta([
        msg(t, TEL(1), 'o pedido foi junto com outro'), msg(t + 60, TEL(1), 'me passa os dois números', { eu: true }),
        msg(t, '1203630@g.us', 'mensagem de grupo'), msg(t + 5, '1203630@g.us', 'resposta no grupo', { eu: true }),
        msg(t, 'status@broadcast', 'status'),
        msg(t, TEL(2), 'ninguém me respondeu'),
        msg(t, TEL(3), 'aviso da equipe sem pergunta', { eu: true }),
    ]);
    const tudo = textoDosLotes(saida);
    assert.match(tudo, /M: o pedido foi junto com outro\nS: me passa os dois números/);
    assert.doesNotMatch(tudo, /grupo|status|ninguém me respondeu|aviso da equipe/);
    assert.equal(saida[0].json.conversas, 1);
});

test('LIMPEZA: dado pessoal vira marcador antes de sair do Kali', async () => {
    const t = AGORA() - 3600;
    const { saida } = await monta([
        msg(t, TEL(4), 'Sou o Fulano, meu zap (44) 99999-0001, cpf 123.456.789-09, placa ABC1D23, faltou R$ 15,50 e 20 reais', { nome: 'Fulano Teste' }),
        msg(t + 10, TEL(4), 'tô na Rua das Flores, 123, email fulano@x.com, pix 12345678, olha https://goby.delivery/x'),
        msg(t + 60, TEL(4), 'Oi Fulano, a Goby já viu aqui', { eu: true }),
    ]);
    const tudo = textoDosLotes(saida);
    for (const vazou of ['99999', '123.456', 'ABC1D23', '15,50', '20 reais', 'Flores', 'fulano@x.com', '12345678', 'https://', 'Fulano']) {
        assert.ok(!tudo.includes(vazou), `vazou: ${vazou}\n${tudo}`);
    }
    for (const marca of ['[telefone]', '[cpf]', '[placa]', '[valor]', '[endereço]', '[email]', '[número]', '[link]', '[nome]']) {
        assert.ok(tudo.includes(marca), `faltou ${marca}`);
    }
    assert.match(tudo, /Goby já viu/, '"Goby" não é dado pessoal');
});

test('falas seguidas viram uma; 6 h de silêncio é outro atendimento; mídia vira marcador', async () => {
    const t = AGORA() - 20 * 3600;
    const { saida } = await monta([
        msg(t, TEL(5), 'cheguei na loja'), msg(t + 5, TEL(5), 'cadê o pedido?'),
        msg(t + 30, TEL(5), '', { eu: true, tipo: 'audioMessage' }),
        msg(t + 7 * 3600, TEL(5), 'outro dia, outro problema'), msg(t + 7 * 3600 + 60, TEL(5), 'já vejo', { eu: true }),
    ]);
    const tudo = textoDosLotes(saida);
    assert.match(tudo, /M: cheguei na loja \/ cadê o pedido\?\nS: \[áudio\]/);
    assert.match(tudo, /Conversa 2:\nM: outro dia, outro problema\nS: já vejo/);
    assert.equal(saida.reduce((s, i) => s + i.json.conversas, 0), 2);
});

test('marcador: 1ª rodada lê o último dia e uma fatia do histórico; depois só anda pra frente', async () => {
    const agora = AGORA();
    const regs = [];
    for (let d = 0; d < 12; d++) {
        const t = agora - d * 86400 - 3600;
        regs.push(msg(t, TEL(10 + d), `pergunta do dia ${d}`), msg(t + 60, TEL(10 + d), `resposta do dia ${d}`, { eu: true }));
    }
    const { saida } = await monta(regs, { env: { NINA_APRENDE_FATIA_DIAS: '5' } });
    const tudo = textoDosLotes(saida);
    // recente (dia 0) + histórico de 5 dias (dias 1 a 5); o dia 6 em diante fica pra próxima
    for (let d = 0; d <= 5; d++) assert.match(tudo, new RegExp(`pergunta do dia ${d}\\b`));
    assert.doesNotMatch(tudo, /pergunta do dia (6|7|8|9|10|11)\b/);
    assert.ok(tudo.indexOf('dia 0') < tudo.indexOf('dia 1'), 'o recente vem primeiro');
    const { estado } = saida[0].json.meta;
    assert.ok(Math.abs(estado.ultimoTs - agora) <= 2);
    assert.ok(Math.abs(estado.historicoAte - (agora - 86400 - 5 * 86400)) <= 2);
    assert.equal(estado.historicoCompleto, false);

    // 2ª rodada, partindo do marcador: o histórico continua de onde parou
    const r2 = await monta(regs, { estado, env: { NINA_APRENDE_FATIA_DIAS: '5' } });
    const tudo2 = textoDosLotes(r2.saida);
    assert.doesNotMatch(tudo2, /pergunta do dia [0-5]\b/);
    assert.match(tudo2, /pergunta do dia 6\b/);
});

test('histórico chega no limite (90 dias, ou o configurado): completo, e para de ler o passado', async () => {
    const agora = AGORA();
    const regs = [msg(agora - 3 * 86400, TEL(30), 'pergunta velha'), msg(agora - 3 * 86400 + 60, TEL(30), 'resposta velha', { eu: true })];
    const { saida } = await monta(regs, { env: { NINA_APRENDE_HISTORICO_DIAS: '4', NINA_APRENDE_FATIA_DIAS: '10' } });
    assert.equal(saida[0].json.meta.estado.historicoCompleto, true);
    const completo = { ...saida[0].json.meta.estado };
    const r2 = await monta(regs, { estado: completo, env: { NINA_APRENDE_HISTORICO_DIAS: '4' } });
    assert.equal(r2.saida[0].json.vazio, true, 'sem nada novo e com o histórico completo: vazio');
});

test('cota da noite: o que não coube fica pra próxima (o marcador não pula)', async () => {
    const agora = AGORA();
    const regs = [];
    for (let i = 0; i < 6; i++) {
        const t = agora - 6 * 3600 + i * 600;
        regs.push(msg(t, TEL(40 + i), `pergunta ${i} ${'x'.repeat(200)}`), msg(t + 60, TEL(40 + i), `resposta ${i}`, { eu: true }));
    }
    const velha = agora - 3 * 86400;
    regs.push(msg(velha, TEL(49), 'pergunta antiga'), msg(velha + 60, TEL(49), 'resposta antiga', { eu: true }));
    const { saida } = await monta(regs, { env: { NINA_APRENDE_MAX_LOTES: '1', NINA_APRENDE_LOTE_CHARS: '700' } });
    assert.equal(saida.length, 1);
    const coube = saida[0].json.conversas;
    assert.ok(coube >= 1 && coube < 6);
    const { ultimoTs, historicoAte } = saida[0].json.meta.estado;
    const primeiraQueFicou = agora - 6 * 3600 + coube * 600;
    assert.equal(ultimoTs, primeiraQueFicou - 1, 'recomeça antes da 1ª que não coube');
    assert.equal(historicoAte, agora - 86400, 'estourou no recente: o histórico nem anda');
    assert.doesNotMatch(textoDosLotes(saida), /pergunta antiga/);
});

test('cota estoura no histórico: o marcador para na conversa antiga que não coube', async () => {
    const agora = AGORA();
    const regs = [msg(agora - 3600, TEL(70), 'recente'), msg(agora - 3540, TEL(70), 'ok', { eu: true })];
    const velhas = [2, 3].map((d) => agora - d * 86400);
    for (const [i, v] of velhas.entries()) regs.push(msg(v, TEL(71 + i), `antiga ${i} ${'y'.repeat(300)}`), msg(v + 60, TEL(71 + i), 'resp', { eu: true }));
    const { saida } = await monta(regs, { env: { NINA_APRENDE_MAX_LOTES: '1', NINA_APRENDE_LOTE_CHARS: '500' } });
    const tudo = textoDosLotes(saida);
    assert.match(tudo, /recente/);
    assert.match(tudo, /antiga 0/);
    assert.doesNotMatch(tudo, /antiga 1/);
    assert.equal(saida[0].json.meta.estado.historicoAte, velhas[1] + 60 + 1);
});

test('teste seco: só contagens, nenhum texto de conversa na saída', async () => {
    const t = AGORA() - 3600;
    const { saida } = await monta([msg(t, TEL(50), 'segredo da conversa'), msg(t + 60, TEL(50), 'resposta', { eu: true })], { seco: true });
    assert.equal(saida.length, 1);
    assert.equal(saida[0].json.seco, true);
    assert.equal(saida[0].json.meta.resumo.conversas, 1);
    assert.ok(!JSON.stringify(saida).includes('segredo'));
});

test('busca binária: acha a data sem ler todas as páginas', async () => {
    const agora = AGORA();
    // 60 mil mensagens de grupo (1 por 30 s) e a conversa que interessa no meio delas
    const regs = Array.from({ length: 60000 }, (_, i) => msg(agora - i * 30, '1203630@g.us', 'grupo'));
    const alvo = agora - 86400 - 7 * 86400 / 2; // dentro da fatia do histórico
    regs.push(msg(alvo, TEL(60), 'pergunta no meio'), msg(alvo + 60, TEL(60), 'resposta no meio', { eu: true }));
    const { saida, evo } = await monta(regs, { env: { NINA_APRENDE_FATIA_DIAS: '7' } });
    assert.match(textoDosLotes(saida), /pergunta no meio/);
    const paginas = Math.ceil(regs.length / 1000);
    assert.ok(evo.chamadas.length < paginas, `${evo.chamadas.length} chamadas pra ${paginas} páginas`);
    assert.equal(evo.chamadas[0].headers.apikey, 'k');
    assert.equal(evo.chamadas[0].url, 'http://evo/chat/findMessages/goby-suporte');
});

test('sem mensagem nenhuma: vazio (e o marcador ainda anda)', async () => {
    const { saida } = await monta([]);
    assert.equal(saida[0].json.vazio, true);
    assert.ok(saida[0].json.meta.estado.ultimoTs > 0);
});

// ─── Junta / Prepara / Fecha ──────────────────────────────────────────────────────────────
const groq = (obj) => ({ choices: [{ message: { content: typeof obj === 'string' ? obj : JSON.stringify(obj) } }] });

test('Junta: candidatas de todos os lotes, conversas contadas (sem passar do lote), falhas contadas', async () => {
    const lotes = [{ conversas: 4 }, { conversas: 10 }, { conversas: 3 }];
    const [saida] = await rodar('Junta o que achou', {
        nos: { 'Monta lotes': lotes, Existentes: { conhecidos: ['Regra que ela já sabe.'] } },
        input: [
            groq({ regras: [{ texto: 'Quando o pedido foi junto, pedir os dois números.', tema: 'pedido junto', conversas: [1, 2, 2, 3, 9, 10] }], jeito: ['Fala curta e educada.'] }),
            groq({ regras: [{ texto: 'curta', conversas: [1] }, { texto: 'Quando o cliente não atende, pedir pra esperar 5 minutos e avisar.', conversas: [] }] }),
            { error: { message: 'Rate limit' } },
        ],
    });
    const c = saida.json.candidatas;
    assert.equal(saida.json.falhas, 1);
    assert.equal(saida.json.lotes, 3);
    assert.deepEqual(c.map((x) => x.conversas), [4, 4, 1], 'ids únicos, no máximo o tamanho do lote; sem ids conta 1');
    assert.equal(c.find((x) => x.tema === 'jeito de falar').conversas, 4);
    assert.ok(!c.some((x) => x.texto === 'curta'));
    assert.match(saida.json.pedido, /JÁ SABE:\n- Regra que ela já sabe\./);
    assert.match(saida.json.pedido, /CANDIDATAS:\n0\. \[/);
});

test('Prepara: soma as conversas pelas candidatas citadas, corta caso isolado e marcador', async () => {
    const candidatas = [{ texto: 'a', tema: 'retirada', conversas: 2 }, { texto: 'b', tema: 'retirada', conversas: 2 }, { texto: 'c', tema: 'x', conversas: 1 }];
    const [saida] = await rodar('Prepara envio', {
        nos: { 'Junta o que achou': { candidatas, falhas: 0, lotes: 2 } },
        input: [groq({ regras: [
            { texto: 'Quando chegar na loja e o pedido não estiver pronto, pedir pra aguardar e avisar a loja.', de: [0, 1, 1, 99, -1, 'x'] },
            { texto: 'Quando for caso raro, fazer tal coisa diferente sempre.', de: [2] },
            { texto: 'Quando [nome] pedir, mandar o link.', de: [0, 1] },
        ] })],
    });
    assert.deepEqual(saida.json.sugestoes, [{ texto: 'Quando chegar na loja e o pedido não estiver pronto, pedir pra aguardar e avisar a loja.', tema: 'retirada', conversas: 4 }]);
    assert.equal(saida.json.avancar, true);
});

// 14/10/2026, 1ª rodada boa: 143 candidatas viraram UMA regra de "jeito de falar"; o resto sumiu.
test('Prepara: candidata relevante que a junção não citou vai mesmo assim, uma por tema', async () => {
    const candidatas = [
        { texto: 'Quando o entregador pedir pra transferir a vaga, confirmar e mandar verificar o app.', tema: 'transferência de vaga', conversas: 10 },
        { texto: 'Quando o entregador confirmar a vaga, responder "vaga transferida".', tema: 'vagas', conversas: 7 },
        { texto: 'A equipe responde curto e agradece.', tema: 'jeito de falar', conversas: 20 },
        { texto: 'Quando o cliente não atender, pedir pra aguardar 10 minutos e tentar de novo.', tema: 'cliente não atende', conversas: 3 },
        { texto: 'Quando for retirada, fazer tal coisa.', tema: 'retirada', conversas: 2 },
        { texto: 'Quando a transferência for de outro tipo, confirmar também.', tema: 'Transferências', conversas: 4 },
    ];
    const [saida] = await rodar('Prepara envio', {
        nos: { 'Junta o que achou': { candidatas, falhas: 1, lotes: 30 } },
        input: [groq({ regras: [{ texto: 'Ao responder, seja curto, confirme a ação e agradeça.', tema: 'jeito de falar', de: [2] }] })],
    });
    const textos = saida.json.sugestoes.map((s) => s.texto);
    assert.equal(textos[0], 'Ao responder, seja curto, confirme a ação e agradeça.', 'o que a junção devolveu vem primeiro (20 conversas)');
    assert.ok(textos.includes(candidatas[0].texto), 'transferência de vaga (10) não citada: entra');
    assert.ok(textos.includes(candidatas[1].texto), 'vagas (7): outro tema, entra');
    assert.ok(textos.includes(candidatas[3].texto), 'cliente não atende (3 = mínimo): entra');
    assert.ok(!textos.includes(candidatas[4].texto), 'retirada com 2 conversas: fora');
    assert.ok(!textos.includes(candidatas[5].texto), '"Transferências" é o mesmo tema de "transferência de vaga": fica só a mais vista');
    assert.equal(saida.json.sugestoes.length, 4);
    assert.ok(saida.json.sugestoes.filter((s) => s.semJuncao).length === 3);
    assert.equal(saida.json.avancar, true);
});

test('Prepara: junção falhou → candidatas vão sem junção e a noite anda; metade dos lotes com erro → não anda', async () => {
    const junta = { candidatas: [
        { texto: 'Quando o entregador pedir pra transferir a vaga, confirmar e mandar verificar o app.', tema: 'transferência', conversas: 5 },
        { texto: 'Quando faltar código, pedir o número do pedido e a loja.', tema: 'código', conversas: 3 },
        { texto: 'Quando for caso raro, fazer tal coisa.', tema: 'raro', conversas: 1 },
    ], falhas: 0, lotes: 2 };
    // 14/10/2026: a junção caiu por cota três noites seguidas e a mesma fatia era relida pra sempre.
    const [semJuncao] = await rodar('Prepara envio', { nos: { 'Junta o que achou': junta }, input: [{ error: { message: 'OTPM' } }] });
    assert.equal(semJuncao.json.avancar, true, 'a leitura rendeu: anda');
    assert.deepEqual(semJuncao.json.sugestoes.map((s) => s.texto), [junta.candidatas[0].texto, junta.candidatas[1].texto]);
    assert.ok(semJuncao.json.sugestoes.every((s) => s.semJuncao));
    const [metade] = await rodar('Prepara envio', { nos: { 'Junta o que achou': { ...junta, falhas: 2, lotes: 3 } }, input: [groq({ regras: [] })] });
    assert.equal(metade.json.avancar, false);
});

test('Prepara: no máximo 30, a mais vista primeiro, e mínimo de conversas configurável', async () => {
    const candidatas = Array.from({ length: 40 }, (_, i) => ({ texto: `c${i}`, tema: 't', conversas: i + 1 }));
    const regras = candidatas.map((_, i) => ({ texto: `Quando acontecer a situação número ${i}, fazer a coisa certa.`, de: [i] }));
    const [saida] = await rodar('Prepara envio', { nos: { 'Junta o que achou': { candidatas, falhas: 0, lotes: 1 } }, input: [groq({ regras })], env: { NINA_APRENDE_MIN_CONVERSAS: '5' } });
    assert.equal(saida.json.sugestoes.length, 30);
    assert.equal(saida.json.sugestoes[0].conversas, 40);
    assert.ok(saida.json.sugestoes.every((s) => s.conversas >= 5));
});

test('Fecha a rodada: seco não grava; vazio anda; noite ruim só deixa o resumo', async () => {
    const meta = { estado: { ultimoTs: 1791899050, historicoAte: 1791000000, historicoCompleto: false }, resumo: { conversas: 3, lotes: 1 } };
    assert.deepEqual(await rodar('Fecha a rodada', { nos: { 'Monta lotes': { seco: true, meta: { ...meta, seco: true } } } }), []);

    const [vazio] = await rodar('Fecha a rodada', { nos: { 'Monta lotes': { vazio: true, meta } } });
    assert.equal(vazio.json.ultimoTs, 1791899050);
    assert.equal(vazio.json.ultimaRodada.avancou, 1);

    const [ruim] = await rodar('Fecha a rodada', {
        nos: { 'Monta lotes': { texto: 'x', meta }, 'Junta o que achou': { candidatas: [{}], falhas: 2, lotes: 2 }, 'Prepara envio': { sugestoes: [], avancar: false } },
    });
    assert.equal(ruim.json.ultimoTs, undefined);
    assert.equal(ruim.json.historicoAte, undefined);
    assert.equal(ruim.json.ultimaRodada.avancou, 0);
    assert.equal(ruim.json.ultimaRodada.falhas, 2);

    const [bom] = await rodar('Fecha a rodada', {
        nos: {
            'Monta lotes': { texto: 'x', meta },
            'Junta o que achou': { candidatas: [{}, {}], falhas: 0, lotes: 1 },
            'Prepara envio': { sugestoes: [{}], avancar: true },
            'Manda sugestões': { success: true, criadas: 1, somadas: 0 },
        },
    });
    assert.equal(bom.json.ultimoTs, 1791899050);
    assert.deepEqual({ ...bom.json.ultimaRodada }, { conversas: 3, lotes: 1, candidatas: 2, falhas: 0, sugeridas: 1, criadas: 1, somadas: 0, avancou: 1 });
});
