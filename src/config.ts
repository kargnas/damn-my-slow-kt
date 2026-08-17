/**
 * 설정 파일 로드/저장 - KT 전용
 * 기본 경로: ~/.damn-my-slow-isp/config-kt.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import os from 'os';

/** 모든 ISP 공용 데이터 디렉토리 (~/.damn-my-slow-isp/) */
export const DATA_DIR = path.join(os.homedir(), '.damn-my-slow-isp');

export interface Credentials {
  id: string;
  password: string;
}

export interface Plan {
  speed_mbps: number;
}

export interface Schedule {
  time: string;
  timezone: string;
  /** 하루 최대 측정 횟수 (감면 성공 시 중단) */
  max_attempts: number;
  /** 재시도 간격 (분). 첫 측정 후 이 간격으로 반복 */
  retry_interval_minutes: number;
  /** 감면 신청 성공 시 나머지 시도 중단 */
  stop_on_complaint_success: boolean;
}

export interface Notification {
  discord_webhook: string;
  slack_webhook: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
}

export interface Config {
  _config_version: number;
  credentials: Credentials;
  /** 이의신청 시 연락처 */
  phone: string;
  plan: Plan;
  schedule: Schedule;
  notification: Notification;
  headless: boolean;
  db_path: string;
}

export const DEFAULT_CONFIG_PATH = path.join(DATA_DIR, 'config-kt.yaml');

export function getDefaultConfig(): Config {
  return {
    _config_version: 3,
    credentials: { id: '', password: '' },
    phone: '',
    plan: { speed_mbps: 1000 },
    schedule: {
      time: '04:00',
      timezone: 'Asia/Seoul',
      max_attempts: 10,
      retry_interval_minutes: 120,
      stop_on_complaint_success: true,
    },
    notification: {
      discord_webhook: '',
      slack_webhook: '',
      telegram_bot_token: '',
      telegram_chat_id: '',
    },
    headless: true,
    db_path: path.join(DATA_DIR, 'history-kt.db'),
  };
}

export function loadConfig(configPath?: string): Config {
  const cfgPath = configPath || DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(cfgPath)) {
    throw new Error(
      `설정 파일이 없습니다: ${cfgPath}\n'npx -y damn-my-slow-kt@latest init' 명령으로 설정 파일을 생성하세요.`
    );
  }

  const raw = yaml.load(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown> || {};
  const defaults = getDefaultConfig();

  const creds = (raw.credentials || {}) as Record<string, string>;
  const plan = (raw.plan || {}) as Record<string, unknown>;
  const sched = (raw.schedule || {}) as Partial<Schedule>;
  const notif = (raw.notification || {}) as Record<string, string>;

  return {
    _config_version: Number(raw._config_version) || 1,
    credentials: {
      id: creds.id || '',
      password: creds.password || '',
    },
    phone: String(raw.phone || ''),
    plan: {
      speed_mbps: Number(plan.speed_mbps || 1000),
    },
    schedule: {
      time: sched.time || '04:00',
      timezone: sched.timezone || 'Asia/Seoul',
      max_attempts: Number(sched.max_attempts) || 10,
      retry_interval_minutes: Number(sched.retry_interval_minutes) || 120,
      stop_on_complaint_success:
        sched.stop_on_complaint_success !== undefined
          ? Boolean(sched.stop_on_complaint_success)
          : true,
    },
    notification: {
      discord_webhook: notif.discord_webhook || '',
      slack_webhook: notif.slack_webhook || '',
      telegram_bot_token: notif.telegram_bot_token || '',
      telegram_chat_id: notif.telegram_chat_id || '',
    },
    headless: raw.headless !== undefined ? Boolean(raw.headless) : true,
    db_path: String(raw.db_path || defaults.db_path),
  };
}

export function saveConfig(config: Config, configPath?: string): void {
  const cfgPath = configPath || DEFAULT_CONFIG_PATH;

  const data = {
    _config_version: config._config_version,
    credentials: {
      id: config.credentials.id,
      password: config.credentials.password,
    },
    phone: config.phone,
    plan: {
      speed_mbps: config.plan.speed_mbps,
    },
    schedule: {
      time: config.schedule.time,
      timezone: config.schedule.timezone,
      max_attempts: config.schedule.max_attempts,
      retry_interval_minutes: config.schedule.retry_interval_minutes,
      stop_on_complaint_success: config.schedule.stop_on_complaint_success,
    },
    notification: {
      discord_webhook: config.notification.discord_webhook,
      slack_webhook: config.notification.slack_webhook,
      telegram_bot_token: config.notification.telegram_bot_token,
      telegram_chat_id: config.notification.telegram_chat_id,
    },
    headless: config.headless,
    db_path: config.db_path,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fs.writeFileSync(cfgPath, (yaml as any).dump(data, { allowUnicode: true }), 'utf8');
}

/**
 * run 명령 실행에 필요한 필수 설정이 모두 채워져 있는지 검증.
 * 누락된 항목이 있으면 필드명 배열을 반환, 모두 있으면 빈 배열.
 */
export function validateRequiredFields(config: Config): string[] {
  const missing: string[] = [];
  if (!config.credentials.id) missing.push('credentials.id (KT 아이디)');
  if (!config.credentials.password) missing.push('credentials.password (KT 비밀번호)');
  if (!config.phone) missing.push('phone (연락처)');
  return missing;
}

export function getExampleConfigContent(): string {
  return `# damn-my-slow-kt 설정 파일
# 주의: 이 파일은 .gitignore에 포함되어 있습니다 (비밀번호 보호)

_config_version: 3

credentials:
  id: "KT_아이디@example.com"
  password: "비밀번호"

plan:
  speed_mbps: 1000  # 계약 속도 (Mbps) - 기가라이트: 1000, 기가프리미엄: 2000

schedule:
  time: "04:00"       # 첫 측정 시작 시간
  timezone: "Asia/Seoul"
  max_attempts: 10    # 하루 최대 측정 횟수 (감면 성공 시 중단)
  retry_interval_minutes: 120  # 재시도 간격 (분) - 기본 2시간
  stop_on_complaint_success: true  # 감면 성공 시 나머지 시도 중단

notification:
  discord_webhook: ""  # Discord 웹훅 URL (선택)
  slack_webhook: ""  # Slack Incoming Webhook URL (선택)
  telegram_bot_token: ""  # Telegram 봇 토큰 (선택)
  telegram_chat_id: ""  # Telegram 채팅 ID (선택)

headless: true  # false로 설정하면 브라우저 창 표시 (디버그용)
db_path: "~/.damn-my-slow-isp/history-kt.db"  # 측정 이력 저장 경로
`;
}
