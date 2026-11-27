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

// Supabase de mentira, em memoria (so e usado quando o teste define SUPABASE_URL).
// MOCK_SUPABASE_SEED: JSON com as linhas iniciais da tabela "conversations".
const supabase = JSON.parse(process.env.MOCK_SUPABASE_SEED || '[]');
function supabaseRoute(method, url, body) {
  const m = /[?&]phone=eq\.([^&]+)/.exec(url);
  const phone = m ? decodeURIComponent(m[1]) : null;
  if (method === 'get') {
    const rows = phone ? supabase.filter(r => r.phone === phone) : supabase;
    return { data: JSON.parse(JSON.stringify(rows)) };
  }
  if (method === 'post') {
    const i = supabase.findIndex(r => r.phone === body.phone);
    if (i === -1) supabase.push({ ...body }); else supabase[i] = { ...supabase[i], ...body };
    ev({ t: 'supabase_upsert', phone: body.phone, meta: body.meta || null });
    return { data: [] };
  }
  if (method === 'patch' && phone) {
    const i = supabase.findIndex(r => r.phone === phone);
    if (i !== -1) supabase[i] = { ...supabase[i], ...body };
    ev({ t: 'supabase_patch', phone, meta: body.meta || null });
    return { data: [] };
  }
  return { data: [] };
}

function route(method, url, body) {
  if (url.includes('/rest/v1/conversations')) return supabaseRoute(method, url, body);
  if (url.includes('api.anthropic.com')) {
    // Fase 5 (origem/urgencia/honorarios): o que entrou no system prompt, e um
    // roteiro simples de ferramenta para testar o encaminhamento formal.
    {
      const sys = String(body.system || '');
      const fim = body.messages[body.messages.length - 1];
      const entradaTxt = typeof fim.content === 'string' ? fim.content : '';
      if (sys.includes('Você é Ana, assistente virtual de atendimento')) {
        ev({
          t: 'claude_sistema', entrada: entradaTxt,
          origem: (sys.match(/ORIGEM (DO CLIENTE|AINDA NÃO INFORMADA)[^\n]*/) || [''])[0],
          urgencia: sys.includes('URGÊNCIA EM CURSO (dados do sistema)'),
          triagem: (sys.match(/TRIAGEM DE URGÊNCIA \(dados do sistema\)[^\n]*/) || [''])[0],
          honorarios: sys.slice(sys.indexOf('HONORÁRIOS ADVOCATÍCIOS'), sys.indexOf('AGORA (dados do sistema)'))
        });
        if (/USAR_FERRAMENTA/.test(entradaTxt)) {
          return { data: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tool-1', name: 'notificar_especialista',
            input: { area: 'criminal', nome_cliente: 'Maria Teste', horario_preferido: 'o quanto antes', resumo_caso: 'Resumo de teste.', urgencia: true, motivo_urgencia: 'teste' } }] } };
        }
        if (/PERGUNTA_ORIGEM/.test(entradaTxt)) {
          return { data: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Entendi. E como você conheceu o escritório?' }] } };
        }
      }
    }
    const ultima = body.messages[body.messages.length - 1];
    const txt = typeof ultima.content === 'string' ? ultima.content : JSON.stringify(ultima.content);
    const cliente = String(body.system).includes('Você é Ana, assistente virtual de atendimento');
    // campos: todas as chaves que chegaram nas mensagens (deve ser so role e content)
    const campos = [...new Set(body.messages.flatMap(m => Object.keys(m)))].sort();
    ev({ t: 'claude', cliente, entrada: txt, campos });
    if (/FALHA_CLAUDE/.test(txt)) { const e = new Error('falha simulada do Claude'); e.response = { status: 500, data: { error: { message: 'erro simulado' } } }; throw e; }
    if (!cliente) return { data: { content: [{ type: 'text', text: 'Resposta da assistente ao advogado: link https://exemplo.com e lista.' }], stop_reason: 'end_turn' } };
    return { data: { content: [{ type: 'text', text: /LONGO/.test(txt) ? RESPOSTA_LONGA : RESPOSTA_CURTA }], stop_reason: 'end_turn' } };
  }
  if (url.includes('graph.facebook.com') && url.endsWith('/messages')) {
    if (process.env.MOCK_FALHA_ALERTA && body.text && /ALERTA URGENTE/.test(body.text.body)) {
      ev({ t: 'meta_falha_alerta', to: body.to });
      throw new Error('falha simulada no envio do alerta');
    }
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
