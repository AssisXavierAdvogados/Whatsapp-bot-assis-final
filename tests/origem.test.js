'use strict';
// Origem dos atendimentos, urgencia em curso e regra de honorarios (sem rede).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const o = require('../origem');

const RAIZ = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf8');

// ---------- honorarios ----------

const RE_PRECO = /30\s?%|trinta por cento|nada adiantado|não se cobra nada|sem entrada|só paga se ganhar|quota litis/i;

test('honorarios: o prompt nao manda mais informar "30%" nem "nada adiantado"', () => {
  const ini = SERVER.indexOf('HONORÁRIOS ADVOCATÍCIOS');
  const bloco = SERVER.slice(ini, SERVER.indexOf('`;', ini));
  assert.ok(ini > 0);
  assert.match(bloco, /QUALQUER área, inclusive Direito do Consumidor/);
  assert.match(bloco, /honorários dependem da análise do caso/);
  assert.match(bloco, /informa o valor após a consulta/);
  assert.match(bloco, /Provimento 205\/2021 da OAB, art\. 3º, I/);
  assert.ok(!/informe que o contrato/i.test(bloco));
  assert.ok(!/Não se cobra nada adiantado\./.test(bloco));
  // as expressoes so aparecem na linha que as PROIBE
  const linhas = bloco.split('\n').filter(l => RE_PRECO.test(l));
  assert.equal(linhas.length, 1);
  assert.match(linhas[0], /^- É PROIBIDO dizer/);
});

test('honorarios: nenhum outro prompt ou texto ao cliente oferece percentual ou condicao de preco', () => {
  for (const arquivo of ['server.js', 'voice.js', 'origem.js']) {
    const hits = fs.readFileSync(path.join(RAIZ, arquivo), 'utf8').split('\n').filter(l => RE_PRECO.test(l));
    if (arquivo === 'server.js') {
      assert.equal(hits.length, 1, hits.join('\n'));
      assert.match(hits[0], /^- É PROIBIDO dizer/);
    } else {
      assert.deepEqual(hits, [], `${arquivo}: ${hits.join('\n')}`);
    }
  }
  assert.ok(!/consulta (é )?gr[aá]tis|primeira consulta gratuita|sem custo/i.test(SERVER));
});

// ---------- codigo de origem ----------

test('detecta o codigo de origem nas formas aceitas', () => {
  assert.equal(o.extractOrigemCode('Olá! (cód. ADS)'), 'ADS');
  assert.equal(o.extractOrigemCode('(cod. insta)'), 'INSTA');
  assert.equal(o.extractOrigemCode('[SITE]'), 'SITE');
  assert.equal(o.extractOrigemCode('cód. GMN'), 'GMN');
  assert.equal(o.extractOrigemCode('(cód ADS)'), 'ADS');
  assert.equal(o.extractOrigemCode('(codigo ADS)'), 'ADS');
  assert.equal(o.extractOrigemCode('Olá! (cód. GMN) boa tarde, levaram meu carro hoje cedo'), 'GMN');
  assert.equal(o.extractOrigemCode('boa tarde, queria falar sobre meu processo. codigo site'), 'SITE');
});

test('os quatro links wa.me do README trazem mensagens que sao reconhecidas', () => {
  const readme = fs.readFileSync(path.join(RAIZ, 'README.md'), 'utf8');
  for (const codigo of ['ADS', 'GMN', 'INSTA', 'SITE']) {
    const m = new RegExp(`https://wa\\.me/5544999778551\\?text=(\\S+?%20${codigo}%29)`).exec(readme);
    assert.ok(m, `link de ${codigo} ausente no README`);
    const texto = decodeURIComponent(m[1]);
    assert.equal(texto, `Olá! (cód. ${codigo})`);
    assert.equal(o.extractOrigemCode(texto), codigo);
  }
});

test('ignora codigo desconhecido e texto sem codigo', () => {
  for (const t of ['[FOO]', '(cód. FOO)', 'oi, tudo bem?', '[ÁUDIO TRANSCRITO] oi', 'codigo de barras do boleto', 'visitei o site', '', undefined]) {
    assert.equal(o.extractOrigemCode(t), null, String(t));
  }
});

test('nao sobrescreve origem ja definida', () => {
  assert.deepEqual(o.aplicarOrigem({ nome: 'Maria' }, 'INSTA'), { nome: 'Maria', origem: 'INSTA' });
  const meta = { origem: 'ADS', nome: 'Maria' };
  assert.equal(o.aplicarOrigem(meta, 'SITE'), meta);
  assert.deepEqual(o.aplicarOrigem(undefined, 'GMN'), { origem: 'GMN' });
  assert.deepEqual(o.aplicarOrigem({}, 'FOO'), {}); // codigo invalido nao grava
  assert.equal(o.origemDoLote(['[SITE]'], { origem: 'ADS' }, ''), null);
  assert.equal(o.origemDoLote(['oi', 'Olá! (cód. INSTA)'], {}, ''), 'INSTA');
});

test('rotulos curtos para o painel e descricao para os avisos', () => {
  assert.deepEqual(['ADS', 'GMN', 'INSTA', 'SITE', 'INDICACAO', 'OUTRO'].map(o.rotuloOrigem), ['Anúncio', 'Google', 'Instagram', 'Site', 'Indicação', 'Outro']);
  assert.equal(o.rotuloOrigem(undefined), '');
  assert.equal(o.descreverOrigem('INSTA'), 'Instagram (INSTA)');
  assert.equal(o.descreverOrigem('XYZ'), '');
});

// ---------- resposta livre ----------

test('mapOrigemFromText: resposta a pergunta da Ana', () => {
  const casos = {
    'vi o anúncio': 'ADS', 'foi uma propaganda': 'ADS', 'google ads': 'ADS',
    'pelo Google': 'GMN', 'apareceu no google': 'GMN', 'google maps': 'GMN', 'pesquisei no google': 'GMN',
    'Instagram': 'INSTA', 'pelo insta': 'INSTA',
    'pelo site': 'SITE', 'site do escritório': 'SITE',
    'indicação': 'INDICACAO', 'um amigo': 'INDICACAO', 'meu primo': 'INDICACAO', 'outro advogado indicou': 'INDICACAO', 'indicaram vocês': 'INDICACAO',
    'pelo facebook': 'OUTRO', 'vi num outdoor': 'OUTRO',
    '[ÁUDIO TRANSCRITO] foi pelo instagram': 'INSTA'
  };
  for (const [texto, esperado] of Object.entries(casos)) assert.equal(o.mapOrigemFromText(texto), esperado, texto);
  for (const vago of ['não lembro', 'sei lá', 'nem sei', 'Maria', 'meu carro foi levado pelo banco', '']) {
    assert.equal(o.mapOrigemFromText(vago), null, vago);
  }
});

test('mapOrigemFromText: fala espontanea so vale quando e claramente sobre como chegou ao escritorio', () => {
  const m = (t) => o.mapOrigemFromText(t, { emResposta: false });
  assert.equal(m('vi no Instagram'), 'INSTA');
  assert.equal(m('achei vocês no google'), 'GMN');
  assert.equal(m('vi o anúncio de vocês'), 'ADS');
  assert.equal(m('um amigo indicou vocês'), 'INDICACAO');
  // o canal e o ASSUNTO do caso, nao a origem
  for (const t of ['vi no instagram que meu ex postou fotos minhas', 'vi no site do banco que estou negativado', 'meu primo me bateu', 'o anúncio era enganoso', 'meu instagram foi hackeado', 'oi']) {
    assert.equal(m(t), null, t);
  }
});

test('origemDoLote: usa o modo "resposta" so quando a ultima fala da Ana foi a pergunta', () => {
  assert.equal(o.origemDoLote(['meu primo'], {}, 'Entendi. E como você conheceu o escritório?'), 'INDICACAO');
  assert.equal(o.origemDoLote(['meu primo'], {}, 'Como posso te chamar?'), null);
  assert.equal(o.origemDoLote(['não lembro'], {}, 'Como você conheceu o escritório?'), null);
});

test('reconhece quando a Ana perguntou a origem', () => {
  for (const t of ['Entendi. E como você conheceu o escritório?', 'Como nos encontrou?', 'Só pra registrar: como soube de nós?', 'Por onde você chegou até a gente?']) {
    assert.equal(o.isPerguntaOrigem(t), true, t);
  }
  for (const t of ['Como posso te chamar?', 'O escritório fica em Maringá.', 'Você conheceu o escritório pelo Instagram.', '']) {
    assert.equal(o.isPerguntaOrigem(t), false, t);
  }
});

test('blocos do prompt: origem conhecida, ainda nao perguntada, ja perguntada, urgencia', () => {
  const conhecida = o.blocoOrigemPrompt({ origem: 'INSTA' });
  assert.match(conhecida, /ORIGEM DO CLIENTE: Instagram \(INSTA\)\. Não comente o código e não pergunte como a pessoa conheceu o escritório\./);
  assert.match(o.blocoOrigemPrompt({}), /ORIGEM AINDA NÃO INFORMADA.*UMA única vez/s);
  assert.match(o.blocoOrigemPrompt(undefined), /ORIGEM AINDA NÃO INFORMADA/);
  assert.equal(o.blocoOrigemPrompt({ origemPerguntada: true }), '');
  assert.equal(o.blocoOrigemPrompt({}, { urgenciaEmCurso: true }), ''); // em urgencia, nao pergunta
  assert.match(o.blocoOrigemPrompt({ origem: 'ADS', origemPerguntada: true }), /ORIGEM DO CLIENTE: Anúncio \(ADS\)/);
  const urg = o.blocoUrgenciaPrompt();
  assert.match(urg, /Dr\. Willian e à Dra\. Aline/);
  assert.match(urg, /urgencia = true/);
  assert.match(urg, /Não prometa em quantos minutos alguém liga nem qualquer resultado/);
});

// ---------- urgencia em curso ----------

test('isUrgenciaEmCurso: dispara so para o que esta acontecendo agora', () => {
  const sim = [
    'acabaram de prender meu marido', 'está em flagrante', 'tem um oficial na porta', 'estão levando o carro agora',
    'mandado sendo cumprido', 'busca e apreensão hoje, o oficial acabou de chegar', 'tem um oficial na porta, vão levar o carro',
    'meu filho foi preso agora', 'a polícia está na minha porta', '[ÁUDIO TRANSCRITO] prenderam meu irmão hoje de manhã',
    'ACABARAM DE PRENDER MEU MARIDO', 'tenho audiência amanhã mas agora tem um oficial na porta'
  ];
  const nao = [
    'fui preso em 2020', 'já cumpriram a busca e apreensão no mês passado', 'tenho uma audiência amanhã',
    'estou muito preocupado, preciso de resposta rápido', 'meu marido está preso há dois anos',
    'o banco disse que vão levar meu carro se eu não pagar', 'recebi uma notificação de busca e apreensão',
    'fui preso em flagrante ano passado', 'meu prazo vence amanhã', 'sofri violência doméstica', 'oi', ''
  ];
  for (const t of sim) assert.equal(o.isUrgenciaEmCurso(t), true, `deveria disparar: ${t}`);
  for (const t of nao) assert.equal(o.isUrgenciaEmCurso(t), false, `nao deveria disparar: ${t}`);
  assert.equal(o.detectUrgenciaEmCurso('tem um oficial na porta').motivo, 'oficial de justiça na porta');
});

test('janela de deduplicacao: 6 horas por padrao, configuravel', () => {
  assert.equal(o.janelaAlertaHoras({}), 6);
  assert.equal(o.janelaAlertaHoras({ URGENCIA_ALERTA_HORAS: '2' }), 2);
  for (const v of ['', 'abc', '0', '-1']) assert.equal(o.janelaAlertaHoras({ URGENCIA_ALERTA_HORAS: v }), 6, v);
  const agora = Date.parse('2026-11-27T18:00:00Z');
  const meta = (h) => ({ alertaUrgencia: { em: new Date(agora - h * 3600e3).toISOString() } });
  assert.equal(o.alertaRecente(meta(1), agora), true);
  assert.equal(o.alertaRecente(meta(5.9), agora), true);
  assert.equal(o.alertaRecente(meta(6.1), agora), false);
  assert.equal(o.alertaRecente(meta(3), agora, 2), false);
  assert.equal(o.alertaRecente({}, agora), false);
  assert.equal(o.alertaRecente(undefined, agora), false);
});

test('destinos do aviso sem repetir telefone', () => {
  const d = o.dedupeDestinos([
    { phone: '5544999784442', email: 'a@x' }, { phone: '5544991651532', email: 'b@x' }, { phone: '+55 (44) 99978-4442', email: 'c@x' }, { phone: '', email: 'd@x' }
  ]);
  assert.deepEqual(d.map(x => x.email), ['a@x', 'b@x']);
});

test('texto do aviso imediato: curto, com cliente, numero, origem e resumo; sem promessa', () => {
  const a = o.montarAlertaUrgencia({ nome: 'Maria', phone: '5544900000000', origem: 'INSTA', trecho: '[ÁUDIO TRANSCRITO] tem um oficial na porta', motivo: 'oficial de justiça na porta' });
  assert.equal(a.texto, [
    '🚨 *ALERTA URGENTE*', '👤 Cliente: Maria', '📱 WhatsApp: +5544900000000', '🏷️ Origem: Instagram (INSTA)',
    '📋 Resumo: tem um oficial na porta', '_A Ana já está atendendo. Este aviso é só pela urgência em curso._'
  ].join('\n'));
  const b = o.montarAlertaUrgencia({ phone: '5544900000000', trecho: `${'x'.repeat(500)} <script>` });
  assert.match(b.texto, /Cliente: não informado/);
  assert.match(b.texto, /Origem: não informada/);
  assert.ok(b.resumo.length <= 400);
  const c = o.montarAlertaUrgencia({ phone: '1', trecho: '<b>oi</b>' });
  assert.ok(c.html.includes('&lt;b&gt;oi&lt;/b&gt;') && !c.html.includes('<b>oi</b>'));
  for (const x of [a, b, c]) assert.ok(!/garant|vamos resolver|chance|êxito/i.test(x.texto + x.html));
});
