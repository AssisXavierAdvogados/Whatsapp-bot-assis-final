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

## 📚 Documentação Completa

Veja `RENDER_DEPLOY.md` para instruções passo-a-passo de deploy.

## 🔒 Segurança

- Nunca coloque credenciais no código
- Use variáveis de ambiente
- `.env` está no `.gitignore`
- Defina `APP_SECRET` para que o `/webhook` só aceite chamadas assinadas pela Meta
- A Ana não avalia chances de êxito nem sugere resultado ao cliente (Provimento 205/2021 da OAB):
  a avaliação preliminar dos documentos segue apenas no resumo interno enviado ao advogado

## 📞 Suporte

Para dúvidas:
- WhatsApp: +55 (44)99977-8551
- Escritório: Assis e Xavier Advogados

## 📄 Licença

MIT

---

**Desenvolvido para Assis e Xavier Advogados** ⚖️
