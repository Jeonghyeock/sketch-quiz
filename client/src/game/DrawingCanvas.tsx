import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { CANVAS } from '../../../shared/limits.ts';
import type { Stroke } from '../../../shared/protocol.ts';
import type { GameClient } from './GameClient.ts';

const BACKGROUND = '#ffffff';
// 이보다 가까운 점은 버린다(가상 좌표 기준). 손떨림 수준의 점까지 보내면 메시지만 커진다.
const MIN_DISTANCE = 2;

type Props = { client: GameClient; canDraw: boolean; color: string; width: number };

// 그림은 SVG 대신 Canvas 2D로 그린다. 자유 곡선은 점이 수천 개라 DOM 노드로 두면 무겁다.
// 그림 데이터는 React 상태가 아니라 GameClient.strokes에 있고, 바뀔 때마다 새로 생긴 부분만 덧그린다.
export function DrawingCanvas({ client, canDraw, color, width }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let scale = 1;

    // E2E 테스트가 캔버스 안을 들여다볼 수 없으므로 획 수를 속성으로 노출한다.
    const updateCount = () => {
      canvas.dataset.strokes = String(client.strokes.length);
    };
    const redraw = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      for (const stroke of client.strokes) drawStroke(ctx, stroke, 0);
      updateCount();
    };
    // 고해상도 화면(devicePixelRatio > 1)에서도 선이 흐리지 않도록 실제 픽셀 수에 맞춘다.
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      scale = canvas.width / CANVAS.width;
      redraw();
    };

    const unsubscribe = client.subscribeStrokes((event) => {
      if (event.kind === 'reset' || event.op.kind === 'undo' || event.op.kind === 'clear') {
        redraw();
        return;
      }
      const stroke = client.strokes.at(-1);
      if (stroke && stroke.id === event.op.id) {
        drawStroke(ctx, stroke, event.op.kind === 'begin' ? 0 : stroke.points.length - event.op.points.length);
      }
      updateCount();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    return () => {
      unsubscribe();
      observer.disconnect();
    };
  }, [client]);

  function toPoint(event: { clientX: number; clientY: number }): [number, number] {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * CANVAS.width);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * CANVAS.height);
    return [clamp(x, 0, CANVAS.width), clamp(y, 0, CANVAS.height)];
  }

  function onPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!canDraw || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const [x, y] = toPoint(event);
    if (client.beginStroke(color, width, x, y)) drawing.current = { pointerId: event.pointerId, lastX: x, lastY: y };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const current = drawing.current;
    if (!current || current.pointerId !== event.pointerId) return;
    // 브라우저는 pointermove를 화면 주사율에 맞춰 묶어서 보낸다. 묶인 점까지 꺼내 써야 빠르게 그어도 선이 부드럽다.
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    const points: number[] = [];
    for (const e of coalesced.length > 0 ? coalesced : [event.nativeEvent]) {
      const [x, y] = toPoint(e);
      if (Math.hypot(x - current.lastX, y - current.lastY) < MIN_DISTANCE) continue;
      points.push(x, y);
      current.lastX = x;
      current.lastY = y;
    }
    if (points.length > 0 && !client.extendStroke(points)) drawing.current = null;
  }

  function onPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (drawing.current?.pointerId !== event.pointerId) return;
    drawing.current = null;
    client.endStroke();
  }

  return (
    <canvas
      ref={canvasRef}
      className={`drawing-canvas${canDraw ? ' can-draw' : ''}`}
      aria-label="그림판"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

// from: 이 좌표 인덱스부터 새로 생긴 부분. 앞 점과 이어지도록 한 점 앞에서 시작한다.
function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, from: number): void {
  const p = stroke.points;
  if (p.length === 2) {
    // 점 하나(톡 찍기)는 원으로 그린다.
    ctx.fillStyle = stroke.color;
    ctx.beginPath();
    ctx.arc(p[0]!, p[1]!, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const start = Math.max(0, from - 2);
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[start]!, p[start + 1]!);
  for (let i = start + 2; i < p.length; i += 2) ctx.lineTo(p[i]!, p[i + 1]!);
  ctx.stroke();
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
