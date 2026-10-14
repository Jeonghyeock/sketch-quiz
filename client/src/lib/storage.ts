import { randomId } from '../../../shared/id.ts';
import { LIMITS } from '../../../shared/limits.ts';

// localStorage·sessionStorage는 사생활 보호 모드 등에서 예외를 던질 수 있다. 실패해도 앱은 동작해야 한다.
function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(key);
    else storage().setItem(key, value);
  } catch {
    // 저장하지 못해도 현재 화면에서는 문제없다.
  }
}

const local = () => localStorage;
const session = () => sessionStorage;

const ADJECTIVES = ['용감한', '졸린', '배고픈', '신나는', '차분한', '수줍은', '똑똑한', '느긋한', '부지런한', '엉뚱한'];
const ANIMALS = ['수달', '고양이', '펭귄', '여우', '판다', '다람쥐', '고래', '부엉이', '해달', '토끼'];
const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;

export function loadName(): string {
  const saved = read(local, 'sketch-quiz:name')?.trim();
  if (saved) return saved.slice(0, LIMITS.maxNameLength);
  return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

export function saveName(name: string): void {
  write(local, 'sketch-quiz:name', name.trim().slice(0, LIMITS.maxNameLength));
}

// 재접속용 토큰은 방마다, 탭마다 따로 둔다(sessionStorage).
// 새로고침하면 같은 자리로 돌아오고, 새 탭으로 열면 새 참가자가 된다.
const tokenKey = (roomId: string) => `sketch-quiz:token:${roomId}`;

export function loadToken(roomId: string): string | null {
  return read(session, tokenKey(roomId));
}

export function createToken(roomId: string): string {
  const token = randomId(24);
  write(session, tokenKey(roomId), token);
  return token;
}

export function forgetToken(roomId: string): void {
  write(session, tokenKey(roomId), null);
}
