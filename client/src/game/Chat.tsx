import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Send } from 'lucide-react';
import { LIMITS } from '../../../shared/limits.ts';
import type { ChatEntry, GameState } from '../../../shared/protocol.ts';
import type { GameClient } from './GameClient.ts';

type Props = { client: GameClient; entries: ChatEntry[]; game: GameState; playerId: string; online: boolean };

export function Chat({ client, entries, game, playerId, online }: Props) {
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // 맨 아래를 보고 있을 때만 새 메시지를 따라 내려간다. 위로 올려 읽는 중이면 그대로 둔다.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && atBottom.current) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const { phase } = game;
  const knowsWord = phase.kind === 'drawing' && (phase.drawerId === playerId || phase.word !== null);
  const placeholder =
    phase.kind !== 'drawing' ? '메시지를 입력하세요' : knowsWord ? '정답을 아는 사람끼리만 보여요' : '정답을 입력해 보세요';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (client.sendChat(text)) setText('');
  }

  return (
    <>
      <h2 className="panel-title">채팅</h2>
      <div
        ref={listRef}
        className="chat-list"
        aria-live="polite"
        onScroll={(e) => {
          const list = e.currentTarget;
          atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        }}
      >
        {entries.map((entry) =>
          entry.kind === 'system' ? (
            <div key={entry.id} className={`chat-system tone-${entry.tone}`}>
              {entry.text}
            </div>
          ) : (
            <div key={entry.id} className={`chat-line${entry.solvedOnly ? ' solved-only' : ''}`}>
              <b style={{ color: entry.color }}>{entry.name}</b> {entry.text}
            </div>
          ),
        )}
      </div>
      <form className={`chat-form${knowsWord ? ' solved-only' : ''}`} onSubmit={submit}>
        <input
          value={text}
          maxLength={LIMITS.maxChatLength}
          placeholder={online ? placeholder : '다시 연결하는 중이에요'}
          disabled={!online}
          onChange={(e) => setText(e.target.value)}
          aria-label="채팅 입력"
        />
        <button type="submit" className="icon-button" aria-label="보내기" disabled={!online || !text.trim()}>
          <Send size={16} />
        </button>
      </form>
    </>
  );
}
