'use strict';
// Integracao: origem do cliente, urgencia (triagem + aviso imediato) e honorarios, com o
// server.js de verdade e os externos mockados (tests/helpers/mock-external.js).
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
  const logFile = path.join(os.tmpdir(), `ana-origem-teste-${process.pid}-${porta}.jsonl`);
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
    const painel = await lerPainel();
    const html = await (await fetch(`${base}/admin`)).text();
    return { painel, html, eventos: lerEventos(), saida, extra };
  } finally {
    proc.kill('SIGKILL');
    fs.rmSync(logFile, { force: true });
  }
}

const RODADA = 5000; // debounce de 3 s + resposta
const COMPLETA = 'é agora, em Maringá, é do meu marido, e quero contratar agora';
const QUALIFICA = 'acabaram de prender meu marido aqui em Maringá, preciso de um advogado';
const alertas = (eventos, to) => eventos.filter(e => e.t === 'meta_texto' && e.to === to && /ALERTA URGENTE/.test(e.body || ''));

test('origem do cliente, urgencia em curso e honorarios (servidor)', { timeout: 60000 }, async (t) => {
  const A = '5544900000031', B = '5544900000032', C = '5544900000033', D = '5544900000034',
    E = '5544900000035', F = '5544900000036', G = '5544900000037', H = '5544900000038';

  const [r, falha] = await Promise.all([
    comServidor(3971, {}, async (s) => {
      await s.texto(A, 'Olá! (cód. INSTA)');
      await s.texto(B, 'oi');
      await s.texto(C, 'boa tarde, preciso de ajuda com um contrato');
      await s.texto(D, 'tem um oficial na porta, vão levar o carro');
      await s.texto(E, 'fui preso em 2020');
      await s.texto(F, 'Olá! (cód. ADS)');
      await s.texto(G, '[SITE] USAR_FERRAMENTA');
      await s.texto(H, 'PERGUNTA_ORIGEM');
      await sleep(RODADA);
      const meio = { painel: await s.lerPainel(), eventos: s.lerEventos() };
      await s.texto(B, 'vi no Instagram');
      await s.texto(D, COMPLETA);
      await s.texto(F, 'na verdade [SITE]');
      await s.texto(H, 'meu primo');
      await sleep(RODADA);
      meio.painel2 = await s.lerPainel();
      await s.texto(D, 'estão levando o carro agora, o oficial está aqui');
      await sleep(RODADA);
      return meio;
    }),
    // fase 6: so uma mensagem que ja QUALIFICA dispara o aviso (aqui, com o envio falhando)
    comServidor(3972, { MOCK_FALHA_ALERTA: '1' }, async (s) => { await s.texto(D, QUALIFICA); await sleep(RODADA); })
  ]);
  const sistema = (lista, entrada) => lista.find(e => e.t === 'claude_sistema' && e.entrada === entrada);

  await t.test('codigo no link: origem gravada, content intacto e a Ana nao pergunta a origem', () => {
    assert.equal(r.painel[A].meta.origem, 'INSTA');
    assert.ok(r.eventos.some(e => e.t === 'claude' && e.entrada === 'Olá! (cód. INSTA)')); // o Claude recebe o texto original
    const sis = sistema(r.eventos, 'Olá! (cód. INSTA)');
    assert.match(sis.origem, /^ORIGEM DO CLIENTE: Instagram \(INSTA\)\. Não comente o código e não pergunte/);
  });

  await t.test('sem codigo: nada gravado e a Ana e orientada a perguntar uma vez; depois "vi no Instagram" grava INSTA', () => {
    const antes = r.extra.painel[B].meta;
    assert.ok(!antes || !('origem' in antes));
    assert.match(sistema(r.eventos, 'oi').origem, /^ORIGEM AINDA NÃO INFORMADA/);
    assert.equal(r.painel[B].meta.origem, 'INSTA');
  });

  await t.test('conversa so com texto, sem origem: o meta nao ganha o campo', () => {
    const meta = r.painel[C].meta;
    assert.ok(!meta || !('origem' in meta));
    assert.ok(!JSON.stringify(r.painel[C]).includes('undefined'));
  });

  await t.test('origem ja gravada nao e sobrescrita', () => {
    assert.equal(r.extra.painel[F].meta.origem, 'ADS');
    assert.equal(r.painel[F].meta.origem, 'ADS');
  });

  await t.test('a Ana pergunta uma vez (origemPerguntada) e a resposta livre e mapeada', () => {
    assert.equal(r.extra.painel[H].meta.origemPerguntada, true);
    assert.equal(r.painel[H].meta.origem, 'INDICACAO');
    // na segunda rodada o bloco "ainda nao informada" sumiu e entrou o da origem conhecida
    assert.match(sistema(r.eventos, 'meu primo').origem, /^ORIGEM DO CLIENTE: Indicação \(INDICACAO\)/);
  });

  await t.test('encaminhamento formal (notificar_especialista) preserva a origem no meta e a inclui no aviso', () => {
    const meta = r.painel[G].meta;
    assert.equal(meta.origem, 'SITE');
    assert.equal(meta.nome, 'Maria Teste');
    assert.equal(meta.especialista, 'Dra. Aline Xavier');
    assert.ok(meta.notificacao);
    const aviso = r.eventos.find(e => e.t === 'meta_texto' && e.to === ALINE && /NOVO ATENDIMENTO/.test(e.body || ''));
    assert.match(aviso.body, /Origem:\* Site \(SITE\)/);
  });

  // FASE 6: o detector so abre a triagem; o aviso espera a qualificacao.
  await t.test('urgencia em curso: a primeira mensagem abre a triagem e NAO avisa ninguem', () => {
    for (const adv of [WILLIAN, ALINE]) assert.equal(alertas(r.extra.eventos, adv).length, 0, `aviso indevido para ${adv}`);
    const tri = r.extra.painel[D].meta.urgenciaTriagem;
    assert.equal(tri.status, 'em_triagem');
    assert.equal(tri.tipo, 'busca_apreensao');
    assert.equal(tri.pergunta, 'cidade');
    assert.equal(tri.respostas.oficialNoLocal, true);
    assert.ok(!r.extra.painel[D].meta.alertaUrgencia);
    // o prompt pede o que falta e nao diz que os advogados ja foram avisados
    const sis = sistema(r.eventos, 'tem um oficial na porta, vão levar o carro');
    assert.equal(sis.urgencia, false);
    assert.match(sis.triagem, /NENHUM advogado foi avisado até agora/);
    assert.match(sis.triagem, /Em qual cidade isso está acontecendo\?/);
    assert.equal(sis.origem, ''); // em urgencia, nao pergunta a origem
    assert.ok(r.extra.eventos.some(e => e.t === 'meta_texto' && e.to === D)); // o cliente foi respondido
  });

  await t.test('urgencia em curso: depois de qualificar, aviso ao Dr. Willian E a Dra. Aline, uma vez so', () => {
    for (const adv of [WILLIAN, ALINE]) {
      const enviados = alertas(r.eventos, adv).filter(e => e.body.includes(`+${D}`));
      assert.equal(enviados.length, 1, `avisos para ${adv}`); // a mensagem urgente seguinte nao repete
      assert.match(enviados[0].body, /^🚨 \*ALERTA URGENTE\*/);
      assert.match(enviados[0].body, /Resumo: tem um oficial na porta, vão levar o carro/);
      assert.match(enviados[0].body, /cidade: Maringá \(na região\)/);
      assert.match(enviados[0].body, /quer contratar agora: sim/);
      assert.match(enviados[0].body, /Origem: não informada/);
    }
    const meta2 = r.extra.painel2[D].meta;
    assert.equal(meta2.urgenciaTriagem.status, 'alerta_enviado');
    assert.equal(meta2.urgenciaTriagem.respostas.vinculo, 'marido');
    assert.equal(meta2.alertaUrgencia.motivo, 'oficial de justiça na porta');
    assert.equal(meta2.alertaUrgencia.canais.texto, true);
    assert.equal(meta2.alertaUrgencia.para.length, 2);
    assert.equal(r.painel[D].meta.alertaUrgencia.em, meta2.alertaUrgencia.em); // o mesmo aviso, nao um novo
    assert.equal(r.painel[D].meta.urgenciaTriagem.status, 'alerta_enviado');
    // o aviso saiu antes de a Ana responder, e so entao o prompt diz que eles foram avisados
    const sis = sistema(r.eventos, COMPLETA);
    assert.equal(sis.urgencia, true);
    assert.equal(sis.triagem, '');
    const iAlerta = r.eventos.findIndex(e => e.t === 'meta_texto' && e.to === WILLIAN && (e.body || '').includes(`+${D}`));
    assert.ok(iAlerta < r.eventos.indexOf(sis));
  });

  await t.test('historia antiga ("fui preso em 2020") e conversa comum nao geram aviso', () => {
    for (const fone of [A, B, C, E, F, H]) {
      for (const adv of [WILLIAN, ALINE]) assert.equal(alertas(r.eventos, adv).filter(e => e.body.includes(`+${fone}`)).length, 0, fone);
    }
    assert.ok(!r.painel[E].meta || !r.painel[E].meta.alertaUrgencia);
    assert.ok(!r.painel[E].meta || !r.painel[E].meta.urgenciaTriagem); // nem abre triagem
    assert.equal(sistema(r.eventos, 'fui preso em 2020').urgencia, false);
    assert.equal(sistema(r.eventos, 'fui preso em 2020').triagem, '');
  });

  await t.test('se o envio do aviso falhar, a Ana responde ao cliente mesmo assim', () => {
    assert.equal(falha.eventos.filter(e => e.t === 'meta_falha_alerta').length, 2); // tentou os dois
    assert.equal(alertas(falha.eventos, WILLIAN).length + alertas(falha.eventos, ALINE).length, 0);
    assert.ok(falha.eventos.some(e => e.t === 'meta_texto' && e.to === D), 'cliente sem resposta');
    assert.match(falha.saida, /\[Urgencia\] NENHUMA via confirmou o aviso imediato/);
    assert.equal(falha.painel[D].meta.alertaUrgencia.canais.texto, false);
    // fase 6: sem confirmacao de nenhum canal, a Ana nao diz que os advogados foram avisados
    assert.equal(falha.painel[D].meta.urgenciaTriagem.status, 'alerta_falhou');
    const sis = sistema(falha.eventos, QUALIFICA);
    assert.equal(sis.urgencia, false);
    assert.match(sis.triagem, /aviso automático aos advogados NÃO foi confirmado/);
  });

  await t.test('honorarios: o prompt enviado ao Claude so cita "30%" e "nada adiantado" como proibidos', () => {
    const h = sistema(r.eventos, 'oi').honorarios;
    assert.match(h, /honorários dependem da análise do caso; o especialista informa o valor após a consulta/);
    assert.match(h, /Provimento 205\/2021 da OAB, art\. 3º, I/);
    assert.ok(!/informe que o contrato é de 30%/.test(h));
    const linhas = h.split('\n').filter(l => /30%|nada adiantado/.test(l));
    assert.equal(linhas.length, 1);
    assert.match(linhas[0], /^- É PROIBIDO dizer/);
  });

  await t.test('painel: etiqueta de origem, origem na barra da conversa, busca e contagem', () => {
    assert.ok(r.html.includes('bdg origem'));
    assert.ok(r.html.includes('"INSTA":"Instagram"'));
    assert.ok(r.html.includes('id="origens"'));
    assert.ok(r.html.includes('Sem origem'));
    const script = r.html.slice(r.html.indexOf('<script>') + 8, r.html.indexOf('</script>'));
    assert.doesNotThrow(() => new Function(script));
    // executa a contagem e o rotulo do proprio painel com as conversas devolvidas pelo servidor
    const trecho = script.slice(script.indexOf('const ORIGENS='), script.indexOf('async function auth('));
    const alvo = { textContent: '' };
    const { origemLbl, origemCounts } = new Function('convs', 'document', `${trecho}; return { origemLbl, origemCounts };`)(r.painel, { getElementById: () => alvo });
    assert.equal(origemLbl(r.painel[A]), 'Instagram');
    assert.equal(origemLbl(r.painel[C]), '');
    origemCounts();
    assert.equal(alvo.textContent, 'Anúncio 1 · Google 0 · Instagram 2 · Site 1 · Indicação 1 · Sem origem 3');
    // fase 6: etiqueta com o status da triagem de urgencia
    assert.ok(r.html.includes('bdg urg'));
    const trechoUrg = script.slice(script.indexOf('const URG_STATUS='), script.indexOf('async function auth('));
    const { urgLbl, urgInfo } = new Function(`${trechoUrg}; return { urgLbl, urgInfo };`)();
    assert.equal(urgLbl(r.extra.painel[D]), 'urgência: em triagem');
    assert.equal(urgLbl(r.painel[D]), 'alerta enviado');
    assert.equal(urgInfo(r.painel[D]), 'alerta enviado · cidade: Maringá · vínculo: marido · contratar: sim');
    assert.equal(urgLbl(r.painel[C]), '');
    assert.ok(script.includes('esc(urgLbl(c))') && script.includes('esc(urgInfo(c))'));
    assert.ok(script.includes("esc(origemLbl(c))"));
  });
});
