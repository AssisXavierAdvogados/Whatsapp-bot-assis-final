'use strict';
// Integracao: sobe o server.js de verdade com as chamadas externas trocadas por
// mocks (tests/helpers/mock-external.js) e confere QUANDO a resposta sai em voz.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const voice = require('../voice');

const RAIZ = path.join(__dirname, '..');
const FAKE_KEY = 'sk_teste_CHAVE_SECRETA_ELEVENLABS_123456';
const ADVOGADO = '5544999784442'; // Dr. Willian (SPECIALISTS no server.js)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function comServidor(porta, envExtra, roteiro) {
  const logFile = path.join(os.tmpdir(), `ana-voz-teste-${process.pid}-${porta}.jsonl`);
  fs.writeFileSync(logFile, '');
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'mock-external.js'), 'server.js'], {
    cwd: RAIZ,
    env: {
      PATH: process.env.PATH, PORT: String(porta), MOCK_LOG: logFile,
      WHATSAPP_TOKEN: 'token-teste-whatsapp', PHONE_NUMBER_ID: '123456', CLAUDE_API_KEY: 'chave-teste-claude',
      TRANSCRIBE_API_KEY: 'chave-teste-groq', ...envExtra
    }
  });
  let saida = '';
  proc.stdout.on('data', d => { saida += d; });
  proc.stderr.on('data', d => { saida += d; });
  const base = `http://127.0.0.1:${porta}`;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) { await sleep(100); }
    }
    const enviar = (from, msg) => fetch(`${base}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, id: `in-${from}-${Math.random()}`, ...msg }] } }] }] })
    });
    const texto = (from, body) => enviar(from, { type: 'text', text: { body } });
    const audio = (from, id = 'aud-ok') => enviar(from, { type: 'audio', audio: { id, mime_type: 'audio/ogg' } });
    const imagem = (from) => enviar(from, { type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg' } });
    const health = async () => (await fetch(`${base}/health`)).json();
    const extra = await roteiro({ texto, audio, imagem, health });
    const eventos = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { eventos, saida, extra };
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(logFile, { force: true });
  }
}

const para = (eventos, to) => eventos.filter(e => e.to === to);
const ESPERA = 9000; // debounce (ate 6 s) + processamento + baloes

test('servidor: decisao entre voz e texto', { skip: !voice.ffmpegAvailable() && 'ffmpeg-static nao instalado', timeout: 60000 }, async (t) => {
  const A = '5544900000011', B = '5544900000012', C = '5544900000013', D = '5544900000014', E = '5544900000015', F = '5544900000016';

  const [ligado, desligado, erroEleven] = await Promise.all([
    comServidor(3941, { VOICE_REPLIES_ENABLED: 'true', ELEVENLABS_API_KEY: FAKE_KEY }, async (s) => {
      await s.audio(A);                                   // so audio
      await s.audio(B); await sleep(1200); await s.texto(B, 'esqueci de dizer: foi o banco'); // audio, depois texto
      await s.texto(C, 'boa tarde'); await sleep(1200); await s.audio(C);                     // texto, depois audio
      await s.imagem(D);                                  // imagem
      await s.audio(ADVOGADO);                            // advogado mandando audio
      await s.audio(E, 'aud-falha');                      // audio que nao pode ser transcrito
      await s.texto(F, 'LONGO'); await sleep(300); await s.audio(F); // ultima e audio, mas a resposta e longa
      const h = await s.health();
      await sleep(ESPERA);
      return h;
    }),
    comServidor(3942, { ELEVENLABS_API_KEY: FAKE_KEY }, async (s) => { await s.audio(A); await sleep(ESPERA - 2000); }),
    comServidor(3943, { VOICE_REPLIES_ENABLED: 'true', ELEVENLABS_API_KEY: FAKE_KEY, MOCK_ELEVEN_STATUS: '401' }, async (s) => { await s.audio(A); await sleep(ESPERA - 2000); })
  ]);

  await t.test('ultima mensagem foi audio: recado de voz + dados por escrito, sem repetir o texto', () => {
    const ev = para(ligado.eventos, A);
    assert.deepEqual(ev.map(e => e.t), ['meta_audio', 'meta_texto']);
    assert.deepEqual(ev[0].audio, { id: 'MEDIA-OGG', voice: true });
    assert.equal(ev[1].body, 'Valor: R$ 250,00\nTelefone: +55 (44)99977-8551');
    const up = ligado.eventos.find(e => e.t === 'meta_upload');
    assert.deepEqual([up.type, up.fileType], ['audio/ogg', 'audio/ogg']);
    assert.ok(up.bytes > 0 && up.bytes < 512 * 1024);
    const falado = ligado.eventos.find(e => e.t === 'elevenlabs');
    assert.equal(falado.model, 'eleven_multilingual_v2');
    assert.ok(falado.url.endsWith('/n2a9VtkZLl8j1FSXHsL7'));
    assert.equal(falado.text, 'Ouvi aqui, obrigada por explicar. A consulta custa o valor que te mando por escrito e o telefone do escritório é o que te mando por escrito.');
  });

  await t.test('audio seguido de texto no mesmo lote: resposta em texto', () => {
    const ev = para(ligado.eventos, B);
    assert.ok(ev.length >= 1);
    assert.ok(ev.every(e => e.t === 'meta_texto'));
    assert.ok(ev.some(e => e.body.includes('R$ 250,00')));
    const lote = ligado.eventos.find(e => e.t === 'claude' && e.entrada.includes('foi o banco'));
    assert.match(lote.entrada, /^\[ÁUDIO TRANSCRITO\][^\n]*\nesqueci de dizer/); // mesmo lote, audio primeiro
  });

  await t.test('texto seguido de audio no mesmo lote: tenta voz', () => {
    assert.deepEqual(para(ligado.eventos, C).map(e => e.t), ['meta_audio', 'meta_texto']);
  });

  await t.test('imagem, advogado e falha de transcricao: sempre texto', () => {
    for (const fone of [D, ADVOGADO, E]) {
      const ev = para(ligado.eventos, fone);
      assert.ok(ev.length >= 1, `sem resposta para ${fone}`);
      assert.ok(ev.every(e => e.t === 'meta_texto'), `voz indevida para ${fone}`);
    }
    assert.match(para(ligado.eventos, E)[0].body, /Não consegui ouvir|não chegou bem/);
    assert.ok(para(ligado.eventos, ADVOGADO).some(e => e.body.includes('https://exemplo.com')));
  });

  await t.test('resposta acima de 600 caracteres: texto, sem chamar a ElevenLabs', () => {
    const ev = para(ligado.eventos, F);
    assert.ok(ev.length >= 1 && ev.every(e => e.t === 'meta_texto'));
  });

  await t.test('ElevenLabs so e chamada nos dois casos de voz', () => {
    assert.equal(ligado.eventos.filter(e => e.t === 'elevenlabs').length, 2);
    assert.equal(ligado.eventos.filter(e => e.t === 'meta_audio').length, 2);
  });

  await t.test('flag desligada: baloes de texto e zero chamada a ElevenLabs', () => {
    assert.equal(desligado.eventos.filter(e => e.t === 'elevenlabs').length, 0);
    const ev = para(desligado.eventos, A);
    assert.deepEqual(ev.map(e => e.body), ['Ouvi aqui, obrigada por explicar.', 'A consulta custa R$ 250,00 e o telefone do escritório é +55 (44)99977-8551.']);
  });

  await t.test('erro da ElevenLabs: o cliente recebe a resposta completa em texto', () => {
    assert.equal(erroEleven.eventos.filter(e => e.t === 'elevenlabs').length, 1);
    assert.equal(erroEleven.eventos.filter(e => e.t === 'meta_audio').length, 0);
    assert.deepEqual(para(erroEleven.eventos, A).map(e => e.body), ['Ouvi aqui, obrigada por explicar.', 'A consulta custa R$ 250,00 e o telefone do escritório é +55 (44)99977-8551.']);
    assert.match(erroEleven.saida, /\[Voz\] Falha no recado de voz .*elevenlabs_limite.*HTTP 401/);
  });

  await t.test('/health mostra a flag e so se a chave esta definida', () => {
    assert.equal(ligado.extra.config.VOICE_REPLIES_ENABLED, true);
    assert.equal(ligado.extra.config.ELEVENLABS_API_KEY, '*** (definido)');
  });

  await t.test('a chave da ElevenLabs nao aparece em nenhum log nem no /health', () => {
    for (const r of [ligado, desligado, erroEleven]) {
      assert.ok(r.saida.length > 0);
      assert.ok(!r.saida.includes(FAKE_KEY));
    }
    assert.ok(!JSON.stringify(ligado.extra).includes(FAKE_KEY));
  });
});
