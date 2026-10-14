import { describe, expect, it } from 'vitest';
import { acceptsDrawOp, applyDrawOp } from './drawing.ts';
import { LIMITS } from './limits.ts';
import type { DrawOp, Stroke } from './protocol.ts';

const begin = (id: number, points = [0, 0, 1, 1]): DrawOp => ({ kind: 'begin', id, color: '#000000', width: 4, points });

function run(ops: DrawOp[]): Stroke[] {
  const strokes: Stroke[] = [];
  for (const op of ops) applyDrawOp(strokes, op);
  return strokes;
}

describe('applyDrawOp', () => {
  it('begin으로 획을 만들고 extend로 점을 덧붙인다', () => {
    const strokes = run([begin(1), { kind: 'extend', id: 1, points: [2, 2] }]);
    expect(strokes).toEqual([{ id: 1, color: '#000000', width: 4, points: [0, 0, 1, 1, 2, 2] }]);
  });

  it('extend는 마지막 획의 id가 같을 때만 붙는다 (지운 획에 늦게 온 점은 버린다)', () => {
    const strokes = run([begin(1), begin(2), { kind: 'undo' }, { kind: 'extend', id: 2, points: [9, 9] }]);
    expect(strokes.map((s) => s.points)).toEqual([[0, 0, 1, 1]]);
  });

  it('undo는 마지막 획을, clear는 전부를 지운다', () => {
    expect(run([begin(1), begin(2), { kind: 'undo' }]).map((s) => s.id)).toEqual([1]);
    expect(run([begin(1), begin(2), { kind: 'clear' }])).toEqual([]);
  });

  it('op의 좌표 배열을 그대로 붙잡지 않는다', () => {
    const op = begin(1);
    const strokes = run([op, { kind: 'extend', id: 1, points: [5, 5] }]);
    expect(op.kind === 'begin' && op.points).toEqual([0, 0, 1, 1]);
    expect(strokes[0]?.points).toHaveLength(6);
  });
});

describe('acceptsDrawOp', () => {
  it('획 하나의 점 개수 한도를 넘는 extend는 받지 않는다', () => {
    const strokes = run([begin(1, new Array(LIMITS.maxCoordsPerStroke - 2).fill(0))]);
    expect(acceptsDrawOp(strokes, { kind: 'extend', id: 1, points: [1, 1] })).toBe(true);
    expect(acceptsDrawOp(strokes, { kind: 'extend', id: 1, points: [1, 1, 2, 2] })).toBe(false);
  });

  it('마지막 획이 아닌 획에 대한 extend는 받지 않는다', () => {
    const strokes = run([begin(1), begin(2)]);
    expect(acceptsDrawOp(strokes, { kind: 'extend', id: 1, points: [1, 1] })).toBe(false);
  });

  it('한 턴의 획 수 한도를 넘는 begin은 받지 않는다', () => {
    const strokes = run(Array.from({ length: LIMITS.maxStrokesPerTurn }, (_, i) => begin(i + 1)));
    expect(acceptsDrawOp(strokes, begin(LIMITS.maxStrokesPerTurn + 1))).toBe(false);
    expect(acceptsDrawOp(strokes, { kind: 'undo' })).toBe(true);
  });
});
