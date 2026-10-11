// ─── Chat da Nina nos sites e no painel ─────────────────────────────────────────────
//
// backend ─'nina' (com ack)─▶ ponte ─▶ n8n /webhook/goby-teste ─▶ resposta no ack.
// Quem é a pessoa (telefone confirmado por código, loja pelo email, ou equipe logada) o
// backend já decidiu. Aqui só se monta o corpo que o fluxo espera e se repassa.
//
// Separado do index.js (10/10/2026) pra ter teste: o index.js conecta no backend ao ser
// carregado, e não dá pra importar sem ligar tudo.

// Nina no painel (goby-suporte, 09/10/2026): em vez de telefone vem `canal: 'painel'`, o
// chatId `painel_<uid>` e o `passe` com as permissões de quem perguntou — o backend confere o
// passe em cada consulta.
function corpoPraNina(pergunta) {
    const texto = String(pergunta?.texto || '').trim();
    if (!texto) return null;
    const nome = pergunta?.nome ? { nome: String(pergunta.nome).slice(0, 80) } : {};
    if (pergunta?.canal === 'painel') {
        const chatId = String(pergunta?.chatId || '');
        const passe = String(pergunta?.passe || '');
        if (!/^painel_[A-Za-z0-9_-]{1,64}$/.test(chatId) || !/^[a-f0-9]{48}$/.test(passe)) return null;
        return { canal: 'painel', chatId, passe, message: texto.slice(0, 2000), ...nome };
    }
    const telefone = String(pergunta?.telefone || '').replace(/\D/g, '');
    if (!/^\d{10,13}$/.test(telefone)) return null;
    // nome: quem está logado no site (a Nina trata pelo nome).
    return { chatId: telefone, message: texto.slice(0, 2000), ...nome };
}

/**
 * Manda a pergunta pra entrada de teste do fluxo e devolve { ok, resposta, handoff } ou
 * { ok: false, erro }. `cfg` = { n8nNinaWeb, ninaTesteSegredo }; `fetch` injetável pra teste.
 * Erro de rede/tempo sobe como exceção (quem chama devolve `erro` no ack).
 */
async function perguntarANina(pergunta, { cfg, fetch: fetchFn = fetch, timeoutMs = 60000 } = {}) {
    const corpoEnviado = corpoPraNina(pergunta);
    if (!corpoEnviado) return { ok: false, erro: 'telefone (ou chatId e passe do painel) e texto são obrigatórios' };
    const segredo = String(cfg?.ninaTesteSegredo || '');
    if (segredo.length < 16) return { ok: false, erro: 'NINA_TESTE_SEGREDO não configurado na ponte' };
    const resp = await fetchFn(cfg.n8nNinaWeb, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nina-segredo': segredo },
        body: JSON.stringify(corpoEnviado),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, erro: `n8n respondeu ${resp.status}` };
    // Segredo diferente do n8n: o fluxo devolve { ignorado: true } em vez da resposta.
    if (corpo.ignorado === true) return { ok: false, erro: 'o n8n recusou: NINA_TESTE_SEGREDO diferente do da ponte' };
    return { ok: true, resposta: String(corpo.reply || ''), handoff: corpo.handoff === true };
}

module.exports = { corpoPraNina, perguntarANina };
