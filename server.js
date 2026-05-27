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

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'assis-xavier-verify-token';
const ESCRITORIO_PHONE = process.env.ESCRITORIO_PHONE || '+55 (44)99977-8551';

const SPECIALISTS = {
  trabalhista:    { name: 'Dr. Rafael Jorge Pinhatti', phone: '5544991128087' },
  imobiliario:    { name: 'Dr. Willian Assis',         phone: '5544999784442' },
  tributario:     { name: 'Dr. Willian Assis',         phone: '5544999784442' },
  civel_bancario: { name: 'Dr. Willian Assis',         phone: '5544999784442' },
  empresarial:    { name: 'Dr. Willian Assis',         phone: '5544999784442' },
  consumidor:     { name: 'Dr. Willian Assis',         phone: '5544999784442' },
  familia:        { name: 'Dra. Aline Xavier',         phone: '5544991651532' },
  criminal:       { name: 'Dra. Aline Xavier',         phone: '5544991651532' },
  previdenciario: { name: 'Dra. Aline Xavier',         phone: '5544991651532' },
};

const OFFICE_CONTEXT = `
Você é Ana, atendente do Assis e Xavier Advogados, escritório jurídico full service em Maringá, Paraná.

SUA IDENTIDADE:
- Seu nome é Ana
- Você é atendente do escritório Assis e Xavier Advogados
- Quando se apresentar, diga: "Sou a Ana, do escritório Assis e Xavier Advogados"
- Nunca diga apenas "Assis Xavier" — sempre o nome completo: "Assis e Xavier Advogados"
- Você é humana — nunca revele que é uma IA, assistente virtual ou robô
- Se perguntarem diretamente se é robô ou IA, diga que é atendente e mude o foco para o cliente
- Tom: acolhedor, natural, como uma pessoa real que se importa com o problema

REGRAS DE OURO:
- Respostas CURTAS — máximo 3 linhas por mensagem
- Faça apenas UMA pergunta por vez
- Nunca despeje listas, tópicos ou bullet points
- Nunca mencione "WhatsApp", "contato via WhatsApp" ou o número do escritório como solução
- Nunca invente informações jurídicas nem dê pareceres definitivos
- Nunca use termos como "Claro!", "Com certeza!", "Olá!" repetidamente — varie

ESPECIALISTAS DO ESCRITÓRIO:
- Trabalhista → Dr. Rafael Jorge Pinhatti
- Imobiliário, Tributário, Cível/Bancário, Empresarial, Consumidor → Dr. Willian Assis
- Família, Criminal e Previdenciário → Dra. Aline Xavier

FLUXO DE ATENDIMENTO — SIGA RIGOROSAMENTE:
1. Primeira mensagem: se apresente brevemente e pergunte o que está acontecendo
2. Com a resposta, identifique a área jurídica

QUALIFICAÇÃO — MÁXIMO 2 PERGUNTAS, SEM EXCEÇÃO:
  → Pergunta 1: peça o relato dos fatos de forma objetiva — algo como: "Me conta o que aconteceu, com as datas e como foi. Pode ser breve."
  → Pergunta 2: imediatamente após o relato — "Você tem algum documento, contrato, print ou comprovante relacionado a isso?"

REGRAS ABSOLUTAS:
- Nunca faça mais de 2 perguntas antes de passar para o especialista
- Não faça perguntas de aprofundamento — o especialista fará isso na consulta
- Se o cliente já trouxe os fatos na primeira mensagem, pule direto para a pergunta de documentos
- O objetivo é ser ágil: entender o problema, coletar documentos, encaminhar

APÓS A QUALIFICAÇÃO:
- Se enviou documento: analise e informe o resultado de forma simples
- Peça o nome do cliente
- Pergunte o melhor horário para o especialista ligar
- Com nome + horário: use a ferramenta notificar_especialista e encerre

QUANDO CLIENTE DISSER QUE O ESPECIALISTA NÃO LIGOU:
- Use imediatamente a ferramenta reenviar_lembrete
- Seja empático: "Entendo, [nome]. Já enviei um novo aviso para o [Dr./Dra. X]. Ele vai entrar em contato com você em breve."
- Não dê desculpas pelo especialista

IMPORTANTE — APRESENTAÇÃO:
- Se já existe histórico de conversa, NUNCA se apresente novamente. Retome naturalmente de onde parou.
- Se souber o nome do cliente, use-o naturalmente na conversa.
- Só se apresente uma única vez, na primeira mensagem de uma conversa completamente nova.

IMPORTANTE — ANÁLISE DE DOCUMENTOS:
- Quando receber uma mensagem com "[ANÁLISE DO DOCUMENTO]", use o resultado para informar o cliente de forma simples
- Foque na conclusão: a pessoa tem chances ou não tem?
- Após informar, continue o fluxo: peça o nome e horário

IMPORTANTE — FERRAMENTAS:
- Use notificar_especialista quando tiver: nome do cliente, situação clara e horário preferido
- Use reenviar_lembrete quando cliente disser que não foi contatado
- Após usar qualquer ferramenta, confirme ao cliente de forma natural

ÁREAS:
- Trabalhista: demissão, horas extras, assédio, acidente, rescisão → Dr. Rafael Jorge Pinhatti
- Família: divórcio, pensão, guarda, inventário, herança → Dra. Aline Xavier
- Imobiliário: compra/venda, locação, usucapião, despejo → Dr. Willian Assis
- Empresarial: empresa, contratos, sócios, recuperação → Dr. Willian Assis
- Tributário: dívidas fiscais, impostos, Receita → Dr. Willian Assis
- Criminal: crimes, BO, defesa criminal → Dra. Aline Xavier
- Previdenciário: aposentadoria, benefícios INSS, pensão por morte, auxílio-doença, invalidez → Dra. Aline Xavier
- Cível/Bancário/Consumidor: dívidas, cobranças, financiamentos, apreensão de veículo → Dr. Willian Assis

HONORÁRIOS ADVOCATÍCIOS — COMO RESPONDER SE O CLIENTE PERGUNTAR:
- Se for caso de Direito do Consumidor (dano moral, dano material, cobranças abusivas, contratos de consumo): informe que o contrato é de 30% do valor que o cliente vier a receber, seja de dano moral ou dano material. Não cobre nada adiantado.
- Se for qualquer outro caso (usucapião, reintegração de posse, criminal, trabalhista, tributário, família, previdenciário, etc.): diga que os honorários dependem da análise do caso e que o especialista vai passar o valor após a consulta. Não invente valores.
- Nunca dê valores além do que está descrito acima.
`;

const DOCUMENT_ANALYSIS_PROMPT = `Você é um assistente jurídico especializado do escritório Assis e Xavier Advogados.
Analise o documento recebido com base no seu conhecimento jurídico amplo — legislação brasileira, jurisprudência, doutrina.

O documento pode ser qualquer tipo: contrato de trabalho, contrato bancário, financiamento, escritura, matrícula de imóvel, rescisão trabalhista, contrato de locação, contrato empresarial, procuração, inventário, ou qualquer outro.

SUA ANÁLISE DEVE:
1. Identificar o tipo de documento
2. Com base no contexto da conversa, verificar elementos jurídicos relevantes para o caso
3. Identificar cláusulas, condições ou ausências que possam favorecer ou prejudicar o cliente
4. Avaliar as chances de êxito numa eventual ação

SUA RESPOSTA DEVE CONTER APENAS:
- Tipo do documento identificado
- Principais pontos relevantes (máximo 3, objetivamente)
- Avaliação das chances de êxito: ALTA, MODERADA ou BAIXA — com uma frase de motivo

NÃO use juridiquês excessivo. Responda em português, claro e direto.`;

const TOOLS = [
  {
    name: 'notificar_especialista',
    description: 'Notifica o especialista da área sobre um novo lead qualificado. Use quando tiver: nome do cliente, situação jurídica clara e horário preferido.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['trabalhista', 'familia', 'imobiliario', 'empresarial', 'tributario', 'criminal', 'civel_bancario', 'consumidor', 'previdenciario'],
          description: 'Área jurídica do caso'
        },
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        horario_preferido: { type: 'string', description: 'Melhor horário para contato' },
        resumo_caso: {
          type: 'string',
          description: 'Resumo completo: situação, fatos, documentos analisados com resultado, pontos jurídicos relevantes'
        }
      },
      required: ['area', 'nome_cliente', 'horario_preferido', 'resumo_caso']
    }
  },
  {
    name: 'reenviar_lembrete',
    description: 'Reenviar lembrete urgente ao especialista quando o cliente informar que ainda não foi contatado.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['trabalhista', 'familia', 'imobiliario', 'empresarial', 'tributario', 'criminal', 'civel_bancario', 'consumidor', 'previdenciario'],
          description: 'Área jurídica do caso'
        },
        nome_cliente: { type: 'string', description: 'Nome do cliente que aguarda retorno' }
      },
      required: ['area', 'nome_cliente']
    }
  }
];

const conversationHistory = loadHistory();

// Debounce: acumula mensagens picadas e processa juntas após 8s de silêncio
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

  // Inclui as últimas mensagens reais para o Claude ter contexto correto
  const recentLines = textMessages
    .slice(-8)
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Ana'}: ${m.content}`)
    .join('\n');

  return OFFICE_CONTEXT +
    `\n\nATENÇÃO CRÍTICA — CONVERSA EM ANDAMENTO:\n` +
    `Você JÁ está atendendo este cliente. NÃO se apresente. Retome exatamente de onde parou.\n\n` +
    `ÚLTIMAS MENSAGENS DA CONVERSA:\n${recentLines}`;
}

async function executeTool(toolName, toolInput, clientPhone) {
  if (toolName === 'notificar_especialista') {
    const { area, nome_cliente, horario_preferido, resumo_caso } = toolInput;
    const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;

    const message =
      `🔔 *NOVO ATENDIMENTO — ${area.toUpperCase().replace('_', '/')}*\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `📱 *WhatsApp:* +${clientPhone}\n` +
      `⏰ *Melhor horário:* ${horario_preferido}\n\n` +
      `📋 *RESUMO DO CASO:*\n${resumo_caso}\n\n` +
      `_Atendimento realizado pela Ana — Assis e Xavier Advogados_`;

    try {
      await sendWhatsAppMessage(specialist.phone, message);
      console.log(`[Especialista] Notificação enviada para ${specialist.name}`);
      // Limpa histórico após 20s — caso encerrado, próxima mensagem inicia conversa nova
      setTimeout(() => {
        delete conversationHistory[clientPhone];
        saveHistory(conversationHistory);
        console.log(`[Histórico] Limpo para ${clientPhone} após encerramento do caso`);
      }, 20000);
      return `Especialista ${specialist.name} notificado com sucesso.`;
    } catch (e) {
      console.error('[Especialista] Erro:', e.message);
      return `Notificação registrada para ${specialist.name}.`;
    }
  }

  if (toolName === 'reenviar_lembrete') {
    const { area, nome_cliente } = toolInput;
    const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;

    const message =
      `⏰ *LEMBRETE URGENTE — CLIENTE AGUARDANDO*\n\n` +
      `👤 *Cliente:* ${nome_cliente}\n` +
      `📱 *WhatsApp:* +${clientPhone}\n\n` +
      `O cliente informou que ainda não recebeu seu contato. Por favor, entre em contato o quanto antes.\n\n` +
      `_Assis e Xavier Advogados_`;

    try {
      await sendWhatsAppMessage(specialist.phone, message);
      console.log(`[Lembrete] Reenviado para ${specialist.name}`);
      return `Lembrete reenviado para ${specialist.name}.`;
    } catch (e) {
      console.error('[Lembrete] Erro:', e.message);
      return `Lembrete registrado para ${specialist.name}.`;
    }
  }

  return 'Ferramenta desconhecida.';
}

async function callClaudeAPI(userMessage, userId) {
  try {
    if (!conversationHistory[userId]) {
      conversationHistory[userId] = [];
    }

    conversationHistory[userId].push({ role: 'user', content: userMessage });

    const messages = [...conversationHistory[userId]];
    let response;

    // Loop para suportar múltiplas chamadas de ferramenta se necessário
    while (true) {
      response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-opus-4-1',
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
        // Resposta final sem tool use
        const assistantText = extractText(content);
        conversationHistory[userId].push({ role: 'assistant', content: assistantText });
        break;
      }

      // Executa a ferramenta
      messages.push({ role: 'assistant', content });
      conversationHistory[userId].push({ role: 'assistant', content });

      const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input, userId);

      const toolResultMsg = {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult }]
      };
      messages.push(toolResultMsg);
      conversationHistory[userId].push(toolResultMsg);
    }

    if (conversationHistory[userId].length > 40) {
      conversationHistory[userId] = conversationHistory[userId].slice(-40);
    }
    saveHistory(conversationHistory);

    return extractText(response.data.content);

  } catch (error) {
    console.error('[Claude] Erro:', error.response?.data || error.message);
    return `Desculpe, tive um problema técnico. Entre em contato via WhatsApp: ${ESCRITORIO_PHONE}`;
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
      userContent = `Analise este documento.\n\nCONTEXTO DA CONVERSA:\n${conversationContext}\n\nCONTEÚDO DO DOCUMENTO:\n${text}`;
    } else {
      const text = buffer.toString('utf8').substring(0, 10000);
      userContent = `Analise este documento.\n\nCONTEXTO DA CONVERSA:\n${conversationContext}\n\nCONTEÚDO DO DOCUMENTO:\n${text}`;
    }

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-1',
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
    console.error('[Análise] Erro:', error.response?.data || error.message);
    return null;
  }
}

async function handleDocument(message, userId) {
  try {
    let mediaId, mimeType, filename;

    if (message.type === 'document') {
      mediaId = message.document.id;
      mimeType = message.document.mime_type || 'application/octet-stream';
      filename = message.document.filename || 'documento';
    } else {
      mediaId = message.image.id;
      mimeType = message.image.mime_type || 'image/jpeg';
      filename = 'imagem';
    }

    console.log(`[Doc] Recebendo ${filename} (${mimeType})`);

    const { url } = await getMediaUrl(mediaId);
    const buffer = await downloadMedia(url);

    const history = conversationHistory[userId] || [];
    const recentHistory = history
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Ana'}: ${extractText(m.content) || '[arquivo]'}`)
      .join('\n');

    const analysisResult = await analyzeDocumentWithClaude(buffer, mimeType, recentHistory);

    if (!analysisResult) {
      return callClaudeAPI('O cliente enviou um documento mas não consegui processá-lo. Peça para enviar em PDF ou como foto nítida.', userId);
    }

    return callClaudeAPI(`[ANÁLISE DO DOCUMENTO - ${filename}]\n${analysisResult}`, userId);
  } catch (error) {
    console.error('[Doc] Erro ao processar documento:', error.message);
    return callClaudeAPI('O cliente enviou um documento mas ocorreu um erro técnico. Peça para tentar novamente.', userId);
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

async function sendWhatsAppMessage(to, message) {
  if (!to || !PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    console.error('[Meta] Parâmetros ausentes:', { to, PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN });
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
    console.log('[Webhook] Verificação OK.');
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const messages = change?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const senderNumber = message.from;
    const messageId = message.id;

    await markAsRead(messageId);

    // Áudio
    if (message.type === 'audio' || message.type === 'voice') {
      const audioReplies = [
        'Ouvi seu áudio! Me conta um pouco mais por escrito? Assim consigo te direcionar para o especialista certo aqui no escritório.',
        'Recebi seu áudio! Para garantir que nada se perca, pode me resumir aqui o que está acontecendo?',
        'Escutei! Me escreve rapidinho o que precisa, assim já te passo para o advogado certo.'
      ];
      const reply = audioReplies[Math.floor(Math.random() * audioReplies.length)];
      await typingDelay(reply);
      await sendWhatsAppMessage(senderNumber, reply);
      return;
    }

    // Documento ou imagem — flush mensagens de texto pendentes primeiro
    if (message.type === 'document' || message.type === 'image') {
      if (pendingMessages[senderNumber]) {
        clearTimeout(pendingMessages[senderNumber].timer);
        const pending = pendingMessages[senderNumber];
        delete pendingMessages[senderNumber];
        // Adiciona textos pendentes ao histórico sem gerar resposta
        if (!conversationHistory[senderNumber]) conversationHistory[senderNumber] = [];
        conversationHistory[senderNumber].push({ role: 'user', content: pending.messages.join('\n') });
        saveHistory(conversationHistory);
      }

      console.log(`[Webhook] ${message.type} recebido de ${senderNumber}`);
      const reply = await handleDocument(message, senderNumber);
      await typingDelay(reply);
      await sendWhatsAppMessage(senderNumber, reply);
      return;
    }

    // Ignora outros tipos
    if (message.type !== 'text') return;

    const incomingText = message.text.body;
    console.log(`[Webhook] Texto de ${senderNumber}: ${incomingText}`);

    // Debounce: acumula mensagens e aguarda 8s após a última
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

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Chatbot está funcionando!',
    api: 'Meta WhatsApp Cloud API',
    features: ['texto com debounce 8s', 'áudio', 'PDF', 'imagens', 'análise jurídica', 'notificação de especialistas', 'lembrete automático'],
    specialists: Object.entries(SPECIALISTS).map(([area, s]) => ({ area, name: s.name })),
    config: {
      WHATSAPP_TOKEN: WHATSAPP_TOKEN ? '*** (definido)' : 'NAO DEFINIDO',
      PHONE_NUMBER_ID: PHONE_NUMBER_ID ? `${PHONE_NUMBER_ID.slice(0, 6)}...` : 'NAO DEFINIDO',
      CLAUDE_API_KEY: CLAUDE_API_KEY ? '*** (definido)' : 'NAO DEFINIDO',
      VERIFY_TOKEN: VERIFY_TOKEN
    }
  });
});

app.listen(PORT, () => {
  console.log(`Chatbot Assis e Xavier Advogados rodando na porta ${PORT}`);
  console.log(`WhatsApp escritorio: ${ESCRITORIO_PHONE}`);
  console.log(`Webhook: GET|POST /webhook`);
});
