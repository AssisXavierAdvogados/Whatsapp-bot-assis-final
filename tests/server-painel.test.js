'use strict';
// Integracao: sobe o server.js de verdade (externos mockados) e le o painel
// por GET /admin/conversations, para conferir o que fica marcado como audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const voice = require('../voice');

const RAIZ = path.join(__dirname, '..');
const SENHA = 'senha-de-teste';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function comServidor(porta, envExtra, roteiro) {
  const logFile = path.join(os.tmpdir(), `ana-painel-teste-${process.pid}-${porta}.jsonl`);
  fs.writeFileSync(logFile, '');
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'mock-external.js'), 'server.js'], {
    cwd: RAIZ,
    env: {
      PATH: process.env.PATH, PORT: String(porta), MOCK_LOG: logFile, ADMIN_PASSWORD: SENHA,
      WHATSAPP_TOKEN: 'token-teste-whatsapp', PHONE_NUMBER_ID: '123456', CLAUDE_API_KEY: 'chave-teste-claude',
      TRANSCRIBE_API_KEY: 'chave-teste-groq', ELEVENLABS_API_KEY: 'sk_teste_elevenlabs', ...envExtra
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
    const api = {
      texto: (from, body) => enviar(from, { type: 'text', text: { body } }),
      audio: (from) => enviar(from, { type: 'audio', audio: { id: 'aud-ok', mime_type: 'audio/ogg' } }),
      imagem: (from) => enviar(from, { type: 'image', image: { id: 'img-1', mime_type: 'image/jpeg' } })
    };
    await roteiro(api);
    const painel = await (await fetch(`${base}/admin/conversations`, { headers: { 'x-token': SENHA } })).json();
    const semSenha = (await fetch(`${base}/admin/conversations`)).status;
    const html = await (await fetch(`${base}/admin`)).text();
    const eventos = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    return { painel, semSenha, html, eventos, saida };
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(logFile, { force: true });
  }
}

const ESPERA = 9000;
const DADOS = 'Valor: R$ 250,00\nTelefone: +55 (44)99977-8551';
const TRANSCRICAO = 'levaram meu carro hoje cedo';

test('painel: o que foi dito em audio', { skip: !voice.ffmpegAvailable() && 'ffmpeg-static nao instalado', timeout: 60000 }, async (t) => {
  const A = '5544900000021', B = '5544900000022', C = '5544900000023', D = '5544900000024', E = '5544900000025';

  const [ligado, desligado] = await Promise.all([
    comServidor(3961, { VOICE_REPLIES_ENABLED: 'true' }, async (s) => {
      await s.audio(A);                                                          // so audio
      await s.audio(B); await sleep(1200); await s.texto(B, 'foi o banco');      // audio, depois texto
      await s.texto(C, 'boa tarde, preciso de ajuda');                           // so texto
      await s.texto(D, 'FALHA_CLAUDE'); await sleep(1200); await s.audio(D);     // voz sai, mas nao ha resposta no historico para marcar
      await s.audio(E); await sleep(1200); await s.imagem(E);                    // audio pendente + imagem (ramo de documento)
      await sleep(ESPERA);
    }),
    comServidor(3962, {}, async (s) => { await s.audio(A); await sleep(ESPERA - 2000); })
  ]);

  await t.test('so audio (voz ligada): parts do cliente sem marcador; resposta com voice e dataText', () => {
    const [cliente, ana] = ligado.painel[A].messages;
    assert.deepEqual(cliente.parts, [{ audio: true, text: TRANSCRICAO }]);
    assert.equal(cliente.text, `[ÁUDIO TRANSCRITO] ${TRANSCRICAO}`); // text continua cru
    assert.equal(ana.role, 'assistant');
    assert.equal(ana.voice, true);
    assert.equal(ana.dataText, DADOS);
    assert.equal(ana.text, 'Ouvi aqui, obrigada por explicar.\n\nA consulta custa R$ 250,00 e o telefone do escritório é +55 (44)99977-8551.'); // texto da resposta, nao o normalizado
    assert.equal(ligado.painel[A].messages.length, 2); // nada duplicado
  });

  await t.test('audio seguido de texto no mesmo lote: dois trechos, resposta em texto sem voice', () => {
    const [cliente, ana] = ligado.painel[B].messages;
    assert.deepEqual(cliente.parts, [{ audio: true, text: TRANSCRICAO }, { audio: false, text: 'foi o banco' }]);
    assert.deepEqual(Object.keys(ana).sort(), ['role', 'text', 'ts']);
    assert.ok(ligado.eventos.filter(e => e.to === B).every(e => e.t === 'meta_texto'));
  });

  await t.test('conversa so com texto: nenhum campo novo', () => {
    for (const m of ligado.painel[C].messages) assert.deepEqual(Object.keys(m).sort(), ['role', 'text', 'ts']);
  });

  await t.test('marcacao falha (resposta nao esta no historico): audio e texto de dados saem mesmo assim', () => {
    const ev = ligado.eventos.filter(e => e.to === D);
    assert.deepEqual(ev.map(e => e.t), ['meta_audio', 'meta_texto']);
    assert.equal(ev[1].body, 'Telefone: +55 (44)99977-8551');
    assert.match(ligado.saida, new RegExp(`\\[Painel\\] Recado de voz para ${D} enviado, mas nao achei a resposta`));
    assert.ok(ligado.painel[D].messages.every(m => !m.voice));
    assert.deepEqual(ligado.painel[D].messages[0].parts, [{ audio: false, text: 'FALHA_CLAUDE' }, { audio: true, text: TRANSCRICAO }]);
  });

  await t.test('audio pendente quando chega uma imagem: o trecho de audio tambem fica marcado', () => {
    assert.deepEqual(ligado.painel[E].messages[0].parts, [{ audio: true, text: TRANSCRICAO }]);
    assert.ok(ligado.painel[E].messages.every(m => !m.voice)); // documento/imagem responde em texto
  });

  await t.test('voz desligada: parts do cliente gravados, resposta sem voice', () => {
    const [cliente, ana] = desligado.painel[A].messages;
    assert.deepEqual(cliente.parts, [{ audio: true, text: TRANSCRICAO }]);
    assert.deepEqual(Object.keys(ana).sort(), ['role', 'text', 'ts']);
    assert.equal(desligado.eventos.filter(e => e.t === 'elevenlabs').length, 0);
  });

  await t.test('o Claude continua recebendo o marcador no content e nenhum campo extra', () => {
    for (const r of [ligado, desligado]) {
      const chamadas = r.eventos.filter(e => e.t === 'claude' && e.cliente);
      assert.ok(chamadas.length >= 1);
      for (const c of chamadas) assert.deepEqual(c.campos, ['content', 'role']);
    }
    assert.ok(ligado.eventos.some(e => e.t === 'claude' && e.entrada === `[ÁUDIO TRANSCRITO] ${TRANSCRICAO}`));
    assert.ok(ligado.eventos.some(e => e.t === 'claude' && e.entrada === `[ÁUDIO TRANSCRITO] ${TRANSCRICAO}\nfoi o banco`));
  });

  await t.test('nenhum trecho do painel traz o marcador', () => {
    for (const r of [ligado, desligado]) {
      for (const conv of Object.values(r.painel)) {
        for (const m of conv.messages) for (const p of m.parts || []) assert.ok(!/TRANSCRITO/i.test(p.text));
      }
    }
  });

  await t.test('autenticacao do painel nao mudou', () => {
    assert.equal(ligado.semSenha, 401);
  });

  await t.test('HTML do painel: etiquetas de audio, sem o marcador e sem player', () => {
    assert.ok(ligado.html.includes('áudio do cliente (transcrito)'));
    assert.ok(ligado.html.includes('Ana respondeu em áudio'));
    assert.ok(ligado.html.includes('Enviado por escrito'));
    assert.ok(!/UDIO TRANSCRITO/i.test(ligado.html));
    assert.ok(!/<audio/i.test(ligado.html));
    // o script do painel precisa ser JavaScript valido depois de sair do template literal
    const script = ligado.html.slice(ligado.html.indexOf('<script>') + 8, ligado.html.indexOf('</script>'));
    assert.doesNotThrow(() => new Function(script));
    assert.ok(script.includes('esc(p.text)') && script.includes('esc(m.dataText)'));
  });
});
