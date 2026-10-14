import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomId } from '../../../shared/id.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { startServer, type RunningServer } from '../../../server/app.ts';
import { GameClient } from './GameClient.ts';

// 실제 서버와 실제 WebSocket으로 클라이언트 여러 개를 붙여 검증한다.
// 가짜 시계는 소켓과 섞으면 다루기 어려우므로 진짜 시계를 쓰고, 대신 서버의 대기 시간을 짧게 준다.

const WORDS = ['바나나우유', '자전거길', '사과나무'];

let server: RunningServer;
let clients: GameClient[] = [];

function connect(roomId: string, name: string, token = randomId(24)) {
  const client = new GameClient({
    url: `ws://localhost:${server.port}/ws`,
    roomId,
    token,
    name,
    sendIntervalMs: 10,
  });
  clients.push(client);
  return { client, token };
}

const phaseOf = (client: GameClient) => client.getState().game?.phase;

async function online(...list: GameClient[]) {
  await vi.waitFor(() => {
    for (const c of list) expect(c.getState().status).toBe('online');
  });
}

// alice(방장)가 시작해서 첫 번째 단어를 고른다. 첫 턴은 alice가 그린다.
async function startDrawing(alice: GameClient, ...others: GameClient[]) {
  await vi.waitFor(() => expect(alice.getState().game?.players).toHaveLength(others.length + 1));
  alice.start({ rounds: 1, drawSeconds: 60 });
  await vi.waitFor(() => expect(phaseOf(alice)?.kind).toBe('choosing'));
  alice.choose(0);
  await vi.waitFor(() => {
    for (const c of [alice, ...others]) expect(phaseOf(c)?.kind).toBe('drawing');
  });
  const phase = phaseOf(alice);
  return phase?.kind === 'drawing' ? phase.word : null;
}

beforeEach(async () => {
  server = await startServer({ port: 0, room: { words: WORDS, random: () => 0, turnEndMs: 200, reconnectGraceMs: 2_000 } });
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server.close();
});

describe('GameClient + server', () => {
  it('그린 획이 다른 사람에게 그대로 보이고, 정답을 맞히면 턴이 끝난다', async () => {
    const room = randomId(10);
    const { client: alice } = connect(room, 'alice');
    await online(alice); // 먼저 들어온 사람이 방장이다
    const { client: bob } = connect(room, 'bob');
    await online(bob);
    const word = await startDrawing(alice, bob);
    expect(word).toBe('바나나우유');
    expect(phaseOf(bob)).toMatchObject({ word: null, hint: '○○○○○' });

    alice.beginStroke('#000000', 4, 100, 100);
    alice.extendStroke([110, 110, 120, 130]);
    alice.endStroke();
    alice.beginStroke('#e03131', 10, 500, 500);
    alice.undo();
    await vi.waitFor(() => expect(bob.strokes).toEqual(alice.strokes));
    expect(bob.strokes).toEqual([{ id: 1, color: '#000000', width: 4, points: [100, 100, 110, 110, 120, 130] }]);

    bob.sendChat('바나나 우유');
    await vi.waitFor(() => expect(phaseOf(bob)).toMatchObject({ kind: 'turnEnd', reason: 'allSolved' }));
    expect(bob.getState().chat.some((c) => c.kind === 'chat')).toBe(false);
  });

  it('새로고침해도(같은 토큰) 같은 자리와 지금까지의 그림으로 돌아온다', async () => {
    const room = randomId(10);
    const { client: alice } = connect(room, 'alice');
    await online(alice); // 먼저 들어온 사람이 방장이다
    const { client: bob, token } = connect(room, 'bob');
    await online(bob);
    await startDrawing(alice, bob);
    alice.beginStroke('#000000', 4, 100, 100);
    alice.extendStroke([200, 200]);
    await vi.waitFor(() => expect(bob.strokes[0]?.points).toHaveLength(4));
    const bobId = bob.getState().playerId;

    bob.close();
    await vi.waitFor(() => expect(alice.getState().game?.players[1]?.connected).toBe(false));
    const { client: again } = connect(room, 'bob', token);
    await online(again);
    expect(again.getState().playerId).toBe(bobId);
    expect(again.strokes).toEqual(alice.strokes);
    expect(again.getState().game?.players).toHaveLength(2);
    await vi.waitFor(() => expect(alice.getState().game?.players[1]?.connected).toBe(true));
  });

  it('그리는 사람의 연결이 잠깐 끊겨도 다시 붙으면 이어서 그린다', async () => {
    const room = randomId(10);
    const { client: alice } = connect(room, 'alice');
    await online(alice); // 먼저 들어온 사람이 방장이다
    const { client: bob } = connect(room, 'bob');
    await online(bob);
    await startDrawing(alice, bob);
    alice.beginStroke('#000000', 4, 100, 100);
    await vi.waitFor(() => expect(bob.strokes).toHaveLength(1));

    alice.handleNetworkOffline();
    expect(alice.beginStroke('#000000', 4, 300, 300)).toBe(false); // 끊긴 동안에는 그릴 수 없다
    alice.handleNetworkOnline();
    await online(alice);
    expect(phaseOf(alice)?.kind).toBe('drawing');

    expect(alice.beginStroke('#1c7ed6', 4, 300, 300)).toBe(true);
    await vi.waitFor(() => expect(bob.strokes).toHaveLength(2));
    expect(bob.strokes.map((s) => s.id)).toEqual([1, 2]); // 다시 붙은 뒤에도 획 id가 겹치지 않는다
  });

  it('획 하나가 점 개수 한도를 넘으면 이어지는 새 획으로 나눠서 보낸다', async () => {
    const room = randomId(10);
    const { client: alice } = connect(room, 'alice');
    await online(alice); // 먼저 들어온 사람이 방장이다
    const { client: bob } = connect(room, 'bob');
    await online(bob);
    await startDrawing(alice, bob);

    alice.beginStroke('#000000', 4, 0, 0);
    for (let i = 1; i <= LIMITS.maxCoordsPerStroke / 2 + 10; i++) alice.extendStroke([i % 1000, i % 750]);
    await vi.waitFor(() => expect(bob.strokes).toEqual(alice.strokes));
    expect(bob.strokes).toHaveLength(2);
    const [first, second] = bob.strokes;
    expect(second?.points.slice(0, 2)).toEqual(first?.points.slice(-2)); // 끊긴 곳 없이 이어진다
  });

  it('다른 탭이 같은 토큰으로 들어오면 이전 탭은 다시 연결하지 않고 멈춘다', async () => {
    const room = randomId(10);
    const { client: first, token } = connect(room, 'alice');
    await online(first);
    const { client: second } = connect(room, 'alice', token);
    await online(second);
    await vi.waitFor(() => expect(first.getState().status).toBe('closed'));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(second.getState().status).toBe('online'); // 서로 자리를 뺏으며 재접속하지 않는다
  });
});
