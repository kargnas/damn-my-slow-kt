/**
 * updater.ts 버전 비교 단위 테스트
 * - 로컬 빌드처럼 prerelease가 붙은 버전(0.5.28-idlogin.1)을 NaN으로 비교해 잘못된 업데이트 안내를 띄우지 않아야 한다 (이슈 #19).
 */
import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/updater';

describe('compareVersions', () => {
  it('compares major/minor/patch numerically', () => {
    expect(compareVersions('0.5.28', '0.5.27')).toBeGreaterThan(0);
    expect(compareVersions('0.5.9', '0.5.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.5.28', '0.5.28')).toBe(0);
  });

  it('does not nag a local prerelease build about the release it was built from (issue #19)', () => {
    expect(compareVersions('0.5.28', '0.5.28-idlogin.1')).toBe(0);
  });

  it('still compares core versions around a prerelease build', () => {
    expect(compareVersions('0.5.29', '0.5.28-idlogin.1')).toBeGreaterThan(0);
    expect(compareVersions('0.5.27', '0.5.28-idlogin.1')).toBeLessThan(0);
    expect(compareVersions('0.5.28', '0.5.29-idlogin.1')).toBeLessThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('0.5.28+build.5', '0.5.28')).toBe(0);
  });
});
