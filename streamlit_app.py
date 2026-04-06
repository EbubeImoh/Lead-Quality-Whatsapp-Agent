import streamlit as st
import requests
import time
from datetime import datetime

API_BASE = "http://localhost:3000"

st.set_page_config(page_title="Coach Clara - Lead Qualifier", layout="wide", page_icon="💬")

if "messages" not in st.session_state:
    st.session_state.messages = []

if "pipeline" not in st.session_state:
    st.session_state.pipeline = []

if "lead_data" not in st.session_state:
    st.session_state.lead_data = {}

if "current_thought" not in st.session_state:
    st.session_state.current_thought = ""

def send_message(message):
    try:
        response = requests.post(
            f"{API_BASE}/api/chat",
            json={"message": message, "phone": "streamlit-user"},
            timeout=30
        )
        if response.status_code == 200:
            data = response.json()
            return data
        else:
            st.error(f"Error: {response.status_code}")
            return None
    except requests.exceptions.ConnectionError:
        st.error("Cannot connect to backend. Make sure the Node.js server is running.")
        return None
    except Exception as e:
        st.error(f"Error: {str(e)}")
        return None

def get_step_color(step):
    colors = {
        "received": "#6366f1",
        "extracted": "#8b5cf6",
        "reasoning": "#06b6d4",
        "stored": "#10b981",
        "notified": "#f59e0b"
    }
    return colors.get(step, "#6b7280")

def render_pipeline():
    st.subheader("📊 Pipeline")
    
    if not st.session_state.pipeline:
        st.info("Start chatting to see the pipeline in action!")
        return
    
    for i, step in enumerate(st.session_state.pipeline):
        step_color = get_step_color(step["step"])
        
        with st.container():
            col1, col2 = st.columns([1, 4])
            with col1:
                st.markdown(
                    f"""
                    <div style="
                        background-color: {step_color};
                        color: white;
                        padding: 8px 12px;
                        border-radius: 20px;
                        text-align: center;
                        font-weight: bold;
                        font-size: 12px;
                    ">
                        {step["label"]}
                    </div>
                    """,
                    unsafe_allow_html=True
                )
            with col2:
                if "details" in step and step["details"]:
                    details_str = str(step["details"])[:100]
                    st.caption(details_str)
                else:
                    st.caption("✓ Completed")
            
            if i < len(st.session_state.pipeline) - 1:
                st.markdown(
                    "<div style='padding-left: 15px; border-left: 2px solid #e5e7eb; margin: 5px 0;'>",
                    unsafe_allow_html=True
                )

def render_lead_data():
    st.subheader("👤 Lead Data")
    
    if not st.session_state.lead_data:
        st.info("No lead data collected yet")
        return
    
    col1, col2 = st.columns(2)
    with col1:
        st.metric("Name", st.session_state.lead_data.get("name", "—"))
    with col2:
        st.metric("Status", st.session_state.lead_data.get("status", "New"))
    
    with st.expander("Full Details"):
        st.json(st.session_state.lead_data)

col1, col2 = st.columns([2, 1], gap="large")

with col1:
    st.title("💬 Coach Clara")
    st.caption("AI Lead Qualifier - WhatsApp Agent")
    
    for msg in st.session_state.messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])
    
    user_input = st.chat_input("Type your message...")
    
    if user_input:
        st.session_state.messages.append({"role": "user", "content": user_input})
        with st.chat_message("user"):
            st.markdown(user_input)
        
        with st.spinner("Thinking..."):
            result = send_message(user_input)
        
        if result:
            st.session_state.current_thought = result.get("reply", "")
            st.session_state.messages.append({"role": "assistant", "content": st.session_state.current_thought})
            st.session_state.pipeline = result.get("pipeline", [])
            st.session_state.lead_data = result.get("lead", {})
            
            with st.chat_message("assistant"):
                st.markdown(st.session_state.current_thought)
            
            if result.get("status") == "lead_captured":
                st.success("🎉 Lead captured and notified!")
        else:
            st.session_state.messages.pop()

with col2:
    st.markdown("### 🤖 Agent Insights")
    
    if st.session_state.current_thought:
        st.info(st.session_state.current_thought)
    
    render_pipeline()
    render_lead_data()

st.markdown("---")
st.caption("Made with Streamlit • Connected to Node.js backend")