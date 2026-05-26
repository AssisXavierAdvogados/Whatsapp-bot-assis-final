const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE || 'whatsapp:+14155238886';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
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

    conversationHistory[userId].push({
      role: 'user',
      content: userMessage
    });

    const messages = conversationHistory[userId].map(msg => ({
      role: msg.role,
      content: msg.content
    }));

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-1',
        max_tokens: 1024,
        system: OFFICE_CONTEXT,
        messages: messages
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

    conversationHistory[userId].push({
      role: 'assistant',
      content: assistantMessage
    });

    if (conversationHistory[userId].length > 20) {
      conversationHistory[userId] = conversationHistory[userId].slice(-20);
    }

    return assistantMessage;
  } catch (error) {
    console.error('Erro ao chamar Claude API:', error.response?.data || error.message);
    return `Desculpe, tive um problema técnico. Por favor, entre em contato conosco via WhatsApp: ${ESCRITORIO_PHONE}`;
  }
}

async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        From: TWILIO_PHONE,
        To: to,
        Body: message
      },
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        }
      }
    );
    console.log('Mensagem enviada:', response.data.sid);
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.response?.data || error.message);
  }
}

app.post('/webhook/messages', async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const senderNumber = req.body.From;
    const userId = senderNumber.replace('whatsapp:', '');

    console.log(`Mensagem recebida de ${senderNumber}: ${incomingMessage}`);

    const response = await callClaudeAPI(incomingMessage, userId);

    await sendWhatsAppMessage(senderNumber, response);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).send('Erro ao processar mensagem');
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Chatbot está funcionando!' });
});

app.listen(PORT, () => {
  console.log(`🤖 Chatbot Assis e Xavier Advogados rodando na porta ${PORT}`);
  console.log(`📱 WhatsApp: ${ESCRITORIO_PHONE}`);
});
