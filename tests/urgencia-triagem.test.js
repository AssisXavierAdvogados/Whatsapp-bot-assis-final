'use strict';
// Triagem de urgencia, regiao de atuacao e resumo matinal (funcoes puras, sem rede).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const t = require('../urgencia-triagem');
const o = require('../origem');

const T0 = Date.parse('2026-11-28T03:00:00Z'); // meia-noite em Brasilia

// Roda uma conversa: cada mensagem do cliente passa pelo detector e pela triagem.
function conversa(mensagens, opts = {}) {
  let triagem = null;
  let agoraMs = T0;
  const passos = [];
  for (const m of mensagens) {
    agoraMs += 60000;
    const r = t.processarLote({ triagem, texto: m, deteccao: o.detectUrgenciaEmCurso(m), agoraMs, ...opts });
    triagem = r.triagem;
    passos.push({ status: triagem && triagem.status, pergunta: triagem && triagem.pergunta, alerta: r.enviarAlerta, mudou: r.mudou });
  }
  return { triagem, passos, ultimo: passos[passos.length - 1] };
}

// ---------- detector (continua igual: reconhecer nao e mais o mesmo que avisar) ----------

test('o detector continua reconhecendo o que e de agora e recusando caso antigo', () => {
  for (const s of ['acabaram de prender meu marido', 'está em flagrante', 'tem um oficial na porta', 'estão levando o carro agora', 'mandado sendo cumprido']) {
    assert.equal(o.isUrgenciaEmCurso(s), true, s);
  }
  for (const s of ['fui preso em 2020', 'já cumpriram a busca e apreensão no mês passado', 'tenho uma audiência amanhã', 'estou muito preocupado, preciso de resposta rápido']) {
    assert.equal(o.isUrgenciaEmCurso(s), false, s);
  }
});

// ---------- regiao ----------

test('naRegiao: lista padrao, com e sem acento, dentro de frases', () => {
  for (const s of ['delegacia de Sarandi', 'aqui em Maringá', 'noroeste do Paraná', 'noroeste paranaense', 'região de Maringá', 'perto de Maringá',
    'Sarandi - PR', 'delegacia de Paiçandu', 'PAICANDU', 'mandaguacu', 'Nova Esperança', 'tá preso em paranavai', 'Cianorte/PR']) {
    assert.equal(t.naRegiao(s), true, s);
  }
  for (const s of ['Curitiba', 'São Paulo', 'Rio de Janeiro', 'Florianópolis', 'Londrina', 'não sei', 'não me disseram', '', undefined, 'Sarandizinho']) {
    assert.equal(t.naRegiao(s), false, String(s));
  }
  assert.equal(t.cidadeNaRegiao('está na delegacia de paicandu'), 'Paiçandu');
});

test('naRegiao: URGENCIA_REGIAO substitui os municipios, mas Maringa e as frases de regiao valem sempre', () => {
  const lista = t.listaRegiao({ URGENCIA_REGIAO: ' Londrina, Cambé ,, ' });
  assert.deepEqual(lista, ['Londrina', 'Cambé']);
  assert.equal(t.naRegiao('delegacia de Londrina', lista), true);
  assert.equal(t.naRegiao('cambe', lista), true);
  assert.equal(t.naRegiao('Sarandi', lista), false);
  assert.equal(t.naRegiao('aqui em Maringá', lista), true);
  assert.equal(t.naRegiao('noroeste do Paraná', lista), true);
  assert.deepEqual(t.listaRegiao({}), t.REGIAO_PADRAO);
  assert.deepEqual(t.listaRegiao({ URGENCIA_REGIAO: '  ' }), t.REGIAO_PADRAO);
  assert.equal(t.REGIAO_PADRAO.length, 11);
});

test('reconhece cidade de fora da regiao', () => {
  assert.equal(t.cidadeForaDaRegiao('acabaram de prender meu filho em Curitiba'), 'Curitiba');
  assert.equal(t.cidadeForaDaRegiao('ta preso em sao paulo'), 'São Paulo');
  assert.equal(t.cidadeForaDaRegiao('na delegacia de Jussara'), 'Jussara');
  assert.equal(t.cidadeForaDaRegiao('aqui em Maringá'), null);
  assert.equal(t.cidadeForaDaRegiao('prenderam meu marido'), null);
});

// ---------- extracao ----------

test('extrai da primeira mensagem o que a pessoa ja disse', () => {
  const r = t.extrairRespostas('acabaram de prender meu filho em Sarandi, quero contratar um advogado', { tipo: 'prisao', abertura: true });
  assert.deepEqual(r, { atual: true, cidade: 'Sarandi', naRegiao: true, vinculo: 'filho', contratar: true });
  const b = t.extrairRespostas('tem um oficial na porta, vão levar meu carro', { tipo: 'busca_apreensao', abertura: true });
  assert.deepEqual(b, { oficialNoLocal: true, atual: true, vinculo: 'a própria pessoa' });
  assert.equal(t.tipoDaUrgencia('prisão em flagrante'), 'prisao');
  assert.equal(t.tipoDaUrgencia('oficial de justiça na porta'), 'busca_apreensao');
  assert.equal(t.tipoDaUrgencia('mandado sendo cumprido'), 'busca_apreensao');
});

test('respostas curtas so valem para a pergunta que a Ana acabou de fazer', () => {
  const p = (texto, pergunta, tipo = 'prisao') => t.extrairRespostas(texto, { tipo, perguntaPendente: pergunta });
  assert.equal(p('sim', 'contratar').contratar, true);
  assert.equal(p('agora não', 'contratar').contratar, false);
  assert.equal(p('sim', 'atual').atual, true);
  assert.equal(p('foi ontem à noite', 'atual').atual, true);
  assert.equal(p('faz uns 3 dias', 'atual').atual, false);
  assert.equal(p('é um caso antigo', 'atual').atual, false);
  assert.equal(p('sou a mãe', 'vinculo').vinculo, 'mae');
  assert.equal(p('sou eu mesmo', 'vinculo').vinculo, 'a própria pessoa');
  assert.deepEqual(p('Sarandi', 'cidade'), { cidade: 'Sarandi', naRegiao: true });
  assert.deepEqual(p('em Jussara', 'cidade'), { cidade: 'Jussara', naRegiao: false });
  assert.deepEqual(p('jussara', 'cidade'), { cidade: 'jussara', naRegiao: false }); // minusculas: vale por ser a resposta da pergunta
  assert.deepEqual(p('não sei, não me disseram', 'cidade'), { cidade: 'não soube informar', naRegiao: null });
  assert.equal(p('ainda estão aqui', 'oficialNoLocal', 'busca_apreensao').oficialNoLocal, true);
  assert.equal(p('já foram embora', 'oficialNoLocal', 'busca_apreensao').oficialNoLocal, false);
  // "sim" solto, sem pergunta pendente, nao responde nada
  assert.deepEqual(p('sim', null), {});
  // desabafo nao e cidade
  assert.deepEqual(p('ele tá muito nervoso', 'cidade'), {});
  // "quero advogado agora" fala da contratacao, nao de quando foi o fato
  assert.equal(t.extrairRespostas('meu filho foi preso em flagrante, quero um advogado agora', { abertura: true }).atual, undefined);
  // recusa explicita vale mesmo sem pergunta pendente
  assert.equal(p('só queria saber como funciona, não quero contratar', null).contratar, false);
  assert.equal(p('depois eu vejo', null).contratar, false);
});

// ---------- decisao ----------

test('so qualifica com fato atual + na regiao + quer contratar', () => {
  assert.equal(t.qualifica('prisao', { atual: true, naRegiao: true, contratar: true }), true);
  assert.equal(t.qualifica('prisao', { atual: true, naRegiao: true }), false);
  assert.equal(t.qualifica('prisao', { naRegiao: true, contratar: true }), false);
  assert.equal(t.qualifica('prisao', { atual: true, naRegiao: null, contratar: true }), false); // nao soube a cidade
  assert.equal(t.qualifica('busca_apreensao', { atual: true, naRegiao: true, contratar: true }), false); // falta o oficial no local
  assert.equal(t.qualifica('busca_apreensao', { oficialNoLocal: true, naRegiao: true, contratar: true }), true);
  assert.equal(t.decidirStatus('prisao', { atual: false }), 'caso_antigo');
  assert.equal(t.decidirStatus('prisao', { atual: true, naRegiao: false, contratar: true }), 'fora_regiao');
  assert.equal(t.decidirStatus('prisao', { atual: true, naRegiao: true, contratar: false }), 'nao_contrata');
  assert.equal(t.decidirStatus('busca_apreensao', { oficialNoLocal: false }), 'sem_oficial');
  assert.equal(t.decidirStatus('prisao', { atual: true, naRegiao: null }), 'incompleto');
  assert.equal(t.decidirStatus('prisao', { atual: true }), 'em_triagem');
  assert.equal(t.proximaPergunta('prisao', {}), 'atual');
  assert.equal(t.proximaPergunta('prisao', { atual: true }), 'cidade');
  assert.equal(t.proximaPergunta('prisao', { atual: true, naRegiao: true, cidade: 'Maringá' }), 'vinculo');
  assert.equal(t.proximaPergunta('busca_apreensao', {}), 'oficialNoLocal');
  assert.equal(t.proximaPergunta('prisao', { atual: true, naRegiao: true, vinculo: 'filho', contratar: true }), null);
});

// ---------- conversas ----------

test('"oficial na porta" sozinho abre a triagem e nao pede o aviso', () => {
  const c = conversa(['tem um oficial na porta, vão levar o carro']);
  assert.deepEqual(c.ultimo, { status: 'em_triagem', pergunta: 'cidade', alerta: false, mudou: true }); // "agora" ja ficou claro: pula a 1a pergunta
  assert.equal(c.triagem.tipo, 'busca_apreensao');
  assert.equal(c.triagem.trecho, 'tem um oficial na porta, vão levar o carro');
});

test('uma pergunta de cada vez ate qualificar; so entao pede o aviso', () => {
  const c = conversa(['tem um oficial na porta, vão levar o carro', 'é em Maringá', 'é do meu marido', 'quero contratar agora sim']);
  assert.deepEqual(c.passos.map(p => p.pergunta), ['cidade', 'vinculo', 'contratar', null]);
  assert.deepEqual(c.passos.map(p => p.alerta), [false, false, false, true]);
  assert.deepEqual(c.triagem.respostas, { oficialNoLocal: true, atual: true, cidade: 'Maringá', naRegiao: true, vinculo: 'marido', contratar: true });
  const enviado = t.registrarEnvio(c.triagem, { confirmado: true }, T0);
  assert.equal(enviado.status, 'alerta_enviado');
  assert.equal(t.registrarEnvio(c.triagem, { confirmado: false }, T0).status, 'alerta_falhou');
});

test('prisao: pergunta se foi agora quando a mensagem nao deixa claro', () => {
  const c = conversa(['meu filho foi preso em flagrante', 'foi ontem à noite', 'delegacia de Paiçandu', 'sim']);
  assert.deepEqual(c.passos.map(p => p.pergunta), ['atual', 'cidade', 'contratar', null]); // o vinculo ("meu filho") ja era sabido
  assert.equal(c.ultimo.alerta, true);
});

test('tudo dito de uma vez qualifica na primeira mensagem; nao pergunta o que ja sabe', () => {
  const c = conversa(['acabaram de prender meu marido aqui em Maringá, preciso de um advogado']);
  assert.equal(c.ultimo.alerta, true);
});

test('fora da regiao, caso antigo, nao contrata e oficial ausente nao pedem o aviso', () => {
  const casos = [
    [['acabaram de prender meu filho em Curitiba, quero advogado agora'], 'fora_regiao'],
    [['acabaram de prender meu marido', 'em Jussara'], 'fora_regiao'],
    [['meu filho foi preso em flagrante', 'faz uns 3 dias'], 'caso_antigo'],
    [['acabaram de prender meu marido', 'só queria saber como funciona, não quero contratar'], 'nao_contrata'],
    [['acabaram de prender meu marido', 'Sarandi', 'agora não, depois eu vejo'], 'nao_contrata'],
    [['estão levando meu carro agora', 'já foram embora'], 'sem_oficial'],
    [['acabaram de prender meu marido', 'não sei onde ele está'], 'incompleto']
  ];
  for (const [msgs, status] of casos) {
    const c = conversa(msgs);
    assert.equal(c.triagem.status, status, msgs.join(' / '));
    assert.ok(c.passos.every(p => !p.alerta), msgs.join(' / '));
    assert.equal(c.triagem.pergunta, null);
  }
});

test('cliente some ou nao responde a pergunta: nao insiste e nao pede o aviso', () => {
  const some = conversa(['acabaram de prender meu marido']);
  assert.equal(some.triagem.status, 'em_triagem');
  assert.equal(some.ultimo.alerta, false);
  const enrola = conversa(['acabaram de prender meu marido', 'ele tá muito nervoso', 'ai meu deus', 'socorro']);
  assert.deepEqual(enrola.passos.map(p => p.status), ['em_triagem', 'em_triagem', 'incompleto', 'incompleto']); // pergunta a cidade no maximo 2 vezes
  assert.ok(enrola.passos.every(p => !p.alerta));
});

test('quem volta e completa depois ainda pode qualificar', () => {
  const c = conversa(['acabaram de prender meu marido', 'não sei onde ele está', 'descobri, é em Maringá', 'quero contratar sim']);
  assert.deepEqual(c.passos.map(p => p.status), ['em_triagem', 'incompleto', 'em_triagem', 'em_triagem']);
  assert.equal(c.ultimo.alerta, true);
});

test('"fui preso em 2020" nao abre triagem; conversa comum tambem nao', () => {
  for (const m of ['fui preso em 2020', 'oi', 'tenho uma audiência amanhã']) {
    const c = conversa([m]);
    assert.equal(c.triagem, null);
    assert.equal(c.ultimo.mudou, false);
  }
});

test('com aviso recente (janela de 6h) nada e reprocessado', () => {
  const aberta = conversa(['acabaram de prender meu marido aqui em Maringá, preciso de um advogado']).triagem;
  const enviada = t.registrarEnvio(aberta, { confirmado: true }, T0);
  const r = t.processarLote({ triagem: enviada, texto: 'estão levando ele agora', deteccao: o.detectUrgenciaEmCurso('estão levando ele agora'), alertaRecente: true, agoraMs: T0 + 3600e3 });
  assert.deepEqual([r.mudou, r.enviarAlerta, r.triagem.status], [false, false, 'alerta_enviado']);
  // fora da janela, uma nova deteccao abre outra triagem
  const depois = t.processarLote({ triagem: enviada, texto: 'acabaram de prender meu filho', deteccao: o.detectUrgenciaEmCurso('acabaram de prender meu filho'), alertaRecente: false, agoraMs: T0 + 8 * 3600e3 });
  assert.equal(depois.triagem.status, 'em_triagem');
  assert.equal(depois.triagem.abertaEm, new Date(T0 + 8 * 3600e3).toISOString());
});

test('usa a regiao configurada', () => {
  const regiao = t.listaRegiao({ URGENCIA_REGIAO: 'Londrina' });
  assert.equal(conversa(['acabaram de prender meu marido em Londrina, preciso de um advogado'], { regiao }).ultimo.alerta, true);
  const sarandi = conversa(['acabaram de prender meu marido em Sarandi, preciso de um advogado'], { regiao });
  assert.equal(sarandi.triagem.status, 'fora_regiao'); // Sarandi saiu da lista configurada
  assert.equal(sarandi.ultimo.alerta, false);
});

// ---------- prompt ----------

test('bloco do prompt: em triagem pede so a proxima pergunta e nao diz que avisou', () => {
  const b = t.blocoTriagemPrompt(conversa(['acabaram de prender meu marido']).triagem);
  assert.match(b, /TRIAGEM DE URGÊNCIA \(dados do sistema\)/);
  assert.match(b, /NENHUM advogado foi avisado até agora/);
  assert.match(b, /NÃO chame ferramenta de encaminhamento nesta resposta/);
  assert.match(b, /Em qual cidade ou delegacia a pessoa está detida\?/);
  assert.match(b, /Já sabemos \(não pergunte de novo\): quando: agora \/ últimas 24h; vínculo: marido/);
  assert.match(b, /Uma pergunta por vez/);
  assert.match(b, /190/);
  assert.ok(!/já foram avisados|já receberam/.test(b));
  // a pergunta de contratar fala em atendimento particular e nao cita valor
  const c = t.blocoTriagemPrompt(conversa(['acabaram de prender meu marido', 'Sarandi']).triagem);
  assert.match(c, /Você quer contratar um advogado agora.*atendimento do escritório é particular/);
  assert.ok(!/R\$|\d+ ?%/.test(c));
});

test('bloco do prompt: nao qualificado nao finge urgencia nem diz que avisou', () => {
  const nao = t.blocoTriagemPrompt(conversa(['acabaram de prender meu marido', 'não quero contratar']).triagem);
  assert.match(nao, /não quer contratar um advogado agora/);
  assert.match(nao, /fica à disposição se ela mudar de ideia/);
  assert.match(nao, /Não pressione, não fale de valores de honorários/);
  const fora = t.blocoTriagemPrompt(conversa(['acabaram de prender meu filho em Curitiba']).triagem);
  assert.match(fora, /fora da região de atendimento imediato/);
  assert.match(fora, /horário de expediente/);
  for (const b of [nao, fora]) {
    assert.match(b, /NENHUM advogado foi avisado até agora/);
    assert.match(b, /sem marcar urgencia = true|não marque urgencia = true/);
  }
  const falhou = t.blocoTriagemPrompt({ status: 'alerta_falhou', tipo: 'prisao', respostas: {} });
  assert.match(falhou, /NÃO foi confirmado/);
  assert.match(falhou, /urgencia = true/);
  assert.equal(t.blocoTriagemPrompt(null), '');
  assert.equal(t.blocoTriagemPrompt({ status: 'alerta_enviado', tipo: 'prisao', respostas: {} }), '');
});

test('o prompt fixo nao manda mais dizer que os advogados foram avisados antes da triagem', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const urg = server.slice(server.indexOf('\nURGÊNCIA\n'), server.indexOf('EMERGÊNCIA (RISCO À VIDA OU VIOLÊNCIA)'));
  assert.match(urg, /passam antes por uma TRIAGEM conduzida pelo sistema/);
  assert.match(urg, /NÃO diga que avisou ou vai avisar algum advogado/);
  assert.match(urg, /Quando o sistema informar "URGÊNCIA EM CURSO", aí sim/);
});

test('encaminhamento "urgente" por prisao/busca perde a marca se a triagem nao qualificou', () => {
  const agora = T0 + 5 * 60000;
  const meta = (status) => ({ urgenciaTriagem: { status, atualizadoEm: new Date(T0).toISOString() } });
  const prisao = { urgencia: true, motivo_urgencia: 'filho preso em flagrante', resumo_caso: 'Filho preso em Curitiba.' };
  for (const s of ['em_triagem', 'fora_regiao', 'nao_contrata', 'caso_antigo', 'incompleto']) assert.equal(t.deveRebaixarUrgencia(meta(s), prisao, agora), true, s);
  for (const s of ['alerta_enviado', 'alerta_falhou']) assert.equal(t.deveRebaixarUrgencia(meta(s), prisao, agora), false, s);
  assert.equal(t.deveRebaixarUrgencia({}, prisao, agora), false); // sem triagem, nada muda
  assert.equal(t.deveRebaixarUrgencia(meta('fora_regiao'), { ...prisao, urgencia: false }, agora), false);
  // outras urgencias (audiencia, prazo, violencia domestica) seguem o fluxo de sempre
  assert.equal(t.deveRebaixarUrgencia(meta('fora_regiao'), { urgencia: true, motivo_urgencia: 'audiência amanhã às 14h', resumo_caso: 'x' }, agora), false);
  assert.equal(t.deveRebaixarUrgencia(meta('nao_contrata'), { urgencia: true, motivo_urgencia: 'violência doméstica', resumo_caso: 'marido preso' }, agora), false);
});

// ---------- resumo matinal ----------

const iso = (ms) => new Date(ms).toISOString();
const AGORA = Date.parse('2026-11-28T11:05:00Z'); // 08h05 em Brasilia
function leads() {
  return [
    { phone: '5544900000101', meta: { nome: 'Carla', origem: 'INSTA', urgenciaTriagem: { status: 'fora_regiao', tipo: 'prisao', respostas: { atual: true, cidade: 'Curitiba', naRegiao: false, vinculo: 'filho', contratar: true }, trecho: 'acabaram de prender meu filho em Curitiba', atualizadoEm: iso(AGORA - 6 * 3600e3) } } },
    { phone: '5544900000102', meta: { urgenciaTriagem: { status: 'alerta_enviado', tipo: 'prisao', respostas: {}, trecho: 'x', atualizadoEm: iso(AGORA - 5 * 3600e3) } } },
    { phone: '5544900000103', meta: { urgenciaTriagem: { status: 'em_triagem', tipo: 'busca_apreensao', pergunta: 'cidade', respostas: { oficialNoLocal: true }, trecho: 'tem um oficial na porta', atualizadoEm: iso(AGORA - 4 * 3600e3) } } },
    { phone: '5544900000104', meta: { urgenciaTriagem: { status: 'em_triagem', tipo: 'prisao', pergunta: 'cidade', respostas: {}, trecho: 'em andamento', atualizadoEm: iso(AGORA - 2 * 60000) } } },
    { phone: '5544900000105', meta: { urgenciaTriagem: { status: 'nao_contrata', tipo: 'prisao', respostas: { contratar: false }, trecho: 'ja foi no resumo de ontem', atualizadoEm: iso(AGORA - 30 * 3600e3), digestEm: iso(AGORA - 24 * 3600e3) } } },
    { phone: '5544900000106', meta: { nome: 'Sem triagem' } },
    { phone: '5544900000107', meta: { urgenciaTriagem: { status: 'nao_contrata', tipo: 'prisao', respostas: { atual: true, cidade: 'Sarandi', naRegiao: true, contratar: false }, trecho: 'só queria saber como funciona', atualizadoEm: iso(AGORA - 3 * 3600e3) } } }
  ];
}

test('resumo matinal: so quem nao teve aviso enviado e ainda nao entrou em resumo', () => {
  assert.deepEqual(t.leadsParaDigest(leads(), AGORA).map(l => l.phone.slice(-3)), ['101', '103', '107']);
  const r = t.montarResumoMatinal(leads(), { origemTxt: o.descreverOrigem, agoraMs: AGORA });
  assert.equal(r.titulo, 'RESUMO MATINAL — urgências em triagem');
  assert.match(r.texto, /^🌅 \*RESUMO MATINAL — urgências em triagem\*\n3 caso\(s\)/);
  assert.match(r.texto, /\*1\.\* Carla — \+5544900000101\n🏷️ Origem: Instagram \(INSTA\)\n📌 prisão — fora da região\n🗒️ quando: agora \/ últimas 24h; cidade: Curitiba \(fora da região\); vínculo: filho; quer contratar agora: sim\n💬 "acabaram de prender meu filho em Curitiba"/);
  assert.match(r.texto, /\*2\.\* não informado — \+5544900000103\n🏷️ Origem: não informada\n📌 busca e apreensão — incompleto/); // parou de responder
  assert.match(r.texto, /não contrata/);
  for (const fora of ['5544900000102', '5544900000104', '5544900000105', '5544900000106']) assert.ok(!r.texto.includes(fora) && !r.html.includes(fora), fora);
  assert.equal(t.montarResumoMatinal([leads()[1], leads()[5]], { agoraMs: AGORA }), null); // nada a enviar
  const marcado = t.marcarNoDigest(leads()[2].meta.urgenciaTriagem, AGORA);
  assert.deepEqual([marcado.status, marcado.digestEm, marcado.pergunta], ['incompleto', iso(AGORA), null]);
  assert.equal(t.entraNoDigest(marcado, AGORA + 24 * 3600e3), false); // nao repete no dia seguinte
  const html = t.montarResumoMatinal([{ phone: '1', meta: { nome: '<b>x</b>', urgenciaTriagem: { status: 'caso_antigo', tipo: 'prisao', respostas: {}, trecho: '<script>' } } }], { agoraMs: AGORA }).html;
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<script>'));
});

function cicloDigest(hora, estado, { enviarOk = true } = {}) {
  return t.executarDigest({
    agora: { ymd: estado.hoje, hora }, hora: 8, origemTxt: o.descreverOrigem, agoraMs: AGORA,
    lerMarcador: async () => estado.marcador,
    gravarMarcador: async (ymd, n) => { estado.marcador = ymd; estado.gravados.push([ymd, n]); },
    listarLeads: async () => estado.rows,
    enviar: async (resumo) => { estado.envios.push(resumo.texto); return enviarOk; },
    marcarLead: async (lead) => { lead.meta.urgenciaTriagem = t.marcarNoDigest(lead.meta.urgenciaTriagem, AGORA); estado.marcados.push(lead.phone); }
  });
}
const novoEstado = () => ({ hoje: '2026-11-28', marcador: '2026-11-27', rows: leads(), envios: [], gravados: [], marcados: [] });

test('resumo matinal: antes das 8h nao envia; a partir das 8h envia uma vez por dia', async () => {
  const e = novoEstado();
  assert.equal(await cicloDigest(7, e), 'antes_da_hora');
  assert.equal(e.envios.length, 0);
  assert.equal(await cicloDigest(8, e), 'enviado');
  assert.equal(e.envios.length, 1);
  assert.deepEqual(e.gravados, [['2026-11-28', 3]]);
  assert.deepEqual(e.marcados.map(p => p.slice(-3)), ['101', '103', '107']);
  // segundo ciclo no mesmo dia (ou depois de um restart, pelo marcador gravado): nao reenvia
  assert.equal(await cicloDigest(8, e), 'ja_enviado');
  assert.equal(await cicloDigest(15, e), 'ja_enviado');
  assert.equal(e.envios.length, 1);
  // dia seguinte: quem ja entrou nao volta; sem leads novos, nada e enviado e o dia fica processado
  e.hoje = '2026-11-29';
  assert.equal(await cicloDigest(9, e), 'sem_leads');
  assert.equal(e.envios.length, 1);
  assert.equal(e.marcador, '2026-11-29');
});

test('resumo matinal: se o processo so acordar as 8h17 (ou 11h), ainda entrega', async () => {
  const e = novoEstado();
  assert.equal(await cicloDigest(11, e), 'enviado');
  assert.equal(e.envios.length, 1);
});

test('resumo matinal: se nenhum canal confirmar, nada e marcado (tenta de novo)', async () => {
  const e = novoEstado();
  assert.equal(await cicloDigest(8, e, { enviarOk: false }), 'falhou');
  assert.equal(e.marcador, '2026-11-27');
  assert.deepEqual(e.marcados, []);
  assert.equal(await cicloDigest(8, e), 'enviado');
});

test('hora do resumo: 8 por padrao, configuravel', () => {
  assert.equal(t.horaDigest({}), 8);
  assert.equal(t.horaDigest({ URGENCIA_DIGEST_HORA: '7' }), 7);
  for (const v of ['', 'abc', '-1', '99']) assert.equal(t.horaDigest({ URGENCIA_DIGEST_HORA: v }), 8, v);
});
