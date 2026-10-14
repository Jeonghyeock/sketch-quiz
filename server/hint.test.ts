import { describe, expect, it } from 'vitest';
import { makeHint, normalizeAnswer } from './hint.ts';

describe('normalizeAnswer', () => {
  it('공백과 대소문자를 무시한다', () => {
    expect(normalizeAnswer(' 아이스 크림 ')).toBe(normalizeAnswer('아이스크림'));
    expect(normalizeAnswer('TV')).toBe('tv');
  });

  it('자모가 분리된 입력(NFD)도 같은 글자로 본다', () => {
    expect(normalizeAnswer('고양이'.normalize('NFD'))).toBe('고양이');
  });
});

describe('makeHint', () => {
  it('단계 0은 글자 수만, 1은 초성, 2는 첫 글자까지 보여 준다', () => {
    expect(makeHint('고양이', 0)).toBe('○○○');
    expect(makeHint('고양이', 1)).toBe('ㄱㅇㅇ');
    expect(makeHint('고양이', 2)).toBe('고ㅇㅇ');
  });

  it('된소리와 한글 범위 양 끝의 초성을 맞게 계산한다', () => {
    expect(makeHint('까치', 1)).toBe('ㄲㅊ');
    expect(makeHint('가힣', 1)).toBe('ㄱㅎ');
  });

  it('한글이 아닌 글자는 초성 단계에서도 가리고, 공백은 항상 보여 준다', () => {
    expect(makeHint('TV 리모컨', 0)).toBe('○○ ○○○');
    expect(makeHint('TV 리모컨', 1)).toBe('○○ ㄹㅁㅋ');
    expect(makeHint('TV 리모컨', 2)).toBe('T○ ㄹㅁㅋ');
  });
});
