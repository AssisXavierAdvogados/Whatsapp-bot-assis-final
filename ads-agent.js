const express  = require('express');
const axios    = require('axios');
const cheerio  = require('cheerio');
const dotenv   = require('dotenv');
const fs       = require('fs');
const path     = require('path');

dotenv.config();

const app  = express();
const PORT = process.env.ADS_PORT || 3001;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Configuração ──────────────────────────────────────────────────────────────
const META_ADS_TOKEN       = process.env.META_ADS_TOKEN;
const META_AD_ACCOUNT_ID   = process.env.META_AD_ACCOUNT_ID;
const META_PAGE_ID         = process.env.META_PAGE_ID;
const INSTAGRAM_USER_ID    = process.env.INSTAGRAM_USER_ID;
const META_WHATSAPP_NUMBER = process.env.META_WHATSAPP_NUMBER || '5544999784442';
const CLAUDE_API_KEY       = process.env.CLAUDE_API_KEY;
const ADS_WHATSAPP_TOKEN   = process.env.ADS_WHATSAPP_TOKEN;
const ADS_PHONE_NUMBER_ID  = process.env.ADS_PHONE_NUMBER_ID;
const ADS_VERIFY_TOKEN     = process.env.ADS_VERIFY_TOKEN || 'ads-agent-verify-token';
const OWNER_PHONE          = process.env.OWNER_PHONE || '5544999784442';

const META_API     = 'https://graph.facebook.com/v21.0';
const HISTORY_FILE = path.join('/tmp', 'ads_history.json');

const MARINGA_LAT       = -23.4205;
const MARINGA_LNG       = -51.9333;
const DEFAULT_RADIUS_KM = 30;

const SCRAPER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9'
};

// ── Histórico ─────────────────────────────────────────────────────────────────
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

// ── Meta API — Anúncios ───────────────────────────────────────────────────────
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

// Meta API — Publicações (usa params em vez de body JSON)
async function metaPagePost(endpoint, params) {
  const res = await axios.post(`${META_API}/${endpoint}`, null, {
    params: { ...params, access_token: META_ADS_TOKEN }
  });
  return res.data;
}

// ── Campanhas ─────────────────────────────────────────────────────────────────
async function criarCampanha(nome, objective) {
  return metaPost(`${META_AD_ACCOUNT_ID}/campaigns`, {
    name: nome, objective, status: 'PAUSED', special_ad_categories: []
  });
}

// Resolve localização para o formato geo_locations da Meta API
async function resolverLocalizacao(localizacao) {
  const loc = (localizacao || '').toLowerCase().trim();

  // Padrão: Maringá e região
  if (!loc || loc.includes('maringá') || loc.includes('maringa') || loc.includes('maringá/pr')) {
    return {
      custom_locations: [{
        latitude: MARINGA_LAT, longitude: MARINGA_LNG,
        radius: DEFAULT_RADIUS_KM, distance_unit: 'kilometer'
      }]
    };
  }

  // Busca na Meta API (estados, cidades)
  try {
    const res = await metaGet('search', {
      type: 'adgeolocation',
      q: localizacao,
      location_types: JSON.stringify(['region', 'city']),
      country_code: 'BR'
    });
    const match = (res.data || [])[0];
    if (!match) throw new Error('Localização não encontrada');

    if (match.type === 'region') {
      return { regions: [{ key: match.key, country: 'BR' }] };
    }
    return {
      cities: [{ key: match.key, country: 'BR', radius: 30, distance_unit: 'kilometer' }]
    };
  } catch (e) {
    console.error('[Geo] Fallback para Maringá:', e.message);
    return {
      custom_locations: [{
        latitude: MARINGA_LAT, longitude: MARINGA_LNG,
        radius: DEFAULT_RADIUS_KM, distance_unit: 'kilometer'
      }]
    };
  }
}

async function criarConjunto({ campaignId, nome, orcamentoDiario, diasDuracao, idadeMin, idadeMax, objective, localizacao, urlDestino }) {
  const start = new Date();
  const end   = new Date(start.getTime() + diasDuracao * 86400000);

  const geoLocations = await resolverLocalizacao(localizacao);

  const body = {
    name:             nome,
    campaign_id:      campaignId,
    daily_budget:     Math.round(orcamentoDiario * 100),
    start_time:       start.toISOString(),
    end_time:         end.toISOString(),
    billing_event:    'IMPRESSIONS',
    bid_strategy:     'LOWEST_COST_WITHOUT_CAP',
    status:           'PAUSED',
    targeting: {
      age_min: idadeMin || 25,
      age_max: idadeMax || 60,
      geo_locations: geoLocations
    }
  };

  if (objective === 'OUTCOME_TRAFFIC' && urlDestino) {
    body.optimization_goal = 'LINK_CLICKS';               // campanha para site
  } else if (objective === 'OUTCOME_TRAFFIC') {
    body.destination_type  = 'WHATSAPP';
    body.optimization_goal = 'LINK_CLICKS';               // campanha para WhatsApp
  } else if (objective === 'OUTCOME_AWARENESS') {
    body.optimization_goal = 'AD_RECALL_LIFT';
  } else {
    body.optimization_goal = 'REACH';
  }

  return metaPost(`${META_AD_ACCOUNT_ID}/adsets`, body);
}

async function criarCriativo({ nome, texto, titulo, urlImagem, objective, urlDestino }) {
  const waLink = `https://api.whatsapp.com/send?phone=${META_WHATSAPP_NUMBER.replace(/\D/g, '')}&text=Ol%C3%A1%2C%20vim%20pelo%20an%C3%BAncio`;

  const destino = urlDestino || (objective === 'OUTCOME_TRAFFIC' ? waLink : `https://www.facebook.com/${META_PAGE_ID}`);

  const linkData = {
    message:     texto,
    name:        titulo,
    description: 'Assis e Xavier Advogados — Maringá, PR',
    link:        destino
  };

  if (urlImagem) linkData.picture = urlImagem;

  if (objective === 'OUTCOME_TRAFFIC' && !urlDestino) {
    linkData.call_to_action = { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link: waLink } };
  } else if (urlDestino) {
    linkData.call_to_action = { type: 'LEARN_MORE' };
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
    name: nome, adset_id: adSetId, creative: { creative_id: creativeId }, status: 'PAUSED'
  });
}

async function listarCampanhas() {
  const data = await metaGet(`${META_AD_ACCOUNT_ID}/campaigns`, { fields: 'id,name,objective,status' });
  return data.data || [];
}

async function pausarCampanha(id)  { return metaPost(id, { status: 'PAUSED' }); }
async function ativarCampanha(id)  { return metaPost(id, { status: 'ACTIVE' }); }

async function relatorioCampanhas() {
  const data = await metaGet(`${META_AD_ACCOUNT_ID}/insights`, {
    fields: 'campaign_name,spend,impressions,clicks,reach',
    date_preset: 'last_7d',
    level: 'campaign'
  });
  return data.data || [];
}

// ── Publicação de conteúdo ────────────────────────────────────────────────────

async function publicarFacebookFeed(texto, imageUrl, linkUrl) {
  if (imageUrl) {
    return metaPagePost(`${META_PAGE_ID}/photos`, { message: texto, url: imageUrl });
  }
  return metaPagePost(`${META_PAGE_ID}/feed`, { message: texto, link: linkUrl });
}

async function publicarInstagramFeed(texto, imageUrl) {
  if (!INSTAGRAM_USER_ID) throw new Error('INSTAGRAM_USER_ID não configurado');

  const container = await metaPagePost(`${INSTAGRAM_USER_ID}/media`, {
    image_url: imageUrl,
    caption:   texto
  });

  await new Promise(r => setTimeout(r, 3000));

  return metaPagePost(`${INSTAGRAM_USER_ID}/media_publish`, { creation_id: container.id });
}

async function publicarStoriesFacebook(imageUrl) {
  return metaPagePost(`${META_PAGE_ID}/photo_stories`, { url: imageUrl });
}

async function publicarStoriesInstagram(imageUrl) {
  if (!INSTAGRAM_USER_ID) throw new Error('INSTAGRAM_USER_ID não configurado');

  const container = await metaPagePost(`${INSTAGRAM_USER_ID}/media`, {
    image_url:  imageUrl,
    media_type: 'STORIES'
  });

  await new Promise(r => setTimeout(r, 3000));

  return metaPagePost(`${INSTAGRAM_USER_ID}/media_publish`, { creation_id: container.id });
}

// ── Scraping de notícias ──────────────────────────────────────────────────────

async function scrapeArticle(url) {
  const res = await axios.get(url, { headers: SCRAPER_HEADERS, timeout: 12000 });
  const $   = cheerio.load(res.data);

  const title       = $('meta[property="og:title"]').attr('content')
                   || $('meta[name="twitter:title"]').attr('content')
                   || $('h1').first().text().trim()
                   || $('title').text().trim();

  const description = $('meta[property="og:description"]').attr('content')
                   || $('meta[name="description"]').attr('content')
                   || '';

  const image       = $('meta[property="og:image"]').attr('content')
                   || $('meta[name="twitter:image"]').attr('content')
                   || '';

  // Extrai texto do corpo do artigo para o Claude gerar um post mais rico
  const articleText = ($('article').text() || $('main').text() || $('body').text())
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 4000);

  return { title, description, image, url, articleText };
}

async function buscarNoticiasMigalhas(tema) {
  const res = await axios.get('https://www.migalhas.com.br/quentes', {
    headers: SCRAPER_HEADERS, timeout: 12000
  });
  const $ = cheerio.load(res.data);

  const artigos = [];
  $('a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const texto = $(el).text().trim();
    if (href.includes('/quentes/') && texto.length > 30) {
      const url = href.startsWith('http') ? href : `https://www.migalhas.com.br${href}`;
      if (!artigos.find(a => a.url === url)) {
        artigos.push({ titulo: texto, url });
      }
    }
  });

  let lista = artigos.slice(0, 15);

  // Filtra por tema se fornecido
  if (tema) {
    const temaLower = tema.toLowerCase();
    const filtrado  = lista.filter(a => a.titulo.toLowerCase().includes(temaLower));
    if (filtrado.length > 0) lista = filtrado;
  }

  return lista.slice(0, 8);
}

async function buscarNoticiasConjur(tema) {
  const url = tema
    ? `https://www.conjur.com.br/busca/?q=${encodeURIComponent(tema)}`
    : 'https://www.conjur.com.br/';

  const res = await axios.get(url, { headers: SCRAPER_HEADERS, timeout: 12000 });
  const $   = cheerio.load(res.data);

  const artigos = [];
  $('a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const texto = $(el).text().trim();
    if ((href.includes('/noticia') || href.match(/\/\d{4}-[a-z]+-\d{2}-/)) && texto.length > 30) {
      const url = href.startsWith('http') ? href : `https://www.conjur.com.br${href}`;
      if (!artigos.find(a => a.url === url)) {
        artigos.push({ titulo: texto, url });
      }
    }
  });

  return artigos.slice(0, 8);
}

async function buscarNoticiasSTJ(tema) {
  const base = 'https://www.stj.jus.br';
  const url  = tema
    ? `${base}/sites/portalp/Paginas/Comunicacao/Noticias/Noticias.aspx?q=${encodeURIComponent(tema)}`
    : `${base}/sites/portalp/Paginas/Comunicacao/Noticias/Noticias.aspx`;

  const res = await axios.get(url, { headers: SCRAPER_HEADERS, timeout: 12000 });
  const $   = cheerio.load(res.data);

  const artigos = [];
  $('a[href*="/Noticias/"], a[href*="/noticias/"]').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const texto = $(el).text().trim();
    if (texto.length > 20) {
      const full = href.startsWith('http') ? href : `${base}${href}`;
      if (!artigos.find(a => a.url === full)) {
        artigos.push({ titulo: texto, url: full });
      }
    }
  });

  return artigos.slice(0, 8);
}

async function buscarNoticiasTJPR(tema) {
  const base = 'https://www.tjpr.jus.br';
  const url  = tema
    ? `${base}/noticias?p_p_id=101&p_p_lifecycle=0&_101_keywords=${encodeURIComponent(tema)}`
    : `${base}/noticias`;

  const res = await axios.get(url, { headers: SCRAPER_HEADERS, timeout: 12000 });
  const $   = cheerio.load(res.data);

  const artigos = [];
  $('a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const texto = $(el).text().trim();
    if ((href.includes('/noticias/') || href.includes('-/-/')) && texto.length > 20) {
      const full = href.startsWith('http') ? href : `${base}${href}`;
      if (!artigos.find(a => a.url === full)) {
        artigos.push({ titulo: texto, url: full });
      }
    }
  });

  return artigos.slice(0, 8);
}

async function buscarNoticiasJusBrasil(tema) {
  const url = tema
    ? `https://www.jusbrasil.com.br/noticias/busca?q=${encodeURIComponent(tema)}`
    : 'https://www.jusbrasil.com.br/noticias/';

  const res = await axios.get(url, { headers: SCRAPER_HEADERS, timeout: 12000 });
  const $   = cheerio.load(res.data);

  const artigos = [];
  $('a').each((_, el) => {
    const href  = $(el).attr('href') || '';
    const texto = $(el).text().trim();
    if (href.includes('/noticias/') && texto.length > 30) {
      const full = href.startsWith('http') ? href : `https://www.jusbrasil.com.br${href}`;
      if (!artigos.find(a => a.url === full)) {
        artigos.push({ titulo: texto, url: full });
      }
    }
  });

  return artigos.slice(0, 8);
}

// ── Ferramentas para o Claude ─────────────────────────────────────────────────
const ADS_TOOLS = [
  // ── Anúncios ─────────────────────────────────────────────────────────────
  {
    name: 'criar_campanha_whatsapp',
    description: 'Cria campanha de tráfego para WhatsApp no Meta Ads.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:    { type: 'string' },
        orcamento_diario: { type: 'number', description: 'Em R$' },
        duracao_dias:     { type: 'number' },
        texto_anuncio:    { type: 'string', description: 'Até 125 caracteres' },
        titulo_anuncio:   { type: 'string' },
        url_imagem:       { type: 'string' },
        idade_min:        { type: 'number' },
        idade_max:        { type: 'number' },
        localizacao:      { type: 'string', description: 'Estado, cidade ou região. Ex: "Santa Catarina", "São Paulo", "Curitiba". Padrão: Maringá e região.' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio']
    }
  },
  {
    name: 'criar_campanha_awareness',
    description: 'Cria campanha de reconhecimento de marca no Meta Ads.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:    { type: 'string' },
        orcamento_diario: { type: 'number' },
        duracao_dias:     { type: 'number' },
        texto_anuncio:    { type: 'string' },
        titulo_anuncio:   { type: 'string' },
        url_imagem:       { type: 'string' },
        localizacao:      { type: 'string', description: 'Estado, cidade ou região. Ex: "Santa Catarina", "São Paulo". Padrão: Maringá e região.' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio']
    }
  },
  {
    name: 'criar_campanha_alcance',
    description: 'Cria campanha de alcance máximo no Meta Ads.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:    { type: 'string' },
        orcamento_diario: { type: 'number' },
        duracao_dias:     { type: 'number' },
        texto_anuncio:    { type: 'string' },
        titulo_anuncio:   { type: 'string' },
        url_imagem:       { type: 'string' },
        localizacao:      { type: 'string', description: 'Estado, cidade ou região. Ex: "Santa Catarina", "São Paulo". Padrão: Maringá e região.' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio']
    }
  },
  {
    name: 'criar_campanha_site',
    description: 'Cria campanha de tráfego para um site/URL específico no Meta Ads. Use quando o usuário quiser direcionar cliques para uma página web.',
    input_schema: {
      type: 'object',
      properties: {
        nome_campanha:    { type: 'string' },
        orcamento_diario: { type: 'number', description: 'Em R$' },
        duracao_dias:     { type: 'number' },
        texto_anuncio:    { type: 'string', description: 'Até 125 caracteres' },
        titulo_anuncio:   { type: 'string' },
        url_destino:      { type: 'string', description: 'URL do site para onde os cliques serão direcionados' },
        url_imagem:       { type: 'string' },
        idade_min:        { type: 'number' },
        idade_max:        { type: 'number' },
        localizacao:      { type: 'string', description: 'Estado, cidade ou região. Ex: "Santa Catarina", "São Paulo". Padrão: Maringá e região.' }
      },
      required: ['nome_campanha', 'orcamento_diario', 'duracao_dias', 'texto_anuncio', 'titulo_anuncio', 'url_destino']
    }
  },
  {
    name: 'listar_campanhas',
    description: 'Lista todas as campanhas da conta.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'pausar_campanha',
    description: 'Pausa uma campanha pelo ID numérico.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string', description: 'ID numérico (somente números)' } },
      required: ['campaign_id']
    }
  },
  {
    name: 'ativar_campanha',
    description: 'Ativa uma campanha pausada.',
    input_schema: {
      type: 'object',
      properties: { campaign_id: { type: 'string' } },
      required: ['campaign_id']
    }
  },
  {
    name: 'relatorio_campanha',
    description: 'Relatório de gastos e performance dos últimos 7 dias.',
    input_schema: { type: 'object', properties: {} }
  },

  // ── Notícias ──────────────────────────────────────────────────────────────
  {
    name: 'buscar_noticias',
    description: 'Busca notícias jurídicas recentes nos principais portais. Retorna lista com título e URL para o usuário escolher qual publicar.',
    input_schema: {
      type: 'object',
      properties: {
        tema:  { type: 'string', description: 'Tema ou área jurídica para filtrar (ex: trabalhista, consumidor, família, previdenciário). Opcional.' },
        fonte: {
          type: 'string',
          enum: ['migalhas', 'conjur', 'stj', 'tjpr', 'jusbrasil', 'todos'],
          description: 'Portal de origem. Use "todos" para buscar em todas as fontes. Padrão: todos.'
        }
      }
    }
  },
  {
    name: 'buscar_conteudo_noticia',
    description: 'Lê o conteúdo completo de uma notícia a partir da URL. Retorna título, descrição, imagem e texto do artigo para você gerar o post.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL completa do artigo' }
      },
      required: ['url']
    }
  },

  // ── Publicação ────────────────────────────────────────────────────────────
  {
    name: 'publicar_post',
    description: 'Publica um post com imagem no Facebook, Instagram e/ou Stories. Sempre confirme com o usuário antes de chamar esta ferramenta.',
    input_schema: {
      type: 'object',
      properties: {
        texto_feed: {
          type: 'string',
          description: 'Texto do post para feed (pode ter até 2000 caracteres). Sempre inclua "Fonte: [portal]" no final.'
        },
        image_url: {
          type: 'string',
          description: 'URL pública da imagem (obrigatória para Instagram e Stories)'
        },
        link_url: {
          type: 'string',
          description: 'URL do artigo original (opcional, adicionada no Facebook)'
        },
        plataformas: {
          type: 'array',
          items: { type: 'string', enum: ['facebook_feed', 'instagram_feed', 'facebook_stories', 'instagram_stories'] },
          description: 'Onde publicar. Se o usuário disser "tudo" ou "todas", use as 4.'
        }
      },
      required: ['texto_feed', 'image_url', 'plataformas']
    }
  }
];

// ── System Prompt ─────────────────────────────────────────────────────────────
const ADS_SYSTEM_PROMPT = `Você é o agente de marketing digital do escritório Assis e Xavier Advogados, em Maringá, PR.

Você ajuda o Dr. Willian a:
1. Criar e gerenciar campanhas de anúncios no Meta Ads (Facebook/Instagram)
2. Buscar notícias jurídicas relevantes (Migalhas, Conjur, STJ, TJPR, JusBrasil)
3. Publicar posts e stories no Facebook e Instagram do escritório

DADOS DO ESCRITÓRIO:
- Nome: Assis e Xavier Advogados
- WhatsApp: ${META_WHATSAPP_NUMBER}
- Cidade: Maringá, PR | Raio: 30 km
- Áreas: Trabalhista, Família, Imobiliário, Empresarial, Tributário, Criminal, Previdenciário, Cível/Consumidor

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONFORMIDADE OBRIGATÓRIA — LEI 8.906/1994 (ESTATUTO DA OAB) E PROVIMENTO 205/2021
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Todo conteúdo criado (anúncios, posts, stories, textos de campanha) DEVE seguir rigorosamente as regras de publicidade da OAB. Qualquer violação pode resultar em sanção disciplinar ao escritório.

❌ ABSOLUTAMENTE PROIBIDO — nunca inclua:
1. Promessas ou garantias de resultado: "você vai ganhar", "resultado garantido", "100% de êxito"
2. Valores de honorários, descontos ou "primeira consulta grátis"
3. Superlativações: "melhor escritório", "número 1 da região", "especialistas em ganhar causas"
4. Nomes, fotos ou descrições de clientes reais ou casos concretos
5. Comparações com outros advogados ou escritórios
6. Linguagem mercantilista ou apelos comerciais agressivos: "não perca essa chance", "oferta limitada"
7. Referências a bens pessoais, luxo, veículos ou patrimônio dos advogados
8. Postagens de sentenças ou decisões judiciais favoráveis como material promocional
9. CTAs que prometam solução rápida: "resolva seu problema em minutos", "venha e resolva hoje"

✅ SEMPRE FAÇA — todo conteúdo deve ter:
1. Caráter informativo e educativo — explique direitos, não venda serviços
2. Linguagem profissional, sóbria e discreta
3. Foco no problema jurídico do cidadão, não no escritório
4. CTA institucional suave e ético: "Fale com nosso escritório para entender seu caso"
5. Tom respeitoso com a dignidade da profissão advocatícia

EXEMPLOS DE LINGUAGEM PERMITIDA vs PROIBIDA:
✅ "Entenda seus direitos em caso de demissão sem justa causa"
❌ "Fui demitido? Venha conosco e GARANTA sua indenização!"
✅ "O STJ decidiu que bancos devem ressarcir cobranças indevidas. Saiba mais."
❌ "Banco te cobrou indevido? Nós GARANTIMOS que você vai receber de volta!"
✅ "Nosso escritório atua em direito de família há anos em Maringá."
❌ "Somos os melhores advogados de família do Paraná. Resultados comprovados!"

ANTES DE CRIAR QUALQUER TEXTO: verifique mentalmente se ele passaria na revisão ética da OAB-PR. Se tiver dúvida, prefira a versão mais conservadora e informativa.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REGRAS OPERACIONAIS:
- Respostas curtas (máximo 5 linhas)
- UMA pergunta por vez quando faltar informação
- Sempre confirme com o usuário ANTES de criar campanha ou publicar post
- Campanhas criadas sempre PAUSADAS — o Dr. Willian ativa quando quiser

FLUXO — CAMPANHAS:
1. Entenda o objetivo e colete: orçamento diário, duração, área jurídica
2. Sugira um texto para o anúncio (respeitando as regras da OAB acima)
3. Mostre resumo e pergunte "Confirma?"
4. Só crie após confirmação

FLUXO — PUBLICAÇÃO DE NOTÍCIAS:
1. Use buscar_noticias para listar opções (ou buscar_conteudo_noticia se o usuário já tem a URL)
2. Apresente as opções e pergunte qual publicar
3. Use buscar_conteudo_noticia para ler o artigo escolhido
4. Gere o texto do post: caráter informativo, foco no direito do cidadão
5. Mostre o texto, pergunte "Publico em todas as plataformas?"
6. Após confirmação, chame publicar_post
7. Sempre inclua "Fonte: [portal]" no final do post

FLUXO — CONTEÚDO COM IA (sem notícia):
- Use quando o usuário pedir "cria um post sobre...", "post educativo sobre..."
- Gere texto informativo com base no seu conhecimento jurídico
- Mostre para o Dr. Willian revisar antes de publicar
- Se não tiver imagem, publique só no Facebook (Instagram exige imagem)

TIPOS DE CAMPANHA:
- Tráfego para WhatsApp → criar_campanha_whatsapp
- Reconhecimento de marca → criar_campanha_awareness
- Alcance máximo → criar_campanha_alcance
- Tráfego para site/URL → criar_campanha_site (use quando o usuário fornecer uma URL de destino)

LOCALIZAÇÃO DE CAMPANHAS:
- Padrão: Maringá e 30 km ao redor
- Aceita qualquer estado, cidade ou região do Brasil
- Exemplos: "Santa Catarina", "São Paulo", "Curitiba", "interior do Paraná"
- Se o usuário mencionar um local diferente de Maringá, passe no campo localizacao

FONTES DE NOTÍCIAS:
- Migalhas, Conjur, STJ, TJPR, JusBrasil`;

// ── Execução das ferramentas ──────────────────────────────────────────────────
async function executarFerramenta(toolName, input) {
  try {

    // ── Campanhas ───────────────────────────────────────────────────────────
    if (toolName === 'listar_campanhas') {
      const lista = await listarCampanhas();
      if (!lista.length) return 'Nenhuma campanha encontrada.';
      return lista.map(c => `📢 *${c.name}*\n   ID: \`${c.id}\` | ${c.status}`).join('\n\n');
    }

    if (toolName === 'pausar_campanha') {
      await pausarCampanha(input.campaign_id);
      return `Campanha \`${input.campaign_id}\` pausada.`;
    }

    if (toolName === 'ativar_campanha') {
      await ativarCampanha(input.campaign_id);
      return `Campanha \`${input.campaign_id}\` ativada.`;
    }

    if (toolName === 'relatorio_campanha') {
      const dados = await relatorioCampanhas();
      if (!dados.length) return 'Nenhum gasto nos últimos 7 dias.';
      let total = 0;
      const linhas = dados.map(d => {
        const g = parseFloat(d.spend || 0);
        total += g;
        return `📊 *${d.campaign_name}*: R$ ${g.toFixed(2)} | ${d.impressions} imp. | ${d.clicks} cliques | ${d.reach} pessoas`;
      });
      return `*Últimos 7 dias:*\n\n${linhas.join('\n')}\n\n💰 *Total: R$ ${total.toFixed(2)}*`;
    }

    if (['criar_campanha_whatsapp', 'criar_campanha_awareness', 'criar_campanha_alcance', 'criar_campanha_site'].includes(toolName)) {
      const objective =
        toolName === 'criar_campanha_whatsapp'  ? 'OUTCOME_TRAFFIC'   :
        toolName === 'criar_campanha_awareness' ? 'OUTCOME_AWARENESS' :
        toolName === 'criar_campanha_site'      ? 'OUTCOME_TRAFFIC'   : 'OUTCOME_REACH';

      const urlDestino = toolName === 'criar_campanha_site' ? input.url_destino : undefined;

      const campaign  = await criarCampanha(input.nome_campanha, objective);
      const adSet     = await criarConjunto({
        campaignId:      campaign.id,
        nome:            `${input.nome_campanha} — Conjunto`,
        orcamentoDiario: input.orcamento_diario,
        diasDuracao:     input.duracao_dias,
        idadeMin:        input.idade_min,
        idadeMax:        input.idade_max,
        objective,
        localizacao:     input.localizacao,
        urlDestino
      });
      const creative  = await criarCriativo({
        nome:      `${input.nome_campanha} — Criativo`,
        texto:     input.texto_anuncio,
        titulo:    input.titulo_anuncio,
        urlImagem: input.url_imagem || null,
        objective,
        urlDestino
      });
      const ad = await criarAnuncio({
        nome:       `${input.nome_campanha} — Anúncio`,
        adSetId:    adSet.id,
        creativeId: creative.id
      });

      const accountNum = META_AD_ACCOUNT_ID.replace('act_', '');
      return (
        `✅ Campanha criada (PAUSADA)!\n\n` +
        `🆔 Campanha: \`${campaign.id}\`\n` +
        `🆔 Conjunto: \`${adSet.id}\`\n` +
        `🆔 Anúncio:  \`${ad.id}\`\n\n` +
        `🔗 https://www.facebook.com/adsmanager/manage/campaigns?act=${accountNum}`
      );
    }

    // ── Notícias ────────────────────────────────────────────────────────────
    if (toolName === 'buscar_noticias') {
      const { tema, fonte = 'todos' } = input;
      const resultados = [];

      const fontes = [
        { key: 'migalhas',  fn: buscarNoticiasMigalhas,  nome: 'Migalhas'  },
        { key: 'conjur',    fn: buscarNoticiasConjur,    nome: 'Conjur'    },
        { key: 'stj',       fn: buscarNoticiasSTJ,       nome: 'STJ'       },
        { key: 'tjpr',      fn: buscarNoticiasTJPR,      nome: 'TJPR'      },
        { key: 'jusbrasil', fn: buscarNoticiasJusBrasil, nome: 'JusBrasil' },
      ];

      for (const f of fontes) {
        if (fonte === 'todos' || fonte === f.key) {
          try {
            const lista = await f.fn(tema);
            lista.forEach(a => resultados.push({ ...a, fonte: f.nome }));
          } catch (e) {
            console.error(`[Scraper] ${f.nome}:`, e.message);
          }
        }
      }

      if (!resultados.length) return 'Não encontrei notícias no momento. Tente fornecer uma URL diretamente ou peça um post com base no meu conhecimento.';

      return resultados
        .slice(0, 12)
        .map((a, i) => `${i + 1}. [${a.fonte}] ${a.titulo}\n   ${a.url}`)
        .join('\n\n');
    }

    if (toolName === 'buscar_conteudo_noticia') {
      const art = await scrapeArticle(input.url);
      return JSON.stringify({
        titulo:      art.title,
        descricao:   art.description,
        imagem:      art.image,
        url:         art.url,
        texto_bruto: art.articleText.substring(0, 2000)
      }, null, 2);
    }

    // ── Publicação ──────────────────────────────────────────────────────────
    if (toolName === 'publicar_post') {
      const { texto_feed, image_url, link_url, plataformas } = input;
      const resultados = [];

      for (const plataforma of plataformas) {
        try {
          if (plataforma === 'facebook_feed') {
            await publicarFacebookFeed(texto_feed, image_url, link_url);
            resultados.push('✅ Facebook Feed');
          } else if (plataforma === 'instagram_feed') {
            await publicarInstagramFeed(texto_feed, image_url);
            resultados.push('✅ Instagram Feed');
          } else if (plataforma === 'facebook_stories') {
            await publicarStoriesFacebook(image_url);
            resultados.push('✅ Facebook Stories');
          } else if (plataforma === 'instagram_stories') {
            await publicarStoriesInstagram(image_url);
            resultados.push('✅ Instagram Stories');
          }
        } catch (e) {
          const msg = e.response?.data?.error?.message || e.message;
          resultados.push(`❌ ${plataforma}: ${msg}`);
          console.error(`[Publicação] ${plataforma}:`, msg);
        }
      }

      return `*Resultado da publicação:*\n\n${resultados.join('\n')}`;
    }

    return 'Ferramenta desconhecida.';

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error(`[Ferramenta] Erro em ${toolName}:`, msg);
    return `Erro: ${msg}`;
  }
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function callClaude(userMessage, userId) {
  try {
    if (!conversationHistory[userId]) conversationHistory[userId] = [];
    conversationHistory[userId].push({ role: 'user', content: userMessage });

    const messages = [...conversationHistory[userId]];
    let response;

    while (true) {
      response = await axios.post('https://api.anthropic.com/v1/messages', {
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     ADS_SYSTEM_PROMPT,
        tools:      ADS_TOOLS,
        messages
      }, {
        headers: {
          'x-api-key':         CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json'
        }
      });

      const content   = response.data.content;
      const toolBlock = content.find(b => b.type === 'tool_use');

      if (!toolBlock) {
        const text = content.find(b => b.type === 'text')?.text || '';
        conversationHistory[userId].push({ role: 'assistant', content: text });
        if (conversationHistory[userId].length > 40) {
          conversationHistory[userId] = conversationHistory[userId].slice(-40);
        }
        saveHistory();
        return text;
      }

      messages.push({ role: 'assistant', content });
      conversationHistory[userId].push({ role: 'assistant', content });

      const result    = await executarFerramenta(toolBlock.name, toolBlock.input);
      const resultMsg = {
        role:    'user',
        content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: result }]
      };
      messages.push(resultMsg);
      conversationHistory[userId].push(resultMsg);
    }
  } catch (error) {
    console.error('[Claude] Erro:', error.response?.data || error.message);
    return 'Desculpe, ocorreu um erro técnico. Tente novamente em instantes.';
  }
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────
async function markAsRead(messageId) {
  if (!ADS_PHONE_NUMBER_ID || !ADS_WHATSAPP_TOKEN) return;
  try {
    await axios.post(`${META_API}/${ADS_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: messageId
    }, { headers: { Authorization: `Bearer ${ADS_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
  } catch (e) { /* silencioso */ }
}

function typingDelay(text) {
  return new Promise(r => setTimeout(r, Math.min(Math.max(2000 + (text.length / 18) * 1000, 2000), 6000)));
}

async function sendWhatsApp(to, message) {
  if (!ADS_PHONE_NUMBER_ID || !ADS_WHATSAPP_TOKEN) {
    console.log(`[AdsBot] (sem WhatsApp) → ${message.substring(0, 80)}...`);
    return;
  }
  await axios.post(`${META_API}/${ADS_PHONE_NUMBER_ID}/messages`, {
    messaging_product: 'whatsapp', to, type: 'text', text: { body: message }
  }, { headers: { Authorization: `Bearer ${ADS_WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
}

// ── Rotas ─────────────────────────────────────────────────────────────────────
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
    if (msg.from !== OWNER_PHONE) return;

    await markAsRead(msg.id);
    const reply = await callClaude(msg.text.body, msg.from);
    await typingDelay(reply);
    await sendWhatsApp(msg.from, reply);
  } catch (e) {
    console.error('[AdsBot] Webhook erro:', e.message);
  }
});

// Endpoint REST para testes sem WhatsApp
app.post('/ads-command', async (req, res) => {
  const { message, userId = 'test-user', history } = req.body;
  if (!message) return res.status(400).json({ error: 'Informe "message"' });
  try {
    // Restaura histórico enviado pelo cliente (sobrevive reinicializações do servidor)
    if (Array.isArray(history) && history.length > 0) {
      conversationHistory[userId] = history;
    }
    const reply = await callClaude(message, userId);
    // Devolve histórico atualizado para o cliente salvar
    res.json({ reply, history: conversationHistory[userId] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ads-health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Agente Meta Ads + Publicação — Assis e Xavier Advogados',
    funcionalidades: ['campanhas_meta_ads', 'buscar_noticias', 'publicar_facebook', 'publicar_instagram', 'stories'],
    config: {
      META_ADS_TOKEN:     META_ADS_TOKEN     ? '✅ definido' : '❌ ausente',
      META_AD_ACCOUNT_ID: META_AD_ACCOUNT_ID || '❌ ausente',
      META_PAGE_ID:       META_PAGE_ID       || '❌ ausente',
      INSTAGRAM_USER_ID:  INSTAGRAM_USER_ID  || '⚠️ ausente (Instagram desativado)',
      CLAUDE_API_KEY:     CLAUDE_API_KEY     ? '✅ definido' : '❌ ausente',
      OWNER_PHONE
    }
  });
});

// ── Inicialização ─────────────────────────────────────────────────────────────
async function init() {
  if (META_ADS_TOKEN && !META_AD_ACCOUNT_ID) {
    try {
      const res = await axios.get(`${META_API}/me/adaccounts`, {
        params: { fields: 'id,name,account_status', access_token: META_ADS_TOKEN }
      });
      console.log('[Meta Ads] Contas disponíveis:');
      (res.data.data || []).forEach(a => console.log(`  • ${a.name} → ${a.id}`));
    } catch (e) {
      console.error('[Meta Ads] Erro ao listar contas:', e.response?.data?.error?.message || e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`Agente de Marketing rodando na porta ${PORT}`);
    console.log(`Teste: POST /ads-command { "message": "busca notícias trabalhistas" }`);
  });
}

init();
