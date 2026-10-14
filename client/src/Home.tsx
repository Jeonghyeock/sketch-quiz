import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Brush, Timer, WifiOff } from 'lucide-react';
import { randomId } from '../../shared/id.ts';
import { LIMITS } from '../../shared/limits.ts';
import { BrandMark } from './BrandMark.tsx';
import { navigate } from './lib/router.ts';
import { createToken, loadName, saveName } from './lib/storage.ts';

const FEATURES = [
  { Icon: Brush, title: '한 명이 그리고 모두가 맞혀요', text: '차례대로 돌아가며 그림을 그리고, 나머지는 채팅으로 정답을 맞혀요.' },
  { Icon: Timer, title: '빨리 맞힐수록 높은 점수', text: '시간이 지나면 초성과 첫 글자 힌트가 하나씩 열려요.' },
  { Icon: WifiOff, title: '끊겨도 이어서', text: '연결이 끊겨도 20초 안에 돌아오면 점수와 차례가 그대로예요.' },
];

export function Home() {
  const [name, setName] = useState(loadName);

  useEffect(() => {
    document.title = 'Sketch Quiz · 그림 맞히기 게임';
  }, []);

  function createRoom(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    saveName(name);
    const roomId = randomId(10);
    createToken(roomId);
    navigate(`/r/${roomId}`);
  }

  return (
    <main className="home">
      <section className="home-hero">
        <BrandMark size={56} />
        <h1>링크 하나로 바로 하는 그림 맞히기</h1>
        <p>방을 만들고 링크를 보내면 끝. 로그인도 설치도 없어요.</p>
        <form className="name-form" onSubmit={createRoom}>
          <label htmlFor="home-name">닉네임</label>
          <div className="name-row">
            <input
              id="home-name"
              value={name}
              maxLength={LIMITS.maxNameLength}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
            />
            <button type="submit" className="button primary large" disabled={!name.trim()}>
              방 만들기
              <ArrowRight size={18} />
            </button>
          </div>
        </form>
      </section>

      <section className="home-features">
        {FEATURES.map(({ Icon, title, text }) => (
          <div key={title} className="feature">
            <Icon size={20} />
            <strong>{title}</strong>
            <span>{text}</span>
          </div>
        ))}
      </section>
    </main>
  );
}
