import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import type { ServerMessage } from '../shared/protocol.ts';
import { startServer, type RunningServer, type ServerOptions } from './app.ts';

let server: RunningServer;
let staticDir: string;

beforeEach(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'sketch-quiz-app-'));
  await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
  server = await startServer({ port: 0, staticDir });
});

afterEach(async () => {
  await server.close();
  await rm(staticDir, { recursive: true, force: true });
});

// 메시지를 보낸 뒤 서버가 소켓을 닫을 때의 종료 코드를 기다린다.
function closeCodeAfter(messages: unknown[]): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    ws.onopen = () => {
      for (const message of messages) ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    };
    ws.onclose = (event) => resolve(event.code);
  });
}

function rawGet(requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: 'localhost', port: server.port, path: requestPath }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

// 브라우저나 http 모듈로는 보낼 수 없는 요청 줄을 그대로 보내고, 서버가 연결을 닫을 때까지 기다린다.
function rawUpgrade(target: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(server.port, 'localhost', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    socket.on('error', () => {}); // 서버가 끊으면 ECONNRESET이 올 수 있다.
    socket.on('close', () => resolve());
  });
}

describe('server', () => {
  it('스키마에 맞지 않는 메시지를 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(['not json'])).toBe(1007);
    expect(await closeCodeAfter([{ type: 'hello', roomId: '../../etc' }])).toBe(1008);
    expect(await closeCodeAfter([{ type: 'chat', text: '   ' }])).toBe(1008);
  });

  it('메시지를 한꺼번에 너무 많이 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(Array.from({ length: 300 }, () => ({ type: 'ping' })))).toBe(4008);
  });

  it('64KB를 넘는 메시지는 연결만 끊고 서버는 계속 동작한다', async () => {
    expect(await closeCodeAfter(['x'.repeat(70 * 1024)])).toBe(1009);
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('해석할 수 없는 주소로 업그레이드를 요청하면 그 연결만 끊고 서버는 계속 동작한다', async () => {
    await rawUpgrade('//');
    await rawUpgrade('http://[/ws');
    expect(await rawGet('/healthz')).toBe(200);
  });

  it('정적 파일 경로로 상위 폴더에 접근할 수 없다', async () => {
    expect(await rawGet('/..%2f..%2fpackage.json')).toBe(403);
  });

  it('확장자 없는 경로는 index.html로 보낸다 (SPA)', async () => {
    expect(await rawGet('/r/someRoom1')).toBe(200);
    expect(await rawGet('/missing.js')).toBe(404);
    expect(await rawGet('/healthz')).toBe(200);
  });
});

describe('느리거나 응답하지 않는 연결', () => {
  // 소켓을 읽지 않거나 pong 을 보내지 않는 클라이언트(ws 라이브러리로 흉내 낸다). 종료 코드를 처음부터 기록하고,
  // hello 를 보낸 뒤 welcome 을 기다린다.
  async function join(port: number, name: string, options: { autoPong?: boolean } = {}) {
    const ws = new WsClient(`ws://localhost:${port}/ws`, options);
    const messages: ServerMessage[] = [];
    let closeCode: number | null = null;
    ws.on('close', (code) => (closeCode = code));
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve) => ws.once('open', () => resolve()));
    ws.send(JSON.stringify({ type: 'hello', roomId: 'slowRoom01', token: `token${name}`.padEnd(20, '0'), name }));
    await vi.waitFor(() => expect(messages.some((m) => m.type === 'welcome')).toBe(true));
    const welcome = messages.find((m) => m.type === 'welcome');
    const playerId = welcome?.type === 'welcome' ? welcome.playerId : '';
    return { ws, messages, playerId, closeCode: () => closeCode };
  }

  async function withServer(options: Partial<ServerOptions>, run: (port: number) => Promise<void>) {
    const s = await startServer({ port: 0, ...options });
    try {
      await run(s.port);
    } finally {
      await s.close();
    }
  }

  it('pong 없이 앱 ping 만 보내는 연결은 하트비트가 끊는다', async () => {
    // 고치기 전에는 아무 메시지나 받아도 살아 있다고 봐서, 소켓을 읽지 않고도 앱 ping 만으로 하트비트를 피했다
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'pinger', { autoPong: false });
      const pinger = setInterval(() => {
        if (client.ws.readyState === WsClient.OPEN) client.ws.send(JSON.stringify({ type: 'ping' }));
      }, 30); // 메시지 속도 제한(초당 50개) 아래로
      await vi.waitFor(() => expect(client.closeCode()).toBe(1006), { timeout: 2000 }).finally(() => clearInterval(pinger));
    });
  });

  it('요청하지 않은 pong 만 보내는 연결도 하트비트가 끊는다', async () => {
    // 서버가 보낸 ping 의 payload 를 돌려준 pong 만 살아 있다는 표시로 본다
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'ponger', { autoPong: false });
      const ponger = setInterval(() => {
        if (client.ws.readyState === WsClient.OPEN) client.ws.pong();
      }, 20);
      await vi.waitFor(() => expect(client.closeCode()).toBe(1006), { timeout: 2000 }).finally(() => clearInterval(ponger));
    });
  });

  it('pong 으로 답하는 연결은 끊지 않는다', async () => {
    await withServer({ heartbeatMs: 50 }, async (port) => {
      const client = await join(port, 'healthy');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.closeCode()).toBeNull();
      client.ws.close();
    });
  });

  it('클라이언트가 보낸 ping 프레임에 자동으로 pong 을 쌓지 않는다', async () => {
    // 자동 pong 은 송신 버퍼 상한을 거치지 않아, 읽지 않는 연결이 ping 만 보내도 버퍼가 끝없이 커질 수 있었다
    const client = await join(server.port, 'pingframe');
    let pongs = 0;
    client.ws.on('pong', () => (pongs += 1));
    for (let i = 0; i < 5; i++) client.ws.ping();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pongs).toBe(0);
    client.ws.close();
  });

  it('소켓을 읽지 않는 연결은 송신 버퍼가 상한을 넘으면 끊고, 자리는 재접속 유예 동안 남긴다', async () => {
    // 고치기 전에는 send 가 bufferedAmount 를 보지 않아, 읽지 않는 연결마다 서버 메모리가 끝없이 쌓였다.
    // OS 소켓 버퍼가 먼저 흡수하는 양이 환경마다 달라, 상한을 256KB 로 낮추고 그보다 훨씬 많이(최대 약 19MB) 보낸다.
    await withServer({ maxSendBufferBytes: 256 * 1024 }, async (port) => {
      const drawer = await join(port, 'drawer'); // 첫 사람이 방장이고 첫 턴을 그린다
      const reader = await join(port, 'reader');
      reader.ws.pause(); // 이제부터 읽지 않는다
      drawer.ws.send(JSON.stringify({ type: 'start', settings: { rounds: 1, drawSeconds: 180 } }));
      drawer.ws.send(JSON.stringify({ type: 'choose', index: 0 }));

      const readerSeat = () => {
        const last = drawer.messages.findLast((m) => m.type === 'state');
        return last?.type === 'state' ? last.state.players.find((p) => p.id === reader.playerId) : undefined;
      };
      // 턴의 획 예산(2000획·20만 좌표)을 undo 로 되돌려 가며, 메시지마다 획 3개(약 48KB)를 보낸다.
      // 그리는 사람에게는 자기 획이 돌아오지 않으므로 그리는 사람 쪽 버퍼는 쌓이지 않는다.
      const points = new Array(4000).fill(999);
      let strokeId = 0;
      for (let i = 0; i < 400 && readerSeat()?.connected !== false; i++) {
        const ops = [1, 2, 3].flatMap(() => [
          { kind: 'undo' },
          { kind: 'begin', id: ++strokeId, color: '#000000', width: 4, points },
        ]);
        drawer.ws.send(JSON.stringify({ type: 'draw', ops }));
        await new Promise((resolve) => setTimeout(resolve, 25)); // 메시지 속도 제한(초당 50개) 아래로
      }
      await vi.waitFor(() => expect(readerSeat()?.connected).toBe(false), { timeout: 10_000 });
      expect(drawer.closeCode()).toBeNull();
      drawer.ws.close();
      reader.ws.terminate();
    });
  }, 30_000);
});
