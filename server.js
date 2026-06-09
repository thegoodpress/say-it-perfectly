require('dotenv').config();
const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const bodyParser = require('body-parser');
const { Pool } = require('@neondatabase/serverless');
const crypto = require('crypto');

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Database — Postgres only (optional)
let db = null;
if (process.env.DATABASE_URL) {
  db = new Pool({ connectionString: process.env.DATABASE_URL });
  db.query(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    stripe_session_id TEXT UNIQUE,
    confirmation_code TEXT UNIQUE,
    speech_data TEXT,
    speech_text TEXT,
    is_paid INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`).catch(err => console.error('Postgres init error:', err));
}

async function runQuery(query, params = []) {
  if (!db) return null;
  let pgQuery = query;
  params.forEach((_, i) => { pgQuery = pgQuery.replace('?', `$${i + 1}`); });
  return db.query(pgQuery, params);
}

async function getQuery(query, params = []) {
  if (!db) return null;
  let pgQuery = query;
  params.forEach((_, i) => { pgQuery = pgQuery.replace('?', `$${i + 1}`); });
  const res = await db.query(pgQuery, params);
  return res.rows[0];
}

async function generateSpeech(data) {
  const { yourName, yourRole, partner1, partner2, yearsKnown, relationship, memory1, memory2, memory3, word1, word2, word3, tone, length } = data;
  const coupleDisplay = `${partner1} and ${partner2}`;

  const prompt = `Write a ${tone || 'heartfelt and warm'} wedding speech for a ${yourRole} named ${yourName}.
The couple is ${coupleDisplay}.
${yearsKnown ? `Known them for: ${yearsKnown}.` : ''}
${relationship ? `Relationship context: ${relationship}.` : ''}
${memory1 ? `Memory 1: ${memory1}.` : ''}
${memory2 ? `Memory 2: ${memory2}.` : ''}
${memory3 ? `Memory 3: ${memory3}.` : ''}
${word1 || word2 || word3 ? `Describe the couple using: ${[word1,word2,word3].filter(Boolean).join(', ')}.` : ''}
Length: ${length || 'medium (2-3 minutes)'}.
Write in British English. Make it personal, genuine, and suitable to deliver aloud at a wedding.
Output only the speech text, no titles or stage directions.`;

  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

app.use(cors());
app.use(express.static('public'));

// DEBUG endpoint — remove after fixing
app.get('/debug-gemini', async (req, res) => {
  const keySet = !!process.env.GEMINI_API_KEY;
  const keyPreview = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.substring(0, 8) + '...' : 'NOT SET';
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent('Say hello in one word.');
    res.json({ keySet, keyPreview, success: true, response: result.response.text() });
  } catch (err) {
    res.json({ keySet, keyPreview, success: false, error: err.message, status: err.status, details: err.toString() });
  }
});

// 1. Generate Speech (free preview — no payment required)
app.post('/generate-speech', bodyParser.json(), async (req, res) => {
  try {
    const speech = await generateSpeech(req.body);
    res.json({ speech });
  } catch (err) {
    console.error('Speech generation error:', err.message || err, err.status, err.errorDetails);
    res.status(500).json({ error: 'Failed to generate speech. Please try again.' });
  }
});

// 2. Create Stripe Checkout Session
app.post('/create-checkout-session', bodyParser.json(), async (req, res) => {
  const { speechData, speechText } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: { name: 'Personalised Wedding Speech' },
          unit_amount: 1500,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${req.headers.origin}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.headers.origin}/?canceled=true`,
    });

    await runQuery(
      'INSERT INTO orders (stripe_session_id, speech_data, speech_text) VALUES (?, ?, ?)',
      [session.id, JSON.stringify(speechData), speechText]
    ).catch(err => console.error('DB Insert Error:', err));

    res.json({ id: session.id });
  } catch (error) {
    console.error('Stripe Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Stripe Webhook
app.post('/webhook', bodyParser.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const confirmationCode = 'SIP-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    await runQuery(
      'UPDATE orders SET is_paid = 1, confirmation_code = ? WHERE stripe_session_id = ?',
      [confirmationCode, session.id]
    ).catch(err => console.error('DB Update Error:', err));
  }

  res.json({received: true});
});

// 4. Verify Code
app.post('/verify-code', bodyParser.json(), async (req, res) => {
  const { code } = req.body;

  if (code === 'SIP-DEMO') {
    const demoData = {
      yourName: 'Alex', yourRole: 'Best Man',
      partner1: 'Sam', partner2: 'Jordan',
      yearsKnown: '15 years',
      relationship: 'Best friends since university',
      memory1: 'That time we got lost hiking in the Highlands',
      memory2: 'Helping Sam prepare for the big proposal',
      memory3: 'Endless late nights of gaming and terrible pizza',
      word1: 'loyal', word2: 'hilarious', word3: 'kind',
      tone: 'funny and light', length: 'medium'
    };
    try {
      const speechText = await generateSpeech(demoData);
      return res.json({ success: true, speechData: demoData, speechText });
    } catch (err) {
      console.error('Demo speech error:', err.message || err, err.status, err.errorDetails);
      return res.status(500).json({ error: 'Demo speech generation failed.' });
    }
  }

  try {
    const row = await getQuery(
      'SELECT speech_data, speech_text FROM orders WHERE confirmation_code = ? AND is_paid = 1',
      [code]
    );
    if (row) {
      res.json({
        success: true,
        speechData: typeof row.speech_data === 'string' ? JSON.parse(row.speech_data) : row.speech_data,
        speechText: row.speech_text
      });
    } else {
      res.json({ success: false, message: 'Invalid or unpaid code' });
    }
  } catch (err) {
    console.error('Verify Error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://0.0.0.0:${PORT}`));
}

module.exports = app;
