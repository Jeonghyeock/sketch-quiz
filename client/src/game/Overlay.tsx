import { useState } from 'react';
import { Play, Trophy } from 'lucide-react';
import type { GameState, Settings, TurnEndReason } from '../../../shared/protocol.ts';
import type { GameClient } from './GameClient.ts';

type Props = { game: GameState; playerId: string; client: GameClient };

const TURN_END_TITLE: Record<TurnEndReason, string> = {
  timeout: '시간 종료!',
  allSolved: '모두 맞혔어요!',
  drawerLeft: '그리는 사람이 나갔어요',
};

// 그리기 단계가 아닐 때 캔버스 위에 띄우는 안내(대기실, 단어 고르기, 턴 결과, 최종 순위)
export function Overlay({ game, playerId, client }: Props) {
  const { phase } = game;
  const isHost = game.hostId === playerId;
  const nameOf = (id: string) => game.players.find((p) => p.id === id)?.name ?? '나간 사람';

  switch (phase.kind) {
    case 'drawing':
      return null;

    case 'lobby':
      return (
        <div className="overlay">
          <div className="overlay-card">
            <h2>대기실</h2>
            <p className="muted">{game.players.length}명이 모였어요. 초대 링크로 친구를 불러 보세요.</p>
            {isHost ? (
              <HostControls game={game} client={client} label="게임 시작" />
            ) : (
              <p className="waiting">방장이 게임을 시작하기를 기다리고 있어요</p>
            )}
          </div>
        </div>
      );

    case 'choosing':
      return (
        <div className="overlay">
          <div className="overlay-card">
            {phase.choices ? (
              <>
                <h2>그릴 단어를 골라 주세요</h2>
                <div className="choices">
                  {phase.choices.map((word, index) => (
                    <button key={word} type="button" className="choice" onClick={() => client.choose(index)}>
                      {word}
                    </button>
                  ))}
                </div>
                <p className="muted">시간 안에 고르지 않으면 자동으로 정해져요</p>
              </>
            ) : (
              <>
                <h2>{nameOf(phase.drawerId)}님이 단어를 고르고 있어요</h2>
                <p className="muted">곧 그림이 시작돼요</p>
              </>
            )}
          </div>
        </div>
      );

    case 'turnEnd': {
      const gained = Object.entries(phase.gained).sort(([, a], [, b]) => b - a);
      return (
        <div className="overlay translucent">
          <div className="overlay-card">
            <h2>{TURN_END_TITLE[phase.reason]}</h2>
            {phase.word && (
              <p className="answer">
                정답 <strong>{phase.word}</strong>
              </p>
            )}
            {gained.length > 0 ? (
              <ul className="score-list">
                {gained.map(([id, points]) => (
                  <li key={id}>
                    <span>{nameOf(id)}</span>
                    <b>+{points}</b>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">아무도 맞히지 못했어요</p>
            )}
          </div>
        </div>
      );
    }

    case 'gameEnd': {
      const ranking = [...game.players].sort((a, b) => b.score - a.score);
      return (
        <div className="overlay">
          <div className="overlay-card">
            <h2>
              <Trophy size={22} /> 최종 순위
            </h2>
            <ol className="score-list ranking">
              {ranking.map((player, index) => (
                <li key={player.id} className={index === 0 ? 'winner' : ''}>
                  <span>
                    {index + 1}. {player.name}
                  </span>
                  <b>{player.score}점</b>
                </li>
              ))}
            </ol>
            {isHost ? (
              <HostControls game={game} client={client} label="다시 하기" />
            ) : (
              <p className="waiting">방장이 새 게임을 시작하기를 기다리고 있어요</p>
            )}
          </div>
        </div>
      );
    }
  }
}

const ROUND_OPTIONS = [2, 3, 5];
const SECOND_OPTIONS = [60, 80, 100];

function HostControls({ game, client, label }: { game: GameState; client: GameClient; label: string }) {
  const [settings, setSettings] = useState<Settings>(game.settings);
  const connected = game.players.filter((p) => p.connected).length;
  return (
    <div className="host-controls">
      <Segmented
        label="라운드"
        options={ROUND_OPTIONS}
        value={settings.rounds}
        format={(n) => `${n}판`}
        onChange={(rounds) => setSettings({ ...settings, rounds })}
      />
      <Segmented
        label="그리는 시간"
        options={SECOND_OPTIONS}
        value={settings.drawSeconds}
        format={(n) => `${n}초`}
        onChange={(drawSeconds) => setSettings({ ...settings, drawSeconds })}
      />
      <button
        type="button"
        className="button primary large"
        disabled={connected < 2}
        onClick={() => client.start(settings)}
      >
        <Play size={18} />
        {label}
      </button>
      {connected < 2 && <p className="muted">두 명 이상 모이면 시작할 수 있어요</p>}
    </div>
  );
}

function Segmented({
  label,
  options,
  value,
  format,
  onChange,
}: {
  label: string;
  options: number[];
  value: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="segmented-row">
      <span>{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={value === option}
            className={value === option ? 'active' : ''}
            onClick={() => onChange(option)}
          >
            {format(option)}
          </button>
        ))}
      </div>
    </div>
  );
}
