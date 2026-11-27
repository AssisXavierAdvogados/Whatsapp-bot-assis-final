'use strict';
// Preload (node -r) usado pelos testes de integracao: troca TODAS as chamadas
// externas do server.js (Meta, Claude, Groq, ElevenLabs) por respostas locais e
// registra cada uma em MOCK_LOG (uma linha JSON por evento). Nada sai para a rede.
const fs = require('fs');
const axios = require('axios');

const LOG = process.env.MOCK_LOG;
const ev = (o) => fs.appendFileSync(LOG, JSON.stringify(o) + '\n');

// O server.js guarda o historico num arquivo fixo em /tmp; os testes nao tocam nele.
const HIST = '/tmp/conversation_history.json';
const { existsSync, writeFileSync } = fs;
fs.existsSync = (p) => (p === HIST ? false : existsSync(p));
fs.writeFileSync = (p, ...r) => (p === HIST ? undefined : writeFileSync(p, ...r));

const RESPOSTA_CURTA = 'Ouvi aqui, obrigada por explicar.\n\nA consulta custa R$ 250,00 e o telefone do escritório é +55 (44)99977-8551.';
const RESPOSTA_LONGA = 'Esta frase se repete para a resposta passar do limite de voz. '.repeat(14).trim();

function route(method, url, body) {
  if (url.includes('api.anthropic.com')) {
    const ultima = body.messages[body.messages.length - 1];
    const txt = typeof ultima.content === 'string' ? ultima.content : JSON.stringify(ultima.content);
    const cliente = String(body.system).includes('Você é Ana, assistente virtual de atendimento');
    ev({ t: 'claude', cliente, entrada: txt });
    if (!cliente) return { data: { content: [{ type: 'text', text: 'Resposta da assistente ao advogado: link https://exemplo.com e lista.' }], stop_reason: 'end_turn' } };
    return { data: { content: [{ type: 'text', text: /LONGO/.test(txt) ? RESPOSTA_LONGA : RESPOSTA_CURTA }], stop_reason: 'end_turn' } };
  }
  if (url.includes('graph.facebook.com') && url.endsWith('/messages')) {
    if (body.status === 'read') return { data: { success: true } };
    ev({ t: 'meta_texto', to: body.to, type: body.type, body: body.text && body.text.body });
    return { data: { messages: [{ id: 'wamid.txt' }] } };
  }
  if (url.includes('graph.facebook.com')) {
    if (url.endsWith('/aud-falha')) { const e = new Error('media nao encontrada'); e.response = { status: 404, data: { error: { message: 'not found' } } }; throw e; }
    return { data: { url: 'https://mock.local/media', mime_type: url.includes('img') ? 'image/jpeg' : 'audio/ogg' } };
  }
  if (url.includes('mock.local/media')) return { data: Buffer.from('conteudo-falso') };
  return { data: [] };
}
for (const m of ['get', 'delete']) axios[m] = async (url) => route(m, url, null);
for (const m of ['post', 'patch', 'put']) axios[m] = async (url, body) => route(m, url, body);

// WAV curto valido: o ffmpeg de verdade converte (ele detecta o formato pelo conteudo).
function wavSilencio() {
  const n = 8000;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes('/audio/transcriptions')) return json(200, { text: 'levaram meu carro hoje cedo' });
  if (u.includes('api.elevenlabs.io')) {
    const body = JSON.parse(init.body);
    ev({ t: 'elevenlabs', text: body.text, model: body.model_id, url: u });
    const status = Number(process.env.MOCK_ELEVEN_STATUS || 200);
    if (status !== 200) return json(status, { detail: { status: 'invalid_api_key', message: `Invalid API key ${init.headers['xi-api-key']}` } });
    return new Response(wavSilencio(), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (u.includes('graph.facebook.com') && u.endsWith('/media')) {
    ev({ t: 'meta_upload', type: init.body.get('type'), fileType: init.body.get('file').type, bytes: init.body.get('file').size });
    return json(200, { id: 'MEDIA-OGG' });
  }
  if (u.includes('graph.facebook.com') && u.endsWith('/messages')) {
    const body = JSON.parse(init.body);
    ev({ t: 'meta_audio', to: body.to, type: body.type, audio: body.audio });
    return json(200, { messages: [{ id: 'wamid.audio' }] });
  }
  throw new Error(`fetch inesperado no teste: ${u}`);
};
