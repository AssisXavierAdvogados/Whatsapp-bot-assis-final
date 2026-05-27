const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Histórico persistido em arquivo — sobrevive ao sleep do Render
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

FLUXO DE ATENDIMENTO (siga essa ordem, sem pular etapas):
1. Primeira mensagem: se apresente brevemente e pergunte o que está acontecendo
2. Com a resposta, faça NO MÁXIMO 2 perguntas de aprofundamento (uma por vez)
3. Com 3 informações em mãos (situação + 2 detalhes), já é suficiente para direcionar
4. Peça o nome do cliente
5. Informe a área e pergunte o melhor horário para o especialista ligar

IMPORTANTE — APRESENTAÇÃO:
- Se já existe histórico de conversa, NUNCA se apresente novamente. Retome naturalmente de onde parou.
- Só se apresente uma única vez, na primeira mensagem da conversa.
- Se o cliente mudar de assunto, responda normalmente sem se reapresentar.

IMPORTANTE — PERGUNTAS:
- Não ultrapasse 3 perguntas no total antes de direcionar.
- Se a situação já estiver clara na primeira mensagem, pule direto para pedir o nome.

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

const conversationHistory = loadHistory();

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

    saveHistory(conversationHistory);

    return assistantMessage;
  } catch (error) {
    console.error('[Claude] Erro:', error.response?.data || error.message);
    return `Desculpe, tive um problema técnico. Entre em contato via WhatsApp: ${ESCRITORIO_PHONE}`;
  }
}

// Marca a mensagem como lida (aparece ✓✓ azul para o cliente)
async function markAsRead(messageId) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('[Meta] Erro ao marcar como lido:', error.response?.data);
  }
}

// Simula tempo de digitação: mínimo 2s + proporcional ao tamanho da resposta
function typingDelay(text) {
  const baseDelay = 2000;
  const charsPerSecond = 18;
  const calculated = baseDelay + (text.length / charsPerSecond) * 1000;
  const delay = Math.min(Math.max(calculated, 2000), 7000);
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
    const senderNumber = message.from;
    const messageId = message.id;

    await markAsRead(messageId);

    // Áudio: responde de forma natural pedindo que escreva
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

    // Ignora outros tipos (imagem, vídeo, documento, sticker, etc.)
    if (message.type !== 'text') return;

    const incomingText = message.text.body;

    console.log(`[Webhook] Mensagem de ${senderNumber}: ${incomingText}`);

    // Marca como lido imediatamente (✓✓ azul)
    await markAsRead(messageId);

    const reply = await callClaudeAPI(incomingText, senderNumber);

    // Aguarda tempo proporcional ao tamanho da resposta (simula digitação)
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
