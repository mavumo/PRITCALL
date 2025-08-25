/*
 * AI Receptionist for The Law Offices of Pritpal Singh
 *
 * This script creates a small HTTP/WebSocket server that bridges
 * Twilio voice calls to OpenAI’s APIs. Call audio from Twilio’s
 * Media Streams is converted to text with whisper‑1, the text is
 * processed by the gpt‑3.5‑turbo model, and the resulting text is
 * converted back to speech via gpt‑4o-mini-tts. The system prompt
 * and tailored intake logic are read from an environment variable
 * (SYSTEM_PROMPT) which should contain the modified training script.
 *
 * To run this script on Replit:
 * 1. Create a `.env` file or define environment variables via the
 *    Secrets panel. At a minimum you need OPENAI_API_KEY,
 *    TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER,
 *    SYSTEM_PROMPT, and optionally CALENDLY_LINK for booking.
 * 2. Install dependencies listed in package.json.
 * 3. Run `node server.js` (or `npm start`) to start the server.
 * 4. Point your Twilio phone number’s voice webhook to
 *    `https://<repl-domain>/twiml`.
 */

const Fastify = require('fastify');
const fastifyWs = require('@fastify/websocket');
const { Configuration, OpenAIApi } = require('openai');
const twilio = require('twilio');
const fetch = require('node-fetch');

const app = Fastify();
app.register(fastifyWs);

// Initialise OpenAI client
const openai = new OpenAIApi(new Configuration({ apiKey: process.env.OPENAI_API_KEY }));

// Initialise Twilio client
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Helper: Determine if current time is within business hours (Mon–Fri, 8am–6pm PT)
function isBusinessHours(date = new Date()) {
  const opts = { timeZone: 'America/Los_Angeles', hour12: false, weekday: 'short', hour: 'numeric' };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  const day = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value);
  return !['Sat', 'Sun'].includes(day) && hour >= 8 && hour < 18;
}

// System prompt (training script) loaded from env. This keeps secrets out of code.
const systemPrompt = process.env.SYSTEM_PROMPT ||
  'You are the receptionist for The Law Offices of Pritpal Singh.';

/**
 * Convert text to speech using OpenAI TTS API (gpt-4o-mini-tts)
 * @param {string} text
 * @returns {Promise<Buffer>} PCM audio buffer
 */
async function textToSpeech(text) {
  const response = await openai.createSpeech({
    model: 'gpt-4o-mini-tts',
    input: text,
    voice: 'alloy',
    response_format: 'pcm'
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Convert audio (PCM) to text using OpenAI whisper API
 * @param {Buffer} audioBuffer
 * @returns {Promise<string>}
 */
async function speechToText(audioBuffer) {
  const resp = await openai.createTranscription({
    file: audioBuffer,
    model: 'whisper-1',
    response_format: 'text'
  });
  return (resp.data || '').trim();
}

/**
 * Generate assistant response given conversation history
 * @param {Array} conversation
 * @returns {Promise<string>}
 */
async function chatCompletion(conversation) {
  const completion = await openai.createChatCompletion({
    model: 'gpt-3.5-turbo',
    messages: conversation,
    temperature: 0.7
  });
  return completion.data.choices[0].message.content || '';
}

// TwiML endpoint: called by Twilio when a new call arrives. This returns
// TwiML that tells Twilio to start streaming the call to our websocket.
app.all('/twiml', async (req, reply) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Say>This call may be recorded. Connecting you now.</Say>\n  <Connect><Stream url="wss://${host}/call" /></Connect>\n</Response>`);
});

// WebSocket route: receives bidirectional audio from Twilio
app.get('/call', { websocket: true }, (connection) => {
  // conversation context: start with system prompt
  const conversation = [{ role: 'system', content: systemPrompt }];
  let callActive = true;

  connection.socket.on('message', async (raw) => {
    if (!callActive) return;
    const msg = JSON.parse(raw.toString());
    if (msg.event === 'media') {
      try {
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        // simple approach: assume each chunk is a complete phrase
        const userText = await speechToText(audioBuffer);
        if (!userText) return;
        conversation.push({ role: 'user', content: userText });

        // After-hours check
        if (!isBusinessHours()) {
          const afterHoursText = `Our office hours are Monday through Friday, 8 AM to 6 PM Pacific. Please state your name, phone number, and a brief description of your matter, and we will return your call during the next business day.`;
          const pcm = await textToSpeech(afterHoursText);
          connection.socket.send(JSON.stringify({ event: 'media', media: { payload: pcm.toString('base64') } }));
          conversation.push({ role: 'assistant', content: afterHoursText });
          return;
        }

        // Chat completion
        const assistantText = await chatCompletion(conversation);
        conversation.push({ role: 'assistant', content: assistantText });

        // When the assistant suggests scheduling, send Calendly link via SMS
        if (/\bschedule\b|\bbook\b/.test(assistantText.toLowerCase()) && process.env.CALENDLY_LINK && process.env.CALLER_PHONE) {
          try {
            await twilioClient.messages.create({
              to: process.env.CALLER_PHONE,
              from: process.env.TWILIO_NUMBER,
              body: `Please use this link to schedule your paid consultation: ${process.env.CALENDLY_LINK}`
            });
          } catch (e) {
            console.error('Failed to send SMS:', e.message);
          }
        }

        // Respond via TTS
        const pcm = await textToSpeech(assistantText);
        connection.socket.send(JSON.stringify({ event: 'media', media: { payload: pcm.toString('base64') } }));
      } catch (err) {
        console.error('Error processing media:', err.message);
      }
    } else if (msg.event === 'stop') {
      callActive = false;
      connection.socket.close();
    }
  });
});

// Start server
const port = process.env.PORT || 8081;
app.listen({ port }, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`Server listening on port ${port}`);
});