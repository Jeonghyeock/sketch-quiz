import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight } from 'lucide-react';
import { LIMITS } from '../../../shared/limits.ts';
import { BrandMark } from '../BrandMark.tsx';
import { navigate } from '../lib/router.ts';
import { createToken, forgetToken, loadName, loadToken, saveName } from '../lib/storage.ts';
import { Game } from './Game.tsx';
import { GameClient } from './GameClient.ts';

const socketUrl = () => `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

// 이 탭에 이 방의 토큰이 있으면(방을 만들었거나 새로고침) 바로 들어가고, 없으면(링크로 들어옴) 닉네임부터 묻는다.
export function RoomPage({ roomId }: { roomId: string }) {
  const [token, setToken] = useState(() => loadToken(roomId));
  if (!token) {
    return (
      <JoinForm
        onJoin={(name) => {
          saveName(name);
          setToken(createToken(roomId));
        }}
      />
    );
  }
  return <ConnectedRoom roomId={roomId} token={token} />;
}

function ConnectedRoom({ roomId, token }: { roomId: string; token: string }) {
  const [client, setClient] = useState<GameClient | null>(null);

  useEffect(() => {
    document.title = 'Sketch Quiz · 게임 중';
    const next = new GameClient({ url: socketUrl(), roomId, token, name: loadName() });
    setClient(next);
    return () => next.close();
  }, [roomId, token]);

  if (!client) return null;
  return (
    <Game
      client={client}
      onLeave={() => {
        client.leave();
        forgetToken(roomId);
        navigate('/');
      }}
    />
  );
}

function JoinForm({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState(loadName);

  useEffect(() => {
    document.title = 'Sketch Quiz · 초대';
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) onJoin(name.trim());
  }

  return (
    <main className="home">
      <section className="home-hero">
        <BrandMark size={56} />
        <h1>그림 맞히기 방에 초대받았어요</h1>
        <p>닉네임을 정하고 들어가세요.</p>
        <form className="name-form" onSubmit={submit}>
          <label htmlFor="join-name">닉네임</label>
          <div className="name-row">
            <input
              id="join-name"
              value={name}
              maxLength={LIMITS.maxNameLength}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" className="button primary large" disabled={!name.trim()}>
              입장하기
              <ArrowRight size={18} />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
