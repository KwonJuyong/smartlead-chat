import os, secrets, datetime, json
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from jose import jwt, JWTError
from sqlalchemy import create_engine, Column, Integer, String, Text, DateTime
from sqlalchemy.orm import sessionmaker, declarative_base

SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret")
ALGORITHM = "HS256"

app = FastAPI(title="SmartLead Chat")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# ---------- DB ----------
engine = create_engine("sqlite:///./app.db", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Message(Base):
    __tablename__ = "messages"
    id = Column(Integer, primary_key=True)
    room_id = Column(String(128), index=True, nullable=False)
    name = Column(String(255), nullable=False)
    text = Column(Text, nullable=True)
    attachment_url = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow, index=True)

Base.metadata.create_all(bind=engine)

# ---------- 업로드 ----------
os.makedirs("uploads", exist_ok=True)
app.mount("/uploads", StaticFiles(directory="uploads"), name="uploads")

# ---------- 메모리 내 연결(실시간 브로드캐스트 관리) ----------
rooms: Dict[str, Set[WebSocket]] = {}

# ---------- 유틸 ----------
def create_invite_token(room_id: str, minutes: int = 60*24*7):
    payload = {"room_id": room_id, "invite": True, "exp": datetime.datetime.utcnow() + datetime.timedelta(minutes=minutes)}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def decode_invite_token(token: str):
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])

# ---------- 핑 ----------
@app.get("/ping")
def ping():
    return {"ok": True}

# ---------- 과거 메시지 로드 ----------
@app.get("/messages/{room_id}")
def list_messages(room_id: str):
    s = SessionLocal()
    rows = s.query(Message).filter(Message.room_id == room_id).order_by(Message.id.asc()).limit(500).all()
    out = [{"id": r.id, "name": r.name, "text": r.text, "attachment_url": r.attachment_url, "created_at": r.created_at.isoformat()} for r in rows]
    s.close()
    return out

# ---------- 파일 업로드 ----------
@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    fname = secrets.token_hex(8) + "_" + file.filename
    path = os.path.join("uploads", fname)
    content = await file.read()
    with open(path, "wb") as f:
        f.write(content)
    url = f"/uploads/{fname}"
    return {"url": url}

# ---------- 방 생성 + 초대 링크 발급 ----------
@app.post("/rooms")
def create_room(title: str = Body(...), creator_name: str = Body(...)):
    room_id = secrets.token_urlsafe(8)
    token = create_invite_token(room_id)
    invite_url = f"/accept?room={room_id}&invite={token}"
    return {"room_id": room_id, "invite_url": invite_url, "title": title, "creator": creator_name}

# ---------- 초대 수락(토큰 검증) ----------
@app.post("/accept-invite")
def accept_invite(token: str = Body(...), name: str = Body(...)):
    try:
        data = decode_invite_token(token)
    except JWTError:
        raise HTTPException(status_code=401, detail="invalid token")
    if not data.get("invite") or "room_id" not in data:
        raise HTTPException(status_code=400, detail="bad token")
    return {"room_id": data["room_id"], "name": name}

# ---------- WebSocket ----------
@app.websocket("/ws/{room_id}")
async def ws_endpoint(ws: WebSocket, room_id: str):
    await ws.accept()
    if room_id not in rooms:
        rooms[room_id] = set()
    rooms[room_id].add(ws)
    try:
        while True:
            data = await ws.receive_text()
            try:
                payload = json.loads(data)
            except:
                payload = {"name": "unknown", "text": data}
            name = str(payload.get("name") or "unknown")
            text = str(payload.get("text") or "")
            attachment_url = str(payload.get("attachment_url") or "") or None

            s = SessionLocal()
            msg = Message(room_id=room_id, name=name, text=text, attachment_url=attachment_url)
            s.add(msg); s.commit()
            out = {"id": msg.id, "name": msg.name, "text": msg.text, "attachment_url": msg.attachment_url, "created_at": msg.created_at.isoformat()}
            s.close()

            dead = []
            for peer in list(rooms[room_id]):
                try:
                    await peer.send_text(json.dumps(out))
                except:
                    dead.append(peer)
            for d in dead:
                try:
                    rooms[room_id].remove(d)
                except:
                    pass
    except WebSocketDisconnect:
        rooms[room_id].discard(ws)
        if not rooms[room_id]:
            del rooms[room_id]
# ---------- (맨 마지막) 프론트 정적 서빙 ----------
# 절대경로로 안전하게(frontend/dist를 FastAPI가 그대로 서빙)
import pathlib

BASE_DIR = pathlib.Path(__file__).resolve().parent
DIST_DIR = BASE_DIR / "frontend" / "dist"

if DIST_DIR.exists():
    # 이미 위에서 StaticFiles를 import 했으므로 재import 불필요
    app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="frontend")
else:
    print(f"[WARN] frontend/dist not found at: {DIST_DIR}")

