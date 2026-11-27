'use strict';
// Funcoes puras do painel de audio (sem rede).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const painel = require('../painel-audio');

test('tira o marcador com e sem acento, com e sem espaco', () => {
  assert.equal(painel.stripAudioMarker('[ÁUDIO TRANSCRITO] levaram meu carro'), 'levaram meu carro');
  assert.equal(painel.stripAudioMarker('[AUDIO TRANSCRITO] levaram meu carro'), 'levaram meu carro');
  assert.equal(painel.stripAudioMarker('[ÁUDIO TRANSCRITO]levaram meu carro'), 'levaram meu carro');
  assert.equal(painel.stripAudioMarker('  [áudio transcrito]   oi  '), 'oi');
  assert.equal(painel.stripAudioMarker('texto normal'), 'texto normal');
  assert.equal(painel.stripAudioMarker('falei do [ÁUDIO TRANSCRITO] no meio'), 'falei do [ÁUDIO TRANSCRITO] no meio');
  assert.equal(painel.stripAudioMarker(undefined), '');
});

test('monta parts a partir do lote', () => {
  assert.deepEqual(painel.buildParts(['[ÁUDIO TRANSCRITO] levaram meu carro']), [{ audio: true, text: 'levaram meu carro' }]);
  assert.deepEqual(painel.buildParts(['boa tarde', '[AUDIO TRANSCRITO] levaram meu carro']), [
    { audio: false, text: 'boa tarde' }, { audio: true, text: 'levaram meu carro' }
  ]);
  assert.deepEqual(painel.buildParts(['[ÁUDIO TRANSCRITO] levaram meu carro', 'foi o banco']), [
    { audio: true, text: 'levaram meu carro' }, { audio: false, text: 'foi o banco' }
  ]);
});

test('lote so de texto nao gera parts', () => {
  assert.equal(painel.buildParts(['oi', 'tudo bem?']), null);
  assert.equal(painel.buildParts([]), null);
  assert.equal(painel.buildParts(undefined), null);
});

test('deriva parts de mensagem antiga (so o marcador no content)', () => {
  assert.deepEqual(painel.partsFromLegacyText('[ÁUDIO TRANSCRITO] levaram meu carro'), [{ audio: true, text: 'levaram meu carro' }]);
  assert.deepEqual(painel.partsFromLegacyText('boa tarde\nme ajuda\n[AUDIO TRANSCRITO] levaram meu carro\nfoi o banco'), [
    { audio: false, text: 'boa tarde\nme ajuda' },
    { audio: true, text: 'levaram meu carro' },
    { audio: false, text: 'foi o banco' }
  ]);
  assert.equal(painel.partsFromLegacyText('so texto\nem duas linhas'), null);
  assert.equal(painel.partsFromLegacyText([{ type: 'tool_result' }]), null);
});

test('acha a resposta da Ana a marcar: a mais recente, com o mesmo texto e sem marcacao', () => {
  const h = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'Certo.' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'Certo.' },
    { role: 'user', content: 'chegou outra mensagem no meio' }
  ];
  assert.equal(painel.findAssistantEntryToMark(h, 'Certo.'), 3); // nao e "a ultima do array"
  h[3].voice = true;
  assert.equal(painel.findAssistantEntryToMark(h, 'Certo.'), 1); // a anterior, ainda sem marcacao
  assert.equal(painel.findAssistantEntryToMark(h, 'texto que nao existe'), -1);
  assert.equal(painel.findAssistantEntryToMark(h, 'a'), -1); // mensagem de cliente nunca
  assert.equal(painel.findAssistantEntryToMark(undefined, 'Certo.'), -1);
});

test('mensagens para o painel: campos novos so quando ha audio', () => {
  const msgs = painel.toPanelMessages([
    { role: 'user', content: 'oi', ts: 't1' },
    { role: 'assistant', content: 'Oi! Como posso ajudar?', ts: 't2' },
    { role: 'user', content: '[ÁUDIO TRANSCRITO] levaram meu carro\nfoi o banco', ts: 't3', parts: [{ audio: true, text: 'levaram meu carro' }, { audio: false, text: 'foi o banco' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x' }], ts: 't4' },
    { role: 'assistant', content: 'A consulta custa R$ 250,00.', ts: 't5', voice: true, dataText: 'Valor: R$ 250,00' },
    { role: 'assistant', content: 'Combinado.', ts: 't6', voice: true, dataText: null },
    { role: 'user', content: '[AUDIO TRANSCRITO] mensagem antiga', ts: 't7' }
  ]);
  assert.deepEqual(msgs[0], { role: 'user', text: 'oi', ts: 't1' });
  assert.deepEqual(msgs[1], { role: 'assistant', text: 'Oi! Como posso ajudar?', ts: 't2' });
  assert.equal(msgs[2].text, '[ÁUDIO TRANSCRITO] levaram meu carro\nfoi o banco'); // text continua cru
  assert.deepEqual(msgs[2].parts, [{ audio: true, text: 'levaram meu carro' }, { audio: false, text: 'foi o banco' }]);
  assert.deepEqual(msgs[3], { role: 'assistant', text: 'A consulta custa R$ 250,00.', ts: 't5', voice: true, dataText: 'Valor: R$ 250,00' });
  assert.deepEqual(msgs[4], { role: 'assistant', text: 'Combinado.', ts: 't6', voice: true });
  assert.deepEqual(msgs[5].parts, [{ audio: true, text: 'mensagem antiga' }]); // derivado do texto antigo
  assert.equal(msgs.length, 6); // bloco de ferramenta fica de fora, como antes
  for (const m of msgs) for (const p of m.parts || []) assert.ok(!/TRANSCRITO/i.test(p.text));
});

// trimHistory e sanitizeMessages vivem no server.js (que nao pode ser importado
// sem subir o servidor): o teste avalia o codigo real dessas duas funcoes.
test('trimHistory mantem os campos extras e sanitizeMessages nao os manda para o Claude', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ini = src.indexOf('function trimHistory(');
  const fim = src.indexOf('\n}\n', src.indexOf('return merged;', ini)) + 3;
  assert.ok(ini > 0 && fim > ini);
  const { trimHistory, sanitizeMessages } = new Function(`${src.slice(ini, fim)}; return { trimHistory, sanitizeMessages };`)();

  const h = [];
  for (let i = 0; i < 30; i++) {
    h.push({ role: 'user', content: `[ÁUDIO TRANSCRITO] pergunta ${i}`, ts: `u${i}`, parts: [{ audio: true, text: `pergunta ${i}` }] });
    h.push({ role: 'assistant', content: `resposta ${i}`, ts: `a${i}`, voice: true, dataText: `Valor: R$ ${i},00` });
  }
  const cortado = trimHistory(h, 40);
  assert.equal(cortado.length, 40);
  assert.deepEqual(cortado.at(-2).parts, [{ audio: true, text: 'pergunta 29' }]);
  assert.equal(cortado.at(-1).voice, true);
  assert.equal(cortado.at(-1).dataText, 'Valor: R$ 29,00');

  // o mesmo mapeamento que o callClaudeAPIInternal faz antes de chamar a API
  const paraClaude = sanitizeMessages(cortado.map(({ role, content }) => ({ role, content })));
  assert.equal(paraClaude.length, 40);
  for (const m of paraClaude) assert.deepEqual(Object.keys(m).sort(), ['content', 'role']);
  assert.equal(paraClaude.at(-2).content, '[ÁUDIO TRANSCRITO] pergunta 29'); // com o marcador, como hoje
  // mesmo recebendo as entradas inteiras, o saneamento devolve so role/content
  for (const m of sanitizeMessages(cortado)) assert.deepEqual(Object.keys(m).sort(), ['content', 'role']);
});
