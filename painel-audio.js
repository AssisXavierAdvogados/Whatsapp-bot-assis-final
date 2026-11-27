'use strict';

// ---------------------------------------------------------------------------
// Painel /admin: o que foi dito em AUDIO, so em texto.
//
// Nenhum arquivo de audio e guardado. Cada mensagem do historico pode levar
// campos extras pequenos:
//   - cliente:  parts = [{ audio: true|false, text }]  (trechos do lote, sem o marcador)
//   - Ana:      voice = true, dataText = "dados enviados por escrito" | null
//
// O campo "content" nunca muda: e ele que vai para o Claude, com o marcador
// "[ÁUDIO TRANSCRITO]". Estas funcoes sao puras (sem rede, sem estado).
// ---------------------------------------------------------------------------

// Marcador de transcricao no inicio do texto, com ou sem acento.
const MARCADOR = /^\s*\[[ÁA]UDIO TRANSCRITO\]\s*/i;

function isAudioText(text) {
  return MARCADOR.test(String(text == null ? '' : text));
}

// "[ÁUDIO TRANSCRITO] oi" -> "oi"
function stripAudioMarker(text) {
  return String(text == null ? '' : text).replace(MARCADOR, '').trim();
}

// Lote do debounce (cada item e uma mensagem do cliente) -> trechos.
// Devolve null quando nenhum trecho e audio: mensagem so de texto fica sem campo extra.
function buildParts(batchMessages) {
  if (!Array.isArray(batchMessages)) return null;
  const parts = batchMessages
    .filter(m => typeof m === 'string' && m.trim())
    .map(m => (isAudioText(m) ? { audio: true, text: stripAudioMarker(m) } : { audio: false, text: m.trim() }));
  return parts.some(p => p.audio) ? parts : null;
}

// Mensagem antiga (gravada antes dos "parts"): deriva os trechos do proprio texto.
// Linha que comeca com o marcador = audio; linhas seguidas sem marcador = um trecho de texto.
function partsFromLegacyText(content) {
  if (typeof content !== 'string') return null;
  const parts = [];
  for (const linha of content.split('\n')) {
    if (!linha.trim()) continue;
    if (isAudioText(linha)) {
      parts.push({ audio: true, text: stripAudioMarker(linha) });
    } else {
      const ultimo = parts[parts.length - 1];
      if (ultimo && !ultimo.audio) ultimo.text += `\n${linha.trim()}`;
      else parts.push({ audio: false, text: linha.trim() });
    }
  }
  return parts.some(p => p.audio) ? parts : null;
}

// Indice da resposta da Ana que acabou de sair por voz: a mais recente com
// role 'assistant', o mesmo texto e ainda sem marcacao. -1 se nao achar.
function findAssistantEntryToMark(history, reply) {
  if (!Array.isArray(history) || typeof reply !== 'string') return -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m && m.role === 'assistant' && m.content === reply && !m.voice) return i;
  }
  return -1;
}

// Uma entrada do historico -> o que o painel recebe. "text" continua cru.
function toPanelMessage(m) {
  const out = { role: m.role, text: m.content, ts: m.ts || null };
  if (m.role === 'user') {
    const validos = Array.isArray(m.parts)
      ? m.parts.filter(p => p && typeof p.text === 'string').map(p => ({ audio: !!p.audio, text: stripAudioMarker(p.text) }))
      : null;
    const parts = validos && validos.some(p => p.audio) ? validos : partsFromLegacyText(m.content);
    if (parts) out.parts = parts;
  } else if (m.voice) {
    out.voice = true;
    if (typeof m.dataText === 'string' && m.dataText.trim()) out.dataText = m.dataText;
  }
  return out;
}

// Historico -> mensagens de texto para o painel (ignora blocos de ferramenta).
function toPanelMessages(msgs) {
  return (Array.isArray(msgs) ? msgs : [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(toPanelMessage);
}

module.exports = {
  isAudioText,
  stripAudioMarker,
  buildParts,
  partsFromLegacyText,
  findAssistantEntryToMark,
  toPanelMessage,
  toPanelMessages
};
