import { RoomPage } from './game/RoomPage.tsx';
import { Home } from './Home.tsx';
import { navigate, usePathname } from './lib/router.ts';

export function App() {
  const pathname = usePathname();
  const match = /^\/r\/([^/]+)\/?$/.exec(pathname);
  if (!match) return <Home />;

  const roomId = match[1]!;
  if (!/^[A-Za-z0-9]{6,40}$/.test(roomId)) {
    return (
      <main className="home">
        <section className="home-hero">
          <h1>방 주소가 올바르지 않아요</h1>
          <button type="button" className="button primary large" onClick={() => navigate('/')}>
            처음으로
          </button>
        </section>
      </main>
    );
  }
  // key: 다른 방으로 이동하면 상태를 처음부터 새로 만든다.
  return <RoomPage key={roomId} roomId={roomId} />;
}
