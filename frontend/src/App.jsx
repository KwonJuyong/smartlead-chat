import { useEffect, useRef, useState } from "react";

const API = "http://127.0.0.1:8000";
const toAbs = (u) => (u && !/^https?:\/\//i.test(u) ? `${API}${u}` : u);

export default function App() {
  const [roomId, setRoomId] = useState("demo");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("Chat");
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const wsRef = useRef(null);

  // URL의 ?room=...&invite=... 자동 인식
  useEffect(() => {
    const url = new URL(window.location.href);
    const r = url.searchParams.get("room");
    const inv = url.searchParams.get("invite");
    if (r) setRoomId(r);
    if (inv) setInviteToken(inv);
  }, []);

  // 과거 메시지 불러오기
  const loadHistory = async (rid) => {
    try {
      const r = await fetch(`${API}/messages/${rid}`);
      const data = await r.json();
      setMessages(data);
    } catch {}
  };

  // 서버(WebSocket) 연결
  const connect = async () => {
    if (!roomId || !name) return;
    await loadHistory(roomId);
    const ws = new WebSocket(`ws://127.0.0.1:8000/ws/${roomId}`);
    ws.onopen = () => setConnected(true);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        setMessages((prev) => [...prev, m]);
      } catch {
        setMessages((prev) => [...prev, { name: "unknown", text: e.data }]);
      }
    };
    ws.onclose = () => setConnected(false);
    wsRef.current = ws;
  };

  // 텍스트 전송
  const send = () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    if (!text.trim()) return;
    const payload = JSON.stringify({ name, text, ts: Date.now() });
    wsRef.current.send(payload);
    setText("");
  };

  // 파일 업로드 → 업로드 URL을 메시지로 발송
  const onUpload = async (file) => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch(`${API}/upload`, { method: "POST", body: fd });
    const d = await r.json();
    if (wsRef.current && wsRef.current.readyState === 1) {
      wsRef.current.send(JSON.stringify({ name, attachment_url: d.url }));
    }
  };

  // 1:1 방 만들기 + 초대 링크 복사
  const createRoom = async () => {
    if (!name) return alert("enter your name");
    const r = await fetch(`${API}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, creator_name: name }),
    });
    const d = await r.json();
    setRoomId(d.room_id);
    await loadHistory(d.room_id);

    // 백엔드가 돌려준 invite_url에서 토큰을 추출해 프론트용 링크 생성
    const token = new URL(`${API}${d.invite_url}`).searchParams.get("invite") || "";
    const inviteLink = `${location.origin}?room=${d.room_id}&invite=${encodeURIComponent(token)}`;

    try {
      await navigator.clipboard.writeText(inviteLink);
      alert("Invite link copied");
    } catch {
      alert(inviteLink);
    }
  };

  // 초대 링크로 들어온 경우: 이름 입력하면 자동 입장
  useEffect(() => {
    if (inviteToken && name) {
      fetch(`${API}/accept-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken, name }),
      })
        .then((r) => r.json())
        .then(async (d) => {
          if (d.room_id) {
            setRoomId(d.room_id);
            await connect();
          }
        })
        .catch(() => {});
    }
  }, [inviteToken, name]);

  // 파일 타입 판별
  const isImage = (u) => u && /\.(png|jpg|jpeg|gif|webp)$/i.test(u);
  const isVideo = (u) => u && /\.(mp4|webm|ogg)$/i.test(u);

  // Enter로 전송
  useEffect(() => {
    const onEnter = (e) => { if (e.key === "Enter") send(); };
    window.addEventListener("keydown", onEnter);
    return () => window.removeEventListener("keydown", onEnter);
  }, [text]);

  return (
    <div style={{ maxWidth: 780, margin: "24px auto", fontFamily: "system-ui, sans-serif" }}>
      <h2>SmartLead Chat (Local + History + Invite + Upload)</h2>

      {!connected && (
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <input placeholder="Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          <button onClick={connect}>Connect</button>
          <div style={{ height: 8 }} />
          <input placeholder="Room title (create new)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button onClick={createRoom}>Create 1:1 Room + Copy Invite</button>
          {inviteToken && <div style={{ fontSize: 12, opacity: 0.7 }}>Invite detected. Enter your name to join.</div>}
        </div>
      )}

      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12, height: 420, overflow: "auto", background: "#fafafa" }}>
        {messages.map((m, i) => (
          <div key={m.id ?? i} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{m.name}</div>
            {m.text && <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}
            {m.attachment_url && isImage(m.attachment_url) && (
              <img src={toAbs(m.attachment_url)} style={{ maxWidth: "100%", borderRadius: 6 }} />
            )}
            {m.attachment_url && isVideo(m.attachment_url) && (
              <video src={toAbs(m.attachment_url)} controls style={{ maxWidth: "100%", borderRadius: 6 }} />
            )}
            {m.attachment_url && !isImage(m.attachment_url) && !isVideo(m.attachment_url) && (
              <a href={toAbs(m.attachment_url)} target="_blank">Attachment</a>
            )}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
        <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Type and press Enter" />
        <button onClick={send} disabled={!name}>Send</button>
        <input type="file" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
      </div>
    </div>
  );
}
