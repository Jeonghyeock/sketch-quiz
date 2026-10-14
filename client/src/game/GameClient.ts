import { CLOSE } from '../../../shared/close.ts';
import { acceptsDrawOp, applyDrawOp } from '../../../shared/drawing.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type {
  ChatEntry,
  ClientMessage,
  DrawOp,
  GameState,
  ServerMessage,
  Settings,
  Stroke,
} from '../../../shared/protocol.ts';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'closed';

export type GameClientState = {
  status: ConnectionStatus;
  closedReason: string | null; // status가 closed일 때, 다시 연결하지 않는 이유
  playerId: string | null;
  game: GameState | null;
  // 서버가 알려 준 남은 시간을 받은 순간 내 시계 기준 마감 시각으로 바꿔 둔다.
  deadline: number | null;
  chat: ChatEntry[];
};

// 그림이 바뀔 때마다 캔버스에 알린다. op 하나를 적용한 직후에 보내므로, 캔버스는 새로 생긴 부분만 그리면 된다.
export type StrokeEvent = { kind: 'reset' } | { kind: 'op'; op: DrawOp };

export type GameClientOptions = {
  url: string;
  roomId: string;
  token: string;
  name: string;
  sendIntervalMs?: number;
  heartbeatMs?: number;
};

const MAX_CHAT_ENTRIES = 200;
// 한 메시지에 담을 획 데이터의 대략적인 최대 크기. 서버의 메시지 크기 제한(64KB)보다 넉넉히 작게 잡는다.
const MAX_BATCH_BYTES = 32 * 1024;

export class GameClient {
  private readonly options: GameClientOptions;
  private readonly sendIntervalMs: number;
  private readonly heartbeatMs: number;

  private ws: WebSocket | null = null;
  private ready = false; // welcome을 받은 뒤부터 true
  private closed = false;
  private networkAvailable = true;

  // 이번 턴의 그림. 그리는 동안 초당 수십 번 바뀌므로 React 상태에 넣지 않고 캔버스가 직접 읽는다.
  readonly strokes: Stroke[] = [];
  private strokeListeners = new Set<(event: StrokeEvent) => void>();

  private state: GameClientState = {
    status: 'connecting',
    closedReason: null,
    playerId: null,
    game: null,
    deadline: null,
    chat: [],
  };
  private listeners = new Set<() => void>();

  // 그리는 사람: 아직 보내지 않은 op와 지금 그리고 있는 획
  private outbox: DrawOp[] = [];
  private nextStrokeId = 1;
  private current: { id: number; color: string; width: number } | null = null;

  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = 0;
  private lastReceivedAt = 0;

  constructor(options: GameClientOptions) {
    this.options = options;
    this.sendIntervalMs = options.sendIntervalMs ?? 40;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleNetworkOnline);
      window.addEventListener('offline', this.handleNetworkOffline);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.connect();
  }

  // ---- React(useSyncExternalStore)용 ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  subscribeStrokes(listener: (event: StrokeEvent) => void): () => void {
    this.strokeListeners.add(listener);
    return () => this.strokeListeners.delete(listener);
  }

  // ---- 게임 동작 ----

  start(settings: Settings): void {
    this.send({ type: 'start', settings });
  }

  choose(index: number): void {
    this.send({ type: 'choose', index });
  }

  sendChat(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || !this.ready) return false;
    this.send({ type: 'chat', text: trimmed });
    return true;
  }

  // 나가기 버튼. 자리를 바로 비우도록 서버에 알린 뒤 연결을 닫는다(그냥 끊기면 유예 시간 동안 자리가 남는다).
  leave(): void {
    this.send({ type: 'leave' });
    this.close();
  }

  close(): void {
    this.closed = true;
    for (const timer of [this.reconnectTimer, this.sendTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.stopHeartbeat();
    this.detachSocket()?.close(1000, 'client closed');
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleNetworkOnline);
      window.removeEventListener('offline', this.handleNetworkOffline);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  // ---- 그리기 (그리는 사람만) ----

  // 내 화면에는 바로 그리고, 서버에는 sendIntervalMs마다 모아서 보낸다.
  beginStroke(color: string, width: number, x: number, y: number): boolean {
    return this.begin(color, width, [x, y]);
  }

  extendStroke(points: number[]): boolean {
    const current = this.current;
    if (!current || points.length === 0) return false;
    if (this.draw({ kind: 'extend', id: current.id, points })) return true;
    // 획 하나의 점 개수 한도에 걸렸으면 마지막 점에서 이어지는 새 획으로 나눈다. 보기에는 한 획이다.
    const last = this.strokes.at(-1);
    this.current = null;
    if (!last || last.id !== current.id) return false;
    return this.begin(current.color, current.width, [...last.points.slice(-2), ...points]);
  }

  private begin(color: string, width: number, points: number[]): boolean {
    const id = this.nextStrokeId;
    if (!this.draw({ kind: 'begin', id, color, width, points })) return false;
    this.nextStrokeId += 1;
    this.current = { id, color, width };
    return true;
  }

  endStroke(): void {
    this.current = null;
  }

  undo(): void {
    this.current = null;
    this.draw({ kind: 'undo' });
  }

  clear(): void {
    this.current = null;
    this.draw({ kind: 'clear' });
  }

  canDraw(): boolean {
    const { game, playerId } = this.state;
    return this.ready && game?.phase.kind === 'drawing' && game.phase.drawerId === playerId;
  }

  private draw(op: DrawOp): boolean {
    if (!this.canDraw() || !acceptsDrawOp(this.strokes, op)) return false;
    this.applyAndEmit(op);
    // 같은 획에 이어지는 점은 보내기 전에 하나의 op로 합친다.
    const last = this.outbox.at(-1);
    if (op.kind === 'extend' && last && (last.kind === 'begin' || last.kind === 'extend') && last.id === op.id) {
      last.points.push(...op.points);
    } else {
      this.outbox.push(op.kind === 'begin' || op.kind === 'extend' ? { ...op, points: [...op.points] } : op);
    }
    this.scheduleSend();
    return true;
  }

  private applyAndEmit(op: DrawOp): void {
    applyDrawOp(this.strokes, op);
    for (const listener of this.strokeListeners) listener({ kind: 'op', op });
  }

  // ---- 네트워크 상태 (브라우저 이벤트, 테스트에서도 같은 경로를 쓴다) ----

  handleNetworkOffline = () => {
    this.networkAvailable = false;
    this.disconnect();
  };

  handleNetworkOnline = () => {
    this.networkAvailable = true;
    this.reconnectNow();
  };

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !this.ws) this.reconnectNow();
  };

  // ---- 연결 ----

  private connect(): void {
    if (this.closed || this.ws || !this.networkAvailable) return;
    this.setState({ status: 'connecting' });
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      this.lastReceivedAt = Date.now();
      this.send({ type: 'hello', roomId: this.options.roomId, token: this.options.token, name: this.options.name });
      this.startHeartbeat();
    };
    ws.onmessage = (event) => {
      this.lastReceivedAt = Date.now();
      this.handleMessage(JSON.parse(String(event.data)) as ServerMessage);
    };
    ws.onclose = (event) => {
      if (event.code === CLOSE.replaced) this.shutDown('다른 탭에서 같은 자리로 접속해서 이 탭의 연결을 끊었어요.');
      else if (event.code === CLOSE.roomFull) this.shutDown('방이 가득 찼어요.');
      else this.disconnect();
    };
  }

  // 소켓을 떼어내고 다시 연결을 예약한다. 이미 떼어낸 소켓에서 늦게 오는 이벤트는 무시된다.
  private disconnect(): void {
    this.detachSocket()?.close();
    this.ready = false;
    this.stopHeartbeat();
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = null;
    this.setState({ status: 'offline' });
    this.scheduleReconnect();
  }

  // 다시 연결해도 소용없는 경우. 서로 자리를 뺏으며 끝없이 재접속하지 않도록 멈춘다.
  private shutDown(reason: string): void {
    this.close();
    this.setState({ status: 'closed', closedReason: reason });
  }

  private detachSocket(): WebSocket | null {
    const ws = this.ws;
    if (!ws) return null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    this.ws = null;
    return ws;
  }

  // 지수 백오프 + 지터: 서버가 재시작됐을 때 모든 클라이언트가 같은 순간에 몰려들지 않게 한다.
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer || !this.networkAvailable) return;
    const base = Math.min(10_000, 500 * 2 ** this.retryCount);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.retryCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retryCount = 0;
    this.connect();
  }

  // 브라우저는 WebSocket ping 프레임을 노출하지 않으므로 앱 레벨 ping으로 죽은 연결을 감지한다.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastReceivedAt > this.heartbeatMs * 2.5) {
        this.disconnect();
        return;
      }
      this.send({ type: 'ping' });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  // ---- 수신 ----

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        // 서버가 가진 이번 턴의 그림으로 덮어쓴다. 끊긴 동안 보내지 못한 내 획은 버린다.
        this.strokes.length = 0;
        this.strokes.push(...message.strokes);
        for (const stroke of message.strokes) this.nextStrokeId = Math.max(this.nextStrokeId, stroke.id + 1);
        this.outbox = [];
        this.current = null;
        this.ready = true;
        this.retryCount = 0;
        this.setState({ status: 'online', playerId: message.playerId, ...this.withDeadline(message.state) });
        for (const listener of this.strokeListeners) listener({ kind: 'reset' });
        break;
      }
      case 'state':
        this.setState(this.withDeadline(message.state));
        if (message.state.phase.kind !== 'drawing') {
          this.current = null;
          this.outbox = [];
        }
        break;
      case 'draw':
        for (const op of message.ops) this.applyAndEmit(op);
        break;
      case 'chat':
        this.setState({ chat: [...this.state.chat, message.entry].slice(-MAX_CHAT_ENTRIES) });
        break;
      case 'pong':
        break;
    }
  }

  private withDeadline(game: GameState): Pick<GameClientState, 'game' | 'deadline'> {
    const deadline = 'remainingMs' in game.phase ? Date.now() + game.phase.remainingMs : null;
    return { game, deadline };
  }

  // ---- 송신 ----

  private scheduleSend(): void {
    if (!this.ready || this.sendTimer) return;
    const delay = Math.max(0, this.lastSentAt + this.sendIntervalMs - Date.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.flush();
    }, delay);
  }

  private flush(): void {
    if (!this.ready || this.outbox.length === 0) return;
    const ops = this.outbox;
    this.outbox = [];
    let batch: DrawOp[] = [];
    let bytes = 0;
    for (const op of ops) {
      const size = 'points' in op ? op.points.length * 5 + 64 : 32;
      if (batch.length > 0 && (batch.length >= LIMITS.maxOpsPerDraw || bytes + size > MAX_BATCH_BYTES)) {
        this.send({ type: 'draw', ops: batch });
        batch = [];
        bytes = 0;
      }
      batch.push(op);
      bytes += size;
    }
    if (batch.length > 0) this.send({ type: 'draw', ops: batch });
    this.lastSentAt = Date.now();
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private setState(patch: Partial<GameClientState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
