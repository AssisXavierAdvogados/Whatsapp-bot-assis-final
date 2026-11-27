'use strict';

// ---------------------------------------------------------------------------
// Origem dos atendimentos e urgencia em curso — funcoes puras (sem rede, sem
// estado), testaveis sozinhas. O server.js so chama.
//
//   - codigo de origem nos links wa.me: "Olá! (cód. ADS)"
//   - resposta livre a "como conheceu o escritorio?"
//   - deteccao de urgencia EM CURSO (prisao agora, flagrante, oficial na porta)
//   - texto do aviso imediato a equipe
//
// Tudo vai no jsonb "meta" que a conversa ja tem: meta.origem,
// meta.origemPerguntada e meta.alertaUrgencia.
// ---------------------------------------------------------------------------

// Codigo -> rotulo curto (painel, avisos e prompt)
const ROTULOS = {
  ADS: 'Anúncio',
  GMN: 'Google',
  INSTA: 'Instagram',
  SITE: 'Site',
  INDICACAO: 'Indicação',
  OUTRO: 'Outro'
};

// So estes podem vir num link wa.me
const CODIGOS_LINK = ['ADS', 'GMN', 'INSTA', 'SITE'];

const URGENCIA_JANELA_HORAS_PADRAO = 6;
const ALERTA_TITULO = 'ALERTA URGENTE';

// minusculas, sem acento, espacos simples
function normalizar(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tira o marcador de transcricao de audio do inicio de cada linha
function semMarcadorDeAudio(texto) {
  return String(texto == null ? '' : texto).replace(/^[ \t]*\[[ÁA]UDIO TRANSCRITO\][ \t]*/gim, '');
}

function rotuloOrigem(codigo) {
  return ROTULOS[codigo] || '';
}

// "Instagram (INSTA)" para avisos e prompt; '' se nao houver origem conhecida
function descreverOrigem(codigo) {
  return ROTULOS[codigo] ? `${ROTULOS[codigo]} (${codigo})` : '';
}

// ===========================================================================
// 1) Codigo de origem na mensagem
// ===========================================================================

// Aceita "(cód. ADS)", "(cod ADS)", "(codigo ADS)", "cód. ADS" solto e "[ADS]".
// So devolve codigos da lista conhecida; "[FOO]" e ignorado.
function extractOrigemCode(texto) {
  const t = normalizar(texto);
  const lista = CODIGOS_LINK.join('|').toLowerCase();
  const m = new RegExp(`\\bcod(?:igo)?\\.?\\s*:?\\s*(${lista})\\b`).exec(t) ||
    new RegExp(`\\[\\s*(${lista})\\s*\\]`).exec(t);
  return m ? m[1].toUpperCase() : null;
}

// Grava a origem no meta sem sobrescrever uma ja existente. Devolve o meta
// novo (ou o mesmo objeto, se nada mudou).
function aplicarOrigem(meta, codigo) {
  const atual = meta || {};
  if (atual.origem || !ROTULOS[codigo]) return atual;
  return { ...atual, origem: codigo };
}

// ===========================================================================
// 2) Pergunta da Ana e resposta livre do cliente
// ===========================================================================

// A resposta da Ana perguntou como a pessoa conheceu o escritorio?
function isPerguntaOrigem(respostaDaAna) {
  const t = normalizar(respostaDaAna);
  if (!t.includes('?')) return false;
  return /(conheceu|conheceram|encontrou|achou|descobriu|chegou ate|ficou sabendo|soube) (d?[oa]s? |n[oa]s? )?(o |a )?(nosso |meu )?(escritorio|gente|nos\b|nosso contato|nosso numero|ana\b)/.test(t) ||
    /como (voce |vc |a senhora |o senhor )?(nos|me) (encontrou|conheceu|achou|descobriu)/.test(t) ||
    /como (voce |vc )?(soube|ficou sabendo) (de nos|da gente|do escritorio)/.test(t) ||
    /(por onde|de onde|onde) (voce |vc )?(nos |me )?(conheceu|encontrou|achou|chegou)/.test(t) ||
    /como (voce |vc )?chegou ate (nos|a gente|aqui|o escritorio)/.test(t);
}

const RE_VAGA = /\bnao (me )?(lembro|sei|recordo)\b|\bsei la\b|\bnem sei\b|\besqueci\b|\btanto faz\b|\bnao importa\b|\bnao faco ideia\b/;
const RE_DESCOBERTA = /\b(vi|vimos|achei|achamos|encontrei|conheci|cheguei|vim|soube|descobri|peguei|pesquisei|procurei|apareceu|apareceram|busquei)\b/;
const RE_ESCRITORIO = /\b(voces|vcs|escritorio|assis|(esse|este|o|seu) (numero|contato|whatsapp|zap))\b/;
const RE_INDICACAO_FORTE = /\b(por|foi|fui por|e|como) indicacao\b|\bindic(ou|aram) (voces|vcs|o escritorio|a ana|esse numero|este numero|o dr|a dra|o doutor|a doutora)|\bme indic(ou|aram)\b|\bfui indicad[oa]\b|\brecomend(ou|aram) (voces|vcs|o escritorio)|\bindicacao d[eoa] /;

const CANAIS = [
  { codigo: 'ADS', re: /\b(anuncio|anuncios|google ads|propaganda|patrocinad[oa]|publicidade)\b/ },
  { codigo: 'GMN', re: /\b(google maps|maps|google meu negocio|meu negocio|google)\b/ },
  { codigo: 'INSTA', re: /\b(instagram|insta)\b/ },
  { codigo: 'SITE', re: /\b(site|pagina de voces|pagina do escritorio)\b/ }
];
const RE_INDICACAO_SOLTA = /\b(indicacao|indicou|indicaram|indicad[oa]|recomend\w+|amig[oa]s?|prim[oa]|vizinh[oa]|parente|familiar|colega|conhecid[oa]|cunhad[oa]|irma|irmao|mae|pai|ti[oa]|espos[oa]|marido|namorad[oa]|chefe|patra?o|outr[oa] advogad[oa]|meu advogado|minha advogada|cliente de voces|contador[a]?)\b/;
const RE_OUTRO_CANAL = /\b(facebook|face|tiktok|tik tok|youtube|linkedin|twitter|outdoor|panfleto|folheto|radio|tv|televisao|jornal|revista|placa|fachada|passei na frente|passando na frente|cartao de visita|whatsapp|grupo)\b/;

function canalNaFrase(frase) {
  for (const c of CANAIS) {
    if (c.re.test(frase)) return c.codigo;
  }
  return null;
}

// Mapeia um texto livre do cliente para um codigo de origem, ou null.
//   emResposta = true  -> o texto responde a pergunta da Ana ("como conheceu o
//                         escritorio?"): basta citar o canal.
//   emResposta = false -> fala espontanea, no meio do caso: so vale se a frase
//                         for claramente sobre como chegou ao escritorio
//                         ("vi no Instagram", "achei voces no Google"), para
//                         nao confundir com o assunto ("vi no Instagram que meu ex...").
function mapOrigemFromText(texto, { emResposta = true } = {}) {
  const t = normalizar(semMarcadorDeAudio(texto));
  if (!t) return null;

  if (!emResposta) {
    if (RE_INDICACAO_FORTE.test(t)) return 'INDICACAO';
    for (const frase of t.split(/[.!?;\n]+/).map(f => f.trim()).filter(Boolean)) {
      if (!RE_DESCOBERTA.test(frase)) continue;
      const canal = canalNaFrase(frase);
      if (!canal) continue;
      const palavras = frase.split(' ');
      const c = CANAIS.find(x => x.codigo === canal);
      const fimDoCanal = frase.search(c.re) + c.re.exec(frase)[0].length;
      const sobra = frase.slice(fimDoCanal).trim().split(' ').filter(Boolean).length;
      // "achei voces no google" (fala do escritorio) ou "vi no instagram" (frase curta que termina no canal)
      if (RE_ESCRITORIO.test(frase) || (palavras.length <= 8 && sobra <= 1)) return canal;
    }
    return null;
  }

  if (RE_VAGA.test(t)) return null;
  const canal = canalNaFrase(t);
  if (canal) return canal;
  if (RE_INDICACAO_SOLTA.test(t)) return 'INDICACAO';
  // Outra origem clara: cita outro canal, ou conta como achou ("vi num outdoor")
  if (RE_OUTRO_CANAL.test(t) || RE_DESCOBERTA.test(t)) return 'OUTRO';
  return null;
}

// Decide a origem a gravar a partir de um lote de mensagens do cliente.
// Devolve o codigo ou null. Nunca sobrescreve: se meta.origem existe, null.
function origemDoLote(messages, meta, ultimaRespostaDaAna) {
  if (meta && meta.origem) return null;
  const lista = (Array.isArray(messages) ? messages : [messages]).filter(m => typeof m === 'string');
  for (const m of lista) {
    const codigo = extractOrigemCode(m);
    if (codigo) return codigo;
  }
  const texto = lista.join('\n');
  return mapOrigemFromText(texto, { emResposta: isPerguntaOrigem(ultimaRespostaDaAna) });
}

// ===========================================================================
// 3) Urgencia em curso
// ===========================================================================

// Historia antiga: nao dispara.
const RE_PASSADO = /\b(ano|mes|semana|decada) passad[oa]\b|\bha (\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|alguns|algumas|varios|varias|muitos|muitas|uns|umas) (anos?|mes|meses|semanas?|dias?)\b|\bfaz (\d+|um|uma|dois|duas|tres|quatro|cinco|alguns|algumas|uns|umas|muito) (anos?|mes|meses|semanas?|tempo)\b|\bem (19|20)\d{2}\b|\bja (cumpriram|cumpriu|foi cumprid[oa]|aconteceu|passou|faz tempo)\b|\banteontem\b|\bantigamente\b|\b(na|naquela) epoca\b|\balguns anos atras\b|\b(anos?|meses) atras\b/;

// Pistas de que esta acontecendo agora
const RE_AGORA = /\b(agora|neste momento|nesse momento|neste instante|hoje|acab(ou|aram|ei|amos) de|na porta|aqui em casa|aqui na|aqui no|esta aqui|estao aqui|ta aqui|tao aqui|chegou|chegaram|na delegacia|na viatura|em curso|em andamento|acontecendo|urgente)\b/;

const GATILHOS = [
  { motivo: 'prisão em flagrante', re: /\bflagrante\b/ },
  { motivo: 'prisão acontecendo agora', re: /\bacab(ou|aram|amos|ei) de (ser )?(prender|pres[oa]s?|detid[oa]s?|algemar|algemad[oa]s?|levar (ele|ela|meu|minha))/ },
  { motivo: 'prisão acontecendo agora', re: /\b(estao|tao|esta|ta) (prendendo|algemando|levando (ele|ela|meu|minha|o meu|a minha) (pres[oa]|marido|esposa|filh[oa]|pai|mae|irma?o?))/ },
  { motivo: 'oficial de justiça na porta', re: /\boficial(es)?( de justica)?\b.{0,40}\b(na (minha )?porta|aqui|em casa|la em casa|na frente|no portao|na empresa|na loja|chegou|acabou de chegar|batendo)/ },
  { motivo: 'oficial de justiça ou polícia na porta', re: /\b(policia|policiais|viatura|delegado|pm|oficial)\b.{0,40}\bna (minha )?porta\b|\bna (minha )?porta\b.{0,40}\b(policia|policiais|viatura|oficial)\b/ },
  { motivo: 'mandado sendo cumprido', re: /\bmandado\b.{0,30}\b(sendo cumprido|esta sendo cumprido|em cumprimento)|\b(estao|tao) cumprindo\b.{0,20}\bmandado\b|\bcumprindo (o |um )?mandado\b/ },
  { motivo: 'apreensão acontecendo agora', re: /\b(estao|tao|esta|ta) (levando|apreendendo|guinchando|rebocando|arrombando|invadindo|revistando|tomando|recolhendo)\b/ },
  { motivo: 'apreensão acontecendo agora', re: /\bacab(ou|aram) de (chegar|entrar|invadir|arrombar|bater)\b.{0,40}\b(oficial|policia|policiais|guincho|mandado|busca)/ },
  // Os proximos so valem com pista de "agora"
  { motivo: 'prisão acontecendo agora', agora: true, re: /\b(pres[oa]s?|detid[oa]s?|prenderam|prendeu|algemad[oa]s?|levaram (ele|ela) pres[oa])\b/ },
  { motivo: 'busca e apreensão em curso', agora: true, re: /\bbusca e apreensao\b/ },
  { motivo: 'apreensão acontecendo agora', agora: true, re: /\b(vao|vai|querem|quer) (levar|prender|apreender|guinchar|rebocar|arrombar|tomar)\b/ }
];

// Devolve { urgente: boolean, motivo: string|null }
function detectUrgenciaEmCurso(texto) {
  const t = normalizar(semMarcadorDeAudio(texto));
  if (!t || RE_PASSADO.test(t)) return { urgente: false, motivo: null };
  const agora = RE_AGORA.test(t);
  for (const g of GATILHOS) {
    if (g.agora && !agora) continue;
    if (g.re.test(t)) return { urgente: true, motivo: g.motivo };
  }
  return { urgente: false, motivo: null };
}

function isUrgenciaEmCurso(texto) {
  return detectUrgenciaEmCurso(texto).urgente;
}

function janelaAlertaHoras(env = process.env) {
  const v = Number(String(env.URGENCIA_ALERTA_HORAS == null ? '' : env.URGENCIA_ALERTA_HORAS).trim());
  return Number.isFinite(v) && v > 0 ? v : URGENCIA_JANELA_HORAS_PADRAO;
}

// Ja houve aviso imediato nesta conversa dentro da janela?
function alertaRecente(meta, agoraMs = Date.now(), horas = URGENCIA_JANELA_HORAS_PADRAO) {
  const em = meta && meta.alertaUrgencia && meta.alertaUrgencia.em;
  if (!em) return false;
  const t = new Date(em).getTime();
  return !Number.isNaN(t) && agoraMs - t < horas * 3600 * 1000;
}

// Destinos sem repeticao de telefone (mesma pessoa nao recebe duas vezes)
function dedupeDestinos(destinos) {
  const vistos = new Set();
  return (destinos || []).filter(d => {
    const chave = String((d && d.phone) || '').replace(/\D/g, '');
    if (!chave || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

const escHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Texto do aviso imediato (WhatsApp, e-mail e resumo para o template)
function montarAlertaUrgencia({ nome, phone, origem, trecho, motivo } = {}) {
  const cliente = String(nome || '').trim() || 'não informado';
  const origemTxt = descreverOrigem(origem) || 'não informada';
  let resumo = semMarcadorDeAudio(trecho).replace(/\s+/g, ' ').trim();
  if (resumo.length > 400) resumo = `${resumo.slice(0, 397)}...`;
  if (!resumo) resumo = motivo || 'urgência em curso';
  const rodape = 'A Ana já está atendendo. Este aviso é só pela urgência em curso.';
  const texto =
    `🚨 *${ALERTA_TITULO}*\n` +
    `👤 Cliente: ${cliente}\n` +
    `📱 WhatsApp: +${phone}\n` +
    `🏷️ Origem: ${origemTxt}\n` +
    `📋 Resumo: ${resumo}\n` +
    `_${rodape}_`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:640px">` +
    `<h2 style="color:#c0392b">${ALERTA_TITULO}</h2>` +
    `<p><b>Cliente:</b> ${escHtml(cliente)}<br><b>WhatsApp:</b> +${escHtml(phone)}<br><b>Origem:</b> ${escHtml(origemTxt)}</p>` +
    `<p style="background:#fdedec;padding:12px;border-left:4px solid #c0392b"><b>Resumo:</b> ${escHtml(resumo)}</p>` +
    `<small style="color:#888">${rodape}</small></div>`;
  return {
    titulo: ALERTA_TITULO,
    assunto: `${ALERTA_TITULO} - urgência em curso | ${cliente} (+${phone})`,
    texto, html, resumo, cliente, origemTxt
  };
}

// ===========================================================================
// 4) Blocos do system prompt
// ===========================================================================

// Bloco sobre a origem: ja sabemos / ainda nao perguntou / (ja perguntou: nada)
function blocoOrigemPrompt(meta, { urgenciaEmCurso = false } = {}) {
  const m = meta || {};
  if (m.origem && ROTULOS[m.origem]) {
    return `\n\nORIGEM DO CLIENTE: ${descreverOrigem(m.origem)}. Não comente o código e não pergunte como a pessoa conheceu o escritório.`;
  }
  if (m.origemPerguntada || urgenciaEmCurso) return '';
  return `\n\nORIGEM AINDA NÃO INFORMADA: em um momento natural da conversa, pergunte UMA única vez como a pessoa conheceu o escritório ` +
    `(Google, Instagram, indicação, site...). Se ela já trouxe o problema, cuide do problema primeiro; a pergunta não é a primeira coisa da conversa. ` +
    `Não pergunte em caso urgente. Se ela não responder, desconversar ou mudar de assunto, não insista e não pergunte de novo.`;
}

// Bloco de urgencia em curso: o aviso imediato ja saiu; falta o encaminhamento formal.
function blocoUrgenciaPrompt() {
  return `\n\nURGÊNCIA EM CURSO (dados do sistema): pela mensagem do cliente, o sistema já enviou agora um aviso imediato ao Dr. Willian e à Dra. Aline. ` +
    `Tranquilize a pessoa em poucas palavras e diga que o Dr. Willian e a Dra. Aline já foram avisados. ` +
    `NESTA MESMA resposta, chame a ferramenta de encaminhamento (notificar_especialista, ou triar_caso_trabalhista se for trabalhista) com urgencia = true, ` +
    `usando o que já tiver: o que faltar vai como "não informado" e o horário como "o quanto antes". ` +
    `Não prometa em quantos minutos alguém liga nem qualquer resultado. Não pergunte como a pessoa conheceu o escritório. ` +
    `Se houver risco à vida ou violência acontecendo, oriente primeiro o 190 (e o 180, em violência contra a mulher).`;
}

module.exports = {
  ROTULOS,
  CODIGOS_LINK,
  ALERTA_TITULO,
  URGENCIA_JANELA_HORAS_PADRAO,
  normalizar,
  rotuloOrigem,
  descreverOrigem,
  extractOrigemCode,
  aplicarOrigem,
  isPerguntaOrigem,
  mapOrigemFromText,
  origemDoLote,
  detectUrgenciaEmCurso,
  isUrgenciaEmCurso,
  janelaAlertaHoras,
  alertaRecente,
  dedupeDestinos,
  montarAlertaUrgencia,
  blocoOrigemPrompt,
  blocoUrgenciaPrompt
};
