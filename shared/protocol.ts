import { z } from 'zod';
import { CANVAS, LIMITS } from './limits.ts';

// 서버는 클라이언트가 보낸 메시지를 신뢰하지 않는다. 모든 입력은 이 스키마를 통과해야 한다.
// 클라이언트는 타입만 가져다 쓰므로(import type) zod가 번들에 들어가지 않는다.

export const RoomIdSchema = z.string().regex(/^[A-Za-z0-9]{6,40}$/);
// 재접속용 비밀 토큰. 본인만 알고, 다른 사람에게는 서버가 매긴 공개 id(playerId)만 보인다.
export const TokenSchema = z.string().regex(/^[A-Za-z0-9]{16,64}$/);

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Name = z.string().trim().min(1).max(LIMITS.maxNameLength);

// 가상 해상도 기준 정수 좌표를 [x0, y0, x1, y1, ...]로 평탄화한다. 소수를 받지 않아 메시지가 짧다.
const Points = z
  .array(z.number().int().min(0).max(Math.max(CANVAS.width, CANVAS.height)))
  .min(2)
  .max(LIMITS.maxCoordsPerStroke)
  .refine((p) => p.length % 2 === 0, '좌표 개수는 짝수여야 합니다');
const StrokeId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

// 획 하나는 begin으로 시작해 extend로 점을 덧붙인다. 지우개는 배경색으로 그리는 획이다.
export const DrawOpSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('begin'),
    id: StrokeId,
    color: Color,
    width: z.number().int().min(1).max(60),
    points: Points,
  }),
  z.strictObject({ kind: z.literal('extend'), id: StrokeId, points: Points }),
  z.strictObject({ kind: z.literal('undo') }),
  z.strictObject({ kind: z.literal('clear') }),
]);

export const SettingsSchema = z.strictObject({
  rounds: z.number().int().min(1).max(10),
  drawSeconds: z.number().int().min(20).max(180),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), roomId: RoomIdSchema, token: TokenSchema, name: Name }),
  z.strictObject({ type: z.literal('start'), settings: SettingsSchema }),
  z.strictObject({ type: z.literal('choose'), index: z.number().int().min(0).max(2) }),
  z.strictObject({ type: z.literal('draw'), ops: z.array(DrawOpSchema).min(1).max(LIMITS.maxOpsPerDraw) }),
  z.strictObject({ type: z.literal('chat'), text: z.string().trim().min(1).max(LIMITS.maxChatLength) }),
  z.strictObject({ type: z.literal('leave') }),
  z.strictObject({ type: z.literal('ping') }),
]);

export type DrawOp = z.infer<typeof DrawOpSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type HelloMessage = Extract<ClientMessage, { type: 'hello' }>;

export type Stroke = { id: number; color: string; width: number; points: number[] };

export type PlayerView = {
  id: string;
  name: string;
  color: string;
  score: number;
  connected: boolean; // false = 끊겨서 재접속을 기다리는 중(자리와 점수는 유지)
  solved: boolean; // 이번 턴에 정답을 맞혔는지
};

export type TurnEndReason = 'timeout' | 'allSolved' | 'drawerLeft';

// 사람마다 다르게 만들어 보낸다. 제시어는 그리는 사람과 이미 맞힌 사람에게만 담긴다.
// 남은 시간은 절대 시각이 아니라 남은 ms로 보낸다. 서버와 브라우저의 시계가 달라도 문제없다.
export type PhaseView =
  | { kind: 'lobby' }
  | { kind: 'choosing'; drawerId: string; remainingMs: number; choices: string[] | null }
  | { kind: 'drawing'; drawerId: string; remainingMs: number; hint: string; word: string | null }
  | {
      kind: 'turnEnd';
      drawerId: string;
      remainingMs: number;
      word: string | null; // 단어를 고르기 전에 그리는 사람이 나가면 null
      reason: TurnEndReason;
      gained: Record<string, number>; // 이번 턴에 얻은 점수(playerId → 점수)
    }
  | { kind: 'gameEnd' };

export type GameState = {
  hostId: string;
  settings: Settings;
  round: number;
  players: PlayerView[]; // 들어온 순서 = 그리는 순서
  phase: PhaseView;
};

export type ChatEntry =
  | {
      kind: 'chat';
      id: number;
      playerId: string;
      name: string;
      color: string;
      text: string;
      solvedOnly: boolean; // 정답을 아는 사람(그리는 사람, 맞힌 사람)끼리만 보이는 메시지
    }
  | { kind: 'system'; id: number; text: string; tone: 'info' | 'success' | 'warning' };

export type ServerMessage =
  | { type: 'welcome'; playerId: string; state: GameState; strokes: Stroke[] }
  | { type: 'state'; state: GameState }
  | { type: 'draw'; ops: DrawOp[] }
  | { type: 'chat'; entry: ChatEntry }
  | { type: 'pong' };
