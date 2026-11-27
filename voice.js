'use strict';

// ---------------------------------------------------------------------------
// Recado de voz da Ana (atendimento a CLIENTE).
//
// Este modulo cuida de tudo que e especifico de voz:
//   - separar os dados que a pessoa precisa copiar (telefone, valor, processo...)
//   - normalizar o texto para a fala (siglas, valores, datas e numeros por extenso)
//   - sintetizar na ElevenLabs, converter para OGG/Opus com ffmpeg
//   - enviar como recado de voz pela Graph API
//   - controlar os limites diarios (por cliente e global)
//
// A decisao de QUANDO responder com voz fica no server.js. Aqui, qualquer
// problema devolve { sent: false, reason } e o server.js responde em texto.
//
// As funcoes puras (extrair dados, normalizar, numeros por extenso) sao
// exportadas para teste sem credencial e sem rede.
// ---------------------------------------------------------------------------

const os = require('os');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const childProcess = require('child_process');

let FFMPEG_STATIC_PATH = null;
try { FFMPEG_STATIC_PATH = require('ffmpeg-static'); } catch (_) { /* dependencia ausente: voz cai para texto */ }

const DEFAULT_VOICE_ID = 'n2a9VtkZLl8j1FSXHsL7'; // Sofia (Natural & Expressive)
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const TTS_TIMEOUT_MS = 25000;
const FFMPEG_TIMEOUT_MS = 20000;
const GRAPH_TIMEOUT_MS = 20000;
const MAX_OGG_BYTES = 512 * 1024; // acima disso o WhatsApp nao mostra como recado de voz
const USAGE_ROW = 'VOICE#usage';

// ===========================================================================
// Configuracao
// ===========================================================================

function parseFlag(v) {
  return /^(true|1|yes)$/i.test(String(v == null ? '' : v).trim());
}

function parseLimit(v, padrao) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d+$/.test(s)) return padrao;
  return Number(s);
}

function loadVoiceConfig(env = process.env) {
  return {
    enabled: parseFlag(env.VOICE_REPLIES_ENABLED),
    apiKey: String(env.ELEVENLABS_API_KEY || '').trim(),
    voiceId: String(env.ELEVENLABS_VOICE_ID || '').trim() || DEFAULT_VOICE_ID,
    model: String(env.ELEVENLABS_MODEL || '').trim() || DEFAULT_MODEL,
    maxChars: parseLimit(env.VOICE_MAX_CHARS, 600),
    clientDailyLimit: parseLimit(env.VOICE_CLIENT_DAILY_LIMIT, 6),
    dailyCharLimit: parseLimit(env.VOICE_DAILY_CHAR_LIMIT, 2500)
  };
}

// A mensagem e a transcricao de um audio? O marcador aparece com e sem acento.
function isAudioTranscript(text) {
  return /^\s*\[[ÁA]UDIO TRANSCRITO\]/i.test(String(text || ''));
}

// "Hoje" no fuso do escritorio (AAAA-MM-DD). O teto diario vira a meia-noite de
// Brasilia, nao em UTC (que seria 21h no escritorio).
function diaBrasilia(instante = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(instante);
}

// ===========================================================================
// Numeros, valores, datas e horas por extenso (pt-BR)
// ===========================================================================

const UNIDADES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez',
  'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos',
  'setecentos', 'oitocentos', 'novecentos'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro',
  'outubro', 'novembro', 'dezembro'];
const ORDINAIS_F = ['', 'primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta', 'sétima', 'oitava', 'nona', 'décima'];
const ORDINAIS_M = ['', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono', 'décimo'];

function unidade(n, feminino) {
  if (feminino && n === 1) return 'uma';
  if (feminino && n === 2) return 'duas';
  return UNIDADES[n];
}

function ate999(n, feminino) {
  if (n === 100) return 'cem';
  const partes = [];
  const c = Math.floor(n / 100);
  const r = n % 100;
  if (c) partes.push(feminino && c >= 2 ? CENTENAS[c].replace(/os$/, 'as') : CENTENAS[c]);
  if (r) {
    if (r < 20) partes.push(unidade(r, feminino));
    else {
      const u = r % 10;
      partes.push(u ? `${DEZENAS[Math.floor(r / 10)]} e ${unidade(u, feminino)}` : DEZENAS[Math.floor(r / 10)]);
    }
  }
  return partes.join(' e ');
}

// Inteiro de 0 a 999.999.999.999 por extenso. Fora disso devolve null.
function numeroPorExtenso(valor, { feminino = false } = {}) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 0 || n > 999999999999) return null;
  if (n === 0) return 'zero';
  const grupos = [
    Math.floor(n / 1e9) % 1000,
    Math.floor(n / 1e6) % 1000,
    Math.floor(n / 1e3) % 1000,
    n % 1000
  ];
  const partes = [];
  grupos.forEach((g, i) => {
    if (!g) return;
    let texto;
    if (i === 0) texto = `${ate999(g, false)} ${g === 1 ? 'bilhão' : 'bilhões'}`;
    else if (i === 1) texto = `${ate999(g, false)} ${g === 1 ? 'milhão' : 'milhões'}`;
    else if (i === 2) texto = g === 1 ? 'mil' : `${ate999(g, feminino)} mil`;
    else texto = ate999(g, feminino);
    partes.push({ texto, valor: g });
  });
  let out = partes[0].texto;
  for (let k = 1; k < partes.length; k++) {
    const ultimo = k === partes.length - 1;
    const v = partes[k].valor;
    // "mil e duzentos", "dois mil e vinte e seis", mas "mil duzentos e cinquenta"
    out += (ultimo && (v < 100 || v % 100 === 0) ? ' e ' : ' ') + partes[k].texto;
  }
  return out;
}

// Valor em reais por extenso: (1250, 0) -> "mil duzentos e cinquenta reais".
function valorPorExtenso(reais, centavos = 0) {
  const r = Math.trunc(Number(reais) || 0);
  const c = Math.trunc(Number(centavos) || 0);
  const partes = [];
  if (r > 0) {
    const ext = numeroPorExtenso(r);
    if (ext === null) return null;
    const milhaoRedondo = r >= 1e6 && r % 1e6 === 0;
    partes.push(`${ext} ${milhaoRedondo ? 'de ' : ''}${r === 1 ? 'real' : 'reais'}`);
  }
  if (c > 0) partes.push(`${numeroPorExtenso(c)} ${c === 1 ? 'centavo' : 'centavos'}`);
  if (!partes.length) return 'zero reais';
  return partes.join(' e ');
}

const REGEX_VALOR = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2})(?!\d))?(?:\s?(mil|milhão|milhões|bilhão|bilhões)\b)?/gi;

// "R$ 1.250,00" -> { reais: 1250, centavos: 0 }
function parseValor(match) {
  const m = new RegExp(REGEX_VALOR.source, 'i').exec(String(match || ''));
  if (!m) return null;
  let reais = Number(m[1].replace(/\./g, ''));
  let centavos = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  const escala = (m[3] || '').toLowerCase();
  if (escala) {
    const fator = escala === 'mil' ? 1e3 : escala.startsWith('milh') ? 1e6 : 1e9;
    const total = Math.round((reais + centavos / 100) * fator * 100);
    reais = Math.floor(total / 100);
    centavos = total % 100;
  }
  return { reais, centavos };
}

// (26, 11, 2026) -> "vinte e seis de novembro de dois mil e vinte e seis"
function dataPorExtenso(dia, mes, ano) {
  const d = Number(dia);
  const m = Number(mes);
  if (!(d >= 1 && d <= 31) || !(m >= 1 && m <= 12)) return null;
  let out = `${d === 1 ? 'primeiro' : numeroPorExtenso(d)} de ${MESES[m - 1]}`;
  if (ano !== undefined && ano !== null && String(ano) !== '') {
    let a = Number(ano);
    if (a < 100) a += 2000;
    out += ` de ${numeroPorExtenso(a)}`;
  }
  return out;
}

// (14, 30) -> "quatorze e trinta"; (14, 0) -> "quatorze horas"; (1, 0) -> "uma hora"
function horaPorExtenso(hora, minuto = 0) {
  const h = Number(hora);
  const min = Number(minuto) || 0;
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
  const hExt = numeroPorExtenso(h, { feminino: true });
  if (!min) return `${hExt} ${h === 1 ? 'hora' : 'horas'}`;
  return `${hExt} e ${numeroPorExtenso(min)}`;
}

// ===========================================================================
// Siglas juridicas
// ===========================================================================

// UF -> [preposicao + nome] ("do Paraná", "de São Paulo")
const ESTADOS = {
  AC: 'do Acre', AL: 'de Alagoas', AP: 'do Amapá', AM: 'do Amazonas', BA: 'da Bahia', CE: 'do Ceará',
  DF: 'do Distrito Federal', ES: 'do Espírito Santo', GO: 'de Goiás', MA: 'do Maranhão',
  MT: 'de Mato Grosso', MS: 'de Mato Grosso do Sul', MG: 'de Minas Gerais', PA: 'do Pará',
  PB: 'da Paraíba', PR: 'do Paraná', PE: 'de Pernambuco', PI: 'do Piauí', RJ: 'do Rio de Janeiro',
  RN: 'do Rio Grande do Norte', RS: 'do Rio Grande do Sul', RO: 'de Rondônia', RR: 'de Roraima',
  SC: 'de Santa Catarina', SP: 'de São Paulo', SE: 'de Sergipe', TO: 'do Tocantins'
};

const LETRAS = {
  A: 'á', B: 'bê', C: 'cê', D: 'dê', E: 'é', F: 'éfe', G: 'gê', H: 'agá', I: 'i', J: 'jota', K: 'cá',
  L: 'éle', M: 'ême', N: 'ene', O: 'ó', P: 'pê', Q: 'quê', R: 'érre', S: 'ésse', T: 'tê', U: 'u',
  V: 'vê', W: 'dáblio', X: 'xis', Y: 'ípsilon', Z: 'zê'
};

function soletrar(sigla) {
  return String(sigla).toUpperCase().split('').map(l => LETRAS[l] || l).join('-');
}

// ===========================================================================
// Normalizacao do texto para a fala
// ===========================================================================

const SUBST_FEMININOS = '(?:horas?|semanas?|vez(?:es)?|parcelas?|pessoas?|vias?|cópias?|fotos?|páginas?|folhas?|audiências?|mensagens?|mensagem|testemunhas?|prestações|prestação|quinzenas?)';

function normalizeForSpeech(texto) {
  let t = String(texto || '');

  // Formatacao de WhatsApp/markdown e emojis nao sao falados
  t = t.replace(/[*_~`]+/g, '');
  t = t.replace(/\p{Extended_Pictographic}|️|‍/gu, '');

  // Blocos (baloes) viram um texto corrido so, com pontuacao entre eles
  t = t.split(/\n+/).map(b => b.trim()).filter(Boolean)
    .map(b => (/[.!?…:;,]$/.test(b) ? b : `${b}.`)).join(' ');

  // OAB/PR, OAB-SP, OAB
  t = t.replace(/\bOAB\s?[\/\-–]\s?([A-Za-z]{2})\b/gi, (m, uf) => {
    const est = ESTADOS[uf.toUpperCase()];
    return est ? `ó-á-bê ${est}` : `ó-á-bê ${soletrar(uf)}`;
  });
  t = t.replace(/\bOAB\b/gi, 'ó-á-bê');

  // Tribunais de Justica
  t = t.replace(/\bTJ[\/\-]?DFT\b/gi, 'Tribunal de Justiça do Distrito Federal e dos Territórios');
  t = t.replace(/\bTJ[\/\-]?([A-Za-z]{2})\b/gi, (m, uf) => {
    const est = ESTADOS[uf.toUpperCase()];
    return est ? `Tribunal de Justiça ${est}` : `Tribunal de Justiça ${soletrar(uf)}`;
  });

  // TRF1 a TRF6 (o ordinal e escrito por extenso logo abaixo)
  t = t.replace(/\bTRF[\s\-]?([1-6])\b/gi, (m, n) => `Tribunal Regional Federal da ${n}ª Região`);

  // PJe
  t = t.replace(/\bPJ-?e\b/gi, 'pê-jê-ê');

  // Dr. / Dra.
  t = t.replace(/\bDra\b\.?/gi, 'doutora');
  t = t.replace(/\bDr\b\.?/gi, 'doutor');

  // Pequenas abreviacoes
  t = t.replace(/\bn[º°]\s?/gi, 'número ');
  t = t.replace(/\s&\s/g, ' e ');

  // Valores em reais
  t = t.replace(REGEX_VALOR, (m) => {
    const v = parseValor(m);
    const ext = v && valorPorExtenso(v.reais, v.centavos);
    return ext || m;
  });

  // Datas 26/11/2026 e 26/11
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m, d, mes, ano) => dataPorExtenso(d, mes, ano) || m);

  // Horas: 14h, 14h30, 14hs, 14:00
  t = t.replace(/\b(\d{1,2})\s?h(?:(\d{2})|s|rs)?(?![\wÀ-ÿ])/gi, (m, h, min) => horaPorExtenso(h, min || 0) || m);
  t = t.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, min) => horaPorExtenso(h, min) || m);

  // Porcentagem
  t = t.replace(/\b(\d{1,3})(?:,(\d{1,2}))?\s?%/g, (m, i, dec) => {
    const base = numeroPorExtenso(Number(i));
    return `${base}${dec ? ` vírgula ${numeroPorExtenso(Number(dec))}` : ''} por cento`;
  });

  // Ordinais: 4ª, 2º
  t = t.replace(/\b(\d{1,2})\s?([ªº°])/g, (m, n, g) => {
    const lista = g === 'ª' ? ORDINAIS_F : ORDINAIS_M;
    return lista[Number(n)] || m;
  });

  // Numeros com separador de milhar (1.250) e decimais (1,5)
  t = t.replace(/\b\d{1,3}(?:\.\d{3})+\b/g, (m) => numeroPorExtenso(Number(m.replace(/\./g, ''))) || m);
  t = t.replace(/\b(\d{1,6}),(\d{1,2})\b/g, (m, i, dec) => {
    const a = numeroPorExtenso(Number(i));
    const b = numeroPorExtenso(Number(dec));
    return a && b ? `${a} vírgula ${b}` : m;
  });

  // Numeros isolados (com concordancia no feminino: "duas semanas", "uma hora")
  t = t.replace(new RegExp(`(?<![\\w.,/-])(\\d{1,12})(?![\\w/-]|[.,]\\d)(\\s+${SUBST_FEMININOS}(?![\\wÀ-ÿ]))?`, 'gi'), (m, n, subst) => {
    if (n.length > 1 && n.startsWith('0')) return m; // 0800, 007: nao e quantidade
    const ext = numeroPorExtenso(Number(n), { feminino: !!subst });
    return ext === null ? m : ext + (subst || '');
  });

  return t.replace(/\s+/g, ' ').replace(/\s+([.,;:!?])/g, '$1').trim();
}

// ===========================================================================
// Extracao dos dados que vao por escrito
// ===========================================================================

const SUFIXO = 'que te mando por escrito';
const SUFIXO_REPETIDO = 'que também vai por escrito';

// tipo -> como aparece na mensagem de texto e como e citado no audio
const TIPOS = {
  link:     { rotulo: 'Link',     ref: 'link',               fem: false, nomes: 'link|site' },
  email:    { rotulo: 'E-mail',   ref: 'endereço de e-mail', fem: false, nomes: 'endereço de e-?mail|e-?mail' },
  processo: { rotulo: 'Processo', ref: 'número do processo', fem: false, nomes: 'número do processo|numero do processo|processo|autos', conectores: 'n[º°o.]|número|numero|de número|de numero', comNome: 'de número que te mando por escrito' },
  cnpj:     { rotulo: 'CNPJ',     ref: 'CNPJ',               fem: false, nomes: 'cnpj' },
  cpf:      { rotulo: 'CPF',      ref: 'CPF',                fem: false, nomes: 'cpf' },
  endereco: { rotulo: 'Endereço', ref: 'endereço',           fem: false, nomes: 'endereço|endereco' },
  cep:      { rotulo: 'CEP',      ref: 'CEP',                fem: false, nomes: 'cep' },
  valor:    { rotulo: 'Valor',    ref: 'valor',              fem: false, nomes: 'valor total|valor|quantia|total|montante|preço|custo', conectores: 'de|em' },
  data:     { rotulo: 'Data',     ref: 'data',               fem: true,  nomes: 'data|prazo', conectores: 'de|para' },
  telefone: { rotulo: 'Telefone', ref: 'telefone',           fem: false, nomes: 'telefone do escritório|telefone|whatsapp|celular|fone|contato|número|numero', conectores: 'de' }
};

const LOGRADOURO = '(?:Rua|R\\.|Avenida|Av\\.|Travessa|Tv\\.|Praça|Pç\\.|Alameda|Al\\.|Rodovia|Rod\\.|Estrada)';
const ABREV_NOME = '(?:Dr|Dra|Sr|Sra|Prof|Des|Cel|Gal|Pe|Sta|Sto|S)';

// Ordem importa: o mais especifico primeiro, para um padrao nao "comer" parte de outro.
const EXTRATORES = [
  { tipo: 'link', re: /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, limpar: (v) => v.replace(/[.,;:!?)]+$/, '') },
  { tipo: 'email', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { tipo: 'processo', re: /\b\d{7}-?\d{2}\.?\d{4}\.?\d\.?\d{2}\.?\d{4}\b/g },
  { tipo: 'cnpj', re: /\b\d{2}\.?\d{3}\.?\d{3}\/\d{4}-?\d{2}\b/g },
  { tipo: 'cpf', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { tipo: 'cpf', re: /(?<=\bCPF[\s:nº°.]*)\d{11}\b/gi },
  {
    tipo: 'endereco',
    re: new RegExp(
      `\\b${LOGRADOURO}\\s+(?:[^\\n.;!?\\d]|(?<=\\b${ABREV_NOME})\\.)*?,?\\s*(?:n[º°o.]?\\s*)?\\d+(?:[^\\n.;!?]|\\.(?=\\d))*`, 'gi'),
    limpar: (v) => v.replace(/[\s,–-]+$/, '')
  },
  { tipo: 'cep', re: /\b\d{2}\.?\d{3}-\d{3}\b/g },
  { tipo: 'cep', re: /(?<=\bCEP[\s:]*)\d{8}\b/gi },
  { tipo: 'valor', re: REGEX_VALOR },
  { tipo: 'data', re: /\b(?:dia\s+)?\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/gi },
  { tipo: 'data', re: /\b(?:dia\s+\d{1,2}\/\d{1,2}|\d{2}\/\d{2})\b/gi }, // sem ano: "dia 5/12" ou "05/12" (nao "2/3")
  { tipo: 'data', re: /(?<=\baté\s+(?:o\s+)?)dia\s+\d{1,2}(?:º|°)?(?:\s+de\s+[a-zç]+(?:\s+de\s+\d{4})?)?/gi, prazo: true, ate: true },
  { tipo: 'telefone', re: /\+55\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g },
  { tipo: 'telefone', re: /\(\d{2}\)\s?9?\d{4}[-\s]?\d{4}\b/g },
  { tipo: 'telefone', re: /\b0800[\s-]?\d{3}[\s-]?\d{4}\b/g },
  { tipo: 'telefone', re: /\b(?:\d{2}\s)?9?\d{4}-\d{4}\b/g },
  { tipo: 'telefone', re: /\b\d{10,13}\b/g }
];

// Sobrou dado cru (algo que nao pode ser ditado) no texto que seria falado?
function hasRawData(texto) {
  const t = String(texto || '');
  return /R\$/.test(t) ||
    /https?:|www\./i.test(t) ||
    /@/.test(t) ||
    /\d{5,}/.test(t) ||           // sequencias longas de digitos
    /\d\s?[\/\-]\s?\d/.test(t);   // digitos com barra ou hifen (data, telefone, documento)
}

const CONTRACOES = {
  de: ['do', 'da'], em: ['no', 'na'], a: ['ao', 'à'], por: ['pelo', 'pela']
};
const CONTRAIDAS = { no: 'em', na: 'em', do: 'de', da: 'de', ao: 'a', 'à': 'a', pelo: 'por', pela: 'por' };

// Separa os dados "copiaveis" do texto que sera falado.
// Devolve { spoken, items: [{ tipo, rotulo, valor }], dataText, residual }.
function extractCopyData(texto) {
  let t = String(texto || '');
  const encontrados = [];

  for (const ex of EXTRATORES) {
    t = t.replace(new RegExp(ex.re.source, ex.re.flags), (m, ...resto) => {
      const offset = resto[resto.length - 2];
      const valor = (ex.limpar ? ex.limpar(m) : m).trim();
      if (!valor) return m;
      const sobra = m.slice(m.indexOf(valor) + valor.length); // pontuacao que nao faz parte do dado
      const antes = t.slice(Math.max(0, offset - 30), offset);
      const prazo = ex.tipo === 'data' && (ex.prazo || /\b(prazo|até|vence|vencimento)\b[^.!?\n]*$/i.test(antes));
      const i = encontrados.push({ tipo: ex.tipo, valor, prazo, ate: !!ex.ate }) - 1;
      return `\u0000${i}\u0000${sobra}`;
    });
  }

  // Troca cada dado pela referencia curta, ajustando a frase em volta.
  const usados = new Set();
  const ordem = []; // dados na ordem em que aparecem no texto
  let spoken = '';
  let resto = t;
  let m;
  while ((m = /\u0000(\d+)\u0000/.exec(resto))) {
    let antes = spoken + resto.slice(0, m.index);
    resto = resto.slice(m.index + m[0].length);
    const item = encontrados[Number(m[1])];
    ordem.push(item);
    const cfg = TIPOS[item.tipo];
    const art = cfg.fem ? 'a' : 'o';
    const sufixo = usados.has(item.tipo) ? SUFIXO_REPETIDO : SUFIXO;
    usados.add(item.tipo);

    let troca;
    // (\b nao serve aqui: "é" nao conta como letra para o \b, e casaria o fim de "até")
    const comVerbo = /(?<![\wÀ-ÿ])(é|são|será|seria)\s*:?\s*$/i.exec(antes);
    const comNome = new RegExp(`(?<![\\wÀ-ÿ])(${cfg.nomes})(?:\\s+(?:${cfg.conectores || 'de'}))?\\s*:?\\s*$`, 'i').exec(antes);
    if (comVerbo) {
      // "o telefone é (44)..." -> "o telefone é o que te mando por escrito"
      antes = antes.slice(0, comVerbo.index) + comVerbo[1] + ' ';
      troca = `${art} ${sufixo}`;
    } else if (comNome) {
      // "no valor de R$ 250" -> "no valor que te mando por escrito"
      antes = antes.slice(0, comNome.index) + comNome[1] + ' ';
      troca = cfg.comNome || sufixo;
    } else {
      // "custa R$ 250" -> "custa o valor que te mando por escrito"
      const prep = /(^|[\s(])(de|em|a|por|no|na|do|da|ao|à|pelo|pela|o|a)\s+$/i.exec(antes);
      let inicio = `${art} ${cfg.ref}`;
      if (item.tipo === 'valor' && prep && prep[2].toLowerCase() === 'de') {
        // "multa de R$ 500" -> "multa no valor que te mando por escrito"
        antes = antes.slice(0, prep.index) + prep[1];
        inicio = `no ${cfg.ref}`;
      } else if (item.tipo === 'data' && !prep && !/(?<![\wÀ-ÿ])(até|para|desde|após|entre|e|ou)\s+$/i.test(antes)) {
        // "vence dia 10/12" -> "vence na data que te mando por escrito"
        inicio = `na ${cfg.ref}`;
      } else if (prep) {
        const p = prep[2].toLowerCase();
        const base = CONTRAIDAS[p] || p;
        if (CONTRACOES[base]) {
          antes = antes.slice(0, prep.index) + prep[1];
          const forma = CONTRACOES[base][cfg.fem ? 1 : 0];
          inicio = `${/^[A-ZÀ-Ý]/.test(prep[2]) ? forma[0].toUpperCase() + forma.slice(1) : forma} ${cfg.ref}`;
        } else if (p === 'o' || p === 'a') {
          antes = antes.slice(0, prep.index) + prep[1];
          inicio = `${/^[A-ZÀ-Ý]/.test(prep[2]) ? art.toUpperCase() : art} ${cfg.ref}`;
        }
      }
      troca = `${inicio} ${sufixo}`;
    }
    spoken = antes + troca;
  }
  spoken += resto;

  // Lista para a mensagem de texto, sem repeticao
  const vistos = new Set();
  const items = [];
  for (const e of ordem) {
    const chave = `${e.tipo}|${e.valor.toLowerCase()}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const rotulo = e.tipo === 'data' && e.prazo ? 'Prazo' : TIPOS[e.tipo].rotulo;
    const valor = e.ate ? `até ${e.valor}` : e.valor;
    items.push({ tipo: e.tipo, rotulo, valor });
  }

  return {
    spoken,
    items,
    dataText: items.length ? items.map(i => `${i.rotulo}: ${i.valor}`).join('\n') : null,
    residual: hasRawData(spoken)
  };
}

// Monta o plano do recado: o que e falado e o que vai por escrito.
// { ok: true, spoken, dataText } ou { ok: false, reason }.
function buildVoicePlan(reply, { maxChars = 600 } = {}) {
  const texto = String(reply || '').trim();
  if (!texto) return { ok: false, reason: 'resposta_vazia' };
  const ext = extractCopyData(texto);
  if (ext.residual) return { ok: false, reason: 'dado_cru_no_texto_falado' };
  const spoken = normalizeForSpeech(ext.spoken);
  if (!spoken) return { ok: false, reason: 'resposta_vazia' };
  if (/\d/.test(spoken)) return { ok: false, reason: 'numero_nao_normalizado' };
  if (spoken.length > maxChars) return { ok: false, reason: 'texto_longo', chars: spoken.length };
  return { ok: true, spoken, dataText: ext.dataText, items: ext.items };
}

// ===========================================================================
// Rede: ElevenLabs, ffmpeg e Graph API
// ===========================================================================

class VoiceError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'VoiceError';
    this.reason = reason;
    Object.assign(this, extra);
  }
}

// Mensagem segura para log: sem segredos, uma linha, curta.
function sanitize(msg, segredos = []) {
  let s = String(msg == null ? '' : msg);
  for (const seg of segredos) {
    if (seg && String(seg).length >= 4) s = s.split(String(seg)).join('***');
  }
  s = s.replace(/\bbearer\s+[^\s"',}]+/gi, 'Bearer ***');
  s = s.replace(/(xi-api-key|authorization)["'\s:=]+(?!Bearer \*\*\*)[^\s"',}]+/gi, '$1: ***');
  return s.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function ffmpegAvailable(ffmpegPath = FFMPEG_STATIC_PATH) {
  if (!ffmpegPath) return false;
  try {
    fs.accessSync(ffmpegPath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

// MP3 -> OGG/Opus mono 48 kHz (formato de recado de voz do WhatsApp).
// Arquivos temporarios com nome unico, sempre apagados no final.
async function convertMp3ToOggOpus(mp3Buffer, { ffmpegPath = FFMPEG_STATIC_PATH, spawn = childProcess.spawn, tmpDir = os.tmpdir() } = {}) {
  if (!ffmpegPath) throw new VoiceError('ffmpeg_ausente', 'ffmpeg nao encontrado');
  const id = crypto.randomUUID();
  const entrada = path.join(tmpDir, `ana-voz-${id}.mp3`);
  const saida = path.join(tmpDir, `ana-voz-${id}.ogg`);
  try {
    await fsp.writeFile(entrada, mp3Buffer);
    await new Promise((resolve, reject) => {
      let stderr = '';
      let terminou = false;
      const fim = (err) => { if (!terminou) { terminou = true; clearTimeout(timer); err ? reject(err) : resolve(); } };
      let proc;
      try {
        proc = spawn(ffmpegPath, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', entrada, '-vn', '-ac', '1', '-ar', '48000',
          '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
          saida
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (e) {
        return fim(new VoiceError('ffmpeg_erro', sanitize(e.message)));
      }
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) { /* ja encerrou */ }
        fim(new VoiceError('ffmpeg_erro', 'timeout na conversao'));
      }, FFMPEG_TIMEOUT_MS);
      if (proc.stderr) proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-500); });
      proc.on('error', (e) => fim(new VoiceError('ffmpeg_erro', sanitize(e.message))));
      proc.on('close', (code) => fim(code === 0 ? null : new VoiceError('ffmpeg_erro', `ffmpeg saiu com codigo ${code}: ${sanitize(stderr)}`)));
    });
    const ogg = await fsp.readFile(saida);
    if (!ogg.length) throw new VoiceError('ffmpeg_erro', 'arquivo convertido vazio');
    if (ogg.length > MAX_OGG_BYTES) throw new VoiceError('audio_grande', `audio com ${ogg.length} bytes passa do limite de recado de voz`);
    return ogg;
  } catch (e) {
    if (e instanceof VoiceError) throw e;
    throw new VoiceError('ffmpeg_erro', sanitize(e.message));
  } finally {
    await Promise.all([entrada, saida].map(f => fsp.unlink(f).catch(() => {})));
  }
}

// Texto -> MP3 pela ElevenLabs. So devolve o audio; quem chama conta os creditos.
async function synthesizeSpeech(text, { apiKey, voiceId = DEFAULT_VOICE_ID, model = DEFAULT_MODEL, fetchFn = fetch, timeoutMs = TTS_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: model }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new VoiceError(timeout ? 'elevenlabs_timeout' : 'elevenlabs_rede', timeout ? 'timeout' : sanitize(e && e.message, [apiKey]));
  }
  if (!res.ok) {
    const corpo = sanitize(await res.text().catch(() => ''), [apiKey]);
    const quota = [401, 402, 429].includes(res.status) || /quota|credit/i.test(corpo);
    throw new VoiceError(quota ? 'elevenlabs_limite' : 'elevenlabs_erro', `HTTP ${res.status}: ${corpo}`, { status: res.status });
  }
  const mp3 = Buffer.from(await res.arrayBuffer());
  if (!mp3.length) throw new VoiceError('elevenlabs_erro', 'audio vazio', { cobrado: true });
  return mp3;
}

// Sobe o OGG para a Meta e envia como recado de voz (voice: true).
async function sendWhatsAppAudio(to, oggBuffer, { token, phoneNumberId, graphVersion = 'v19.0', fetchFn = fetch } = {}) {
  if (!to || !token || !phoneNumberId) throw new VoiceError('whatsapp_config', 'parametros do WhatsApp ausentes');
  const base = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}`;
  const falha = async (etapa, res) => {
    const corpo = await res.json().catch(() => ({}));
    const err = corpo && corpo.error ? corpo.error : {};
    return new VoiceError(`whatsapp_${etapa}`, `HTTP ${res.status}${err.code ? ` (codigo ${err.code})` : ''}: ${sanitize(err.message || '', [token])}`, { status: res.status });
  };

  // 1) upload da midia: o campo "type" precisa bater com o MIME do arquivo
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'audio/ogg');
  form.append('file', new Blob([oggBuffer], { type: 'audio/ogg' }), 'recado.ogg');
  let res;
  try {
    res = await fetchFn(`${base}/media`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    });
  } catch (e) {
    throw new VoiceError('whatsapp_upload', sanitize(e && e.message, [token]));
  }
  if (!res.ok) throw await falha('upload', res);
  const mediaId = (await res.json().catch(() => ({}))).id;
  if (!mediaId) throw new VoiceError('whatsapp_upload', 'upload sem id de midia');

  // 2) mensagem de audio como recado de voz
  try {
    res = await fetchFn(`${base}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'audio', audio: { id: mediaId, voice: true }
      }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS)
    });
  } catch (e) {
    throw new VoiceError('whatsapp_envio', sanitize(e && e.message, [token]));
  }
  if (!res.ok) throw await falha('envio', res);
  const data = await res.json().catch(() => ({}));
  return { mediaId, messageId: data && data.messages && data.messages[0] ? data.messages[0].id : null };
}

// ===========================================================================
// Servico: limites diarios + tentativa de recado de voz
// ===========================================================================

// deps:
//   env        -> variaveis de ambiente (default process.env)
//   whatsapp   -> { token, phoneNumberId, graphVersion }
//   store      -> { load(): Promise<meta|null>, save(meta): Promise } (Supabase); null = so memoria
//   fetchFn, spawn, ffmpegPath, now, log -> injetaveis para teste
function createVoiceService(deps = {}) {
  const config = loadVoiceConfig(deps.env || process.env);
  const whatsapp = deps.whatsapp || {};
  const fetchFn = deps.fetchFn || ((...a) => fetch(...a));
  const spawn = deps.spawn || childProcess.spawn;
  const ffmpegPath = deps.ffmpegPath !== undefined ? deps.ffmpegPath : FFMPEG_STATIC_PATH;
  const store = deps.store || null;
  const now = deps.now || (() => new Date());
  const log = deps.log || console;
  const segredos = [config.apiKey, whatsapp.token];

  let usage = null;            // { day, chars, byClient: { fone: { chars, count } } }
  let reservadoChars = 0;      // caracteres de sinteses em andamento
  const reservadoCliente = {}; // fone -> recados em andamento
  let bloqueadoNoDia = null;   // dia (AAAA-MM-DD) em que a ElevenLabs recusou por chave/credito
  let bloqueadoAte = 0;        // pausa curta apos HTTP 429
  let avisouStore = false;

  const warnStore = (acao, e) => {
    if (avisouStore) return;
    avisouStore = true;
    log.warn(`[Voz] Supabase indisponivel ao ${acao} os contadores de voz; seguindo so com a memoria. ${sanitize(e && e.message, segredos)}`);
  };

  async function usageToday() {
    const day = diaBrasilia(now());
    if (usage && usage.day === day) return usage;
    let salvo = null;
    if (store) {
      try { salvo = await store.load(); } catch (e) { warnStore('ler', e); }
    }
    usage = salvo && salvo.day === day
      ? { day, chars: Number(salvo.chars) || 0, byClient: { ...(salvo.byClient || {}) } }
      : { day, chars: 0, byClient: {} };
    return usage;
  }

  async function registrar(phone, chars, entregue) {
    const u = await usageToday();
    u.chars += chars;
    const c = u.byClient[phone] || { chars: 0, count: 0 };
    c.chars += chars;
    if (entregue) c.count += 1;
    u.byClient[phone] = c;
    if (store) {
      try { await store.save({ day: u.day, chars: u.chars, byClient: u.byClient }); avisouStore = false; } catch (e) { warnStore('gravar', e); }
    }
  }

  function status() {
    return {
      enabled: config.enabled,
      apiKeyDefined: !!config.apiKey,
      ffmpeg: ffmpegAvailable(ffmpegPath),
      voiceId: config.voiceId,
      model: config.model,
      maxChars: config.maxChars,
      clientDailyLimit: config.clientDailyLimit,
      dailyCharLimit: config.dailyCharLimit
    };
  }

  // Tenta responder com recado de voz. Nunca lanca erro:
  //   { sent: true, dataText, chars }  -> audio enviado; dataText (se houver) vai por escrito
  //   { sent: false, reason }          -> quem chamou responde em texto, como sempre
  async function tryVoiceReply(to, reply) {
    if (!config.enabled) return { sent: false, reason: 'flag_desligada' };
    if (!config.apiKey) return { sent: false, reason: 'chave_ausente' };
    if (!whatsapp.token || !whatsapp.phoneNumberId) return { sent: false, reason: 'whatsapp_config' };
    if (!ffmpegAvailable(ffmpegPath)) return { sent: false, reason: 'ffmpeg_ausente' };

    const plano = buildVoicePlan(reply, { maxChars: config.maxChars });
    if (!plano.ok) return { sent: false, reason: plano.reason };

    const u = await usageToday();
    if (bloqueadoNoDia === u.day) return { sent: false, reason: 'elevenlabs_bloqueada_hoje' };
    if (now().getTime() < bloqueadoAte) return { sent: false, reason: 'elevenlabs_pausa' };

    const chars = plano.spoken.length;
    const cliente = u.byClient[to] || { chars: 0, count: 0 };
    if (cliente.count + (reservadoCliente[to] || 0) >= config.clientDailyLimit) return { sent: false, reason: 'limite_cliente' };
    if (u.chars + reservadoChars + chars > config.dailyCharLimit) return { sent: false, reason: 'limite_diario' };

    reservadoChars += chars;
    reservadoCliente[to] = (reservadoCliente[to] || 0) + 1;
    let cobrado = false;
    try {
      log.log(`[Voz] Sintetizando recado para ${to} (${chars} caracteres).`);
      const mp3 = await synthesizeSpeech(plano.spoken, { apiKey: config.apiKey, voiceId: config.voiceId, model: config.model, fetchFn });
      cobrado = true; // a ElevenLabs ja descontou os creditos deste texto
      const ogg = await convertMp3ToOggOpus(mp3, { ffmpegPath, spawn });
      await sendWhatsAppAudio(to, ogg, { ...whatsapp, fetchFn });
      await registrar(to, chars, true);
      log.log(`[Voz] Recado de voz enviado para ${to} (${chars} caracteres, ${ogg.length} bytes).`);
      return { sent: true, dataText: plano.dataText, chars };
    } catch (e) {
      const reason = e instanceof VoiceError ? e.reason : 'erro_inesperado';
      if (e && e.cobrado) cobrado = true;
      if (reason === 'elevenlabs_limite') {
        if (e.status === 429) bloqueadoAte = now().getTime() + 5 * 60 * 1000;
        else bloqueadoNoDia = u.day;
      }
      // Sintese cobrada mas nao entregue: conta os caracteres, para o teto continuar honesto.
      if (cobrado) await registrar(to, chars, false);
      log.warn(`[Voz] Falha no recado de voz para ${to} (${reason}): ${sanitize(e && e.message, segredos)}`);
      return { sent: false, reason };
    } finally {
      reservadoChars -= chars;
      reservadoCliente[to] -= 1;
      if (reservadoCliente[to] <= 0) delete reservadoCliente[to];
    }
  }

  return { config, status, tryVoiceReply, usageToday };
}

module.exports = {
  USAGE_ROW,
  DEFAULT_VOICE_ID,
  DEFAULT_MODEL,
  loadVoiceConfig,
  isAudioTranscript,
  diaBrasilia,
  numeroPorExtenso,
  valorPorExtenso,
  dataPorExtenso,
  horaPorExtenso,
  normalizeForSpeech,
  extractCopyData,
  hasRawData,
  buildVoicePlan,
  sanitize,
  ffmpegAvailable,
  convertMp3ToOggOpus,
  synthesizeSpeech,
  sendWhatsAppAudio,
  createVoiceService,
  VoiceError
};
