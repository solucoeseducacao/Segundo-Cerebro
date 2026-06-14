# Deploy — Segundo Cérebro

## ⚡ Deploy rápido (um clique)

| Script | O que faz |
|--------|-----------|
| **`deploy.bat`** | Firebase completo: frontend + backend IA + pagamentos ✅ RECOMENDADO |
| **`deploy-netlify.bat`** | Netlify: só o frontend (backend fica no Firebase) |

---

## Pré-requisitos
- Node.js 20+
- `npm install -g firebase-tools`
- Projeto Firebase: segundo-cerebro-bfb66

## 1. Instalar dependências
```
cd functions && npm install
```

## 2. Configurar variáveis de ambiente
```
firebase functions:config:set gemini.api_key="SUA_CHAVE_GEMINI"
firebase functions:config:set asaas.api_key="SEU_TOKEN_ASAAS"
firebase functions:config:set asaas.api_url="https://sandbox.asaas.com/api/v3"
firebase functions:config:set asaas.webhook_token="SEU_TOKEN_WEBHOOK"
```

## 3. Ativar autenticação no Firebase Console
- https://console.firebase.google.com/project/segundo-cerebro-bfb66/authentication
- Ativar: Google + E-mail/Senha

## 4. Definir claim de admin
No Firebase Console > Authentication > seu usuário:
```
admin.auth().setCustomUserClaims('SEU_UID', { admin: true })
```
Após definir, fazer logout e login novamente.

## 5. Configurar webhook Asaas
- URL: https://us-central1-segundo-cerebro-bfb66.cloudfunctions.net/asaasWebhook
- Eventos: PAYMENT_RECEIVED, PAYMENT_CONFIRMED, SUBSCRIPTION_PAYMENT_RECEIVED
- Token: o mesmo valor em asaas.webhook_token

## 6. Deploy completo
```
firebase deploy
```

## 7. URLs
- App:   https://segundo-cerebro-bfb66.web.app
- Admin: https://segundo-cerebro-bfb66.web.app/admin

## Para produção (Asaas)
```
firebase functions:config:set asaas.api_url="https://api.asaas.com/api/v3"
firebase deploy --only functions
```

## Custos estimados (Gemini)
- Flash (resumir/melhorar/OCR): ~R$0,06/operação
- Pro (adaptar artigo): ~R$2,00/operação
- Embedding (busca semântica): ~R$0,001/operação
- Alerta automático ao atingir R$10/dia
