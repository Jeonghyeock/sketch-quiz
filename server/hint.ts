// 서버에서만 쓴다. 정답 판정과 힌트 계산은 브라우저로 내려보내지 않는다.

const CHOSEONG = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const HANGUL_FIRST = 0xac00; // 가
const HANGUL_LAST = 0xd7a3; // 힣
const SYLLABLES_PER_CHOSEONG = 21 * 28; // 중성 21개 × 종성 28개

// 공백을 무시하고 정확히 같을 때만 정답이다. 영문이 섞인 단어를 위해 대소문자도 무시한다.
export function normalizeAnswer(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, '').toLowerCase();
}

// 힌트 단계
// 0: 글자 수만 (○○○)
// 1: 한글은 초성 (ㄱㅇㅇ). 한글이 아닌 글자는 초성이 없으므로 계속 ○로 가린다.
// 2: 첫 글자까지 공개 (고ㅇㅇ)
// 공백은 단계와 관계없이 그대로 보여 준다.
export function makeHint(word: string, level: number): string {
  return [...word]
    .map((char, index) => {
      if (/\s/.test(char)) return char;
      if (level >= 2 && index === 0) return char;
      if (level >= 1) {
        const code = char.codePointAt(0) ?? 0;
        if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
          return CHOSEONG[Math.floor((code - HANGUL_FIRST) / SYLLABLES_PER_CHOSEONG)];
        }
      }
      return '○';
    })
    .join('');
}
