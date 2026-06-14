const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://segundo-cerebro-bfb66.web.app';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FIREBASE_PROJECT_ID = 'segundo-cerebro-bfb66';
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY; // nunca hardcoded

const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 10;

let db = null;
try {
  if(process.env.FIREBASE_SERVICE_ACCOUNT){
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: FIREBASE_PROJECT_ID
    });
    db = admin.firestore();
    console.log('[firebase-admin] inicializado com service account');
  } else {
    console.warn('[firebase-admin] FIREBASE_SERVICE_ACCOUNT não configurada');
  }
} catch(e) {
  console.error('[firebase-admin] erro:', e.message);
}

app.use((req,res,next)=>{
  const origin = req.headers.origin;
  if(origin && origin !== ALLOWED_ORIGIN){
    return res.status(403).json({error:'Origem nao autorizada'});
  }
  next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function verificarFirebaseToken(authHeader){
  if(!authHeader||!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7);
  try{
    if(db){
      const decoded = await admin.auth().verifyIdToken(idToken);
      return {localId: decoded.uid, email: decoded.email};
    }
    if(!FIREBASE_WEB_API_KEY){ console.error('FIREBASE_WEB_API_KEY não configurada'); return null; }
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`,
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken})}
    );
    const data = await resp.json();
    if(!resp.ok || !data.users || !data.users[0]) return null;
    return data.users[0];
  }catch(e){ return null; }
}

async function checkRateLimit(uid){
  if(!db) return;
  const ref = db.collection('rate_limits').doc(uid);
  const now = Date.now();
  const snap = await ref.get();
  if(snap.exists){
    const d = snap.data();
    if((now - d.ultimoReset) < RATE_LIMIT_WINDOW){
      if(d.count >= RATE_LIMIT_MAX) throw new Error('Muitas requisições. Aguarde um minuto.');
      await ref.update({ count: admin.firestore.FieldValue.increment(1) });
      return;
    }
  }
  await ref.set({ count: 1, ultimoReset: now });
}

async function checkAndUpdateBudget(custo){
  if(!db) return;
  const hoje = new Date().toISOString().slice(0,10);
  const ref = db.collection('admin_config').doc('budget_daily');
  await db.runTransaction(async(t)=>{
    const snap = await t.get(ref);
    let d = snap.exists ? snap.data() : { custoAcumulado:0, bloqueado:false, data:hoje };
    if(d.data !== hoje) d = { custoAcumulado:0, bloqueado:false, data:hoje };
    if(d.bloqueado) throw new Error('Sistema temporariamente em manutenção.');
    const novo = (d.custoAcumulado||0) + custo;
    if(novo > 10){
      t.set(ref, { custoAcumulado:novo, bloqueado:true, data:hoje, bloqueadoEm:admin.firestore.FieldValue.serverTimestamp() }, {merge:true});
      console.error(`ALERTA ORÇAMENTO: R$${novo.toFixed(2)} em ${hoje}`);
    } else {
      t.set(ref, { custoAcumulado:novo, bloqueado:false, data:hoje }, {merge:true});
    }
  });
}

// ── Middleware auth+budget+rate para /claude ──────────────────────────────────

app.use('/claude', async(req,res,next)=>{
  const user = await verificarFirebaseToken(req.headers.authorization);
  if(!user) return res.status(401).json({error:'Nao autenticado. Faca login novamente.'});
  try{
    if(db){
      const budSnap = await db.collection('admin_config').doc('budget_daily').get();
      if(budSnap.exists && budSnap.data().bloqueado)
        return res.status(503).json({error:'Sistema em manutenção. Tente mais tarde.'});
    }
    await checkRateLimit(user.localId);
    req.user = user;
    next();
  }catch(e){
    if(e.message.includes('Muitas')) return res.status(429).json({error:e.message});
    if(e.message.includes('manutenção')) return res.status(503).json({error:e.message});
    return res.status(500).json({error:'Erro interno.'});
  }
});

// ── Rota Claude ───────────────────────────────────────────────────────────────

app.post('/claude', async(req,res)=>{
  try{
    const {messages, system, max_tokens=1024} = req.body;
    if(!messages) return res.status(400).json({error:'messages obrigatorio'});

    const response = await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens,
        system: system || 'Voce e um assistente academico brasileiro. Responda sempre em portugues.',
        messages
      })
    });

    const data = await response.json();
    if(!response.ok) return res.status(response.status).json(data);

    const inputTokens = data.usage?.input_tokens || 0;
    const outputTokens = data.usage?.output_tokens || 0;
    const custoEstimado = (inputTokens * 0.00000025) + (outputTokens * 0.00000125);
    await checkAndUpdateBudget(custoEstimado).catch(()=>{});

    res.json({text: data.content[0].text});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ── Mercado Pago – PIX ────────────────────────────────────────────────────────

app.post('/mp/pix', async(req,res)=>{
  try{
    const {valor, descricao, email_pagador, plano, uid} = req.body;
    if(!valor||!email_pagador||!uid) return res.status(400).json({error:'Dados incompletos'});

    const body = {
      transaction_amount: parseFloat(valor),
      description: descricao || 'Segundo Cerebro',
      payment_method_id: 'pix',
      payer: { email: email_pagador },
      metadata: { plano, uid }
    };

    const resp = await fetch('https://api.mercadopago.com/v1/payments',{
      method:'POST',
      headers:{
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${uid}-${plano}-${Date.now()}`
      },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    if(!resp.ok) return res.status(resp.status).json(data);

    res.json({
      id: data.id,
      status: data.status,
      qr_code: data.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64,
      ticket_url: data.point_of_interaction?.transaction_data?.ticket_url
    });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

app.get('/mp/status/:id', async(req,res)=>{
  try{
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.id}`,{
      headers:{'Authorization': `Bearer ${MP_ACCESS_TOKEN}`}
    });
    const data = await resp.json();
    res.json({status: data.status, plano: data.metadata?.plano, uid: data.metadata?.uid});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

app.post('/mp/assinatura', async(req,res)=>{
  try{
    const {plano, email_pagador, token_cartao, uid} = req.body;
    if(!plano||!email_pagador||!token_cartao||!uid)
      return res.status(400).json({error:'Dados incompletos'});

    const precos = {mestre:19.90, doutor:39.90, pesquisador_pro:79.90};
    const valor = precos[plano];
    if(!valor) return res.status(400).json({error:'Plano invalido'});

    const planResp = await fetch('https://api.mercadopago.com/preapproval_plan',{
      method:'POST',
      headers:{'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        reason: `Segundo Cerebro - ${plano}`,
        auto_recurring:{ frequency:1, frequency_type:'months', transaction_amount:valor, currency_id:'BRL' },
        payment_methods_allowed:{payment_types:[{id:'credit_card'}]},
        back_url: ALLOWED_ORIGIN
      })
    });
    const planData = await planResp.json();
    if(!planResp.ok) return res.status(planResp.status).json(planData);

    const subResp = await fetch('https://api.mercadopago.com/preapproval',{
      method:'POST',
      headers:{'Authorization': `Bearer ${MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        preapproval_plan_id: planData.id,
        payer_email: email_pagador,
        card_token_id: token_cartao,
        status: 'authorized',
        metadata: {plano, uid}
      })
    });
    const subData = await subResp.json();
    if(!subResp.ok) return res.status(subResp.status).json(subData);

    res.json({id: subData.id, status: subData.status, plano});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ── Webhook MP com idempotência ───────────────────────────────────────────────

app.post('/mp/webhook', async(req,res)=>{
  try{
    const {type, data} = req.body;
    if(type==='payment' && data?.id){
      const paymentId = String(data.id);
      if(!db){
        console.error('[webhook] Firestore não disponível');
        return res.sendStatus(200);
      }
      // Idempotência: ignora pagamentos já processados
      const eventRef = db.collection('webhook_events').doc(paymentId);
      const eventSnap = await eventRef.get();
      if(eventSnap.exists){
        console.log(`[webhook] ${paymentId} já processado — ignorando`);
        return res.sendStatus(200);
      }

      const resp = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`,{
        headers:{'Authorization': `Bearer ${MP_ACCESS_TOKEN}`}
      });
      const payment = await resp.json();

      if(payment.status==='approved'){
        const {plano, uid} = payment.metadata||{};
        if(uid){
          const userRef = db.collection('usuarios').doc(uid);
          if(plano==='creditos_100'){
            await userRef.update({ creditos: admin.firestore.FieldValue.increment(100) });
          } else if(plano==='adaptacao_artigo'){
            await userRef.update({ adaptacoesDisponiveis: admin.firestore.FieldValue.increment(1) });
          } else if(plano){
            const expira = new Date();
            expira.setDate(expira.getDate()+365);
            await userRef.set({ plano, pagamentoId:paymentId, planoExpira:expira.toISOString() }, {merge:true});
          }
          console.log(`[webhook] ${paymentId} aprovado → uid=${uid} plano=${plano}`);
        }
      }
      // Marca como processado (mesmo se não aprovado, para não reprocessar)
      await eventRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp(), status: payment.status });
    }
    res.sendStatus(200);
  }catch(e){
    console.error('[webhook] erro:', e.message);
    res.sendStatus(200);
  }
});

// ── Código promocional (unificado: promo_codes) ───────────────────────────────

app.post('/promo/resgatar', async(req,res)=>{
  try{
    const user = await verificarFirebaseToken(req.headers.authorization);
    if(!user) return res.status(401).json({error:'Não autenticado.'});

    const {codigo} = req.body;
    if(!codigo) return res.status(400).json({error:'Código obrigatório.'});
    const codigoNorm = String(codigo).toUpperCase().trim();

    if(!db) return res.status(503).json({error:'Serviço indisponível. Tente mais tarde.'});

    const promoRef = db.collection('promo_codes').doc(codigoNorm);
    const snap = await promoRef.get();
    if(!snap.exists || snap.data().cancelled)
      return res.status(404).json({error:'Código inválido ou cancelado.'});

    const p = snap.data();
    if(p.expiresAt && p.expiresAt.toMillis() < Date.now())
      return res.status(410).json({error:'Código expirado.'});
    if(p.usesLeft !== null && p.usesLeft !== undefined && p.usesLeft <= 0)
      return res.status(409).json({error:'Código esgotado.'});

    const uid = user.localId;
    if((p.redeemedBy||[]).includes(uid))
      return res.status(409).json({error:'Você já usou este código.'});

    const userRef = db.collection('usuarios').doc(uid);
    const F = admin.firestore.FieldValue;

    await db.runTransaction(async(t)=>{
      const pr = await t.get(promoRef);
      const d = pr.data();
      if(d.usesLeft !== null && d.usesLeft !== undefined && d.usesLeft <= 0)
        throw new Error('Esgotado');

      switch(d.type){
        case 'creditos':
          t.update(userRef, { creditos: F.increment(d.value||0) });
          break;
        case 'adaptacao':
          t.update(userRef, { adaptacoesDisponiveis: F.increment(d.value||0) });
          break;
        case 'plano':
          t.update(userRef, { plano: d.value });
          break;
        case 'isencao': {
          const ate = new Date();
          ate.setDate(ate.getDate() + (d.durationDays||7));
          t.update(userRef, {
            isencaoAte: admin.firestore.Timestamp.fromDate(ate),
            isencaoOrigem: codigoNorm
          });
          break;
        }
        default:
          // Compatibilidade com formato antigo (campo plano direto)
          if(d.plano) t.update(userRef, { plano: d.plano });
      }

      const updateData = { redeemedBy: F.arrayUnion(uid) };
      if(d.usesLeft !== null && d.usesLeft !== undefined)
        updateData.usesLeft = F.increment(-1);
      t.update(promoRef, updateData);
    });

    res.json({ok:true, tipo:p.type||'plano', valor:p.value||p.plano});
  }catch(e){
    console.error('[promo] erro:', e.message);
    if(e.message==='Esgotado') return res.status(409).json({error:'Código esgotado.'});
    res.status(500).json({error:'Erro interno.'});
  }
});

app.get('/mp/pubkey', async(_,res)=>{
  res.json({public_key: process.env.MP_PUBLIC_KEY||''});
});

app.get('/health', (_,res)=>res.json({ok:true, mp:!!MP_ACCESS_TOKEN, ai:!!ANTHROPIC_API_KEY, firestore:!!db, v:'4.0'}));

// ── Keep-alive ────────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT||3000}`;
setInterval(async()=>{
  try{ await fetch(`${SELF_URL}/health`); console.log('[keep-alive] ok', new Date().toISOString()); }
  catch(e){ console.warn('[keep-alive] erro:', e.message); }
}, 9 * 60 * 1000);

app.listen(process.env.PORT||3000, ()=>{
  console.log('Proxy Segundo Cerebro v4.0 rodando');
  setTimeout(async()=>{ try{ await fetch(`${SELF_URL}/health`); }catch(e){} }, 5000);
});
