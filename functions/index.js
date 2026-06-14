const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const axios     = require('axios');
const crypto    = require('crypto');

admin.initializeApp();
const db = admin.firestore();

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const PLANOS = {
  leitor:          { citacoes: 30,        exportacoesMes: 5,        creditos: 0,   adaptacoes: 0, ocr: false, offline: false },
  mestre:          { citacoes: Infinity,  exportacoesMes: Infinity,  creditos: 10,  adaptacoes: 0, ocr: false, offline: false },
  mestre_offline:  { citacoes: Infinity,  exportacoesMes: Infinity,  creditos: 10,  adaptacoes: 0, ocr: false, offline: true  },
  doutor:          { citacoes: Infinity,  exportacoesMes: Infinity,  creditos: 50,  adaptacoes: 0, ocr: true,  offline: true  },
  pesquisador_pro: { citacoes: Infinity,  exportacoesMes: Infinity,  creditos: 200, adaptacoes: 3, ocr: true,  offline: true  },
};
const CUSTOS             = { flash: 0.011, pro: 2.0, embed: 0.001 };
const BUDGET_COLLECTION  = 'admin_config';
const BUDGET_DOC         = 'budget_daily';
const RATE_LIMIT_WINDOW  = 60_000;
const RATE_LIMIT_MAX     = 10;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sanitize(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>?/gm, '')
             .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
             .trim();
}

async function checkExemptionAndGetUser(uid, token) {
  const snap = await db.collection('usuarios').doc(uid).get();
  if (!snap.exists)
    throw new functions.https.HttpsError('not-found', 'Usuário não encontrado.');
  const userData = snap.data();
  if (token?.admin === true) {
    const cfg = await db.collection(BUDGET_COLLECTION).doc(uid).get();
    if (cfg.exists && cfg.data().mode === 'isento')
      return { exempt: true, type: 'admin', userData };
  }
  if (userData.isencaoAte && userData.isencaoAte.toMillis() > Date.now())
    return { exempt: true, type: 'promo', origem: userData.isencaoOrigem, userData };
  return { exempt: false, userData };
}

async function checkRateLimit(uid) {
  const ref  = db.collection('rate_limits').doc(uid);
  const now  = Date.now();
  const snap = await ref.get();
  if (snap.exists) {
    const d = snap.data();
    if ((now - d.ultimoReset) < RATE_LIMIT_WINDOW) {
      if (d.count >= RATE_LIMIT_MAX)
        throw new functions.https.HttpsError('resource-exhausted', 'Muitas requisições. Aguarde um minuto.');
      await ref.update({ count: admin.firestore.FieldValue.increment(1) });
      return;
    }
  }
  await ref.set({ count: 1, ultimoReset: now });
}

async function checkAndUpdateBudget(custo, isExempt) {
  if (isExempt) return;
  const hoje = new Date().toISOString().slice(0, 10);
  const ref  = db.collection(BUDGET_COLLECTION).doc(BUDGET_DOC);
  await db.runTransaction(async t => {
    const snap = await t.get(ref);
    let d = snap.exists ? snap.data() : { custoAcumulado: 0, bloqueado: false, data: hoje };
    if (d.data !== hoje) d = { custoAcumulado: 0, bloqueado: false, data: hoje };
    if (d.bloqueado)
      throw new functions.https.HttpsError('resource-exhausted', 'Sistema temporariamente em manutenção.');
    const novo = d.custoAcumulado + custo;
    if (novo > 10) {
      t.set(ref, { custoAcumulado: novo, bloqueado: true, data: hoje,
                   bloqueadoEm: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      console.error(`ALERTA ORÇAMENTO: R$${novo.toFixed(2)} em ${hoje}`);
    } else {
      t.set(ref, { custoAcumulado: novo, bloqueado: false, data: hoje }, { merge: true });
    }
  });
}

async function geminiGenerate(model, prompt, imagemBase64 = null) {
  const apiKey = functions.config().gemini.api_key;
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const parts  = imagemBase64
    ? [{ inlineData: { mimeType: 'image/jpeg', data: imagemBase64 } }, { text: prompt }]
    : [{ text: prompt }];
  try {
    const resp = await axios.post(url, { contents: [{ role: 'user', parts }] },
      { headers: { 'Content-Type': 'application/json' } });
    return resp.data.candidates[0].content.parts[0].text;
  } catch (err) {
    if (err.response?.data?.error?.message?.includes('quota'))
      throw new functions.https.HttpsError('resource-exhausted', 'Cota da IA excedida. Contate o suporte.');
    throw new functions.https.HttpsError('internal', 'Erro ao processar com IA.');
  }
}

async function geminiEmbed(text) {
  const apiKey = functions.config().gemini.api_key;
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
  try {
    const resp = await axios.post(url, {
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
      taskType: 'SEMANTIC_SIMILARITY'
    });
    return resp.data.embedding.values;
  } catch (err) {
    if (err.response?.data?.error?.message?.includes('quota'))
      throw new functions.https.HttpsError('resource-exhausted', 'Cota da IA excedida.');
    throw new functions.https.HttpsError('internal', 'Erro ao gerar embedding.');
  }
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]**2; nb += b[i]**2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

// ─── callGemini ───────────────────────────────────────────────────────────────
exports.callGemini = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid = context.auth.uid;
  const { operacao, texto, textoArtigo, normas, imagemBase64, preview } = data;
  const { exempt, type: exemptType, userData: ud } =
    await checkExemptionAndGetUser(uid, context.auth.token);
  const plano    = PLANOS[ud.plano] || PLANOS.leitor;
  const isExempt = exempt;

  if (!isExempt) {
    const budRef  = db.collection(BUDGET_COLLECTION).doc(BUDGET_DOC);
    const budSnap = await budRef.get();
    if (budSnap.exists && budSnap.data().bloqueado)
      throw new functions.https.HttpsError('resource-exhausted', 'Sistema temporariamente em manutenção.');
  }

  if (['resumir', 'melhorar'].includes(operacao)) {
    if (!isExempt && (ud.creditos || 0) < 1)
      throw new functions.https.HttpsError('resource-exhausted', 'Créditos insuficientes.');
    if (!isExempt) await checkRateLimit(uid);
  } else if (operacao === 'ocr') {
    if (!plano.ocr && !isExempt)
      throw new functions.https.HttpsError('permission-denied', 'OCR disponível a partir do plano Doutor.');
    if (!imagemBase64)
      throw new functions.https.HttpsError('invalid-argument', 'Imagem necessária.');
    const limiteBytes = isExempt ? 6*1024*1024 : 4*1024*1024;
    if (Buffer.byteLength(imagemBase64, 'base64') > limiteBytes)
      throw new functions.https.HttpsError('invalid-argument', 'Imagem muito grande.');
    if (!isExempt && (ud.creditos || 0) < 1)
      throw new functions.https.HttpsError('resource-exhausted', 'Créditos insuficientes.');
    if (!isExempt) await checkRateLimit(uid);
  } else if (operacao === 'adaptar_normas') {
    if (!textoArtigo || !normas)
      throw new functions.https.HttpsError('invalid-argument', 'Artigo e normas são obrigatórios.');
    if (textoArtigo.length > 125000)
      throw new functions.https.HttpsError('invalid-argument', 'Artigo muito extenso (máx. ~125 mil caracteres).');
    if (!isExempt && !preview && (ud.adaptacoesDisponiveis || 0) < 1)
      throw new functions.https.HttpsError('resource-exhausted', 'Nenhuma adaptação disponível.');
  } else {
    throw new functions.https.HttpsError('invalid-argument', 'Operação inválida.');
  }

  let hashInput;
  if (['resumir', 'melhorar'].includes(operacao)) {
    const t = sanitize(texto);
    hashInput = crypto.createHash('sha256').update(`${t}|${operacao}`).digest('hex');
    const cached = await db.collection('ia_cache').doc(hashInput).get();
    if (cached.exists && cached.data().expiraEm > Date.now())
      return { success: true, resultado: cached.data().resultado, cached: true };
  }

  let modelo, custo, prompt, resultado;
  try {
    if (operacao === 'resumir') {
      modelo = 'gemini-1.5-flash-latest'; custo = CUSTOS.flash;
      prompt = `Resuma em até 3 frases acadêmicas concisas:\n\n"${sanitize(texto)}"`;
    } else if (operacao === 'melhorar') {
      modelo = 'gemini-1.5-flash-latest'; custo = CUSTOS.flash;
      prompt = `Reescreva o trecho abaixo com maior fluidez e precisão acadêmica, mantendo o sentido original:\n\n"${sanitize(texto)}"`;
    } else if (operacao === 'ocr') {
      modelo = 'gemini-1.5-flash-latest'; custo = CUSTOS.flash;
      resultado = await geminiGenerate(modelo,
        'Extraia todo o texto visível desta imagem, preservando parágrafos e pontuação.',
        imagemBase64);
    } else if (operacao === 'adaptar_normas') {
      modelo = 'gemini-1.5-pro-latest'; custo = preview ? CUSTOS.pro * 0.15 : CUSTOS.pro;
      const previewSuffix = preview
        ? '\n\nIMPORTANTE: Retorne apenas os primeiros 15% do artigo revisado (prévia gratuita).' : '';
      prompt = `Reescreva o artigo acadêmico abaixo aplicando rigorosamente as normas indicadas. Retorne apenas o artigo revisado, sem comentários.\n\nNORMAS:\n${sanitize(normas)}\n\nARTIGO:\n${sanitize(textoArtigo)}${previewSuffix}`;
    }
    if (operacao !== 'ocr') resultado = await geminiGenerate(modelo, prompt);
  } catch (err) {
    if (err instanceof functions.https.HttpsError) throw err;
    throw new functions.https.HttpsError('internal', 'Erro ao processar com IA.');
  }

  if (!isExempt && !preview) {
    const userRef = db.collection('usuarios').doc(uid);
    if (operacao === 'adaptar_normas') {
      await db.runTransaction(async t => {
        const d = await t.get(userRef);
        if ((d.data().adaptacoesDisponiveis || 0) < 1) throw new Error('Saldo insuficiente');
        t.update(userRef, { adaptacoesDisponiveis: admin.firestore.FieldValue.increment(-1) });
      });
    } else {
      await userRef.update({ creditos: admin.firestore.FieldValue.increment(-1) });
    }
  }

  if (['resumir', 'melhorar'].includes(operacao) && hashInput) {
    await db.collection('ia_cache').doc(hashInput).set({
      resultado, operacao,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      expiraEm: Date.now() + 7*24*60*60*1000
    });
  }

  const hoje = new Date().toISOString().slice(0, 10);
  await db.collection('ia_logs').add({
    uid, operacao, modelo, custo, data: hoje,
    preview: preview || false, exempt: isExempt,
    exemptType: exemptType || 'none',
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  });
  await checkAndUpdateBudget(custo, isExempt);
  return { success: true, resultado, cached: false };
});

// ─── gerarEmbedding ───────────────────────────────────────────────────────────
exports.gerarEmbedding = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid = context.auth.uid;
  const { quoteId, texto, autor, obra } = data;
  if (!quoteId || !texto)
    throw new functions.https.HttpsError('invalid-argument', 'quoteId e texto obrigatórios.');
  const citRef  = db.collection('usuarios').doc(uid).collection('citacoes').doc(quoteId);
  const citSnap = await citRef.get();
  if (!citSnap.exists)
    throw new functions.https.HttpsError('not-found', 'Citação não encontrada.');
  const { exempt, userData: ud } = await checkExemptionAndGetUser(uid, context.auth.token);
  if ((ud.plano || 'leitor') === 'leitor' && !exempt)
    throw new functions.https.HttpsError('permission-denied', 'Recurso disponível a partir do plano Mestre.');
  const conteudo = `${texto} — ${autor || ''}${obra ? ', ' + obra : ''}`;
  const embedding = await geminiEmbed(conteudo);
  await db.collection('usuarios').doc(uid).collection('embeddings').doc(quoteId).set({
    embedding,
    texto: texto.slice(0, 300),
    autor: autor || '',
    obra: obra || '',
    atualizadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  return { success: true };
});

// ─── buscaSemantica ───────────────────────────────────────────────────────────
exports.buscaSemantica = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid = context.auth.uid;
  const { query } = data;
  if (!query) throw new functions.https.HttpsError('invalid-argument', 'Query obrigatória.');
  const { exempt, userData: ud } = await checkExemptionAndGetUser(uid, context.auth.token);
  if ((ud.plano || 'leitor') === 'leitor' && !exempt)
    throw new functions.https.HttpsError('permission-denied', 'Busca semântica disponível a partir do plano Mestre.');
  const queryEmb = await geminiEmbed(query);
  const snap = await db.collection('usuarios').doc(uid).collection('embeddings').get();
  const resultados = snap.docs
    .map(d => ({ id: d.id, score: cosineSim(queryEmb, d.data().embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  return { success: true, resultados };
});

// ─── criarCobranca ────────────────────────────────────────────────────────────
exports.criarCobranca = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid = context.auth.uid;
  const { produto } = data;
  const PRODUTOS = {
    creditos_100:         { valor: 19.90, descricao: 'Pacote de Créditos — 100 créditos IA',       assinatura: false },
    adaptacao_artigo:     { valor: 19.90, descricao: 'Adaptação de Artigo (IA Pro)',                assinatura: false },
    plano_mestre:         { valor: 19.90, descricao: 'Plano Mestre — Assinatura mensal',            assinatura: true  },
    plano_mestre_offline: { valor: 24.80, descricao: 'Plano Mestre + Offline — Assinatura mensal',  assinatura: true  },
    plano_doutor:         { valor: 39.90, descricao: 'Plano Doutor — Assinatura mensal',            assinatura: true  },
    plano_pesquisador_pro:{ valor: 79.90, descricao: 'Plano Pesquisador Pro — Assinatura mensal',   assinatura: true  },
  };
  const prod = PRODUTOS[produto];
  if (!prod) throw new functions.https.HttpsError('invalid-argument', 'Produto inválido.');
  const apiKey     = functions.config().asaas.api_key;
  const apiUrl     = functions.config().asaas.api_url;
  const userRecord = await admin.auth().getUser(uid);
  const userName   = userRecord.displayName || 'Usuário';
  const userEmail  = userRecord.email || '';
  let customerId;
  const srch = await axios.get(`${apiUrl}/customers?externalReference=${uid}`,
    { headers: { 'access_token': apiKey } });
  if (srch.data.data?.length) {
    customerId = srch.data.data[0].id;
  } else {
    const cr = await axios.post(`${apiUrl}/customers`,
      { name: userName, email: userEmail, externalReference: uid },
      { headers: { 'access_token': apiKey, 'Content-Type': 'application/json' } });
    customerId = cr.data.id;
  }
  let response;
  if (prod.assinatura) {
    const nd = new Date(); nd.setDate(nd.getDate() + 30);
    response = await axios.post(`${apiUrl}/subscriptions`, {
      customer: customerId, value: prod.valor,
      nextDueDate: nd.toISOString().split('T')[0],
      cycle: 'MONTHLY', description: prod.descricao,
      billingType: 'PIX', externalReference: uid
    }, { headers: { 'access_token': apiKey, 'Content-Type': 'application/json' } });
  } else {
    const venc = new Date(); venc.setDate(venc.getDate() + 1);
    response = await axios.post(`${apiUrl}/payments`, {
      customer: customerId, billingType: 'PIX',
      value: prod.valor, dueDate: venc.toISOString().split('T')[0],
      description: prod.descricao, externalReference: uid
    }, { headers: { 'access_token': apiKey, 'Content-Type': 'application/json' } });
  }
  return {
    success:      true,
    paymentId:    response.data.id,
    invoiceUrl:   response.data.invoiceUrl   || null,
    pixCode:      response.data.pixCode      || null,
    pixQrCodeUrl: response.data.pixQrCodeUrl || null,
  };
});

// ─── asaasWebhook ─────────────────────────────────────────────────────────────
exports.asaasWebhook = functions.https.onRequest(async (req, res) => {
  const token = functions.config().asaas.webhook_token;
  if ((req.headers['asaas-access-token'] || req.body?.access_token) !== token)
    return res.status(403).send('Forbidden');
  const { event, payment } = req.body;
  if (!payment) return res.status(400).send('No payment');
  const EVENTOS_OK = [
    'PAYMENT_RECEIVED','PAYMENT_CONFIRMED',
    'PAYMENT_CREDIT_CARD_CAPTURED','SUBSCRIPTION_PAYMENT_RECEIVED'
  ];
  if (!EVENTOS_OK.includes(event)) return res.status(200).send('ignored');
  const uid = payment.externalReference;
  if (!uid) return res.status(400).send('No uid');
  const desc = (payment.description || '').toLowerCase();
  let prod = null;
  if      (desc.includes('100 créditos'))          prod = 'creditos_100';
  else if (desc.includes('adaptação de artigo'))   prod = 'adaptacao_artigo';
  else if (desc.includes('mestre + offline'))      prod = 'plano_mestre_offline';
  else if (desc.includes('plano mestre'))          prod = 'plano_mestre';
  else if (desc.includes('plano doutor'))          prod = 'plano_doutor';
  else if (desc.includes('plano pesquisador pro')) prod = 'plano_pesquisador_pro';
  if (!prod) return res.status(200).send('ignored');
  const userRef = db.collection('usuarios').doc(uid);
  const snap    = await userRef.get();
  if (!snap.exists) await userRef.set({
    plano:'leitor', creditos:0, adaptacoesDisponiveis:0,
    exportacoesMes:0, offlineHabilitado:false,
    criadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  const F = admin.firestore.FieldValue;
  switch (prod) {
    case 'creditos_100':
      await userRef.update({ creditos: F.increment(100) }); break;
    case 'adaptacao_artigo':
      await userRef.update({ adaptacoesDisponiveis: F.increment(1) }); break;
    case 'plano_mestre':
      await userRef.update({ plano:'mestre', offlineHabilitado:false }); break;
    case 'plano_mestre_offline':
      await userRef.update({ plano:'mestre', offlineHabilitado:true }); break;
    case 'plano_doutor':
      await userRef.update({ plano:'doutor', offlineHabilitado:true }); break;
    case 'plano_pesquisador_pro':
      await userRef.update({
        plano:'pesquisador_pro', offlineHabilitado:true,
        adaptacoesDisponiveis: F.increment(3),
        creditos: F.increment(200)
      }); break;
  }
  res.status(200).send('OK');
});

// ─── resgatarCodigo ───────────────────────────────────────────────────────────
exports.resgatarCodigo = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid  = context.auth.uid;
  const code = (data.code || '').toUpperCase();
  if (!code) throw new functions.https.HttpsError('invalid-argument', 'Código obrigatório.');
  const promoRef = db.collection('promo_codes').doc(code);
  const promo    = await promoRef.get();
  if (!promo.exists || promo.data().cancelled)
    throw new functions.https.HttpsError('not-found', 'Código inválido ou cancelado.');
  const p = promo.data();
  if (p.expiresAt && p.expiresAt.toMillis() < Date.now())
    throw new functions.https.HttpsError('deadline-exceeded', 'Código expirado.');
  if (p.usesLeft !== null && p.usesLeft <= 0)
    throw new functions.https.HttpsError('resource-exhausted', 'Código esgotado.');
  if ((p.redeemedBy || []).filter(x => x === uid).length >= (p.usesPerUser || 1))
    throw new functions.https.HttpsError('already-exists', 'Você já usou este código.');
  const userRef = db.collection('usuarios').doc(uid);
  const F = admin.firestore.FieldValue;
  await db.runTransaction(async t => {
    const pr = await t.get(promoRef);
    const d  = pr.data();
    if (d.usesLeft !== null && d.usesLeft <= 0) throw new Error('Esgotado');
    switch (d.type) {
      case 'creditos':
        t.update(userRef, { creditos: F.increment(d.value || 0) }); break;
      case 'adaptacao':
        t.update(userRef, { adaptacoesDisponiveis: F.increment(d.value || 0) }); break;
      case 'plano':
        t.update(userRef, { plano: d.value }); break;
      case 'isencao': {
        const ate = new Date();
        ate.setDate(ate.getDate() + (d.durationDays || 7));
        t.update(userRef, {
          isencaoAte: admin.firestore.Timestamp.fromDate(ate),
          isencaoOrigem: code
        }); break;
      }
    }
    t.update(promoRef, {
      usesLeft: d.usesLeft !== null ? F.increment(-1) : null,
      redeemedBy: F.arrayUnion(uid)
    });
  });
  return { success: true, tipo: p.type, valor: p.value };
});

// ─── adminControlBudget ───────────────────────────────────────────────────────
exports.adminControlBudget = functions.https.onCall(async (data, context) => {
  if (!context.auth?.token.admin)
    throw new functions.https.HttpsError('permission-denied', 'Acesso negado.');
  if (data.action === 'liberar') {
    await db.collection(BUDGET_COLLECTION).doc(BUDGET_DOC).update({ bloqueado: false });
    return { message: 'Sistema liberado.' };
  }
  return { message: 'Status mantido.' };
});

// ─── adminCreatePromoCode ─────────────────────────────────────────────────────
exports.adminCreatePromoCode = functions.https.onCall(async (data, context) => {
  if (!context.auth?.token.admin)
    throw new functions.https.HttpsError('permission-denied', 'Acesso negado.');
  const { code, type, value, expiresAt, usesLeft, usesPerUser, privilegeLevel, durationDays } = data;
  if (!code || !type)
    throw new functions.https.HttpsError('invalid-argument', 'code e type são obrigatórios.');
  if (privilegeLevel === 'ilimitado') {
    if (type !== 'isencao')
      throw new functions.https.HttpsError('invalid-argument', 'Ilimitado só para tipo isencao.');
    if (!durationDays || durationDays < 1 || durationDays > 30)
      throw new functions.https.HttpsError('invalid-argument', 'durationDays deve ser entre 1 e 30.');
    const cfg = await db.collection(BUDGET_COLLECTION).doc(context.auth.uid).get();
    if ((cfg.data()?.ilimitadosAtivos || 0) >= 3)
      throw new functions.https.HttpsError('resource-exhausted', 'Máximo de 3 códigos ilimitados ativos.');
    await db.collection(BUDGET_COLLECTION).doc(context.auth.uid).set(
      { ilimitadosAtivos: admin.firestore.FieldValue.increment(1) }, { merge: true });
  }
  await db.collection('promo_codes').doc(code.toUpperCase()).set({
    code: code.toUpperCase(), type,
    value:          value        || 0,
    expiresAt:      expiresAt    ? admin.firestore.Timestamp.fromMillis(expiresAt) : null,
    usesLeft:       usesLeft     ?? 100,
    usesPerUser:    usesPerUser  || 1,
    privilegeLevel: privilegeLevel || 'limitado',
    durationDays:   durationDays   || null,
    createdBy:  context.auth.uid,
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    cancelled:  false,
    redeemedBy: []
  });
  return { success: true };
});

// ─── adminCancelPromoCode ─────────────────────────────────────────────────────
exports.adminCancelPromoCode = functions.https.onCall(async (data, context) => {
  if (!context.auth?.token.admin)
    throw new functions.https.HttpsError('permission-denied', 'Acesso negado.');
  const { code } = data;
  const promoRef = db.collection('promo_codes').doc(code.toUpperCase());
  const snap     = await promoRef.get();
  if (!snap.exists)
    throw new functions.https.HttpsError('not-found', 'Código não encontrado.');
  const p = snap.data();
  if (p.type === 'isencao' && p.redeemedBy?.length) {
    const batch = db.batch();
    for (const ruid of p.redeemedBy) {
      batch.update(db.collection('usuarios').doc(ruid), {
        isencaoAte:    admin.firestore.FieldValue.delete(),
        isencaoOrigem: admin.firestore.FieldValue.delete()
      });
    }
    await batch.commit();
  }
  await promoRef.update({ cancelled: true });
  if (p.privilegeLevel === 'ilimitado') {
    await db.collection(BUDGET_COLLECTION).doc(context.auth.uid).update({
      ilimitadosAtivos: admin.firestore.FieldValue.increment(-1)
    });
  }
  return { success: true };
});

// ─── inicializarUsuario ───────────────────────────────────────────────────────
exports.inicializarUsuario = functions.https.onCall(async (data, context) => {
  if (!context.auth)
    throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
  const uid = context.auth.uid;
  const ref = db.collection('usuarios').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return { ja_existia: true };
  await ref.set({
    uid,
    email:  context.auth.token.email || '',
    nome:   context.auth.token.name  || '',
    plano:  'leitor',
    creditos: 0,
    adaptacoesDisponiveis: 0,
    exportacoesMes: 0,
    offlineHabilitado: false,
    criadoEm: admin.firestore.FieldValue.serverTimestamp()
  });
  return { ja_existia: false };
});
