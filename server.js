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

// CORREÇÃO 1: Número fixo com prefixo whatsapp: garantido.
// Antes: process.env.TWILIO_PHONE || '...' — se a variável existisse sem o prefixo,
// a API do Twilio rejeitava o From e causava o erro 21604 no To.
const TWILIO_PHONE = 'whatsapp:+14155238886';

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
  // CORREÇÃO 2: Validação explícita do destinatário antes de chamar a API.
  if (!to) {
    console.error('sendWhatsAppMessage: parâmetro "to" está vazio ou indefinido.');
    return;
  }

  // CORREÇÃO 3: A API do Twilio exige application/x-www-form-urlencoded, não JSON.
  // Antes: axios enviava JSON por padrão → Twilio ignorava os campos → erro 21604 ("To is required").
  // Agora: URLSearchParams serializa os dados no formato correto.
  const params = new URLSearchParams({
    From: TWILIO_PHONE,
    To: to,
    Body: message
  });

  console.log(`[Twilio] Enviando mensagem | De: ${TWILIO_PHONE} | Para: ${to}`);

  try {
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
      params.toString(),
      {
        auth: {
          username: TWILIO_ACCOUNT_SID,
          password: TWILIO_AUTH_TOKEN
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    console.log(`[Twilio] Mensagem enviada com sucesso. SID: ${response.data.sid}`);
    return response.data;
  } catch (error) {
    console.error('[Twilio] Erro ao enviar mensagem:', error.response?.data || error.message);
  }
}

app.post('/webhook/messages', async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const senderNumber = req.body.From;
    const userId = senderNumber ? senderNumber.replace('whatsapp:', '') : null;

    if (!senderNumber || !incomingMessage) {
      console.error('Webhook recebeu payload incompleto:', req.body);
      return res.status(400).send('Payload inválido');
    }

    console.log(`[Webhook] Mensagem recebida de ${senderNumber}: ${incomingMessage}`);

    const response = await callClaudeAPI(incomingMessage, userId);

    await sendWhatsAppMessage(senderNumber, response);

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.status(500).send('Erro ao processar mensagem');
  }
});

// Rota de diagnóstico: simula o envio sem chamar APIs reais
app.get('/test-send', (req, res) => {
  const simulatedTo = req.query.to || 'whatsapp:+5544999778551';
  const simulatedMessage = req.query.msg || 'Olá! Tudo bem? Como posso ajudar?';

  const params = new URLSearchParams({
    From: TWILIO_PHONE,
    To: simulatedTo,
    Body: simulatedMessage
  });

  res.json({
    status: 'simulacao',
    descricao: 'Esta rota mostra como a requisição seria enviada ao Twilio.',
    url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    corpo_codificado: params.toString(),
    campos: {
      From: TWILIO_PHONE,
      To: simulatedTo,
      Body: simulatedMessage
    },
    credenciais: {
      TWILIO_ACCOUNT_SID: TWILIO_ACCOUNT_SID ? `${TWILIO_ACCOUNT_SID.slice(0, 6)}...` : 'NAO DEFINIDO',
      TWILIO_AUTH_TOKEN: TWILIO_AUTH_TOKEN ? '*** (definido)' : 'NAO DEFINIDO',
      CLAUDE_API_KEY: CLAUDE_API_KEY ? '*** (definido)' : 'NAO DEFINIDO'
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Chatbot está funcionando!' });
});

app.listen(PORT, () => {
  console.log(`Chatbot Assis e Xavier Advogados rodando na porta ${PORT}`);
  console.log(`WhatsApp escritorio: ${ESCRITORIO_PHONE}`);
  console.log(`Twilio From: ${TWILIO_PHONE}`);
});
