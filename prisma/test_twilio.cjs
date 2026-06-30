require('dotenv').config();
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
const toPhone = '+541170505564';

console.log('TWILIO_ACCOUNT_SID:', accountSid ? 'SET' : 'MISSING');
console.log('TWILIO_AUTH_TOKEN:', authToken ? 'SET (' + authToken.slice(0,5) + '...)' : 'MISSING');
console.log('TWILIO_WHATSAPP_FROM:', fromNumber);
console.log('To:', toPhone);

if (!accountSid || !authToken || !fromNumber) {
  console.log('Faltan variables de Twilio');
  process.exit(1);
}

const from = fromNumber.startsWith('whatsapp:') ? fromNumber : `whatsapp:${fromNumber}`;
const to = toPhone.startsWith('+') ? `whatsapp:${toPhone}` : `whatsapp:+${toPhone}`;
const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

const body = new URLSearchParams({
  From: from,
  To: to,
  Body: '🧪 Test - Recordatorio de turno MediSync. Respondé 1 para ver tus turnos.',
}).toString();

fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body,
}).then(async res => {
  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text.slice(0, 500));
}).catch(err => {
  console.log('ERROR:', err.message);
});
