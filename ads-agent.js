const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.ADS_PORT || 3001;
app.use(express.json());

const META_ADS_TOKEN    = process.env.META_ADS_TOKEN;
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // formato: act_XXXXXXXXXX
const META_PAGE_ID      = process.env.META_PAGE_ID;
const META_WHATSAPP_NUMBER = process.env.META_WHATSAPP_NUMBER || '5544999784442';
const CLAUDE_API_KEY    = process.env.CLAUDE_API_KEY;
const ADS_WHATSAPP_TOKEN   = process.env.ADS_WHATSAPP_TOKEN;
const ADS_PHONE_NUMBER_ID  = process.env.ADS_PHONE_NUMBER_ID;
const ADS_VERIFY_TOKEN     = process.env.ADS_VERIFY_TOKEN || 'ads-agent-verify-token';

const META_API = 'https://graph.facebook.com/v19.0';
const HISTORY_FILE = path.join('/tmp', 'ads_history.json');

// Maringá, PR — coordenadas centrais
const MARINGA_LAT  = -23.4205;
const MARINGA_LNG  = -51.9333;
const DEFAULT_RADIUS_KM = 30;

// ── Histórico de conversa ────────────────────────────────────────────────────
let conversationHistory = {};

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveHistory() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(conversationHistory), 'utf8'); } catch (e) {}
}

conversationHistory = loadHistory();

// ── Meta Marketing API ───────────────────────────────────────────────────────
async function metaPost(endpoint, data) {
  const res = await axios.post(`${META_API}/${endpoint}`, data, {
    params: { access_token: META_ADS_TOKEN }
  });
  return res.data;
}

async function metaGet(endpoint, params = {}) {
  const res = await axios.get(`${META_API}/${endpoint}`, {
    params: { ...params, access_token: META_ADS_TOKEN }
  });
  return res.data;
}

async function criarCampanha(nome, objective) {
  return metaPost(`${META_AD_ACCOUNT_ID}/campaigns`, {
    name: nome,
    objective,
    status: 'PAUSED',
    special_ad_categories: []
  });
}

async function criarConjunto({ campaignId, nome, orcamentoDiario, diasDuracao, idadeMin, idadeMax, objective }) {
  const start = new Date();
  const end   = new Date(start.getTime() + diasDuracao * 86400000);

  const targeting = {
    age_min: idadeMin || 25,
    age_max: idadeMax || 60,
    geo_locations: {
      custom_locations: [{
        latitude: MARINGA_LAT,
        longitude: MARINGA_LNG,
        radius: DEFAULT_RADIUS_KM,
        distance_unit: 'kilometer'
      }]
    }
  };

  const body = {
    name: nome,
    campaign_id: campaignId,
    daily_budget: Math.round(orcamentoDiario * 100),
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    targeting,
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    status: 'PAUSED'
  };

  if (objective === 'OUTCOME_TRAFFIC') {
    body.destination_type   = 'WHATSAPP';
    body.optimization_goal  = 'LINK_CLICKS';
  } else {
    body.optimization_goal  = 'REACH';
  }

  return metaPost(`${META_AD_ACCOUNT_ID}/adsets`, body);
}

async function criarCriativo({ nome, texto, titulo, urlImagem, objective }) {
  const waLink = `https://api.whatsapp.com/send?phone=${META_WHATSAPP_NUMBER.replace(/\D/g, '')}&text=Ol%C3%A1%2C%20vim%20pelo%20an%C3%BAncio`;

  const linkData = {
    message: texto,
    name: titulo,
    description: 'Assis e Xavier Advogados — Maringá, PR',
    link: objective === 'OUTCOME_TRAFFIC' ? waLink : `https://www.facebook.com/${META_PAGE_ID}`
  };

  if (urlImagem) linkData.picture = urlImagem;

  if (objective === 'OUTCOME_TRAFFIC') {
    linkData.call_to_action = {
      type: 'WHATSAPP_MESSAGE',
      value: { app_destination: 'WHATSAPP', link: waLink }
    };
  } else {
    linkData.call_to_action = { type: 'LEARN_MORE' };
  }

  return metaPost(`${META_AD_ACCOUNT_ID}/adcreatives`, {
    name: nome,
    object_story_spec: { page_id: META_PAGE_ID, link_data: linkData }
  });
}

async function criarAnuncio({ nome, adSetId, creativeId }) {
  return metaPost(`${META_AD_ACCOUNT_ID}/ads`, {
    name: nome,
    adset_id: adSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED'
  });
}

async function listarCampanhas() {
  const data = await metaGet(`${META_AD_ACCOUNT_ID}/campaigns`, {
    fields: 'id,name,objective,status,daily_budget'
  });
  return data.data || [];
}

async function pausarCampanha(campaignId) {
  return metaPost(campaignId, { status: 'PAUSED' });
}

async function ativarCampanha(campaignId) {
  return metaPost(campaignId, { status: 'ACTIVE' });
}

async function relatorioCampanhas() {
  const data = await metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'campaign_name,spend,impressions,clicks,reach',
    date_preset: 'last_7d',
    level: 'campaign'
  });
  return data.data || [];
}

// ── Ferramentas para o Claude ────────────────────────────────────────────────
const ADS_TOOLS = [
  {
    name: 'criar_campanha_whatsapp',
    description: 'Cria campanha de tráfego para WhatsApp no Meta Ads. Use quando o usuário quiser levar pessoas para conversar no WhatsApp do escritório.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:   { type: 'string',  description: 'Nome da campanha' },
        orcamento_diario:{ type: 'number',  description: 'Orçamento diário em R$' },
        duracao_dias:    { type: 'number',  description: 'Quantos dias a campanha vai rodar' },
        texto_anuncio:   { type: 'string',  description: 'Texto principal do anúncio (~125 caracteres)' },
        titulo_anuncio:  { type: 'string',  description: 'Título/headline do anúncio' },
        url_imagem:      { type: 'string',  description: 'URL da imagem (opcional)' },
        idade_min:       { type: 'number',  description: 'Idade mínima do público (padrão 25)' },
        idade_max:       { type: 'number',  description: 'Idade máxima do público (padrão 60)' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio']
    }
  },
  {
    name: 'criar_campanha_awareness',
    description: 'Cria campanha de reconhecimento de marca no Meta Ads. Use para aumentar visibilidade do escritório na região.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:   { type: 'string', description: 'Nome da campanha' },
        orcamento_diario:{ type: 'number', description: 'Orçamento diário em R$' },
        duracao_dias:    { type: 'number', description: 'Quantos dias a campanha vai rodar' },
        texto_anuncio:   { type: 'string', description: 'Texto principal do anúncio' },
        titulo_anuncio:  { type: 'string', description: 'Título/headline do anúncio' },
        url_imagem:      { type: 'string', description: 'URL da imagem (opcional)' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio']
    }
  },
  {
    name: 'listar_campanhas',
    description: 'Lista todas as campanhas da conta (ativas, pausadas).',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'pausar_campanha',
    description: 'Pausa uma campanha pelo ID.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string', description: 'ID da campanha' } },
      required: ['campaign_id']
    }
  },
  {
    name: 'ativar_campanha',
    description: 'Ativa (publica) uma campanha que estava pausada.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string', description: 'ID da campanha' } },
      required: ['campaign_id']
    }
  },
  {
    name: 'relatorio_gastos',
    description: 'Mostra relatório de performance e gastos dos últimos 7 dias.',
    input_schema: { type: 'object', properties: {} }
  }
];

const ADS_SYSTEM_PROMPT = `Você é um especialista em Meta Ads (Facebook e Instagram Ads) do escritório Assis e Xavier Advogados, em Maringá, PR.

Você ajuda o Dr. Willian a criar e gerenciar campanhas de anúncios usando linguagem natural, de forma simples e objetiva.

DADOS DO ESCRITÓRIO:
- Nome: Assis e Xavier Advogados
- WhatsApp: ${META_WHATSAPP_NUMBER}
- Cidade: Maringá, PR
- Raio padrão: 30 km
- Especialidades: Trabalhista, Família, Imobiliário, Empresarial, Tributário, Criminal, Previdenciário, Cível/Consumidor

REGRAS DE COMPORTAMENTO:
- Respostas curtas (máximo 5 linhas)
- Faça UMA pergunta por vez quando faltar informação
- SEMPRE mostre um resumo e peça confirmação antes de criar campanha
- Campanhas são sempre criadas como PAUSADAS — o Dr. Willian ativa quando quiser
- Ao criar com sucesso, informe os IDs e o link do Gerenciador

FLUXO DE CRIAÇÃO:
1. Usuário descreve o que quer
2. Você coleta: orçamento diário, duração, texto do anúncio (se não fornecido, sugira um)
3. Mostre resumo completo e pergunte "Confirma?"
4. Só crie após confirmação

BOAS PRÁTICAS PARA TEXTO DE ANÚNCIO:
- Foque no problema do cliente, não no escritório
- Linguagem acessível, sem juridiquês
- Texto principal: até 125 caracteres
- Exemplo: "Seu chefe te demitiu sem pagar o que é seu? Fale agora com um advogado trabalhista."

QUANDO NÃO TIVER IMAGEM:
- Crie assim mesmo e avise que ficará melhor com imagem
- Sugira que o usuário adicione uma depois no Gerenciador de Anúncios`;

// ── Execução das ferramentas ─────────────────────────────────────────────────
async function executarFerramenta(toolName, input) {
  try {
    if (toolName === 'listar_campanhas') {
      const lista = await listarCampanhas();
      if (!lista.length) return 'Nenhuma campanha encontrada na conta.';
      return lista.map(c =>
        `📢 *${c.name}*\n   ID: \`${c.id}\` | Status: ${c.status}`
      ).join('\n\n');
    }

    if (toolName === 'pausar_campanha') {
      await pausarCampanha(input.campaign_id);
      return `Campanha \`${input.campaign_id}\` pausada com sucesso.`;
    }

    if (toolName === 'ativar_campanha') {
      await ativarCampanha(input.campaign_id);
      return `Campanha \`${input.campaign_id}\` ativada com sucesso.`;
    }

    if (toolName === 'relatorio_gastos') {
      const dados = await relatorioCampanhas();
      if (!dados.length) return 'Nenhum gasto registrado nos últimos 7 dias.';
      let total = 0;
      const linhas = dados.map(d => {
        const gasto = parseFloat(d.spend || 0);
        total += gasto;
        return `📊 *${d.campaign_name}*: R$ ${gasto.toFixed(2)} | ${d.impressions} impressões | ${d.clicks} cliques | ${d.reach} pessoas`;
      });
      return `*Últimos 7 dias:*\n\n${linhas.join('\n')}\n\n💰 *Total: R$ ${total.toFixed(2)}*`;
    }

    if (toolName === 'criar_campanha_whatsapp' || toolName === 'criar_campanha_awareness') {
      const objective = toolName === 'criar_campanha_whatsapp' ? 'OUTCOME_TRAFFIC' : 'OUTCOME_AWARENESS';

      const campaign  = await criarCampanha(input.nome_campanha, objective);
      const adSet     = await criarConjunto({
        campaignId:    campaign.id,
        nome:          `${input.nome_campanha} — Conjunto`,
        orcamentoDiario: input.orcamento_diario,
        diasDuracao:   input.duracao_dias,
        idadeMin:      input.idade_min,
        idadeMax:      input.idade_max,
        objective
      });
      const creative  = await criarCriativo({
        nome:      `${input.nome_campanha} — Criativo`,
        texto:     input.texto_anuncio,
        titulo:    input.titulo_anuncio,
        urlImagem: input.url_imagem || null,
        objective
      });
      const ad = await criarAnuncio({
        nome:      `${input.nome_campanha} — Anúncio`,
        adSetId:   adSet.id,
        creativeId: creative.id
      });

      const accountNum = META_AD_ACCOUNT_ID.replace('act_', '');
      return (
        `✅ Campanha criada!\n\n` +
        `🆔 Campanha: \`${campaign.id}\`\n` +
        `🆔 Conjunto: \`${adSet.id}\`\n` +
        `🆔 Anúncio: \`${ad.id}\`\n\n` +
        `⚠️ Status: PAUSADA — ative quando quiser publicar.\n` +
        `🔗 Gerenciador: https://www.facebook.com/adsmanager/manage/campaigns?act=${accountNum}`
      );
    }

    return 'Ferramenta desconhecida.';
  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error(`[Meta Ads] Erro em ${toolName}:`, msg);
    return `Erro: ${msg}`;
  }
}

// ── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(userMessage, userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  conversationHistory[userId].push({ role: 'user', content: userMessage });

  const messages = [...conversationHistory[userId]];
  let response;

  while (true) {
    response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-opus-4-1',
      max_tokens: 1024,
      system: ADS_SYSTEM_PROMPT,
      tools: ADS_TOOLS,
      messages
    }, {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    });

    const content = response.data.content;
    const toolBlock = content.find(b => b.type === 'tool_use');

    if (!toolBlock) {
      const text = content.find(b => b.type === 'text')?.text || '';
      conversationHistory[userId].push({ role: 'assistant', content: text });
      saveHistory();
      return text;
    }

    messages.push({ role: 'assistant', content });
    conversationHistory[userId].push({ role: 'assistant', content });

    const result = await executarFerramenta(toolBlock.name, toolBlock.input);
    const resultMsg = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: result }]
    };
    messages.push(resultMsg);
    conversationHistory[userId].push(resultMsg);
  }
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(to, message) {
  if (!ADS_PHONE_NUMBER_ID || !ADS_WHATSAPP_TOKEN) {
    console.log(`[AdsBot] (sem WhatsApp configurado) Resposta: ${message}`);
    return;
  }
  await axios.post(`${META_API}/${ADS_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message }
  }, {
    headers: {
      Authorization: `Bearer ${ADS_WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// ── Rotas ────────────────────────────────────────────────────────────────────

// Webhook WhatsApp (segundo número)
app.get('/ads-webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === ADS_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/ads-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msgs = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!msgs?.length) return;
    const msg = msgs[0];
    if (msg.type !== 'text') return;
    const reply = await callClaude(msg.text.body, msg.from);
    await sendWhatsApp(msg.from, reply);
  } catch (e) {
    console.error('[AdsBot] Webhook erro:', e.message);
  }
});

// Endpoint REST para testes (sem precisar de WhatsApp)
app.post('/ads-command', async (req, res) => {
  const { message, userId = 'test-user' } = req.body;
  if (!message) return res.status(400).json({ error: 'Informe o campo "message"' });
  try {
    const reply = await callClaude(message, userId);
    res.json({ reply });
  } catch (e) {
    console.error('[AdsBot] Erro:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/ads-health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Meta Ads Agent — Assis e Xavier Advogados',
    config: {
      META_ADS_TOKEN:    META_ADS_TOKEN    ? '*** (definido)' : 'NÃO DEFINIDO',
      META_AD_ACCOUNT_ID: META_AD_ACCOUNT_ID || 'NÃO DEFINIDO',
      META_PAGE_ID:      META_PAGE_ID      || 'NÃO DEFINIDO',
      META_WHATSAPP_NUMBER
    }
  });
});

// ── Inicialização ─────────────────────────────────────────────────────────────
async function init() {
  // Detecta e exibe conta(s) de anúncios disponíveis no token
  if (META_ADS_TOKEN && !META_AD_ACCOUNT_ID) {
    try {
      const res = await axios.get(`${META_API}/me/adaccounts`, {
        params: { fields: 'id,name,account_status', access_token: META_ADS_TOKEN }
      });
      const accounts = res.data.data || [];
      console.log('[Meta Ads] Contas disponíveis no token:');
      accounts.forEach(a => console.log(`  • ${a.name} → ID: ${a.id} (status: ${a.account_status})`));
      console.log('[Meta Ads] Defina META_AD_ACCOUNT_ID no .env com um dos IDs acima.');
    } catch (e) {
      console.error('[Meta Ads] Falha ao listar contas:', e.response?.data?.error?.message || e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`Meta Ads Agent rodando na porta ${PORT}`);
    console.log(`Teste via REST: POST /ads-command { "message": "..." }`);
  });
}

init();
