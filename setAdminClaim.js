// Execute UMA VEZ para dar claim de admin ao seu usuário:
// node setAdminClaim.js
const admin = require('firebase-admin');
const path = require('path');

admin.initializeApp({
  credential: admin.credential.cert(require('./chave secreta firebase.json')),
  projectId: 'segundo-cerebro-bfb66'
});

async function setAdmin(email) {
  const user = await admin.auth().getUserByEmail(email);
  await admin.auth().setCustomUserClaims(user.uid, { admin: true });
  console.log(`✅ Custom claim admin:true definida para ${email} (uid: ${user.uid})`);
  process.exit(0);
}

setAdmin('felipevigneron@gmail.com').catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
