import express from "express";
import dotenv from "dotenv";
import initSqlJs from "sql.js";
import path from "path";
import { fileURLToPath } from 'url';
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

// Helper to get client IP
const getClientIp = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
};

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false, 
  message: { error: "Too many requests, please try again later." }
});

const aiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  keyGenerator: (req) => {
    return getClientIp(req);
  },
  handler: (req, res) => {
    res.status(429).json({ 
      reply: "Whoa there, speed racer! 🏎️ You've used up your 5 daily credits. Coach Clara needs a coffee break, and so does my API quota. \n\n**Love this system?** I can build one for your business too! Reach out to my creator at **ebubeimoh@gmail.com** and let's automate your hustle. 😉",
      error: "Rate limit exceeded",
      reasoning: "Rate limit reached. Creator contact recommended.",
      confidence: "1.00",
      stage: "Limit Reached"
    });
  }
});

app.use(generalLimiter);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  verify: (req, res, buf) => {
    console.log("Raw body:", buf.toString());
  }
}));

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const COACH_WHATSAPP = process.env.COACH_WHATSAPP || "2348167583290";

const openai = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1"
});

let db;
const DB_PATH = path.resolve(__dirname, "database.sqlite");

async function initDatabase() {
  const SQL = await initSqlJs();
  
  let data = null;
  if (fs.existsSync(DB_PATH)) {
    data = fs.readFileSync(DB_PATH);
  }
  
  db = new SQL.Database(data);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      name TEXT,
      email TEXT,
      challenge TEXT,
      status TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      role TEXT,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS credits (
      phone TEXT PRIMARY KEY,
      remaining INTEGER DEFAULT 5,
      last_reset DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  saveDatabase();
  console.log("Database initialized successfully.");
}

function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  }
}

initDatabase();

const sessions = {};

async function checkAndConsumeCredit(phone) {
  const stmt = db.prepare("SELECT remaining FROM credits WHERE phone = ?");
  stmt.bind([phone]);
  
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    
    if (row.remaining <= 0) {
      return -1;
    }
    
    db.run("UPDATE credits SET remaining = remaining - 1 WHERE phone = ?", [phone]);
    saveDatabase();
    return row.remaining - 1;
  } else {
    stmt.free();
    db.run("INSERT INTO credits (phone, remaining) VALUES (?, 4)", [phone]);
    saveDatabase();
    return 4;
  }
}

async function getSession(phone) {
  if (!sessions[phone]) {
    const leadStmt = db.prepare("SELECT * FROM leads WHERE phone = ?");
    leadStmt.bind([phone]);
    let lead = {};
    if (leadStmt.step()) {
      lead = leadStmt.getAsObject();
    }
    leadStmt.free();
    
    const historyStmt = db.prepare("SELECT role, content FROM history WHERE phone = ? ORDER BY timestamp ASC");
    historyStmt.bind([phone]);
    const dbHistory = [];
    while (historyStmt.step()) {
      dbHistory.push(historyStmt.getAsObject());
    }
    historyStmt.free();
    
    let stage = "Asking Challenge";
    if (lead.email) stage = "Lead Captured";
    else if (lead.name) stage = "Collecting Email";
    else if (lead.challenge) stage = "Collecting Name";

    sessions[phone] = { 
        stage: stage, 
        lead: {
            name: lead.name || "",
            email: lead.email || "",
            challenge: lead.challenge || "",
            status: lead.status || "ongoing"
        }, 
        history: dbHistory
    };
  }
  return sessions[phone];
}

async function addToHistory(phone, role, content) {
    const session = sessions[phone];
    if (session) {
        session.history.push({ role, content });
    }
    db.run("INSERT INTO history (phone, role, content) VALUES (?, ?, ?)", [phone, role, content]);
    saveDatabase();
}

const tools = [
  {
    type: "function",
    function: {
      name: "record_user_challenge",
      description: "Record the user's primary business or mindset challenge.",
      parameters: {
        type: "object",
        properties: {
          challenge: { type: "string", description: "The detailed challenge the user is facing" }
        },
        required: ["challenge"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_user_identity",
      description: "Update the user's name or email address.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The user's name" },
          email: { type: "string", description: "The user's email address" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "mark_lead_captured",
      description: "Finalize the lead capture when you have both name AND email.",
      parameters: {
        type: "object",
        properties: {
          final_note: { type: "string", description: "Summary of the lead" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_coach_notification",
      description: "Send a notification to the coach's WhatsApp with lead details or feedback.",
      parameters: {
        type: "object",
        properties: {
          notification_type: { 
            type: "string", 
            enum: ["new_lead", "feedback", "meeting_request", "insight"],
            description: "Type of notification" 
          },
          lead_name: { type: "string", description: "Name of the lead" },
          lead_email: { type: "string", description: "Email of the lead" },
          lead_phone: { type: "string", description: "Phone number of the lead" },
          message: { type: "string", description: "Additional message or feedback" }
        },
        required: ["notification_type", "message"]
      }
    }
  }
];

const SYSTEM_PROMPT = `
You are Coach Clara, a professional business and mindset coach.

YOUR GOAL: Warmly guide the user to share their challenge, name, and email.

CONVERSATION FLOW:
1. GREET - Warm welcome.
2. ASK CHALLENGE - Ask what's their biggest challenge.
3. QUALIFY - Acknowledge the challenge and ask for their NAME.
4. CLOSE - When both name and email are captured, confirm and let them know the coach will reach out soon.

TOOLS:
- Use 'record_user_challenge' as soon as the user describes their struggle.
- Use 'update_user_identity' when they share their name or email.
- Use 'mark_lead_captured' ONLY after collecting both Name AND Email.
- Use 'send_coach_notification' when a lead is captured or important feedback is received.

RULES:
- ONE QUESTION AT A TIME.
- Be concise but warm.
- When closing, tell the user: "Thank you! I'll have Coach Clara reach out to you shortly."
`;

async function saveLead(lead, phone) {
  lead.phone = phone;
  lead.timestamp = new Date().toISOString();
  
  const existingStmt = db.prepare("SELECT id FROM leads WHERE phone = ?");
  existingStmt.bind([phone]);
  const exists = existingStmt.step();
  existingStmt.free();
  
  if (exists) {
    db.run(
      "UPDATE leads SET name = ?, email = ?, challenge = ?, status = ? WHERE phone = ?",
      [lead.name || "", lead.email || "", lead.challenge || "", lead.status || "ongoing", phone]
    );
  } else {
    db.run(
      "INSERT INTO leads (phone, name, email, challenge, status) VALUES (?, ?, ?, ?, ?)",
      [phone, lead.name || "", lead.email || "", lead.challenge || "", lead.status || "ongoing"]
    );
  }
  saveDatabase();
}

app.post("/api/chat", aiLimiter, async (req, res) => {
  const { message, phone } = req.body;
  // Use IP for Web UI persistence
  const userPhone = getClientIp(req);
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    const session = await getSession(userPhone);
    session.phone = userPhone;
    const pipelineSteps = [];
    
    pipelineSteps.push({ step: "received", label: "Message Received", timestamp: new Date().toISOString(), details: { message } });
    
    await addToHistory(userPhone, "user", message);

    let assistantMsg;
    let toolCallsProcessed = 0;
    let toolWasCalled = false;
    
    while (toolCallsProcessed < 3) {
        const response = await openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history],
            tools: tools,
            tool_choice: "auto"
        });

        assistantMsg = response.choices[0].message;
        
        if (assistantMsg.tool_calls) {
            toolWasCalled = true;
            session.history.push(assistantMsg);

            for (const toolCall of assistantMsg.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                
                if (toolCall.function.name === "record_user_challenge") {
                    session.lead.challenge = args.challenge;
                    pipelineSteps.push({ step: "extracted", label: "Challenge Recorded", details: args, timestamp: new Date().toISOString() });
                }
                
                if (toolCall.function.name === "update_user_identity") {
                    if (args.name) session.lead.name = args.name;
                    if (args.email) session.lead.email = args.email;
                    pipelineSteps.push({ step: "extracted", label: "Identity Updated", details: args, timestamp: new Date().toISOString() });
                }
                
                if (toolCall.function.name === "mark_lead_captured") {
                    session.lead.status = "lead_captured";
                    pipelineSteps.push({ step: "stored", label: "Lead Finalized", details: args, timestamp: new Date().toISOString() });
                    
                    const summary = await generateConversationSummary(session.history, session.lead);
                    await notifyCoach("new_lead", session.lead.name, session.lead.email, userPhone, summary);
                }
                
                if (toolCall.function.name === "send_coach_notification") {
                    await notifyCoach(args.notification_type, args.lead_name, args.lead_email, args.lead_phone, args.message);
                    pipelineSteps.push({ step: "notification", label: "Coach Notified", details: args, timestamp: new Date().toISOString() });
                }

                session.history.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: "Action successful."
                });
            }
            
            await saveLead(session.lead, userPhone);
            toolCallsProcessed++;
            continue;
        } else {
            break;
        }
    }

    let reply = assistantMsg.content || "I've noted that down. What's next?";
    reply = reply.replace(/<｜DSML｜.*?>/gs, "").trim();
    
    await addToHistory(userPhone, "assistant", reply);

    let status = "ongoing";
    if (session.lead.name && session.lead.email) {
        session.stage = "Lead Captured";
        status = "lead_captured";
    } else if (session.lead.name) {
        session.stage = "Collecting Email";
    } else if (session.lead.challenge) {
        session.stage = "Collecting Name";
    } else {
        session.stage = "Asking Challenge";
    }

    const confidence = toolWasCalled ? "0.98" : "0.75";
    const reasoning = toolWasCalled ? "AI updated lead data and generated a contextual response." : "Engaging in natural conversation flow.";

    pipelineSteps.push({ step: "reasoning", label: "Agent Reasoning", details: reasoning, timestamp: new Date().toISOString() });

    res.json({
      reply,
      lead: session.lead,
      pipeline: pipelineSteps,
      status,
      history: session.history,
      stage: session.stage,
      reasoning,
      confidence
    });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/webhook", aiLimiter, async (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body));
  
  let userMsg, phone;
  
  if (req.body.entry && req.body.entry[0]?.changes) {
    const change = req.body.entry[0].changes[0];
    if (change.value?.messages?.[0]) {
      userMsg = change.value.messages[0].text?.body || change.value.messages[0].interactive?.button?.payload;
      phone = change.value.messages[0].from;
    }
  } else {
    userMsg = req.body.Body?.trim();
    phone = req.body.From;
  }
  
  if (!userMsg || !phone) {
    console.log("No message or phone found");
    return res.status(200).send("OK");
  }

  try {
    const session = await getSession(phone);
    session.phone = phone;
    
    // Check credits for WhatsApp users too
    const remaining = await checkAndConsumeCredit(phone);
    if (remaining === -1) {
        await sendWhatsAppMessage(phone, "Whoa there! 🏎️ You've used up your daily credits. Contact ebubeimoh@gmail.com to build a system like this for your business!");
        return res.status(200).send("OK");
    }

    await addToHistory(phone, "user", userMsg);

    // AI Call with Tool Use Loop
    let assistantMsg;
    let toolCallsProcessed = 0;
    
    while (toolCallsProcessed < 3) {
        const response = await openai.chat.completions.create({
            model: "deepseek-chat",
            messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history],
            tools: tools,
            tool_choice: "auto"
        });

        assistantMsg = response.choices[0].message;
        
        if (assistantMsg.tool_calls) {
            session.history.push(assistantMsg);
            for (const toolCall of assistantMsg.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                if (toolCall.function.name === "record_user_challenge") {
                    session.lead.challenge = args.challenge;
                }
                if (toolCall.function.name === "update_user_identity") {
                    if (args.name) session.lead.name = args.name;
                    if (args.email) session.lead.email = args.email;
                }
                if (toolCall.function.name === "mark_lead_captured") {
                    session.lead.status = "lead_captured";
                    
                    const summary = await generateConversationSummary(session.history, session.lead);
                    await notifyCoach("new_lead", session.lead.name, session.lead.email, phone, summary);
                }
                session.history.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: "Action successful."
                });
            }
            await saveLead(session.lead, phone);
            toolCallsProcessed++;
            continue;
        } else {
            break;
        }
    }

    let reply = assistantMsg.content || "I've noted that down.";
    reply = reply.replace(/<｜DSML｜.*?>/gs, "").trim();
    
    await addToHistory(phone, "assistant", reply);
    await sendWhatsAppMessage(phone, reply);

    if (session.lead.name && session.lead.email && session.lead.status !== "lead_captured") {
      console.log("[webhook] Lead captured - notifying coach");
      session.lead.status = "lead_captured";
      await saveLead(session.lead, phone);
      const summary = await generateConversationSummary(session.history, session.lead);
      await notifyCoach("new_lead", session.lead.name, session.lead.email, phone, summary);
    }

    res.json({ object: "whatsapp_business_account", entry: [] });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_TOKEN;
  
  console.log(`[sendWhatsAppMessage] phoneNumberId: ${phoneNumberId}, accessToken exists: ${!!accessToken}, to: ${to}`);
  
  if (!phoneNumberId || !accessToken) {
    console.log("[sendWhatsAppMessage] WhatsApp credentials not configured");
    return;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: to,
        text: { body: message }
      })
    });
    const result = await response.json();
    console.log("[sendWhatsAppMessage] WhatsApp response:", result);
    return result;
  } catch (err) {
    console.error("[sendWhatsAppMessage] Failed to send WhatsApp message:", err);
  }
}

async function generateConversationSummary(history, lead) {
  const conversationText = history
    .filter(msg => msg.role !== "tool" && msg.content)
    .map(msg => `${msg.role === "user" ? "User" : "Coach"}: ${msg.content}`)
    .join("\n");

  const summaryPrompt = `Analyze this conversation between Coach Clara and a lead. Provide a brief 2-3 sentence summary covering: 1) What challenge/problem the lead shared, 2) Key details about the lead. 

Conversation:
${conversationText}`;

  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "You are a helpful assistant that summarizes conversations concisely." },
        { role: "user", content: summaryPrompt }
      ],
      max_tokens: 150
    });
    return response.choices[0].message.content || `Lead: ${lead.name || "Unknown"}`;
  } catch (err) {
    console.error("Summary generation failed:", err);
    return `Lead captured: ${lead.name || "Unknown"} (${lead.email || "N/A"}) - Challenge: ${lead.challenge || "Not recorded"}`;
  }
}

async function notifyCoach(type, leadName, leadEmail, leadPhone, message) {
  console.log(`[notifyCoach] Attempting to notify coach - Type: ${type}, Lead: ${leadName}, Email: ${leadEmail}, Phone: ${leadPhone}`);
  
  const typeEmoji = {
    "new_lead": "🎉",
    "feedback": "💬",
    "meeting_request": "📅",
    "insight": "💡"
  };
  
  const coachMsg = `${typeEmoji[type] || "📩"} *Coach Clara Alert*

*Type:* ${type.replace("_", " ").toUpperCase()}
*Lead:* ${leadName || "Unknown"}
*Email:* ${leadEmail || "N/A"}
*Message:* ${message}

_AI Assistant_`;
  
  console.log(`[notifyCoach] Sending to coach number: ${COACH_WHATSAPP}`);
  console.log(`[notifyCoach] Message: ${coachMsg}`);
  
  await sendWhatsAppMessage(COACH_WHATSAPP, coachMsg);
  console.log(`Coach notified: ${type} - ${leadName || "Unknown"}`);
}

app.get("/api/session/:phone", async (req, res) => {
  try {
    const session = await getSession(req.params.phone);
    res.json({
      lead: session.lead,
      stage: session.stage,
      history: session.history
    });
  } catch (err) {
    res.status(500).json({ error: "Session load error" });
  }
});

app.get("/api/leads", async (req, res) => {
  try {
    const results = [];
    const stmt = db.prepare("SELECT * FROM leads ORDER BY timestamp DESC");
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Coach Clara bot is running" });
});

app.get("/test-webhook", (req, res) => {
  res.json({ 
    message: "Webhook endpoint is reachable",
    time: new Date().toISOString(),
    hint: "POST a test payload to /webhook to verify"
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'] || req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const verifyToken = process.env.VERIFY_TOKEN || "my_verify_token";

  console.log("GET /webhook - Webhook verification request:", { mode, token, challenge, verifyToken });

  if (mode === 'subscribe' && token === verifyToken) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else {
    console.log("Verification failed:", { received: token, expected: verifyToken });
    res.sendStatus(403);
  }
});

app.post("/subscribe-webhooks", async (req, res) => {
  const accessToken = process.env.WHATSAPP_TOKEN;
  
  if (!accessToken) {
    return res.status(400).json({ error: "WHATSAPP_TOKEN not configured" });
  }

  const wabaId = "1586811042375335"; // WhatsApp Business Account ID from your dashboard

  try {
    const response = await fetch(`https://graph.facebook.com/v22.0/${wabaId}/subscribed_apps`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      }
    });
    const result = await response.json();
    console.log("Subscribe webhooks result:", result);
    res.json(result);
  } catch (err) {
    console.error("Subscribe webhooks error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Bot live on port ${PORT}`));