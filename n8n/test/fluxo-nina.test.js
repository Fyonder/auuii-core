// O fluxo da Nina GERADO (n8n/workflows/atendimento-goby-nina.json): o código dos nós é
// executado aqui com entradas falsas, como o n8n faria. Rodar: node --test n8n/test/*.test.js
//
// O que cobre: a entrada (Normaliza), a trava da entrada de teste, a saudação pronta do
// motoboy (Monta contexto), a resposta do agente (Interpreta resposta) e a estrutura que o
// backend espera (ferramentas do suporte com o passe). Mudou o gerador, mudou aqui.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fluxo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'atendimento-goby-nina.json'), 'utf8'));
const no = Object.fromEntries(fluxo.nodes.map((n) => [n.name, n]));
const conn = fluxo.connections;

// `={{ expr }}` do n8n → valor, com $json/$env falsos.
function expressao(valor, { $json = {}, $env = {} } = {}) {
    const js = String(valor).replace(/^=\{\{\s*/, '').replace(/\s*\}\}$/, '');
    return new Function('$json', '$env', `return (${js});`)($json, $env);
}
const campo = (noNome, nome) => no[noNome].parameters.assignments.assignments.find((a) => a.name === nome).value;

// Telefones/passes fictícios (o repositório é público).
const TEL = '5544999990001';
const PASSE = 'f'.repeat(48);
const SEGREDO = 's'.repeat(32);

test('Normaliza: WhatsApp (Evolution) — canal whatsapp, chatId do remoteJid, nome do pushName, sem passe', () => {
    const body = { data: { key: { remoteJid: `${TEL}@s.whatsapp.net` }, pushName: 'Zé', message: { conversation: 'oi' } }, instance: 'goby', passe: 'nao-vale' };
    assert.equal(expressao(campo('Normaliza', 'canal'), { $json: { body } }), 'whatsapp');
    assert.equal(expressao(campo('Normaliza', 'chatId'), { $json: { body } }), TEL);
    assert.equal(expressao(campo('Normaliza', 'nome'), { $json: { body } }), 'Zé');
    assert.equal(expressao(campo('Normaliza', 'message'), { $json: { body } }), 'oi');
    assert.equal(expressao(campo('Normaliza', 'passe'), { $json: { body } }), '');
});

test('Normaliza: painel — canal painel, chatId sempre painel_…, nome e passe do corpo', () => {
    const body = { canal: 'painel', chatId: 'painel_AbC-1', message: 'como foi hoje?', nome: 'Carlos', passe: PASSE };
    assert.equal(expressao(campo('Normaliza', 'canal'), { $json: { body } }), 'painel');
    assert.equal(expressao(campo('Normaliza', 'chatId'), { $json: { body } }), 'painel_AbC-1');
    assert.equal(expressao(campo('Normaliza', 'nome'), { $json: { body } }), 'Carlos');
    assert.equal(expressao(campo('Normaliza', 'passe'), { $json: { body } }), PASSE);
    // tentativa de se passar por um telefone pelo canal painel: o chatId ganha o prefixo
    assert.equal(expressao(campo('Normaliza', 'chatId'), { $json: { body: { canal: 'painel', chatId: TEL, message: 'x' } } }), `painel_${TEL}`);
    assert.equal(expressao(campo('Normaliza', 'chatId'), { $json: { body: { canal: 'painel', chatId: 'painel_a b;c', message: 'x' } } }), 'painel_abc');
});

test('Normaliza: entrada de teste (curl) — canal teste, chatId do corpo', () => {
    const body = { chatId: TEL, message: 'oi' };
    assert.equal(expressao(campo('Normaliza', 'canal'), { $json: { body } }), 'teste');
    assert.equal(expressao(campo('Normaliza', 'chatId'), { $json: { body } }), TEL);
});

test('Teste com segredo?: só passa com x-nina-segredo igual ao NINA_TESTE_SEGREDO (e ele com 16+)', () => {
    const cond = no['Teste com segredo?'].parameters.conditions.conditions[0].leftValue;
    const confere = (h, s) => expressao(cond, { $json: { headers: h ? { 'x-nina-segredo': h } : {} }, $env: s === undefined ? {} : { NINA_TESTE_SEGREDO: s } });
    assert.equal(confere(SEGREDO, SEGREDO), true);
    assert.equal(confere('errado', SEGREDO), false);
    assert.equal(confere(undefined, SEGREDO), false);
    assert.equal(confere('curto', 'curto'), false); // segredo curto não vale nem batendo
    assert.equal(confere('', ''), false);
    assert.equal(confere(SEGREDO, undefined), false); // variável ausente: recusa tudo
    assert.deepEqual(conn['Webhook (teste)'].main.map((o) => o.map((d) => d.node)), [['Teste com segredo?']]);
    assert.deepEqual(conn['Teste com segredo?'].main.map((o) => o.map((d) => d.node)), [['Humano pelo aparelho?'], ['Teste recusado']]);
    assert.equal(conn['Teste recusado'], undefined); // recusado não vai a lugar nenhum
});

test('estrutura: o modo suporte tem a ferramenta de estatísticas e manda o passe em tudo', () => {
    const tools = Object.entries(conn).filter(([, c]) => (c.ai_tool || []).some((o) => o.some((d) => d.node === 'Agente Nina (suporte)'))).map(([n]) => n).sort();
    // As que o backend do painel conhece (ninaPainel.PERMISSAO_DA_CONSULTA) têm que estar;
    // ferramenta nova pode entrar, desde que também leve o passe (abaixo).
    for (const t of ['Buscar cadastro', 'Buscar pedido', 'Corridas do entregador', 'Dia dos motoboys', 'Estatísticas', 'Motoboy no dia', 'Vagas do dia']) {
        assert.ok(tools.includes(t), `falta a ferramenta "${t}" no modo suporte`);
    }
    for (const t of [...tools, 'Identificar']) {
        const hs = no[t].parameters.headerParameters.parameters;
        assert.ok(hs.some((h) => h.name === 'x-nina-passe'), `${t} sem o passe`);
        assert.ok(hs.some((h) => h.name === 'x-suporte-api-key'), `${t} sem a chave`);
    }
    const prompt = no['Agente Nina (suporte)'].parameters.options.systemMessage;
    assert.match(prompt, /semPermissao/);
    assert.match(prompt, /"Estatísticas"/);
    assert.doesNotMatch(prompt.split('TRAVA DO FINANCEIRO')[0], /R\$/);
});

// ── Interpreta resposta ──────────────────────────────────────────────────────────────
function interpretar(output, textoDaFerramenta) {
    const code = no['Interpreta resposta'].parameters.jsCode;
    const item = { json: { output, intermediateSteps: textoDaFerramenta ? [{ action: {}, observation: JSON.stringify([{ success: true, texto: textoDaFerramenta }]) }] : [] } };
    const $input = { all: () => [item], first: () => item };
    const r = new Function('$input', '$json', code)($input, item.json);
    return (Array.isArray(r) ? r[0] : r).json.output;
}
const TEXTO = 'Hoje, 10/10 — 80 motoboys\n\n*Não vieram*\n• Thiago Rodrigues — Holandesa 07:00-10:59\n• Mauricio Cruz — Holandesa 07:00-10:29\n• Wes Gama — Holandesa 08:00-11:59';

test('Interpreta resposta: [SUPORTE] vira handoff e some do texto', () => {
    assert.deepEqual(interpretar('Vou chamar a equipe. [SUPORTE]'), { reply: 'Vou chamar a equipe.', handoff: true, resumo: null });
    assert.deepEqual(interpretar('Tudo certo.').handoff, false);
});

test('Interpreta resposta: RESUMO: na última linha vai pra equipe', () => {
    const r = interpretar('Um atendente vai falar com você. [SUPORTE]\nRESUMO: motoboy · pedido 123 · pedido sumiu');
    assert.equal(r.handoff, true);
    assert.equal(r.resumo, 'motoboy · pedido 123 · pedido sumiu');
    assert.doesNotMatch(r.reply, /RESUMO/);
});

test('Interpreta resposta: suporte — a IA copiou o texto pronto e parou no meio: vai o texto inteiro (etapa 26)', () => {
    const cortada = 'Hoje, 10/10 — 80 motoboys\n\nNão vieram\n• Thiago Rodrigues — Holandesa 07:00‑10:59\n• Wes Gama — Holand‑ …';
    assert.equal(interpretar(cortada, TEXTO).reply, TEXTO);
    assert.equal(interpretar(TEXTO, TEXTO).reply, TEXTO);
    assert.equal(interpretar(TEXTO.replace(/-/g, '‑').replace(/\*/g, ''), TEXTO).reply, TEXTO);
});

test('Interpreta resposta: resposta curta tirada do texto, ou sem relação, fica como a IA escreveu', () => {
    assert.equal(interpretar('O Thiago não chegou na vaga das 07:00.', TEXTO).reply, 'O Thiago não chegou na vaga das 07:00.');
    assert.equal(interpretar('A fila pra escolher vaga não está aberta agora.', TEXTO).reply, 'A fila pra escolher vaga não está aberta agora.');
});

test('Interpreta resposta: vazio (o modelo tropeçou) pede pra mandar de novo, sem chamar a equipe', () => {
    const r = interpretar('');
    assert.equal(r.vazio, true);
    assert.equal(r.handoff, false);
    assert.match(r.reply, /mandar de novo/);
});

test('Interpreta resposta: JSON {reply, handoff} também é aceito', () => {
    assert.deepEqual(interpretar('{"reply":"ok","handoff":true}').handoff, true);
    assert.equal(interpretar({ reply: 'direto', handoff: false }).reply, 'direto');
});

// ── Monta contexto: a saudação pronta (sem IA) ──────────────────────────────────────
function contexto({ identificar, normaliza, robo }) {
    const code = no['Monta contexto'].parameters.jsCode;
    const nos = {
        Identificar: { first: () => ({ json: identificar }) },
        Normaliza: { first: () => ({ json: normaliza }) },
        'Robô: quem': { first: () => { if (!robo) throw new Error('sem robô'); return { json: robo }; } },
        'Config da Nina': { first: () => ({ json: {} }) },
    };
    const estatico = {};
    const r = new Function('$', '$env', '$getWorkflowStaticData', code)((n) => nos[n], { SUPORTE_WHATSAPP: '' }, () => estatico);
    return r[0].json;
}
const motoboy = (corridas) => ({ perfil: 'motoboy', nome: 'JOAO DA SILVA', persona: 'Nina', primeiroContato: true, corridas, aguardandoHumano: false });
const oi = { chatId: TEL, message: 'oi', nome: 'Joao' };

test('Monta contexto: motoboy com 1 corrida — a saudação pronta abre pela situação dele', () => {
    const c = contexto({ identificar: motoboy([{ codigo: '1234', loja: 'Pizzaria Dom', etapa: 'a caminho do cliente' }]), normaliza: oi });
    assert.equal(c.perfil, 'motoboy');
    assert.match(c.saudacaoPronta, /#1234/);
    assert.match(c.saudacaoPronta, /Pizzaria Dom/);
    assert.match(c.saudacaoPronta, /a caminho do cliente/);
    assert.match(c.saudacaoPronta, /Joao/);
});

test('Monta contexto: 2 corridas, uma por linha; nenhuma; corridas indisponíveis não inventa', () => {
    const duas = contexto({ identificar: motoboy([{ codigo: '1', loja: 'A', etapa: 'aceita' }, { codigo: '2', loja: 'B', etapa: 'em rota' }]), normaliza: oi }).saudacaoPronta;
    assert.match(duas, /#1/); assert.match(duas, /#2/); assert.match(duas, /\n/);
    assert.match(contexto({ identificar: motoboy([]), normaliza: oi }).saudacaoPronta, /nenhuma corrida/i);
    const semDados = contexto({ identificar: motoboy(null), normaliza: oi }).saudacaoPronta;
    assert.doesNotMatch(semDados, /#|corrida/i);
    assert.ok(semDados.length > 0);
});

test('Monta contexto: pergunta de verdade não ganha resposta fixa (vai pra IA, com as corridas no prompt)', () => {
    const c = contexto({ identificar: motoboy([{ codigo: '1234', loja: 'Pizzaria Dom', etapa: 'aceita' }]), normaliza: { ...oi, message: 'cade meu pedido 1234' } });
    assert.equal(c.saudacaoPronta, '');
    assert.match(c.blocoCorridas, /#1234/);
});

test('Monta contexto: número desconhecido que diz "oi" recebe o menu; o passe do painel entra como suporte', () => {
    const d = contexto({ identificar: { perfil: null, nome: null, primeiroContato: true }, normaliza: { ...oi, nome: '' } });
    assert.match(d.saudacaoPronta, /1 - Motoboy/);
    assert.match(d.saudacaoPronta, /2 - Restaurante/);
    const s = contexto({ identificar: { perfil: 'suporte', nome: 'Carlos', suporte: true, painel: true, primeiroContato: null }, normaliza: { chatId: 'painel_u1', message: 'oi', nome: 'Carlos', passe: PASSE } });
    assert.equal(s.perfil, 'suporte');
});
