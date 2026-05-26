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
```

## 📚 Documentação Completa

Veja `RENDER_DEPLOY.md` para instruções passo-a-passo de deploy.

## 🔒 Segurança

- Nunca coloque credenciais no código
- Use variáveis de ambiente
- `.env` está no `.gitignore`

## 📞 Suporte

Para dúvidas:
- WhatsApp: +55 (44)99977-8551
- Escritório: Assis e Xavier Advogados

## 📄 Licença

MIT

---

**Desenvolvido para Assis e Xavier Advogados** ⚖️
