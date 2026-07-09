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
1. Primeira mensagem: se apresente brevemente e pergunte o que esta acontecendo
2. Com a resposta, identifique a area juridica

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

    // 2) Fallback: texto livre (so funciona se estiver dentro da janela de 24h)
    if (!templateOk) {
      try {
        await sendWhatsAppMessage(specialist.phone, whatsappMsg);
        console.log(`[Especialista] WhatsApp (texto livre) enviado para ${specialist.name}`);
      } catch (e) {
        console.error('[Especialista] Erro WhatsApp:', e.message);
      }
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
      `⚖️ *TRIAGEM - Caso trabalhista*  [${code}]\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `💰 *Salario:* ${salario}\n` +
      `🕐 *Tempo:* ${tempo_trabalho}\n\n` +
      `📋 ${resumo_caso}\n\n` +
      `*O escritorio assume este caso?*\n` +
      `Responda *SIM ${code}* ou *NAO ${code}* _(pode responder so SIM ou NAO tambem)._`;

    // 1) Template aprovado (chega mesmo fora da janela de 24h)
    await sendWhatsAppTemplate(specialist.phone, [
      `TRIAGEM trabalhista - responda SIM ${code} ou NAO ${code}`,
      nome_cliente,
      `Salario ${salario} | ${tempo_trabalho}`,
      `Codigo ${code}`,
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

// Interpreta a resposta do especialista a uma triagem. Retorna:
//   { code, aceito }  quando conseguiu identificar caso + decisao
//   { needCode: true } quando ha triagem pendente mas falta o codigo/decisao clara
//   null               quando nao parece ser uma resposta de triagem
async function interpretTriageReply(message, senderNumber) {
  const isSpecialist = Object.values(SPECIALISTS).some(s => s.phone === senderNumber);
  if (!isSpecialist) return null;

  const text = (message.text?.body || '').trim();
  const upper = text.toUpperCase();

  // 1) Localiza o codigo: por "responder" do WhatsApp, por token no texto, ou triagem unica pendente
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

  const pendingForSpecialist = Object.entries(pendingTriage)
    .filter(([, t]) => t.specialistPhone === senderNumber);

  if (!code && pendingForSpecialist.length === 1) code = pendingForSpecialist[0][0];

  // Se nao ha nenhum indicio de triagem, deixa seguir o fluxo normal da Ana
  if (!code && pendingForSpecialist.length === 0) return null;

  // 2) Detecta a decisao
  const simRe = /\b(SIM|ACEITO|ACEITAR|ACEITA|INTERESSA|PODE|VAI|OK|POSITIVO|ASSUM\w*)\b/;
  const naoRe = /\b(NAO|NÃO|RECUSO|RECUSAR|RECUSA|DESCARTA\w*|PASSO|NEGATIVO|NEGADO)\b/;
  const disseSim = simRe.test(upper);
  const disseNao = naoRe.test(upper);

  if (disseSim === disseNao) return { needCode: !code, ambiguous: true, code };
  if (!code) return { needCode: true };

  return { code, aceito: disseSim };
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

    // Resposta de um especialista a uma triagem trabalhista (SIM/NAO)?
    // Precisa ser tratada ANTES do fluxo normal para nao virar conversa da Ana.
    if (message.type === 'text') {
      const triage = await interpretTriageReply(message, senderNumber);
      if (triage) {
        if (triage.code && typeof triage.aceito === 'boolean') {
          await resolveTriage(triage.code, triage.aceito);
          await sendWhatsAppMessage(
            senderNumber,
            triage.aceito
              ? `✅ Caso ${triage.code} confirmado. Cliente avisado e notificacao completa enviada.`
              : `👍 Caso ${triage.code} recusado. Cliente comunicado de forma educada. Obrigado!`
          );
        } else if (triage.ambiguous && triage.code) {
          await sendWhatsAppMessage(
            senderNumber,
            `Nao entendi a decisao do caso ${triage.code}. Responda *SIM ${triage.code}* ou *NAO ${triage.code}*, por favor.`
          );
        } else {
          await sendWhatsAppMessage(
            senderNumber,
            `Ha caso(s) de triagem aguardando resposta. Responda com o codigo, ex: *SIM ABC* ou *NAO ABC*.`
          );
        }
        return;
      }
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
      result[phone] = {
        messages: textMsgs,
        meta: conversationMeta[phone] || existing.meta || null,
        handled: existing.handled || false,
        updated_at: new Date().toISOString()
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
