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

// Especialistas do escritório — edite aqui para atualizar nomes/números
const SPECIALISTS = {
  trabalhista:   { name: 'Dr. Willian Assis',  phone: '5544999784442' },
  imobiliario:   { name: 'Dr. Willian Assis',  phone: '5544999784442' },
  tributario:    { name: 'Dr. Willian Assis',  phone: '5544999784442' },
  civel_bancario:{ name: 'Dr. Willian Assis',  phone: '5544999784442' },
  empresarial:   { name: 'Dr. Willian Assis',  phone: '5544999784442' },
  consumidor:    { name: 'Dr. Willian Assis',  phone: '5544999784442' },
  familia:       { name: 'Dra. Aline Xavier',  phone: '5544991651532' },
  criminal:      { name: 'Dra. Aline Xavier',  phone: '5544991651532' },
};

const SPECIALIST_NAMES = {
  trabalhista:    'Dr. Willian Assis',
  imobiliario:    'Dr. Willian Assis',
  tributario:     'Dr. Willian Assis',
  civel_bancario: 'Dr. Willian Assis',
  empresarial:    'Dr. Willian Assis',
  consumidor:     'Dr. Willian Assis',
  familia:        'Dra. Aline Xavier',
  criminal:       'Dra. Aline Xavier',
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
- Trabalhista, Imobiliário, Tributário, Cível/Bancário, Empresarial, Consumidor → Dr. Willian Assis
- Família e Criminal → Dra. Aline Xavier

FLUXO DE ATENDIMENTO (siga essa ordem):
1. Primeira mensagem: se apresente brevemente e pergunte o que está acontecendo
2. Com a resposta, identifique a área jurídica
3. Peça ao cliente que faça um relato breve do que aconteceu — diga algo como: "Me conta o que aconteceu. Se puder incluir quando foi, o que ocorreu e quem estava envolvido, fica mais fácil de avaliar. Pode ir contando em partes, sem pressa."
4. Se necessário, faça no máximo 1 pergunta de aprofundamento
5. Pergunte se a pessoa tem algum documento ou prova (contrato, print, foto, comprovante) que possa ajudar
6. Se tiver: peça para enviar aqui no chat
7. Após receber e analisar o documento: informe o resultado de forma clara e simples, sem juridiquês
8. Peça o nome do cliente
9. Pergunte o melhor horário para o especialista ligar
10. Com nome + horário em mãos: use a ferramenta notificar_especialista, informe o nome do especialista ao cliente e encerre com naturalidade

IMPORTANTE — APRESENTAÇÃO:
- Se já existe histórico de conversa, NUNCA se apresente novamente. Retome naturalmente de onde parou.
- Só se apresente uma única vez, na primeira mensagem da conversa.

IMPORTANTE — ANÁLISE DE DOCUMENTOS:
- Quando receber uma mensagem começando com "[ANÁLISE DO DOCUMENTO]", use esse resultado para informar o cliente
- Traduza para linguagem simples e humana — sem juridiquês
- Seja direta: informe se a pessoa tem ou não chances de êxito
- Após informar, continue o fluxo: peça o nome e o melhor horário para ligar

IMPORTANTE — FERRAMENTA notificar_especialista:
- Use assim que tiver: nome do cliente, situação clara e horário preferido
- No campo resumo_caso: inclua a situação, fatos relevantes, análise de documentos (se houver) e pontos importantes para o especialista
- Após usar a ferramenta, diga ao cliente: "Perfeito, [nome]! O [Dr./Dra. X] vai entrar em contato com você [horário informado]. Pode deixar que ele já vai estar por dentro do seu caso."

ÁREAS E ROTEAMENTO:
- Trabalhista: demissão, horas extras, assédio, acidente, rescisão → Dr. Willian Assis
- Família: divórcio, pensão, guarda, inventário, herança → Dra. Aline Xavier
- Imobiliário: compra/venda, locação, usucapião, despejo → Dr. Willian Assis
- Empresarial: empresa, contratos, sócios, recuperação → Dr. Willian Assis
- Tributário: dívidas fiscais, impostos, Receita → Dr. Willian Assis
- Criminal: crimes, BO, defesa criminal → Dra. Aline Xavier
- Cível/Bancário/Consumidor: dívidas, cobranças, contratos bancários, financiamentos, apreensão de veículo → Dr. Willian Assis
`;

const DOCUMENT_ANALYSIS_PROMPT = `Você é um assistente jurídico especializado do escritório Assis e Xavier Advogados.
Analise o documento recebido com base no seu conhecimento jurídico amplo — legislação brasileira, jurisprudência, doutrina.

O documento pode ser qualquer tipo: contrato de trabalho, contrato bancário, financiamento, escritura, matrícula de imóvel, rescisão trabalhista, contrato de locação, contrato empresarial, procuração, inventário, ou qualquer outro.

SUA ANÁLISE DEVE:
1. Identificar o tipo de documento
2. Com base no contexto da conversa (situação do cliente), verificar se há elementos jurídicos relevantes para o caso
3. Identificar cláusulas, condições ou ausências que possam favorecer ou prejudicar o cliente
4. Avaliar, com base na legislação e jurisprudência brasileira, as chances de êxito numa eventual ação

SUA RESPOSTA DEVE CONTER APENAS:
- Tipo do documento identificado
- Principais pontos relevantes encontrados (máximo 3 pontos, de forma objetiva)
- Avaliação das chances de êxito: ALTA, MODERADA ou BAIXA — com uma frase explicando o motivo

NÃO faça análise jurídica aprofundada. NÃO use excesso de termos técnicos. A resposta será repassada ao cliente por uma atendente humana.
Responda em português, de forma clara e direta.`;

const TOOLS = [
  {
    name: 'notificar_especialista',
    description: 'Notifica o especialista responsável pela área sobre um novo lead qualificado. Use quando tiver coletado: nome do cliente, situação jurídica clara, horário preferido para contato. Inclua no resumo tudo que o especialista precisa saber antes de ligar.',
    input_schema: {
      type: 'object',
      properties: {
        area: {
          type: 'string',
          enum: ['trabalhista', 'familia', 'imobiliario', 'empresarial', 'tributario', 'criminal', 'civel_bancario', 'consumidor'],
          description: 'Área jurídica identificada no caso'
        },
        nome_cliente: {
          type: 'string',
          description: 'Nome do cliente'
        },
        horario_preferido: {
          type: 'string',
          description: 'Melhor horário informado pelo cliente para receber contato'
        },
        resumo_caso: {
          type: 'string',
          description: 'Resumo completo para o especialista: situação, fatos, documentos analisados com resultado, pontos jurídicos relevantes e tudo que ele precisa saber antes de ligar'
        }
      },
      required: ['area', 'nome_cliente', 'horario_preferido', 'resumo_caso']
    }
  }
];

const conversationHistory = loadHistory();

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(b => b.type === 'text');
    return textBlock?.text || '';
  }
  return '';
}

async function executeNotificarEspecialista(input, clientPhone) {
  const { area, nome_cliente, horario_preferido, resumo_caso } = input;
  const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;

  const message =
    `🔔 *NOVO ATENDIMENTO — ${area.toUpperCase().replace('_', '/')}*\n\n` +
    `👤 *Cliente:* ${nome_cliente}\n` +
    `📱 *WhatsApp:* +${clientPhone}\n` +
    `⏰ *Melhor horário para contato:* ${horario_preferido}\n\n` +
    `📋 *RESUMO DO CASO:*\n${resumo_caso}\n\n` +
    `_Atendimento realizado pela Ana — Assis e Xavier Advogados_`;

  try {
    await sendWhatsAppMessage(specialist.phone, message);
    console.log(`[Especialista] Notificação enviada para ${specialist.name} (${specialist.phone})`);
    return `Especialista ${specialist.name} notificado com sucesso.`;
  } catch (error) {
    console.error('[Especialista] Erro ao notificar:', error.message);
    return `Notificação registrada para ${specialist.name}.`;
  }
}

async function callClaudeAPI(userMessage, userId) {
  try {
    if (!conversationHistory[userId]) {
      conversationHistory[userId] = [];
    }

    conversationHistory[userId].push({ role: 'user', content: userMessage });

    const firstResponse = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        system: OFFICE_CONTEXT,
        tools: TOOLS,
        messages: conversationHistory[userId]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const firstContent = firstResponse.data.content;
    const toolUseBlock = firstContent.find(b => b.type === 'tool_use');

    if (toolUseBlock && toolUseBlock.name === 'notificar_especialista') {
      // Salva o bloco de tool_use no histórico
      conversationHistory[userId].push({ role: 'assistant', content: firstContent });

      // Executa a notificação
      const toolResult = await executeNotificarEspecialista(toolUseBlock.input, userId);

      // Adiciona o resultado da ferramenta ao histórico
      conversationHistory[userId].push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: toolResult }]
      });

      // Segunda chamada para Claude gerar a resposta final ao cliente
      const finalResponse = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-opus-4-1',
          max_tokens: 512,
          system: OFFICE_CONTEXT,
          tools: TOOLS,
          messages: conversationHistory[userId]
        },
        {
          headers: {
            'x-api-key': CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
          }
        }
      );

      const finalText = extractText(finalResponse.data.content);
      conversationHistory[userId].push({ role: 'assistant', content: finalText });

      if (conversationHistory[userId].length > 40) {
        conversationHistory[userId] = conversationHistory[userId].slice(-40);
      }
      saveHistory(conversationHistory);
      return finalText;
    }

    // Resposta normal sem tool use
    const assistantText = extractText(firstContent);
    conversationHistory[userId].push({ role: 'assistant', content: assistantText });

    if (conversationHistory[userId].length > 40) {
      conversationHistory[userId] = conversationHistory[userId].slice(-40);
    }
    saveHistory(conversationHistory);
    return assistantText;

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
    return callClaudeAPI('O cliente enviou um documento mas ocorreu um erro técnico ao processá-lo. Peça para tentar novamente.', userId);
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
    console.error('[Meta] Parâmetros ausentes para envio:', { to, PHONE_NUMBER_ID: !!PHONE_NUMBER_ID, WHATSAPP_TOKEN: !!WHATSAPP_TOKEN });
    return;
  }

  console.log(`[Meta] Enviando mensagem para: ${to}`);

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
    console.log(`[Meta] Mensagem enviada. ID: ${response.data.messages?.[0]?.id}`);
    return response.data;
  } catch (error) {
    console.error('[Meta] Erro ao enviar mensagem:', error.response?.data || error.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] Verificação concluída com sucesso.');
    return res.status(200).send(challenge);
  }

  console.error('[Webhook] Falha na verificação. Token recebido:', token);
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

    if (message.type === 'document' || message.type === 'image') {
      console.log(`[Webhook] ${message.type} recebido de ${senderNumber}`);
      const reply = await handleDocument(message, senderNumber);
      await typingDelay(reply);
      await sendWhatsAppMessage(senderNumber, reply);
      return;
    }

    if (message.type !== 'text') return;

    const incomingText = message.text.body;
    console.log(`[Webhook] Mensagem de ${senderNumber}: ${incomingText}`);

    const reply = await callClaudeAPI(incomingText, senderNumber);
    await typingDelay(reply);
    await sendWhatsAppMessage(senderNumber, reply);

  } catch (error) {
    console.error('[Webhook] Erro ao processar mensagem:', error);
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Chatbot está funcionando!',
    api: 'Meta WhatsApp Cloud API',
    features: ['texto', 'áudio', 'documentos PDF', 'imagens', 'análise jurídica', 'notificação de especialistas'],
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
