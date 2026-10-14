// 클라이언트도 참조하는 값이라 zod 스키마(protocol.ts)와 분리해 둔다. 번들에 zod가 딸려 들어가지 않게 하기 위해서다.
export const LIMITS = {
  maxPlayersPerRoom: 10,
  maxNameLength: 16,
  maxChatLength: 100,
  maxOpsPerDraw: 200,
  maxCoordsPerStroke: 4000, // 점 2000개 (x, y 평탄화)
  maxStrokesPerTurn: 2000,
  maxCoordsPerTurn: 200_000,
  maxMessageBytes: 64 * 1024,
} as const;

// 캔버스의 가상 해상도. 화면 크기와 관계없이 좌표는 이 범위의 정수로 주고받는다.
export const CANVAS = { width: 1000, height: 750 } as const;

export const DEFAULT_SETTINGS = { rounds: 3, drawSeconds: 80 } as const;
