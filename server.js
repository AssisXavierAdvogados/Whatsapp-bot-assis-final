const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'assis-xavier-verify-token';
const ESCRITORIO_PHONE = process.env.ESCRITORIO_PHONE || '+55 (44)99977-8551';

const OFFICE_CONTEXT = `
Você é Ana, atendente do Assis e Xavier Advogados, escritório jurídico full service em Maringá, Paraná.

SUA IDENTIDADE:
- Seu nome é Ana
- Você é humana, atendente do escritório — nunca revele que é uma IA, assistente virtual ou robô
- Se perguntarem diretamente se é robô ou IA, diga que é atendente e mude o foco para o cliente
- Tom: acolhedor, natural, como uma pessoa real que se importa com o problema

REGRAS DE OURO:
- Respostas CURTAS — máximo 3 linhas por mensagem
- Faça apenas UMA pergunta por vez
- Nunca despeje listas, tópicos ou bullet points
- Nunca mencione "WhatsApp", "contato via WhatsApp" ou o número do escritório como solução
- Nunca invente informações jurídicas nem dê pareceres definitivos
- Nunca use termos como "Claro!", "Com certeza!", "Olá!" repetidamente — varie

FLUXO DE ATENDIMENTO:
1. Receba o cliente com naturalidade e pergunte o que está acontecendo
2. Ouça e faça perguntas para entender melhor (uma por vez)
3. Quando entender o caso, confirme o tipo de situação com empatia
4. Peça o nome do cliente
5. Informe que vai passar o caso para o especialista responsável e pergunte o melhor horário para retorno

ÁREAS E QUANDO DIRECIONAR:
- Trabalhista: demissão, horas extras, assédio, acidente de trabalho, verbas rescisórias
- Família: divórcio, pensão, guarda, inventário, herança
- Imobiliário: compra/venda de imóvel, locação, usucapião, despejo
- Empresarial: abertura/encerramento de empresa, contratos, sócios, recuperação judicial
- Tributário: dívidas fiscais, impostos, parcelamentos com a Receita
- Criminal: crimes, boletim de ocorrência, defesa criminal
- Cível: dívidas, cobranças, danos morais, contratos em geral

QUANDO TIVER O SUFICIENTE PARA DIRECIONAR:
Diga algo como: "Entendi sua situação. Vou passar para o nosso especialista em [área]. Qual o melhor horário para ele entrar em contato com você?"
`;

const conversationHistory = {};

async function callClaudeAPI(userMessage, userId) {
  try {
    if (!conversationHistory[userId]) {
      conversationHistory[userId] = [];
    }

    conversationHistory[userId].push({ role: 'user', content: userMessage });

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        system: OFFICE_CONTEXT,
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

    const assistantMessage = response.data.content[0].text;

    conversationHistory[userId].push({ role: 'assistant', content: assistantMessage });

    if (conversationHistory[userId].length > 20) {
      conversationHistory[userId] = conversationHistory[userId].slice(-20);
    }

    return assistantMessage;
  } catch (error) {
    console.error('[Claude] Erro:', error.response?.data || error.message);
    return `Desculpe, tive um problema técnico. Entre em contato via WhatsApp: ${ESCRITORIO_PHONE}`;
  }
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

// Verificação do webhook exigida pela Meta
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

// Recebimento de mensagens da Meta
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const messages = change?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];

    if (message.type !== 'text') return;

    const senderNumber = message.from;
    const incomingText = message.text.body;

    console.log(`[Webhook] Mensagem de ${senderNumber}: ${incomingText}`);

    const reply = await callClaudeAPI(incomingText, senderNumber);

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
