import { LIMITS } from './limits.ts';
import type { DrawOp, Stroke } from './protocol.ts';

// 서버와 클라이언트가 똑같이 쓰는 획 reducer.
// 그리는 동안 초당 수십 번 호출되므로 새 배열을 만들지 않고 제자리에서 고친다.
//
// - extend는 마지막 획의 id가 같을 때만 붙는다. 실행 취소로 지운 획에 늦게 도착한 점이 다른 획에 붙지 않는다.
// - undo는 마지막 획을, clear는 전부를 지운다. 그리는 사람이 한 명뿐이라 순서 충돌이 없다.
export function applyDrawOp(strokes: Stroke[], op: DrawOp): void {
  switch (op.kind) {
    case 'begin':
      strokes.push({ id: op.id, color: op.color, width: op.width, points: [...op.points] });
      break;
    case 'extend': {
      const last = strokes.at(-1);
      if (last && last.id === op.id) last.points.push(...op.points);
      break;
    }
    case 'undo':
      strokes.pop();
      break;
    case 'clear':
      strokes.length = 0;
      break;
  }
}

// 한도를 넘는 op인지. 서버와 클라이언트가 같은 기준을 써야 그린 사람의 화면과 보는 사람의 화면이 어긋나지 않는다.
export function acceptsDrawOp(strokes: readonly Stroke[], op: DrawOp): boolean {
  switch (op.kind) {
    case 'begin':
      return (
        strokes.length < LIMITS.maxStrokesPerTurn &&
        countCoords(strokes) + op.points.length <= LIMITS.maxCoordsPerTurn
      );
    case 'extend': {
      const last = strokes.at(-1);
      return (
        last !== undefined &&
        last.id === op.id &&
        last.points.length + op.points.length <= LIMITS.maxCoordsPerStroke &&
        countCoords(strokes) + op.points.length <= LIMITS.maxCoordsPerTurn
      );
    }
    case 'undo':
    case 'clear':
      return true;
  }
}

export function countCoords(strokes: readonly Stroke[]): number {
  let total = 0;
  for (const stroke of strokes) total += stroke.points.length;
  return total;
}
