const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({limit:'2mb'}));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://segundo-cerebro-bfb66.web.app';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FIREBASE_PROJECT_ID = 'segundo-cerebro-bfb66';
// FIREBASE_WEB_API_KEY deve ser configurada no Render como variável de ambiente
// Valor: AIzaSyAfaddZQi_QILdYZZQv5zb3R3nHRvp7z4s (mesma que está no frontend)

app.use((req,res,next)=>{
  const origin = req.headers.origin;
  if(origin && origin !== ALLOWED_ORIGIN){
    return res.status(403).json({error:'Origem nao autorizada'});
  }
  next();
});

// Valida Firebase ID Token via API pública do Google (sem SDK)
async function verificarFirebaseToken(authHeader){
  if(!authHeader||!authHeader.startsWith('Bearer ')) return null;
  const idToken = authHeader.slice(7);
  try{
    const resp = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.FIREBASE_WEB_API_KEY}`,
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken})}
    );
    const data = await resp.json();
    if(!resp.ok || !data.users || !data.users[0]) return null;
    return data.users[0]; // {localId, email, ...}
  }catch(e){
    return null;
  }
}

// ===== ANTHROPIC / CLAUDE =====
app.post('/claude', async(req,res)=>{
  try{
    // Valida autenticação Firebase
    const user = await verificarFirebaseToken(req.headers.authorization);
    if(!user) return res.status(401).json({error:'Nao autenticado. Faca login novamente.'});

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
    res.json({text: data.content[0].text});

  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ===== MERCADO PAGO — PIX =====
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
        'X-Idempotency-Key': `${uid}-${Date.now()}`
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

// ===== MERCADO PAGO — VERIFICAR STATUS PAGAMENTO =====
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

// ===== MERCADO PAGO — CARTÃO RECORRENTE (ASSINATURA) =====
app.post('/mp/assinatura', async(req,res)=>{
  try{
    const {plano, email_pagador, token_cartao, uid} = req.body;
    if(!plano||!email_pagador||!token_cartao||!uid)
      return res.status(400).json({error:'Dados incompletos'});

    // Tabela de preços (recorrente mensal)
    const precos = {mestre:19.90, doutor:39.90, pesquisador_pro:79.90};
    const valor = precos[plano];
    if(!valor) return res.status(400).json({error:'Plano invalido'});

    // Cria plano de assinatura no MP
    const planResp = await fetch('https://api.mercadopago.com/preapproval_plan',{
      method:'POST',
      headers:{
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reason: `Segundo Cerebro - ${plano}`,
        auto_recurring:{
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: valor,
          currency_id: 'BRL'
        },
        payment_methods_allowed:{payment_types:[{id:'credit_card'}]},
        back_url: ALLOWED_ORIGIN
      })
    });
    const planData = await planResp.json();
    if(!planResp.ok) return res.status(planResp.status).json(planData);

    // Assina o plano com o token do cartão
    const subResp = await fetch('https://api.mercadopago.com/preapproval',{
      method:'POST',
      headers:{
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
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

// ===== MERCADO PAGO — WEBHOOK (confirmação automática) =====
// Trata planos (mestre/doutor/pesquisador_pro) e avulsos (creditos_100/adaptacao_artigo)
app.post('/mp/webhook', async(req,res)=>{
  try{
    const {type, data} = req.body;
    if(type==='payment' && data?.id){
      const resp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`,{
        headers:{'Authorization': `Bearer ${MP_ACCESS_TOKEN}`}
      });
      const payment = await resp.json();
      if(payment.status==='approved'){
        const {plano, uid} = payment.metadata||{};
        if(uid){
          const fsBase=`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/usuarios/${uid}`;

          // Produtos avulsos: creditos_100 e adaptacao_artigo
          if(plano==='creditos_100'){
            // Incremento de créditos via Firestore REST (fieldTransform)
            await fetch(fsBase+':commit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({writes:[{transform:{document:fsBase,fieldTransforms:[{fieldPath:'creditos',increment:{integerValue:100}}]}}]})
            });
          } else if(plano==='adaptacao_artigo'){
            await fetch(fsBase+':commit',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({writes:[{transform:{document:fsBase,fieldTransforms:[{fieldPath:'adaptacoesAvulsas',increment:{integerValue:1}}]}}]})
            });
          } else if(plano){
            // Plano de acesso (mestre, doutor, pesquisador_pro)
            const expira=new Date();expira.setDate(expira.getDate()+365);
            const fsUrl=fsBase+'?updateMask.fieldPaths=plano&updateMask.fieldPaths=pagamentoId&updateMask.fieldPaths=planoExpira';
            await fetch(fsUrl,{
              method:'PATCH',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({fields:{
                plano:{stringValue:plano},
                pagamentoId:{stringValue:String(data.id)},
                planoExpira:{stringValue:expira.toISOString()}
              }})
            });
          }
        }
      }
    }
    res.sendStatus(200);
  }catch(e){
    console.error('Webhook erro:',e.message);
    res.sendStatus(200); // sempre 200 para o MP não reenviar
  }
});

// Expõe Public Key de forma segura (sem expor Access Token)
app.get('/mp/pubkey', async(_,res)=>{
  try{
    // Busca a public key via API do MP
    const resp=await fetch('https://api.mercadopago.com/users/me',{
      headers:{'Authorization':`Bearer ${MP_ACCESS_TOKEN}`}
    });
    const data=await resp.json();
    // A public key fica nas credenciais da aplicação — retornamos como variável de ambiente separada
    res.json({public_key: process.env.MP_PUBLIC_KEY||''});
  }catch(e){
    res.json({public_key: process.env.MP_PUBLIC_KEY||''});
  }
});

app.get('/health', (_,res)=>res.json({ok:true, mp: !!MP_ACCESS_TOKEN, ai: !!ANTHROPIC_API_KEY, v:'2.0'}));

app.listen(process.env.PORT||3000, ()=>console.log('Proxy Segundo Cerebro rodando'));
