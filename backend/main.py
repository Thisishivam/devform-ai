# backend/main.py
from fastapi import FastAPI, HTTPException, Depends
from fastapi.security import HTTPBearer
from pydantic import BaseModel
import requests
import os
from supabase import create_client, Client
import stripe
from datetime import datetime, timedelta
import json
from typing import Optional

app = FastAPI()
security = HTTPBearer()

# Initialize Supabase
supabase: Client = create_client(
    os.getenv('SUPABASE_URL'),
    os.getenv('SUPABASE_KEY')
)

# DeepSeek API
DEEPSEEK_API_KEY = os.getenv('DEEPSEEK_API_KEY')
DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

class GenerateRequest(BaseModel):
    messages: list
    max_tokens: int = 8000
    temperature: float = 0.3
    stream: bool = False

class CreditRequest(BaseModel):
    user_id: str
    credits_used: int

# Helper: Get user from token
async def get_user_from_token(token: str):
    try:
        # Query Supabase for user with this token
        response = supabase.table('users')\
            .select('*')\
            .eq('api_token', token)\
            .execute()
        
        if response.data and len(response.data) > 0:
            return response.data[0]
        return None
    except:
        return None

# Helper: Check credits
async def check_user_credits(user_id: str, credits_needed: int = 1):
    try:
        # Get user
        response = supabase.table('users')\
            .select('credits, tier')\
            .eq('id', user_id)\
            .execute()
        
        if not response.data:
            return False, "User not found"
        
        user = response.data[0]
        
        # Free tier: Check daily limit
        if user['tier'] == 'free':
            today = datetime.now().strftime('%Y-%m-%d')
            # Check today's usage
            usage_resp = supabase.table('generations')\
                .select('credits_used', count='exact')\
                .eq('user_id', user_id)\
                .gte('created_at', today)\
                .execute()
            
            today_usage = sum([r['credits_used'] for r in usage_resp.data]) if usage_resp.data else 0
            
            # Free tier: Max 100 credits/day
            if today_usage + credits_needed > 100:
                return False, "Daily limit exceeded. Upgrade to Pro."
        
        # Check total credits
        if user['credits'] < credits_needed:
            return False, "Insufficient credits"
            
        return True, "OK"
        
    except Exception as e:
        return False, f"Error: {str(e)}"

@app.post("/generate")
async def generate_code(request: GenerateRequest, token: str = Depends(security)):
    # 1. Validate user
    user = await get_user_from_token(token.credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid API token")
    
    # 2. Estimate credits needed (1 credit per 100 tokens)
    estimated_tokens = sum(len(msg['content']) for msg in request.messages) // 4
    credits_needed = max(1, estimated_tokens // 100)
    
    # 3. Check credits
    can_proceed, message = await check_user_credits(user['id'], credits_needed)
    if not can_proceed:
        raise HTTPException(status_code=402, detail=message)
    
    # 4. Call DeepSeek API
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}"
    }
    
    try:
        deepseek_response = requests.post(
            DEEPSEEK_URL,
            headers=headers,
            json={
                "model": "deepseek-coder",
                "messages": request.messages,
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                "stream": request.stream
            },
            timeout=60
        )
        
        if deepseek_response.status_code != 200:
            raise HTTPException(status_code=500, detail="AI service error")
        
        result = deepseek_response.json()
        content = result['choices'][0]['message']['content']
        
        # 5. Deduct credits
        supabase.table('users')\
            .update({'credits': user['credits'] - credits_needed})\
            .eq('id', user['id'])\
            .execute()
        
        # 6. Log generation
        supabase.table('generations').insert({
            'user_id': user['id'],
            'prompt': json.dumps(request.messages[-1]) if request.messages else '',
            'credits_used': credits_needed
        }).execute()
        
        return {
            "content": content,
            "credits_used": credits_needed,
            "remaining_credits": user['credits'] - credits_needed
        }
        
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Request timeout")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/user/status")
async def user_status(token: str = Depends(security)):
    user = await get_user_from_token(token.credentials)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid token")
    
    # Get today's usage
    today = datetime.now().strftime('%Y-%m-%d')
    usage_resp = supabase.table('generations')\
        .select('credits_used')\
        .eq('user_id', user['id'])\
        .gte('created_at', today)\
        .execute()
    
    today_usage = sum([r['credits_used'] for r in usage_resp.data]) if usage_resp.data else 0
    
    return {
        "email": user['email'],
        "tier": user['tier'],
        "credits": user['credits'],
        "today_usage": today_usage,
        "api_token": user['api_token']
    }

@app.post("/user/create")
async def create_user(email: str):
    # Check if user exists
    existing = supabase.table('users')\
        .select('*')\
        .eq('email', email)\
        .execute()
    
    if existing.data:
        return {"error": "User already exists"}
    
    # Create new user
    import uuid
    api_token = str(uuid.uuid4())
    
    new_user = {
        'email': email,
        'api_token': api_token,
        'tier': 'free',
        'credits': 100
    }
    
    response = supabase.table('users').insert(new_user).execute()
    
    return {
        "message": "User created",
        "api_token": api_token,
        "tier": "free",
        "credits": 100
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=10000)