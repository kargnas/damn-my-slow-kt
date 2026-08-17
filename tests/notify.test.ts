/**
 * notify.ts 단위 테스트
 * - Slack 웹훅 페이로드 형식과 실패 처리 확인 (네트워크는 axios 모킹)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { notifySlack, formatRecord } from '../src/notify';
import { SpeedRecord } from '../src/db';

vi.mock('axios');

const baseRecord: SpeedRecord = {
  isp: 'kt',
  measured_at: '2026-08-17 04:00:00',
  download_mbps: 432.1,
  upload_mbps: 0,
  ping_ms: 0,
  sla_result: 'fail',
  complaint_filed: true,
  complaint_result: 'success',
  raw_data: '{}',
  error: '',
};

describe('notifySlack', () => {
  beforeEach(() => {
    vi.mocked(axios.post).mockReset();
  });

  it('should return false without calling axios when webhook is empty', async () => {
    const ok = await notifySlack('', baseRecord);

    expect(ok).toBe(false);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('should post mrkdwn text payload to the webhook URL', async () => {
    vi.mocked(axios.post).mockResolvedValueOnce({ data: 'ok' });

    const ok = await notifySlack('https://hooks.slack.com/services/T0/B0/xxx', baseRecord);

    expect(ok).toBe(true);
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = vi.mocked(axios.post).mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T0/B0/xxx');
    const text = (payload as { text: string }).text;
    // Slack mrkdwn: Discord용 **볼드**가 *볼드*로 변환되어야 함
    expect(text).not.toContain('**');
    expect(text).toContain('*인터넷 속도 측정 결과*');
    expect(text).toContain('432.1 Mbps');
    expect(text).toContain('이의신청: 완료');
  });

  it('should return false when the webhook request fails', async () => {
    vi.mocked(axios.post).mockRejectedValueOnce(new Error('boom'));

    const ok = await notifySlack('https://hooks.slack.com/services/T0/B0/xxx', baseRecord);

    expect(ok).toBe(false);
  });
});

describe('formatRecord', () => {
  it('should render error records with the error message', () => {
    const text = formatRecord({ ...baseRecord, error: '측정 실패' });

    expect(text).toContain('인터넷 속도 측정 실패');
    expect(text).toContain('측정 실패');
  });
});
