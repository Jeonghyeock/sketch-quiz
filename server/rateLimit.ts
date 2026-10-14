// 토큰 버킷: capacity개까지는 몰아서 보낼 수 있고, 그 뒤로는 초당 perSecond개씩만 허용한다.
// 시각을 인자로 받을 수 있어 테스트에서 시간을 직접 움직일 수 있다.
export class TokenBucket {
  private readonly capacity: number;
  private readonly perSecond: number;
  private tokens: number;
  private updatedAt: number;

  constructor(capacity: number, perSecond: number, now = Date.now()) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now = Date.now()): boolean {
    const elapsed = Math.max(0, now - this.updatedAt);
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.perSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
