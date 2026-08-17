/**
 * Discord / Slack / Telegram 알림
 */

import axios from 'axios';
import { Config } from './config';
import { SpeedRecord } from './db';

export function formatRecord(record: SpeedRecord): string {
  // 자동화 오류로 측정 자체가 실패한 경우 — 속도값이 0이어도 의미 없음
  if (record.error) {
    return (
      `**인터넷 속도 측정 실패** (${record.measured_at.slice(0, 16)})\n` +
      `🚨 오류: ${record.error}`
    );
  }

  const slaEmoji =
    record.sla_result === 'pass' ? '✅' : record.sla_result === 'fail' ? '❌' : '⚠️';
  let complaintInfo = '';

  if (record.complaint_filed) {
    complaintInfo = `\n🔔 이의신청: ${record.complaint_result === 'success' ? '완료' : '실패'}`;
  }

  return (
    `**인터넷 속도 측정 결과** (${record.measured_at.slice(0, 16)})\n` +
    `${slaEmoji} SLA: ${record.sla_result.toUpperCase()}\n` +
    `⬇️ 다운로드: ${record.download_mbps.toFixed(1)} Mbps` +
    complaintInfo
  );
}

export async function notifyDiscord(webhookUrl: string, record: SpeedRecord): Promise<boolean> {
  if (!webhookUrl) return false;

  const message = formatRecord(record);
  const color = record.error ? 0xff8800 : record.sla_result === 'pass' ? 0x00ff00 : 0xff0000;

  const payload = {
    embeds: [
      {
        title: '🐌 damn-my-slow-kt',
        description: message,
        color,
      },
    ],
  };

  try {
    await axios.post(webhookUrl, payload, { timeout: 10000 });
    console.log('Discord 알림 전송 완료');
    return true;
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`Discord 알림 실패: ${err.message}`);
    return false;
  }
}

export async function notifySlack(webhookUrl: string, record: SpeedRecord): Promise<boolean> {
  if (!webhookUrl) return false;

  // Slack mrkdwn은 볼드가 *단일 별표* — Discord용 **를 변환
  const message = formatRecord(record).replace(/\*\*/g, '*');

  try {
    await axios.post(
      webhookUrl,
      { text: `🐌 damn-my-slow-kt\n${message}` },
      { timeout: 10000 }
    );
    console.log('Slack 알림 전송 완료');
    return true;
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`Slack 알림 실패: ${err.message}`);
    return false;
  }
}

export async function notifyTelegram(
  botToken: string,
  chatId: string,
  record: SpeedRecord
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  const message = formatRecord(record).replace(/\*\*/g, '*');
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    await axios.post(
      url,
      { chat_id: chatId, text: message, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
    console.log('Telegram 알림 전송 완료');
    return true;
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(`Telegram 알림 실패: ${err.message}`);
    return false;
  }
}

export async function sendNotifications(config: Config, record: SpeedRecord): Promise<void> {
  const { notification: notif } = config;

  if (notif.discord_webhook) {
    await notifyDiscord(notif.discord_webhook, record);
  }

  if (notif.slack_webhook) {
    await notifySlack(notif.slack_webhook, record);
  }

  if (notif.telegram_bot_token && notif.telegram_chat_id) {
    await notifyTelegram(notif.telegram_bot_token, notif.telegram_chat_id, record);
  }
}
