import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEntry, DrawOp, GameState, HelloMessage, ServerMessage, Settings } from '../shared/protocol.ts';
import { Room, type Connection, type RoomOptions } from './room.ts';

// 타이머는 vitest 가짜 시계로 움직인다. Room은 전역 setTimeout/Date.now만 쓰므로 그대로 따라온다.

class FakeConnection implements Connection {
  received: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  send(message: ServerMessage) {
    // 실제 서버는 보내는 순간 직렬화한다. 나중에 바뀌는 배열을 붙잡지 않도록 복사해 둔다.
    this.received.push(structuredClone(message));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  get playerId(): string {
    const welcome = this.received.find((m) => m.type === 'welcome');
    return welcome?.type === 'welcome' ? welcome.playerId : '';
  }
  get state(): GameState {
    const last = this.received.filter((m) => m.type === 'state' || m.type === 'welcome').at(-1);
    if (!last || (last.type !== 'state' && last.type !== 'welcome')) throw new Error('no state yet');
    return last.state;
  }
  get chats(): ChatEntry[] {
    return this.received.flatMap((m) => (m.type === 'chat' ? [m.entry] : []));
  }
  get drawOps(): DrawOp[] {
    return this.received.flatMap((m) => (m.type === 'draw' ? m.ops : []));
  }
  me() {
    return this.state.players.find((p) => p.id === this.playerId)!;
  }
}

// 이름·안내 문구와 겹칠 수 없는 단어를 쓴다. random이 0이면 남은 단어 중 맨 앞부터 고른다.
const WORDS = ['바나나우유', '자전거길', '사과나무', '눈사람집', '고양이밥', '해바라기씨'];
const SETTINGS: Settings = { rounds: 1, drawSeconds: 60 };

const tokenOf = (name: string) => `token${name}`.padEnd(20, '0');
const hello = (name: string): HelloMessage => ({ type: 'hello', roomId: 'room0001', token: tokenOf(name), name });

function setup(names = ['alice', 'bob', 'carol'], options: RoomOptions = {}) {
  const room = new Room('room0001', {
    choosingMs: 10_000,
    turnEndMs: 3_000,
    reconnectGraceMs: 5_000,
    words: WORDS,
    random: () => 0,
    ...options,
  });
  const conns = names.map((name) => {
    const conn = new FakeConnection();
    room.join(conn, hello(name));
    return conn;
  });
  return { room, conns };
}

// 방장(첫 번째 사람)이 시작하고 첫 번째 후보를 고른다. 첫 턴은 방장이 그린다.
function startDrawing(room: Room, host: FakeConnection, settings = SETTINGS) {
  room.handle(host, { type: 'start', settings });
  room.handle(host, { type: 'choose', index: 0 });
}

const stroke: DrawOp = { kind: 'begin', id: 1, color: '#000000', width: 4, points: [10, 10, 20, 20] };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('게임 진행', () => {
  it('방장만, 접속한 사람이 두 명 이상일 때 시작할 수 있다', () => {
    const { room, conns } = setup(['alice']);
    const [alice] = conns as [FakeConnection];
    room.handle(alice, { type: 'start', settings: SETTINGS });
    expect(alice.state.phase.kind).toBe('lobby');

    const bob = new FakeConnection();
    room.join(bob, hello('bob'));
    room.handle(bob, { type: 'start', settings: SETTINGS });
    expect(bob.state.phase.kind).toBe('lobby');

    room.handle(alice, { type: 'start', settings: SETTINGS });
    expect(bob.state.phase).toMatchObject({ kind: 'choosing', drawerId: alice.playerId });
    expect(bob.state.round).toBe(1);
  });

  it('단어 후보는 그리는 사람에게만 보낸다', () => {
    const { room, conns } = setup();
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    room.handle(alice, { type: 'start', settings: SETTINGS });
    expect(alice.state.phase).toMatchObject({ choices: ['바나나우유', '자전거길', '사과나무'] });
    expect(bob.state.phase).toMatchObject({ kind: 'choosing', choices: null });
  });

  it('시간 안에 고르지 않으면 서버가 대신 고른다', () => {
    const { room, conns } = setup();
    const [alice] = conns as [FakeConnection];
    room.handle(alice, { type: 'start', settings: SETTINGS });
    vi.advanceTimersByTime(10_000);
    expect(alice.state.phase).toMatchObject({ kind: 'drawing', word: '바나나우유' });
  });

  it('힌트는 시간이 지나면서 글자 수 → 초성 → 첫 글자로 바뀐다', () => {
    const { room, conns } = setup();
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice);
    expect(bob.state.phase).toMatchObject({ hint: '○○○○○', word: null, remainingMs: 60_000 });
    vi.advanceTimersByTime(30_000);
    expect(bob.state.phase).toMatchObject({ hint: 'ㅂㄴㄴㅇㅇ', remainingMs: 30_000 });
    vi.advanceTimersByTime(15_000);
    expect(bob.state.phase).toMatchObject({ hint: '바ㄴㄴㅇㅇ' });
    vi.advanceTimersByTime(15_000);
    expect(bob.state.phase).toMatchObject({ kind: 'turnEnd', reason: 'timeout', word: '바나나우유' });
  });

  it('정답을 맞히기 전에는 정답·후보 단어·남의 토큰이 어떤 메시지에도 담기지 않는다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(alice, { type: 'draw', ops: [stroke] });
    vi.advanceTimersByTime(46_000); // 힌트 두 단계가 모두 공개된 뒤
    const nearMisses = ['바나나우유?', '바나나우유!!', '바나나 우유ㅋㅋ'];
    for (const text of nearMisses) room.handle(bob, { type: 'chat', text }); // 정답이 들어 있지만 정답은 아닌 말
    room.handle(bob, { type: 'chat', text: '바나나우유' }); // bob이 맞힌다
    room.handle(bob, { type: 'chat', text: '정답은 바나나우유' }); // 맞힌 사람끼리의 대화
    room.handle(alice, { type: 'chat', text: '바나나우유 맞아요' }); // 그리는 사람의 대화

    const seenByCarol = JSON.stringify(carol.received);
    for (const word of ['바나나우유', '자전거길', '사과나무']) expect(seenByCarol).not.toContain(word);
    for (const name of ['alice', 'bob']) expect(seenByCarol).not.toContain(tokenOf(name));
    expect(JSON.stringify(alice.received)).not.toContain(tokenOf('alice'));
    // 정답이 들어 있는 말은 버리지 않고 보낸 사람에게만 돌려준다(보낸 사람 화면에는 평범한 오답으로 보인다).
    const sentBack = bob.chats.flatMap((c) => (c.kind === 'chat' && !c.solvedOnly ? [c.text] : []));
    expect(sentBack).toEqual(nearMisses);

    vi.advanceTimersByTime(14_000); // 시간 종료 → 이제 모두에게 공개
    expect(carol.state.phase).toMatchObject({ kind: 'turnEnd', word: '바나나우유' });
  });

  it('정답은 채팅으로 내보내지 않고, 빨리 맞힐수록 점수를 많이 준다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'chat', text: ' 바나나 우유 ' }); // 공백은 무시한다
    vi.advanceTimersByTime(30_000);
    room.handle(carol, { type: 'chat', text: '바나나우유' });

    for (const conn of [alice, bob, carol]) {
      expect(conn.chats.filter((c) => c.kind === 'chat')).toHaveLength(0);
      expect(conn.chats.filter((c) => c.kind === 'system' && c.tone === 'success')).toHaveLength(3); // 시작 + 두 명
    }
    expect(bob.me()).toMatchObject({ score: 300, solved: true });
    expect(carol.me()).toMatchObject({ score: 200, solved: true });
    expect(alice.me().score).toBe(100); // 맞힌 사람 한 명당 50점
  });

  it('정답을 아는 사람의 채팅은 정답을 아는 사람끼리만 본다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    room.handle(bob, { type: 'chat', text: '쉽네요' });
    room.handle(alice, { type: 'chat', text: '그렇죠' });
    room.handle(carol, { type: 'chat', text: '모르겠다' });

    const texts = (conn: FakeConnection) => conn.chats.flatMap((c) => (c.kind === 'chat' ? [c.text] : []));
    expect(texts(alice)).toEqual(['쉽네요', '그렇죠', '모르겠다']);
    expect(texts(bob)).toEqual(['쉽네요', '그렇죠', '모르겠다']);
    expect(texts(carol)).toEqual(['모르겠다']);
    expect(alice.chats.find((c) => c.kind === 'chat' && c.text === '쉽네요')).toMatchObject({ solvedOnly: true });
  });

  it('모두 맞히면 시간을 기다리지 않고 턴을 끝내고, 결과 화면 뒤에 다음 사람 차례가 된다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice, { rounds: 2, drawSeconds: 60 });
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    expect(bob.state.phase).toMatchObject({
      kind: 'turnEnd',
      reason: 'allSolved',
      gained: { [bob.playerId]: 300, [alice.playerId]: 50 },
    });
    vi.advanceTimersByTime(3_000);
    expect(bob.state.phase).toMatchObject({ kind: 'choosing', drawerId: bob.playerId });
    expect(bob.state.phase.kind === 'choosing' && bob.state.phase.choices).toEqual(['자전거길', '사과나무', '눈사람집']);
  });

  it('라운드를 모두 돌면 게임이 끝나고, 라운드 중간에 들어온 사람은 다음 라운드부터 그린다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    room.handle(alice, { type: 'start', settings: { rounds: 2, drawSeconds: 20 } });
    const dave = new FakeConnection();
    room.join(dave, hello('dave'));

    const drawers: string[] = [];
    while (alice.state.phase.kind !== 'gameEnd') {
      const phase = alice.state.phase;
      if (phase.kind === 'choosing' && drawers.at(-1) !== phase.drawerId) drawers.push(phase.drawerId);
      vi.advanceTimersByTime(1_000);
    }
    expect(drawers).toEqual([alice.playerId, bob.playerId, alice.playerId, bob.playerId, dave.playerId]);
    expect(dave.chats.at(-1)).toMatchObject({ kind: 'system', tone: 'success' });
  });

  it('게임이 끝나면 방장이 같은 방에서 새 게임을 시작할 수 있고, 점수는 0부터 다시 센다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    vi.advanceTimersByTime(3_000 + 10_000 + 60_000 + 3_000); // 결과 → bob 차례(자동 선택, 시간 종료) → 결과
    expect(bob.state.phase.kind).toBe('gameEnd');
    expect(bob.me().score).toBeGreaterThan(0);

    room.handle(alice, { type: 'start', settings: SETTINGS });
    expect(bob.state.phase.kind).toBe('choosing');
    expect(bob.state.players.map((p) => p.score)).toEqual([0, 0]);
  });
});

describe('그림', () => {
  it('그리는 사람이 그리기 단계에서 보낸 획만 받아서 나머지에게 전달한다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    room.handle(alice, { type: 'start', settings: SETTINGS });
    room.handle(alice, { type: 'draw', ops: [stroke] }); // 아직 고르는 중
    room.handle(alice, { type: 'choose', index: 0 });
    room.handle(bob, { type: 'draw', ops: [stroke] }); // 그리는 사람이 아님
    expect(carol.drawOps.filter((op) => op.kind !== 'clear')).toEqual([]);

    room.handle(alice, { type: 'draw', ops: [stroke, { kind: 'extend', id: 1, points: [30, 30] }] });
    expect(carol.drawOps.filter((op) => op.kind !== 'clear')).toHaveLength(2);
    expect(alice.drawOps.filter((op) => op.kind !== 'clear')).toEqual([]); // 그린 사람에게는 되돌려 보내지 않는다
  });

  it('늦게 들어오거나 새로고침한 사람은 지금까지의 그림을 한 번에 받는다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice] = conns as [FakeConnection];
    startDrawing(room, alice);
    room.handle(alice, { type: 'draw', ops: [stroke, { kind: 'extend', id: 1, points: [30, 30] }] });
    const dave = new FakeConnection();
    room.join(dave, hello('dave'));
    const welcome = dave.received[0];
    expect(welcome?.type === 'welcome' && welcome.strokes).toEqual([
      { id: 1, color: '#000000', width: 4, points: [10, 10, 20, 20, 30, 30] },
    ]);
  });

  it('턴이 바뀌면 그림을 지운다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice, { rounds: 2, drawSeconds: 60 });
    room.handle(alice, { type: 'draw', ops: [stroke] });
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    vi.advanceTimersByTime(3_000);
    expect(bob.drawOps.at(-1)).toEqual({ kind: 'clear' });
    const dave = new FakeConnection();
    room.join(dave, hello('dave'));
    const welcome = dave.received[0];
    expect(welcome?.type === 'welcome' && welcome.strokes).toEqual([]);
  });
});

describe('접속과 퇴장', () => {
  it('끊긴 사람은 유예 시간 동안 자리와 점수를 지키고, 같은 토큰으로 돌아오면 이어서 한다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(alice, { type: 'draw', ops: [stroke] });
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    const bobId = bob.playerId;

    room.disconnect(bob);
    expect(carol.state.players.find((p) => p.id === bobId)).toMatchObject({ connected: false, score: 300 });
    vi.advanceTimersByTime(4_000);

    const again = new FakeConnection();
    room.join(again, hello('bob'));
    expect(again.playerId).toBe(bobId);
    expect(again.me()).toMatchObject({ connected: true, score: 300, solved: true });
    expect(again.state.phase).toMatchObject({ kind: 'drawing', word: '바나나우유' }); // 이미 맞혔으므로 정답이 보인다
    const welcome = again.received[0];
    expect(welcome?.type === 'welcome' && welcome.strokes).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(carol.state.players).toHaveLength(3); // 돌아왔으므로 유예 타이머가 취소됐다
  });

  it('유예 시간이 지나면 내보내고, 그리는 사람이었으면 턴을 끝낸다', () => {
    const { room, conns } = setup();
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.disconnect(alice);
    expect(bob.state.phase.kind).toBe('drawing'); // 잠깐 끊긴 것일 수 있으니 계속 진행
    vi.advanceTimersByTime(5_000);
    expect(bob.state.phase).toMatchObject({ kind: 'turnEnd', reason: 'drawerLeft' });
    expect(bob.state.players).toHaveLength(2);
  });

  it('재접속을 기다리는 사람은 그릴 차례를 건너뛴다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice, { rounds: 2, drawSeconds: 60 });
    room.disconnect(bob); // 다음 차례인 bob이 끊겼다
    room.handle(carol, { type: 'chat', text: '바나나우유' }); // 접속한 사람이 모두 맞혀 턴 종료
    vi.advanceTimersByTime(3_000);
    expect(carol.state.phase).toMatchObject({ kind: 'choosing', drawerId: carol.playerId });
  });

  it('못 맞힌 사람이 끊겨도 바로 턴을 끝내지 않고, 유예 시간 안에 돌아오면 턴이 이어진다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    room.disconnect(carol); // 마지막으로 남은 못 맞힌 사람이 새로고침
    expect(bob.state.phase.kind).toBe('drawing');
    vi.advanceTimersByTime(4_000);

    const again = new FakeConnection();
    room.join(again, hello('carol'));
    expect(again.state.phase).toMatchObject({ kind: 'drawing', word: null });
    vi.advanceTimersByTime(5_000); // 원래 유예 시간이 끝났을 시점이 지나도
    expect(bob.state.phase.kind).toBe('drawing');
  });

  it('끊긴 사람이 유예 시간 안에 돌아오지 않으면, 그 사람을 빼고 모두 맞혔으므로 턴을 끝낸다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'chat', text: '바나나우유' });
    room.disconnect(carol);
    expect(bob.state.phase.kind).toBe('drawing');
    vi.advanceTimersByTime(5_000);
    expect(bob.state.phase).toMatchObject({ kind: 'turnEnd', reason: 'allSolved' });
  });

  it('게임 중에 두 명 미만이 되면 대기실로 돌아간다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    startDrawing(room, alice);
    room.handle(bob, { type: 'leave' });
    expect(alice.state.phase.kind).toBe('lobby');
    expect(alice.chats.at(-1)).toMatchObject({ kind: 'system', tone: 'warning' });
    vi.advanceTimersByTime(120_000);
    expect(alice.state.phase.kind).toBe('lobby'); // 남은 타이머가 없다
  });

  it('방장이 나가면 다음 사람이 방장이 된다', () => {
    const { room, conns } = setup();
    const [alice, bob, carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    room.handle(alice, { type: 'leave' });
    expect(carol.state.hostId).toBe(bob.playerId);
  });

  it('같은 토큰으로 다시 접속하면 이전 연결을 닫는다', () => {
    const { room, conns } = setup();
    const [alice, , carol] = conns as [FakeConnection, FakeConnection, FakeConnection];
    const again = new FakeConnection();
    room.join(again, hello('alice'));
    expect(alice.closed?.code).toBe(4000);
    expect(carol.state.players).toHaveLength(3);
    room.disconnect(alice); // 닫힌 이전 연결의 close 이벤트가 늦게 와도 새 연결에 영향이 없다
    expect(carol.state.players.find((p) => p.id === again.playerId)?.connected).toBe(true);
  });

  it('방이 가득 차면 새로 들어오는 사람을 거절한다', () => {
    const names = Array.from({ length: 10 }, (_, i) => `player${i}`);
    const { room } = setup(names);
    const late = new FakeConnection();
    room.join(late, hello('late'));
    expect(late.closed?.code).toBe(4003);
  });

  it('마지막 사람이 나가면 방을 정리한다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    const onEmpty = vi.fn();
    room.onEmpty = onEmpty;
    room.handle(alice, { type: 'leave' });
    room.disconnect(bob);
    vi.advanceTimersByTime(5_000);
    expect(onEmpty).toHaveBeenCalledOnce();
  });
});

describe('채팅 속도 제한', () => {
  it('너무 빨리 보내면 버리고 보낸 사람에게만 알린다', () => {
    const { room, conns } = setup(['alice', 'bob']);
    const [alice, bob] = conns as [FakeConnection, FakeConnection];
    for (let i = 0; i < 6; i++) room.handle(alice, { type: 'chat', text: `메시지${i}` });
    expect(bob.chats.filter((c) => c.kind === 'chat')).toHaveLength(5);
    expect(alice.chats.at(-1)).toMatchObject({ kind: 'system', tone: 'warning' });
    expect(bob.chats.some((c) => c.kind === 'system' && c.tone === 'warning')).toBe(false);

    vi.advanceTimersByTime(1_000);
    room.handle(alice, { type: 'chat', text: '다시' });
    expect(bob.chats.at(-1)).toMatchObject({ kind: 'chat', text: '다시' });
  });
});
