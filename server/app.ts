import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { CLOSE } from '../shared/close.ts';
import { LIMITS } from '../shared/limits.ts';
import { ClientMessageSchema } from '../shared/protocol.ts';
import { TokenBucket } from './rateLimit.ts';
import { Room, type Connection, type RoomOptions } from './room.ts';
import { createStaticHandler } from './static.ts';

export type ServerOptions = {
  port: number;
  host?: string;
  staticDir?: string; // 없으면 WebSocket만 제공한다(개발 모드에서는 Vite가 화면을 맡는다).
  heartbeatMs?: number;
  // 연결 하나의 서버 송신 버퍼 상한(입장 때 보낸 welcome 은 다 빠질 때까지 따로 더한다).
  // 정상 클라이언트가 받는 양(획 중계, 상태)으로는 느린 회선에서도 닿지 않는 크기다.
  maxSendBufferBytes?: number;
  room?: RoomOptions;
};

export type RunningServer = {
  port: number;
  close(): Promise<void>;
};

// 연결 하나가 보낼 수 있는 메시지 양. 그리는 사람은 40ms마다(초당 25번) 보내므로 넉넉하게 잡는다.
const MESSAGE_BURST = 100;
const MESSAGES_PER_SECOND = 50;

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { heartbeatMs = 30_000, maxSendBufferBytes = 2 * 1024 * 1024 } = options;

  // 게임은 저장하지 않는다. 방은 첫 사람이 들어올 때 만들고, 마지막 사람이 나가면 지운다.
  const rooms = new Map<string, Room>();
  let closing = false;

  function getRoom(roomId: string): Room {
    let room = rooms.get(roomId);
    if (!room) {
      const created = new Room(roomId, options.room);
      created.onEmpty = () => {
        if (rooms.get(roomId) === created) rooms.delete(roomId);
      };
      rooms.set(roomId, created);
      room = created;
    }
    return room;
  }

  // ---- HTTP + WebSocket ----
  const serveStatic = options.staticDir ? createStaticHandler(options.staticDir) : null;
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (serveStatic) void serveStatic(req, res);
    else res.writeHead(404).end();
  });

  // autoPong: 클라이언트가 보낸 ping 프레임에 ws 가 자동으로 쌓는 pong 은 송신 버퍼 상한을 거치지 않는다.
  // 브라우저는 ping 프레임을 보내지 않으므로 끈다.
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, autoPong: false });
  server.on('upgrade', (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // '//'·'http://[/ws'처럼 해석할 수 없는 주소. 여기서 던지면 서버 프로세스 전체가 죽는다.
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // ---- 연결 상태: 생존 판정과 송신 버퍼 상한 ----
  // 응답 없는 연결(와이파이 끊김 등)은 TCP가 한참 뒤에야 알아챈다. 주기적으로 ping을 보내 정리한다.
  // - 살아 있다는 판정은 이번에 보낸 ping 의 payload(무작위)를 그대로 돌려준 pong 으로만 한다(브라우저는 자동으로 답한다).
  //   아무 메시지나, 요청하지 않은 pong 까지 살아 있다고 보면 소켓을 읽지 않는 연결이 앱 ping 만으로 하트비트를 피했다.
  // - pong 이 늦어도 송신 버퍼가 줄고 있으면(느리지만 받는 중) 끊지 않는다. ping 이 쌓인 버퍼 뒤에 서기 때문이다.
  // - 읽지 않는(또는 아주 느린) 연결은 서버 송신 버퍼가 끝없이 커져 결국 프로세스 메모리가 넘친다.
  //   버퍼가 welcome 여유분 + maxSendBufferBytes 를 넘으면 끊는다. 자리는 재접속 유예 동안 남고, 클라이언트는 다시 접속해 따라잡는다.
  type ConnState = { nonce: Buffer | null; ponged: boolean; lastBuffered: number; welcomeBytes: number };
  const states = new WeakMap<WebSocket, ConnState>();
  const overLimit = (ws: WebSocket, state: ConnState) => {
    // 입장 때 보낸 welcome(지금까지의 그림 등)은 빠져나가는 만큼 여유분을 줄인다
    state.welcomeBytes = Math.min(state.welcomeBytes, ws.bufferedAmount);
    return ws.bufferedAmount > state.welcomeBytes + maxSendBufferBytes;
  };
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = states.get(ws);
      if (!state) continue;
      const draining = ws.bufferedAmount < state.lastBuffered;
      if (overLimit(ws, state) || (!state.ponged && !draining)) {
        ws.terminate();
        continue;
      }
      state.ponged = false;
      state.lastBuffered = ws.bufferedAmount;
      state.nonce = randomBytes(8);
      ws.ping(state.nonce);
    }
  }, heartbeatMs);

  wss.on('connection', (ws) => {
    const state: ConnState = { nonce: null, ponged: true, lastBuffered: 0, welcomeBytes: 0 };
    states.set(ws, state);
    ws.on('pong', (data) => {
      if (state.nonce && data.equals(state.nonce)) state.ponged = true;
    });

    let room: Room | null = null;
    const limit = new TokenBucket(MESSAGE_BURST, MESSAGES_PER_SECOND);
    const conn: Connection = {
      send(message) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (overLimit(ws, state)) {
          ws.terminate();
          return;
        }
        const json = JSON.stringify(message);
        if (message.type === 'welcome') state.welcomeBytes = ws.bufferedAmount + Buffer.byteLength(json);
        ws.send(json);
      },
      close(code, reason) {
        // close 프레임은 쌓인 버퍼 뒤에 서므로, 상한을 넘은 연결은 closeTimeout(30초) 동안 버퍼를 쥐고 남는다. 바로 끊는다.
        if (overLimit(ws, state)) ws.terminate();
        else ws.close(code, reason);
      },
    };
    const helloTimeout = setTimeout(() => {
      if (!room) ws.close(1008, 'hello timeout');
    }, 10_000);

    ws.on('message', (data, isBinary) => {
      if (!limit.take()) {
        ws.close(CLOSE.rateLimited, 'too many messages');
        return;
      }
      if (isBinary) {
        ws.close(1003, 'binary messages are not supported');
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        ws.close(1007, 'invalid json');
        return;
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        ws.close(1008, 'invalid message');
        return;
      }
      const message = parsed.data;

      if (message.type === 'hello') {
        if (room) return;
        clearTimeout(helloTimeout);
        room = getRoom(message.roomId);
        room.join(conn, message);
        return;
      }
      // hello 전에 온 메시지는 버린다. 클라이언트는 welcome을 받은 뒤에만 다른 메시지를 보낸다.
      room?.handle(conn, message);
    });

    // 크기 초과(64KB)·프로토콜 위반이면 ws가 알맞은 코드(1009 등)로 소켓을 직접 닫고 'error'를 낸다.
    // 리스너가 없으면 프로세스가 죽어 모든 방이 사라지므로 받아만 둔다. 정리는 이어지는 'close'에서 한다.
    // 로그는 남기지 않는다. 일부러 큰 메시지를 계속 보내면 로그만 쌓이기 때문이다.
    ws.on('error', () => {});

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      // 서버를 닫는 중이면 이미 정리한 방에 재접속 유예 타이머를 다시 걸지 않는다.
      if (!closing) room?.disconnect(conn);
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      for (const room of rooms.values()) room.dispose();
      rooms.clear();
      for (const ws of wss.clients) ws.close(1001, 'server shutting down');
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
