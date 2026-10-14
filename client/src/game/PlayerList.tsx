import { Check, Crown, Pencil } from 'lucide-react';
import { LIMITS } from '../../../shared/limits.ts';
import type { GameState } from '../../../shared/protocol.ts';

// 들어온 순서 = 그리는 순서로 보여 준다.
export function PlayerList({ game, playerId }: { game: GameState; playerId: string }) {
  const { phase } = game;
  const drawerId = 'drawerId' in phase ? phase.drawerId : null;
  return (
    <>
      <h2 className="panel-title">
        참가자
        <span>
          {game.players.length}/{LIMITS.maxPlayersPerRoom}
        </span>
      </h2>
      <ul className="player-list">
        {game.players.map((player) => (
          <li
            key={player.id}
            className={`player${player.connected ? '' : ' disconnected'}${player.solved ? ' solved' : ''}`}
            data-testid="player"
          >
            <span className="avatar" style={{ background: player.color }}>
              {[...player.name][0]}
            </span>
            <span className="player-info">
              <span className="player-name">
                {player.name}
                {player.id === playerId && <span className="me-tag">나</span>}
              </span>
              <span className="player-sub">
                <span data-testid="score">{player.score}</span>점{!player.connected && ' · 재접속 기다리는 중'}
              </span>
            </span>
            <span className="player-icons">
              {player.id === game.hostId && <Crown size={15} aria-label="방장" />}
              {player.id === drawerId && <Pencil size={15} aria-label="그리는 사람" />}
              {player.solved && <Check size={15} aria-label="정답" className="icon-solved" />}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
