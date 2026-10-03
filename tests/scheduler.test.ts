/**
 * 스케줄 시간 계산 단위 테스트
 * - schedule.times로 측정 시각을 직접 지정하면 자정을 넘는 스케줄도 표현할 수 있어야 한다 (이슈 #19).
 */
import { describe, expect, it } from 'vitest';
import { getDefaultConfig } from '../src/config';
import { buildScheduleTimes } from '../src/scheduler';

function configWith(schedule: Partial<ReturnType<typeof getDefaultConfig>['schedule']>) {
  const cfg = getDefaultConfig();
  cfg.schedule = { ...cfg.schedule, ...schedule };
  return cfg;
}

describe('buildScheduleTimes', () => {
  it('keeps the start + interval behavior when times is not set', () => {
    const times = buildScheduleTimes(configWith({ time: '20:00', max_attempts: 4, retry_interval_minutes: 120 }));
    // 자정을 넘으면 중단 → 20:00, 22:00
    expect(times).toEqual([
      { hour: 20, minute: 0 },
      { hour: 22, minute: 0 },
    ]);
  });

  it('uses explicit times, including ones past midnight', () => {
    const times = buildScheduleTimes(configWith({ times: ['20:00', '22:00', '00:00', '06:30'] }));
    expect(times).toEqual([
      { hour: 20, minute: 0 },
      { hour: 22, minute: 0 },
      { hour: 0, minute: 0 },
      { hour: 6, minute: 30 },
    ]);
  });

  it('drops duplicate explicit times', () => {
    expect(buildScheduleTimes(configWith({ times: ['04:00', '4:00', '04:00'] }))).toEqual([{ hour: 4, minute: 0 }]);
  });

  it('rejects malformed explicit times', () => {
    expect(() => buildScheduleTimes(configWith({ times: ['25:00'] }))).toThrow(/schedule\.times/);
    expect(() => buildScheduleTimes(configWith({ times: ['abc'] }))).toThrow(/schedule\.times/);
  });

  it('falls back to start + interval for an empty times list', () => {
    expect(buildScheduleTimes(configWith({ time: '04:00', max_attempts: 1, times: [] }))).toEqual([{ hour: 4, minute: 0 }]);
  });
});
