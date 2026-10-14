/**
 * O ARQUIVO das mídias (foto, áudio, vídeo, documento, figurinha) até o painel — dono,
 * 13/10/2026: "dentro do painel dá pra mostrar os dados em imagens, ou os áudios também?".
 *
 * A mensagem vai pela fila de sempre só com os DADOS do arquivo (normalizar.js). O arquivo
 * vai por fora, numa chamada HTTP própria pro backend: base64 de áudio e vídeo na fila (que
 * é gravada em disco e vai pelo socket) passaria do tamanho que o socket aceita e travaria
 * todas as mensagens atrás dele. Se o arquivo não subir, a mensagem chega igual — o painel
 * mostra "[áudio]" como antes.
 *
 * De onde vem o arquivo:
 *   - Evolution (número do suporte): no próprio webhook, se ela estiver mandando base64;
 *     senão pede pra ela (/chat/getBase64FromMediaMessage).
 *   - Meta (número da Nina): pela Graph API, com o id da mídia (GraphMeta.baixarMidia).
 *
 * O backend guarda por 24 h (escolha do dono) e apaga.
 */

// O que o backend aceita. Acima disso, nem tenta: vídeo longo não é pra ver no painel.
const LIMITE_BYTES = 16 * 1024 * 1024;
const TENTATIVAS = 3;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** O arquivo que veio NO webhook da Evolution (quando ela manda base64), ou null. */
function arquivoDoWebhook(data) {
    const b64 = data?.message?.base64;
    if (typeof b64 !== 'string' || !b64) return null;
    return Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
}

/** Pede o arquivo da mensagem pra Evolution. */
async function baixarDaEvolution({ evolutionUrl, evolutionKey, instancia, key, fetchImpl = fetch }) {
    const resp = await fetchImpl(`${evolutionUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(instancia)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: evolutionKey },
        body: JSON.stringify({ message: { key }, convertToMp4: false }),
        signal: AbortSignal.timeout(60000),
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok || typeof corpo?.base64 !== 'string' || !corpo.base64) {
        throw new Error(`a Evolution não entregou o arquivo (${resp.status})`);
    }
    return { buffer: Buffer.from(corpo.base64, 'base64'), mime: corpo.mimetype || null };
}

/** Sobe o arquivo pro backend: POST /api/ponte/midia, com a chave da ponte. */
async function subirProBackend({ backend, chave, ev, buffer, mime, fetchImpl = fetch }) {
    const url = `${backend}/api/ponte/midia?id=${encodeURIComponent(ev.id)}&instancia=${encodeURIComponent(ev.instancia || '')}`;
    const resp = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': mime || ev.midia?.mime || 'application/octet-stream', 'x-ponte-chave': chave },
        body: buffer,
        signal: AbortSignal.timeout(60000),
    });
    if (resp.ok) return;
    const corpo = await resp.json().catch(() => ({}));
    const erro = new Error(`o backend recusou o arquivo (${resp.status}${corpo?.erro ? `: ${corpo.erro}` : ''})`);
    // Recusa por regra (chave, tamanho, tipo) não melhora tentando de novo.
    erro.definitivo = resp.status >= 400 && resp.status < 500;
    throw erro;
}

/**
 * Leva o arquivo de UMA mensagem até o backend. Nunca lança: devolve { ok, motivo } — o
 * arquivo é um extra, a mensagem já foi.
 *
 * `obter()` traz { buffer, mime } (do webhook, da Evolution ou da Meta); `subir(arquivo)`
 * manda pro backend. Tentativas com espera crescente pros dois.
 */
async function levarMidia({ ev, obter, subir, tentativas = TENTATIVAS, esperaMs = 2000, log = () => {} }) {
    if (!ev?.id || !ev.midia) return { ok: false, motivo: 'sem_midia' };
    if (ev.midia.tamanho && ev.midia.tamanho > LIMITE_BYTES) {
        log(`📎 ${ev.id}: ${ev.midia.tamanho} bytes, acima do limite — fica só "[${ev.tipo}]" no painel`);
        return { ok: false, motivo: 'grande_demais' };
    }
    let ultimo = null;
    for (let i = 0; i < tentativas; i++) {
        try {
            const arquivo = await obter();
            if (!arquivo?.buffer?.length) throw new Error('arquivo vazio');
            if (arquivo.buffer.length > LIMITE_BYTES) return { ok: false, motivo: 'grande_demais' };
            await subir(arquivo);
            return { ok: true };
        } catch (err) {
            ultimo = err;
            if (err.definitivo) break;
            if (i < tentativas - 1) await esperar(esperaMs * (i + 1));
        }
    }
    log(`❌ 📎 arquivo de ${ev.id} não chegou ao painel: ${ultimo?.message || 'erro'}`);
    return { ok: false, motivo: ultimo?.message || 'erro' };
}

module.exports = { LIMITE_BYTES, arquivoDoWebhook, baixarDaEvolution, subirProBackend, levarMidia };
