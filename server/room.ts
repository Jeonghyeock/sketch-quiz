import { CLOSE } from '../shared/close.ts';
import { acceptsDrawOp, applyDrawOp } from '../shared/drawing.ts';
import { randomId } from '../shared/id.ts';
import { DEFAULT_SETTINGS, LIMITS } from '../shared/limits.ts';
import type {
  ChatEntry,
  ClientMessage,
  DrawOp,
  GameState,
  HelloMessage,
  PhaseView,
  ServerMessage,
  Settings,
  Stroke,
  TurnEndReason,
} from '../shared/protocol.ts';
import { makeHint, normalizeAnswer } from './hint.ts';
import { TokenBucket } from './rateLimit.ts';
import { WORDS } from './words.ts';

// 소켓 구현과 분리해 두면 Room을 소켓 없이 테스트할 수 있다.
export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export type RoomOptions = {
  choosingMs?: number;
  turnEndMs?: number;
  reconnectGraceMs?: number;
  words?: readonly string[];
  random?: () => number;
};

const PLAYER_COLORS = [
  '#e03131', '#1c7ed6', '#2f9e44', '#f76707', '#7048e8',
  '#d6336c', '#0c8599', '#5c940d', '#862e9c', '#e8590c',
];
const CHOICE_COUNT = 3;
// 그리기 시간의 50%, 75%가 지나면 힌트를 한 단계씩 더 보여 준다(글자 수 → 초성 → 첫 글자).
const HINT_AT = [0.5, 0.75];
const DRAWER_POINTS_PER_SOLVE = 50;

type Player = {
  id: string; // 공개 id. 다른 사람에게 보인다.
  token: string; // 비밀. 재접속할 때 본인 확인에만 쓰고 밖으로 내보내지 않는다.
  name: string;
  color: string;
  score: number;
  conn: Connection | null; // null = 끊겨서 재접속을 기다리는 중
  graceTimer: ReturnType<typeof setTimeout> | null;
  chatLimit: TokenBucket;
};

type Turn = {
  drawerId: string;
  choices: string[];
  word: string | null; // 고르기 전에는 null
  solved: Map<string, number>; // 맞힌 사람 → 얻은 점수 (맞힌 순서대로)
  drawerGained: number;
};

type Phase =
  | { kind: 'lobby' }
  | { kind: 'choosing'; turn: Turn; endsAt: number }
  | { kind: 'drawing'; turn: Turn; endsAt: number; drawMs: number; hintLevel: number }
  | { kind: 'turnEnd'; turn: Turn; endsAt: number; reason: TurnEndReason }
  | { kind: 'gameEnd' };

// 방 하나의 게임. 진행(단계 전환, 타이머, 정답 판정, 점수)은 전부 서버가 정하고 클라이언트는 보여 주기만 한다.
//
// 대기실 → 단어 고르기 → 그리기 → 턴 결과 → (다음 사람) … → 게임 끝
export class Room {
  readonly id: string;
  // 마지막 사람이 나가면 호출된다(방 정리용).
  onEmpty: (() => void) | null = null;

  private readonly choosingMs: number;
  private readonly turnEndMs: number;
  private readonly reconnectGraceMs: number;
  private readonly words: readonly string[];
  private readonly random: () => number;

  private players = new Map<string, Player>(); // Map은 넣은 순서를 지킨다 → 들어온 순서 = 그리는 순서
  private byConn = new Map<Connection, Player>();
  private hostId = '';
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private phase: Phase = { kind: 'lobby' };
  private round = 0;
  private order: string[] = []; // 이번 라운드에 그릴 사람. 라운드 중간에 들어온 사람은 다음 라운드부터 그린다.
  private orderIndex = 0;
  private usedWords = new Set<string>();
  // 이번 턴의 그림. 늦게 들어오거나 새로고침한 사람에게 한 번에 보내 주려고 들고 있는다.
  private strokes: Stroke[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private chatSeq = 0;

  constructor(id: string, options: RoomOptions = {}) {
    this.id = id;
    this.choosingMs = options.choosingMs ?? 15_000;
    this.turnEndMs = options.turnEndMs ?? 5_000;
    this.reconnectGraceMs = options.reconnectGraceMs ?? 20_000;
    this.words = options.words ?? WORDS;
    this.random = options.random ?? Math.random;
  }

  join(conn: Connection, hello: HelloMessage): void {
    let player = [...this.players.values()].find((p) => p.token === hello.token);
    const isNew = !player;
    if (player) {
      // 새로고침·재접속: 같은 자리(점수, 그릴 차례)를 이어받는다. 반쯤 끊긴 이전 연결이 남아 있으면 닫는다.
      if (player.conn) {
        this.byConn.delete(player.conn);
        player.conn.close(CLOSE.replaced, 'replaced by a new connection');
      }
      if (player.graceTimer) clearTimeout(player.graceTimer);
      player.graceTimer = null;
    } else {
      if (this.players.size >= LIMITS.maxPlayersPerRoom) {
        conn.close(CLOSE.roomFull, 'room is full');
        return;
      }
      player = {
        id: randomId(12),
        token: hello.token,
        name: hello.name,
        color: this.pickColor(),
        score: 0,
        conn: null,
        graceTimer: null,
        chatLimit: new TokenBucket(5, 1),
      };
      this.players.set(player.id, player);
      if (!this.hostId) this.hostId = player.id;
    }

    player.conn = conn;
    this.byConn.set(conn, player);
    conn.send({ type: 'welcome', playerId: player.id, state: this.viewFor(player), strokes: this.strokes });
    this.broadcastState(player);
    if (isNew) this.system(`${player.name}님이 들어왔어요`);
  }

  // 소켓이 닫혔을 때. 잠깐 끊긴 것일 수 있으니 바로 내보내지 않고 자리를 잡아 둔다.
  disconnect(conn: Connection): void {
    const player = this.byConn.get(conn);
    if (!player) return;
    this.byConn.delete(conn);
    player.conn = null;
    player.graceTimer = setTimeout(
      () => this.remove(player, `${player.name}님의 연결이 끊어졌어요`),
      this.reconnectGraceMs,
    );
    this.broadcastState();
    this.checkAllSolved();
  }

  handle(conn: Connection, message: ClientMessage): void {
    const player = this.byConn.get(conn);
    if (!player) return;
    // 단계가 막 바뀌는 순간에 도착한 메시지(시간 종료 직후의 획, 자동 선택 뒤의 choose 등)는 조용히 버린다.
    // 연결을 끊는 것은 스키마 위반과 메시지 폭주 때뿐이다.
    switch (message.type) {
      case 'start':
        this.start(player, message.settings);
        break;
      case 'choose':
        if (this.phase.kind === 'choosing' && this.phase.turn.drawerId === player.id) {
          this.chooseWord(this.phase.turn, message.index);
        }
        break;
      case 'draw':
        this.draw(player, message.ops);
        break;
      case 'chat':
        this.chat(player, message.text);
        break;
      case 'leave':
        this.remove(player, `${player.name}님이 나갔어요`);
        break;
      case 'ping':
        conn.send({ type: 'pong' });
        break;
      case 'hello':
        break; // 연결당 한 번만 의미가 있다. 이후의 hello는 무시한다.
    }
  }

  // 서버를 닫을 때 남은 타이머를 정리한다.
  dispose(): void {
    this.clearTimers();
    for (const player of this.players.values()) {
      if (player.graceTimer) clearTimeout(player.graceTimer);
    }
  }

  // ---- 진행 ----

  private start(player: Player, settings: Settings): void {
    if (player.id !== this.hostId) return;
    if (this.phase.kind !== 'lobby' && this.phase.kind !== 'gameEnd') return;
    if (this.connectedPlayers().length < 2) return;
    this.settings = settings;
    for (const p of this.players.values()) p.score = 0;
    this.usedWords.clear();
    this.round = 1;
    this.order = [...this.players.keys()];
    this.orderIndex = 0;
    this.system('게임을 시작합니다!', 'success');
    this.nextTurn();
  }

  private nextTurn(): void {
    // 이번 라운드에서 아직 그리지 않았고 지금 접속해 있는 사람을 찾는다. 다 그렸으면 다음 라운드로.
    // 재접속을 기다리는 사람은 이번 차례를 건너뛴다(뽑아 봐야 아무도 그릴 수 없는 시간만 생긴다).
    // 모두 끊겨 있어도 라운드 수가 정해져 있으므로 결국 게임 끝으로 빠져나간다.
    let drawerId: string | undefined;
    while (!drawerId) {
      const candidate = this.order[this.orderIndex];
      if (candidate === undefined) {
        if (this.round >= this.settings.rounds) {
          this.finish();
          return;
        }
        this.round += 1;
        this.order = [...this.players.keys()];
        this.orderIndex = 0;
        continue;
      }
      this.orderIndex += 1;
      if (this.players.get(candidate)?.conn) drawerId = candidate;
    }

    const turn: Turn = { drawerId, choices: this.pickWords(), word: null, solved: new Map(), drawerGained: 0 };
    this.strokes = [];
    this.broadcast({ type: 'draw', ops: [{ kind: 'clear' }] });
    this.setPhase({ kind: 'choosing', turn, endsAt: Date.now() + this.choosingMs });
    // 시간 안에 고르지 않으면 서버가 대신 고른다.
    this.after(this.choosingMs, () => this.chooseWord(turn, Math.floor(this.random() * turn.choices.length)));
    this.broadcastState();
  }

  private chooseWord(turn: Turn, index: number): void {
    const word = turn.choices[index];
    if (!word) return;
    turn.word = word;
    this.usedWords.add(word);
    const drawMs = this.settings.drawSeconds * 1000;
    const phase: Phase = { kind: 'drawing', turn, endsAt: Date.now() + drawMs, drawMs, hintLevel: 0 };
    this.setPhase(phase);
    HINT_AT.forEach((ratio, i) =>
      this.after(drawMs * ratio, () => {
        phase.hintLevel = i + 1;
        this.broadcastState();
      }),
    );
    this.after(drawMs, () => this.endTurn('timeout'));
    this.broadcastState();
  }

  private draw(player: Player, ops: DrawOp[]): void {
    if (this.phase.kind !== 'drawing' || this.phase.turn.drawerId !== player.id) return;
    const accepted: DrawOp[] = [];
    for (const op of ops) {
      if (!acceptsDrawOp(this.strokes, op)) continue;
      applyDrawOp(this.strokes, op);
      accepted.push(op);
    }
    // 그린 사람은 이미 자기 화면에 그렸으므로 나머지에게만 보낸다.
    if (accepted.length > 0) this.broadcast({ type: 'draw', ops: accepted }, player);
  }

  private chat(player: Player, text: string): void {
    if (!player.chatLimit.take()) {
      this.system('채팅이 너무 빨라요. 잠시 후에 다시 보내 주세요.', 'warning', player);
      return;
    }
    const entry: ChatEntry = {
      kind: 'chat',
      id: ++this.chatSeq,
      playerId: player.id,
      name: player.name,
      color: player.color,
      text,
      solvedOnly: false,
    };
    const phase = this.phase;
    if (phase.kind === 'drawing') {
      const { turn } = phase;
      const knowsWord = player.id === turn.drawerId || turn.solved.has(player.id);
      if (!knowsWord && turn.word && normalizeAnswer(text) === normalizeAnswer(turn.word)) {
        // 정답은 채팅으로 내보내지 않는다. 내보내면 그 순간 모두에게 정답이 보인다.
        this.solve(player, phase);
        return;
      }
      if (!knowsWord && turn.word && normalizeAnswer(text).includes(normalizeAnswer(turn.word))) {
        // "고양이?", "고양이ㅋㅋ"처럼 정답이 들어 있지만 정답은 아닌 말은 보낸 사람에게만 돌려준다.
        // 따로 알리지 않는다. 알리면 단어 여러 개를 넣어 보내 보며 어느 말에 정답이 있는지 알아낼 수 있다.
        player.conn?.send({ type: 'chat', entry });
        return;
      }
      if (knowsWord) {
        // 정답을 아는 사람의 채팅은 정답을 아는 사람끼리만 본다. 정답이나 결정적인 힌트가 새지 않게 하기 위해서다.
        const solvedEntry = { ...entry, solvedOnly: true };
        for (const p of this.players.values()) {
          if (p.id === turn.drawerId || turn.solved.has(p.id)) p.conn?.send({ type: 'chat', entry: solvedEntry });
        }
        return;
      }
    }
    this.broadcast({ type: 'chat', entry });
  }

  private solve(player: Player, phase: Extract<Phase, { kind: 'drawing' }>): void {
    const { turn } = phase;
    // 빨리 맞힐수록 점수가 높다: 100 ~ 300점. 그린 사람은 맞힌 사람 한 명당 50점.
    const remaining = Math.max(0, phase.endsAt - Date.now());
    const points = 100 + Math.round((200 * remaining) / phase.drawMs);
    turn.solved.set(player.id, points);
    player.score += points;
    const drawer = this.players.get(turn.drawerId);
    if (drawer) {
      drawer.score += DRAWER_POINTS_PER_SOLVE;
      turn.drawerGained += DRAWER_POINTS_PER_SOLVE;
    }
    this.system(`${player.name}님이 정답을 맞혔어요!`, 'success');
    this.broadcastState();
    this.checkAllSolved();
  }

  // 접속해 있는 사람이 모두 맞혔으면 시간을 다 기다리지 않고 턴을 끝낸다.
  private checkAllSolved(): void {
    if (this.phase.kind !== 'drawing') return;
    const { turn } = this.phase;
    const guessers = this.connectedPlayers().filter((p) => p.id !== turn.drawerId);
    if (guessers.length > 0 && guessers.every((p) => turn.solved.has(p.id))) this.endTurn('allSolved');
  }

  private endTurn(reason: TurnEndReason): void {
    const phase = this.phase;
    if (phase.kind !== 'choosing' && phase.kind !== 'drawing') return;
    const { turn } = phase;
    this.setPhase({ kind: 'turnEnd', turn, reason, endsAt: Date.now() + this.turnEndMs });
    this.after(this.turnEndMs, () => this.nextTurn());
    if (turn.word) this.system(`정답 공개: ${turn.word}`);
    this.broadcastState();
  }

  private finish(): void {
    this.setPhase({ kind: 'gameEnd' });
    const winner = [...this.players.values()].sort((a, b) => b.score - a.score)[0];
    if (winner) this.system(`게임 끝! 1등은 ${winner.name}님이에요`, 'success');
    this.broadcastState();
  }

  private remove(player: Player, text: string): void {
    if (this.players.get(player.id) !== player) return;
    if (player.graceTimer) clearTimeout(player.graceTimer);
    if (player.conn) this.byConn.delete(player.conn);
    this.players.delete(player.id);
    if (this.players.size === 0) {
      this.dispose();
      this.onEmpty?.();
      return;
    }
    if (this.hostId === player.id) {
      const next = this.connectedPlayers()[0] ?? [...this.players.values()][0];
      if (next) this.hostId = next.id;
    }
    this.system(text);

    const phase = this.phase;
    const inGame = phase.kind === 'choosing' || phase.kind === 'drawing' || phase.kind === 'turnEnd';
    if (inGame && this.players.size < 2) {
      this.setPhase({ kind: 'lobby' });
      this.system('인원이 부족해서 게임을 끝냈어요', 'warning');
      this.broadcastState();
      return;
    }
    if ((phase.kind === 'choosing' || phase.kind === 'drawing') && phase.turn.drawerId === player.id) {
      this.endTurn('drawerLeft');
      return;
    }
    this.broadcastState();
    this.checkAllSolved();
  }

  // ---- 보내기 ----

  // 사람마다 보이는 것이 다르다. 제시어는 그리는 사람(고르기·그리기)과 이미 맞힌 사람에게만 담는다.
  private viewFor(viewer: Player): GameState {
    const now = Date.now();
    const phase = this.phase;
    const turn = 'turn' in phase ? phase.turn : null;
    let view: PhaseView;
    switch (phase.kind) {
      case 'lobby':
      case 'gameEnd':
        view = { kind: phase.kind };
        break;
      case 'choosing':
        view = {
          kind: 'choosing',
          drawerId: phase.turn.drawerId,
          remainingMs: Math.max(0, phase.endsAt - now),
          choices: viewer.id === phase.turn.drawerId ? phase.turn.choices : null,
        };
        break;
      case 'drawing': {
        const word = phase.turn.word ?? '';
        const knowsWord = viewer.id === phase.turn.drawerId || phase.turn.solved.has(viewer.id);
        view = {
          kind: 'drawing',
          drawerId: phase.turn.drawerId,
          remainingMs: Math.max(0, phase.endsAt - now),
          hint: makeHint(word, phase.hintLevel),
          word: knowsWord ? word : null,
        };
        break;
      }
      case 'turnEnd':
        view = {
          kind: 'turnEnd',
          drawerId: phase.turn.drawerId,
          remainingMs: Math.max(0, phase.endsAt - now),
          word: phase.turn.word,
          reason: phase.reason,
          gained: Object.fromEntries([
            ...phase.turn.solved,
            ...(phase.turn.drawerGained > 0 ? [[phase.turn.drawerId, phase.turn.drawerGained] as const] : []),
          ]),
        };
        break;
    }
    return {
      hostId: this.hostId,
      settings: this.settings,
      round: this.round,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        connected: p.conn !== null,
        solved: turn?.solved.has(p.id) ?? false,
      })),
      phase: view,
    };
  }

  private broadcastState(except?: Player): void {
    for (const player of this.players.values()) {
      if (player !== except) player.conn?.send({ type: 'state', state: this.viewFor(player) });
    }
  }

  private broadcast(message: ServerMessage, except?: Player): void {
    for (const player of this.players.values()) {
      if (player !== except) player.conn?.send(message);
    }
  }

  private system(text: string, tone: 'info' | 'success' | 'warning' = 'info', to?: Player): void {
    const message: ServerMessage = { type: 'chat', entry: { kind: 'system', id: ++this.chatSeq, text, tone } };
    if (to) to.conn?.send(message);
    else this.broadcast(message);
  }

  // ---- 도우미 ----

  private setPhase(phase: Phase): void {
    this.clearTimers();
    this.phase = phase;
  }

  private after(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private connectedPlayers(): Player[] {
    return [...this.players.values()].filter((p) => p.conn !== null);
  }

  private pickColor(): string {
    const used = new Set([...this.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]!;
  }

  // 이번 게임에서 아직 나오지 않은 단어 중 3개를 고른다. 다 썼으면 처음부터 다시 쓴다.
  private pickWords(): string[] {
    let pool = this.words.filter((w) => !this.usedWords.has(w));
    if (pool.length < CHOICE_COUNT) {
      this.usedWords.clear();
      pool = [...this.words];
    }
    const choices: string[] = [];
    while (choices.length < CHOICE_COUNT && pool.length > 0) {
      const [word] = pool.splice(Math.floor(this.random() * pool.length), 1);
      if (word) choices.push(word);
    }
    return choices;
  }
}
