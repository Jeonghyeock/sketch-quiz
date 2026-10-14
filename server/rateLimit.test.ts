import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rateLimit.ts';

describe('TokenBucket', () => {
  it('용량만큼은 몰아서 허용하고 그다음은 거절한다', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([1, 2, 3, 4].map(() => bucket.take(0))).toEqual([true, true, true, false]);
  });

  it('시간이 지나면 초당 정해진 만큼 다시 채워지고, 용량을 넘지 않는다', () => {
    const bucket = new TokenBucket(3, 2, 0);
    for (let i = 0; i < 3; i++) bucket.take(0);
    expect(bucket.take(250)).toBe(false); // 0.5개
    expect(bucket.take(500)).toBe(true); // 1개
    const later = 60_000;
    expect([1, 2, 3, 4].map(() => bucket.take(later))).toEqual([true, true, true, false]);
  });
});
