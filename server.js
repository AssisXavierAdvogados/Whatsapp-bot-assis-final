const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HISTORY_FILE = path.join('/tmp', 'conversation_history.json');

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history), 'utf8');
  } catch (e) {}
}

// === Supabase: arquivo permanente das conversas (sobrevive a restart) ===
function supabaseEnabled() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

// Grava (upsert) a conversa de um numero. Fire-and-forget: nao trava a resposta.
async function supabaseUpsert(phone, messages, extra = {}) {
  if (!supabaseEnabled() || !phone || !Array.isArray(messages)) return;
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/conversations`,
      { phone, messages, updated_at: new Date().toISOString(), ...extra },
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        }
      }
    );
  } catch (e) {
    console.error('[Supabase] Erro ao gravar:', e.response?.data || e.message);
  }
}

// Marca/atualiza um campo da conversa (ex: handled=true)
async function supabasePatch(phone, fields) {
  if (!supabaseEnabled() || !phone) return false;
  try {
    await axios.patch(
      `${SUPABASE_URL}/rest/v1/conversations?phone=eq.${encodeURIComponent(phone)}`,
      fields,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (e) {
    console.error('[Supabase] Erro ao atualizar:', e.response?.data || e.message);
    return false;
  }
}

// Le todas as conversas arquivadas (para o painel /admin)
async function supabaseGetAll() {
  if (!supabaseEnabled()) return null;
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/conversations?select=phone,messages,updated_at,meta,handled&order=updated_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return r.data;
  } catch (e) {
    console.error('[Supabase] Erro ao ler:', e.response?.data || e.message);
    return null;
  }
}

// Carrega historico de um numero especifico do Supabase (lazy, sob demanda)
async function supabaseLoadOne(phone) {
  if (!supabaseEnabled() || !phone) return null;
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/conversations?phone=eq.${encodeURIComponent(phone)}&select=messages,meta`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (r.data && r.data.length > 0) return r.data[0];
  } catch (e) {
    console.error('[Supabase] Erro ao carregar histórico individual:', e.message);
  }
  return null;
}

// Status real de entrega vindo do Meta (delivered/read/failed), indexado pelo wamid.
// Permite saber se uma notificacao REALMENTE chegou, e nao so se foi aceita na fila.
const deliveryStatus = {};

// Metadados da conversa (nome, area, especialista) capturados ao notificar
const conversationMeta = {};

// Documentos enviados pelo cliente durante a conversa (para anexar ao notificar o especialista)
const clientDocuments = {};

// Triagem de casos trabalhistas: guarda os casos aguardando o SIM/NAO do especialista.
// Cada caso vira uma linha propria no Supabase (phone = "TRIAGE#<codigo>") para
// sobreviver a um restart do Render enquanto o especialista ainda nao respondeu.
// Como essas linhas tem messages=[], o painel /admin as ignora automaticamente.
const pendingTriage = {};   // codigo -> { clientPhone, area, nome, horario, resumo, salario, tempo, specialistPhone, triageMsgId }
const triageByMsgId = {};   // id da mensagem de triagem enviada -> codigo (casa o "responder" do WhatsApp)

function triageRowPhone(code) { return `TRIAGE#${code}`; }

function genTriageCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I para nao confundir
  let c = '';
  for (let i = 0; i < 3; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function saveTriage(code, data) {
  pendingTriage[code] = data;
  if (data.triageMsgId) triageByMsgId[data.triageMsgId] = code;
  supabaseUpsert(triageRowPhone(code), [], { meta: { type: 'triage', code, ...data }, handled: false });
}

// Recupera uma triagem pelo codigo, restaurando do Supabase se a memoria foi
// zerada por um restart do Render entre o envio e a resposta do especialista.
async function loadTriage(code) {
  if (pendingTriage[code]) return pendingTriage[code];
  const saved = await supabaseLoadOne(triageRowPhone(code));
  if (saved && saved.meta && saved.meta.type === 'triage' && !saved.meta.resolved) {
    pendingTriage[code] = saved.meta;
    return saved.meta;
  }
  return null;
}

function clearTriage(code) {
  const data = pendingTriage[code];
  if (data && data.triageMsgId) delete triageByMsgId[data.triageMsgId];
  delete pendingTriage[code];
  // Marca como resolvida (nao apaga, para manter rastro de auditoria)
  supabasePatch(triageRowPhone(code), { meta: { type: 'triage', code, resolved: true }, handled: true });
}

// Salva no arquivo local E arquiva o numero no Supabase.
// Os documentos do cliente (clientDocuments) viajam dentro do proprio campo
// "meta" (sem precisar de coluna nova no Supabase) para sobreviver a um
// restart do Render antes do caso ser encaminhado ao especialista.
function persist(userId) {
  saveHistory(conversationHistory);
  const metaBase = conversationMeta[userId] || {};
  const docs = clientDocuments[userId];
  const meta = (docs && docs.length) ? { ...metaBase, documents: docs } : metaBase;
  const extra = Object.keys(meta).length ? { meta } : {};
  supabaseUpsert(userId, conversationHistory[userId], extra);
}

// Garante que o historico, os metadados e os documentos do cliente estejam
// em memoria, restaurando do Supabase quando o processo acabou de reiniciar
// (Render free tier derruba a instancia por inatividade e zera tudo em RAM).
async function ensureStateLoaded(userId) {
  if (!conversationHistory[userId] || !clientDocuments[userId]) {
    const saved = await supabaseLoadOne(userId);
    if (saved) {
      if (!conversationHistory[userId] && Array.isArray(saved.messages) && saved.messages.length > 0) {
        conversationHistory[userId] = saved.messages;
        console.log(`[Supabase] Histórico restaurado para ${userId}: ${saved.messages.length} msgs`);
      }
      if (saved.meta) {
        const { documents, ...metaRest } = saved.meta;
        if (!conversationMeta[userId] && Object.keys(metaRest).length) conversationMeta[userId] = metaRest;
        if (!clientDocuments[userId] && Array.isArray(documents) && documents.length) {
          clientDocuments[userId] = documents;
          console.log(`[Supabase] ${documents.length} documento(s) restaurado(s) para ${userId}`);
        }
      }
    }
  }
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  if (!clientDocuments[userId]) clientDocuments[userId] = [];
}

// Serializa as chamadas a Claude por numero de telefone: evita que dois
// arquivos/mensagens enviados em sequencia rapida pelo mesmo cliente sejam
// processados em paralelo e corrompam o historico (duas mensagens "user"
// seguidas sem resposta "assistant" entre elas fazem a API do Claude
// rejeitar TODAS as chamadas futuras daquele numero com erro 400).
const userCallQueue = {};
function enqueueForUser(userId, taskFn) {
  const previous = userCallQueue[userId] || Promise.resolve();
  const next = previous.then(taskFn, taskFn);
  userCallQueue[userId] = next;
  return next;
}

// Mantem so as ultimas N entradas do historico, mas nunca corta entre um
// tool_use e seu tool_result correspondente — a API do Claude exige que
// todo tool_result venha logo depois do tool_use que o originou; cortar
// nesse meio quebraria TODAS as chamadas futuras daquele cliente.
function trimHistory(history, maxLen) {
  if (history.length <= maxLen) return history;
  let start = history.length - maxLen;
  while (start > 0 && Array.isArray(history[start].content) && history[start].content.some(b => b.type === 'tool_result')) {
    start--;
  }
  return history.slice(start);
}

// Sana o historico ANTES de enviar a API do Claude, para que conversas que
// JA foram gravadas corrompidas (ex: duas mensagens "user" seguidas por uma
// corrida antiga, ou um tool_use sem tool_result) voltem a funcionar sozinhas
// na proxima mensagem — em vez de ficar em loop eterno de "problema tecnico".
// A API exige: comeca com user, papeis alternam, e todo tool_use tem seu
// tool_result correspondente (e vice-versa).
function sanitizeMessages(rawMessages) {
  const toolUseIds = new Set();
  const toolResultIds = new Set();
  for (const m of rawMessages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') toolUseIds.add(b.id);
        if (b.type === 'tool_result') toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // 1) Remove blocos de ferramenta orfaos (sem o par correspondente)
  const cleaned = [];
  for (const m of rawMessages) {
    let content = m.content;
    if (Array.isArray(content)) {
      const filtered = content.filter(b => {
        if (b.type === 'tool_use') return toolResultIds.has(b.id);
        if (b.type === 'tool_result') return toolUseIds.has(b.tool_use_id);
        return true;
      });
      if (filtered.length === 0) continue; // mensagem ficou vazia: descarta
      content = filtered;
    } else if (typeof content !== 'string' || content.trim() === '') {
      if (typeof content === 'string') continue; // texto vazio: descarta
    }
    cleaned.push({ role: m.role, content });
  }

  // 2) Funde mensagens consecutivas do mesmo papel
  const toArr = c => Array.isArray(c) ? c : [{ type: 'text', text: String(c) }];
  const merged = [];
  for (const m of cleaned) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      if (typeof last.content === 'string' && typeof m.content === 'string') {
        last.content = `${last.content}\n${m.content}`;
      } else {
        last.content = [...toArr(last.content), ...toArr(m.content)];
      }
    } else {
      merged.push({ role: m.role, content: m.content });
    }
  }

  // 3) Garante que a conversa comeca com 'user'
  while (merged.length && merged[0].role !== 'user') merged.shift();

  return merged;
}

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'assis-xavier-verify-token';
const ESCRITORIO_PHONE = process.env.ESCRITORIO_PHONE || '+55 (44)99977-8551';
const EMAIL_FROM = process.env.GMAIL_USER; // remetente (email verificado no Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME; // ex: novo_lead (aprovado no Meta)
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'pt_BR';
const SUPABASE_URL = process.env.SUPABASE_URL;   // ex: https://xxxx.supabase.co
const SUPABASE_KEY = process.env.SUPABASE_KEY;   // secret key do Supabase

const SPECIALISTS = {
  trabalhista:    { name: 'Dr. Rafael Jorge Pinhatti', phone: '5544991128087', email: 'rafaelpinhatti_adv@hotmail.com' },
  imobiliario:    { name: 'Dr. Willian Assis',         phone: '5544999784442', email: 'willianr.assis@outlook.com' },
  tributario:     { name: 'Dr. Willian Assis',         phone: '5544999784442', email: 'willianr.assis@outlook.com' },
  civel_bancario: { name: 'Dr. Willian Assis',         phone: '5544999784442', email: 'willianr.assis@outlook.com' },
  empresarial:    { name: 'Dr. Willian Assis',         phone: '5544999784442', email: 'willianr.assis@outlook.com' },
  consumidor:     { name: 'Dr. Willian Assis',         phone: '5544999784442', email: 'willianr.assis@outlook.com' },
  familia:        { name: 'Dra. Aline Xavier',         phone: '5544991651532', email: 'alinex.assis@gmail.com' },
  criminal:       { name: 'Dra. Aline Xavier',         phone: '5544991651532', email: 'alinex.assis@gmail.com' },
  previdenciario: { name: 'Dra. Aline Xavier',         phone: '5544991651532', email: 'alinex.assis@gmail.com' },
};

// Admin do escritorio: recebe copia de TODOS os atendimentos notificados
const ADMIN_PHONE = '5544999784442';
const ADMIN_EMAIL = 'willianr.assis@outlook.com';

// --- Reconhecimento de numeros (especialistas) ---
// No Brasil o Meta as vezes entrega o numero do celular SEM o 9 extra apos o DDD.
// Geramos as duas formas (com e sem o 9) para comparar de forma tolerante e nao
// tratar um advogado do escritorio como se fosse um cliente novo.
function phoneVariants(p) {
  p = String(p || '').replace(/\D/g, '');
  const set = new Set();
  if (!p) return set;
  set.add(p);
  const com9 = p.match(/^(55)(\d{2})9(\d{8})$/);   // 13 digitos, com 9
  if (com9) set.add(com9[1] + com9[2] + com9[3]);   // -> 12 digitos, sem 9
  const sem9 = p.match(/^(55)(\d{2})(\d{8})$/);     // 12 digitos, sem 9
  if (sem9) set.add(sem9[1] + sem9[2] + '9' + sem9[3]); // -> 13 digitos, com 9
  return set;
}
function phonesMatch(a, b) {
  const A = phoneVariants(a);
  for (const v of phoneVariants(b)) if (A.has(v)) return true;
  return false;
}

// Retorna o objeto do especialista cujo numero bate com o telefone dado (ou null).
// Como Dr. Willian aparece em varias areas, devolvemos o primeiro que casar.
function findSpecialistByPhone(phone) {
  for (const key of Object.keys(SPECIALISTS)) {
    if (phonesMatch(SPECIALISTS[key].phone, phone)) return SPECIALISTS[key];
  }
  return null;
}

// Busca triagens pendentes de um especialista direto no Supabase (sobrevive a
// restart do Render, quando a memoria foi zerada). As linhas de triagem tem
// phone comecando com "TRIAGE#".
async function supabaseFindPendingTriages(specialistPhone) {
  if (!supabaseEnabled()) return [];
  try {
    const r = await axios.get(
      `${SUPABASE_URL}/rest/v1/conversations?phone=like.TRIAGE*&handled=eq.false&select=meta`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return (r.data || [])
      .map(row => row.meta)
      .filter(m => m && m.type === 'triage' && !m.resolved && phonesMatch(m.specialistPhone, specialistPhone));
  } catch (e) {
    console.error('[Triagem] Erro ao buscar pendentes:', e.message);
    return [];
  }
}

// Lista triagens pendentes de um especialista (memoria + Supabase, sem duplicar).
async function listPendingTriages(specialistPhone) {
  const byCode = {};
  for (const [code, t] of Object.entries(pendingTriage)) {
    if (phonesMatch(t.specialistPhone, specialistPhone)) byCode[code] = t;
  }
  for (const m of await supabaseFindPendingTriages(specialistPhone)) {
    if (m.code && !byCode[m.code]) byCode[m.code] = m;
  }
  return Object.entries(byCode).map(([code, t]) => ({ code, nome: t.nome }));
}

// Mensagens enviadas ao cliente apos a triagem trabalhista (decisao do especialista).
// Emendam na conversa ja em andamento (sem "Ola"), num tom natural e formal.
function triageAcceptMessage(nome, horario) {
  const primeiroNome = (nome || '').trim().split(' ')[0] || '';
  const saud = primeiroNome ? `${primeiroNome}, ` : '';
  const quando = horario ? ` no horario que voce indicou (${horario})` : '';
  return `${saud}boa noticia! Confirmei com o nosso especialista e vamos poder cuidar do seu caso. ` +
    `O Dr. Rafael Jorge Pinhatti vai entrar em contato com voce${quando}. Fico a disposicao se precisar de algo.`;
}

function triageDeclineMessage(nome) {
  const primeiroNome = (nome || '').trim().split(' ')[0] || '';
  const saud = primeiroNome ? `${primeiroNome}, ` : '';
  return `${saud}encaminhei seu caso ao nosso especialista e, apos uma analise inicial, verificamos que ` +
    `neste momento nao poderemos assumir o seu processo.\n\n` +
    `Isso nao significa que voce nao tenha direitos — apenas que, no momento, nao conseguimos oferecer ` +
    `o atendimento adequado a essa demanda especifica. Se desejar, pode buscar orientacao junto a OAB da ` +
    `sua cidade ou a Defensoria Publica.\n\n` +
    `Agradeco muito a sua confianca e desejo sucesso na resolucao da sua questao. ` +
    `Atenciosamente, Assis e Xavier Advogados.`;
}

const OFFICE_CONTEXT = `
Voce e Ana, atendente do Assis e Xavier Advogados, escritorio juridico full service em Maringa, Parana.

SUA IDENTIDADE:
- Seu nome e Ana
- Voce e atendente do escritorio Assis e Xavier Advogados
- Quando se apresentar, diga: "Sou a Ana, do escritorio Assis e Xavier Advogados"
- Nunca diga apenas "Assis Xavier" - sempre o nome completo: "Assis e Xavier Advogados"
- Voce e humana - nunca revele que e uma IA, assistente virtual ou robo
- Se perguntarem diretamente se e robo ou IA, diga que e atendente e mude o foco para o cliente
- Tom: acolhedor, natural, como uma pessoa real que se importa com o problema

REGRAS DE OURO:
- Respostas CURTAS - maximo 3 linhas por mensagem
- Faca apenas UMA pergunta por vez
- Nunca despeje listas, topicos ou bullet points
- Nunca mencione "WhatsApp", "contato via WhatsApp" ou o numero do escritorio como solucao
- Nunca invente informacoes juridicas nem de pareceres definitivos
- Nunca use termos como "Claro!", "Com certeza!", "Ola!" repetidamente - varie

ESPECIALISTAS DO ESCRITORIO:
- Trabalhista -> Dr. Rafael Jorge Pinhatti
- Imobiliario, Tributario, Civel/Bancario, Empresarial, Consumidor -> Dr. Willian Assis
- Familia, Criminal e Previdenciario -> Dra. Aline Xavier

FLUXO DE ATENDIMENTO - SIGA RIGOROSAMENTE:
1. Primeira mensagem de uma conversa nova: apresente-se brevemente ("Sou a Ana, do escritorio Assis e Xavier Advogados") e pergunte, de forma acolhedora, o NOME da pessoa antes de qualquer outra coisa.
2. Com o nome em maos, use-o naturalmente e ai sim pergunte o que esta acontecendo / no que pode ajudar.
3. Com a resposta, identifique a area juridica.
- IMPORTANTE: nunca peca o caso antes do nome numa conversa nova. Se a pessoa ja contar o problema junto com o "oi", agradeca, pergunte o nome dela e so entao siga.

QUALIFICACAO - SEJA AGIL E NATURAL:
- Peca ao cliente que conte o que aconteceu, com datas e como foi. Pode perguntar de forma leve, sem pressao.
- Se a situacao ja ficou clara, nao faca mais perguntas - va direto para documentos.
- Se faltar algum detalhe importante, faca UMA pergunta pontual. So uma.
- Assim que entender o problema, pergunte se a pessoa tem algum documento ou comprovante.
- O aprofundamento do caso e papel do especialista na consulta - Ana so precisa do essencial.
- Bom senso: conversa curta e objetiva, sem interrogatorio, sem loop infinito de perguntas.

APOS A QUALIFICACAO:
- Se enviou documento: analise e informe o resultado de forma simples
- Peca o nome do cliente
- Pergunte o melhor horario para o especialista ligar
- Com nome + horario: use a ferramenta notificar_especialista e encerre

QUANDO CLIENTE DISSER QUE O ESPECIALISTA NAO LIGOU:
- Use imediatamente a ferramenta reenviar_lembrete
- Seja empatico: "Entendo, [nome]. Ja enviei um novo aviso para o [Dr./Dra. X]. Ele vai entrar em contato com voce em breve."
- Nao de desculpas pelo especialista

IMPORTANTE - APRESENTACAO:
- Se ja existe historico de conversa, NUNCA se apresente novamente. Retome naturalmente de onde parou.
- Se souber o nome do cliente, use-o naturalmente na conversa.
- So se apresente uma unica vez, na primeira mensagem de uma conversa completamente nova.

IMPORTANTE - NOME DO CLIENTE:
- Quando o cliente informar o nome dele, use esse nome para se referir A ELE, nunca como se fosse o seu proprio nome.
- Seu nome e ANA, sempre. O nome que o cliente informa e o nome DELE.
- Exemplo correto: cliente diz "Mava" -> voce responde "Obrigada, Mava! Qual o melhor horario..."
- Nunca diga "meu nome e [nome do cliente]" - isso e um erro grave.
- Nunca mencione "sistema anterior", "nao reconhecido" ou qualquer referencia tecnica ao cliente.

IMPORTANTE - ANALISE DE DOCUMENTOS:
- Quando receber uma mensagem com "[ANALISE DO DOCUMENTO]", use o resultado para informar o cliente de forma simples
- Foque na conclusao: a pessoa tem chances ou nao tem?
- Apos informar, continue o fluxo: peca o nome e horario

IMPORTANTE - FERRAMENTAS:
- Use notificar_especialista quando tiver: nome do cliente, situacao clara e horario preferido (EXCETO casos trabalhistas)
- Use reenviar_lembrete quando cliente disser que nao foi contatado
- Apos usar qualquer ferramenta, confirme ao cliente de forma natural

IMPORTANTE - CASOS TRABALHISTAS (REGRA ESPECIAL):
- Para caso trabalhista, NUNCA use notificar_especialista. Use SEMPRE triar_caso_trabalhista.
- Antes de triar, alem do que aconteceu, colete de forma natural (sem interrogatorio): o ultimo salario do cliente, ha quanto tempo trabalhou na empresa (ou quando saiu), nome e melhor horario.
- Quando tiver esses dados, chame triar_caso_trabalhista. O escritorio faz uma analise antes de assumir o caso.
- Depois de triar: diga ao cliente, de forma acolhedora, que vai confirmar a disponibilidade com o especialista e retorna em seguida. NAO prometa que o especialista vai ligar ainda - isso depende da confirmacao.
- A resposta final (se o escritorio assume ou nao) sera enviada automaticamente ao cliente. Voce nao precisa fazer mais nada apos triar.

AREAS:
- Trabalhista: demissao, horas extras, assedio, acidente, rescisao -> Dr. Rafael Jorge Pinhatti
- Familia: divorcio, pensao, guarda, inventario, heranca -> Dra. Aline Xavier
- Imobiliario: compra/venda, locacao, usucapiao, despejo -> Dr. Willian Assis
- Empresarial: empresa, contratos, socios, recuperacao -> Dr. Willian Assis
- Tributario: dividas fiscais, impostos, Receita -> Dr. Willian Assis
- Criminal: crimes, BO, defesa criminal -> Dra. Aline Xavier
- Previdenciario: aposentadoria, beneficios INSS, pensao por morte, auxilio-doenca, invalidez -> Dra. Aline Xavier
- Civel/Bancario/Consumidor: dividas, cobracas, financiamentos, apreensao de veiculo -> Dr. Willian Assis

HONORARIOS ADVOCATICIOS - COMO RESPONDER SE O CLIENTE PERGUNTAR:
- Se for caso de Direito do Consumidor (dano moral, dano material, cobranças abusivas, contratos de consumo): informe que o contrato e de 30% do valor que o cliente vier a receber, seja de dano moral ou dano material. Nao cobra nada adiantado.
- Se for qualquer outro caso (usucapiao, reintegracao de posse, criminal, trabalhista, tributario, familia, previdenciario, etc.): diga que os honorarios dependem da analise do caso e que o especialista vai passar o valor apos a consulta. Nao invente valores.
- Nunca de valores alem do que esta descrito acima.
`;

const DOCUMENT_ANALYSIS_PROMPT = `Voce e um assistente juridico especializado do escritorio Assis e Xavier Advogados.
Analise o documento recebido com base no seu conhecimento juridico amplo - legislacao brasileira, jurisprudencia, doutrina.

O documento pode ser qualquer tipo: contrato de trabalho, contrato bancario, financiamento, escritura, matricula de imovel, rescisao trabalhista, contrato de locacao, contrato empresarial, procuracao, inventario, ou qualquer outro.

SUA ANALISE DEVE:
1. Identificar o tipo de documento
2. Com base no contexto da conversa, verificar elementos juridicos relevantes para o caso
3. Identificar clausulas, condicoes ou ausencias que possam favorecer ou prejudicar o cliente
4. Avaliar as chances de exito numa eventual acao

SUA RESPOSTA DEVE CONTER APENAS:
- Tipo do documento identificado
- Principais pontos relevantes (maximo 3, objetivamente)
- Avaliacao das chances de exito: ALTA, MODERADA ou BAIXA - com uma frase de motivo

NAO use juridiques excessivo. Responda em portugues, claro e direto.`;

const TOOLS = [
  {
    name: 'notificar_especialista',
    description: 'Notifica o especialista da area sobre um novo lead qualificado. Use quando tiver: nome do cliente, situacao juridica clara e horario preferido.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['trabalhista', 'familia', 'imobiliario', 'empresarial', 'tributario', 'criminal', 'civel_bancario', 'consumidor', 'previdenciario'],
          description: 'Area juridica do caso'
        },
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        horario_preferido: { type: 'string', description: 'Melhor horario para contato' },
        resumo_caso: {
          type: 'string',
          description: 'Resumo completo: situacao, fatos, documentos analisados com resultado, pontos juridicos relevantes'
        }
      },
      required: ['area', 'nome_cliente', 'horario_preferido', 'resumo_caso']
    }
  },
  {
    name: 'reenviar_lembrete',
    description: 'Reenviar lembrete urgente ao especialista quando o cliente informar que ainda nao foi contatado.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['trabalhista', 'familia', 'imobiliario', 'empresarial', 'tributario', 'criminal', 'civel_bancario', 'consumidor', 'previdenciario'],
          description: 'Area juridica do caso'
        },
        nome_cliente: { type: 'string', description: 'Nome do cliente que aguarda retorno' }
      },
      required: ['area', 'nome_cliente']
    }
  },
  {
    name: 'triar_caso_trabalhista',
    description: 'USE APENAS para casos TRABALHISTAS. Em vez de notificar o especialista diretamente, envia o caso para uma triagem previa com o Dr. Rafael, que decide se o escritorio vai assumir. So use quando ja tiver: nome do cliente, horario preferido, ultimo salario, tempo de trabalho e um resumo do que aconteceu. NUNCA use notificar_especialista para casos trabalhistas.',
    input_schema: {
      type: 'object',
      properties: {
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        horario_preferido: { type: 'string', description: 'Melhor horario para contato, caso o caso seja aceito' },
        salario: { type: 'string', description: 'Ultimo salario do cliente (ex: R$ 1.800)' },
        tempo_trabalho: { type: 'string', description: 'Quanto tempo trabalhou na empresa e/ou ha quanto tempo saiu (ex: 12 anos de casa, saiu ha 3 meses)' },
        resumo_caso: {
          type: 'string',
          description: 'Resumo do caso: o que aconteceu, o que a empresa deixou de pagar, pontos relevantes'
        }
      },
      required: ['nome_cliente', 'horario_preferido', 'salario', 'tempo_trabalho', 'resumo_caso']
    }
  }
];

const conversationHistory = loadHistory();

// Debounce: acumula mensagens picadas e processa juntas apos 8s de silencio
const pendingMessages = {};

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || '';
  }
  return '';
}

function buildSystemPrompt(userId) {
  const history = conversationHistory[userId] || [];
  const textMessages = history.filter(m => typeof m.content === 'string' && m.content.trim());

  if (textMessages.length === 0) return OFFICE_CONTEXT;

  const recentLines = textMessages
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Ana'}: ${m.content}`)
    .join('\n');

  return OFFICE_CONTEXT +
    `\n\nATENCAO CRITICA - CONVERSA EM ANDAMENTO:\n` +
    `Voce JA esta atendendo este cliente. NAO se apresente. Retome exatamente de onde parou.\n\n` +
    `ULTIMAS MENSAGENS DA CONVERSA:\n${recentLines}`;
}

async function sendEmailToSpecialist(toEmail, subject, htmlBody, ccEmail = null, attachments = []) {
  if (!BREVO_API_KEY || !EMAIL_FROM) {
    console.log('[Email] Credenciais nao configuradas, pulando envio.');
    return;
  }
  try {
    const payload = {
      sender: { name: 'Ana - Assis e Xavier Advogados', email: EMAIL_FROM },
      to: [{ email: toEmail }],
      subject,
      htmlContent: htmlBody
    };
    if (ccEmail && ccEmail !== toEmail) {
      payload.cc = [{ email: ccEmail }];
    }
    if (attachments.length > 0) {
      payload.attachment = attachments.map(a => ({ content: a.base64, name: a.filename }));
    }
    await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
      headers: { 'api-key': BREVO_API_KEY, 'content-type': 'application/json' }
    });
    const ccInfo = ccEmail && ccEmail !== toEmail ? ` (CC: ${ccEmail})` : '';
    const attInfo = attachments.length ? ` com ${attachments.length} anexo(s)` : '';
    console.log(`[Email] Enviado para ${toEmail}${ccInfo} via Brevo${attInfo}`);
  } catch (e) {
    console.error('[Email] Erro ao enviar:', e.response?.data || e.message);
  }
}

// Reenvia o documento original (mediaId) ao especialista via WhatsApp.
// So entrega se a janela de 24h do especialista estiver aberta (nao e template).
async function forwardDocumentToSpecialist(to, mediaId, mimeType, filename) {
  if (!to || !PHONE_NUMBER_ID || !WHATSAPP_TOKEN || !mediaId) return;
  const type = mimeType.startsWith('image/') ? 'image' : 'document';
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type,
        [type]: type === 'document' ? { id: mediaId, filename } : { id: mediaId }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[Doc] Encaminhado ${filename} para ${to}`);
  } catch (e) {
    console.error('[Doc] Erro ao encaminhar documento:', e.response?.data?.error?.message || e.message);
  }
}

async function executeTool(toolName, toolInput, clientPhone) {
  if (toolName === 'notificar_especialista') {
    const { area, nome_cliente, horario_preferido, resumo_caso } = toolInput;
    const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;
    const areaLabel = area.toUpperCase().replace('_', '/');

    // Restaura documentos pendentes do Supabase ANTES de sobrescrever o campo
    // "meta" abaixo — senao um restart do Render entre o envio do arquivo e a
    // notificacao faria esse patch apagar os documentos ja persistidos.
    await ensureStateLoaded(clientPhone);

    // Guarda metadados para exibir no painel (nome, area, especialista, horario)
    conversationMeta[clientPhone] = {
      nome: nome_cliente,
      area: areaLabel,
      especialista: specialist.name,
      horario: horario_preferido
    };
    supabasePatch(clientPhone, {
      meta: { ...conversationMeta[clientPhone], documents: clientDocuments[clientPhone] || [] },
      handled: false
    });

    const whatsappMsg =
      `🔔 *NOVO ATENDIMENTO - ${areaLabel}*\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `📱 *WhatsApp:* +${clientPhone}\n` +
      `⏰ *Melhor horario:* ${horario_preferido}\n\n` +
      `📋 *RESUMO DO CASO:*\n${resumo_caso}\n\n` +
      `_Atendimento realizado pela Ana - Assis e Xavier Advogados_`;

    const emailHtml =
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">` +
      `<h2 style="color:#1a5276">Novo Atendimento - ${areaLabel}</h2>` +
      `<table style="border-collapse:collapse;width:100%">` +
      `<tr><td style="padding:8px;font-weight:bold;width:140px">Cliente:</td><td style="padding:8px">${nome_cliente}</td></tr>` +
      `<tr style="background:#f2f2f2"><td style="padding:8px;font-weight:bold">WhatsApp:</td><td style="padding:8px">+${clientPhone}</td></tr>` +
      `<tr><td style="padding:8px;font-weight:bold">Melhor horario:</td><td style="padding:8px">${horario_preferido}</td></tr>` +
      `</table>` +
      `<h3 style="color:#1a5276;margin-top:20px">Resumo do Caso</h3>` +
      `<p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-left:4px solid #1a5276">${resumo_caso}</p>` +
      `<hr style="margin-top:24px">` +
      `<small style="color:#888">Atendimento realizado pela Ana - Assis e Xavier Advogados</small>` +
      `</div>`;

    // 1) Tenta via TEMPLATE (chega a qualquer hora, mesmo fora da janela de 24h)
    const templateOk = await sendWhatsAppTemplate(specialist.phone, [
      `Novo atendimento (${areaLabel})`,
      nome_cliente,
      `+${clientPhone}`,
      horario_preferido,
      resumo_caso
    ]);

    // 2) Texto livre — SEMPRE tenta (nao so quando o template falha). Se o template
    //    estiver pausado/reprovado pela Meta mas houver janela de 24h aberta, o
    //    especialista ainda recebe. Se nao houver janela, o Meta so rejeita e nada
    //    se perde. Perder um lead e muito pior que uma eventual mensagem duplicada.
    try {
      await sendWhatsAppMessage(specialist.phone, whatsappMsg);
      console.log(`[Especialista] WhatsApp (texto livre) enviado para ${specialist.name} (template ${templateOk ? 'ok' : 'falhou'})`);
    } catch (e) {
      console.error('[Especialista] Erro WhatsApp:', e.message);
    }
    if (!templateOk) {
      console.error(`[Especialista] ATENCAO: template FALHOU para ${specialist.name}. Se estiver fora da janela de 24h, so o email chegou. Verifique o template no Meta.`);
    }

    // 3) Email — garantia que sempre chega (com os documentos do cliente anexados)
    const documentos = clientDocuments[clientPhone] || [];
    console.log(`[Especialista] ${documentos.length} documento(s) encontrado(s) para anexar (${documentos.map(d => d.filename).join(', ') || 'nenhum'})`);
    const emailCc = specialist.email !== ADMIN_EMAIL ? ADMIN_EMAIL : null;
    await sendEmailToSpecialist(
      specialist.email,
      `Novo Atendimento - ${areaLabel} | ${nome_cliente}`,
      emailHtml,
      emailCc,
      documentos.map(d => ({ filename: d.filename, base64: d.base64 }))
    );

    // 3b) Tenta reenviar os documentos originais via WhatsApp (depende da janela de 24h)
    for (const doc of documentos) {
      await forwardDocumentToSpecialist(specialist.phone, doc.mediaId, doc.mimeType, doc.filename);
    }
    delete clientDocuments[clientPhone];
    supabasePatch(clientPhone, { meta: { ...(conversationMeta[clientPhone] || {}), documents: [] } });

    // 4) Copia para o admin no WhatsApp quando o especialista e outro (Rafael ou Aline)
    if (specialist.phone !== ADMIN_PHONE) {
      const adminCopyMsg =
        `📋 *CÓPIA - Novo Atendimento ${areaLabel}*\n\n` +
        `👤 *Cliente:* ${nome_cliente}\n` +
        `📱 *WhatsApp:* +${clientPhone}\n` +
        `⏰ *Melhor horário:* ${horario_preferido}\n` +
        `👨‍⚖️ *Especialista notificado:* ${specialist.name}\n\n` +
        `📋 *Resumo:* ${resumo_caso.substring(0, 400)}\n\n` +
        `_Se ${specialist.name} não retornar, contate-o diretamente._`;

      const adminTemplateOk = await sendWhatsAppTemplate(ADMIN_PHONE, [
        `Cópia - ${areaLabel}`,
        nome_cliente,
        `+${clientPhone}`,
        horario_preferido,
        `Notifiquei ${specialist.name}. ${resumo_caso}`
      ]);
      if (!adminTemplateOk) {
        try {
          await sendWhatsAppMessage(ADMIN_PHONE, adminCopyMsg);
        } catch (e) {
          console.error('[Admin] Erro ao enviar copia:', e.message);
        }
      }
      console.log(`[Admin] Copia enviada para Dr. Willian sobre atendimento ${areaLabel} de ${nome_cliente}`);
    }

    // Limpa historico apos 3h para que o admin consiga ver a conversa completa
    setTimeout(() => {
      delete conversationHistory[clientPhone];
      saveHistory(conversationHistory);
      console.log(`[Historico] Limpo para ${clientPhone} apos 3h do encerramento`);
    }, 3 * 60 * 60 * 1000);

    return `Especialista ${specialist.name} notificado com sucesso.`;
  }

  if (toolName === 'reenviar_lembrete') {
    const { area, nome_cliente } = toolInput;
    const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;

    const whatsappMsg =
      `⏰ *LEMBRETE URGENTE - CLIENTE AGUARDANDO*\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `📱 *WhatsApp:* +${clientPhone}\n\n` +
      `O cliente informou que ainda nao recebeu seu contato. Por favor, entre em contato o quanto antes.\n\n` +
      `_Assis e Xavier Advogados_`;

    const emailHtml =
      `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">` +
      `<h2 style="color:#c0392b">Lembrete Urgente - Cliente Aguardando</h2>` +
      `<table style="border-collapse:collapse;width:100%">` +
      `<tr><td style="padding:8px;font-weight:bold;width:140px">Cliente:</td><td style="padding:8px">${nome_cliente}</td></tr>` +
      `<tr style="background:#f2f2f2"><td style="padding:8px;font-weight:bold">WhatsApp:</td><td style="padding:8px">+${clientPhone}</td></tr>` +
      `</table>` +
      `<p style="margin-top:16px;color:#c0392b;font-weight:bold">O cliente informou que ainda nao recebeu seu contato. Por favor, entre em contato o quanto antes.</p>` +
      `<hr style="margin-top:24px">` +
      `<small style="color:#888">Assis e Xavier Advogados</small>` +
      `</div>`;

    // 1) Tenta via TEMPLATE (chega a qualquer hora)
    const templateOk = await sendWhatsAppTemplate(specialist.phone, [
      `LEMBRETE URGENTE (${area.toUpperCase().replace('_', '/')})`,
      nome_cliente,
      `+${clientPhone}`,
      '-',
      'Cliente informou que ainda nao recebeu seu contato. Entre em contato o quanto antes.'
    ]);

    // 2) Fallback: texto livre (dentro da janela de 24h)
    if (!templateOk) {
      try {
        await sendWhatsAppMessage(specialist.phone, whatsappMsg);
        console.log(`[Lembrete] WhatsApp (texto livre) reenviado para ${specialist.name}`);
      } catch (e) {
        console.error('[Lembrete] Erro WhatsApp:', e.message);
      }
    }

    // 3) Email — garantia
    const emailCcL = specialist.email !== ADMIN_EMAIL ? ADMIN_EMAIL : null;
    await sendEmailToSpecialist(
      specialist.email,
      `Lembrete Urgente - ${nome_cliente} aguarda seu contato`,
      emailHtml,
      emailCcL
    );

    // 4) Copia para o admin no WhatsApp quando o especialista e outro (Rafael ou Aline)
    if (specialist.phone !== ADMIN_PHONE) {
      const adminLembreteMsg =
        `⏰ *LEMBRETE - Cliente aguardando ${specialist.name}*\n\n` +
        `👤 *Cliente:* ${nome_cliente}\n` +
        `📱 *WhatsApp:* +${clientPhone}\n\n` +
        `Cliente informou que ainda nao foi contatado por ${specialist.name}. Por favor, verifique.`;

      const adminTplOk = await sendWhatsAppTemplate(ADMIN_PHONE, [
        `LEMBRETE (${area.toUpperCase().replace('_', '/')})`,
        nome_cliente,
        `+${clientPhone}`,
        '-',
        `Cliente aguarda retorno de ${specialist.name}.`
      ]);
      if (!adminTplOk) {
        try {
          await sendWhatsAppMessage(ADMIN_PHONE, adminLembreteMsg);
        } catch (e) {}
      }
      console.log(`[Admin] Copia de lembrete enviada para Dr. Willian - ${nome_cliente}`);
    }

    return `Lembrete reenviado para ${specialist.name}.`;
  }

  if (toolName === 'triar_caso_trabalhista') {
    const { nome_cliente, horario_preferido, salario, tempo_trabalho, resumo_caso } = toolInput;
    const specialist = SPECIALISTS.trabalhista;
    const code = genTriageCode();

    const triageText =
      `⚖️ *TRIAGEM - PRECISO DA SUA DECISAO*  [${code}]\n\n` +
      `*O escritorio deve ASSUMIR este caso trabalhista?*\n` +
      `➡️ Responda *SIM ${code}* (assume) ou *NAO ${code}* (recusa)\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `💰 *Salario:* ${salario}\n` +
      `🕐 *Tempo:* ${tempo_trabalho}\n\n` +
      `📋 ${resumo_caso}\n\n` +
      `_(pode responder so SIM ou NAO tambem)_`;

    // 1) Template aprovado (chega mesmo fora da janela de 24h). Como o texto fixo
    //    do template e generico ("novo atendimento"), colocamos a PERGUNTA em mais
    //    de um campo para que ela apareca com destaque independentemente do layout.
    await sendWhatsAppTemplate(specialist.phone, [
      `TRIAGEM: o escritorio deve ASSUMIR este caso? Responda SIM ${code} ou NAO ${code}`,
      nome_cliente,
      `Salario ${salario} | Tempo ${tempo_trabalho}`,
      `RESPONDA: SIM ${code} (assume) ou NAO ${code} (recusa)`,
      resumo_caso
    ]);

    // 2) Texto livre (formatacao bonita, dentro da janela de 24h) — capturamos o id
    //    da mensagem para casar caso o especialista use o "responder" do WhatsApp.
    let triageMsgId = null;
    try {
      const sent = await sendWhatsAppMessage(specialist.phone, triageText);
      triageMsgId = sent?.messages?.[0]?.id || null;
    } catch (e) {
      console.error('[Triagem] Erro ao enviar texto livre:', e.message);
    }

    saveTriage(code, {
      clientPhone,
      area: 'trabalhista',
      nome: nome_cliente,
      horario: horario_preferido,
      salario,
      tempo: tempo_trabalho,
      resumo: resumo_caso,
      specialistPhone: specialist.phone,
      triageMsgId
    });

    console.log(`[Triagem] Caso ${code} (${nome_cliente}) enviado ao Dr. Rafael. Aguardando SIM/NAO.`);

    return `Triagem enviada ao especialista (codigo ${code}). Diga ao cliente, de forma natural e acolhedora, ` +
      `que voce vai confirmar a disponibilidade com o especialista e retorna em seguida. ` +
      `NAO afirme ainda que o especialista vai ligar — isso depende da confirmacao. Encerre por aqui.`;
  }

  return 'Ferramenta desconhecida.';
}

// Resolve uma triagem trabalhista quando o especialista responde SIM/NAO.
// Chamada a partir do webhook (fluxo assincrono, fora do loop da Ana).
async function resolveTriage(code, aceito) {
  const t = await loadTriage(code);
  if (!t) {
    console.log(`[Triagem] Codigo ${code} nao encontrado ou ja resolvido.`);
    return false;
  }
  clearTriage(code);

  if (aceito) {
    console.log(`[Triagem] Caso ${code} ACEITO pelo especialista. Notificando normalmente.`);
    // Reusa o fluxo completo e ja testado de notificacao ao especialista.
    await executeTool('notificar_especialista', {
      area: 'trabalhista',
      nome_cliente: t.nome,
      horario_preferido: t.horario,
      resumo_caso: t.resumo
    }, t.clientPhone);

    const msg = triageAcceptMessage(t.nome, t.horario);
    await sendWhatsAppMessage(t.clientPhone, msg);
    await enqueueForUser(t.clientPhone, async () => {
      await ensureStateLoaded(t.clientPhone);
      conversationHistory[t.clientPhone].push({ role: 'assistant', content: msg, ts: new Date().toISOString() });
      persist(t.clientPhone);
    });
  } else {
    console.log(`[Triagem] Caso ${code} RECUSADO pelo especialista. Enviando recusa educada ao cliente.`);
    const msg = triageDeclineMessage(t.nome);
    await sendWhatsAppMessage(t.clientPhone, msg);
    await enqueueForUser(t.clientPhone, async () => {
      await ensureStateLoaded(t.clientPhone);
      conversationHistory[t.clientPhone].push({ role: 'assistant', content: msg, ts: new Date().toISOString() });
      persist(t.clientPhone);
    });
  }
  return true;
}

// Interpreta a resposta de um especialista a uma triagem. Retorna:
//   { code, aceito }              conseguiu identificar caso + decisao (SIM/NAO)
//   { ambiguous: true, code? }    tem o caso mas a decisao nao ficou clara
//   { needCode: true, pendentes } ha triagem(ns) pendente(s) mas falta o codigo
//   { none: true }                especialista sem nenhuma triagem pendente
async function interpretTriageReply(message, senderNumber) {
  const text = (message.text?.body || '').trim();
  const upper = text
    .toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos (NAO == NÃO)

  // 1) Localiza o codigo: "responder" do WhatsApp, token no texto, ou triagem unica pendente
  let code = null;
  const ctxId = message.context?.id;
  if (ctxId && triageByMsgId[ctxId]) code = triageByMsgId[ctxId];

  if (!code) {
    const tokens = upper.match(/\b[A-Z2-9]{3}\b/g) || [];
    for (const tok of tokens) {
      if (tok === 'SIM' || tok === 'NAO') continue;
      if (await loadTriage(tok)) { code = tok; break; }
    }
  }

  // Pendentes deste especialista (memoria + Supabase, para sobreviver a restart)
  const pendentes = await listPendingTriages(senderNumber);
  if (!code && pendentes.length === 1) code = pendentes[0].code;

  if (!code && pendentes.length === 0) return { none: true };

  // 2) Detecta a decisao — negacao tem precedencia (cobre "nao tem interesse").
  const naoRe = /(\bNAO\b|RECUS|DESCART|NEGATIV|\bPASSO\b|SEM INTERESSE|NAO (TENHO|TEMOS|HA) INTERESSE)/;
  const simRe = /(\bSIM\b|ACEIT|POSITIV|\bOK\b|ASSUM|\bPODE\b|INTERESSAD|(TENHO|TEMOS|HA) INTERESSE|INTERESSA\b)/;
  const hasNao = naoRe.test(upper);
  const hasSim = simRe.test(upper);

  let aceito;
  if (hasNao) aceito = false;
  else if (hasSim) aceito = true;
  else return { ambiguous: true, code, pendentes };

  if (!code) return { needCode: true, pendentes };
  return { code, aceito };
}

// Tratamento dedicado para mensagens vindas dos advogados do escritorio.
// Eles NUNCA entram no fluxo de lead da Ana — sao contatos prioritarios.
async function handleSpecialistMessage(message, senderNumber, specialist) {
  const nomeCurto = specialist.name;

  // So mensagens de texto podem ser resposta de triagem
  const triage = message.type === 'text'
    ? await interpretTriageReply(message, senderNumber)
    : { none: true };

  if (triage.code && typeof triage.aceito === 'boolean') {
    const ok = await resolveTriage(triage.code, triage.aceito);
    if (!ok) {
      await sendWhatsAppMessage(senderNumber, `Nao encontrei o caso ${triage.code} (talvez ja tenha sido respondido). Se precisar, me diga o codigo novamente.`);
      return;
    }
    await sendWhatsAppMessage(
      senderNumber,
      triage.aceito
        ? `✅ Perfeito, ${nomeCurto}. Caso ${triage.code} confirmado — ja avisei o cliente e enviei os dados completos para contato.`
        : `👍 Entendido, ${nomeCurto}. Caso ${triage.code} recusado. Ja comuniquei o cliente de forma educada. Obrigada!`
    );
    return;
  }

  if (triage.ambiguous) {
    const alvo = triage.code ? ` do caso ${triage.code}` : '';
    await sendWhatsAppMessage(senderNumber, `${nomeCurto}, nao entendi a decisao${alvo}. Pode responder *SIM* ou *NAO*${triage.code ? ` ${triage.code}` : ''}?`);
    return;
  }

  if (triage.needCode) {
    const lista = triage.pendentes.map(p => `• ${p.code} — ${p.nome}`).join('\n');
    await sendWhatsAppMessage(senderNumber, `${nomeCurto}, ha mais de um caso em triagem. Responda com o codigo, por exemplo *SIM ${triage.pendentes[0].code}* ou *NAO ${triage.pendentes[0].code}*:\n${lista}`);
    return;
  }

  // Sem triagem pendente: permite consultar os casos aguardando decisao
  if (message.type === 'text' && /\b(CASOS?|PENDENTE|TRIAGE|TRIAGEM)\b/i.test(message.text?.body || '')) {
    const pend = await listPendingTriages(senderNumber);
    if (pend.length) {
      const lista = pend.map(p => `• ${p.code} — ${p.nome}`).join('\n');
      await sendWhatsAppMessage(senderNumber, `${nomeCurto}, casos aguardando sua decisao:\n${lista}\n\nResponda *SIM <codigo>* ou *NAO <codigo>*.`);
    } else {
      await sendWhatsAppMessage(senderNumber, `${nomeCurto}, nao ha nenhum caso em triagem aguardando sua decisao no momento.`);
    }
    return;
  }

  // Qualquer outra mensagem do advogado: resposta profissional, sem intake de lead
  await sendWhatsAppMessage(
    senderNumber,
    `Ola, ${nomeCurto}. Aqui e o atendimento automatico da Ana. No momento nao ha nenhum caso em triagem aguardando sua resposta — assim que houver, envio por aqui. Se quiser ver os pendentes, e so escrever "casos".`
  );
}

async function callClaudeAPI(userMessage, userId) {
  return enqueueForUser(userId, () => callClaudeAPIInternal(userMessage, userId));
}

async function callClaudeAPIInternal(userMessage, userId) {
  try {
    await ensureStateLoaded(userId);

    conversationHistory[userId].push({ role: 'user', content: userMessage, ts: new Date().toISOString() });

    // A API do Claude recebe apenas role/content (sem o campo ts) e ja saneado,
    // para que historicos corrompidos por bugs antigos voltem a funcionar.
    const messages = sanitizeMessages(
      conversationHistory[userId].map(({ role, content }) => ({ role, content }))
    );
    let response;

    while (true) {
      response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-opus-4-8',
          max_tokens: 1024,
          system: buildSystemPrompt(userId),
          tools: TOOLS,
          messages
        },
        {
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );

      const content = response.data.content;
      const toolUseBlock = content.find(b => b.type === 'tool_use');

      if (!toolUseBlock) {
        const assistantText = extractText(content);
        conversationHistory[userId].push({ role: 'assistant', content: assistantText, ts: new Date().toISOString() });
        break;
      }

      messages.push({ role: 'assistant', content });
      conversationHistory[userId].push({ role: 'assistant', content, ts: new Date().toISOString() });

      const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input, userId);

      const toolResultMsg = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult }]
      };
      messages.push(toolResultMsg);
      conversationHistory[userId].push({ ...toolResultMsg, ts: new Date().toISOString() });
    }

    conversationHistory[userId] = trimHistory(conversationHistory[userId], 40);
    persist(userId);

    return extractText(response.data.content);

  } catch (error) {
    console.error('[Claude] Erro:', error.response?.data || error.message);
    return `Desculpe, tive um problema tecnico. Entre em contato via WhatsApp: ${ESCRITORIO_PHONE}`;
  }
}

async function getMediaUrl(mediaId) {
  const response = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } }
  );
  return { url: response.data.url, mimeType: response.data.mime_type };
}

async function downloadMedia(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
  });
  return Buffer.from(response.data);
}

async function analyzeDocumentWithClaude(buffer, mimeType, conversationContext) {
  try {
    let userContent;

    if (mimeType.startsWith('image/')) {
      const base64 = buffer.toString('base64');
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: `Analise este documento.\n\nCONTEXTO DA CONVERSA:\n${conversationContext}` }
      ];
    } else if (mimeType === 'application/pdf') {
      const pdfData = await pdfParse(buffer);
      const text = pdfData.text.substring(0, 10000);
      userContent = `Analise este documento.\n\nCONTEXTO DA CONVERSA:\n${conversationContext}\n\nCONTEUDO DO DOCUMENTO:\n${text}`;
    } else {
      const text = buffer.toString('utf8').substring(0, 10000);
      userContent = `Analise este documento.\n\nCONTEXTO DA CONVERSA:\n${conversationContext}\n\nCONTEUDO DO DOCUMENTO:\n${text}`;
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: DOCUMENT_ANALYSIS_PROMPT,
        messages: [{ role: 'user', content: userContent }]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error('[Analise] Erro:', error.response?.data || error.message);
    return null;
  }
}

async function handleDocument(message, userId) {
  try {
    let mediaId, mimeType, filename;

    if (message.type === 'document') {
      mediaId = message.document.id;
      mimeType = message.document.mime_type || 'application/octet-stream';
      filename = message.document.filename || 'documento.pdf';
    } else {
      mediaId = message.image.id;
      mimeType = message.image.mime_type || 'image/jpeg';
      filename = `imagem.${mimeType.split('/')[1] || 'jpg'}`;
    }

    console.log(`[Doc] Recebendo ${filename} (${mimeType})`);

    const { url } = await getMediaUrl(mediaId);
    const buffer = await downloadMedia(url);

    // Guarda o documento original para anexar/encaminhar quando notificar o especialista.
    // Restaura do Supabase primeiro: se o servidor reiniciou entre um arquivo e outro
    // (Render free tier derruba a instancia por inatividade), o array em memoria teria
    // sido zerado e o arquivo anterior seria perdido silenciosamente.
    await ensureStateLoaded(userId);
    clientDocuments[userId].push({ filename, mimeType, mediaId, base64: buffer.toString('base64') });
    if (clientDocuments[userId].length > 5) clientDocuments[userId].shift();
    console.log(`[Doc] ${filename} salvo para ${userId}. Total de documentos pendentes: ${clientDocuments[userId].length}`);
    supabasePatch(userId, { meta: { ...(conversationMeta[userId] || {}), documents: clientDocuments[userId] } });

    const history = conversationHistory[userId] || [];
    const recentHistory = history
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Ana'}: ${extractText(m.content) || '[arquivo]'}`)
      .join('\n');

    const analysisResult = await analyzeDocumentWithClaude(buffer, mimeType, recentHistory);

    if (!analysisResult) {
      return callClaudeAPI('O cliente enviou um documento mas nao consegui processa-lo. Peca para enviar em PDF ou como foto nitida.', userId);
    }

    return callClaudeAPI(`[ANALISE DO DOCUMENTO - ${filename}]\n${analysisResult}`, userId);
  } catch (error) {
    console.error('[Doc] Erro ao processar documento:', error.response?.data || error.message);
    return callClaudeAPI('O cliente enviou um documento mas ocorreu um erro tecnico. Peca para tentar novamente.', userId);
  }
}

async function markAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[Meta] Erro ao marcar como lido:', error.response?.data);
  }
}

function typingDelay(text) {
  const baseDelay = 2000;
  const charsPerSecond = 18;
  const calculated = baseDelay + (text.length / charsPerSecond) * 1000;
  const delay = Math.min(Math.max(calculated, 2000), 8000);
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Envia notificacao via template aprovado pelo Meta.
// Funciona a QUALQUER hora, mesmo fora da janela de 24h.
// Retorna true se enviou, false se falhou (template inexistente, nao aprovado, etc).
async function sendWhatsAppTemplate(to, bodyParams) {
  if (!to || !PHONE_NUMBER_ID || !WHATSAPP_TOKEN || !LEAD_TEMPLATE_NAME) return false;

  // Variaveis de template do Meta nao podem ter quebras de linha nem espacos multiplos
  const clean = (s) => String(s ?? '-').replace(/\s+/g, ' ').trim().substring(0, 700) || '-';

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: LEAD_TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
          components: [
            {
              type: 'body',
              parameters: bodyParams.map(p => ({ type: 'text', text: clean(p) }))
            }
          ]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[Template] Enviado para ${to}. ID: ${response.data.messages?.[0]?.id}`);
    return true;
  } catch (error) {
    console.error('[Template] Erro:', error.response?.data?.error?.message || error.message);
    return false;
  }
}

async function sendWhatsAppMessage(to, message) {
  if (!to || !PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.error('[Meta] Parametros ausentes:', { to, PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN });
    return;
  }

  console.log(`[Meta] Enviando para: ${to}`);

  try {
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log(`[Meta] Enviada. ID: ${response.data.messages?.[0]?.id}`);
    return response.data;
  } catch (error) {
    console.error('[Meta] Erro ao enviar:', error.response?.data || error.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] Verificacao OK.');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;

    // Status de entrega (sent / delivered / read / FAILED). Revela porque uma
    // notificacao ao especialista nao chegou, com o codigo de erro do Meta.
    const statuses = change?.statuses;
    if (statuses && statuses.length) {
      for (const st of statuses) {
        deliveryStatus[st.id] = {
          status: st.status,
          recipient: st.recipient_id,
          errors: st.errors || null,
          ts: new Date().toISOString()
        };
        if (st.status === 'failed') {
          console.error(`[Entrega] FALHOU para +${st.recipient_id}:`, JSON.stringify(st.errors || st));
        } else {
          console.log(`[Entrega] +${st.recipient_id}: ${st.status}`);
        }
      }
      return;
    }

    const messages = change?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const senderNumber = message.from;
    const messageId = message.id;

    await markAsRead(messageId);

    // Advogados do escritorio (especialistas) tem tratamento proprio e NUNCA
    // sao tratados como lead/cliente. Isso precisa vir ANTES de todo o resto.
    const specialist = findSpecialistByPhone(senderNumber);
    if (specialist) {
      console.log(`[Especialista] Mensagem de ${specialist.name} (${senderNumber})`);
      await handleSpecialistMessage(message, senderNumber, specialist);
      return;
    }

    if (message.type === 'audio' || message.type === 'voice') {
      const audioReplies = [
        'Ouvi seu audio! Me conta um pouco mais por escrito? Assim consigo te direcionar para o especialista certo aqui no escritorio.',
        'Recebi seu audio! Para garantir que nada se perca, pode me resumir aqui o que esta acontecendo?',
        'Escutei! Me escreve rapidinho o que precisa, assim ja te passo para o advogado certo.'
      ];
      const reply = audioReplies[Math.floor(Math.random() * audioReplies.length)];
      await typingDelay(reply);
      await sendWhatsAppMessage(senderNumber, reply);
      return;
    }

    if (message.type === 'document' || message.type === 'image') {
      if (pendingMessages[senderNumber]) {
        clearTimeout(pendingMessages[senderNumber].timer);
        const pending = pendingMessages[senderNumber];
        delete pendingMessages[senderNumber];
        await enqueueForUser(senderNumber, async () => {
          await ensureStateLoaded(senderNumber);
          conversationHistory[senderNumber].push({ role: 'user', content: pending.messages.join('\n'), ts: new Date().toISOString() });
          persist(senderNumber);
        });
      }

      console.log(`[Webhook] ${message.type} recebido de ${senderNumber}`);
      const reply = await handleDocument(message, senderNumber);
      await typingDelay(reply);
      await sendWhatsAppMessage(senderNumber, reply);
      return;
    }

    if (message.type !== 'text') return;

    const incomingText = message.text.body;
    console.log(`[Webhook] Texto de ${senderNumber}: ${incomingText}`);

    if (pendingMessages[senderNumber]) {
      clearTimeout(pendingMessages[senderNumber].timer);
      pendingMessages[senderNumber].messages.push(incomingText);
    } else {
      pendingMessages[senderNumber] = { messages: [incomingText] };
    }

    pendingMessages[senderNumber].timer = setTimeout(async () => {
      const batch = pendingMessages[senderNumber];
      if (!batch) return;
      delete pendingMessages[senderNumber];

      const combined = batch.messages.join('\n');
      console.log(`[Batch] Processando ${batch.messages.length} mensagem(ns) de ${senderNumber}`);

      try {
        const reply = await callClaudeAPI(combined, senderNumber);
        await typingDelay(reply);
        await sendWhatsAppMessage(senderNumber, reply);
      } catch (error) {
        console.error('[Batch] Erro ao processar:', error);
      }
    }, 8000);

  } catch (error) {
    console.error('[Webhook] Erro:', error);
  }
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ana — Painel</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#0b141a;--panel:#202c33;--panel2:#111b21;--green:#00a884;--green2:#005c4b;--txt:#e9edef;--mut:#8696a0;--line:#2a3942}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--txt);min-height:100vh}
.screen{display:none}.screen.active{display:flex;flex-direction:column;height:100vh}
/* LOGIN */
#login{justify-content:center;align-items:center;padding:24px;background:linear-gradient(160deg,#0b141a,#16242d)}
.box{background:var(--panel);border-radius:20px;padding:36px 26px;width:100%;max-width:360px;box-shadow:0 12px 40px rgba(0,0,0,.4);animation:pop .3s ease}
@keyframes pop{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
.logo{width:64px;height:64px;border-radius:50%;background:var(--green);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:800;margin:0 auto 16px;color:#fff}
.box h1{font-size:22px;font-weight:700;text-align:center}.box p{color:var(--mut);font-size:13.5px;margin:4px 0 24px;text-align:center}
input[type=password],input[type=text]{width:100%;background:#2a3942;border:1px solid transparent;border-radius:10px;color:var(--txt);font-size:16px;padding:14px 16px;outline:none}
input:focus{border-color:var(--green)}
button{width:100%;background:var(--green);border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:600;padding:14px;cursor:pointer;margin-top:12px;transition:.15s}
button:active{transform:scale(.98)}.err{color:#ef4444;font-size:13px;margin-top:10px;text-align:center}
/* HEADER */
.hdr{background:var(--panel);padding:14px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;box-shadow:0 1px 0 rgba(0,0,0,.2)}
.hdr .ttl{flex:1;min-width:0}.hdr .ttl b{font-size:17px;font-weight:600;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hdr .ttl span{font-size:12px;color:var(--mut)}
.back{font-size:28px;cursor:pointer;line-height:1;color:var(--txt);padding:0 4px}.ref{font-size:20px;cursor:pointer;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:50%}
.ref:active{background:var(--line)}
/* SEARCH + TABS */
.tools{background:var(--panel2);padding:10px 14px;display:flex;flex-direction:column;gap:10px;flex-shrink:0;border-bottom:1px solid var(--line)}
.search{display:flex;align-items:center;gap:8px;background:#2a3942;border-radius:10px;padding:9px 14px}
.search input{background:none;border:none;padding:0;font-size:15px}
.search span{color:var(--mut);font-size:16px}
.tabs{display:flex;gap:8px}
.tab{flex:1;text-align:center;font-size:13px;font-weight:600;color:var(--mut);background:#2a3942;padding:8px;border-radius:20px;cursor:pointer;transition:.15s}
.tab.on{background:var(--green);color:#fff}
.tab .n{font-size:11px;opacity:.85}
/* LIST */
.list{flex:1;overflow-y:auto}
.item{display:flex;align-items:center;gap:13px;padding:13px 16px;border-bottom:1px solid var(--line);cursor:pointer;transition:.12s;animation:fade .25s ease}
@keyframes fade{from{opacity:0}to{opacity:1}}
.item:active{background:var(--line)}
.av{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:700;flex-shrink:0;color:#fff}
.ci{flex:1;min-width:0}
.crow{display:flex;align-items:center;gap:6px}
.cp{font-size:15.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ctime{font-size:11px;color:var(--mut);flex-shrink:0}
.cv{font-size:13px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.badges{display:flex;gap:5px;margin-top:5px;flex-wrap:wrap}
.bdg{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:10px;background:#0e3a2f;color:#4fd3a8}
.bdg.area{background:#10334d;color:#5cb3f0}
.bdg.ok{background:#2a3942;color:var(--mut)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green);flex-shrink:0}
.empty{padding:60px 24px;text-align:center;color:var(--mut);font-size:14px}
/* CHAT */
.cbar{background:#0b2920;padding:8px 16px;font-size:12px;color:#7fd0b5;flex-shrink:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:6px;background:#0b141a}
.msg{max-width:80%;padding:7px 11px 5px;border-radius:9px;font-size:14.5px;line-height:1.45;word-break:break-word;box-shadow:0 1px 1px rgba(0,0,0,.2);animation:fade .2s ease}
.msg.u{align-self:flex-end;background:var(--green2)}
.msg.a{align-self:flex-start;background:var(--panel)}
.mt{font-size:10px;color:var(--mut);text-align:right;margin-top:2px}
.who{font-size:11px;font-weight:700;margin-bottom:2px;color:#7fd0b5}
.msg.u .who{color:#9fe0c8}
.cact{flex-shrink:0;padding:10px 14px;background:var(--panel);display:flex;gap:10px}
.cact button{margin:0}
.btn-ok{background:var(--green)}.btn-undo{background:#2a3942}
.daysep{align-self:center;background:#1d2a32;color:var(--mut);font-size:11px;padding:4px 12px;border-radius:10px;margin:6px 0}
</style>
</head>
<body>
<div id="login" class="screen active">
  <div class="box">
    <div class="logo">AX</div>
    <h1>Ana</h1>
    <p>Painel de Atendimentos · Assis Xavier Advogados</p>
    <input type="password" id="pwd" placeholder="Senha de acesso" onkeydown="if(event.key==='Enter')auth()">
    <button onclick="auth()">Entrar</button>
    <div class="err" id="err"></div>
  </div>
</div>

<div id="list" class="screen">
  <div class="hdr">
    <div class="logo" style="width:40px;height:40px;font-size:17px;margin:0">AX</div>
    <div class="ttl"><b>Atendimentos</b><span id="subt">—</span></div>
    <span class="ref" onclick="load(1)" title="Atualizar">↻</span>
  </div>
  <div class="tools">
    <div class="search"><span>🔍</span><input type="text" id="q" placeholder="Buscar por nome ou número" oninput="render()"></div>
    <div class="tabs">
      <div class="tab on" data-f="all" onclick="setTab('all')">Todas <span class="n" id="n-all"></span></div>
      <div class="tab" data-f="open" onclick="setTab('open')">A tratar <span class="n" id="n-open"></span></div>
      <div class="tab" data-f="done" onclick="setTab('done')">Tratadas <span class="n" id="n-done"></span></div>
    </div>
  </div>
  <div class="list" id="lst"></div>
</div>

<div id="chat" class="screen">
  <div class="hdr">
    <span class="back" onclick="show('list')">‹</span>
    <div class="av" id="cav" style="width:40px;height:40px;font-size:15px"></div>
    <div class="ttl"><b id="ctitle"></b><span id="csub"></span></div>
  </div>
  <div class="cbar" id="cbar" style="display:none"></div>
  <div class="msgs" id="cmsgs"></div>
  <div class="cact"><button id="hbtn" onclick="toggleHandled()">Marcar como tratada</button></div>
</div>

<script>
let tk=localStorage.getItem('ana_tk')||'',convs={},filter='all',current='';
const COLORS=['#e57373','#64b5f6','#81c784','#ffb74d','#ba68c8','#4db6ac','#f06292','#7986cb','#a1887f','#90a4ae'];
function color(ph){let s=0;for(let i=0;i<ph.length;i++)s+=ph.charCodeAt(i);return COLORS[s%COLORS.length];}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function nm(c){return (c.meta&&c.meta.nome)?c.meta.nome:('+'+c.phone);}
function initials(c){const n=(c.meta&&c.meta.nome)?c.meta.nome:c.phone;const p=n.trim().split(/\\s+/);return ((p[0]||'')[0]||'')+((p[1]||'')[0]||p[0].slice(-1)||'');}
function fmtTime(ts){if(!ts)return '';const d=new Date(ts);return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
function fmtDay(ts){if(!ts)return '';const d=new Date(ts),h=new Date(),y=new Date(Date.now()-864e5);
  if(d.toDateString()===h.toDateString())return 'Hoje';
  if(d.toDateString()===y.toDateString())return 'Ontem';
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'});}

async function auth(){
  const p=document.getElementById('pwd').value;
  const r=await fetch('/admin/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
  if(r.ok){const d=await r.json();tk=d.token;localStorage.setItem('ana_tk',tk);show('list');load();}
  else document.getElementById('err').textContent='Senha incorreta.';
}
function show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}
function setTab(f){filter=f;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.f===f));render();}

async function load(manual){
  const el=document.getElementById('lst');
  if(manual&&!Object.keys(convs).length)el.innerHTML='<div class="empty">Carregando…</div>';
  const r=await fetch('/admin/conversations',{headers:{'x-token':tk}});
  if(r.status===401){localStorage.removeItem('ana_tk');show('login');return;}
  convs=await r.json();
  for(const ph in convs)convs[ph].phone=ph;
  render();
}
function counts(){let all=0,open=0,done=0;for(const k in convs){all++;convs[k].handled?done++:open++;}
  document.getElementById('n-all').textContent=all;document.getElementById('n-open').textContent=open;document.getElementById('n-done').textContent=done;
  document.getElementById('subt').textContent=all+' conversa'+(all!==1?'s':'');}
function render(){
  counts();
  const q=(document.getElementById('q').value||'').toLowerCase();
  const el=document.getElementById('lst');
  let keys=Object.keys(convs).sort((a,b)=>new Date(convs[b].updated_at||0)-new Date(convs[a].updated_at||0));
  keys=keys.filter(ph=>{
    const c=convs[ph];
    if(filter==='open'&&c.handled)return false;
    if(filter==='done'&&!c.handled)return false;
    if(q){const hay=(ph+' '+nm(c)+' '+(c.meta&&c.meta.area||'')).toLowerCase();if(!hay.includes(q))return false;}
    return true;
  });
  if(!keys.length){el.innerHTML='<div class="empty">Nenhuma conversa encontrada.</div>';return;}
  el.innerHTML=keys.map(ph=>{
    const c=convs[ph],ms=c.messages,last=ms[ms.length-1];
    const prev=last?(last.role==='user'?'':'Ana: ')+esc(last.text.substring(0,48)):'';
    const area=c.meta&&c.meta.area?\`<span class="bdg area">\${esc(c.meta.area)}</span>\`:'';
    const esp=c.meta&&c.meta.especialista?\`<span class="bdg">\${esc(c.meta.especialista)}</span>\`:'';
    const done=c.handled?'<span class="bdg ok">✓ tratada</span>':'';
    return \`<div class="item" onclick="openChat('\${ph}')">
      <div class="av" style="background:\${color(ph)}">\${esc(initials(c)).toUpperCase()}</div>
      <div class="ci">
        <div class="crow"><div class="cp">\${esc(nm(c))}</div><div class="ctime">\${fmtDay(c.updated_at)}</div></div>
        <div class="cv">\${prev}</div>
        <div class="badges">\${area}\${esp}\${done}\${!c.handled?'<span class="dot"></span>':''}</div>
      </div>
    </div>\`;
  }).join('');
}
function openChat(ph){
  current=ph;const c=convs[ph],ms=c.messages;
  document.getElementById('ctitle').textContent=nm(c);
  document.getElementById('csub').textContent='+'+ph;
  const av=document.getElementById('cav');av.textContent=initials(c).toUpperCase();av.style.background=color(ph);
  const bar=document.getElementById('cbar');
  if(c.meta){bar.style.display='flex';bar.innerHTML=
    (c.meta.area?\`<b>\${esc(c.meta.area)}</b>\`:'')+
    (c.meta.especialista?\`· \${esc(c.meta.especialista)}\`:'')+
    (c.meta.horario?\`· ⏰ \${esc(c.meta.horario)}\`:'');}
  else bar.style.display='none';
  const el=document.getElementById('cmsgs');let lastDay='';
  el.innerHTML=ms.map(m=>{
    let sep='';const day=fmtDay(m.ts);
    if(day&&day!==lastDay){lastDay=day;sep=\`<div class="daysep">\${day}</div>\`;}
    return sep+\`<div class="msg \${m.role==='user'?'u':'a'}">
      <div class="who">\${m.role==='user'?'Cliente':'Ana'}</div>
      \${esc(m.text)}\${m.ts?\`<div class="mt">\${fmtTime(m.ts)}</div>\`:''}
    </div>\`;
  }).join('');
  updHBtn();
  show('chat');
  setTimeout(()=>el.scrollTop=el.scrollHeight,60);
}
function updHBtn(){const c=convs[current],b=document.getElementById('hbtn');
  if(c&&c.handled){b.textContent='↩ Reabrir';b.className='btn-undo';}
  else{b.textContent='✓ Marcar como tratada';b.className='btn-ok';}}
async function toggleHandled(){
  const c=convs[current];const nv=!c.handled;c.handled=nv;updHBtn();
  await fetch('/admin/handled',{method:'POST',headers:{'Content-Type':'application/json','x-token':tk},body:JSON.stringify({phone:current,handled:nv})});
}
setInterval(()=>{if(document.getElementById('list').classList.contains('active'))load();},30000);
if(tk){show('list');load();}
<\/script>
</body>
</html>`;

app.get('/admin', (req, res) => res.send(ADMIN_HTML));

app.post('/admin/auth', (req, res) => {
  const { password } = req.body;
  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ success: true, token: ADMIN_PASSWORD });
});

app.get('/admin/conversations', async (req, res) => {
  const token = req.headers['x-token'];
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = {};
  const onlyText = (msgs) => msgs
    .filter(m => typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, text: m.content, ts: m.ts || null }));

  // Fonte principal: arquivo permanente no Supabase
  const rows = await supabaseGetAll();
  if (rows) {
    for (const row of rows) {
      const textMsgs = onlyText(row.messages || []);
      if (textMsgs.length > 0) {
        result[row.phone] = {
          messages: textMsgs,
          meta: row.meta || conversationMeta[row.phone] || null,
          handled: !!row.handled,
          updated_at: row.updated_at || null
        };
      }
    }
  }

  // Complementa com o que esta na memoria (conversas ativas ainda nao arquivadas)
  for (const [phone, msgs] of Object.entries(conversationHistory)) {
    const textMsgs = onlyText(msgs);
    if (textMsgs.length > 0) {
      const existing = result[phone] || {};
      // Usa a data real da ultima mensagem (nao "agora"), senao conversas apenas
      // carregadas na memoria pulavam para o topo e o painel ficava fora de ordem.
      const lastTs = textMsgs[textMsgs.length - 1].ts;
      result[phone] = {
        messages: textMsgs,
        meta: conversationMeta[phone] || existing.meta || null,
        handled: existing.handled || false,
        updated_at: lastTs || existing.updated_at || null
      };
    }
  }

  res.json(result);
});

// Marca conversa como tratada / nao tratada
app.post('/admin/handled', async (req, res) => {
  const token = req.headers['x-token'];
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { phone, handled } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone obrigatorio' });
  const ok = await supabasePatch(phone, { handled: !!handled });
  res.json({ success: ok });
});

// Diagnostico: envia uma notificacao de teste e devolve a resposta CRUA do Meta.
// Permite ver na hora o motivo exato de uma falha de entrega de template.
app.post('/admin/test-notify', async (req, res) => {
  const token = req.headers['x-token'];
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const target = (req.body?.phone || '').replace(/\D/g, '') || SPECIALISTS.imobiliario.phone;
  const out = { target, config: {
    PHONE_NUMBER_ID: PHONE_NUMBER_ID ? 'ok' : 'FALTANDO',
    WHATSAPP_TOKEN: WHATSAPP_TOKEN ? 'ok' : 'FALTANDO',
    LEAD_TEMPLATE_NAME: LEAD_TEMPLATE_NAME || 'FALTANDO',
    TEMPLATE_LANG
  }, template: null, texto: null };

  // 1) Tenta o TEMPLATE e captura a resposta/erro cru
  try {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: target,
        type: 'template',
        template: {
          name: LEAD_TEMPLATE_NAME,
          language: { code: TEMPLATE_LANG },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: 'TESTE' },
              { type: 'text', text: 'Cliente Teste' },
              { type: 'text', text: '+5544000000000' },
              { type: 'text', text: 'Agora' },
              { type: 'text', text: 'Mensagem de teste de entrega do template novo_lead.' }
            ]
          }]
        }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    out.template = { ok: true, id: r.data.messages?.[0]?.id };
  } catch (e) {
    out.template = { ok: false, error: e.response?.data?.error || e.message };
  }

  // 2) Tenta TEXTO livre (so entrega se houver janela de 24h aberta)
  try {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: target, type: 'text', text: { body: '🔧 Teste de entrega Ana (texto livre).' } },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    out.texto = { ok: true, id: r.data.messages?.[0]?.id };
  } catch (e) {
    out.texto = { ok: false, error: e.response?.data?.error || e.message };
  }

  // Aguarda o Meta devolver o STATUS REAL de entrega (chega por webhook em segundos).
  // wamid aceito != entregue. Aqui descobrimos se chegou de verdade.
  const wamids = [out.template?.id, out.texto?.id].filter(Boolean);
  if (wamids.length) {
    out.entrega = {};
    for (let i = 0; i < 8 && wamids.some(id => !deliveryStatus[id]); i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (out.template?.id) out.entrega.template = deliveryStatus[out.template.id] || { status: 'sem_retorno' };
    if (out.texto?.id) out.entrega.texto = deliveryStatus[out.texto.id] || { status: 'sem_retorno' };
  }

  // 3) Testa EMAIL via Brevo
  const emailTarget = req.body?.email || specialist?.email || 'willianr.assis@outlook.com';
  try {
    await sendEmailToSpecialist(
      emailTarget,
      '🔧 Teste de entrega — Ana Assis Xavier Advogados',
      `<div style="font-family:Arial,sans-serif;padding:20px">
        <h2 style="color:#1a5276">Teste de email funcionando ✅</h2>
        <p>Este é um email de teste enviado pela Ana — sistema de notificações do escritório.</p>
        <p><b>Remetente:</b> ${EMAIL_FROM || 'não configurado'}</p>
        <p><b>Horário:</b> ${new Date().toLocaleString('pt-BR')}</p>
        <hr><small style="color:#888">Assis e Xavier Advogados</small>
      </div>`
    );
    out.email = { ok: true, to: emailTarget, from: EMAIL_FROM };
  } catch (e) {
    out.email = { ok: false, error: e.message };
  }

  console.log('[Teste] Resultado para', target, JSON.stringify(out));
  res.json(out);
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Chatbot esta funcionando!',
    api: 'Meta WhatsApp Cloud API',
    features: ['texto com debounce 8s', 'audio', 'PDF', 'imagens', 'analise juridica', 'notificacao de especialistas', 'lembrete automatico', 'email de especialistas'],
    specialists: Object.entries(SPECIALISTS).map(([area, s]) => ({ area, name: s.name })),
    config: {
      WHATSAPP_TOKEN: WHATSAPP_TOKEN ? '*** (definido)' : 'NAO DEFINIDO',
      PHONE_NUMBER_ID: PHONE_NUMBER_ID ? `${PHONE_NUMBER_ID.slice(0, 6)}...` : 'NAO DEFINIDO',
      CLAUDE_API_KEY: CLAUDE_API_KEY ? '*** (definido)' : 'NAO DEFINIDO',
      EMAIL_FROM: EMAIL_FROM ? EMAIL_FROM : 'NAO DEFINIDO',
      BREVO_API_KEY: BREVO_API_KEY ? '*** (definido)' : 'NAO DEFINIDO',
      LEAD_TEMPLATE_NAME: LEAD_TEMPLATE_NAME ? LEAD_TEMPLATE_NAME : 'NAO DEFINIDO',
      TEMPLATE_LANG: TEMPLATE_LANG,
      SUPABASE: supabaseEnabled() ? 'conectado' : 'NAO DEFINIDO',
      VERIFY_TOKEN: VERIFY_TOKEN
    }
  });
});

// Pagina de teste acessivel diretamente pelo navegador (sem fetch/JS)
app.get('/admin/test-notify-page', async (req, res) => {
  if (!ADMIN_PASSWORD || req.query.token !== ADMIN_PASSWORD) {
    return res.status(401).send('Acesso negado.');
  }
  const target = SPECIALISTS.imobiliario.phone;
  const emailTarget = SPECIALISTS.imobiliario.email;
  let html = `<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{font-family:Arial,sans-serif;padding:20px;background:#0b141a;color:#e9edef}
  .ok{color:#00a884}.err{color:#ef4444}.wait{color:#ffb74d}
  h2{color:#00a884}pre{background:#202c33;padding:12px;border-radius:8px;font-size:12px;overflow-x:auto}</style></head>
  <body><h2>🔧 Teste de Notificações</h2>`;

  // WhatsApp template
  let templateId = null;
  try {
    const r = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product:'whatsapp', to:target, type:'template', template:{
        name:LEAD_TEMPLATE_NAME, language:{code:TEMPLATE_LANG},
        components:[{type:'body',parameters:[
          {type:'text',text:'TESTE'},{type:'text',text:'Cliente Teste'},
          {type:'text',text:'+5544000000000'},{type:'text',text:'Agora'},
          {type:'text',text:'Mensagem de teste.'}
        ]}]
      }},
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, 'Content-Type':'application/json' } }
    );
    templateId = r.data.messages?.[0]?.id;
    html += `<p class="ok">✅ TEMPLATE WhatsApp: aceito pelo Meta (ID: ${templateId})</p>`;
  } catch(e) {
    html += `<p class="err">❌ TEMPLATE WhatsApp: FALHOU<br><pre>${JSON.stringify(e.response?.data?.error||e.message,null,2)}</pre></p>`;
  }

  // Aguarda status real
  if (templateId) {
    for (let i = 0; i < 8 && !deliveryStatus[templateId]; i++) {
      await new Promise(r => setTimeout(r, 1000));
    }
    const st = deliveryStatus[templateId];
    if (!st) html += `<p class="wait">⏳ Status de entrega: aguardando… (normal, pode levar segundos)</p>`;
    else if (st.status === 'failed') html += `<p class="err">❌ TEMPLATE NÃO ENTREGUE:<br><pre>${JSON.stringify(st.errors,null,2)}</pre></p>`;
    else html += `<p class="ok">✅ TEMPLATE ENTREGUE: ${st.status}</p>`;
  }

  // Email
  try {
    await sendEmailToSpecialist(emailTarget,
      '🔧 Teste de entrega — Ana Assis Xavier Advogados',
      `<div style="font-family:Arial;padding:20px"><h2 style="color:#1a5276">✅ Email funcionando!</h2>
      <p>Remetente: <b>${EMAIL_FROM}</b></p><p>Horário: ${new Date().toLocaleString('pt-BR')}</p></div>`
    );
    html += `<p class="ok">✅ EMAIL: enviado para ${emailTarget} (de ${EMAIL_FROM||'não configurado'})</p>`;
  } catch(e) {
    html += `<p class="err">❌ EMAIL: falhou — ${e.message}</p>`;
  }

  html += `<br><a href="/admin" style="color:#00a884">← Voltar ao painel</a></body></html>`;
  res.send(html);
});

// ===================== DIAGNOSTICO =====================
// Testa de verdade cada peca de que a Ana depende (Claude, Meta WhatsApp,
// Supabase, Brevo) e diz, em portugues, qual esta quebrada e o que fazer.
// Use: /diagnostico  (HTML)  ou  /diagnostico.json
// Se ADMIN_PASSWORD estiver definida, exige ?token=SUA_SENHA.

const DIAG_TIMEOUT = 15000;

function diagResult(nome, ok, detalhe, acao) {
  return { nome, ok, detalhe, acao: ok ? null : acao };
}

async function checarClaude() {
  if (!CLAUDE_API_KEY) {
    return diagResult('Claude (cerebro da Ana)', false, 'CLAUDE_API_KEY nao esta definida no servidor.',
      'No painel do Render > Environment, adicione CLAUDE_API_KEY com a chave de console.anthropic.com > API Keys.');
  }
  try {
    await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-8', max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] },
      {
        timeout: DIAG_TIMEOUT,
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );
    return diagResult('Claude (cerebro da Ana)', true, 'Respondeu normalmente.');
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.error?.message || e.message;
    if (status === 401 || status === 403) {
      return diagResult('Claude (cerebro da Ana)', false, `Chave recusada (HTTP ${status}): ${msg}`,
        'A CLAUDE_API_KEY esta invalida ou foi revogada. Gere uma nova em console.anthropic.com > API Keys e substitua no Render.');
    }
    if (status === 400 && /credit|balance|quota/i.test(msg)) {
      return diagResult('Claude (cerebro da Ana)', false, `Sem creditos: ${msg}`,
        'Adicione creditos em console.anthropic.com > Billing. A Ana volta a responder assim que houver saldo.');
    }
    if (status === 404) {
      return diagResult('Claude (cerebro da Ana)', false, `Modelo recusado: ${msg}`,
        'O modelo configurado nao existe mais para esta conta. Avise para trocarmos o ID do modelo no codigo.');
    }
    if (status === 429) {
      return diagResult('Claude (cerebro da Ana)', false, `Limite de uso atingido: ${msg}`,
        'Aguarde alguns minutos ou aumente o limite em console.anthropic.com > Limits.');
    }
    return diagResult('Claude (cerebro da Ana)', false, `Erro${status ? ' HTTP ' + status : ''}: ${msg}`,
      'Verifique a chave e os creditos em console.anthropic.com.');
  }
}

async function checarWhatsApp() {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    return diagResult('WhatsApp (Meta Cloud API)', false,
      `Faltando: ${!WHATSAPP_TOKEN ? 'WHATSAPP_TOKEN ' : ''}${!PHONE_NUMBER_ID ? 'PHONE_NUMBER_ID' : ''}`,
      'No painel do Render > Environment, preencha as variaveis que faltam com os dados de developers.facebook.com > WhatsApp > API Setup.');
  }
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}`,
      {
        timeout: DIAG_TIMEOUT,
        params: { fields: 'display_phone_number,verified_name,quality_rating,name_status' },
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );
    const d = r.data || {};
    return diagResult('WhatsApp (Meta Cloud API)', true,
      `Numero ${d.display_phone_number || '?'} (${d.verified_name || 'sem nome'}) — qualidade: ${d.quality_rating || 'n/d'}.`);
  } catch (e) {
    const err = e.response?.data?.error || {};
    const code = err.code;
    const msg = err.message || e.message;
    if (code === 190) {
      return diagResult('WhatsApp (Meta Cloud API)', false, `Token expirado ou invalido: ${msg}`,
        'ESTA E A CAUSA MAIS COMUM. O token temporario da Meta dura 24h. Gere um TOKEN PERMANENTE: developers.facebook.com > Configuracoes do Negocio > Usuarios do sistema > criar usuario admin > Gerar novo token > selecionar o app > permissoes whatsapp_business_messaging e whatsapp_business_management > sem expiracao. Depois cole em WHATSAPP_TOKEN no Render.');
    }
    if (code === 100) {
      return diagResult('WhatsApp (Meta Cloud API)', false, `Numero nao encontrado: ${msg}`,
        'O PHONE_NUMBER_ID esta errado. Copie o "Phone number ID" em developers.facebook.com > WhatsApp > API Setup e atualize no Render.');
    }
    if (code === 200 || code === 10) {
      return diagResult('WhatsApp (Meta Cloud API)', false, `Sem permissao: ${msg}`,
        'O token nao tem as permissoes whatsapp_business_messaging e whatsapp_business_management. Gere um novo token com essas duas permissoes.');
    }
    return diagResult('WhatsApp (Meta Cloud API)', false, `Erro${code ? ' (codigo ' + code + ')' : ''}: ${msg}`,
      'Confira o token e o Phone Number ID em developers.facebook.com > WhatsApp > API Setup.');
  }
}

// Descobre, a partir do proprio WHATSAPP_TOKEN, as contas WhatsApp Business (WABA)
// que ele alcanca. Evita pedir ao usuario que ache o ID no painel da Meta.
async function descobrirWabas() {
  if (!WHATSAPP_TOKEN) return [];
  const r = await axios.get('https://graph.facebook.com/v19.0/debug_token', {
    timeout: DIAG_TIMEOUT,
    params: { input_token: WHATSAPP_TOKEN, access_token: WHATSAPP_TOKEN }
  });
  const scopes = r.data?.data?.granular_scopes || [];
  const ids = new Set();
  for (const sc of scopes) {
    if (/whatsapp_business_(management|messaging)/.test(sc.scope || '')) {
      (sc.target_ids || []).forEach(id => ids.add(String(id)));
    }
  }
  if (ids.size) return [...ids];

  // Token com acesso ao negocio inteiro nao traz target_ids. Nesse caso,
  // lista as contas WhatsApp (proprias e de clientes) dos negocios do token.
  const tentativas = [
    { url: 'https://graph.facebook.com/v19.0/me', params: { fields: 'businesses{id,name,owned_whatsapp_business_accounts{id,name},client_whatsapp_business_accounts{id,name}}' } },
    { url: 'https://graph.facebook.com/v19.0/me/businesses', params: { fields: 'id,name,owned_whatsapp_business_accounts{id,name},client_whatsapp_business_accounts{id,name}' } }
  ];
  for (const t of tentativas) {
    try {
      const r2 = await axios.get(t.url, {
        timeout: DIAG_TIMEOUT,
        params: { ...t.params, access_token: WHATSAPP_TOKEN }
      });
      const negocios = r2.data?.businesses?.data || r2.data?.data || [];
      for (const b of negocios) {
        (b.owned_whatsapp_business_accounts?.data || []).forEach(w => ids.add(String(w.id)));
        (b.client_whatsapp_business_accounts?.data || []).forEach(w => ids.add(String(w.id)));
      }
      if (ids.size) break;
    } catch (e) {
      console.log('[Webhook] Descoberta via', t.url.split('v19.0/')[1], 'falhou:', e.response?.data?.error?.message || e.message);
    }
  }
  return [...ids];
}

async function checarWebhookMeta(wabaParam) {
  let wabaId = wabaParam || process.env.WABA_ID;
  if (!wabaId) {
    try {
      const achadas = await descobrirWabas();
      if (achadas.length === 1) wabaId = achadas[0];
      else if (achadas.length > 1) {
        return diagResult('Assinatura do webhook na Meta', true,
          `O token alcanca ${achadas.length} contas (${achadas.join(', ')}). Abra /diagnostico?waba=ID para testar uma delas.`);
      }
    } catch (e) { /* cai no aviso abaixo */ }
  }
  if (!wabaId) {
    return diagResult('Assinatura do webhook na Meta', true,
      'Nao verificado: nao consegui descobrir o ID da conta pelo token. Abra /diagnostico?waba=ID_DA_CONTA_WHATSAPP_BUSINESS para testar.');
  }
  try {
    const r = await axios.get(
      `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
      { timeout: DIAG_TIMEOUT, headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const apps = r.data?.data || [];
    if (!apps.length) {
      return diagResult('Assinatura do webhook na Meta', false, 'Nenhum aplicativo assinado neste numero.',
        'As mensagens dos clientes nao chegam ate a Ana. Em developers.facebook.com > WhatsApp > Configuracao, reassine o webhook e marque o campo "messages".');
    }
    return diagResult('Assinatura do webhook na Meta', true,
      `${apps.length} aplicativo(s) assinado(s): ${apps.map(a => a.whatsapp_business_api_data?.name || a.id).join(', ')}.`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    return diagResult('Assinatura do webhook na Meta', false, `Nao foi possivel consultar: ${msg}`,
      'Confira o WABA_ID e as permissoes do token.');
  }
}

async function checarSupabase() {
  if (!supabaseEnabled()) {
    return diagResult('Supabase (memoria das conversas)', false, 'SUPABASE_URL e/ou SUPABASE_KEY nao definidas.',
      'Sem isso a Ana esquece as conversas a cada reinicio do servidor, mas continua respondendo. Preencha no Render > Environment.');
  }
  try {
    await axios.get(
      `${SUPABASE_URL}/rest/v1/conversations?select=phone&limit=1`,
      { timeout: DIAG_TIMEOUT, headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    return diagResult('Supabase (memoria das conversas)', true, 'Banco respondendo.');
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    if (status === 401 || status === 403) {
      return diagResult('Supabase (memoria das conversas)', false, `Chave recusada (HTTP ${status}): ${msg}`,
        'Gere a chave em supabase.com > Project Settings > API e atualize SUPABASE_KEY no Render.');
    }
    return diagResult('Supabase (memoria das conversas)', false, `Erro${status ? ' HTTP ' + status : ''}: ${msg}`,
      'O projeto pode estar pausado por inatividade. Entre em supabase.com, abra o projeto e clique em "Restore"/"Resume".');
  }
}

async function checarEmail() {
  if (!BREVO_API_KEY) {
    return diagResult('E-mail aos especialistas (Brevo)', false, 'BREVO_API_KEY nao definida.',
      'Sem isso os especialistas nao recebem o e-mail do caso (o WhatsApp continua funcionando). Preencha no Render > Environment.');
  }
  try {
    const r = await axios.get('https://api.brevo.com/v3/account',
      { timeout: DIAG_TIMEOUT, headers: { 'api-key': BREVO_API_KEY, accept: 'application/json' } });
    return diagResult('E-mail aos especialistas (Brevo)', true,
      `Conta ${r.data?.email || 'ok'} ativa. Remetente configurado: ${EMAIL_FROM || 'NAO DEFINIDO'}.`);
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    return diagResult('E-mail aos especialistas (Brevo)', false, `Erro${status ? ' HTTP ' + status : ''}: ${msg}`,
      'Verifique a chave em app.brevo.com > SMTP & API > API Keys e atualize BREVO_API_KEY no Render.');
  }
}

function checarVariaveis() {
  // Criticas: sem elas a Ana simplesmente nao responde.
  const criticas = [];
  if (!CLAUDE_API_KEY) criticas.push('CLAUDE_API_KEY');
  if (!WHATSAPP_TOKEN) criticas.push('WHATSAPP_TOKEN');
  if (!PHONE_NUMBER_ID) criticas.push('PHONE_NUMBER_ID');
  // Secundarias: a Ana responde, mas algum recurso fica capenga.
  const avisos = [];
  if (!ADMIN_PASSWORD) avisos.push('ADMIN_PASSWORD (o painel /admin fica inacessivel)');
  if (!LEAD_TEMPLATE_NAME) avisos.push('LEAD_TEMPLATE_NAME (aviso ao especialista fora da janela de 24h)');
  if (criticas.length) {
    return diagResult('Variaveis de ambiente', false, `Faltando (critico): ${criticas.join(', ')}.`,
      'Preencha no painel do Render > seu servico > Environment > Add Environment Variable e salve (o servico reinicia sozinho).');
  }
  const detalhe = avisos.length
    ? `Essenciais OK. Pendencias menores: ${avisos.join('; ')}.`
    : 'Todas preenchidas.';
  return diagResult('Variaveis de ambiente', true, detalhe);
}

async function rodarDiagnostico(opts = {}) {
  const [claude, whats, webhook, supa, email] = await Promise.all([
    checarClaude(), checarWhatsApp(), checarWebhookMeta(opts.waba), checarSupabase(), checarEmail()
  ]);
  const checks = [checarVariaveis(), claude, whats, webhook, supa, email];
  const criticos = [checks[0], claude, whats, webhook];
  return {
    momento: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    ana_no_ar: criticos.every(c => c.ok),
    servidor: 'online (se voce esta lendo isto, o Render esta rodando)',
    checks
  };
}

function diagAutorizado(req) {
  if (!ADMIN_PASSWORD) return true; // sem senha configurada, nao ha o que exigir
  return req.query.token === ADMIN_PASSWORD;
}

app.get('/diagnostico.json', async (req, res) => {
  if (!diagAutorizado(req)) return res.status(401).json({ erro: 'Acesso negado. Use ?token=SUA_SENHA' });
  res.json(await rodarDiagnostico({ waba: req.query.waba }));
});

app.get('/diagnostico', async (req, res) => {
  if (!diagAutorizado(req)) return res.status(401).send(DIAG_SEM_SENHA);
  const r = await rodarDiagnostico({ waba: req.query.waba });
  const linhas = r.checks.map(c => `
    <div class="card ${c.ok ? 'ok' : 'err'}">
      <div class="t">${c.ok ? '&#9989;' : '&#10060;'} ${c.nome}</div>
      <div class="d">${String(c.detalhe).replace(/</g, '&lt;')}</div>
      ${c.acao ? `<div class="a"><b>O que fazer:</b> ${String(c.acao).replace(/</g, '&lt;')}</div>` : ''}
    </div>`).join('');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Diagnostico da Ana</title>
<style>
body{font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:18px;background:#0b141a;color:#e9edef}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8696a0;font-size:13px;margin-bottom:16px}
.status{padding:14px;border-radius:10px;font-weight:700;margin-bottom:16px;font-size:16px}
.up{background:#0d3b2e;color:#4ade80}.down{background:#3b0d0d;color:#f87171}
.card{background:#202c33;border-radius:10px;padding:14px;margin-bottom:10px;border-left:4px solid #8696a0}
.card.ok{border-left-color:#00a884}.card.err{border-left-color:#ef4444}
.t{font-weight:700;margin-bottom:6px}
.d{font-size:14px;color:#d1d7db;word-break:break-word}
.a{margin-top:10px;font-size:14px;background:#111b21;padding:10px;border-radius:8px;color:#ffd28a}
</style></head><body>
<h1>Diagnostico da Ana</h1>
<div class="sub">${r.momento}</div>
<div class="status ${r.ana_no_ar ? 'up' : 'down'}">
  ${r.ana_no_ar ? 'ANA ESTA FUNCIONANDO — todos os testes essenciais passaram.' : 'ANA ESTA FORA DO AR — veja abaixo o item em vermelho.'}
</div>
${linhas}
<div class="sub" style="margin-top:16px">Versao em dados: <a style="color:#00a884" href="/diagnostico.json${ADMIN_PASSWORD ? '?token=' + encodeURIComponent(req.query.token || '') : ''}">/diagnostico.json</a></div>
</body></html>`);
});

// Reassina o app no webhook da conta WhatsApp Business (WABA). Quando essa
// assinatura cai, a Meta para de entregar as mensagens dos clientes ao servidor
// e a Ana fica muda. Roda AQUI (no Render) porque o servidor tem o token.
// Use: /admin/assinar-webhook?token=ADMIN_PASSWORD&waba=ID_DA_CONTA_WHATSAPP_BUSINESS
const DIAG_SEM_SENHA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Senha necessaria</title><style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;padding:18px;background:#0b141a;color:#e9edef;font-size:15px}code{background:#202c33;padding:2px 6px;border-radius:4px}</style></head>
<body><h2>Falta a senha do painel</h2><p>Adicione <code>?token=SENHA</code> no fim do endereco.</p>
<p><b>Onde achar a senha:</b> dashboard.render.com &gt; servico <i>assis-xavier-whatsapp-bot</i> &gt; aba <b>Environment</b> &gt; linha <b>ADMIN_PASSWORD</b> &gt; toque no icone de olho para revelar.</p></body></html>`;

app.get('/admin/assinar-webhook', async (req, res) => {
  if (!diagAutorizado(req)) return res.status(401).send(DIAG_SEM_SENHA);
  let wabaId = (req.query.waba || process.env.WABA_ID || '').toString().trim();
  const esc = v => String(v).replace(/</g, '&lt;');
  const pagina = (cor, titulo, corpo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Assinar webhook</title>
<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;padding:18px;background:#0b141a;color:#e9edef}
.box{padding:14px;border-radius:10px;margin-bottom:12px;font-size:15px;word-break:break-word}
.ok{background:#0d3b2e;color:#4ade80}.err{background:#3b0d0d;color:#f87171}.info{background:#202c33;color:#d1d7db}
a{color:#00a884}</style></head><body><h2>Assinatura do webhook</h2>
<div class="box ${cor}"><b>${titulo}</b></div><div class="box info">${corpo}</div>
<a href="/diagnostico?token=${encodeURIComponent(req.query.token || '')}&waba=${encodeURIComponent(wabaId)}">Rodar o diagnostico completo</a></body></html>`;

  if (!WHATSAPP_TOKEN) {
    return res.send(pagina('err', 'WHATSAPP_TOKEN nao esta definido no servidor.', 'Preencha no painel do Render > Environment.'));
  }
  let descobertas = [];
  if (!wabaId) {
    try { descobertas = await descobrirWabas(); } catch (e) {
      const err = e.response?.data?.error || {};
      console.error('[Webhook] Falha ao descobrir WABA:', JSON.stringify(err) || e.message);
      if (err.code === 190) {
        return res.send(pagina('err', 'O token do WhatsApp (WHATSAPP_TOKEN) esta expirado ou invalido.',
          `A Meta respondeu: ${esc(err.message)}<br><br><b>O que fazer:</b> gerar um token permanente e colar no Render em WHATSAPP_TOKEN. Passo a passo: business.facebook.com &gt; Configuracoes do negocio &gt; Usuarios &gt; Usuarios do sistema &gt; Adicionar (tipo Admin) &gt; Gerar novo token &gt; escolher o app &quot;Ana - Assis Xavier&quot; &gt; marcar whatsapp_business_messaging e whatsapp_business_management &gt; expiracao: Nunca &gt; Gerar. Depois: Atribuir ativos &gt; Contas do WhatsApp &gt; marcar a conta &gt; Controle total.`));
      }
    }
    if (descobertas.length) wabaId = descobertas.join(',');
  }
  if (!wabaId) {
    return res.send(pagina('err', 'Nao consegui descobrir o ID da conta do WhatsApp Business (WABA) pelo token.',
      'Abra developers.facebook.com > seu app > Casos de uso > Conectar-se com clientes pelo WhatsApp > Inicio rapido/Configuracao da API: copie o "ID da conta do WhatsApp Business" e adicione na URL: <br><code>/admin/assinar-webhook?token=SUA_SENHA&amp;waba=ID_COPIADO</code>'));
  }
  const headers = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
  try {
    const linhas = [];
    for (const id of wabaId.split(',').map(x => x.trim()).filter(Boolean)) {
      const sub = await axios.post(`https://graph.facebook.com/v19.0/${id}/subscribed_apps`, {}, { timeout: DIAG_TIMEOUT, headers });
      const lista = await axios.get(`https://graph.facebook.com/v19.0/${id}/subscribed_apps`, { timeout: DIAG_TIMEOUT, headers });
      const apps = lista.data?.data || [];
      console.log(`[Webhook] Reassinatura na conta ${id}:`, JSON.stringify(sub.data), 'apps:', apps.length);
      linhas.push(`Conta ${esc(id)}: resposta da Meta <code>${esc(JSON.stringify(sub.data))}</code> — aplicativos assinados agora: <b>${apps.length}</b> (${esc(apps.map(a => a.whatsapp_business_api_data?.name || a.id).join(', ') || 'nenhum')})`);
    }
    return res.send(pagina('ok', 'Webhook reassinado com sucesso.',
      linhas.join('<br><br>') + '<br><br>Agora mande "oi" para a Ana de outro celular e aguarde 15 segundos.'));
  } catch (e) {
    const err = e.response?.data?.error || {};
    console.error('[Webhook] Falha ao reassinar:', JSON.stringify(err) || e.message);
    let dica = 'Confira o ID da conta e o token.';
    if (err.code === 190) dica = 'O WHATSAPP_TOKEN esta expirado/invalido. Gere um token permanente (Usuario do sistema no Gerenciador de Negocios) e atualize no Render.';
    else if (err.code === 100) dica = 'O ID da conta do WhatsApp Business parece errado. Copie o "ID da conta do WhatsApp Business" (nao o Phone Number ID nem o ID do app).';
    else if (err.code === 200 || err.code === 10) dica = 'O token nao tem a permissao whatsapp_business_management. Gere um novo token com whatsapp_business_messaging e whatsapp_business_management.';
    return res.send(pagina('err', 'A Meta recusou a assinatura.',
      `Erro${err.code ? ' (codigo ' + err.code + ')' : ''}: ${esc(err.message || e.message)}<br><br><b>O que fazer:</b> ${dica}`));
  }
});
// =================== FIM DO DIAGNOSTICO ===================

// ===================== TRIAGEM POR PERIODO =====================
// Relatorio de quem procurou a Ana entre duas datas, montado a partir do
// Supabase (+ memoria), cruzado com as estatisticas de conversas da Meta para
// revelar dias em que clientes escreveram mas nada chegou ao servidor.
// Use: /admin/triagem?token=SENHA&de=2026-08-17&ate=2026-09-04[&waba=ID]
//      /admin/triagem.json (mesmos parametros)

const TZ_SP = 'America/Sao_Paulo';

function dataSP(d) {
  // Data local (YYYY-MM-DD) em Sao Paulo de um Date/ISO
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return null;
  return dt.toLocaleDateString('sv-SE', { timeZone: TZ_SP }); // sv-SE => 2026-09-04
}
function horaSP(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleString('pt-BR', { timeZone: TZ_SP, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function validaData(s, padrao) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? s : padrao;
}

async function estatisticasMeta(wabaId, de, ate) {
  // Conversas por dia segundo a Meta (quem iniciou: cliente ou escritorio).
  if (!WHATSAPP_TOKEN || !wabaId) return { erro: 'sem WABA_ID' };
  const ini = Math.floor(new Date(`${de}T00:00:00-03:00`).getTime() / 1000);
  const fim = Math.floor(new Date(`${ate}T23:59:59-03:00`).getTime() / 1000);
  try {
    const r = await axios.get(`https://graph.facebook.com/v19.0/${wabaId}`, {
      timeout: DIAG_TIMEOUT,
      params: {
        fields: `conversation_analytics.start(${ini}).end(${fim}).granularity(DAILY).dimensions(CONVERSATION_DIRECTION)`,
        access_token: WHATSAPP_TOKEN
      }
    });
    const pontos = r.data?.conversation_analytics?.data?.[0]?.data_points || [];
    const porDia = {};
    for (const p of pontos) {
      const dia = dataSP(p.start * 1000);
      porDia[dia] = porDia[dia] || { cliente: 0, escritorio: 0 };
      if (p.conversation_direction === 'USER_INITIATED') porDia[dia].cliente += p.conversation || 0;
      else porDia[dia].escritorio += p.conversation || 0;
    }
    return { porDia };
  } catch (e) {
    return { erro: e.response?.data?.error?.message || e.message };
  }
}

async function montarTriagem(opts) {
  const hoje = dataSP(new Date());
  const de = validaData(opts.de, '2026-08-17');
  const ate = validaData(opts.ate, hoje);
  const inicio = new Date(`${de}T00:00:00-03:00`).getTime();
  const fim = new Date(`${ate}T23:59:59.999-03:00`).getTime();

  // Junta Supabase + memoria, priorizando o que estiver mais completo
  const fontes = {};
  const rows = (await supabaseGetAll()) || [];
  for (const row of rows) fontes[row.phone] = { messages: row.messages || [], meta: row.meta || null, handled: !!row.handled, updated_at: row.updated_at || null };
  for (const [phone, msgs] of Object.entries(conversationHistory)) {
    const f = fontes[phone] || { messages: [], meta: null, handled: false, updated_at: null };
    if ((msgs || []).length >= f.messages.length) f.messages = msgs;
    f.meta = conversationMeta[phone] || f.meta;
    fontes[phone] = f;
  }

  const textoDe = (m) => {
    if (typeof m.content === 'string') return m.content.trim();
    if (Array.isArray(m.content)) return m.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    return '';
  };

  const clientes = [];
  for (const [phone, f] of Object.entries(fontes)) {
    if (phone.startsWith('TRIAGE#')) continue;          // linhas internas de triagem trabalhista
    if (findSpecialistByPhone(phone)) continue;         // advogados do escritorio nao sao clientes

    const todas = (f.messages || []).map(m => ({ role: m.role, text: textoDe(m), ts: m.ts ? new Date(m.ts).getTime() : null }))
      .filter(m => m.text);
    const comData = todas.filter(m => m.ts);
    let noPeriodo;
    if (comData.length) {
      noPeriodo = todas.filter(m => m.ts && m.ts >= inicio && m.ts <= fim);
    } else {
      // Historico antigo sem data por mensagem: usa a data de atualizacao da linha
      const up = f.updated_at ? new Date(f.updated_at).getTime() : null;
      noPeriodo = (up && up >= inicio && up <= fim) ? todas : [];
    }
    if (!noPeriodo.length) continue;

    const doCliente = noPeriodo.filter(m => m.role === 'user');
    const daAna = noPeriodo.filter(m => m.role === 'assistant');
    if (!doCliente.length) continue;

    const ultima = noPeriodo[noPeriodo.length - 1];
    const primeiroContato = doCliente[0].ts || (f.updated_at ? new Date(f.updated_at).getTime() : null);
    const ultimoContato = doCliente[doCliente.length - 1].ts || primeiroContato;
    const meta = f.meta || {};
    clientes.push({
      telefone: phone,
      nome: meta.nome || null,
      area: meta.area || null,
      especialista: meta.especialista || null,
      horario: meta.horario || null,
      encaminhado: !!meta.especialista,
      tratado: !!f.handled,
      primeiro_contato: primeiroContato,
      ultimo_contato: ultimoContato,
      msgs_cliente: doCliente.length,
      msgs_ana: daAna.length,
      sem_resposta: ultima.role === 'user',
      primeira_msg: doCliente[0].text.slice(0, 220),
      ultima_msg: doCliente[doCliente.length - 1].text.slice(0, 220)
    });
  }
  clientes.sort((a, b) => (b.ultimo_contato || 0) - (a.ultimo_contato || 0));

  // Conversas registradas no servidor, por dia (para cruzar com a Meta)
  const servidorPorDia = {};
  for (const c of clientes) {
    const dia = dataSP(c.primeiro_contato);
    if (dia) servidorPorDia[dia] = (servidorPorDia[dia] || 0) + 1;
  }

  let wabaId = opts.waba || process.env.WABA_ID || null;
  if (!wabaId) { try { const w = await descobrirWabas(); if (w.length === 1) wabaId = w[0]; } catch (e) { /* segue sem Meta */ } }
  const meta = await estatisticasMeta(wabaId, de, ate);

  const dias = [];
  for (let t = inicio; t <= fim; t += 86400000) {
    const dia = dataSP(t);
    const m = meta.porDia?.[dia];
    dias.push({ dia, meta_cliente: m ? m.cliente : null, meta_escritorio: m ? m.escritorio : null, servidor: servidorPorDia[dia] || 0 });
  }
  const perdidas = meta.porDia
    ? dias.reduce((s, d) => s + Math.max(0, (d.meta_cliente || 0) - d.servidor), 0)
    : null;

  return {
    periodo: { de, ate },
    gerado_em: new Date().toLocaleString('pt-BR', { timeZone: TZ_SP }),
    resumo: {
      clientes: clientes.length,
      encaminhados_ao_especialista: clientes.filter(c => c.encaminhado).length,
      sem_resposta_da_ana: clientes.filter(c => c.sem_resposta).length,
      ainda_nao_tratados: clientes.filter(c => !c.tratado).length,
      conversas_de_clientes_segundo_meta: meta.porDia ? dias.reduce((s, d) => s + (d.meta_cliente || 0), 0) : null,
      possivelmente_perdidas: perdidas
    },
    meta_erro: meta.erro || null,
    waba: wabaId,
    dias,
    clientes
  };
}

app.get('/admin/triagem.json', async (req, res) => {
  if (!diagAutorizado(req)) return res.status(401).send(DIAG_SEM_SENHA);
  res.json(await montarTriagem(req.query));
});

app.get('/admin/triagem', async (req, res) => {
  if (!diagAutorizado(req)) return res.status(401).send(DIAG_SEM_SENHA);
  const r = await montarTriagem(req.query);
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fmtDia = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}`; };

  const cards = r.clientes.map(c => `
    <div class="card ${c.sem_resposta ? 'alerta' : (c.encaminhado ? 'ok' : '')}">
      <div class="top"><b>${esc(c.nome || 'Nome nao informado')}</b> <span class="tel">+${esc(c.telefone)}</span></div>
      <div class="linha">${esc(horaSP(c.primeiro_contato))}${c.msgs_cliente > 1 ? ` &rarr; ${esc(horaSP(c.ultimo_contato))}` : ''} &middot; ${c.msgs_cliente} msg do cliente, ${c.msgs_ana} da Ana</div>
      ${c.area ? `<div class="linha">Area: <b>${esc(c.area)}</b> &middot; ${esc(c.especialista)}${c.horario ? ` &middot; prefere ${esc(c.horario)}` : ''}</div>` : ''}
      <div class="tags">
        ${c.encaminhado ? '<span class="tag verde">encaminhado ao especialista</span>' : '<span class="tag cinza">nao encaminhado</span>'}
        ${c.sem_resposta ? '<span class="tag vermelha">ULTIMA MENSAGEM SEM RESPOSTA</span>' : ''}
        ${c.tratado ? '<span class="tag azul">tratado no painel</span>' : ''}
      </div>
      <div class="msg">&ldquo;${esc(c.ultima_msg)}&rdquo;</div>
      <a class="zap" href="https://wa.me/${esc(c.telefone)}">Abrir conversa no WhatsApp</a>
    </div>`).join('');

  const tabelaDias = r.dias.map(d => {
    const perdeu = d.meta_cliente != null && d.meta_cliente > d.servidor;
    return `<tr class="${perdeu ? 'perdeu' : ''}"><td>${fmtDia(d.dia)}</td><td>${d.meta_cliente == null ? '&ndash;' : d.meta_cliente}</td><td>${d.servidor}</td><td>${perdeu ? '&#9888; ' + (d.meta_cliente - d.servidor) + ' nao chegou' : ''}</td></tr>`;
  }).join('');

  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Triagem ${esc(r.periodo.de)} a ${esc(r.periodo.ate)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:0;padding:16px;background:#0b141a;color:#e9edef}
h1{font-size:20px;margin:0 0 2px}.sub{color:#8696a0;font-size:13px;margin-bottom:14px}
.kpis{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.kpi{background:#202c33;border-radius:10px;padding:10px}.kpi b{font-size:22px;display:block}.kpi span{font-size:12px;color:#8696a0}
.kpi.ruim b{color:#f87171}.kpi.bom b{color:#4ade80}
h2{font-size:16px;margin:18px 0 8px}
.card{background:#202c33;border-radius:10px;padding:12px;margin-bottom:10px;border-left:4px solid #8696a0}
.card.ok{border-left-color:#00a884}.card.alerta{border-left-color:#ef4444}
.top{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}.tel{color:#8696a0;font-size:13px}
.linha{font-size:13px;color:#d1d7db;margin-top:4px}
.tags{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
.tag{font-size:11px;padding:2px 8px;border-radius:999px;background:#37474f;color:#e9edef}
.tag.verde{background:#0d3b2e;color:#4ade80}.tag.vermelha{background:#3b0d0d;color:#f87171}.tag.azul{background:#0d2a3b;color:#7dd3fc}.tag.cinza{background:#2a3942;color:#8696a0}
.msg{margin-top:8px;font-size:14px;color:#e9edef;background:#111b21;padding:8px;border-radius:8px}
.zap{display:inline-block;margin-top:8px;color:#00a884;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px;background:#202c33;border-radius:10px;overflow:hidden}
th,td{padding:6px 8px;text-align:left;border-bottom:1px solid #2a3942}th{color:#8696a0;font-weight:600;font-size:12px}
tr.perdeu td{color:#fbbf24}
.aviso{background:#3b2a0d;color:#fbbf24;padding:10px;border-radius:8px;font-size:13px;margin-bottom:12px}
.form{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}.form input{background:#202c33;color:#e9edef;border:1px solid #37474f;border-radius:8px;padding:8px}
.form button{background:#00a884;color:#fff;border:0;border-radius:8px;padding:8px 12px}
</style></head><body>
<h1>Quem procurou a Ana</h1>
<div class="sub">${esc(fmtDia(r.periodo.de))} a ${esc(fmtDia(r.periodo.ate))} &middot; gerado ${esc(r.gerado_em)}</div>
<form class="form" method="get">
  <input type="hidden" name="token" value="${esc(req.query.token || '')}">
  ${r.waba ? `<input type="hidden" name="waba" value="${esc(r.waba)}">` : ''}
  <input type="date" name="de" value="${esc(r.periodo.de)}"><input type="date" name="ate" value="${esc(r.periodo.ate)}"><button>Filtrar</button>
</form>
<div class="kpis">
  <div class="kpi"><b>${r.resumo.clientes}</b><span>clientes que chegaram ao servidor</span></div>
  <div class="kpi bom"><b>${r.resumo.encaminhados_ao_especialista}</b><span>encaminhados ao especialista</span></div>
  <div class="kpi ruim"><b>${r.resumo.sem_resposta_da_ana}</b><span>ficaram sem resposta da Ana</span></div>
  <div class="kpi ${r.resumo.possivelmente_perdidas ? 'ruim' : ''}"><b>${r.resumo.possivelmente_perdidas == null ? '&ndash;' : r.resumo.possivelmente_perdidas}</b><span>conversas que a Meta contou mas nao chegaram</span></div>
</div>
${r.meta_erro ? `<div class="aviso">Nao consegui as estatisticas da Meta (${esc(r.meta_erro)}). A coluna "Meta" fica vazia; adicione &amp;waba=ID_DA_CONTA no link.</div>` : ''}
${r.resumo.possivelmente_perdidas ? `<div class="aviso">&#9888; Nos dias marcados, clientes iniciaram conversa segundo a Meta, mas nada chegou ao servidor (webhook desassinado). Esses contatos nao tem registro de numero nem de mensagem &mdash; a Meta nao guarda o conteudo. Veja "Conversas do WhatsApp" no Gerenciador de Negocios da Meta para o total do periodo.</div>` : ''}
<h2>Clientes (${r.clientes.length})</h2>
${cards || '<div class="card">Nenhum cliente registrado no servidor neste periodo.</div>'}
<h2>Dia a dia</h2>
<table><tr><th>Dia</th><th>Meta: iniciadas por cliente</th><th>Servidor: registradas</th><th></th></tr>${tabelaDias}</table>
<div class="sub" style="margin-top:12px">Dados: <a style="color:#00a884" href="/admin/triagem.json?token=${encodeURIComponent(req.query.token || '')}&de=${esc(r.periodo.de)}&ate=${esc(r.periodo.ate)}${r.waba ? '&waba=' + esc(r.waba) : ''}">/admin/triagem.json</a></div>
</body></html>`);
});
// =================== FIM DA TRIAGEM ===================



app.listen(PORT, () => {
  console.log(`Chatbot Assis e Xavier Advogados rodando na porta ${PORT}`);
  console.log(`WhatsApp escritorio: ${ESCRITORIO_PHONE}`);
  console.log(`Webhook: GET|POST /webhook`);

  // Cutuca o Supabase a cada 6h para nao pausar por inatividade (limite de 7 dias)
  if (supabaseEnabled()) {
    setInterval(async () => {
      try {
        await axios.get(
          `${SUPABASE_URL}/rest/v1/conversations?select=phone&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        console.log('[Ping] Supabase ativo');
      } catch (e) {
        console.log('[Ping] Falha no ping do Supabase:', e.message);
      }
    }, 6 * 60 * 60 * 1000);
  }
});
