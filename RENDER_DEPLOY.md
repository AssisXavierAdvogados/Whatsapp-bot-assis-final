# 🚀 Guia: Deploy no Render.com

## Passo 1: Preparar credenciais

Certifique-se que você tem:
- ✅ CLAUDE_API_KEY (de console.anthropic.com)
- ✅ TWILIO_ACCOUNT_SID (de console.twilio.com)
- ✅ TWILIO_AUTH_TOKEN (de console.twilio.com)
- ✅ Seu número de WhatsApp do Twilio Sandbox

## Passo 2: Fazer upload no Render

1. Acesse https://render.com
2. Clique em "New +" → "Web Service"
3. Selecione "Public Git repository"
4. Cole a URL (se tiver GitHub): https://github.com/AssisXavierAdvogados/whatsapp-bot-assis-clean
5. OU upload manual dos arquivos

### Se usar upload manual:
1. Crie um repositório Git vazio localmente
2. Faça upload dos arquivos (server.js, package.json, .env.example)
3. Faça push para qualquer repositório Git (GitHub, GitLab, etc)

## Passo 3: Configurar no Render

1. **Name:** assis-xavier-whatsapp-bot
2. **Environment:** Node
3. **Build Command:** npm install
4. **Start Command:** npm start
5. **Plan:** Free

## Passo 4: Adicionar variáveis de ambiente

No Render dashboard, vá em "Environment":

```
CLAUDE_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=AC0d9b1b...
TWILIO_AUTH_TOKEN=SK9f726e0e...
TWILIO_PHONE=whatsapp:+14155238886
ESCRITORIO_PHONE=+55 (44)99977-8551
PORT=3000
NODE_ENV=production
```

## Passo 5: Configurar Webhook no Twilio

1. Acesse https://console.twilio.com
2. Vá em "Messaging" → "Services" → Seu serviço
3. Em "Inbound Settings", coloque a URL:

```
https://seu-app.onrender.com/webhook/messages
```

(Substitua "seu-app" pelo nome do seu serviço no Render)

## Passo 6: Testar

1. No Render, procure pela URL da sua aplicação
2. Visite: https://seu-app.onrender.com/health
3. Deve retornar: {"status":"OK","message":"Chatbot está funcionando!"}

## Pronto! 🎉

Seu chatbot está online 24/7!

Envie uma mensagem via WhatsApp para o Twilio Sandbox e teste!

---

## Troubleshooting

### Erro 503 Service Unavailable
- Espere 1-2 minutos para o serviço iniciar
- Verifique os logs no Render

### Mensagens não chegam
- Verifique se as credenciais do Twilio estão corretas
- Confirme que o webhook está apontando para a URL correta
- Verifique os logs de erro no Render

### Erro de autenticação Claude
- Confirme que a API Key está correta
- Verifique se tem créditos disponíveis

---

**Desenvolvido para: Assis e Xavier Advogados** ⚖️
**WhatsApp: +55 (44)99977-8551**
