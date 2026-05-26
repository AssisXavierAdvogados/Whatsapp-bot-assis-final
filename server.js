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
Você é um assistente do Assis e Xavier Advogados, um escritório full service com experiência em múltiplas áreas do direito.

INFORMAÇÕES DO ESCRITÓRIO:
- Nome: Assis e Xavier Advogados
- Telefone/WhatsApp: ${ESCRITORIO_PHONE}
- Tipo: Escritório Full Service
- Localização: Maringá, Paraná

ÁREAS DE ATUAÇÃO:
- Direito Comercial e Societário
- Direito Trabalhista
- Direito de Família
- Direito Imobiliário
- Direito Tributário
- Direito Administrativo
- Direito Contratual
- Consultoria Jurídica Geral

INSTRUÇÕES:
1. Sempre responda em português (Brasil)
2. Seja profissional mas acessível
3. Se não sabe informação específica, sugira contato direto
4. Nunca invente informações jurídicas
5. Estimule contato via WhatsApp: ${ESCRITORIO_PHONE}
6. Respostas devem parecer naturais, como se um advogado estivesse respondendo
7. Seja empático com problemas do cliente
8. Ofereça orientações gerais, mas sempre recomende consulta profissional para casos específicos
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
  // Responder 200 imediatamente — a Meta exige resposta rápida
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const messages = change?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];

    // Ignorar mensagens que não sejam texto
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

// Diagnóstico: verifica se as variáveis de ambiente estão definidas
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Chatbot está funcionando!',
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
  console.log(`Webhook URL: /webhook`);
});
