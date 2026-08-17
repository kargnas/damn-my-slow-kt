/**
 * KT 자동화 - speed.kt.com 품질보증 테스트
 *
 * Flow (실제 테스트를 통해 검증된 플로우):
 *   1. https://speed.kt.com/sla/slatest/introduce.asp 접속
 *   2. "품질보증(SLA) 테스트" 버튼 클릭 (class="redbtn btntolayer") → 레이어 팝업
 *   3. 레이어에서 회선 선택 (radio button - el-radio 컴포넌트, value="0")
 *   4. "#measureBtn" 클릭 → 테스트 시작
 *   5. 5회 자동 측정 완료 대기 (각 300초 간격 → 총 ~25분)
 *   6. 결과 파싱 (SLA pass/fail)
 *   7. fail이면 "이의신청" 버튼 클릭
 *
 * 로그인 플로우:
 *   - 로그인 없이 접속 → accounts.kt.com으로 리다이렉트
 *   - 로그인 후 비밀번호 변경 안내 → "다음에 하기" 클릭 (3개월 유예)
 *   - 로그인 완료 후 SLA 소개 페이지로 복귀
 */

import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { Config, DATA_DIR } from './config';
import chalk from 'chalk';

const KT_SLA_INTRO_URL = 'https://speed.kt.com/sla/slatest/introduce.asp';
const KT_SPEED_ORIGIN = 'https://speed.kt.com';
const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/123.0.0.0 Safari/537.36';
const SLA_ROUND_TOTAL = 5;
const SLA_FAIL_THRESHOLD = Math.ceil(SLA_ROUND_TOTAL / 2);
export const KT_SLA_GUARANTEE_RATIO = 0.5;
const WORKFLOW_STEP_TOTAL = 5;
const KT_SPEED_CLIENT_PORT = 10055;
const KT_SPEED_CLIENT_PATHS = [
  path.join(process.env['ProgramFiles(x86)'] || '', 'KTSpeedClient', 'kt-speed-client.exe'),
  path.join(process.env.ProgramFiles || '', 'KTSpeedClient', 'kt-speed-client.exe'),
].filter((candidate) => path.isAbsolute(candidate));
// 로그인 세션(쿠키) 저장 경로 — 매 실행마다 새 컨텍스트로 로그인하면 KT가
// PASS/문자 추가 본인인증을 반복 요구하므로(이슈 #13), 인증된 세션을 재사용한다.
const SESSION_STATE_PATH = path.join(DATA_DIR, 'session-kt.json');
// TEST_TIMEOUT_MIN 환경변수로 타임아웃 조절 가능 (기본 40분)
const SLA_TEST_TIMEOUT_MS = (parseInt(process.env.TEST_TIMEOUT_MIN || '0') || 40) * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000; // 15초 — 라운드 변화를 빠르게 감지

// ─── 진행 UI 헬퍼 ────────────────────────────────────────────────

const STEPS = {
  login:   { num: 1, total: WORKFLOW_STEP_TOTAL, label: '로그인' },
  layer:   { num: 2, total: WORKFLOW_STEP_TOTAL, label: 'SLA 테스트 준비' },
  measure: { num: 3, total: WORKFLOW_STEP_TOTAL, label: '속도 측정' },
  parse:   { num: 4, total: WORKFLOW_STEP_TOTAL, label: '결과 분석' },
  action:  { num: 5, total: WORKFLOW_STEP_TOTAL, label: '감면 처리' },
};

function stepHeader(step: { num: number; total: number; label: string }): void {
  const bar = '●'.repeat(step.num) + '○'.repeat(step.total - step.num);
  console.log(chalk.cyan(`\n  ${bar}  `) + chalk.bold(`[${step.num}/${step.total}] ${step.label}`));
}

function info(msg: string): void {
  console.log(chalk.dim(`       ${msg}`));
}

function formatElapsed(ms: number): string {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return min > 0 ? `${min}분 ${sec}초` : `${sec}초`;
}

/** 측정 진행 바 (1~5회차) */
function measureProgress(round: number, total: number, elapsedMs: number): void {
  const filled = round;
  const empty = total - round;
  const bar = chalk.green('■'.repeat(filled)) + chalk.gray('□'.repeat(empty));
  const elapsed = formatElapsed(elapsedMs);
  const line = `       ${bar}  ${round}/${total}회 완료  ${chalk.dim(elapsed)}  `;
  // 커서를 줄 앞으로 이동하여 같은 줄에 덮어쓰기
  if (process.stdout.isTTY) {
    process.stdout.write(`\r${line}\x1b[K`);
  } else {
    console.log(line);
  }
}

export interface SpeedTestResult {
  download_mbps: number;
  upload_mbps: number;
  ping_ms: number;
  sla_result: 'pass' | 'fail' | 'unknown';
  complaint_filed: boolean;
  complaint_result: 'success' | 'failed' | 'skipped' | 'not_applicable';
  raw_data: Record<string, unknown>;
  error: string;
}

export interface ParsedSlaRound {
  speed: string;
  slaRef: string;
  result: string;
  date: string;
}

export interface ParsedSlaResults {
  rounds: ParsedSlaRound[];
  satisfyCount: number;
  failCount: number;
  totalCount: number;
  fullText: string;
}

interface SlaDomParseOptions {
  roundTotal: number;
  includeEmptyRounds: boolean;
  fullTextLimit: number;
}

interface ParsedSlaDomResults extends ParsedSlaResults {
  completedRounds: number;
  isMeasuring: boolean;
  countdown: string;
  textSnippet: string;
}

export interface SlaResultSummary {
  downloadMbps: number;
  slaResult: SpeedTestResult['sla_result'];
  rawData: Record<string, unknown>;
  error: string;
}

function parseSlaDomResults(options: SlaDomParseOptions): ParsedSlaDomResults | null {
  const ifArea = document.getElementById('ifArea');
  if (!ifArea) return null;

  const rounds: ParsedSlaRound[] = [];
  let completedRounds = 0;
  for (let i = 1; i <= options.roundTotal; i++) {
    const speed = ifArea.querySelector(`.step-table-speed-${i}`)?.textContent?.trim() || '';
    const slaRef = ifArea.querySelector(`.step-table-default-${i}`)?.textContent?.trim() || '';
    const resultText = ifArea.querySelector(`.step-table-result-${i}`)?.textContent?.trim() || '';
    const date = ifArea.querySelector(`.step-table-date-${i}`)?.textContent?.trim() || '';

    if (speed) completedRounds += 1;
    if (speed || options.includeEmptyRounds) {
      rounds.push({ speed, slaRef, result: resultText, date });
    }
  }

  const fullText = ifArea.textContent?.replace(/\s+/g, ' ').trim() || '';
  const satisfyMatch = fullText.match(/SLA만족\s*횟수는?\s*(\d+)\s*번/);
  const failMatch = fullText.match(/미달\s*횟수는?\s*(\d+)\s*번/);
  const totalMatch = fullText.match(/테스트\s*횟수\s*(\d+)\s*번/);

  return {
    rounds,
    completedRounds,
    isMeasuring: fullText.includes('측정중'),
    countdown: ifArea.querySelector('.delayTimeSec')?.textContent?.trim() || '',
    satisfyCount: satisfyMatch ? parseInt(satisfyMatch[1]) : 0,
    failCount: failMatch ? parseInt(failMatch[1]) : 0,
    totalCount: totalMatch ? parseInt(totalMatch[1]) : 0,
    fullText: fullText.slice(0, options.fullTextLimit),
    textSnippet: fullText.slice(0, 200),
  };
}

export function parseMbpsValue(text: string): number | null {
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function summarizeSlaResults(parsed: ParsedSlaResults): SlaResultSummary {
  const speeds = parsed.rounds
    .map((round) => parseMbpsValue(round.speed))
    .filter((value): value is number => value !== null);
  const slaRefs = parsed.rounds
    .map((round) => parseMbpsValue(round.slaRef))
    .filter((value): value is number => value !== null);
  const slaReferenceMbps = slaRefs.length > 0 ? Math.max(...slaRefs) : null;
  const inferredPlanMbps = slaReferenceMbps !== null ? slaReferenceMbps / KT_SLA_GUARANTEE_RATIO : null;

  const rawData = {
    total: parsed.totalCount,
    satisfy: parsed.satisfyCount,
    fail: parsed.failCount,
    rounds: parsed.rounds,
    parsed_speed_count: speeds.length,
    sla_ref_mbps: slaReferenceMbps,
    inferred_plan_mbps: inferredPlanMbps,
  };

  if (speeds.length === 0) {
    const error =
      parsed.totalCount > 0
        ? '측정 요약은 확인됐지만 회차별 다운로드 속도를 읽지 못했습니다. KT 측정 프로그램 결과 전달 상태를 확인하세요.'
        : '측정 결과 영역에서 회차별 다운로드 속도와 요약 정보를 읽지 못했습니다. KT 측정 프로그램 결과 전달 상태를 확인하세요.';

    return {
      downloadMbps: 0,
      slaResult: 'unknown',
      rawData,
      error,
    };
  }

  if (parsed.totalCount > 0 && parsed.totalCount < SLA_ROUND_TOTAL) {
    return {
      downloadMbps: speeds.reduce((a, b) => a + b, 0) / speeds.length,
      slaResult: 'unknown',
      rawData,
      error: `SLA 측정이 ${parsed.totalCount}/${SLA_ROUND_TOTAL}회만 기록되어 완료되지 않았습니다.`,
    };
  }

  const downloadMbps = speeds.reduce((a, b) => a + b, 0) / speeds.length;

  let slaResult: SpeedTestResult['sla_result'] = 'unknown';
  if (parsed.totalCount > 0) {
    slaResult = parsed.failCount >= SLA_FAIL_THRESHOLD ? 'fail' : 'pass';
  } else {
    const fallbackFailMatch = parsed.fullText.match(/미달\s*횟수는?\s*(\d+)\s*번/);
    const fallbackSatisfyMatch = parsed.fullText.match(/SLA\s*만족\s*횟수는?\s*(\d+)\s*번/);
    const fallbackFailCount = fallbackFailMatch ? Number(fallbackFailMatch[1]) : null;
    const fallbackSatisfyCount = fallbackSatisfyMatch ? Number(fallbackSatisfyMatch[1]) : null;

    if (fallbackFailCount !== null && fallbackFailCount >= SLA_FAIL_THRESHOLD) {
      slaResult = 'fail';
    } else if (fallbackSatisfyCount !== null && fallbackSatisfyCount >= SLA_FAIL_THRESHOLD) {
      slaResult = 'pass';
    }
  }

  return {
    downloadMbps,
    slaResult,
    rawData,
    error: '',
  };
}

/**
 * run() 실행 시 옵션.
 * debug=true면 headless를 강제로 off, slowMo/devtools 켜고
 * 에러 발생 시 브라우저를 사용자가 Enter 칠 때까지 닫지 않는다.
 */
export interface RunOptions {
  dryRun?: boolean;
  debug?: boolean;
}

function defaultResult(): SpeedTestResult {
  return {
    download_mbps: 0,
    upload_mbps: 0,
    ping_ms: 0,
    sla_result: 'unknown',
    complaint_filed: false,
    complaint_result: 'skipped',
    raw_data: {},
    error: '',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isChromeChannelMissingError(err: Error): boolean {
  const message = err.message.toLowerCase();

  return (
    message.includes("executable doesn't exist") ||
    message.includes("chromium distribution 'chrome' is not found") ||
    message.includes('chrome is not installed') ||
    message.includes('chrome not installed') ||
    (message.includes("channel 'chrome'") && message.includes('not found'))
  );
}

function canConnectToLocalPort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function findWindowsSpeedClientPath(): string | null {
  return KT_SPEED_CLIENT_PATHS.find((candidate) => fs.existsSync(candidate)) || null;
}

export class KTProvider {
  private config: Config;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private startedSpeedClient = false;
  private debugMode = false;

  constructor(config: Config) {
    this.config = config;
  }

  async run(dryRunOrOptions: boolean | RunOptions = false): Promise<SpeedTestResult> {
    // 하위 호환: 기존 호출 방식(boolean)은 dryRun만 지정.
    // 새 호출 방식은 { dryRun, debug } 객체.
    const options: RunOptions =
      typeof dryRunOrOptions === 'boolean' ? { dryRun: dryRunOrOptions } : dryRunOrOptions;
    const dryRun = options.dryRun === true;
    const debug = options.debug === true;

    const result = defaultResult();

    // 디버그 모드: 브라우저 창을 열고 각 동작을 slowMo로 느리게 실행.
    // 원인 추정이 어려운 상황(이슈 #3의 신규 기기 등록/다회선 주소지 선택/회선 미보유 등)에서
    // 사용자가 직접 브라우저를 관찰할 수 있게 한다. config.headless 값을 덮어씀.
    const headless = debug ? false : this.config.headless;
    this.debugMode = debug;
    const launchOptions = {
      headless,
      slowMo: debug ? 250 : 0,
      devtools: debug,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--disable-web-security',
      ],
    };

    await this.ensureWindowsSpeedClientRunning();

    try {
      if (process.platform === 'win32') {
        try {
          this.browser = await chromium.launch({ ...launchOptions, channel: 'chrome' });
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (!isChromeChannelMissingError(err)) {
            throw err;
          }
          console.warn(chalk.yellow(`⚠ 시스템 Chrome을 찾지 못해 Playwright Chromium으로 재시도합니다: ${err.message.split('\n')[0]}`));
        }
      }

      if (!this.browser) {
        // Playwright 브라우저 바이너리가 없으면 자동 설치 (npx 첫 실행 시 필요)
        try {
          this.browser = await chromium.launch(launchOptions);
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          if (err.message.includes("Executable doesn't exist")) {
            console.log('📦 Chromium 브라우저 설치 중... (최초 1회)');
            execSync('npx playwright install chromium', { stdio: 'inherit' });
            this.browser = await chromium.launch(launchOptions);
          } else {
            throw e;
          }
        }
      }

      this.context = await this.browser.newContext({
        // Windows의 KT 측정 프로그램 탐지는 브라우저 정보에 민감해서 실제 Chrome UA를 그대로 둔다.
        ...(process.platform === 'win32' ? {} : { userAgent: DEFAULT_BROWSER_USER_AGENT }),
        viewport: { width: 1280, height: 900 },
        // 이전 실행에서 저장한 로그인 세션이 있으면 복원 — 추가 본인인증 반복을 방지 (이슈 #13)
        ...(this.hasValidSessionState() ? { storageState: SESSION_STATE_PATH } : {}),
      });

      if (process.platform === 'win32') {
        try {
          await this.context.grantPermissions(['local-network-access'], {
            origin: KT_SPEED_ORIGIN,
          });
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.warn(
            chalk.yellow(`⚠ local-network-access 권한 부여 실패, 권한 없이 계속 진행합니다: ${err.message.split('\n')[0]}`),
          );
        }
      }
    } catch (e: unknown) {
      await this.context?.close();
      await this.browser?.close();
      await this.stopWindowsSpeedClientIfStarted();
      this.browser = null;
      this.context = null;
      throw e;
    }

    try {
      this.page = await this.context.newPage();

      // Step 1: 로그인
      stepHeader(STEPS.login);
      info('speed.kt.com 접속 중...');
      await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
      await this.handleLogin();

      const currentUrl = this.page.url();
      if (!currentUrl.includes('sla/slatest/introduce.asp')) {
        info('SLA 페이지로 이동 중...');
        await this.page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }
      info('로그인 완료');
      // 인증된 세션을 저장해 다음 실행에서 재사용 (추가 본인인증 반복 방지)
      await this.saveSession();

      // Step 2: SLA 테스트 준비
      stepHeader(STEPS.layer);
      info('품질보증(SLA) 테스트 레이어 열기...');
      await this.openSlaLayer();
      info('회선 선택 중...');
      await this.selectLine();
      info('준비 완료');

      // Step 3: 속도 측정
      stepHeader(STEPS.measure);
      info(`${SLA_ROUND_TOTAL}회 측정 시작 (약 25분 소요)`);
      await this.startMeasurement();
      await this.waitForCompletion();

      // Step 4: 결과 분석
      stepHeader(STEPS.parse);
      info('측정 데이터 파싱 중...');
      const parsed = await this.parseResults();
      Object.assign(result, parsed);

      // Step 5: 감면 처리
      stepHeader(STEPS.action);
      if (result.sla_result === 'fail' && !dryRun) {
        info('SLA 미달 → 이의신청 진행...');
        const ok = await this.fileComplaint();
        result.complaint_filed = ok;
        result.complaint_result = ok ? 'success' : 'failed';
        info(ok ? '이의신청 완료' : '이의신청 실패');
      } else if (result.sla_result === 'fail' && dryRun) {
        info('SLA 미달 (dry-run → 이의신청 생략)');
        result.complaint_result = 'skipped';
      } else if (result.sla_result === 'pass') {
        info('SLA 통과 → 이의신청 불필요');
        result.complaint_result = 'not_applicable';
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`오류: ${err.message}`));
      result.error = err.message;
      result.sla_result = 'unknown';

      // 오류 스크린샷
      try {
        await this.page?.screenshot({ path: 'kt-error.png' });
        info('스크린샷 저장: kt-error.png');
      } catch {
        // ignore
      }

      // 디버그 모드 + 인터랙티브 TTY에서는 브라우저를 열어둔 채 사용자 확인 대기.
      // 이슈 #3 같은 환경별 엣지 케이스를 눈으로 확인하기 위함.
      if (debug && process.stdin.isTTY && process.stdout.isTTY) {
        await this.waitForEnter(
          chalk.yellow('\n🔍 디버그 모드: 브라우저에서 현재 상태를 확인하세요.\n') +
            chalk.dim('   확인 후 Enter를 누르면 브라우저를 닫습니다... '),
        );
      }
    } finally {
      await this.context?.close();
      await this.browser?.close();
      await this.stopWindowsSpeedClientIfStarted();
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    return result;
  }

  private async ensureWindowsSpeedClientRunning(): Promise<void> {
    if (process.platform !== 'win32') return;

    if (await canConnectToLocalPort(KT_SPEED_CLIENT_PORT)) {
      info('KTSpeedClient 로컬 서버 확인됨');
      return;
    }

    const clientPath = findWindowsSpeedClientPath();
    if (!clientPath) {
      console.warn(chalk.yellow('⚠ KTSpeedClient 실행 파일을 찾지 못했습니다. KT 페이지에서 설치 안내가 표시될 수 있습니다.'));
      return;
    }

    info('KTSpeedClient 로컬 서버가 없어 실행합니다...');
    this.startedSpeedClient = true;
    const child = spawn(clientPath, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();

    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      if (await canConnectToLocalPort(KT_SPEED_CLIENT_PORT)) {
        info('KTSpeedClient 로컬 서버 시작 확인');
        return;
      }
    }

    console.warn(chalk.yellow('⚠ KTSpeedClient를 실행했지만 로컬 서버가 열리지 않았습니다. KT 페이지에서 설치 안내가 표시될 수 있습니다.'));
  }

  private async stopWindowsSpeedClientIfStarted(): Promise<void> {
    if (process.platform !== 'win32' || !this.startedSpeedClient) return;

    this.startedSpeedClient = false;

    try {
      const commands = [
        "Get-Process -Name 'kt-speed-client' -ErrorAction SilentlyContinue | Stop-Process -Force",
        `Get-NetTCPConnection -LocalPort ${KT_SPEED_CLIENT_PORT} -ErrorAction SilentlyContinue | ` +
          'ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }',
      ];

      execSync(`powershell.exe -NoProfile -Command "${commands.join('; ')}"`, {
        stdio: 'ignore',
      });

      for (let i = 0; i < 5; i++) {
        if (!(await canConnectToLocalPort(KT_SPEED_CLIENT_PORT, 500))) {
          info('KTSpeedClient 로컬 서버 종료 확인');
          return;
        }
        await sleep(500);
      }

      console.warn(chalk.yellow('⚠ KTSpeedClient 종료 후에도 로컬 서버 포트가 열려 있습니다.'));
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn(chalk.yellow(`⚠ KTSpeedClient 종료 실패: ${err.message.split('\n')[0]}`));
    }
  }

  /**
   * 디버그 모드에서 사용자가 브라우저를 관찰할 시간을 주기 위해
   * Enter 입력을 기다린다. TTY가 아니면 즉시 반환.
   */
  private waitForEnter(prompt: string): Promise<void> {
    return new Promise((resolve) => {
      if (!process.stdin.isTTY) {
        resolve();
        return;
      }
      process.stdout.write(prompt);
      const onData = () => {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        resolve();
      };
      process.stdin.resume();
      process.stdin.once('data', onData);
    });
  }

  private async handleLogin(): Promise<void> {
    const page = this.page!;
    const { id, password } = this.config.credentials;

    if (!id || !password) {
      throw new Error('KT 계정 정보가 설정되지 않았습니다. 설정 파일을 확인하세요.');
    }

    const url = page.url();
    if (!url.includes('accounts.kt.com')) {
      return;
    }

    info('KT 로그인 페이지 감지...');
    await this.fillLoginForm(id, password);
    await this.postLoginChecks();
  }

  // 로그인 제출 직후의 공통 처리: 리다이렉트 대기 → 자격증명 오류 확인 →
  // 비밀번호 변경 안내 스킵 → 추가 본인인증 처리. (handleLogin/openSlaLayer 공용)
  private async postLoginChecks(): Promise<void> {
    const page = this.page!;

    // 로그인 후 리다이렉트 대기 — accounts.kt.com에서 벗어날 때까지
    try {
      await page.waitForURL((url) => !url.toString().includes('accounts.kt.com'), { timeout: 15000 });
    } catch {
      // 비밀번호 변경/추가 인증 등 중간 페이지에서 멈출 수 있음
    }
    await sleep(2000);

    if (page.url().includes('accounts.kt.com')) {
      // 아이디/비밀번호 오류를 추가 인증으로 오진하지 않도록 먼저 걸러낸다
      const loginError = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        return ['일치하지 않습니다', '잘못 입력', '아이디 또는 비밀번호', '입력 오류'].some((kw) =>
          text.includes(kw),
        );
      });
      if (loginError) {
        throw new Error('KT 로그인에 실패했습니다. 설정 파일의 아이디/비밀번호를 확인하세요.');
      }
    }

    await this.skipPasswordChangeIfPresent();

    // 추가 본인인증(PASS/문자) — 2026-06-12 이후 KT가 새 세션의 로그인에 요구 (이슈 #13).
    // 저장된 세션(SESSION_STATE_PATH)으로 로그인이 유지되면 이 단계는 아예 오지 않는다.
    await this.handleExtraAuth();
  }

  private async skipPasswordChangeIfPresent(): Promise<void> {
    const page = this.page!;
    const url = page.url();
    if (!url.includes('unchanged-password') && !url.includes('change-password')) {
      return;
    }
    info('비밀번호 변경 안내 → 다음에 하기');
    try {
      await page.waitForSelector('button', { timeout: 5000 });
      await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const text = btn.textContent || '';
          if (text.includes('다음에 하기') || text.includes('나중에') || text.includes('Skip')) {
            btn.click();
            return;
          }
        }
      });
      await sleep(3000);
    } catch {
      // 다음에 하기 버튼 없음, 계속 진행
    }
  }

  // 로그인 제출 후에도 accounts.kt.com에 머물러 있고 본인인증 화면이 떠 있으면,
  // 자동 실행에서는 명확한 안내와 함께 실패시키고, --debug 모드에서는
  // 사용자가 직접 인증을 마칠 때까지 대기한 뒤 세션을 저장한다.
  private async handleExtraAuth(): Promise<void> {
    const page = this.page!;

    if (!page.url().includes('accounts.kt.com')) {
      return;
    }

    const needsExtraAuth = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return ['본인인증', '인증번호', '추가 인증', 'PASS 인증'].some((kw) => text.includes(kw));
    });
    if (!needsExtraAuth) {
      return;
    }

    // config의 headless:false로 무인 실행하는 경우도 있으므로,
    // 사용자가 지켜보고 있다고 확신할 수 있는 --debug에서만 대기한다
    if (!this.debugMode) {
      throw new Error(
        'KT가 추가 본인인증(PASS/문자)을 요구합니다. 아래 명령으로 브라우저를 열어 1회만 인증하세요:\n' +
          '  npx -y damn-my-slow-kt@latest run --debug --dry-run --force\n' +
          '인증이 끝나면 세션이 저장되어 이후에는 headless로 자동 실행됩니다.',
      );
    }

    info('추가 본인인증(PASS/문자) 감지 — 열린 브라우저에서 인증을 완료해주세요 (최대 5분 대기)');
    try {
      await page.waitForURL((url) => !url.toString().includes('accounts.kt.com'), {
        timeout: 5 * 60 * 1000,
      });
    } catch {
      // 인증 직후 비밀번호 변경 안내 등으로 accounts.kt.com에 머무를 수 있어
      // URL만으로 단정하지 않고 아래에서 후처리를 시도한다
    }
    await sleep(2000);
    await this.skipPasswordChangeIfPresent();

    if (page.url().includes('accounts.kt.com')) {
      throw new Error('추가 본인인증이 5분 내에 완료되지 않았습니다. 다시 실행해 인증을 진행해주세요.');
    }
    if (await this.saveSession()) {
      info('추가 인증 완료 — 세션 저장됨');
    } else {
      console.warn(
        chalk.yellow('⚠ 추가 인증은 완료했지만 세션 저장에 실패했습니다. 다음 실행에서 인증이 다시 필요할 수 있습니다'),
      );
    }
  }

  private async saveSession(): Promise<boolean> {
    try {
      await this.context?.storageState({ path: SESSION_STATE_PATH });
      // 로그인 쿠키가 담기므로 소유자만 읽을 수 있게 제한
      fs.chmodSync(SESSION_STATE_PATH, 0o600);
      return true;
    } catch {
      // 세션 저장 실패는 측정 진행에 영향을 주지 않는다
      return false;
    }
  }

  // 저장된 세션 파일이 존재하고 유효한 JSON일 때만 복원 대상으로 삼는다.
  // 손상된 파일(저장 중 강제 종료 등)을 그대로 넘기면 newContext가 던지면서
  // --debug를 포함한 모든 실행이 막히므로, 여기서 걸러내고 새로 로그인한다.
  private hasValidSessionState(): boolean {
    if (!fs.existsSync(SESSION_STATE_PATH)) {
      return false;
    }
    try {
      JSON.parse(fs.readFileSync(SESSION_STATE_PATH, 'utf8'));
      return true;
    } catch {
      console.warn(chalk.yellow('⚠ 저장된 세션 파일이 손상되어 무시하고 새로 로그인합니다'));
      try {
        fs.unlinkSync(SESSION_STATE_PATH);
      } catch {
        // 삭제 실패해도 복원만 건너뛰면 된다
      }
      return false;
    }
  }

  private async openSlaLayer(): Promise<void> {
    const page = this.page!;
    const { id, password } = this.config.credentials;

    // SLA 테스트 버튼 클릭 — 미로그인 시 accounts.kt.com으로 리다이렉트됨
    const btnExists = await page.evaluate(() => {
      return !!document.querySelector('a.redbtn.btntolayer');
    });

    if (!btnExists) {
      throw new Error('품질보증(SLA) 테스트 버튼을 찾지 못했습니다');
    }

    await page.click('a.redbtn.btntolayer');
    await sleep(3000);

    // 로그인 페이지로 리다이렉트 되었는지 확인
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.kt.com')) {
      info('로그인 필요 → 로그인 진행');
      await this.fillLoginForm(id, password);
      await this.postLoginChecks();
      // 이 경로로 새로 로그인한 세션도 저장해 다음 실행에서 재사용
      await this.saveSession();

      // 로그인 후 SLA 페이지로 재접속
      if (!page.url().includes('sla/slatest/introduce.asp')) {
        await page.goto(KT_SLA_INTRO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
      }

      // 다시 레이어 버튼 클릭
      await page.click('a.redbtn.btntolayer');
      await sleep(3000);
    }

    // 레이어가 열렸는지 확인 — Vue 컴포넌트가 #ifArea에 회선 정보를 렌더링
    const layerText = await page.evaluate(() => {
      return document.getElementById('ifArea')?.textContent?.trim().slice(0, 200) || '';
    });

    if (!layerText) {
      throw new Error('로그인 후에도 SLA 레이어가 열리지 않았습니다');
    }

    info('SLA 레이어 열림');
  }

  private async fillLoginForm(id: string, password: string): Promise<void> {
    const page = this.page!;

    // accounts.kt.com 로그인 폼: input#id (아이디), input#password (비밀번호)
    // 구버전 호환을 위해 generic selector도 fallback으로 유지
    const idSelectors = ['input#id', "input[name='id']", "input[type='text']"];
    const pwSelectors = ['input#password', "input[name='password']", "input[type='password']"];

    let idFilled = false;
    for (const sel of idSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 5000 });
        await page.fill(sel, id);
        info(`계정: ${id}`);
        idFilled = true;
        break;
      } catch {
        continue;
      }
    }
    if (!idFilled) return;

    for (const sel of pwSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 3000 });
        await page.fill(sel, password);
        break;
      } catch {
        continue;
      }
    }

    // 로그인 버튼 클릭 — Playwright의 click()으로 안정적인 클릭
    try {
      const loginBtn = page.locator('button[type="submit"]').filter({ hasText: '로그인' });
      await loginBtn.waitFor({ state: 'visible', timeout: 3000 });
      await loginBtn.click();
    } catch {
      // fallback: evaluate로 직접 클릭
      try {
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button, input[type="submit"]');
          for (const btn of btns) {
            const text = (btn as HTMLElement).textContent || (btn as HTMLInputElement).value || '';
            if (text.includes('로그인')) {
              (btn as HTMLElement).click();
              return;
            }
          }
        });
      } catch {
        // 로그인 버튼 없음
      }
    }
  }

  private async selectLine(): Promise<void> {
    const page = this.page!;

    const result = await page.evaluate(() => {
      // Element UI 라디오 — 첫 번째 회선이 기본 선택됨
      const radioLabel = document.querySelector('label.el-radio.addr') as HTMLElement | null;
      if (radioLabel) {
        radioLabel.click(); // Element UI는 label 클릭으로 선택 처리

        // 회선 정보 텍스트 추출 (상품명 - 주소)
        const labelText = radioLabel.querySelector('.el-radio__label')?.textContent?.trim() || '';
        return labelText || 'selected (no label)';
      }

      // fallback: generic radio
      const radioInput = document.querySelector('input[type="radio"]') as HTMLInputElement | null;
      if (radioInput) {
        radioInput.checked = true;
        radioInput.dispatchEvent(new Event('change', { bubbles: true }));
        const label = radioInput.closest('label');
        if (label) (label as HTMLElement).click();
        return radioInput.value;
      }
      return 'no radio found';
    });

    if (result === 'no radio found') {
      // SLA 레이어는 열렸지만 회선 라디오 버튼이 없음 = 이 계정에 KT 인터넷 회선이 연결되어 있지 않음.
      // #measureBtn 단계까지 내려가기 전에 여기서 명확한 원인으로 끊어야 이슈 #3의
      // 다른 엣지 케이스(속도측정 프로그램 미설치, 새 기기 등록 등)와 혼동되지 않음.
      throw new Error(
        'KT 회선 정보를 찾을 수 없습니다. 이 계정에 KT 인터넷 회선이 연결되어 있는지 확인하세요. ' +
          '(회선이 없는 계정으로는 SLA 측정이 불가능합니다)',
      );
    }

    if (result) {
      info(`회선: ${result}`);
    }

    await sleep(500);
  }

  private async startMeasurement(): Promise<void> {
    const page = this.page!;

    // #measureBtn (a.speed_speedtest_prestart_btn) 클릭 — Vue 컴포넌트가 SLA 테스트 시작
    const btn = page.locator('#measureBtn, a.speed_speedtest_prestart_btn').first();
    try {
      await btn.waitFor({ state: 'visible', timeout: 5000 });
      await btn.click();
    } catch {
      // 회선 미보유 케이스는 selectLine() 단계에서 이미 걸러짐.
      // 여기까지 와서 버튼이 안 뜨는 건 그 외 원인 (이슈 #3 참고).
      throw new Error(
        '속도 측정 시작 버튼(#measureBtn)을 찾지 못했습니다. 자주 발생하는 원인:\n' +
          '  • KT 속도측정 프로그램 미설치 (https://speed.kt.com/file/ktspeed.pkg)\n' +
          '  • 새 기기 등록 화면이 추가로 뜸\n' +
          '  • 다회선 계정에서 주소지 선택 화면이 추가로 뜸\n' +
          '  디버그 모드로 원인 확인: npx -y damn-my-slow-kt@latest run --debug',
      );
    }

    await sleep(5000);

    // 측정이 시작되었는지 확인 — "회차 측정중" 또는 결과 테이블이 나타나야 함
    const layerText = await page.evaluate(() => {
      return (
        document
          .getElementById('ifArea')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300) || ''
      );
    });

    if (layerText.includes('측정중') || layerText.includes('SLA 테스트')) {
      info('측정 시작 확인');
    } else {
      info('측정 시작 대기 중...');
    }

    // 단말 정보 출력 — 페이지 하단의 품질측정 단말정보
    const deviceInfo = await page.evaluate(() => {
      const ifArea = document.getElementById('ifArea');
      if (!ifArea) return null;
      const text = ifArea.textContent || '';
      const osMatch = text.match(/OS\s+([\s\S]*?)(?=CPU)/);
      const cpuMatch = text.match(/CPU\s+([\s\S]*?)(?=RAM)/);
      const ramMatch = text.match(/RAM\s+([\s\S]*?)(?=Browser)/);
      const browserMatch = text.match(/Browser\s+([\s\S]*?)(?=재측정|$)/);
      return {
        os: osMatch ? osMatch[1].trim() : '',
        cpu: cpuMatch ? cpuMatch[1].trim() : '',
        ram: ramMatch ? ramMatch[1].trim() : '',
        browser: browserMatch ? browserMatch[1].trim() : '',
      };
    });

    if (deviceInfo && deviceInfo.os) {
      info(chalk.cyan('품질측정 단말정보:'));
      info(`  OS: ${deviceInfo.os}`);
      info(`  CPU: ${deviceInfo.cpu}`);
      info(`  RAM: ${deviceInfo.ram}`);
      info(`  Browser: ${deviceInfo.browser}`);
    }

    // HTML 캡처 저장 (디버그/증거용)
    await this.saveHtmlSnapshot('measurement-start');
  }

  private async waitForCompletion(): Promise<void> {
    const page = this.page!;
    const maxWaitMs = SLA_TEST_TIMEOUT_MS;
    let elapsed = 0;
    let lastReportedRound = 0; // 이미 출력한 라운드 추적

    while (elapsed < maxWaitMs) {
      await sleep(POLL_INTERVAL_MS);
      elapsed += POLL_INTERVAL_MS;

      // 구조화된 CSS 클래스로 회차별 결과를 직접 파싱
      const status = await page.evaluate(parseSlaDomResults, {
        roundTotal: SLA_ROUND_TOTAL,
        includeEmptyRounds: true,
        fullTextLimit: 500,
      });

      if (!status) continue;

      if (process.env.DEBUG_POLL) {
        console.log(`\n[DEBUG POLL ${formatElapsed(elapsed)}] rounds=${status.completedRounds} measuring=${status.isMeasuring} countdown=${status.countdown} total=${status.totalCount}`);
        console.log(`  text: ${status.textSnippet}`);
      }

      // 새로 완료된 라운드가 있으면 즉시 결과 출력
      if (status.completedRounds > lastReportedRound) {
        for (let i = lastReportedRound; i < status.completedRounds; i++) {
          const r = status.rounds[i];
          const isFail = r.result.includes('미달');
          const icon = isFail ? '❌' : '✅';
          if (process.stdout.isTTY) process.stdout.write('\n'); // 진행 바 줄바꿈
          info(`${icon} ${i + 1}회차: ${r.speed} (기준 ${r.slaRef}) → ${r.result}  [${r.date}]`);
        }
        lastReportedRound = status.completedRounds;

        // HTML 스냅샷 저장
        await this.saveHtmlSnapshot(`round-${status.completedRounds}`);
      }

      // 완료 조건: 5개 회차의 측정값이 모두 채워짐
      // (페이지가 "측정중" 텍스트를 유지하더라도, 5개 속도값이 있으면 완료)
      if (status.completedRounds >= SLA_ROUND_TOTAL) {
        measureProgress(SLA_ROUND_TOTAL, SLA_ROUND_TOTAL, elapsed);
        if (process.stdout.isTTY) console.log('');
        info(`${SLA_ROUND_TOTAL}회 측정 완료!`);
        await this.saveHtmlSnapshot('complete');
        break;
      } else if (status.completedRounds > 0) {
        measureProgress(status.completedRounds, SLA_ROUND_TOTAL, elapsed);
        if (status.countdown) {
          if (process.stdout.isTTY) {
            process.stdout.write(`${chalk.dim(` 다음: ${status.countdown}`)}\x1b[K`);
          }
        }
      }
    }

    if (elapsed >= maxWaitMs) {
      if (process.stdout.isTTY) console.log('');
      info(chalk.yellow(`⏰ ${Math.round(maxWaitMs / 60000)}분 타임아웃 - 현재 결과로 진행`));
      await this.saveHtmlSnapshot('timeout');
    }
  }

  private async parseResults(): Promise<Partial<SpeedTestResult>> {
    const page = this.page!;
    const result: Partial<SpeedTestResult> = {
      download_mbps: 0,
      upload_mbps: 0,
      ping_ms: 0,
      sla_result: 'unknown',
      raw_data: {},
      error: '',
    };

    try {
      // 구조화된 DOM에서 회차별 데이터를 직접 추출
      const parsed = await page.evaluate(parseSlaDomResults, {
        roundTotal: SLA_ROUND_TOTAL,
        includeEmptyRounds: false,
        fullTextLimit: 500,
      });

      if (!parsed) {
        result.error = 'ifArea 엘리먼트를 찾지 못했습니다';
        return result;
      }

      // 회차별 속도와 SLA 판정은 같은 기준으로 계산해야 알림/DB가 어긋나지 않는다.
      const summary = summarizeSlaResults(parsed);
      result.download_mbps = summary.downloadMbps;
      result.sla_result = summary.slaResult;
      result.raw_data = summary.rawData;
      result.error = summary.error;

      if (summary.error) {
        info(chalk.yellow(summary.error));
      }

      // SLA 결과 판정
      const { satisfyCount, failCount, totalCount } = parsed;
      if (totalCount > 0) {
        info(`전체 ${totalCount}회: 만족 ${satisfyCount}회, 미달 ${failCount}회`);
      }

      // 개별 라운드 결과 출력
      for (const round of parsed.rounds) {
        const isFail = round.result.includes('미달');
        const icon = isFail ? '❌' : '✅';
        info(`  ${icon} ${round.speed} (기준: ${round.slaRef}) → ${round.result}`);
      }

      // fallback 판정은 summarizeSlaResults()에서 처리한다.
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`결과 파싱 실패: ${err.message}`));
      result.error = err.message;
    }

    return result;
  }

  /**
   * 5회 측정 완료 후 "속도측정 상세이력" 다이얼로그가 자동으로 뜸.
   * 다이얼로그에서:
   * 1. 측정 결과 상세 정보를 CLI에 출력 (증거)
   * 2. 전화번호를 입력 (config.phone)
   * 3. "확인" 버튼 클릭 → 이의신청(품질점검 신청) 완료
   */
  private async fileComplaint(): Promise<boolean> {
    const page = this.page!;

    // 상세이력 다이얼로그가 열릴 때까지 대기
    try {
      await page.waitForSelector('.slaTestResultDetailPopup', { state: 'visible', timeout: 30000 });
    } catch {
      info('상세이력 다이얼로그가 열리지 않았습니다');
      return false;
    }

    await sleep(2000);
    await this.saveHtmlSnapshot('complaint-dialog');

    // 상세이력 정보를 CLI에 출력
    const detail = await page.evaluate(() => {
      const popup = document.querySelector('.slaTestResultDetailPopup');
      if (!popup) return null;

      // 요약 테이블 (test_table type1) 파싱
      const summaryRows = popup.querySelectorAll('.test_table.type1 tr');
      const summary: Record<string, string> = {};
      summaryRows.forEach(row => {
        const th = row.querySelector('th')?.textContent?.trim() || '';
        const td = row.querySelector('td')?.textContent?.trim() || '';
        if (th) summary[th] = td;
      });

      // 회차별 속도 테이블 (test_table type3) 파싱
      const speedRows = popup.querySelectorAll('.test_table.type3 tbody tr');
      const rounds: Array<{ round: string; speed: string }> = [];
      speedRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          rounds.push({
            round: cells[0].textContent?.trim() || '',
            speed: cells[1].textContent?.trim() || '',
          });
        }
      });

      return { summary, rounds };
    });

    if (detail) {
      console.log('');
      info(chalk.cyan('━━━ SLA 테스트 결과 상세 ━━━'));
      info(`  측정일자:    ${detail.summary['측정일자'] || '-'}`);
      info(`  상품명:      ${detail.summary['상품명'] || '-'}`);
      info(`  SLA기준속도: ${detail.summary['SLA기준속도'] || '-'}`);
      info(`  측정횟수:    ${detail.summary['측정횟수'] || '-'}`);
      info(`  미달횟수:    ${detail.summary['미달횟수'] || '-'}`);
      info(`  결과:        ${detail.summary['결 과'] || '-'}`);
      info('');
      info('  회차별 다운로드 속도:');
      for (const r of detail.rounds) {
        info(`    ${r.round}회차: ${r.speed} Mbps`);
      }
      info(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━'));
    }

    // 전화번호 입력 — config.phone에서 가져옴
    const phone = this.config.phone || '';
    if (!phone) {
      info(chalk.yellow('전화번호가 설정되지 않아 이의신청을 진행할 수 없습니다.'));
      info(chalk.dim('설정 파일에 phone: "01012345678" 을 추가하세요.'));
      return false;
    }

    // 010-XXXX-XXXX 형태로 파싱
    const digits = phone.replace(/-/g, '');
    const prefix = digits.slice(0, 3);  // 010
    const mid = digits.slice(3, 7);     // 중간 4자리
    const last = digits.slice(7, 11);   // 끝 4자리

    info(`연락처 입력: ${prefix}-${mid}-${last}`);

    // 휴대폰 라디오 선택 (기본이 hp이지만 명시적으로)
    await page.evaluate(() => {
      const hpRadio = document.querySelector('input[type="radio"][value="hp"]') as HTMLInputElement;
      if (hpRadio) {
        const label = hpRadio.closest('label');
        if (label) label.click();
      }
    });

    // 중간번호, 끝번호 입력
    try {
      await page.fill('input[name="telnum2"]', mid);
      await page.fill('input[name="telnum3"]', last);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`전화번호 입력 실패: ${err.message}`));
      return false;
    }

    await sleep(1000);

    // "확인" 버튼 클릭
    try {
      await page.click('a.sla_popup_detail_confirmCompAction_btn');
      info('품질점검 신청 확인 클릭');
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      info(chalk.red(`확인 버튼 클릭 실패: ${err.message}`));
      return false;
    }

    await sleep(3000);
    await this.saveHtmlSnapshot('complaint-submitted');

    return true;
  }

  async takeScreenshot(filePath = 'screenshot.png'): Promise<void> {
    if (this.page) {
      await this.page.screenshot({ path: filePath });
      console.log(`스크린샷 저장: ${filePath}`);
    }
  }

  /** #ifArea의 HTML을 파일로 저장 — 디버그/증거용 */
  private async saveHtmlSnapshot(label: string): Promise<void> {
    try {
      const snapshotDir = path.join(DATA_DIR, 'snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filePath = path.join(snapshotDir, `${timestamp}_${label}.html`);

      const html = await this.page!.evaluate(() => {
        return document.getElementById('ifArea')?.innerHTML || document.body.innerHTML;
      });

      fs.writeFileSync(filePath, html, 'utf8');
    } catch {
      // 스냅샷 저장 실패는 무시 — 측정 플로우에 영향 없음
    }
  }
}
