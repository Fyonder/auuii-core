// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { Classificador, chaveCanonica, destinoDaMensagem, emMs } = require('../src/normalizar');

const SUPORTE = '557991367323';

function upsert(data) { return { event: 'messages.upsert', instance: 'auuii', data }; }
function enviada(data) { return { event: 'send.message', instance: 'auuii', data }; }
function msg({ id = 'ID1', jid = '554499429771@s.whatsapp.net', fromMe = false, texto = 'oi', extra = {}, key = {} } = {}) {
    return { key: { remoteJid: jid, fromMe, id, ...key }, pushName: 'Maria', message: { conversation: texto }, messageType: 'conversation', messageTimestamp: 1790000000, ...extra };
}

test('mensagem de quem escreve pro Auuii é do contato, com o nome do WhatsApp', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    const ev = c.classificar(upsert(msg()));
    assert.equal(ev.autor, 'contato');
    assert.equal(ev.telefone, '554499429771');
    assert.equal(ev.nome, 'Maria');
    assert.equal(ev.em, 1790000000 * 1000);
});

test('resposta que o n8n mandou pela API é da IA', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    assert.equal(c.classificar(enviada(msg({ fromMe: true, texto: 'Oi, eu sou a Duda' }))).autor, 'ia');
});

test('envio do painel é reconhecido mesmo chegando antes da resposta do sendText', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    // painel pediu pro número com o 9; o WhatsApp devolve o JID sem o 9
    c.registrarPendente({ reqId: 'req_1', conversaId: 'c_x', numero: '5544999429771', texto: 'Já estou vendo ' });
    const ev = c.classificar(enviada(msg({ fromMe: true, texto: 'Já estou vendo' })));
    assert.equal(ev.autor, 'operador');
    assert.equal(ev.reqId, 'req_1');
    assert.equal(ev.conversaId, 'c_x');
    // o mesmo texto de novo, sem pendente, já é da IA
    assert.equal(c.classificar(enviada(msg({ id: 'ID2', fromMe: true, texto: 'Já estou vendo' }))).autor, 'ia');
});

test('pendente vencido não rouba mensagem da IA', () => {
    let t = 0;
    const c = new Classificador({ agora: () => t, janelaPendenteMs: 60000 });
    c.registrarPendente({ reqId: 'r', conversaId: 'c', numero: '554499429771', texto: 'ok' });
    t = 61000;
    assert.equal(c.classificar(enviada(msg({ fromMe: true, texto: 'ok' }))).autor, 'ia');
});

test('aviso interno pro número do suporte é do sistema', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    const ev = c.classificar(enviada(msg({ fromMe: true, jid: `${SUPORTE}@s.whatsapp.net`, texto: '🛎️ AVISO INTERNO DO SUPORTE\n[motoboy] ...' })));
    assert.equal(ev.autor, 'sistema');
});

test('digitado no celular do Auuii é do aparelho; eco de envio da API é ignorado', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    assert.equal(c.classificar(upsert(msg({ id: 'CEL1', fromMe: true, texto: 'aqui é o Filipe' }))).autor, 'aparelho');
    c.classificar(enviada(msg({ id: 'API1', fromMe: true, texto: 'resposta' })));
    assert.equal(c.classificar(upsert(msg({ id: 'API1', fromMe: true, texto: 'resposta' }))), null);
});

test('grupo, status e reação não viram mensagem', () => {
    const c = new Classificador();
    assert.equal(c.classificar(upsert(msg({ jid: '120363@g.us' }))), null);
    assert.equal(c.classificar(upsert(msg({ jid: 'status@broadcast' }))), null);
    assert.equal(c.classificar(upsert({ key: { remoteJid: '554499429771@s.whatsapp.net', id: 'R1' }, message: { reactionMessage: { text: '👍' } }, messageType: 'reactionMessage' })), null);
    assert.equal(c.classificar({ event: 'connection.update', data: {} }), null);
});

test('áudio e foto chegam com tipo; legenda vira texto', () => {
    const c = new Classificador();
    const audio = c.classificar(upsert({ key: { remoteJid: '554499429771@s.whatsapp.net', id: 'A1' }, message: { audioMessage: { seconds: 5 } }, messageType: 'audioMessage' }));
    assert.deepEqual([audio.tipo, audio.texto], ['audio', '']);
    const foto = c.classificar(upsert({ key: { remoteJid: '554499429771@s.whatsapp.net', id: 'F1' }, message: { imageMessage: { caption: 'o endereço é esse' } }, messageType: 'imageMessage' }));
    assert.deepEqual([foto.tipo, foto.texto], ['imagem', 'o endereço é esse']);
});

test('conversa endereçada por LID acha o telefone no remoteJidAlt', () => {
    const d = destinoDaMensagem({ key: { remoteJid: '123456789012345@lid', remoteJidAlt: '554499429771@s.whatsapp.net' } });
    assert.deepEqual(d, { jid: '554499429771@s.whatsapp.net', telefone: '554499429771', lid: '123456789012345' });
    const semAlt = destinoDaMensagem({ key: { remoteJid: '123456789012345@lid' } });
    assert.equal(semAlt.telefone, null);
    assert.equal(semAlt.lid, '123456789012345');
});

test('a chave ignora o 9º dígito, igual ao backend', () => {
    assert.equal(chaveCanonica('5579991367323'), '557991367323');
    assert.equal(chaveCanonica('557991367323@s.whatsapp.net'), '557991367323');
    assert.equal(chaveCanonica('79991367323'), '557991367323');
});

test('timestamp em segundos, em milissegundos ou no formato Long do protobuf', () => {
    assert.equal(emMs(1790000000), 1790000000000);
    assert.equal(emMs(1790000000000), 1790000000000);
    assert.equal(emMs({ low: 1790000000, high: 0 }), 1790000000000);
});

test('cada evento diz de qual número (instância) veio', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    assert.equal(c.classificar(upsert(msg())).instancia, 'auuii');
    assert.equal(c.classificar({ event: 'messages.upsert', instance: 'goby', data: msg({ id: 'G1' }) }).instancia, 'goby');
});

test('envio do painel pela Goby não é confundido com o mesmo texto saindo pela Auuii', () => {
    const c = new Classificador({ suporteWhatsapp: SUPORTE });
    c.registrarPendente({ reqId: 'req_g', conversaId: 'c_g', numero: '554499429771', texto: 'ok', instancia: 'goby' });
    // a Duda (Auuii) manda "ok" pro mesmo contato: é da IA, não o envio do painel da Goby
    assert.equal(c.classificar(enviada(msg({ id: 'A1', fromMe: true, texto: 'ok' }))).autor, 'ia');
    const ev = c.classificar({ event: 'send.message', instance: 'goby', data: msg({ id: 'G2', fromMe: true, texto: 'ok' }) });
    assert.equal(ev.autor, 'operador');
    assert.equal(ev.reqId, 'req_g');
});
