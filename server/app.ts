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
  const { heartbeatMs = 30_000 } = options;

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

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // 응답 없는 연결(와이파이 끊김 등)은 TCP가 한참 뒤에야 알아챈다. 주기적으로 ping을 보내 정리한다.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, heartbeatMs);

  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    let room: Room | null = null;
    const limit = new TokenBucket(MESSAGE_BURST, MESSAGES_PER_SECOND);
    const conn: Connection = {
      send(message) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    const helloTimeout = setTimeout(() => {
      if (!room) ws.close(1008, 'hello timeout');
    }, 10_000);

    ws.on('message', (data, isBinary) => {
      alive.add(ws);
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
