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
