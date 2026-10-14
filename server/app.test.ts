import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from './app.ts';

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

describe('server', () => {
  it('스키마에 맞지 않는 메시지를 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(['not json'])).toBe(1007);
    expect(await closeCodeAfter([{ type: 'hello', roomId: '../../etc' }])).toBe(1008);
    expect(await closeCodeAfter([{ type: 'chat', text: '   ' }])).toBe(1008);
  });

  it('메시지를 한꺼번에 너무 많이 보내면 연결을 끊는다', async () => {
    expect(await closeCodeAfter(Array.from({ length: 300 }, () => ({ type: 'ping' })))).toBe(4008);
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
