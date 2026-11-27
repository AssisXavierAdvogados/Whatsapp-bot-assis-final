'use strict';

// ---------------------------------------------------------------------------
// Triagem de urgencia em curso — filtro ANTES do aviso imediato.
//
// O detector (origem.js) so ABRE a triagem. A Ana faz as perguntas que faltam
// e o aviso ao Dr. Willian e a Dra. Aline so sai se o caso for atual, na
// regiao de atuacao e a pessoa confirmar que quer contratar agora. O que nao
// qualifica vira lead e entra no resumo matinal.
//
// Tudo aqui e puro (sem rede, sem estado), para testar sozinho. O estado vive
// em meta.urgenciaTriagem:
//   { status, tipo, motivo, respostas: { atual, oficialNoLocal, cidade, naRegiao,
//     vinculo, contratar }, pergunta, tentativas, trecho, abertaEm, atualizadoEm, digestEm }
// ---------------------------------------------------------------------------

const { normalizar } = require('./origem');

const STATUS = {
  EM_TRIAGEM: 'em_triagem',
  ALERTA_ENVIADO: 'alerta_enviado',
  ALERTA_FALHOU: 'alerta_falhou',
  CASO_ANTIGO: 'caso_antigo',
  SEM_OFICIAL: 'sem_oficial',
  FORA_REGIAO: 'fora_regiao',
  NAO_CONTRATA: 'nao_contrata',
  INCOMPLETO: 'incompleto'
};

// Rotulos curtos para o painel e para o resumo matinal
const ROTULOS_STATUS = {
  em_triagem: 'urgência: em triagem',
  alerta_enviado: 'alerta enviado',
  alerta_falhou: 'alerta não confirmado',
  caso_antigo: 'caso antigo',
  sem_oficial: 'oficial não está no local',
  fora_regiao: 'fora da região',
  nao_contrata: 'não contrata',
  incompleto: 'incompleto'
};

const TITULO_DIGEST = 'RESUMO MATINAL — urgências em triagem';
const DIGEST_HORA_PADRAO = 8;
const TRIAGEM_VALIDADE_HORAS = 24;   // depois disso, uma nova deteccao abre outra triagem
const TRIAGEM_PARADA_MINUTOS = 30;   // em triagem sem resposta ha esse tempo = incompleto
const MAX_TENTATIVAS = 2;            // vezes que a mesma pergunta e feita

// ===========================================================================
// Regiao de atuacao
// ===========================================================================

const REGIAO_PADRAO = ['Maringá', 'Sarandi', 'Paiçandu', 'Mandaguaçu', 'Mandaguari', 'Marialva', 'Astorga',
  'Nova Esperança', 'Cianorte', 'Umuarama', 'Paranavaí'];

// Valem sempre, mesmo com a lista customizada
const RE_FRASES_REGIAO = /\b(maringa|regiao de maringa|noroeste do parana|noroeste paranaense|perto de maringa)\b/;

// Cidades conhecidas de fora, para reconhecer mesmo escritas em minusculas
const CIDADES_CONHECIDAS = ['Curitiba', 'Londrina', 'Cascavel', 'Foz do Iguaçu', 'Ponta Grossa', 'Guarapuava', 'Apucarana',
  'Arapongas', 'Campo Mourão', 'Toledo', 'Paranaguá', 'Cambé', 'Rolândia', 'São José dos Pinhais', 'Colombo',
  'São Paulo', 'Rio de Janeiro', 'Belo Horizonte', 'Brasília', 'Florianópolis', 'Porto Alegre', 'Salvador', 'Fortaleza',
  'Recife', 'Goiânia', 'Manaus', 'Belém', 'Campo Grande', 'Cuiabá', 'Vitória', 'Campinas', 'Santos', 'Joinville',
  'Presidente Prudente', 'Dourados'];

// URGENCIA_REGIAO (opcional): lista separada por virgula que substitui os municipios padrao
function listaRegiao(env = process.env) {
  const itens = String(env.URGENCIA_REGIAO == null ? '' : env.URGENCIA_REGIAO).split(',').map(s => s.trim()).filter(Boolean);
  return itens.length ? itens : REGIAO_PADRAO.slice();
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Nome do municipio da regiao citado no texto (ou a frase de regiao), ou null
function cidadeNaRegiao(texto, lista = REGIAO_PADRAO) {
  const t = normalizar(texto);
  if (!t) return null;
  for (const cidade of lista || []) {
    const n = normalizar(cidade);
    if (n && new RegExp(`(^|[^a-z0-9])${escRe(n)}([^a-z0-9]|$)`).test(t)) return cidade;
  }
  const frase = RE_FRASES_REGIAO.exec(t);
  if (frase) return frase[1] === 'maringa' ? 'Maringá' : 'região de Maringá';
  return null;
}

// O texto cita um lugar dentro da regiao de atuacao?
function naRegiao(texto, lista = REGIAO_PADRAO) {
  return cidadeNaRegiao(texto, lista) !== null;
}

// Cidade de FORA da regiao citada no texto ("em Curitiba", "delegacia de Londrina"), ou null
function cidadeForaDaRegiao(texto, lista = REGIAO_PADRAO) {
  const original = String(texto == null ? '' : texto);
  const t = normalizar(original);
  for (const cidade of CIDADES_CONHECIDAS) {
    const n = normalizar(cidade);
    if (new RegExp(`(^|[^a-z0-9])${escRe(n)}([^a-z0-9]|$)`).test(t) && !naRegiao(cidade, lista)) return cidade;
  }
  // Nome proprio depois de uma indicacao de lugar: "preso em Xambrê", "delegacia de Jussara"
  const m = /(?:\b(?:em|delegacia de|delegacia da|delegacia do|cadeia de|pres[íi]dio de|cidade de|comarca de|f[óo]rum de)\s+)([A-ZÀ-Ý][\wÀ-ÿ]+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][\wÀ-ÿ]+){0,3})/.exec(original);
  if (m && !naRegiao(m[1], lista) && !/^(Deus|Flagrante|Casa|Liberdade|Regime)$/i.test(m[1])) return m[1].trim();
  return null;
}

// ===========================================================================
// Tipo e extracao das respostas
// ===========================================================================

// Motivo do detector -> tipo da triagem
function tipoDaUrgencia(motivo) {
  return /pris/i.test(normalizar(motivo)) ? 'prisao' : 'busca_apreensao';
}

const RE_SIM = /^(sim|s|isso|isso mesmo|exato|exatamente|claro|com certeza|certeza|quero|quero sim|pode|pode sim|por favor|positivo|aham|uhum|ss|sim senhora|foi|foi sim|esta|esta sim|estao|estao sim|ainda esta|ainda estao|ta|tao)\b/;
const RE_NAO = /^(nao|n|nn|negativo|ainda nao|agora nao|por enquanto nao|nao quero|nao precisa|deixa|deixa pra la)\b/;
const RE_NAO_SEI = /\bnao (sei|me disseram|me falaram|me informaram|faco ideia|tenho certeza|sabemos)\b|\bsei la\b|\bnem sei\b/;

const RE_PASSADO = /\b(ano|mes|semana|decada) passad[oa]\b|\b(ha|faz) (uns |umas |quase |mais de |cerca de |tipo )?(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|alguns|algumas|varios|varias|muitos|muito) (anos?|mes|meses|semanas?|dias|tempo)\b|\bem (19|20)\d{2}\b|\banteontem\b|\b(caso|processo|coisa|historia) antig[oa]\b|\be antig[oa]\b|\bantig[oa]\b|\bfaz tempo\b|\bja faz\b|\b(anos?|meses|semanas|dias) atras\b|\bmais de (24|vinte e quatro) horas\b|\bja cumpriram\b/;
const RE_RECENTE = /\b(agora|agorinha|neste momento|nesse momento|hoje|ontem|acab(ou|aram|ei|amos) de|essa (noite|madrugada|manha|tarde)|esta (noite|madrugada|manha|tarde)|de madrugada|ha (pouco|poucos minutos|\d+ (minutos?|horas?)|uma hora|duas horas|algumas horas)|faz (pouco|\d+ (minutos?|horas?)|uma hora|duas horas|algumas horas)|ultimas (24|vinte e quatro) horas|recente|agora ha pouco|agora pouco)\b/;
// "quero advogado agora" fala da contratacao, nao de quando foi o fato
const RE_AGORA_DA_CONTRATACAO = /\b(contratar|advogad[oa]s?|ajuda|atendimento|falar com alguem|resolver)( [a-z]+)? (agora|hoje|urgente)\b/g;

const RE_CONTRATAR_NAO = /\bnao (quero|vou|pretendo|preciso|posso) (contratar|pagar)|\bnao quero (advogad|contrat)|\bso (queria|quero|preciso|precisava) (saber|de uma informacao|uma informacao|tirar uma duvida|uma duvida|perguntar|entender|uma orientacao)|\b(e|era) so uma (duvida|informacao|pergunta|curiosidade)\b|\bso uma (duvida|informacao|pergunta)\b|\bdepois eu vejo\b|\bvou pensar\b|\bvou ver\b|\bnao tenho (dinheiro|condic)|\bja tenho advogad|\bdefensoria\b|\bde graca\b|\bgratuit[oa]\b|\bagora nao\b|\bpor enquanto nao\b/;
const RE_CONTRATAR_SIM = /\bquero (contratar|um advogado|uma advogada|advogado|advogada|que (voces|vcs|o escritorio|a doutora|o doutor) (acompanhe|assuma|pegue|cuide))|\bpreciso (de |contratar )(um |uma )?advogad|\bpode(m)? (assumir|pegar o caso|acompanhar|mandar (o|a) advogad)|\bvamos contratar\b|\bquero sim\b|\bcontratar (agora|ja|sim)\b|\bquero contrata/;

const PARENTES = 'marido|esposo|esposa|mulher|companheiro|companheira|namorado|namorada|noivo|noiva|filho|filha|enteado|enteada|pai|mae|irmao|irma|tio|tia|primo|prima|sobrinho|sobrinha|neto|neta|avo|cunhado|cunhada|sogro|sogra|genro|nora|amigo|amiga|vizinho|vizinha|funcionario|funcionaria|patrao|chefe|cliente|socio|socia';
const RE_PARENTE = new RegExp(`\\b(?:meu|minha|do meu|da minha|o meu|a minha) (${PARENTES})\\b`);
const RE_PARENTE_SOLTO = new RegExp(`^(?:e |eh |sou )?(?:o |a |seu |sua )?(${PARENTES})(?: dele| dela)?\\b`);
const RE_PROPRIA_PESSOA = /\b(sou eu|eu mesm[oa]|a propria pessoa|o proprio|eu fui pres[oa]|me prenderam|estou pres[oa]|estou detid[oa]|e comigo|e meu\b|e minha\b|meu (carro|veiculo|caminhao|imovel|apartamento|comercio|nome)|minha (casa|moto|empresa|loja|porta|residencia))/;

const RE_OFICIAL_SIM = /\b(oficial|policia|policiais|viatura|guincho|delegado)\b.{0,40}\b(na (minha )?porta|aqui|no local|chegou|chegaram|acabou de chegar|esta aqui|estao aqui)\b|\b(estao|tao|esta|ta) (levando|apreendendo|guinchando|rebocando|arrombando|invadindo|revistando|recolhendo|cumprindo)\b|\b(ainda )?(esta|estao|ta|tao) (aqui|ai|la|no local|na porta)\b|\bna (minha )?porta\b/;
const RE_OFICIAL_NAO = /\bja (foi|foram) embora\b|\bfoi embora\b|\bforam embora\b|\bja (saiu|sairam|levou|levaram)\b|\bnao esta mais\b|\bnao estao mais\b|\bnao tem ninguem\b|\bainda nao (chegou|chegaram|veio|vieram)\b|\bso (recebi|chegou) (a |uma )?(carta|notificacao|intimacao)\b/;

function limpar(texto, max) {
  const s = String(texto == null ? '' : texto).replace(/^[ \t]*\[[ÁA]UDIO TRANSCRITO\][ \t]*/gim, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

// Le o texto do cliente e devolve SO as respostas que ele trouxe.
//   abertura = true      -> primeira mensagem da triagem (a que disparou o detector)
//   perguntaPendente     -> chave da pergunta que a Ana acabou de fazer (a resposta
//                           pode ser curta: "sim", "Sarandi", "meu marido")
function extrairRespostas(texto, { tipo = 'prisao', perguntaPendente = null, abertura = false, regiao = REGIAO_PADRAO } = {}) {
  const original = limpar(texto, 2000);
  const t = normalizar(original);
  const out = {};
  if (!t) return out;

  // quando foi (so na abertura ou respondendo a pergunta: "agora" solto em outra
  // mensagem costuma falar de outra coisa)
  if (abertura || perguntaPendente === 'atual') {
    const semContratacao = t.replace(RE_AGORA_DA_CONTRATACAO, ' ');
    if (RE_PASSADO.test(t)) out.atual = false;
    else if (RE_RECENTE.test(semContratacao)) out.atual = true;
    else if (perguntaPendente === 'atual' && RE_SIM.test(t)) out.atual = true;
  }

  // oficial ou policia no local (busca e apreensao)
  if (tipo === 'busca_apreensao') {
    if (RE_OFICIAL_NAO.test(t)) out.oficialNoLocal = false;
    else if ((abertura || perguntaPendente === 'oficialNoLocal') && RE_OFICIAL_SIM.test(t)) out.oficialNoLocal = true;
    else if (perguntaPendente === 'oficialNoLocal' && RE_SIM.test(t)) out.oficialNoLocal = true;
    else if (perguntaPendente === 'oficialNoLocal' && RE_NAO.test(t)) out.oficialNoLocal = false;
    if (out.oficialNoLocal === true && out.atual === undefined) out.atual = true;
  }

  // cidade / regiao
  const dentro = cidadeNaRegiao(original, regiao);
  const fora = dentro ? null : cidadeForaDaRegiao(original, regiao);
  if (dentro) { out.cidade = dentro; out.naRegiao = true; }
  else if (fora) { out.cidade = fora; out.naRegiao = false; }
  else if (perguntaPendente === 'cidade') {
    if (RE_NAO_SEI.test(t)) { out.cidade = 'não soube informar'; out.naRegiao = null; }
    else {
      // So aceita como cidade (de fora) uma resposta curta com cara de lugar:
      // "em Jussara", "delegacia de Floresta". Desabafo ou outro assunto nao conta.
      const lugar = t.replace(/^(e |eh |fica |foi |esta |ta |la |aqui )*(em |na |no |n[ao] cidade de |cidade de |n?a? ?delegacia (de |da |do )?|n?a? ?cadeia (de |da |do )?)*/, '').replace(/[.,!?]+$/, '').trim();
      const palavras = lugar.split(' ').filter(Boolean);
      const naoELugar = /\b(ele|ela|eles|elas|eu|nao|sim|quero|queria|muito|esta|ta|foi|foram|meu|minha|deus|socorro|sei|so|ajuda|favor|obrigad[oa]|agora|ja|preciso|pode|vou|tem|que|como|quando|onde|porque|contratar|advogad[oa]|urgente|rapido|embora)\b/.test(lugar);
      if (palavras.length >= 1 && palavras.length <= 4 && !naoELugar) { out.cidade = limpar(original, 60); out.naRegiao = false; }
    }
  }

  // vinculo com a pessoa presa / com o bem
  const parente = RE_PARENTE.exec(t) || (perguntaPendente === 'vinculo' ? RE_PARENTE_SOLTO.exec(t) : null);
  if (parente) out.vinculo = parente[1];
  else if (RE_PROPRIA_PESSOA.test(t)) out.vinculo = 'a própria pessoa';
  else if (perguntaPendente === 'vinculo' && !RE_NAO_SEI.test(t)) out.vinculo = limpar(original, 40);

  // quer contratar agora
  if (RE_CONTRATAR_NAO.test(t)) out.contratar = false;
  else if (RE_CONTRATAR_SIM.test(t)) out.contratar = true;
  else if (perguntaPendente === 'contratar' && RE_NAO.test(t)) out.contratar = false;
  else if (perguntaPendente === 'contratar' && RE_SIM.test(t)) out.contratar = true;

  return out;
}

// ===========================================================================
// Decisao
// ===========================================================================

const ORDEM = {
  prisao: ['atual', 'cidade', 'vinculo', 'contratar'],
  busca_apreensao: ['oficialNoLocal', 'cidade', 'vinculo', 'contratar']
};

// Proxima pergunta a fazer (chave), ou null se nao falta nada
function proximaPergunta(tipo, respostas) {
  const r = respostas || {};
  for (const chave of ORDEM[tipo] || ORDEM.prisao) {
    if (chave === 'cidade') { if (r.naRegiao === undefined) return 'cidade'; continue; }
    if (r[chave] === undefined) return chave;
  }
  return null;
}

// O aviso imediato so sai se: fato atual E na regiao E quer contratar agora.
function qualifica(tipo, respostas) {
  const r = respostas || {};
  const atual = tipo === 'busca_apreensao' ? r.oficialNoLocal === true : r.atual === true;
  return atual && r.naRegiao === true && r.contratar === true;
}

// Status a partir das respostas: 'qualificado', um status final, ou 'em_triagem'
function decidirStatus(tipo, respostas) {
  const r = respostas || {};
  if (tipo === 'busca_apreensao' && r.oficialNoLocal === false) return STATUS.SEM_OFICIAL;
  if (r.atual === false) return STATUS.CASO_ANTIGO;
  if (r.naRegiao === false) return STATUS.FORA_REGIAO;
  if (r.contratar === false) return STATUS.NAO_CONTRATA;
  if (r.naRegiao === null) return STATUS.INCOMPLETO; // nao soube dizer a cidade
  if (qualifica(tipo, r)) return 'qualificado';
  return STATUS.EM_TRIAGEM;
}

const horasDesde = (iso, agoraMs) => {
  const t = new Date(iso || 0).getTime();
  return Number.isNaN(t) ? Infinity : (agoraMs - t) / 3600000;
};

// Processa um lote de mensagens do cliente.
// Devolve { triagem, mudou, enviarAlerta }:
//   triagem      -> o novo meta.urgenciaTriagem (ou o atual, se nada mudou; null se nao ha)
//   enviarAlerta -> true quando acabou de qualificar: quem chama envia o aviso
//                   e grava o status final com registrarEnvio()
function processarLote({ triagem = null, texto, deteccao = null, alertaRecente = false, agoraMs = Date.now(), regiao = REGIAO_PADRAO } = {}) {
  const agoraISO = new Date(agoraMs).toISOString();
  const detectou = !!(deteccao && deteccao.urgente);
  const atual = triagem && horasDesde(triagem.abertaEm, agoraMs) < TRIAGEM_VALIDADE_HORAS ? triagem : null;

  // Ja houve aviso imediato nesta janela: nada a fazer (deduplicacao)
  if (alertaRecente) return { triagem: triagem || null, mudou: false, enviarAlerta: false };

  // Abre uma triagem nova
  if (!atual || atual.status === STATUS.ALERTA_ENVIADO || atual.status === STATUS.ALERTA_FALHOU) {
    if (!detectou) return { triagem: triagem || null, mudou: false, enviarAlerta: false };
    const tipo = tipoDaUrgencia(deteccao.motivo);
    const respostas = extrairRespostas(texto, { tipo, abertura: true, regiao });
    return fechar({ status: STATUS.EM_TRIAGEM, tipo, motivo: deteccao.motivo, respostas, pergunta: null, tentativas: {},
      trecho: limpar(texto, 300), abertaEm: agoraISO }, agoraISO);
  }

  // Continua a triagem existente
  const emAndamento = atual.status === STATUS.EM_TRIAGEM || atual.status === STATUS.INCOMPLETO;
  const novas = extrairRespostas(texto, {
    tipo: atual.tipo, regiao, abertura: detectou,
    perguntaPendente: atual.status === STATUS.EM_TRIAGEM ? atual.pergunta : null
  });
  if (!Object.keys(novas).length && !emAndamento) return { triagem: atual, mudou: false, enviarAlerta: false };
  if (!Object.keys(novas).length && atual.status === STATUS.INCOMPLETO && !detectou) return { triagem: atual, mudou: false, enviarAlerta: false };
  return fechar({ ...atual, respostas: { ...(atual.respostas || {}), ...novas } }, agoraISO, atual.pergunta);
}

function fechar(t, agoraISO, perguntaAnterior = null) {
  const decisao = decidirStatus(t.tipo, t.respostas);
  const out = { ...t, atualizadoEm: agoraISO, tentativas: { ...(t.tentativas || {}) } };
  if (decisao === 'qualificado') {
    out.pergunta = null;
    return { triagem: out, mudou: true, enviarAlerta: true };
  }
  if (decisao !== STATUS.EM_TRIAGEM) {
    out.status = decisao;
    out.pergunta = null;
    return { triagem: out, mudou: true, enviarAlerta: false };
  }
  const prox = proximaPergunta(t.tipo, t.respostas);
  if (!prox) { // respondeu tudo e nao qualificou nem desqualificou: nao ha mais o que perguntar
    out.status = STATUS.INCOMPLETO;
    out.pergunta = null;
    return { triagem: out, mudou: true, enviarAlerta: false };
  }
  const feitas = out.tentativas[prox] || 0;
  if (prox === perguntaAnterior && feitas >= MAX_TENTATIVAS) { // ja perguntou duas vezes: nao insiste
    out.status = STATUS.INCOMPLETO;
    out.pergunta = null;
    return { triagem: out, mudou: true, enviarAlerta: false };
  }
  out.status = STATUS.EM_TRIAGEM;
  out.pergunta = prox;
  out.tentativas[prox] = feitas + 1;
  return { triagem: out, mudou: true, enviarAlerta: false };
}

// Depois de tentar o aviso: status conforme o que os canais responderam
function registrarEnvio(triagem, { confirmado }, agoraMs = Date.now()) {
  return { ...triagem, status: confirmado ? STATUS.ALERTA_ENVIADO : STATUS.ALERTA_FALHOU, pergunta: null,
    atualizadoEm: new Date(agoraMs).toISOString() };
}

// Encaminhamento formal marcado como urgente por prisao/busca, mas a triagem
// nao qualificou: a marca de URGENTE nao deve sair (o caso segue como lead normal).
function deveRebaixarUrgencia(meta, toolInput, agoraMs = Date.now()) {
  const t = meta && meta.urgenciaTriagem;
  if (!t || !toolInput || toolInput.urgencia !== true) return false;
  if (t.status === STATUS.ALERTA_ENVIADO || t.status === STATUS.ALERTA_FALHOU) return false;
  if (horasDesde(t.atualizadoEm, agoraMs) > TRIAGEM_VALIDADE_HORAS) return false;
  const assunto = normalizar(`${toolInput.motivo_urgencia || ''} ${toolInput.resumo_caso || ''}`);
  const outroMotivo = /\b(audiencia|prazo|violencia domestica|medida protetiva|agress)/.test(normalizar(toolInput.motivo_urgencia || ''));
  return !outroMotivo && /\b(pres[oa]s?|prisao|prenderam|flagrante|detid[oa]|busca e apreensao|oficial|mandado|apreens)/.test(assunto);
}

// ===========================================================================
// Blocos do system prompt
// ===========================================================================

const PERGUNTAS = {
  prisao: {
    atual: 'A prisão aconteceu agora, nas últimas 24 horas, ou é um caso mais antigo?',
    cidade: 'Em qual cidade ou delegacia a pessoa está detida?',
    vinculo: 'Qual é a sua relação com a pessoa que foi presa?',
    contratar: 'Você quer contratar um advogado agora para acompanhar o caso? O atendimento do escritório é particular.'
  },
  busca_apreensao: {
    oficialNoLocal: 'O oficial de justiça (ou a polícia) está aí no local neste momento?',
    cidade: 'Em qual cidade isso está acontecendo?',
    vinculo: 'O bem ou o mandado é no seu nome ou de outra pessoa? Se for de outra pessoa, qual a sua relação com ela?',
    contratar: 'Você quer contratar um advogado agora para acompanhar o caso? O atendimento do escritório é particular.'
  }
};

function descreverRespostas(triagem) {
  const r = (triagem && triagem.respostas) || {};
  const partes = [];
  if (r.atual === true) partes.push('quando: agora / últimas 24h');
  if (r.atual === false) partes.push('quando: caso antigo');
  if (r.oficialNoLocal === true) partes.push('oficial/polícia no local agora: sim');
  if (r.oficialNoLocal === false) partes.push('oficial/polícia no local agora: não');
  if (r.cidade) partes.push(`cidade: ${r.cidade}${r.naRegiao === true ? ' (na região)' : r.naRegiao === false ? ' (fora da região)' : ''}`);
  if (r.vinculo) partes.push(`vínculo: ${r.vinculo}`);
  if (r.contratar === true) partes.push('quer contratar agora: sim');
  if (r.contratar === false) partes.push('quer contratar agora: não');
  return partes;
}

const NAO_AVISADO = 'NENHUM advogado foi avisado até agora: NÃO diga que avisou, que já avisou ou que vai avisar agora o Dr. Willian ou a Dra. Aline. ';
const SEMPRE = 'Não prometa resultado nem em quanto tempo alguém liga. Não pergunte como a pessoa conheceu o escritório. ' +
  'Se houver risco à vida ou violência acontecendo, oriente primeiro o 190 (e o 180, em violência contra a mulher).';

// Bloco conforme o status da triagem ('' quando nao ha nada a dizer).
// (Para "alerta_enviado" vale o bloco de urgencia em curso do origem.js.)
function blocoTriagemPrompt(triagem) {
  if (!triagem) return '';
  const tipoTxt = triagem.tipo === 'busca_apreensao' ? 'busca e apreensão / mandado' : 'prisão';
  const sabe = descreverRespostas(triagem);
  const jaSabe = sabe.length ? `Já sabemos (não pergunte de novo): ${sabe.join('; ')}. ` : '';

  if (triagem.status === STATUS.EM_TRIAGEM && triagem.pergunta) {
    const pergunta = (PERGUNTAS[triagem.tipo] || PERGUNTAS.prisao)[triagem.pergunta];
    return `\n\nTRIAGEM DE URGÊNCIA (dados do sistema): a pessoa relatou ${tipoTxt} possivelmente em curso. ` + NAO_AVISADO +
      `NÃO chame ferramenta de encaminhamento nesta resposta. ${jaSabe}` +
      `Tranquilize a pessoa em uma frase e faça APENAS esta pergunta, com as suas palavras e em tom de conversa: "${pergunta}" ` +
      `Uma pergunta por vez; não é formulário. ${SEMPRE}`;
  }
  if (triagem.status === STATUS.ALERTA_FALHOU) {
    return `\n\nTRIAGEM DE URGÊNCIA (dados do sistema): o caso se qualificou como urgente, mas o aviso automático aos advogados NÃO foi confirmado. ` +
      `Não diga que eles já foram avisados. NESTA MESMA resposta, chame a ferramenta de encaminhamento (notificar_especialista, ou triar_caso_trabalhista se for trabalhista) ` +
      `com urgencia = true, usando o que já tiver ("não informado" para o que faltar, horário "o quanto antes"), e diga que está acionando o advogado. ${SEMPRE}`;
  }
  if (triagem.status === STATUS.NAO_CONTRATA) {
    return `\n\nTRIAGEM DE URGÊNCIA (dados do sistema): a pessoa disse que não quer contratar um advogado agora. ` + NAO_AVISADO +
      `Agradeça com acolhimento e diga que o escritório fica à disposição se ela mudar de ideia. Não pressione, não fale de valores de honorários ` +
      `e não marque urgencia = true por este motivo. ${SEMPRE}`;
  }
  if ([STATUS.CASO_ANTIGO, STATUS.FORA_REGIAO, STATUS.SEM_OFICIAL, STATUS.INCOMPLETO].includes(triagem.status)) {
    const motivo = {
      caso_antigo: 'o fato não é das últimas 24 horas',
      fora_regiao: 'o caso é fora da região de atendimento imediato do escritório (Maringá e região)',
      sem_oficial: 'o oficial ou a polícia não está no local neste momento',
      incompleto: 'não foi possível confirmar os dados para o atendimento imediato'
    }[triagem.status];
    return `\n\nTRIAGEM DE URGÊNCIA (dados do sistema): este caso NÃO vai para o aviso imediato porque ${motivo}. ` + NAO_AVISADO +
      `${jaSabe}Explique com simplicidade que o escritório avalia esse tipo de caso no horário de expediente e que ela pode deixar o contato ` +
      `(nome e melhor horário). Siga o atendimento normal, sem marcar urgencia = true por este motivo. ${SEMPRE}`;
  }
  return '';
}

// ===========================================================================
// Resumo matinal
// ===========================================================================

function horaDigest(env = process.env) {
  const s = String(env.URGENCIA_DIGEST_HORA == null ? '' : env.URGENCIA_DIGEST_HORA).trim();
  return /^\d{1,2}$/.test(s) && Number(s) <= 24 ? Number(s) : DIGEST_HORA_PADRAO;
}

// Entra no resumo: passou pelo detector, NAO teve aviso imediato enviado e ainda
// nao entrou em nenhum resumo. Triagem ainda em andamento so entra se a pessoa
// parou de responder.
function entraNoDigest(triagem, agoraMs = Date.now()) {
  if (!triagem || !triagem.status || triagem.digestEm) return false;
  if (triagem.status === STATUS.ALERTA_ENVIADO) return false;
  if (triagem.status === STATUS.EM_TRIAGEM) return horasDesde(triagem.atualizadoEm, agoraMs) * 60 >= TRIAGEM_PARADA_MINUTOS;
  return true;
}

// rows: [{ phone, meta }] -> so os leads que entram no resumo
function leadsParaDigest(rows, agoraMs = Date.now()) {
  return (rows || []).filter(r => r && r.phone && entraNoDigest(r.meta && r.meta.urgenciaTriagem, agoraMs));
}

// Marca a triagem como incluida no resumo (em_triagem parado vira incompleto)
function marcarNoDigest(triagem, agoraMs = Date.now()) {
  return { ...triagem, status: triagem.status === STATUS.EM_TRIAGEM ? STATUS.INCOMPLETO : triagem.status, pergunta: null,
    digestEm: new Date(agoraMs).toISOString() };
}

const escHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Texto do resumo matinal. leads: [{ phone, meta }], ja filtrados.
// origemTxt: funcao codigo -> "Instagram (INSTA)". Devolve null se nao ha leads.
function montarResumoMatinal(leads, { origemTxt = () => '', agoraMs = Date.now() } = {}) {
  const lista = leadsParaDigest(leads, agoraMs);
  if (!lista.length) return null;
  const itens = lista.map((l, i) => {
    const meta = l.meta || {};
    const t = meta.urgenciaTriagem;
    const status = t.status === STATUS.EM_TRIAGEM ? ROTULOS_STATUS.incompleto : (ROTULOS_STATUS[t.status] || t.status);
    const respostas = descreverRespostas(t);
    return {
      n: i + 1,
      nome: String(meta.nome || '').trim() || 'não informado',
      phone: l.phone,
      origem: origemTxt(meta.origem) || 'não informada',
      tipo: t.tipo === 'busca_apreensao' ? 'busca e apreensão' : 'prisão',
      status,
      respostas: respostas.length ? respostas.join('; ') : 'sem respostas',
      trecho: limpar(t.trecho, 200) || 'sem trecho'
    };
  });
  const texto = `🌅 *${TITULO_DIGEST}*\n` +
    `${itens.length} caso(s) que passaram pela triagem sem aviso imediato:\n\n` +
    itens.map(i =>
      `*${i.n}.* ${i.nome} — +${i.phone}\n` +
      `🏷️ Origem: ${i.origem}\n` +
      `📌 ${i.tipo} — ${i.status}\n` +
      `🗒️ ${i.respostas}\n` +
      `💬 "${i.trecho}"`).join('\n\n') +
    `\n\n_Nenhum destes gerou aviso de madrugada. Veja as conversas no painel._`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:680px"><h2 style="color:#1a5276">${escHtml(TITULO_DIGEST)}</h2>` +
    `<p>${itens.length} caso(s) que passaram pela triagem sem aviso imediato:</p>` +
    itens.map(i => `<p style="background:#f6f6f6;padding:10px;border-left:4px solid #1a5276"><b>${i.n}. ${escHtml(i.nome)}</b> — +${escHtml(i.phone)}<br>` +
      `<b>Origem:</b> ${escHtml(i.origem)}<br><b>Tipo e status:</b> ${escHtml(i.tipo)} — ${escHtml(i.status)}<br>` +
      `<b>Respostas:</b> ${escHtml(i.respostas)}<br><b>Trecho:</b> ${escHtml(i.trecho)}</p>`).join('') +
    `<small style="color:#888">Nenhum destes gerou aviso de madrugada. Veja as conversas no painel.</small></div>`;
  return {
    titulo: TITULO_DIGEST,
    assunto: `${TITULO_DIGEST} (${itens.length})`,
    resumoCurto: itens.map(i => `${i.nome} +${i.phone} (${i.status})`).join(' | '),
    texto, html, itens, leads: lista
  };
}

// Um ciclo do resumo matinal, com as dependencias injetadas (testavel sem rede):
//   agora = { ymd, hora } de Brasilia; hora = hora minima (8)
//   lerMarcador() -> ymd do ultimo resumo; gravarMarcador(ymd, n)
//   listarLeads() -> [{ phone, meta }]; enviar(resumo) -> true se algum canal confirmou
//   marcarLead(lead) -> grava digestEm na conversa
// Devolve 'antes_da_hora' | 'ja_enviado' | 'sem_leads' | 'enviado' | 'falhou'.
async function executarDigest({ agora, hora = DIGEST_HORA_PADRAO, lerMarcador, gravarMarcador, listarLeads, enviar, marcarLead, origemTxt, agoraMs = Date.now() }) {
  if (agora.hora < hora) return 'antes_da_hora';
  if ((await lerMarcador()) === agora.ymd) return 'ja_enviado';
  const resumo = montarResumoMatinal(await listarLeads(), { origemTxt, agoraMs });
  if (!resumo) {
    await gravarMarcador(agora.ymd, 0);
    return 'sem_leads';
  }
  if (!(await enviar(resumo))) return 'falhou';
  await gravarMarcador(agora.ymd, resumo.leads.length);
  for (const lead of resumo.leads) await marcarLead(lead);
  return 'enviado';
}

module.exports = {
  STATUS,
  ROTULOS_STATUS,
  TITULO_DIGEST,
  DIGEST_HORA_PADRAO,
  REGIAO_PADRAO,
  PERGUNTAS,
  listaRegiao,
  cidadeNaRegiao,
  naRegiao,
  cidadeForaDaRegiao,
  tipoDaUrgencia,
  extrairRespostas,
  proximaPergunta,
  qualifica,
  decidirStatus,
  processarLote,
  registrarEnvio,
  deveRebaixarUrgencia,
  descreverRespostas,
  blocoTriagemPrompt,
  horaDigest,
  entraNoDigest,
  leadsParaDigest,
  marcarNoDigest,
  montarResumoMatinal,
  executarDigest
};
