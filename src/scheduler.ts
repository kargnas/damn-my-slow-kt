/**
 * 자동 스케줄 설치/제거 (macOS launchd / Linux systemd/cron / Windows 작업 스케줄러)
 */

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync } from 'child_process';
import { Config, DATA_DIR, DEFAULT_CONFIG_PATH } from './config';

/** POSIX shell 안전 문자열 이스케이프. 공백·특수문자가 포함된 경로를 cron/systemd에 안전하게 넘긴다. */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@=,-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

const LAUNCHD_PLIST_PATH = path.join(
  os.homedir(),
  'Library',
  'LaunchAgents',
  'com.damn-my-slow-kt.plist'
);
const CRON_COMMENT = '# damn-my-slow-kt';
const SYSTEMD_SERVICE_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  'damn-my-slow-kt.service'
);
const SYSTEMD_TIMER_PATH = path.join(
  os.homedir(),
  '.config',
  'systemd',
  'user',
  'damn-my-slow-kt.timer'
);

export function getPlatform(): 'macos' | 'linux' | 'windows' | 'unknown' {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

/**
 * npx 임시 캐시 경로인지 판별.
 * npx는 _npx/ 디렉토리 아래에 임시 설치하므로, launchd/cron에 이 경로를 기록하면
 * 세션 종료 후 파일이 사라져 실행 실패한다.
 */
function isNpxTempPath(p: string): boolean {
  return p.includes('/_npx/') || p.includes('\\_npx\\');
}

interface CliExec {
  /** 실행 바이너리 (npx 모드면 npx 절대경로, 아니면 CLI 절대경로) */
  program: string;
  /** program 뒤에 붙는 인자 (npx 모드면 ['--yes', 'damn-my-slow-kt']) */
  prefixArgs: string[];
  /** npx 모드 여부 */
  isNpx: boolean;
}

function getCliExec(): CliExec {
  // 1) 글로벌 설치 경로 확인
  try {
    const globalPath = execSync('which damn-my-slow-kt 2>/dev/null', { encoding: 'utf8' }).trim();
    if (globalPath && !isNpxTempPath(globalPath)) {
      return { program: globalPath, prefixArgs: [], isNpx: false };
    }
  } catch {
    // ignore
  }

  // 2) process.argv[1]이 안정적 경로(글로벌 or 로컬 node_modules)인 경우
  const scriptPath = process.argv[1];
  if (scriptPath && scriptPath.includes('damn-my-slow-kt') && !isNpxTempPath(scriptPath)) {
    return { program: scriptPath, prefixArgs: [], isNpx: false };
  }

  // 3) npx 모드 - npx 바이너리 절대경로를 찾아서 사용
  let npxPath = 'npx';
  try {
    npxPath = execSync('which npx 2>/dev/null', { encoding: 'utf8' }).trim() || 'npx';
  } catch {
    // fallback
  }
  return { program: npxPath, prefixArgs: ['--yes', 'damn-my-slow-kt'], isNpx: true };
}

/** 사용자 안내용 실행 명령어 문자열 */
export function getRunCommand(): string {
  const exec = getCliExec();
  if (exec.isNpx) {
    return 'npx damn-my-slow-kt';
  }
  return 'damn-my-slow-kt';
}

// ─────────────────────────────────────────────
// 스케줄 시간 계산
// ─────────────────────────────────────────────

interface ScheduleTime { hour: number; minute: number; }

/**
 * 트리거 시간 목록 생성.
 * - schedule.times가 있으면 그대로 사용 (자정을 넘는 스케줄 표현용)
 * - 없으면 시작 시간 + 간격 + 최대 횟수. 예: 04:00, max=10, interval=120 → 04:00, 06:00, ..., 22:00
 */
export function buildScheduleTimes(config: Config): ScheduleTime[] {
  const explicit = config.schedule.times;
  if (explicit && explicit.length > 0) {
    const times: ScheduleTime[] = [];
    for (const raw of explicit) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
      const hour = m ? Number(m[1]) : NaN;
      const minute = m ? Number(m[2]) : NaN;
      if (!m || hour > 23 || minute > 59) {
        throw new Error(`schedule.times 형식이 잘못되었습니다: "${raw}" (HH:mm, 예: "06:00")`);
      }
      if (!times.some((t) => t.hour === hour && t.minute === minute)) times.push({ hour, minute });
    }
    return times;
  }

  const [startH, startM] = config.schedule.time.split(':').map(Number);
  const maxAttempts = config.schedule.max_attempts || 10;
  const intervalMin = config.schedule.retry_interval_minutes || 120;

  const times: ScheduleTime[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    const totalMinutes = (startH * 60 + startM) + (i * intervalMin);
    const hour = Math.floor(totalMinutes / 60) % 24;
    const minute = totalMinutes % 60;

    // 다음 날로 넘어가면 중단 (24시간 내만)
    if (i > 0 && totalMinutes >= 24 * 60) break;

    times.push({ hour, minute });
  }
  return times;
}

/** 스케줄 시간을 보기 좋게 출력 */
function formatScheduleTimes(times: ScheduleTime[]): string {
  return times.map((t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`).join(', ');
}

// ─────────────────────────────────────────────
// macOS - launchd plist
// ─────────────────────────────────────────────

function buildLaunchdPlist(config: Config, configPath: string): string {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const logDir = DATA_DIR;
  const logPath = path.join(logDir, 'run.log');
  const errPath = path.join(logDir, 'run.error.log');

  fs.mkdirSync(logDir, { recursive: true });

  const args = [exec.program, ...exec.prefixArgs, 'run', '--config', configPath];
  const argsXml = args.map((a) => `    <string>${a}</string>`).join('\n');

  // launchd는 StartCalendarInterval을 array로 받으면 여러 시간에 트리거
  const calendarEntries = times.map((t) => `    <dict>
      <key>Hour</key>
      <integer>${t.hour}</integer>
      <key>Minute</key>
      <integer>${t.minute}</integer>
    </dict>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.damn-my-slow-kt</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>StartCalendarInterval</key>
  <array>
${calendarEntries}
  </array>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

export function installMacos(config: Config, configPath: string): void {
  const plistDir = path.dirname(LAUNCHD_PLIST_PATH);
  fs.mkdirSync(plistDir, { recursive: true });

  // 기존 언로드
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  const plist = buildLaunchdPlist(config, configPath);
  fs.writeFileSync(LAUNCHD_PLIST_PATH, plist, 'utf8');

  execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);

  const times = buildScheduleTimes(config);
  console.log(`✅ macOS launchd 스케줄 등록 완료: ${LAUNCHD_PLIST_PATH}`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: npx -y damn-my-slow-kt@latest schedule remove`);
}

export function removeMacos(): void {
  if (!fs.existsSync(LAUNCHD_PLIST_PATH)) {
    console.log('등록된 launchd 스케줄이 없습니다.');
    return;
  }

  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // ignore
  }

  fs.unlinkSync(LAUNCHD_PLIST_PATH);
  console.log('✅ macOS launchd 스케줄 제거 완료');
}

// ─────────────────────────────────────────────
// Linux - systemd timer 또는 cron
// ─────────────────────────────────────────────

function hasSystemd(): boolean {
  try {
    execSync('systemctl --user status 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** crontab 바이너리가 PATH에 존재하는지 확인 */
function hasCrontab(): boolean {
  try {
    execSync('which crontab 2>/dev/null', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Synology NAS 감지 — /etc/synoinfo.conf 존재 여부로 판별.
 * Synology DSM은 user-level crontab이 없고 /etc/crontab을 직접 편집해야 한다.
 */
function isSynology(): boolean {
  return fs.existsSync('/etc/synoinfo.conf');
}

export function installLinux(config: Config, configPath: string): void {
  if (hasSystemd()) {
    installSystemd(config, configPath);
  } else if (isSynology()) {
    installSynologyCron(config, configPath);
  } else if (hasCrontab()) {
    installCron(config, configPath);
  } else {
    throw new Error(
      'crontab 명령어를 찾을 수 없습니다.\n' +
      '수동으로 cron을 설정하세요:\n' +
      `  npx --yes damn-my-slow-kt run --config ${configPath}`
    );
  }
}

function installSystemd(config: Config, configPath: string): void {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();

  const serviceDir = path.dirname(SYSTEMD_SERVICE_PATH);
  fs.mkdirSync(serviceDir, { recursive: true });

  const execCmd = [shellQuote(exec.program), ...exec.prefixArgs.map(shellQuote), 'run', '--config', shellQuote(configPath)].join(' ');

  const serviceContent = `[Unit]
Description=damn-my-slow-kt KT SLA Speed Test

[Service]
Type=oneshot
ExecStart=${execCmd}
StandardOutput=journal
StandardError=journal
`;

  // systemd는 여러 OnCalendar 라인을 지원
  const onCalendarLines = times
    .map((t) => `OnCalendar=*-*-* ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}:00`)
    .join('\n');

  const timerContent = `[Unit]
Description=damn-my-slow-kt daily timer (${times.length}회/일)

[Timer]
${onCalendarLines}
Persistent=true

[Install]
WantedBy=timers.target
`;

  fs.writeFileSync(SYSTEMD_SERVICE_PATH, serviceContent, 'utf8');
  fs.writeFileSync(SYSTEMD_TIMER_PATH, timerContent, 'utf8');

  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable damn-my-slow-kt.timer');
  execSync('systemctl --user start damn-my-slow-kt.timer');

  console.log(`✅ systemd 타이머 등록 완료`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`   확인: systemctl --user status damn-my-slow-kt.timer`);
  console.log(`\n   제거하려면: npx -y damn-my-slow-kt@latest schedule remove`);
}

/**
 * Synology NAS 전용 cron 설치.
 * DSM은 user-level crontab이 없으므로 /etc/crontab을 직접 편집하고
 * synoservicectl --restart crond로 crond를 재시작한다.
 * /etc/crontab 형식: minute hour mday month wday user command
 */
function installSynologyCron(config: Config, configPath: string): void {
  const SYSTEM_CRONTAB = '/etc/crontab';
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const logPath = path.join(DATA_DIR, 'cron.log');
  const user = os.userInfo().username;

  const execCmd = [shellQuote(exec.program), ...exec.prefixArgs.map(shellQuote), 'run', '--config', shellQuote(configPath)].join(' ');

  // cron은 최소 PATH로 실행되므로 node/npx가 있는 디렉토리를 PATH에 명시해야 한다
  const nodeBinDir = path.dirname(process.execPath);
  const pathPrefix = `PATH=${shellQuote(nodeBinDir)}:/usr/local/bin:/usr/bin:/bin`;

  // Synology /etc/crontab은 user 필드가 포함된 형식
  const cronLines = times.map((t) =>
    `${t.minute}\t${t.hour}\t*\t*\t*\t${user}\t${pathPrefix} ${execCmd} >> ${shellQuote(logPath)} 2>&1 ${CRON_COMMENT}`
  );

  let existing = '';
  try {
    existing = fs.readFileSync(SYSTEM_CRONTAB, 'utf8');
  } catch {
    throw new Error(`${SYSTEM_CRONTAB}을 읽을 수 없습니다. sudo 권한이 필요할 수 있습니다.`);
  }

  // 기존 damn-my-slow-kt 라인 제거 후 새 라인 추가
  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(CRON_COMMENT));

  // 마지막 빈 줄 유지하면서 추가
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  lines.push(...cronLines, '');

  const newCrontab = lines.join('\n');

  try {
    fs.writeFileSync(SYSTEM_CRONTAB, newCrontab, 'utf8');
  } catch {
    // sudo 실행 시 $HOME이 /root로 바뀌므로 --config로 원래 경로를 명시해야 한다
    throw new Error(
      `/etc/crontab 쓰기 실패. sudo 권한으로 다시 시도하세요:\n` +
      `  sudo npx --yes damn-my-slow-kt schedule install --config ${configPath}`
    );
  }

  // crond 재시작으로 변경사항 반영
  try {
    execSync('synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
  } catch {
    // synoservicectl이 없으면 /usr/syno/bin/ 경로로 재시도
    try {
      execSync('/usr/syno/bin/synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
    } catch {
      console.log('⚠️  crond 재시작 실패 — NAS를 재부팅하면 반영됩니다.');
    }
  }

  console.log(`✅ Synology /etc/crontab 등록 완료`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: sudo npx --yes damn-my-slow-kt schedule remove`);
}

function installCron(config: Config, configPath: string): void {
  const times = buildScheduleTimes(config);
  const exec = getCliExec();
  const logPath = path.join(DATA_DIR, 'cron.log');

  const execCmd = [shellQuote(exec.program), ...exec.prefixArgs.map(shellQuote), 'run', '--config', shellQuote(configPath)].join(' ');

  // cron은 최소 PATH로 실행되므로 node/npx가 있는 디렉토리를 PATH에 명시
  const nodeBinDir = path.dirname(process.execPath);
  const pathPrefix = `PATH=${shellQuote(nodeBinDir)}:/usr/local/bin:/usr/bin:/bin`;

  // 각 트리거 시간마다 cron 라인 생성
  const cronLines = times.map((t) =>
    `${t.minute} ${t.hour} * * * ${pathPrefix} ${execCmd} >> ${shellQuote(logPath)} 2>&1 ${CRON_COMMENT}`
  );

  let existing = '';
  try {
    existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  } catch {
    // no crontab
  }

  // 기존 damn-my-slow-kt 라인 제거 후 새 라인 추가
  const lines = existing
    .split('\n')
    .filter((l) => !l.includes(CRON_COMMENT));
  lines.push(...cronLines);

  const newCrontab = lines.join('\n') + '\n';

  // stdin 방식 먼저 시도 (표준 Linux)
  const proc = require('child_process').spawnSync('crontab', ['-'], {
    input: newCrontab,
    encoding: 'utf8',
  });

  if (proc.status !== 0 || proc.error) {
    // BusyBox(Synology NAS 등)는 crontab - (stdin) 미지원 → 임시 파일 방식으로 재시도
    const tmpFile = path.join(os.tmpdir(), `damn-my-slow-kt-cron-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmpFile, newCrontab, 'utf8');
      const proc2 = require('child_process').spawnSync('crontab', [tmpFile], {
        encoding: 'utf8',
      });
      if (proc2.status !== 0 || proc2.error) {
        const errMsg =
          (proc2.stderr as string | undefined) ||
          proc2.error?.message ||
          (proc.stderr as string | undefined) ||
          proc.error?.message ||
          'unknown error';
        throw new Error(`crontab 설치 실패: ${errMsg}`);
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  console.log(`✅ crontab 등록 완료`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log(`\n   제거하려면: npx -y damn-my-slow-kt@latest schedule remove`);
}

export function removeLinux(): void {
  if (fs.existsSync(SYSTEMD_SERVICE_PATH) || fs.existsSync(SYSTEMD_TIMER_PATH)) {
    try {
      execSync('systemctl --user stop damn-my-slow-kt.timer 2>/dev/null', { stdio: 'ignore' });
      execSync('systemctl --user disable damn-my-slow-kt.timer 2>/dev/null', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    if (fs.existsSync(SYSTEMD_SERVICE_PATH)) fs.unlinkSync(SYSTEMD_SERVICE_PATH);
    if (fs.existsSync(SYSTEMD_TIMER_PATH)) fs.unlinkSync(SYSTEMD_TIMER_PATH);

    try {
      execSync('systemctl --user daemon-reload 2>/dev/null', { stdio: 'ignore' });
    } catch {
      // ignore
    }

    console.log('✅ systemd 타이머 제거 완료');
    return;
  }

  // Synology NAS: /etc/crontab에서 제거
  if (isSynology()) {
    try {
      const SYSTEM_CRONTAB = '/etc/crontab';
      const existing = fs.readFileSync(SYSTEM_CRONTAB, 'utf8');
      const lines = existing.split('\n').filter((l) => !l.includes(CRON_COMMENT));
      fs.writeFileSync(SYSTEM_CRONTAB, lines.join('\n') + '\n', 'utf8');
      try {
        execSync('synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
      } catch {
        try {
          execSync('/usr/syno/bin/synoservicectl --restart crond 2>/dev/null', { stdio: 'ignore' });
        } catch { /* ignore */ }
      }
      console.log('✅ Synology /etc/crontab 스케줄 제거 완료');
    } catch (_e: unknown) {
      throw new Error('/etc/crontab 수정 실패. sudo 권한으로 다시 시도하세요:\n  sudo npx --yes damn-my-slow-kt schedule remove');
    }
    return;
  }

  // 일반 Linux: crontab 명령어로 제거
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    if (!existing.includes(CRON_COMMENT)) {
      console.log('등록된 crontab 스케줄이 없습니다.');
      return;
    }
    const lines = existing.split('\n').filter((l) => !l.includes(CRON_COMMENT));
    const newCrontab = lines.join('\n') + '\n';
    const proc = require('child_process').spawnSync('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    if (proc.status !== 0 || proc.error) {
      throw new Error(`crontab 제거 실패: ${(proc.stderr as string | undefined) || proc.error?.message || 'unknown error'}`);
    }
    console.log('✅ crontab 스케줄 제거 완료');
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('crontab 제거 실패')) throw e;
    console.log('등록된 crontab 스케줄이 없습니다.');
  }
}

// ─────────────────────────────────────────────
// Windows - 작업 스케줄러 (Task Scheduler)
// ─────────────────────────────────────────────

/** schedule install이 자동 등록하는 작업 — 이름+경로가 정확히 같은 작업만 "자동 등록"으로 간주 */
export const WINDOWS_TASK_NAME = 'damn-my-slow-kt';
export const WINDOWS_TASK_PATH = '\\';

export interface WindowsScheduledTask {
  name: string;
  path: string;
  /** "<Execute> <Arguments>" */
  actions: string[];
}

export interface WindowsTaskAction {
  execute: string;
  arguments: string;
}

/**
 * 자동 등록 작업과 사용자가 직접 등록한 작업을 구분.
 * 직접 등록한 작업은 이름·폴더가 제각각이라(예: \Custom\KT 자동 속도 측정) 실행 명령으로 찾은 뒤,
 * 자동 등록 이름·경로와 정확히 일치하지 않으면 모두 수동 등록으로 본다.
 */
export function classifyWindowsTasks(tasks: WindowsScheduledTask[]): {
  auto: WindowsScheduledTask | null;
  manual: WindowsScheduledTask[];
} {
  const isAuto = (t: WindowsScheduledTask) => t.name === WINDOWS_TASK_NAME && t.path === WINDOWS_TASK_PATH;
  return {
    auto: tasks.find(isAuto) || null,
    manual: tasks.filter((t) => !isAuto(t)),
  };
}

/** Windows 명령줄 인자 따옴표 — Windows 경로에는 "가 들어갈 수 없으므로 감싸기만 하면 된다 */
function winQuote(s: string): string {
  return /[\s&()^|<>]/.test(s) ? `"${s}"` : s;
}

/**
 * 작업 스케줄러에 등록할 실행 명령. 작업 스케줄러의 PATH에 의존하지 않도록 절대 경로를 쓴다.
 * - 글로벌/로컬 설치: node.exe로 dist/index.js를 직접 실행
 * - npx 임시 캐시에서 실행 중: 캐시가 사라질 수 있으므로 매번 npx.cmd로 실행
 */
export function buildWindowsTaskAction(opts: {
  scriptPath: string;
  nodePath: string;
  /** npx 모드에서 쓸 npx.cmd 경로 (기본: PATH의 npx.cmd) */
  npxPath?: string;
  configPath: string;
}): WindowsTaskAction {
  const runArgs = `run --config "${opts.configPath}"`;
  if (isNpxTempPath(opts.scriptPath)) {
    return { execute: opts.npxPath || 'npx.cmd', arguments: `--yes damn-my-slow-kt ${runArgs}` };
  }
  return { execute: opts.nodePath, arguments: `${winQuote(opts.scriptPath)} ${runArgs}` };
}

/** PowerShell 작은따옴표 문자열 — 내부 '는 ''로 이스케이프 (변수 확장 없음) */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function formatTime(t: ScheduleTime): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
}

export function buildWindowsRegisterScript(opts: { action: WindowsTaskAction; times: ScheduleTime[] }): string {
  // 각 호출을 괄호로 감싸야 한다 — 없으면 쉼표 뒤가 앞 호출의 -At 인자 배열로 묶여 변환 오류
  const triggers = opts.times.map((t) => `(New-ScheduledTaskTrigger -Daily -At ${psQuote(formatTime(t))})`).join(', ');
  return [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(opts.action.execute)} -Argument ${psQuote(opts.action.arguments)}`,
    `$triggers = @(${triggers})`,
    // 측정 1회 ~25분(최대 40분) — 넉넉히 2시간. 이전 실행이 남아 있으면 새 실행은 건너뜀.
    '$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries ' +
      '-DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -TaskPath ${psQuote(WINDOWS_TASK_PATH)} ` +
      `-Action $action -Trigger $triggers -Settings $settings ` +
      `-Description ${psQuote('KT 품질보증(SLA) 자동 측정 — damn-my-slow-kt schedule install로 등록됨')} -Force | Out-Null`,
  ].join('\n');
}

const PS_ERROR_MARKER = 'DMSK_PS_ERROR:';

/**
 * PowerShell 스크립트 실행 — 한글/따옴표 문제를 피하려고 UTF-16LE base64(-EncodedCommand)로 전달.
 * -EncodedCommand의 stderr는 CLIXML로 직렬화되어 읽을 수 없으므로, 예외 메시지를 stdout에 표식과 함께 출력한다.
 */
function runPowerShell(script: string): string {
  const wrapped = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    script,
    `} catch { [Console]::Out.WriteLine('${PS_ERROR_MARKER}' + $_.Exception.Message); exit 1 }`,
  ].join('\n');
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function powerShellErrorMessage(e: unknown): string {
  const stdout = (e as { stdout?: unknown }).stdout;
  if (typeof stdout === 'string') {
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith(PS_ERROR_MARKER));
    if (line) return line.slice(PS_ERROR_MARKER.length).trim();
  }
  return e instanceof Error ? e.message.split('\n')[0] : String(e);
}

/** 실행 명령이나 이름에 damn-my-slow-kt가 들어간 작업을 모든 폴더에서 찾는다 */
export function findWindowsScheduledTasks(): WindowsScheduledTask[] {
  const script = [
    '$found = @(Get-ScheduledTask | Where-Object {',
    "  $_.TaskName -like '*damn-my-slow-kt*' -or",
    "  (@($_.Actions) | Where-Object { \"$($_.Execute) $($_.Arguments)\" -like '*damn-my-slow-kt*' })",
    '} | ForEach-Object {',
    '  [pscustomobject]@{ name = $_.TaskName; path = $_.TaskPath;',
    '    actions = @($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)".Trim() }) }',
    '})',
    'ConvertTo-Json -InputObject $found -Depth 4 -Compress',
  ].join('\n');

  let out: string;
  try {
    out = runPowerShell(script);
  } catch (e: unknown) {
    throw new Error(`작업 스케줄러 조회 실패: ${powerShellErrorMessage(e)}`);
  }
  const parsed: unknown = JSON.parse(out.trim() || '[]');
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map((t: { name?: unknown; path?: unknown; actions?: unknown }) => ({
    name: String(t.name ?? ''),
    path: String(t.path ?? ''),
    actions: Array.isArray(t.actions) ? t.actions.map(String) : t.actions ? [String(t.actions)] : [],
  }));
}

function formatWindowsTask(t: WindowsScheduledTask): string {
  return `${t.path}${t.name}`;
}

export interface WindowsInstallOptions {
  /** 사용자가 교체를 승인한 직접 등록 작업 목록 (CLI에서 목록을 보여주고 확인받은 그대로) */
  replaceManualTasks?: WindowsScheduledTask[];
}

function taskKey(t: WindowsScheduledTask): string {
  return JSON.stringify([t.path, t.name, [...t.actions].sort()]);
}

/** 승인받은 작업 목록과 현재 작업 목록이 같은지 — 확인 프롬프트 사이에 작업이 추가/변경되었으면 false */
export function isSameTaskSet(a: WindowsScheduledTask[], b: WindowsScheduledTask[]): boolean {
  const ka = a.map(taskKey).sort();
  const kb = b.map(taskKey).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

function unregisterWindowsTask(name: string, taskPath: string): void {
  runPowerShell(
    `Unregister-ScheduledTask -TaskName ${psQuote(name)} -TaskPath ${psQuote(taskPath)} -Confirm:$false -ErrorAction Stop`,
  );
}

/**
 * @returns 등록했으면 true, 직접 등록한 작업이 있어 중복 방지로 건너뛰었으면 false
 */
export function installWindows(config: Config, configPath: string, options: WindowsInstallOptions = {}): boolean {
  const { auto, manual } = classifyWindowsTasks(findWindowsScheduledTasks());

  if (manual.length > 0 && !options.replaceManualTasks) {
    console.log('⚠️  직접 등록한 damn-my-slow-kt 작업이 이미 있어 중복 등록하지 않았습니다:');
    for (const t of manual) console.log(`   • ${formatWindowsTask(t)}`);
    console.log('   자동 등록으로 바꾸려면 터미널에서 schedule install을 다시 실행해 교체를 선택하세요.');
    return false;
  }
  // 승인 이후 작업이 추가/변경되었으면 보여주지 않은 작업을 지우지 않도록 중단
  if (options.replaceManualTasks && !isSameTaskSet(options.replaceManualTasks, manual)) {
    throw new Error('확인 이후 작업 스케줄러의 damn-my-slow-kt 작업이 바뀌었습니다. 다시 실행하세요.');
  }

  const times = buildScheduleTimes(config);
  // npm은 npx.cmd를 node.exe와 같은 폴더에 설치한다
  const bundledNpx = path.join(path.dirname(process.execPath), 'npx.cmd');
  const action = buildWindowsTaskAction({
    scriptPath: process.argv[1] || '',
    nodePath: process.execPath,
    npxPath: fs.existsSync(bundledNpx) ? bundledNpx : undefined,
    // 작업 스케줄러의 작업 디렉터리는 System32라 상대 경로가 깨진다
    configPath: path.resolve(configPath),
  });
  // 새 작업을 먼저 등록하고 기존 작업을 지운다 — 등록이 실패해도 기존 스케줄이 남도록
  try {
    runPowerShell(buildWindowsRegisterScript({ action, times }));
  } catch (e: unknown) {
    throw new Error(`작업 스케줄러 등록 실패: ${powerShellErrorMessage(e)}`);
  }

  const removed: WindowsScheduledTask[] = [];
  for (const t of manual) {
    try {
      unregisterWindowsTask(t.name, t.path);
      removed.push(t);
      console.log(`   기존 작업 제거: ${formatWindowsTask(t)}`);
    } catch (e: unknown) {
      // 관리자 권한으로 만든 작업/폴더는 일반 권한으로 지울 수 없다 (액세스 거부).
      // 아직 아무것도 지우지 않았고 새로 만든 작업이면 되돌려서 시작 전 상태로 둔다 (같은 시각 중복 실행 방지).
      let rollback = '';
      if (removed.length === 0 && !auto) {
        try {
          unregisterWindowsTask(WINDOWS_TASK_NAME, WINDOWS_TASK_PATH);
          rollback = '\n   새로 등록한 작업은 되돌렸습니다 (변경 없음).';
        } catch {
          rollback = `\n   새로 등록한 ${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME} 작업을 되돌리지 못했습니다. 직접 삭제하세요.`;
        }
      } else {
        rollback = `\n   ${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}는 등록된 상태입니다. 남은 작업을 직접 삭제해 중복 실행을 막으세요.`;
      }
      throw new Error(
        `기존 작업 제거 실패 (${formatWindowsTask(t)}): ${powerShellErrorMessage(e)}${rollback}\n` +
          '   관리자 권한 터미널에서 다시 실행하거나, 작업 스케줄러(taskschd.msc)에서 직접 삭제한 뒤 다시 실행하세요.',
      );
    }
  }

  console.log(`✅ Windows 작업 스케줄러 ${auto ? '갱신' : '등록'} 완료: ${WINDOWS_TASK_PATH}${WINDOWS_TASK_NAME}`);
  console.log(`   매일 ${times.length}회 실행: ${formatScheduleTimes(times)}`);
  console.log(`   감면 성공 시 나머지 실행은 자동 스킵됩니다.`);
  console.log('   Windows에 로그인되어 있을 때만 실행됩니다.');
  console.log(`\n   제거하려면: npx -y damn-my-slow-kt@latest schedule remove`);
  return true;
}

export function removeWindows(): void {
  const { auto, manual } = classifyWindowsTasks(findWindowsScheduledTasks());

  if (auto) {
    try {
      unregisterWindowsTask(WINDOWS_TASK_NAME, WINDOWS_TASK_PATH);
    } catch (e: unknown) {
      throw new Error(`작업 스케줄러 제거 실패: ${powerShellErrorMessage(e)}`);
    }
    console.log('✅ Windows 작업 스케줄러 제거 완료');
  } else {
    console.log('자동 등록된 작업 스케줄러 작업이 없습니다.');
  }

  // 사용자가 직접 만든 작업은 임의로 지우지 않고 알려만 준다
  if (manual.length > 0) {
    console.log('ℹ️  직접 등록한 작업은 제거하지 않았습니다 (작업 스케줄러 taskschd.msc에서 직접 삭제):');
    for (const t of manual) console.log(`   • ${formatWindowsTask(t)}`);
  }
}

export function installSchedule(
  config: Config,
  configPath: string = DEFAULT_CONFIG_PATH,
  windowsOptions: WindowsInstallOptions = {},
): void {
  const platform = getPlatform();

  // schedule.times를 지정해도 run은 하루 max_attempts회까지만 측정하므로 뒤쪽 시각은 스킵된다.
  // PC가 꺼져 놓치는 시각을 대비해 일부러 여유분을 두는 구성도 있으므로 경고가 아닌 안내로 표시.
  const times = buildScheduleTimes(config);
  if (config.schedule.times && times.length > config.schedule.max_attempts) {
    console.log(
      `ℹ️  schedule.times ${times.length}개 중 하루 max_attempts(${config.schedule.max_attempts}회)까지만 측정하고 ` +
        '나머지는 스킵합니다 (놓친 시각 대비 여유분으로 둔 경우 그대로 두면 됩니다).',
    );
  }

  if (platform === 'macos') {
    installMacos(config, configPath);
  } else if (platform === 'linux') {
    installLinux(config, configPath);
  } else if (platform === 'windows') {
    installWindows(config, configPath, windowsOptions);
  } else {
    throw new Error(`지원하지 않는 플랫폼: ${platform}`);
  }
}

export function removeSchedule(): void {
  const platform = getPlatform();

  if (platform === 'macos') {
    removeMacos();
  } else if (platform === 'linux') {
    removeLinux();
  } else if (platform === 'windows') {
    removeWindows();
  } else {
    console.log('이 플랫폼에서는 자동 제거가 지원되지 않습니다.');
  }
}
