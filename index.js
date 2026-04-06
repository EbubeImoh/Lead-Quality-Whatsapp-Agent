// WhatsApp Coach Bot — Lead Capture + FAQ
// Stack: Node.js + Express + OpenAI + Twilio (WhatsApp Sandbox)
// Deploy on: Railway / Render / Fly.io (free tier works)

import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── In-memory session store (swap for Redis in production) ───────────────────
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { step: "start", lead: {}, history: [] };
  }
  return sessions[phone];
}

// ─── Coach persona + FAQ context ─────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are the AI assistant for Coach Clara, a business and mindset coach.
Your job is to:
1. Warmly greet and qualify leads
2. Understand their main challenge
3. Collect their name and email
4. Book them for a free 20-min discovery call OR send them Clara's free guide
5. Answer FAQs about Clara's coaching programs

Clara's programs:
- 1:1 Business Coaching ($500/month) — strategy, accountability, scaling
- Mindset Reset ($200/month) — confidence, clarity, work-life balance
- Group Mastermind ($150/month) — community + weekly calls

Keep responses SHORT (max 2 sentences). Be warm, not salesy.
When you have collected name + email + challenge, end with: "LEAD_CAPTURED"
When user books a call, end with: "CALL_BOOKED"
`;

// ─── Conversation flow handler ────────────────────────────────────────────────
async function handleMessage(phone, userMsg) {
  const session = getSession(phone);

  // Add user message to history
  session.history.push({ role: "user", content: userMsg });

  // Extract lead info if present in conversation
  extractLeadInfo(session, userMsg);

  // Get AI response
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // cheap + fast, perfect for this
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...session.history,
    ],
    temperature: 0.7,
    max_tokens: 200,
  });

  let reply = response.choices[0].message.content;

  // Check for special signals from AI
  if (reply.includes("LEAD_CAPTURED")) {
    reply = reply.replace("LEAD_CAPTURED", "").trim();
    await saveLead(session.lead, phone);
    await notifyCoach(session.lead); // notify Clara by email/WhatsApp
  }

  if (reply.includes("CALL_BOOKED")) {
    reply = reply.replace("CALL_BOOKED", "").trim();
    session.lead.status = "call_booked";
    await saveLead(session.lead, phone);
  }

  // Add bot reply to history
  session.history.push({ role: "assistant", content: reply });

  return reply;
}

// ─── Simple lead info extractor ───────────────────────────────────────────────
function extractLeadInfo(session, msg) {
  // Email pattern
  const emailMatch = msg.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) session.lead.email = emailMatch[0];

  // Phone pattern (basic)
  const phoneMatch = msg.match(/(\+?\d[\d\s\-]{8,14}\d)/);
  if (phoneMatch && !session.lead.phone) session.lead.phone = phoneMatch[0];

  // If previous message asked for name, treat short reply as name
  const history = session.history;
  if (history.length >= 2) {
    const prevBot = history[history.length - 2]?.content || "";
    if (
      prevBot.toLowerCase().includes("your name") &&
      msg.length < 30 &&
      !msg.includes("@")
    ) {
      session.lead.name = msg.trim();
    }
  }
}

// ─── Save lead (swap for your DB of choice) ───────────────────────────────────
async function saveLead(lead, phone) {
  lead.phone = phone;
  lead.timestamp = new Date().toISOString();
  lead.source = "whatsapp";

  console.log("NEW LEAD:", lead);

  // Option A: Save to Google Sheets via API
  // await appendToSheet(lead);

  // Option B: Save to Airtable
  // await airtable('Leads').create(lead);

  // Option C: Save to your own DB
  // await db.collection('leads').insertOne(lead);
}

// ─── Notify coach (WhatsApp or email) ─────────────────────────────────────────
async function notifyCoach(lead) {
  // Send Clara a WhatsApp message with the lead details
  // Using Twilio:
  /*
  await twilioClient.messages.create({
    from: 'whatsapp:+14155238886',
    to: `whatsapp:${process.env.COACH_PHONE}`,
    body: `New lead!\nName: ${lead.name}\nEmail: ${lead.email}\nChallenge: ${lead.challenge}`
  });
  */
  console.log("Notifying coach of new lead:", lead.name);
}

// ─── Twilio WhatsApp webhook ──────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const userMsg = req.body.Body?.trim();
  const phone = req.body.From; // e.g. "whatsapp:+2348012345678"

  if (!userMsg || !phone) {
    return res.status(400).send("Bad request");
  }

  try {
    const reply = await handleMessage(phone, userMsg);

    // Twilio expects TwiML XML response
    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  } catch (err) {
    console.error("Bot error:", err);
    res.set("Content-Type", "text/xml");
    res.send(`
      <Response>
        <Message>Sorry, I had a hiccup! Clara will reach out shortly.</Message>
      </Response>
    `);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Coach bot is running ✓"));

// ─── Streamlit UI API Endpoints ───────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, phone } = req.body;
  const userPhone = phone || "streamlit-user";

  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    const session = getSession(userPhone);
    const pipelineSteps = [];
    
    pipelineSteps.push({ step: "received", label: "Message Received", timestamp: new Date().toISOString() });
    
    // Extract lead info
    extractLeadInfo(session, message);
    if (session.lead.email || session.lead.name) {
      pipelineSteps.push({ step: "extracted", label: "Data Extracted", details: session.lead, timestamp: new Date().toISOString() });
    }

    // Get AI response
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...session.history,
      ],
      temperature: 0.7,
      max_tokens: 200,
    });

    let reply = response.choices[0].message.content;
    pipelineSteps.push({ step: "reasoning", label: "Agent Reasoning", details: "Generated response", timestamp: new Date().toISOString() });

    // Check for lead capture or call booking
    let status = "ongoing";
    if (reply.includes("LEAD_CAPTURED")) {
      reply = reply.replace("LEAD_CAPTURED", "").trim();
      await saveLead(session.lead, userPhone);
      await notifyCoach(session.lead);
      pipelineSteps.push({ step: "stored", label: "Lead Stored", details: session.lead, timestamp: new Date().toISOString() });
      pipelineSteps.push({ step: "notified", label: "Coach Notified", details: { name: session.lead.name, email: session.lead.email }, timestamp: new Date().toISOString() });
      status = "lead_captured";
    }

    if (reply.includes("CALL_BOOKED")) {
      reply = reply.replace("CALL_BOOKED", "").trim();
      session.lead.status = "call_booked";
      await saveLead(session.lead, userPhone);
      pipelineSteps.push({ step: "stored", label: "Call Booked", details: session.lead, timestamp: new Date().toISOString() });
      pipelineSteps.push({ step: "notified", label: "Coach Notified", details: { name: session.lead.name }, timestamp: new Date().toISOString() });
      status = "call_booked";
    }

    // Add to history
    session.history.push({ role: "user", content: message });
    session.history.push({ role: "assistant", content: reply });

    res.json({
      reply,
      lead: session.lead,
      pipeline: pipelineSteps,
      status,
      history: session.history
    });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/session/:phone", (req, res) => {
  const { phone } = req.params;
  const session = getSession(phone);
  res.json(session);
});

app.get("/api/sessions", (req, res) => {
  res.json(Object.keys(sessions).map(phone => ({
    phone,
    lead: sessions[phone].lead,
    step: sessions[phone].step
  })));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot live on port ${PORT}`));
