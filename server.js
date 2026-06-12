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

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'assis-xavier-verify-token';
const ESCRITORIO_PHONE = process.env.ESCRITORIO_PHONE || '+55 (44)99977-8551';
const EMAIL_FROM = process.env.GMAIL_USER; // remetente (email verificado no Brevo)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const LEAD_TEMPLATE_NAME = process.env.LEAD_TEMPLATE_NAME; // ex: novo_lead (aprovado no Meta)
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || 'pt_BR';

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
- Use notificar_especialista quando tiver: nome do cliente, situacao clara e horario preferido
- Use reenviar_lembrete quando cliente disser que nao foi contatado
- Apos usar qualquer ferramenta, confirme ao cliente de forma natural

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

async function sendEmailToSpecialist(toEmail, subject, htmlBody) {
  if (!BREVO_API_KEY || !EMAIL_FROM) {
    console.log('[Email] Credenciais nao configuradas, pulando envio.');
    return;
  }
  try {
    await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      {
        sender: { name: 'Ana - Assis e Xavier Advogados', email: EMAIL_FROM },
        to: [{ email: toEmail }],
        subject,
        htmlContent: htmlBody
      },
      {
        headers: {
          'api-key': BREVO_API_KEY,
          'content-type': 'application/json'
        }
      }
    );
    console.log(`[Email] Enviado para ${toEmail} via Brevo`);
  } catch (e) {
    console.error('[Email] Erro ao enviar:', e.response?.data || e.message);
  }
}

async function executeTool(toolName, toolInput, clientPhone) {
  if (toolName === 'notificar_especialista') {
    const { area, nome_cliente, horario_preferido, resumo_caso } = toolInput;
    const specialist = SPECIALISTS[area] || SPECIALISTS.civel_bancario;
    const areaLabel = area.toUpperCase().replace('_', '/');

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

    // 3) Email — garantia que sempre chega
    await sendEmailToSpecialist(
      specialist.email,
      `Novo Atendimento - ${areaLabel} | ${nome_cliente}`,
      emailHtml
    );

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
    await sendEmailToSpecialist(
      specialist.email,
      `Lembrete Urgente - ${nome_cliente} aguarda seu contato`,
      emailHtml
    );

    return `Lembrete reenviado para ${specialist.name}.`;
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
        const assistantText = extractText(content);
        conversationHistory[userId].push({ role: 'assistant', content: assistantText });
        break;
      }

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
      return callClaudeAPI('O cliente enviou um documento mas nao consegui processa-lo. Peca para enviar em PDF ou como foto nitida.', userId);
    }

    return callClaudeAPI(`[ANALISE DO DOCUMENTO - ${filename}]\n${analysisResult}`, userId);
  } catch (error) {
    console.error('[Doc] Erro ao processar documento:', error.message);
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
    const messages = change?.messages;

    if (!messages || messages.length === 0) return;

    const message = messages[0];
    const senderNumber = message.from;
    const messageId = message.id;

    await markAsRead(messageId);

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
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#111b21;color:#e9edef;min-height:100vh}
.screen{display:none}.screen.active{display:flex;flex-direction:column;min-height:100vh}
#login{justify-content:center;align-items:center;padding:24px}
.box{background:#202c33;border-radius:16px;padding:32px 24px;width:100%;max-width:360px}
.box h1{font-size:24px;font-weight:700;margin-bottom:4px}.box p{color:#8696a0;font-size:14px;margin-bottom:24px}
input[type=password]{width:100%;background:#2a3942;border:none;border-radius:8px;color:#e9edef;font-size:16px;padding:14px 16px;outline:none;margin-bottom:12px}
button{width:100%;background:#00a884;border:none;border-radius:8px;color:#fff;font-size:16px;font-weight:600;padding:14px;cursor:pointer}
button:active{opacity:.85}.err{color:#ef4444;font-size:13px;margin-top:8px;text-align:center}
.hdr{background:#202c33;padding:16px 20px;display:flex;align-items:center;gap:12px;position:sticky;top:0;z-index:10}
.hdr h2{font-size:17px;font-weight:600;flex:1}
.back{font-size:26px;cursor:pointer;line-height:1}.ref{font-size:20px;cursor:pointer}
.list{flex:1;overflow-y:auto}
.item{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #2a3942;cursor:pointer}
.item:active{background:#2a3942}
.av{width:46px;height:46px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0}
.ci{flex:1;min-width:0}.cp{font-size:15px;font-weight:600}
.cv{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.cc{font-size:12px;color:#8696a0;flex-shrink:0}
.empty{padding:48px 20px;text-align:center;color:#8696a0}
.msgs{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:5px}
.msg{max-width:82%;padding:8px 12px;border-radius:8px;font-size:14.5px;line-height:1.5;word-break:break-word}
.msg.u{align-self:flex-end;background:#005c4b;border-radius:8px 0 8px 8px}
.msg.a{align-self:flex-start;background:#202c33;border-radius:0 8px 8px 8px}
.who{font-size:11px;font-weight:600;margin-bottom:3px;color:#8696a0}
</style>
</head>
<body>
<div id="login" class="screen active">
  <div class="box">
    <h1>Ana</h1>
    <p>Painel de conversas — Assis e Xavier Advogados</p>
    <input type="password" id="pwd" placeholder="Senha" onkeydown="if(event.key==='Enter')auth()">
    <button onclick="auth()">Entrar</button>
    <div class="err" id="err"></div>
  </div>
</div>
<div id="list" class="screen">
  <div class="hdr">
    <h2>Conversas</h2>
    <span class="ref" onclick="load()" title="Atualizar">↻</span>
  </div>
  <div class="list" id="lst"></div>
</div>
<div id="chat" class="screen">
  <div class="hdr">
    <span class="back" onclick="show('list')">‹</span>
    <h2 id="ctitle"></h2>
  </div>
  <div class="msgs" id="cmsgs"></div>
</div>
<script>
let tk=localStorage.getItem('ana_tk')||'',convs={};
async function auth(){
  const p=document.getElementById('pwd').value;
  const r=await fetch('/admin/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});
  if(r.ok){const d=await r.json();tk=d.token;localStorage.setItem('ana_tk',tk);show('list');load();}
  else document.getElementById('err').textContent='Senha incorreta.';
}
function show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}
async function load(){
  const r=await fetch('/admin/conversations',{headers:{'x-token':tk}});
  if(r.status===401){localStorage.removeItem('ana_tk');show('login');return;}
  convs=await r.json();render();
}
function render(){
  const el=document.getElementById('lst'),keys=Object.keys(convs);
  if(!keys.length){el.innerHTML='<div class="empty">Nenhuma conversa ainda.</div>';return;}
  el.innerHTML=keys.map(ph=>{
    const ms=convs[ph],last=ms[ms.length-1];
    const prev=last?esc(last.text.substring(0,55)):'';
    return \`<div class="item" onclick="openChat('\${ph}')">
      <div class="av">\${ph.slice(-2)}</div>
      <div class="ci"><div class="cp">+\${ph}</div><div class="cv">\${prev}</div></div>
      <div class="cc">\${ms.length} msgs</div>
    </div>\`;
  }).join('');
}
function openChat(ph){
  document.getElementById('ctitle').textContent='+'+ph;
  const ms=convs[ph]||[],el=document.getElementById('cmsgs');
  el.innerHTML=ms.map(m=>\`<div class="msg \${m.role==='user'?'u':'a'}">
    <div class="who">\${m.role==='user'?'Cliente':'Ana'}</div>
    \${esc(m.text)}
  </div>\`).join('');
  show('chat');
  setTimeout(()=>el.scrollTop=el.scrollHeight,60);
}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
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

app.get('/admin/conversations', (req, res) => {
  const token = req.headers['x-token'];
  if (!ADMIN_PASSWORD || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const result = {};
  for (const [phone, msgs] of Object.entries(conversationHistory)) {
    const textMsgs = msgs.filter(m => typeof m.content === 'string' && m.content.trim());
    if (textMsgs.length > 0) {
      result[phone] = textMsgs.map(m => ({ role: m.role, text: m.content }));
    }
  }
  res.json(result);
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
      VERIFY_TOKEN: VERIFY_TOKEN
    }
  });
});

app.listen(PORT, () => {
  console.log(`Chatbot Assis e Xavier Advogados rodando na porta ${PORT}`);
  console.log(`WhatsApp escritorio: ${ESCRITORIO_PHONE}`);
  console.log(`Webhook: GET|POST /webhook`);

  const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await axios.get(`${SERVICE_URL}/health`);
      console.log('[Ping] Servidor ativo');
    } catch (e) {
      console.log('[Ping] Falha no ping:', e.message);
    }
  }, 10 * 60 * 1000);
});
