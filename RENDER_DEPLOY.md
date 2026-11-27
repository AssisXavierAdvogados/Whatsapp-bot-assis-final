# Deploy no Render.com — Guia Rápido

## Passo 1: Acessar o Render

Abra no celular: **https://render.com** e faça login.

## Passo 2: Criar o serviço

1. Toque em **"New +"** → **"Web Service"**
2. Conecte ao GitHub e selecione o repositório **`Whatsapp-bot-assis-final`**
3. O Render detecta o `render.yaml` automaticamente — a maioria das configurações já estará preenchida

## Passo 3: Preencher os 3 valores secretos

Na tela de criação, role até **"Environment Variables"** e preencha:

| Variável | Onde encontrar |
|---|---|
| `CLAUDE_API_KEY` | console.anthropic.com → API Keys |
| `TWILIO_ACCOUNT_SID` | console.twilio.com → Account Info |
| `TWILIO_AUTH_TOKEN` | console.twilio.com → Account Info |

### Assinatura do webhook da Meta (`APP_SECRET`)

Adicione também, em **Environment**:

| Variável | Onde encontrar |
|---|---|
| `APP_SECRET` | developers.facebook.com → seu app → Configurações do app → Básico → Chave secreta do aplicativo |

Com ela, o servidor valida a assinatura `X-Hub-Signature-256` de cada chamada ao `/webhook` e
recusa (401) as que não vierem da Meta. Sem ela o bot continua funcionando, mas sem essa
proteção: o log mostra um aviso e o `/health` mostra `"appSecret": false`. Após salvar a
variável (o Render reinicia o serviço), confira que o `/health` passou a mostrar `"appSecret": true`.

### Recado de voz da Ana (ElevenLabs) — opcional

A Ana pode responder com recado de voz quando o último recado do cliente foi um áudio. O recurso
vem desligado; para usar, preencha em **Environment**:

| Variável | Valor |
|---|---|
| `ELEVENLABS_API_KEY` | elevenlabs.io → API Keys (secreta) |
| `VOICE_REPLIES_ENABLED` | `false` até terminar os testes; `true` para ligar |
| `ELEVENLABS_VOICE_ID` | `n2a9VtkZLl8j1FSXHsL7` (Sofia) — já vem no `render.yaml` |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` — já vem no `render.yaml` |
| `VOICE_MAX_CHARS` | `600` |
| `VOICE_CLIENT_DAILY_LIMIT` | `6` |
| `VOICE_DAILY_CHAR_LIMIT` | `2500` |

Depois de salvar, confira no `/health` os campos `VOICE_REPLIES_ENABLED` e `ELEVENLABS_API_KEY`
(aparece só `*** (definido)`, nunca a chave) e, no `/diagnostico`, o item "Recado de voz", que
também diz se o `ffmpeg` está acessível. O diagnóstico não chama a ElevenLabs, para não gastar crédito.

## Passo 4: Fazer o deploy

Toque em **"Create Web Service"**. Aguarde ~2 minutos.

## Passo 5: Testar

Pegue a URL gerada (ex: `https://assis-xavier-whatsapp-bot.onrender.com`) e acesse:

```
https://SEU-APP.onrender.com/health
```

Deve retornar: `{"status":"OK","message":"Chatbot está funcionando!"}`

## Passo 6: Configurar o Webhook no Twilio

1. Acesse **console.twilio.com**
2. Vá em **Messaging → Try it out → Send a WhatsApp message**
3. Em **"When a message comes in"**, cole:

```
https://SEU-APP.onrender.com/webhook/messages
```

## Pronto!

Envie qualquer mensagem para o número do Twilio Sandbox no WhatsApp para testar.

---

## Verificar se as credenciais estão corretas

Acesse esta URL no navegador (sem chamar nenhuma API real):

```
https://SEU-APP.onrender.com/test-send
```

Se aparecer `"NAO DEFINIDO"` em alguma credencial, volte ao painel do Render e adicione a variável faltante.

---

## Problemas comuns

**Mensagem não chega / erro 21604** → Credenciais do Twilio incorretas ou webhook não configurado.

**Erro 503** → Aguarde 1-2 minutos, o serviço está iniciando.

**Claude não responde** → Verifique se `CLAUDE_API_KEY` está correta e com créditos disponíveis.

---

**Desenvolvido para: Assis e Xavier Advogados**
**WhatsApp: +55 (44)99977-8551**
