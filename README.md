# 🤖 WhatsApp Chatbot - Assis e Xavier Advogados

Chatbot inteligente com IA (Claude) para responder clientes via WhatsApp automaticamente.

## ✨ Características

- 🤖 **Respostas com IA** - Usa Claude API para gerar respostas naturais
- 💬 **WhatsApp Integration** - Integrado via Twilio
- 📱 **Full Service** - Conhece todas as áreas de atuação do escritório
- 🚀 **Deploy Fácil** - Hospedagem no Render.com (gratuita)
- 💾 **Contexto Persistente** - Lembra de conversas anteriores

## 🚀 Quick Start

### Opção 1: Deploy no Render (Recomendado)

1. Acesse https://render.com
2. Clique em "New +" → "Web Service"
3. Conecte seu repositório GitHub ou faça upload dos arquivos
4. Configure as variáveis de ambiente (veja RENDER_DEPLOY.md)
5. Deploy automático!

### Opção 2: Executar Localmente

```bash
# Instalar dependências
npm install

# Criar arquivo .env com suas credenciais
cp .env.example .env
# Edite .env com seus dados

# Executar
npm start
```

## 📋 Pré-requisitos

- Node.js 18+
- Conta Claude (https://console.anthropic.com) - com créditos
- Conta Twilio (https://www.twilio.com) - WhatsApp Sandbox
- (Opcional) Render.com para deploy

## 🔑 Variáveis de Ambiente

```
CLAUDE_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=AC0d9b1b...
TWILIO_AUTH_TOKEN=SK9f726e0e...
TWILIO_PHONE=whatsapp:+14155238886
ESCRITORIO_PHONE=+55 (44)99977-8551
PORT=3000
NODE_ENV=production
APP_SECRET=chave_secreta_do_app_na_meta
```

### `APP_SECRET` — validação da assinatura do webhook

Cada chamada da Meta ao `POST /webhook` vem assinada no header `X-Hub-Signature-256`
(HMAC-SHA256 do corpo com a chave secreta do aplicativo). Com `APP_SECRET` definida, o
servidor confere essa assinatura e responde **401** a qualquer chamada que não bata — sem
processar a mensagem.

- Onde encontrar: Meta for Developers → seu app → **Configurações do app → Básico → Chave secreta do aplicativo**.
- Se a variável **não** estiver definida, o bot continua atendendo (para a Ana não ficar muda),
  mas registra um aviso bem visível no log e o `/health` mostra `"appSecret": false`.
- Depois de configurar no Render, confira em `/health` se aparece `"appSecret": true`.

### Origem dos atendimentos

Cada conversa guarda de onde o cliente veio (`meta.origem`), e o painel `/admin` mostra a etiqueta
e a contagem por origem. Use estes links nos anúncios, no Google, no Instagram e no site — a
mensagem já vem preenchida com o código:

| Origem | Link |
|---|---|
| Anúncio / Google Ads (`ADS`) | `https://wa.me/5544999778551?text=Ol%C3%A1%21%20%28c%C3%B3d.%20ADS%29` |
| Google Meu Negócio / Maps (`GMN`) | `https://wa.me/5544999778551?text=Ol%C3%A1%21%20%28c%C3%B3d.%20GMN%29` |
| Instagram (`INSTA`) | `https://wa.me/5544999778551?text=Ol%C3%A1%21%20%28c%C3%B3d.%20INSTA%29` |
| Site do escritório (`SITE`) | `https://wa.me/5544999778551?text=Ol%C3%A1%21%20%28c%C3%B3d.%20SITE%29` |

- A mensagem chega como `Olá! (cód. ADS)`. O cliente pode editar ou acrescentar texto; o código
  continua sendo reconhecido (também nas formas `(cod ADS)`, `cód. ADS` e `[ADS]`).
- Sem código, a Ana pergunta uma única vez como a pessoa conheceu o escritório e registra a resposta
  (`INDICACAO` e `OUTRO` só surgem assim). Em urgência ela não pergunta.
- A origem nunca é sobrescrita depois de gravada.

### Aviso imediato de urgência em curso

Se o cliente relata algo **acontecendo agora** (prisão, flagrante, oficial na porta, mandado sendo
cumprido, busca e apreensão em curso), o Dr. Willian e a Dra. Aline recebem na hora um aviso
"ALERTA URGENTE" por WhatsApp e e-mail, sem esperar o encaminhamento da Ana. É no máximo um aviso
por conversa a cada 6 horas (`URGENCIA_ALERTA_HORAS`, opcional). O encaminhamento formal ao
especialista da área continua acontecendo depois, normalmente.

### Recado de voz da Ana (ElevenLabs)

Quando o **último recado do cliente foi um áudio**, a Ana pode responder com um recado de voz
(voz Sofia, ElevenLabs). Telefone, valor, número de processo, endereço, prazo, link e afins não
são ditados: seguem numa mensagem de texto à parte, logo depois do áudio. Advogados, documentos,
imagens e falhas de transcrição continuam sempre em texto.

O recurso vem **desligado**. Variáveis:

| Variável | Padrão | Para que serve |
|---|---|---|
| `VOICE_REPLIES_ENABLED` | `false` | Liga o recado de voz (só com `true`, `1` ou `yes`) |
| `ELEVENLABS_API_KEY` | — | Chave da ElevenLabs (secreta). Sem ela, a Ana responde em texto |
| `ELEVENLABS_VOICE_ID` | `n2a9VtkZLl8j1FSXHsL7` | Voz (Sofia) |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` | Modelo de voz |
| `VOICE_MAX_CHARS` | `600` | Acima disso (texto já normalizado) a resposta vai em texto |
| `VOICE_CLIENT_DAILY_LIMIT` | `6` | Recados de voz por cliente, por dia |
| `VOICE_DAILY_CHAR_LIMIT` | `2500` | Teto diário de caracteres enviados à ElevenLabs (1 crédito por caractere) |

- O dia vira à meia-noite de Brasília. O uso do dia fica gravado no Supabase (linha `VOICE#usage`).
- Qualquer falha (chave, crédito, limite, conversão, envio) cai para a resposta em texto de sempre.
- A conversão para o formato de recado de voz usa o `ffmpeg` da dependência `ffmpeg-static`.
- `/health` e `/diagnostico` mostram só se o recurso está ligado e se a chave está definida — nunca a chave.
- Testes (sem credenciais e sem rede): `npm test`.

**Áudio no painel `/admin`.** Na conversa de cada cliente, o painel mostra a transcrição do áudio
do cliente ("🎤 áudio do cliente (transcrito)") e o texto do recado de voz da Ana ("🔊 Ana respondeu
em áudio"), com os dados que foram por escrito depois. Nenhum arquivo de áudio é armazenado: só o
texto, dentro do histórico da conversa que já existe. A retenção é a mesma das conversas. Um áudio
que não pôde ser transcrito não aparece no painel.

## 📚 Documentação Completa

Veja `RENDER_DEPLOY.md` para instruções passo-a-passo de deploy.

## 🔒 Segurança

- Nunca coloque credenciais no código
- Use variáveis de ambiente
- `.env` está no `.gitignore`
- Defina `APP_SECRET` para que o `/webhook` só aceite chamadas assinadas pela Meta
- A Ana não avalia chances de êxito nem sugere resultado ao cliente (Provimento 205/2021 da OAB):
  a avaliação preliminar dos documentos segue apenas no resumo interno enviado ao advogado
- A Ana também não informa honorários, percentual nem "nada adiantado" (Provimento 205/2021, art. 3º, I):
  em qualquer área, diz apenas que os honorários dependem da análise do caso e que o advogado informa após a consulta

## 📞 Suporte

Para dúvidas:
- WhatsApp: +55 (44)99977-8551
- Escritório: Assis e Xavier Advogados

## 📄 Licença

MIT

---

**Desenvolvido para Assis e Xavier Advogados** ⚖️
