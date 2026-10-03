/**
 * kt.ts 로그인 URL 판별 단위 테스트
 * - accounts.kt.com 로그인 페이지 여부를 호스트 기준으로 판별해야 한다 (쿼리스트링에 섞인 URL에 속지 않음).
 */
import { describe, expect, it } from 'vitest';
import { isKtAccountsUrl, isPasswordChangeUrl, redactUrl } from '../src/kt';

describe('redactUrl', () => {
  it('keeps only host and path so error messages sent to Discord/Telegram do not leak query or fragment', () => {
    expect(
      redactUrl('https://accounts.kt.com/wamui/AthWeb.do?urlcd=https%3A%2F%2Fspeed.kt.com&token=secret#frag'),
    ).toBe('accounts.kt.com/wamui/AthWeb.do');
    expect(redactUrl('https://accounts.kt.com/login/id')).toBe('accounts.kt.com/login/id');
  });

  it('falls back to a placeholder for unparsable URLs', () => {
    expect(redactUrl('not a url?id=me')).toBe('-');
  });
});

describe('isKtAccountsUrl', () => {
  it('detects KT login pages, including the 2026-10 login method selection and id login pages', () => {
    expect(
      isKtAccountsUrl('https://accounts.kt.com/wamui/AthWeb.do?urlcd=https%3A%2F%2Fspeed.kt.com%2Fsla%2Fslatest%2Fintroduce.asp'),
    ).toBe(true);
    expect(isKtAccountsUrl('https://accounts.kt.com/login/id')).toBe(true);
  });

  it('does not treat speed.kt.com pages as login pages even when accounts.kt.com appears in the query', () => {
    expect(isKtAccountsUrl('https://speed.kt.com/sla/slatest/introduce.asp')).toBe(false);
    expect(isKtAccountsUrl('https://speed.kt.com/sla/slatest/introduce.asp?from=accounts.kt.com')).toBe(false);
  });

  it('returns false for unparsable URLs', () => {
    expect(isKtAccountsUrl('')).toBe(false);
    expect(isKtAccountsUrl('about:blank')).toBe(false);
  });
});

describe('isPasswordChangeUrl', () => {
  it('detects password change notice pages', () => {
    expect(isPasswordChangeUrl('https://accounts.kt.com/unchanged-password')).toBe(true);
    expect(isPasswordChangeUrl('https://accounts.kt.com/change-password?next=x')).toBe(true);
  });

  it('ignores normal pages', () => {
    expect(isPasswordChangeUrl('https://accounts.kt.com/login/id')).toBe(false);
    expect(isPasswordChangeUrl('https://speed.kt.com/sla/slatest/introduce.asp')).toBe(false);
  });
});
