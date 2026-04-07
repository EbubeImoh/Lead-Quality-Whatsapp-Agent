import express from "express";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import { fileURLToPath } from 'url';
import rateLimit from "express-rate-limit";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();

// ─── Rate Limiting Security Layer ─────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  standardHeaders: true, 
  legacyHeaders: false, 
  message: { error: "Too many requests, please try again later." }
});

const aiLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // Suppress trust proxy warnings if not needed
  keyGenerator: (req) => {
    // Use the phone/session_id from body or query. 
    // This ensures credits are tracked per browser session.
    return req.body.phone || req.query.phone || req.ip;
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
app.use(express.json());

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
const openai = new OpenAI({
    apiKey: DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com/v1"
});

// ─── Database Setup (SQLite) ──────────────────────────────────────────────────
let db;
(async () => {
  const dbPath = path.resolve(__dirname, "database.sqlite");
  console.log("Initializing database at:", dbPath);
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  await db.exec(`
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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      role TEXT,
      content TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS credits (
      phone TEXT PRIMARY KEY,
      remaining INTEGER DEFAULT 5,
      last_reset DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log("Database initialized successfully.");
})();

// ─── In-memory session store (backed by SQLite) ──────────────────────────────
const sessions = {};

async function checkAndConsumeCredit(phone) {
    let row = await db.get("SELECT * FROM credits WHERE phone = ?", [phone]);
    const now = new Date();
    
    if (!row) {
        await db.run("INSERT INTO credits (phone, remaining, last_reset) VALUES (?, 4, ?)", [phone, now.toISOString()]);
        return 4;
    }
    
    const lastReset = new Date(row.last_reset);
    const diffHours = (now - lastReset) / (1000 * 60 * 60);
    
    if (diffHours >= 24) {
        await db.run("UPDATE credits SET remaining = 4, last_reset = ? WHERE phone = ?", [now.toISOString(), phone]);
        return 4;
    }
    
    if (row.remaining <= 0) return -1;
    
    const newRemaining = row.remaining - 1;
    await db.run("UPDATE credits SET remaining = ? WHERE phone = ?", [newRemaining, phone]);
    return newRemaining;
}

async function getRemainingCredits(phone) {
    let row = await db.get("SELECT * FROM credits WHERE phone = ?", [phone]);
    if (!row) return 5;
    const now = new Date();
    const lastReset = new Date(row.last_reset);
    if ((now - lastReset) / (1000 * 60 * 60) >= 24) return 5;
    return row.remaining;
}

async function getSession(phone) {
  if (!sessions[phone]) {
    const lead = await db.get("SELECT * FROM leads WHERE phone = ?", [phone]) || {};
    const dbHistory = await db.all("SELECT role, content FROM history WHERE phone = ? ORDER BY timestamp ASC", [phone]);
    
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
        history: dbHistory.length > 0 ? dbHistory : []
    };
  }
  return sessions[phone];
}

async function addToHistory(phone, role, content) {
    const session = sessions[phone];
    if (session) {
        session.history.push({ role, content });
    }
    await db.run("INSERT INTO history (phone, role, content) VALUES (?, ?, ?)", [phone, role, content]);
}

// ─── AI Tools Definition ─────────────────────────────────────────────────────
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
  }
];

// ─── Coach persona ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are Coach Clara, a professional business and mindset coach.

YOUR GOAL: Warmly guide the user to share their challenge, name, and email.

CONVERSATION FLOW:
1. GREET - Warm welcome.
2. ASK CHALLENGE - Ask what's their biggest challenge.
3. QUALIFY - Acknowledge the challenge and ask for their NAME.
4. COLLECT EMAIL - Ask for their email to send a free guide.

TOOLS:
- Use 'record_user_challenge' as soon as the user describes their struggle.
- Use 'update_user_identity' when they share their name or email.
- Use 'mark_lead_captured' ONLY after collecting both Name AND Email.

RULES:
- ONE QUESTION AT A TIME.
- Be concise but warm.
`;

// ─── Save lead (SQLite) ────────────────────────────────────────────────────────
async function saveLead(lead, phone) {
  lead.phone = phone;
  lead.timestamp = new Date().toISOString();
  
  try {
    const existing = await db.get("SELECT id FROM leads WHERE phone = ?", [phone]);
    if (existing) {
      await db.run(
        "UPDATE leads SET name = ?, email = ?, challenge = ?, status = ? WHERE phone = ?",
        [lead.name || "", lead.email || "", lead.challenge || "", lead.status || "ongoing", phone]
      );
    } else {
      await db.run(
        "INSERT INTO leads (phone, name, email, challenge, status) VALUES (?, ?, ?, ?, ?)",
        [phone, lead.name || "", lead.email || "", lead.challenge || "", lead.status || "ongoing"]
      );
    }
  } catch (error) {
    console.error("Database save failed:", error);
  }
}

// ─── API Handlers ────────────────────────────────────────────────────────────

app.post("/api/chat", aiLimiter, async (req, res) => {
  const { message, phone } = req.body;
  const userPhone = phone || "streamlit-user";
  if (!message) return res.status(400).json({ error: "Message required" });

  try {
    // 1. Credit Check from DB
    const remaining = await checkAndConsumeCredit(userPhone);
    if (remaining === -1) {
        return res.status(429).json({ 
            reply: "Whoa there, speed racer! 🏎️ You've used up your 5 daily credits. Coach Clara needs a coffee break, and so does my API quota. \n\n**Love this system?** I can build one for your business too! Reach out to my creator at **ebubeimoh@gmail.com** and let's automate your hustle. 😉",
            error: "Rate limit exceeded",
            reasoning: "Rate limit reached. Creator contact recommended.",
            confidence: "1.00",
            stage: "Limit Reached",
            remaining: 0
        });
    }

    const session = await getSession(userPhone);
    session.phone = userPhone;
    const pipelineSteps = [];
    
    pipelineSteps.push({ step: "received", label: "Message Received", timestamp: new Date().toISOString(), details: { message } });
    
    // Add to SQLite history immediately
    await addToHistory(userPhone, "user", message);

    // AI Call with Tool Use Loop
    let assistantMsg;
    let toolCallsProcessed = 0;
    let toolWasCalled = false;
    
    // We loop up to 3 times to allow for multiple tool calls or a final response
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
            session.history.push(assistantMsg); // Add the assistant's request to call tools

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
                }

                // Add tool result to history
                session.history.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: "Action successful."
                });
            }
            
            await saveLead(session.lead, userPhone);
            toolCallsProcessed++;
            continue; // Go back for the model to generate a text response
        } else {
            break; // No tool calls, we have our final text response
        }
    }

    let reply = assistantMsg.content || "I've noted that down. What's next?";
    
    // Clean up any leaked DeepSeek internal tokens
    reply = reply.replace(/<｜DSML｜.*?>/gs, "").trim();
    
    // Final assistant reply to SQLite
    await addToHistory(userPhone, "assistant", reply);

    // Determine stage
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

    // Reasoning & Confidence
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
      confidence,
      remaining: await getRemainingCredits(userPhone)
    });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Twilio WhatsApp webhook (kept for compatibility) ────────────────────────
app.post("/webhook", aiLimiter, async (req, res) => {
  const userMsg = req.body.Body?.trim();
  const phone = req.body.From;
  if (!userMsg || !phone) return res.status(400).send("Bad request");

  try {
    const session = await getSession(phone);
    session.phone = phone;
    session.history.push({ role: "user", content: userMsg });

    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history],
      tools: tools,
      tool_choice: "auto"
    });

    let assistantMsg = response.choices[0].message;

    if (assistantMsg.tool_calls) {
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
        }
      }
      await saveLead(session.lead, phone);

      const secondResponse = await openai.chat.completions.create({
        model: "deepseek-chat",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.history],
      });
      assistantMsg = secondResponse.choices[0].message;
    }

    const reply = assistantMsg.content || "Noted!";
    session.history.push({ role: "assistant", content: reply });

    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type", "text/xml");
    res.send(`<Response><Message>Sorry, I had a hiccup!</Message></Response>`);
  }
});

app.get("/api/credits/:phone", async (req, res) => {
  try {
    const remaining = await getRemainingCredits(req.params.phone);
    res.json({ remaining });
  } catch (err) {
    res.status(500).json({ error: "Credit fetch error" });
  }
});

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
    const leads = await db.all("SELECT * FROM leads ORDER BY timestamp DESC");
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot live on port ${PORT}`));
