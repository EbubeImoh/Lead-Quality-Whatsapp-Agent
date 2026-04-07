import streamlit as st
import requests
import json
import pandas as pd
import uuid
from datetime import datetime

API_BASE = st.secrets.get("API_BASE", "http://localhost:3000")

st.set_page_config(page_title="Coach Clara - Lead Qualifier", layout="wide", page_icon="💬")

# Initialize session state
if "session_id" not in st.session_state:
    st.session_state.session_id = str(uuid.uuid4())
if "credits_remaining" not in st.session_state:
    st.session_state.credits_remaining = 5
if "messages" not in st.session_state:
    st.session_state.messages = []
if "pipeline" not in st.session_state:
    st.session_state.pipeline = []
if "lead_data" not in st.session_state:
    st.session_state.lead_data = {}
if "stage" not in st.session_state:
    st.session_state.stage = "Initial Contact"
if "confidence" not in st.session_state:
    st.session_state.confidence = "0.00"
if "reasoning" not in st.session_state:
    st.session_state.reasoning = ""
if "debug" not in st.session_state:
    st.session_state.debug = False
if "initialized" not in st.session_state:
    st.session_state.initialized = False

def sync_with_backend():
    try:
        # Fetch session state
        resp = requests.get(f"{API_BASE}/api/session/{st.session_state.session_id}", timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            st.session_state.lead_data = data.get("lead", {})
            st.session_state.stage = data.get("stage", "Initial Contact")
            db_history = data.get("history", [])
            if db_history and not st.session_state.messages:
                st.session_state.messages = db_history
        
        # Fetch credits
        c_resp = requests.get(f"{API_BASE}/api/credits/{st.session_state.session_id}", timeout=5)
        if c_resp.status_code == 200:
            st.session_state.credits_remaining = c_resp.json().get("remaining", 5)
    except:
        pass

if not st.session_state.initialized:
    sync_with_backend()
    st.session_state.initialized = True

# Custom CSS
st.markdown("""
<style>
    /* Default Light Mode Styles */
    .stApp {
        background-color: #ffffff;
        color: #1e293b;
    }
    
    .credit-counter {
        position: fixed;
        top: 70px;
        right: 20px;
        background: #ffffff;
        color: #1e293b;
        padding: 8px 16px;
        border-radius: 20px;
        font-weight: 700;
        font-size: 0.85rem;
        z-index: 1000;
        border: 2px solid #3b82f6;
        box-shadow: 0 4px 12px rgba(59, 130, 246, 0.1);
    }
    
    .stChatMessage { 
        background-color: #f8fafc !important;
        border: 1px solid #e2e8f0;
        border-radius: 15px; 
        padding: 15px; 
        margin-bottom: 10px; 
    }
    
    .insight-card { 
        background: #ffffff; 
        border-radius: 12px; 
        padding: 20px; 
        margin-bottom: 20px; 
        border: 1px solid #e2e8f0; 
        color: #1e293b;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    
    .section-header { 
        font-size: 0.85rem; 
        font-weight: 700; 
        color: #64748b; 
        text-transform: uppercase; 
        letter-spacing: 0.05em; 
        margin-bottom: 12px; 
        display: flex; 
        align-items: center; 
    }
    
    .entity-tag { 
        display: inline-block; 
        padding: 4px 12px; 
        border-radius: 6px; 
        font-size: 0.85rem; 
        margin-right: 8px; 
        margin-bottom: 8px; 
        background: #f1f5f9; 
        border: 1px solid #e2e8f0; 
        color: #475569;
    }
    
    .entity-label { 
        font-weight: 600; 
        color: #3b82f6; 
        margin-right: 4px; 
    }
    
    .stage-badge { 
        background: #dbeafe; 
        color: #1e40af; 
        padding: 4px 12px; 
        border-radius: 20px; 
        font-weight: 600; 
        font-size: 0.8rem; 
    }
    
    .confidence-meter { 
        height: 8px; 
        background: #f1f5f9; 
        border-radius: 4px; 
        margin-top: 8px; 
        overflow: hidden; 
    }
    
    .confidence-fill { 
        height: 100%; 
        background: linear-gradient(90deg, #3b82f6, #2563eb); 
        border-radius: 4px; 
        transition: width 0.5s ease-in-out; 
    }
    
    .pipeline-item { 
        border-left: 2px solid #e2e8f0; 
        padding-left: 15px; 
        padding-bottom: 15px; 
        position: relative; 
    }
    
    .pipeline-item::before { 
        content: ''; 
        position: absolute; 
        left: -5px; 
        top: 0; 
        width: 8px; 
        height: 8px; 
        border-radius: 50%; 
        background: #3b82f6; 
    }

    /* Dark Mode Overrides */
    @media (prefers-color-scheme: dark) {
        .stApp {
            background-color: #000000;
            color: #e2e8f0;
        }
        .credit-counter {
            background: #111111;
            color: #ffffff;
            box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }
        .stChatMessage { 
            background-color: #111111 !important;
            border: 1px solid #222222;
        }
        .insight-card { 
            background: #111111; 
            border: 1px solid #222222; 
            color: #ffffff;
        }
        .section-header { color: #94a3b8; }
        .entity-tag { 
            background: #1e293b; 
            border: 1px solid #334155; 
            color: #cbd5e1;
        }
        .stage-badge { 
            background: #1e3a8a; 
            color: #bfdbfe; 
        }
        .confidence-meter { background: #1e293b; }
        .pipeline-item { border-left: 2px solid #334155; }
        
        h1, h2, h3, p, span, label {
            color: #f1f5f9 !important;
        }
    }

    .scroll-container { 
        max-height: 300px; 
        overflow-y: auto; 
        padding-right: 10px; 
    }
</style>
""", unsafe_allow_html=True)

# Render Credit Counter at top right
st.markdown(f'<div class="credit-counter">🔋 Daily Credits: {st.session_state.credits_remaining} / 5</div>', unsafe_allow_html=True)

def send_message(message):
    try:
        response = requests.post(
            f"{API_BASE}/api/chat",
            json={"message": message, "phone": st.session_state.session_id},
            timeout=30
        )
        # Update credits from JSON body first, then headers
        data = None
        if response.status_code in [200, 429]:
            data = response.json()
            if data.get("remaining") is not None:
                st.session_state.credits_remaining = data["remaining"]
            else:
                rem = response.headers.get("X-RateLimit-Remaining")
                if rem is not None:
                    st.session_state.credits_remaining = int(rem)
            return data
        else:
            st.error(f"Error: {response.status_code}")
            return None
    except Exception as e:
        st.error(f"Error: {str(e)}")
        return None

def get_leads():
    try:
        response = requests.get(f"{API_BASE}/api/leads", timeout=5)
        if response.status_code == 200:
            return response.json()
        return []
    except:
        return []

# --- UI Layout ---
st.title("🏃 Coach Clara Admin")

tab1, tab2 = st.tabs(["💬 Live Agent", "📊 Lead Database"])

with tab1:
    col_chat, col_insights = st.columns([1.8, 1], gap="large")

    with col_chat:
        st.subheader("Live Chat")
        chat_placeholder = st.container(height=500)
        with chat_placeholder:
            if not st.session_state.messages:
                st.info("Start a conversation to see the agent in action.")
            for msg in st.session_state.messages:
                with st.chat_message(msg["role"]):
                    st.markdown(msg["content"])

        user_input = st.chat_input("Message Coach Clara...")
        if user_input:
            if st.session_state.credits_remaining <= 0:
                st.error("Daily credits exhausted. Contact ebubeimoh@gmail.com for a custom system! 😉")
            else:
                st.session_state.messages.append({"role": "user", "content": user_input})
                # Local countdown for realtime feel
                st.session_state.credits_remaining -= 1
                
                with st.spinner("Agent processing..."):
                    result = send_message(user_input)
                if result:
                    st.session_state.messages.append({"role": "assistant", "content": result["reply"]})
                st.session_state.pipeline = result.get("pipeline", [])
                st.session_state.lead_data = result.get("lead", {})
                st.session_state.stage = result.get("stage", "Ongoing")
                st.session_state.confidence = result.get("confidence", "0.00")
                st.session_state.reasoning = result.get("reasoning", "")
                if result.get("status") == "lead_captured":
                    st.toast("Lead Captured!", icon="🎉")
                st.rerun()

    with col_insights:
        st.subheader("Agent Insights")
        
        # Live Reasoning
        st.markdown(f"""
        <div class="insight-card">
            <div class="section-header">🧠 Live Reasoning</div>
            <p style="font-size: 0.9rem; color: #334155; font-style: italic;">"{st.session_state.reasoning or 'Waiting for input...'}"</p>
            <div style="margin-top: 15px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.75rem; font-weight: 600;">
                    <span>CONFIDENCE</span>
                    <span>{float(st.session_state.confidence)*100:.0f}%</span>
                </div>
                <div class="confidence-meter">
                    <div class="confidence-fill" style="width: {float(st.session_state.confidence)*100}%"></div>
                </div>
            </div>
        </div>
        """, unsafe_allow_html=True)

        # Conversation State
        st.markdown(f"""
        <div class="insight-card">
            <div class="section-header">📍 Conversation Stage</div>
            <span class="stage-badge">{st.session_state.stage}</span>
            <div style="margin-top: 15px;">
                <div class="section-header" style="font-size: 0.7rem;">EXTRACTED ENTITIES</div>
                <div class="entity-tag"><span class="entity-label">Name:</span> {st.session_state.lead_data.get('name', '—')}</div>
                <div class="entity-tag"><span class="entity-label">Email:</span> {st.session_state.lead_data.get('email', '—')}</div>
                <div class="entity-tag"><span class="entity-label">Challenge:</span> {"Captured" if st.session_state.lead_data.get('challenge') else '—'}</div>
            </div>
        </div>
        """, unsafe_allow_html=True)

        # Activity Log (Scrollable)
        st.markdown('<div class="section-header">🔄 Activity Log</div>', unsafe_allow_html=True)
        with st.container(height=300):
            if not st.session_state.pipeline:
                st.write("No activity yet.")
            for step in reversed(st.session_state.pipeline):
                st.markdown(f"""
                <div class="pipeline-item">
                    <span style="font-size: 0.7rem; color: #94a3b8;">{step['timestamp'].split('T')[1][:8]}</span><br/>
                    <b>{step['label']}</b><br/>
                    <span style="font-size: 0.8rem; color: #64748b;">{json.dumps(step['details']) if step.get('details') else ''}</span>
                </div>
                """, unsafe_allow_html=True)

with tab2:
    st.subheader("Captured Leads (SQLite)")
    if st.button("🔄 Refresh Database"):
        leads = get_leads()
        if leads:
            df = pd.DataFrame(leads)
            st.dataframe(df, use_container_width=True)
            
            csv = df.to_csv(index=False).encode('utf-8')
            st.download_button("📥 Export CSV", csv, "leads.csv", "text/csv")
        else:
            st.info("No leads found in database.")
    else:
        leads = get_leads()
        if leads:
            st.dataframe(pd.DataFrame(leads), use_container_width=True)

if st.session_state.debug:
    st.divider()
    st.json(st.session_state.to_dict())
