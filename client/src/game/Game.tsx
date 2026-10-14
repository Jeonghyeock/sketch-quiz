import { useEffect, useState, useSyncExternalStore } from 'react';
import { Link2, LogOut } from 'lucide-react';
import { BrandMark } from '../BrandMark.tsx';
import { navigate } from '../lib/router.ts';
import { Chat } from './Chat.tsx';
import { DrawingCanvas } from './DrawingCanvas.tsx';
import type { GameClient } from './GameClient.ts';
import { Overlay } from './Overlay.tsx';
import { PlayerList } from './PlayerList.tsx';
import { Toolbar, type Tool } from './Toolbar.tsx';
import { WordBar } from './WordBar.tsx';

const ERASER_COLOR = '#ffffff'; // 캔버스 배경색. 지우개는 배경색으로 그리는 획이다.

const STATUS_LABEL = { connecting: '연결 중', online: '연결됨', offline: '연결 끊김', closed: '연결 종료' } as const;

export function Game({ client, onLeave }: { client: GameClient; onLeave: () => void }) {
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const [tool, setTool] = useState<Tool>({ color: '#1f2328', width: 4, eraser: false });
  const [toast, setToast] = useState<string | null>(null);
  const { game, playerId, status } = state;

  const phase = game?.phase;
  const canDraw = phase?.kind === 'drawing' && phase.drawerId === playerId && status === 'online';

  // 한글 입력 상태에서는 key가 'ㅋ'로 들어오므로 물리 키(code)를 본다.
  useEffect(() => {
    if (!canDraw) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ' && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        client.undo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canDraw, client]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setToast('초대 링크를 복사했어요');
    } catch {
      // 클립보드 API는 https나 localhost에서만 동작한다.
      window.prompt('이 링크를 복사해서 보내 주세요', window.location.href);
    }
  }

  if (status === 'closed') {
    return (
      <main className="home">
        <section className="home-hero">
          <h1>연결을 끝냈어요</h1>
          <p>{state.closedReason}</p>
          <button type="button" className="button primary large" onClick={() => navigate('/')}>
            처음으로
          </button>
        </section>
      </main>
    );
  }

  if (!game || !playerId || !phase) {
    return <div className="loading">{status === 'offline' ? '서버에 다시 연결하는 중이에요' : '방에 들어가는 중이에요'}</div>;
  }

  const inGame = phase.kind === 'choosing' || phase.kind === 'drawing' || phase.kind === 'turnEnd';

  return (
    <div className="game">
      <header className="game-header panel">
        <div className="brand">
          <BrandMark size={26} />
          <span>Sketch Quiz</span>
        </div>
        {inGame && (
          <span className="round">
            라운드 {game.round} / {game.settings.rounds}
          </span>
        )}
        <div className="header-actions">
          <span className={`status status-${status}`}>
            <span className="status-dot" />
            {STATUS_LABEL[status]}
          </span>
          <button type="button" className="button" onClick={copyLink}>
            <Link2 size={16} />
            초대 링크
          </button>
          <button type="button" className="button" onClick={onLeave}>
            <LogOut size={16} />
            나가기
          </button>
        </div>
      </header>

      <aside className="players panel">
        <PlayerList game={game} playerId={playerId} />
      </aside>

      <main className="stage">
        <WordBar game={game} playerId={playerId} deadline={state.deadline} />
        <div className="canvas-area">
          <div className="canvas-frame">
            <DrawingCanvas
              client={client}
              canDraw={canDraw}
              color={tool.eraser ? ERASER_COLOR : tool.color}
              width={tool.eraser ? Math.min(60, tool.width * 3) : tool.width}
            />
            <Overlay game={game} playerId={playerId} client={client} />
          </div>
        </div>
        <div className="toolbar-slot">
          {canDraw ? (
            <Toolbar tool={tool} onChange={setTool} client={client} />
          ) : (
            phase.kind === 'drawing' && <span className="muted">그림을 보고 채팅으로 정답을 입력하세요</span>
          )}
        </div>
      </main>

      <aside className="chat panel">
        <Chat client={client} entries={state.chat} game={game} playerId={playerId} online={status === 'online'} />
      </aside>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
