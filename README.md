# WhatsApp Coach Bot — Setup Guide

## What this bot does
- Greets visitors on WhatsApp
- Qualifies them (understands their challenge)
- Collects name + email
- Books discovery calls or sends info
- Notifies the coach instantly
- Answers FAQs using GPT

---

## Setup (30-60 mins total)

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Get your API keys
You need two accounts (both free to start):

**OpenAI**
- Go to platform.openai.com
- Create API key
- Add $5 credit (enough for ~500 conversations)

**Twilio (WhatsApp Sandbox)**
- Go to twilio.com → sign up free
- Go to Messaging → Try WhatsApp Sandbox
- You get a sandbox number instantly
- No business verification needed for testing

### Step 3 — Set environment variables
Create a `.env` file:
```
OPENAI_API_KEY=sk-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
COACH_PHONE=+234801234567
PORT=3000
```

### Step 4 — Deploy (free)
**Railway (easiest):**
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```
Railway gives you a public URL like: `https://your-bot.railway.app`

### Step 5 — Connect to Twilio
- Go to Twilio WhatsApp Sandbox settings
- Set webhook URL to: `https://your-bot.railway.app/webhook`
- Method: POST
- Save

### Step 6 — Test it
- Go to Twilio sandbox
- Send the join code to the sandbox number via WhatsApp
- Start chatting!

---

## Customising for each client

To adapt this for a new client, only change these things in index.js:

1. **SYSTEM_PROMPT** — change coach name, programs, prices
2. **notifyCoach()** — change coach's phone number
3. **saveLead()** — connect to their Google Sheets or Airtable

That's it. One bot template → infinite clients.

---

## Pricing this to clients

**Setup fee:** $300–500
- Configure for their business
- Connect to their WhatsApp
- 1 week of testing

**Monthly retainer:** $100–150/month
- Keep it running
- Update FAQs
- Monitor leads

**Your cost to run it:**
- OpenAI: ~$3–8/month (depending on traffic)
- Railway: Free tier covers most small businesses
- Twilio: ~$1/month

**Your margin:** Very high.

---

## Upgrading later

Once you have paying clients, upgrade to:
- **Twilio official WhatsApp Business API** (client pays ~$15/month)
- **Airtable** for lead storage (visual, clients love it)
- **Calendly API** for real call booking
- **Redis** for session storage (if traffic gets high)
