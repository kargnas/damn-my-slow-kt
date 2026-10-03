/**
 * db.ts 단위 테스트
 * - getTodayRecords(): UTC로 저장된 measured_at과 타임존 로컬 날짜 비교가
 *   올바르게 동작해야 함 (이슈 #5)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpeedDatabase, SpeedRecord } from '../src/db';

function makeRecord(overrides: Partial<SpeedRecord>): Omit<SpeedRecord, 'id'> {
  return {
    isp: 'kt',
    measured_at: new Date().toISOString(),
    download_mbps: 100,
    upload_mbps: 100,
    ping_ms: 10,
    sla_result: 'fail',
    complaint_filed: true,
    complaint_result: 'success',
    raw_data: '{}',
    error: '',
    ...overrides,
  };
}

describe('SpeedDatabase.getTodayRecords (timezone-aware)', () => {
  let tmpDir: string;
  let db: SpeedDatabase;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsk-db-'));
    db = new SpeedDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats UTC record from KST early morning as today (issue #5)', () => {
    // KST 2026-04-18 04:00 = UTC 2026-04-17 19:00
    const utcEarlyMorning = '2026-04-17T19:00:00.000Z';
    db.save(makeRecord({ measured_at: utcEarlyMorning }));

    // 같은 KST 날짜(2026-04-18)의 06:00 = UTC 2026-04-17 21:00 시점 기준으로 조회
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T21:00:00.000Z'));
    try {
      const records = db.getTodayRecords('Asia/Seoul');
      expect(records).toHaveLength(1);
      expect(records[0].measured_at).toBe(utcEarlyMorning);
    } finally {
      vi.useRealTimers();
    }
  });

  it('hasTodayComplaintSuccess returns true for KST early-morning success', () => {
    db.save(
      makeRecord({
        measured_at: '2026-04-17T19:00:00.000Z', // KST 2026-04-18 04:00
        complaint_result: 'success',
      })
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T21:00:00.000Z')); // KST 06:00
    try {
      expect(db.hasTodayComplaintSuccess('Asia/Seoul')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes records from previous KST day', () => {
    // KST 2026-04-17 23:00 = UTC 2026-04-17 14:00 (어제)
    db.save(makeRecord({ measured_at: '2026-04-17T14:00:00.000Z' }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T21:00:00.000Z')); // KST 2026-04-18 06:00
    try {
      const records = db.getTodayRecords('Asia/Seoul');
      expect(records).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * 자정을 넘는 사용 사이클 (이슈 #19)
 * PC를 매일 18:00~02:30(KST)에 켜고 schedule.times로 매시 측정하면, 달력 날짜 기준으로
 * 자정 이후 측정분은 다음 날 저녁 측정분과 같은 날로 묶인다. 첫날만 횟수가 적고 이후로는 매일 채워진다.
 */
describe('SpeedDatabase.getTodayRecords (cross-midnight usage cycle)', () => {
  let tmpDir: string;
  let db: SpeedDatabase;

  // KST 시각 → UTC ISO (KST = UTC+9)
  const kst = (date: string, hour: number) =>
    new Date(Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00+09:00`)).toISOString();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmsk-db-'));
    db = new SpeedDatabase(path.join(tmpDir, 'test.db'));
    // 1일차 저녁 세션: 10/01 18~23시 + 10/02 00~02시
    for (const h of [18, 19, 20, 21, 22, 23]) db.save(makeRecord({ measured_at: kst('2026-10-01', h), complaint_result: 'not_applicable' }));
    for (const h of [0, 1, 2]) db.save(makeRecord({ measured_at: kst('2026-10-02', h), complaint_result: h === 1 ? 'success' : 'not_applicable' }));
    // 2일차 저녁 세션: 10/02 18~22시
    for (const h of [18, 19, 20, 21, 22]) db.save(makeRecord({ measured_at: kst('2026-10-02', h), complaint_result: 'not_applicable' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('counts the first evening alone, then post-midnight + next evening as one day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(kst('2026-10-01', 23)));
    expect(db.getTodayRecords('Asia/Seoul')).toHaveLength(6);

    vi.setSystemTime(new Date(Date.parse(kst('2026-10-02', 22)) + 30 * 60 * 1000)); // 10/02 22:30
    // 10/02 00~02시(3회) + 18~22시(5회) — 다음 23시 측정으로 9회, 그다음 날부터는 매일 같은 패턴
    expect(db.getTodayRecords('Asia/Seoul')).toHaveLength(8);
  });

  it('a complaint success after midnight applies to that calendar day only', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(kst('2026-10-02', 20)));
    expect(db.hasTodayComplaintSuccess('Asia/Seoul')).toBe(true); // 같은 날 저녁 측정은 스킵

    vi.setSystemTime(new Date(kst('2026-10-03', 0)));
    expect(db.hasTodayComplaintSuccess('Asia/Seoul')).toBe(false); // 다음 날 자정부터 다시 감면 기회
  });
});
