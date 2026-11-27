'use strict';
// Testes do recado de voz. Sem credenciais reais e sem rede: fetch, ffmpeg e
// Supabase sao substituidos por mocks.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const voice = require('../voice');

const FAKE_KEY = 'sk_teste_CHAVE_SECRETA_ELEVENLABS_123456';
const FAKE_TOKEN = 'EAAG_token_whatsapp_secreto_987654';
const CLIENTE = '5544900000001';

// ---------- funcoes puras ----------

test('numeros, valores, datas e horas por extenso', () => {
  assert.equal(voice.numeroPorExtenso(1250), 'mil duzentos e cinquenta');
  assert.equal(voice.numeroPorExtenso(1200), 'mil e duzentos');
  assert.equal(voice.numeroPorExtenso(2026), 'dois mil e vinte e seis');
  assert.equal(voice.numeroPorExtenso(100), 'cem');
  assert.equal(voice.numeroPorExtenso(101), 'cento e um');
  assert.equal(voice.numeroPorExtenso(2, { feminino: true }), 'duas');
  assert.equal(voice.valorPorExtenso(1250, 0), 'mil duzentos e cinquenta reais');
  assert.equal(voice.valorPorExtenso(250, 50), 'duzentos e cinquenta reais e cinquenta centavos');
  assert.equal(voice.valorPorExtenso(1, 0), 'um real');
  assert.equal(voice.valorPorExtenso(2000000, 0), 'dois milhões de reais');
  assert.equal(voice.dataPorExtenso(26, 11, 2026), 'vinte e seis de novembro de dois mil e vinte e seis');
  assert.equal(voice.dataPorExtenso(1, 3), 'primeiro de março');
  assert.equal(voice.horaPorExtenso(14, 0), 'quatorze horas');
  assert.equal(voice.horaPorExtenso(14, 30), 'quatorze e trinta');
});

test('normalizacao de siglas juridicas', () => {
  const n = voice.normalizeForSpeech;
  assert.equal(n('Inscrita na OAB/PR.'), 'Inscrita na ó-á-bê do Paraná.');
  assert.equal(n('oab-sp'), 'ó-á-bê de São Paulo.');
  assert.equal(n('A OAB orienta.'), 'A ó-á-bê orienta.');
  assert.equal(n('O processo está no TJPR.'), 'O processo está no Tribunal de Justiça do Paraná.');
  assert.equal(n('TJSP'), 'Tribunal de Justiça de São Paulo.');
  assert.equal(n('TJXX'), 'Tribunal de Justiça xis-xis.');
  assert.equal(n('Recurso no TRF4.'), 'Recurso no Tribunal Regional Federal da quarta Região.');
  assert.equal(n('TRF1'), 'Tribunal Regional Federal da primeira Região.');
  assert.equal(n('Está no PJe.'), 'Está no pê-jê-ê.');
  assert.equal(n('Consulte o PJE.'), 'Consulte o pê-jê-ê.');
  assert.equal(n('O Dr. Willian e a Dra. Aline.'), 'O doutor Willian e a doutora Aline.');
});

test('normalizacao de valores, datas, horas e numeros', () => {
  const n = voice.normalizeForSpeech;
  assert.equal(n('Custa R$ 250,00.'), 'Custa duzentos e cinquenta reais.');
  assert.equal(n('R$ 1.250,00'), 'mil duzentos e cinquenta reais.');
  assert.equal(n('R$250,00'), 'duzentos e cinquenta reais.');
  assert.equal(n('R$ 250,50'), 'duzentos e cinquenta reais e cinquenta centavos.');
  assert.equal(n('Em 26/11/2026.'), 'Em vinte e seis de novembro de dois mil e vinte e seis.');
  assert.equal(n('Às 14h ou 14:00.'), 'Às quatorze horas ou quatorze horas.');
  assert.equal(n('Em 2 dias ou 2 semanas.'), 'Em dois dias ou duas semanas.');
  assert.equal(n('São 30% do valor.'), 'São trinta por cento do valor.');
  assert.equal(n('Ligue 190.'), 'Ligue cento e noventa.');
});

test('normalizacao junta os baloes num texto so e tira formatacao', () => {
  assert.equal(voice.normalizeForSpeech('Oi! *Tudo* bem?\n\nSegundo bloco\n\nTerceiro.'), 'Oi! Tudo bem? Segundo bloco. Terceiro.');
});

test('extracao: processo, telefone, valor e link vao para a mensagem de texto', () => {
  const e = voice.extractCopyData(
    'O processo nº 0001234-56.2024.8.16.0017 está no TJPR. A consulta custa R$ 250,00. ' +
    'Ligue no +55 (44)99977-8551 ou veja em https://projudi.tjpr.jus.br/projudi.'
  );
  const porTipo = Object.fromEntries(e.items.map(i => [i.tipo, i.valor]));
  assert.equal(porTipo.processo, '0001234-56.2024.8.16.0017');
  assert.equal(porTipo.telefone, '+55 (44)99977-8551');
  assert.equal(porTipo.valor, 'R$ 250,00');
  assert.equal(porTipo.link, 'https://projudi.tjpr.jus.br/projudi');
  assert.equal(e.dataText, [
    'Processo: 0001234-56.2024.8.16.0017',
    'Valor: R$ 250,00',
    'Telefone: +55 (44)99977-8551',
    'Link: https://projudi.tjpr.jus.br/projudi'
  ].join('\n'));
  assert.equal(e.residual, false);
  for (const cru of ['0001234', '99977', 'R$', 'https']) assert.ok(!e.spoken.includes(cru), `"${cru}" nao pode ser falado`);
  assert.match(e.spoken, /que te mando por escrito/);
});

test('extracao: CPF, CNPJ, CEP, endereco, e-mail e datas', () => {
  const e = voice.extractCopyData(
    'O escritório fica na Av. Dr. Luiz Teixeira Mendes, 1000 - Zona 05, Maringá - PR, CEP 87015-000. ' +
    'Mande o CPF 123.456.789-00 e o CNPJ 12.345.678/0001-90 para contato@exemplo.com.br. O prazo vence em 30/11/2026.'
  );
  const tipos = e.items.map(i => i.tipo);
  for (const t of ['endereco', 'cpf', 'cnpj', 'email', 'data']) assert.ok(tipos.includes(t), `faltou ${t}`);
  assert.ok(e.items.find(i => i.tipo === 'endereco').valor.includes('87015-000'));
  assert.equal(e.items.find(i => i.tipo === 'data').rotulo, 'Prazo');
  assert.equal(e.residual, false);
  assert.ok(!/\d{3}/.test(e.spoken));
});

test('sem dado copiavel nao ha mensagem de texto', () => {
  const p = voice.buildVoicePlan('Ouvi aqui, obrigada por explicar.\n\nVou avisar o Dr. Willian agora mesmo.');
  assert.equal(p.ok, true);
  assert.equal(p.dataText, null);
  assert.equal(p.spoken, 'Ouvi aqui, obrigada por explicar. Vou avisar o doutor Willian agora mesmo.');
});

test('plano de voz: valor e telefone saem do audio e vao por escrito', () => {
  const p = voice.buildVoicePlan('Oi, João! A consulta inicial custa R$ 250,00.\n\nSe preferir ligar, o telefone do escritório é +55 (44)99977-8551.');
  assert.equal(p.ok, true);
  assert.equal(p.spoken, 'Oi, João! A consulta inicial custa o valor que te mando por escrito. Se preferir ligar, o telefone do escritório é o que te mando por escrito.');
  assert.equal(p.dataText, 'Valor: R$ 250,00\nTelefone: +55 (44)99977-8551');
  assert.ok(!/\d/.test(p.spoken));
});

test('dado cru que a extracao nao reconhece impede a sintese', () => {
  assert.deepEqual(voice.buildVoicePlan('Seu protocolo é 123456789.'), { ok: false, reason: 'dado_cru_no_texto_falado' });
  assert.equal(voice.buildVoicePlan('A proporção é 2/3 do salário.').ok, false);
});

test('texto falado acima do limite nao e sintetizado', () => {
  const longo = 'Esta frase se repete para passar do limite. '.repeat(20);
  const p = voice.buildVoicePlan(longo, { maxChars: 600 });
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'texto_longo');
});

test('marcador de audio com e sem acento', () => {
  assert.equal(voice.isAudioTranscript('[ÁUDIO TRANSCRITO] oi'), true);
  assert.equal(voice.isAudioTranscript('[AUDIO TRANSCRITO] oi'), true);
  assert.equal(voice.isAudioTranscript('  [áudio transcrito] oi'), true);
  assert.equal(voice.isAudioTranscript('oi, mandei um [ÁUDIO TRANSCRITO]'), false);
  assert.equal(voice.isAudioTranscript('oi'), false);
  assert.equal(voice.isAudioTranscript(undefined), false);
});

test('configuracao: flag desligada por padrao e defaults', () => {
  const c = voice.loadVoiceConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.voiceId, 'n2a9VtkZLl8j1FSXHsL7');
  assert.equal(c.model, 'eleven_multilingual_v2');
  assert.deepEqual([c.maxChars, c.clientDailyLimit, c.dailyCharLimit], [600, 6, 2500]);
  for (const v of ['true', 'TRUE', '1', 'yes', ' Yes ']) assert.equal(voice.loadVoiceConfig({ VOICE_REPLIES_ENABLED: v }).enabled, true, v);
  for (const v of ['false', '0', 'no', 'on', 'sim', '']) assert.equal(voice.loadVoiceConfig({ VOICE_REPLIES_ENABLED: v }).enabled, false, v);
  assert.equal(voice.loadVoiceConfig({ VOICE_DAILY_CHAR_LIMIT: '900', VOICE_MAX_CHARS: 'abc' }).dailyCharLimit, 900);
  assert.equal(voice.loadVoiceConfig({ VOICE_MAX_CHARS: 'abc' }).maxChars, 600);
});

test('o dia do teto vira a meia-noite de Brasilia, nao em UTC', () => {
  assert.equal(voice.diaBrasilia(new Date('2026-11-27T02:30:00Z')), '2026-11-26'); // 23h30 em Brasilia
  assert.equal(voice.diaBrasilia(new Date('2026-11-27T03:00:00Z')), '2026-11-27'); // meia-noite em Brasilia
});

// ---------- servico (com mocks) ----------

function harness(opts = {}) {
  const calls = { eleven: [], upload: [], send: [], spawn: [] };
  const logs = [];
  const log = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push(a.join(' ')),
    error: (...a) => logs.push(a.join(' '))
  };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('api.elevenlabs.io')) {
      calls.eleven.push({ url: u, headers: init.headers, body: JSON.parse(init.body) });
      if (opts.eleven) return opts.eleven(init);
      return new Response(Buffer.from('mp3-falso'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    if (u.endsWith('/media')) {
      calls.upload.push({ url: u, type: init.body.get('type'), product: init.body.get('messaging_product'), fileType: init.body.get('file').type });
      if (opts.upload) return opts.upload(init);
      return json(200, { id: 'MEDIA123' });
    }
    if (u.endsWith('/messages')) {
      calls.send.push({ url: u, body: JSON.parse(init.body) });
      if (opts.send) return opts.send(init);
      return json(200, { messages: [{ id: 'wamid.AUDIO' }] });
    }
    throw new Error(`chamada de rede inesperada no teste: ${u}`);
  };
  // ffmpeg de mentira: grava o arquivo de saida e termina com o codigo pedido
  const spawn = (cmd, args) => {
    calls.spawn.push({ cmd, args });
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    setImmediate(() => {
      const code = opts.ffmpegExit || 0;
      if (code === 0) fs.writeFileSync(args[args.length - 1], Buffer.alloc(opts.oggBytes || 2048, 1));
      else proc.stderr.emit('data', 'Invalid data found when processing input');
      proc.emit('close', code);
    });
    return proc;
  };
  const saved = [];
  const store = opts.store === null ? null : (opts.store || {
    load: async () => (opts.stored ? JSON.parse(JSON.stringify(opts.stored)) : null),
    save: async (meta) => { saved.push(JSON.parse(JSON.stringify(meta))); }
  });
  let agora = opts.now || new Date('2026-11-27T15:00:00Z');
  const service = voice.createVoiceService({
    env: { VOICE_REPLIES_ENABLED: 'true', ELEVENLABS_API_KEY: FAKE_KEY, ...(opts.env || {}) },
    whatsapp: { token: FAKE_TOKEN, phoneNumberId: '123456', graphVersion: 'v19.0' },
    fetchFn, spawn, store, log,
    ffmpegPath: opts.ffmpegPath === undefined ? process.execPath : opts.ffmpegPath, // qualquer executavel existente
    now: () => agora
  });
  return { service, calls, logs, saved, setNow: (d) => { agora = d; } };
}

const RESPOSTA = 'Ouvi aqui, obrigada por explicar.\n\nA consulta custa R$ 250,00 e o Dr. Willian retorna ainda hoje.';

test('caminho feliz: sintetiza, converte, envia como recado de voz e conta o uso', async () => {
  const h = harness();
  const r = await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
  assert.equal(r.sent, true);
  assert.equal(r.dataText, 'Valor: R$ 250,00');

  assert.equal(h.calls.eleven.length, 1);
  const el = h.calls.eleven[0];
  assert.ok(el.url.endsWith('/v1/text-to-speech/n2a9VtkZLl8j1FSXHsL7'));
  assert.equal(el.headers['xi-api-key'], FAKE_KEY);
  assert.equal(el.headers.Accept, 'audio/mpeg');
  assert.equal(el.body.model_id, 'eleven_multilingual_v2');
  assert.equal(el.body.text, 'Ouvi aqui, obrigada por explicar. A consulta custa o valor que te mando por escrito e o doutor Willian retorna ainda hoje.');

  const args = h.calls.spawn[0].args.join(' ');
  for (const trecho of ['-ac 1', '-ar 48000', '-c:a libopus', '-application voip']) assert.ok(args.includes(trecho), trecho);

  assert.deepEqual(h.calls.upload[0], { url: 'https://graph.facebook.com/v19.0/123456/media', type: 'audio/ogg', product: 'whatsapp', fileType: 'audio/ogg' });
  assert.deepEqual(h.calls.send[0].body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: CLIENTE, type: 'audio', audio: { id: 'MEDIA123', voice: true }
  });

  // contador usa o texto normalizado e fica gravado com o dia de Brasilia
  assert.deepEqual(h.saved.at(-1), { day: '2026-11-27', chars: el.body.text.length, byClient: { [CLIENTE]: { chars: el.body.text.length, count: 1 } } });
});

test('arquivos temporarios do ffmpeg sao apagados (sucesso e erro)', async () => {
  for (const ffmpegExit of [0, 1]) {
    const h = harness({ ffmpegExit });
    await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
    const args = h.calls.spawn[0].args;
    const entrada = args[args.indexOf('-i') + 1];
    const saida = args[args.length - 1];
    assert.equal(fs.existsSync(entrada), false);
    assert.equal(fs.existsSync(saida), false);
  }
});

test('flag desligada: nenhuma chamada a ElevenLabs', async () => {
  for (const flag of ['false', '', 'on']) {
    const h = harness({ env: { VOICE_REPLIES_ENABLED: flag } });
    assert.deepEqual(await h.service.tryVoiceReply(CLIENTE, RESPOSTA), { sent: false, reason: 'flag_desligada' });
    assert.equal(h.calls.eleven.length, 0);
  }
});

test('sem chave ou sem ffmpeg: texto, sem chamar a ElevenLabs', async () => {
  const semChave = harness({ env: { ELEVENLABS_API_KEY: '' } });
  assert.equal((await semChave.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'chave_ausente');
  const semFfmpeg = harness({ ffmpegPath: '/caminho/que/nao/existe/ffmpeg' });
  assert.equal((await semFfmpeg.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'ffmpeg_ausente');
  assert.equal(semChave.calls.eleven.length + semFfmpeg.calls.eleven.length, 0);
});

test('texto falado acima de VOICE_MAX_CHARS: texto, sem chamar a ElevenLabs', async () => {
  const h = harness();
  const r = await h.service.tryVoiceReply(CLIENTE, 'Esta frase se repete para passar do limite. '.repeat(20));
  assert.deepEqual([r.sent, r.reason], [false, 'texto_longo']);
  assert.equal(h.calls.eleven.length, 0);
});

test('limite diario por cliente: o 7o recado do dia vai em texto', async () => {
  const h = harness({ env: { VOICE_DAILY_CHAR_LIMIT: '100000' } });
  for (let i = 0; i < 6; i++) assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado.')).sent, true);
  assert.deepEqual(await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado.'), { sent: false, reason: 'limite_cliente' });
  assert.equal(h.calls.eleven.length, 6);
  // outro cliente ainda pode
  assert.equal((await h.service.tryVoiceReply('5544900000002', 'Certo, anotado.')).sent, true);
});

test('teto diario global: conta ANTES de chamar a API e nao chama se nao couber', async () => {
  const h = harness({ env: { VOICE_DAILY_CHAR_LIMIT: '40' } });
  assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado. Até mais!')).sent, true); // 25 caracteres
  assert.deepEqual(await h.service.tryVoiceReply('5544900000002', 'Certo, anotado. Até mais!'), { sent: false, reason: 'limite_diario' });
  assert.equal(h.calls.eleven.length, 1);
});

test('contadores vem do Supabase apos restart e zeram quando o dia vira em Brasilia', async () => {
  const stored = { day: '2026-11-27', chars: 2490, byClient: { [CLIENTE]: { chars: 2490, count: 2 } } };
  const h = harness({ stored });
  assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado. Até mais!')).reason, 'limite_diario');
  // 23h50 de Brasilia do mesmo dia (02h50 UTC do dia seguinte): ainda e o mesmo dia
  h.setNow(new Date('2026-11-28T02:50:00Z'));
  assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado. Até mais!')).reason, 'limite_diario');
  // 00h10 de Brasilia: dia novo. A linha gravada e do dia anterior, entao o contador zera.
  h.setNow(new Date('2026-11-28T03:10:00Z'));
  assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado. Até mais!')).sent, true);
  assert.equal(h.saved.at(-1).day, '2026-11-28');
  assert.equal(h.saved.at(-1).chars, 25);
});

test('Supabase fora do ar: segue com a memoria e registra aviso', async () => {
  const h = harness({ store: { load: async () => { throw new Error('ECONNREFUSED'); }, save: async () => { throw new Error('ECONNREFUSED'); } } });
  assert.equal((await h.service.tryVoiceReply(CLIENTE, 'Certo, anotado.')).sent, true);
  assert.ok(h.logs.some(l => /Supabase indisponivel/.test(l)));
  assert.equal((await h.service.usageToday()).byClient[CLIENTE].count, 1);
});

test('erro da ElevenLabs (401, 402, 429, quota, 500): texto, sem descontar credito', async () => {
  const casos = [
    [401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 'elevenlabs_limite'],
    [402, { detail: { status: 'payment_required' } }, 'elevenlabs_limite'],
    [429, { detail: { status: 'too_many_concurrent_requests' } }, 'elevenlabs_limite'],
    [400, { detail: { status: 'quota_exceeded', message: 'You have 0 credits remaining' } }, 'elevenlabs_limite'],
    [500, { detail: 'internal error' }, 'elevenlabs_erro']
  ];
  for (const [status, body, reason] of casos) {
    const h = harness({ eleven: () => new Response(JSON.stringify(body), { status }) });
    const r = await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
    assert.deepEqual([r.sent, r.reason], [false, reason], `HTTP ${status}`);
    assert.equal(h.calls.upload.length, 0);
    assert.equal(h.saved.length, 0, 'nao pode descontar o que nao foi cobrado');
    assert.equal((await h.service.usageToday()).chars, 0);
  }
});

test('chave recusada ou sem credito: nao insiste na ElevenLabs no mesmo dia', async () => {
  const h = harness({ eleven: () => new Response('{"detail":{"status":"quota_exceeded"}}', { status: 401 }) });
  await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
  assert.equal((await h.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'elevenlabs_bloqueada_hoje');
  assert.equal(h.calls.eleven.length, 1);
});

test('timeout ou falha de rede na ElevenLabs: texto', async () => {
  const timeout = harness({ eleven: () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } });
  assert.equal((await timeout.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'elevenlabs_timeout');
  const rede = harness({ eleven: () => { throw new TypeError('fetch failed'); } });
  assert.equal((await rede.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'elevenlabs_rede');
});

test('erro do ffmpeg: texto, e o credito ja cobrado e contado (sem contar recado entregue)', async () => {
  const h = harness({ ffmpegExit: 1 });
  const r = await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
  assert.deepEqual([r.sent, r.reason], [false, 'ffmpeg_erro']);
  assert.equal(h.calls.upload.length, 0);
  const uso = h.saved.at(-1);
  assert.ok(uso.chars > 0);
  assert.equal(uso.byClient[CLIENTE].count, 0);
});

test('audio acima de 512 KB nao e enviado', async () => {
  const h = harness({ oggBytes: 600 * 1024 });
  assert.equal((await h.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'audio_grande');
  assert.equal(h.calls.upload.length, 0);
});

test('erro no upload ou no envio do WhatsApp: texto, com o credito contado', async () => {
  const erroMeta = (code) => () => new Response(JSON.stringify({ error: { message: 'Media upload error', code } }), { status: 400 });
  const up = harness({ upload: erroMeta(131053) });
  assert.equal((await up.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'whatsapp_upload');
  assert.equal(up.calls.send.length, 0);
  assert.ok(up.logs.some(l => l.includes('131053')));
  const env = harness({ send: erroMeta(131047) });
  assert.equal((await env.service.tryVoiceReply(CLIENTE, RESPOSTA)).reason, 'whatsapp_envio');
  for (const h of [up, env]) {
    assert.ok(h.saved.at(-1).chars > 0);
    assert.equal(h.saved.at(-1).byClient[CLIENTE].count, 0);
  }
});

test('a chave da ElevenLabs e o token nunca aparecem nos logs', async () => {
  const cenarios = [
    {},
    { eleven: () => new Response(JSON.stringify({ detail: { message: `Invalid API key: ${FAKE_KEY}` }, headers: { 'xi-api-key': FAKE_KEY } }), { status: 401 }) },
    { eleven: () => { throw new Error(`request to api.elevenlabs.io failed, headers: {"xi-api-key":"${FAKE_KEY}"}`); } },
    { ffmpegExit: 1 },
    { upload: () => new Response(JSON.stringify({ error: { message: `Bad token ${FAKE_TOKEN}`, code: 190 } }), { status: 401 }) },
    { send: () => { throw new Error(`Authorization: Bearer ${FAKE_TOKEN}`); } },
    { store: { load: async () => { throw new Error(`falha ${FAKE_KEY}`); }, save: async () => {} } }
  ];
  for (const c of cenarios) {
    const h = harness(c);
    await h.service.tryVoiceReply(CLIENTE, RESPOSTA);
    const tudo = h.logs.join('\n') + JSON.stringify(h.service.status());
    assert.ok(h.logs.length > 0);
    assert.ok(!tudo.includes(FAKE_KEY), `chave vazou: ${tudo}`);
    assert.ok(!tudo.includes(FAKE_TOKEN), `token vazou: ${tudo}`);
  }
});

test('sanitize redige segredos e encurta a mensagem', () => {
  const s = voice.sanitize(`erro xi-api-key: ${FAKE_KEY}\nAuthorization: Bearer abc.def ${'x'.repeat(500)}`, [FAKE_KEY]);
  assert.ok(!s.includes(FAKE_KEY));
  assert.ok(!s.includes('abc.def'));
  assert.ok(s.length <= 200);
});

test('conversao real com o ffmpeg-static: gera OGG/Opus mono 48 kHz pequeno', { skip: !voice.ffmpegAvailable() && 'ffmpeg-static nao instalado' }, async () => {
  // WAV de 1 segundo de silencio (o ffmpeg detecta o formato pelo conteudo, nao pela extensao)
  const amostras = 8000;
  const wav = Buffer.alloc(44 + amostras * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + amostras * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(amostras * 2, 40);
  const ogg = await voice.convertMp3ToOggOpus(wav);
  assert.equal(ogg.subarray(0, 4).toString('latin1'), 'OggS');
  assert.ok(ogg.includes(Buffer.from('OpusHead')));
  const head = ogg.indexOf(Buffer.from('OpusHead'));
  assert.equal(ogg.readUInt8(head + 9), 1, 'mono');
  assert.equal(ogg.readUInt32LE(head + 12), 48000, 'taxa de entrada 48 kHz');
  assert.ok(ogg.length < 512 * 1024);
});
