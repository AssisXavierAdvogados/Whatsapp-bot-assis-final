'use strict';
// Integracao da fase 6: triagem antes do aviso urgente e resumo matinal, com o
// server.js de verdade e os externos mockados (inclusive um Supabase em memoria).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const SENHA = 'senha-de-teste';
const WILLIAN = '5544999784442';
const ALINE = '5544991651532';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function comServidor(porta, envExtra, roteiro) {
  const logFile = path.join(os.tmpdir(), `ana-triagem-teste-${process.pid}-${porta}.jsonl`);
  fs.writeFileSync(logFile, '');
  const proc = spawn(process.execPath, ['-r', path.join(__dirname, 'helpers', 'mock-external.js'), 'server.js'], {
    cwd: RAIZ,
    env: {
      PATH: process.env.PATH, PORT: String(porta), MOCK_LOG: logFile, ADMIN_PASSWORD: SENHA,
      WHATSAPP_TOKEN: 'token-teste-whatsapp', PHONE_NUMBER_ID: '123456', CLAUDE_API_KEY: 'chave-teste-claude', ...envExtra
    }
  });
  let saida = '';
  proc.stdout.on('data', d => { saida += d; });
  proc.stderr.on('data', d => { saida += d; });
  const base = `http://127.0.0.1:${porta}`;
  const lerEventos = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const lerPainel = async () => (await fetch(`${base}/admin/conversations`, { headers: { 'x-token': SENHA } })).json();
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) { await sleep(100); }
    }
    const texto = (from, body) => fetch(`${base}/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, id: `in-${from}-${Math.random()}`, type: 'text', text: { body } }] } }] }] })
    });
    const extra = await roteiro({ texto, lerPainel, lerEventos });
    return { painel: await lerPainel(), eventos: lerEventos(), saida, extra };
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(logFile, { force: true });
  }
}

const RODADA = 5000;
const paraEquipe = (eventos, re) => eventos.filter(e => e.t === 'meta_texto' && (e.to === WILLIAN || e.to === ALINE) && re.test(e.body || ''));
const sistema = (lista, entrada) => lista.find(e => e.t === 'claude_sistema' && e.entrada === entrada);

// Linhas ja gravadas no "Supabase" quando o servidor sobe (para o resumo matinal)
const agora = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const SEED = [
  { phone: '5544900000201', messages: [{ role: 'user', content: 'acabaram de prender meu filho em Curitiba', ts: iso(agora - 6 * 3600e3) }], updated_at: iso(agora - 6 * 3600e3), handled: false,
    meta: { nome: 'Carla', origem: 'INSTA', urgenciaTriagem: { status: 'fora_regiao', tipo: 'prisao', respostas: { atual: true, cidade: 'Curitiba', naRegiao: false, vinculo: 'filho', contratar: true }, trecho: 'acabaram de prender meu filho em Curitiba', abertaEm: iso(agora - 6 * 3600e3), atualizadoEm: iso(agora - 6 * 3600e3) } } },
  { phone: '5544900000202', messages: [{ role: 'user', content: 'x', ts: iso(agora - 5 * 3600e3) }], updated_at: iso(agora - 5 * 3600e3), handled: false,
    meta: { urgenciaTriagem: { status: 'alerta_enviado', tipo: 'prisao', respostas: {}, trecho: 'ja teve aviso imediato', abertaEm: iso(agora - 5 * 3600e3), atualizadoEm: iso(agora - 5 * 3600e3) } } },
  { phone: '5544900000203', messages: [{ role: 'user', content: 'tem um oficial na porta', ts: iso(agora - 4 * 3600e3) }], updated_at: iso(agora - 4 * 3600e3), handled: false,
    meta: { urgenciaTriagem: { status: 'em_triagem', tipo: 'busca_apreensao', pergunta: 'cidade', respostas: { oficialNoLocal: true }, trecho: 'tem um oficial na porta', abertaEm: iso(agora - 4 * 3600e3), atualizadoEm: iso(agora - 4 * 3600e3) } } }
];
const SUPABASE = { SUPABASE_URL: 'https://mock.supabase.local', SUPABASE_KEY: 'chave-teste-supabase', MOCK_SUPABASE_SEED: JSON.stringify(SEED) };

test('fase 6: triagem antes do aviso urgente e resumo matinal (servidor)', { timeout: 60000 }, async (t) => {
  const I = '5544900000041', J = '5544900000042', K = '5544900000043', L = '5544900000044', M = '5544900000045';

  const [r, digest, cedo] = await Promise.all([
    comServidor(3981, {}, async (s) => {
      await s.texto(I, 'acabaram de prender meu filho em Curitiba, quero advogado agora');
      await s.texto(J, 'acabaram de prender meu marido');
      await s.texto(K, 'acabaram de prender meu irmão'); // comeca a triagem e some
      await s.texto(L, 'meu filho foi preso em flagrante');
      await sleep(RODADA);
      await s.texto(J, 'só queria saber como funciona, não quero contratar');
      await s.texto(L, 'faz uns 3 dias');
      await sleep(RODADA);
    }),
    // Resumo matinal: a hora minima ja passou (0h) e o "Supabase" tem leads gravados
    comServidor(3982, { ...SUPABASE, URGENCIA_DIGEST_HORA: '0' }, async (s) => {
      await s.texto(M, 'oi');           // o primeiro request depois da hora dispara o resumo
      await sleep(2500);
      const primeiro = s.lerEventos();
      await s.texto(M, 'tudo bem?');    // segundo ciclo no mesmo dia: nao reenvia
      await sleep(RODADA);
      return primeiro;
    }),
    // Antes da hora do resumo (hora minima 24 nunca chega): nada e enviado
    comServidor(3983, { ...SUPABASE, URGENCIA_DIGEST_HORA: '24' }, async (s) => { await s.texto(M, 'oi'); await sleep(RODADA); })
  ]);

  await t.test('nenhum destes casos acorda os advogados', () => {
    assert.equal(paraEquipe(r.eventos, /ALERTA URGENTE/).length, 0);
    for (const fone of [I, J, K, L]) assert.ok(!r.painel[fone].meta.alertaUrgencia, fone);
    for (const fone of [I, J, K, L]) assert.ok(r.eventos.some(e => e.t === 'meta_texto' && e.to === fone), `cliente ${fone} sem resposta`);
  });

  await t.test('fora da regiao: nao avisa na hora, status fora_regiao, fica para o resumo', () => {
    const tri = r.painel[I].meta.urgenciaTriagem;
    assert.equal(tri.status, 'fora_regiao');
    assert.deepEqual(tri.respostas, { atual: true, cidade: 'Curitiba', naRegiao: false, vinculo: 'filho', contratar: true });
    assert.ok(!tri.digestEm); // ainda vai entrar no resumo matinal
    const sis = sistema(r.eventos, 'acabaram de prender meu filho em Curitiba, quero advogado agora');
    assert.equal(sis.urgencia, false);
    assert.match(sis.triagem, /NÃO vai para o aviso imediato porque o caso é fora da região/);
    assert.match(sis.triagem, /NENHUM advogado foi avisado até agora/);
  });

  await t.test('nao quer contratar: status nao_contrata e a Ana nao diz que avisou os advogados', () => {
    assert.equal(r.painel[J].meta.urgenciaTriagem.status, 'nao_contrata');
    const primeira = sistema(r.eventos, 'acabaram de prender meu marido');
    assert.match(primeira.triagem, /Em qual cidade ou delegacia a pessoa está detida\?/);
    const sis = sistema(r.eventos, 'só queria saber como funciona, não quero contratar');
    assert.equal(sis.urgencia, false);
    assert.match(sis.triagem, /não quer contratar um advogado agora/);
    assert.match(sis.triagem, /NENHUM advogado foi avisado até agora/);
  });

  await t.test('cliente comeca a triagem e some: continua em triagem, sem aviso', () => {
    const tri = r.painel[K].meta.urgenciaTriagem;
    assert.equal(tri.status, 'em_triagem');
    assert.equal(tri.pergunta, 'cidade');
    assert.equal(tri.respostas.vinculo, 'irmao');
  });

  await t.test('prisao que nao e de agora: pergunta quando foi e fecha como caso antigo', () => {
    assert.match(sistema(r.eventos, 'meu filho foi preso em flagrante').triagem, /A prisão aconteceu agora, nas últimas 24 horas, ou é um caso mais antigo\?/);
    assert.equal(r.painel[L].meta.urgenciaTriagem.status, 'caso_antigo');
    assert.match(sistema(r.eventos, 'faz uns 3 dias').triagem, /o fato não é das últimas 24 horas/);
  });

  await t.test('painel: /admin/conversations traz o status e as respostas da triagem', () => {
    assert.equal(r.painel[I].meta.urgenciaTriagem.respostas.cidade, 'Curitiba');
    assert.ok(!('urgenciaTriagem' in (r.painel[I].meta.urgenciaTriagem))); // sem aninhamento acidental
  });

  await t.test('resumo matinal: sai para o Dr. Willian e a Dra. Aline, so com quem nao teve aviso imediato', () => {
    for (const adv of [WILLIAN, ALINE]) {
      const enviados = digest.eventos.filter(e => e.t === 'meta_texto' && e.to === adv && /RESUMO MATINAL/.test(e.body || ''));
      assert.equal(enviados.length, 1, `resumos para ${adv}`); // o segundo ciclo do dia nao reenvia
      const corpo = enviados[0].body;
      assert.match(corpo, /^🌅 \*RESUMO MATINAL — urgências em triagem\*\n2 caso\(s\)/);
      assert.match(corpo, /Carla — \+5544900000201\n🏷️ Origem: Instagram \(INSTA\)\n📌 prisão — fora da região/);
      assert.match(corpo, /\+5544900000203\n🏷️ Origem: não informada\n📌 busca e apreensão — incompleto/);
      assert.ok(!corpo.includes('5544900000202')); // esse ja teve alerta_enviado
    }
    assert.equal(paraEquipe(digest.extra, /RESUMO MATINAL/).length, 2); // ja no primeiro request depois da hora
    assert.equal(paraEquipe(digest.eventos, /ALERTA URGENTE/).length, 0);
  });

  await t.test('resumo matinal: dia marcado numa linha interna e cada conversa com digestEm', () => {
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const marcador = digest.eventos.filter(e => e.t === 'supabase_upsert' && e.phone === 'DIGEST#urgencia');
    assert.equal(marcador.length, 1);
    assert.equal(marcador[0].meta.digestYmd, hoje);
    assert.equal(marcador[0].meta.leads, 2);
    const marcados = digest.eventos.filter(e => e.t === 'supabase_patch' && e.meta && e.meta.urgenciaTriagem && e.meta.urgenciaTriagem.digestEm);
    assert.deepEqual(marcados.map(e => e.phone).sort(), ['5544900000201', '5544900000203']);
    assert.equal(marcados.find(e => e.phone === '5544900000203').meta.urgenciaTriagem.status, 'incompleto'); // parou de responder
    assert.equal(marcados.find(e => e.phone === '5544900000201').meta.nome, 'Carla'); // o resto do meta foi preservado
    // a linha interna nao aparece no painel de clientes; os leads aparecem com o status
    assert.ok(!Object.keys(digest.painel).some(p => p.startsWith('DIGEST#')));
    assert.ok(digest.painel['5544900000201'].meta.urgenciaTriagem.digestEm);
    assert.equal(digest.painel['5544900000202'].meta.urgenciaTriagem.status, 'alerta_enviado');
  });

  await t.test('resumo matinal: antes da hora nao envia nada', () => {
    assert.equal(cedo.eventos.filter(e => e.t === 'meta_texto' && /RESUMO MATINAL/.test(e.body || '')).length, 0);
    assert.equal(cedo.eventos.filter(e => e.phone === 'DIGEST#urgencia').length, 0);
    assert.ok(cedo.eventos.some(e => e.t === 'meta_texto' && e.to === M)); // o atendimento segue normal
  });
});
