import { useEffect, useState } from 'react';
import { Check, Timer } from 'lucide-react';
import type { GameState } from '../../../shared/protocol.ts';

type Props = { game: GameState; playerId: string; deadline: number | null };

// 캔버스 위 한 줄: 남은 시간 + 지금 단계에서 내가 알아야 할 것(제시어 또는 힌트)
export function WordBar({ game, playerId, deadline }: Props) {
  const { phase } = game;
  const drawer = 'drawerId' in phase ? game.players.find((p) => p.id === phase.drawerId) : undefined;

  let content;
  switch (phase.kind) {
    case 'lobby':
      content = <span className="muted">대기실 · 초대 링크를 보내 친구를 불러 보세요</span>;
      break;
    case 'choosing':
      content = phase.choices ? (
        <span>그릴 단어를 고르세요</span>
      ) : (
        <span>
          <b>{drawer?.name}</b>님이 단어를 고르고 있어요
        </span>
      );
      break;
    case 'drawing':
      if (phase.drawerId === playerId) {
        content = (
          <span>
            그릴 단어{' '}
            <strong className="word" data-testid="word">
              {phase.word}
            </strong>
          </span>
        );
      } else if (phase.word) {
        content = (
          <span className="solved-word">
            <Check size={18} /> 정답 <strong className="word">{phase.word}</strong>
          </span>
        );
      } else {
        content = <Hint hint={phase.hint} />;
      }
      break;
    case 'turnEnd':
      content = phase.word ? (
        <span>
          정답은 <strong className="word">{phase.word}</strong>
        </span>
      ) : (
        <span>그리는 사람이 나갔어요</span>
      );
      break;
    case 'gameEnd':
      content = <span>게임 끝!</span>;
      break;
  }

  const counting = phase.kind === 'choosing' || phase.kind === 'drawing' || phase.kind === 'turnEnd';
  return (
    <div className="wordbar panel">
      <Countdown deadline={counting ? deadline : null} />
      <div className="wordbar-main">{content}</div>
    </div>
  );
}

// ○는 아직 가려진 글자다. 칸으로 보여 주고 글자 수를 함께 적는다.
function Hint({ hint }: { hint: string }) {
  const chars = [...hint];
  const length = chars.filter((c) => c !== ' ').length;
  return (
    <span className="hint" data-testid="hint" aria-label={`힌트: ${hint.replaceAll('○', '?')}, ${length}글자`}>
      {chars.map((char, i) =>
        char === ' ' ? (
          <span key={i} className="hint-gap" />
        ) : (
          <span key={i} className="hint-char">
            {char === '○' ? '' : char}
          </span>
        ),
      )}
      <small>{length}글자</small>
    </span>
  );
}

function Countdown({ deadline }: { deadline: number | null }) {
  // 0.25초마다 다시 그리기만 하고, 남은 시간은 그릴 때의 현재 시각으로 계산한다.
  // 시각을 상태로 들고 있으면 마감 시각이 바뀐 직후 한 번은 옛 시각으로 계산돼 1초 많게 보인다.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 250);
    return () => clearInterval(timer);
  }, [deadline]);

  if (deadline === null) {
    return (
      <span className="countdown idle">
        <Timer size={16} />-
      </span>
    );
  }
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return (
    <span className={`countdown${seconds <= 10 ? ' urgent' : ''}`} aria-label={`남은 시간 ${seconds}초`}>
      <Timer size={16} />
      {seconds}
    </span>
  );
}
