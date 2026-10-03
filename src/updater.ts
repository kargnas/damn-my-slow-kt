/**
 * 자동 업데이트 체크 - npm registry에서 최신 버전 확인
 * 24시간에 1번만 체크 (캐시)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import chalk from 'chalk';

const CACHE_FILE = path.join(os.homedir(), '.damn-my-slow-isp', 'update-cache.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24시간
const PACKAGE_NAME = 'damn-my-slow-kt';

interface UpdateCache {
  lastCheck: number;
  latestVersion: string;
}

function readCache(): UpdateCache | null {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // ignore cache write errors
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await axios.get(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      timeout: 5000,
    });
    return resp.data?.version || null;
  } catch {
    return null;
  }
}

/**
 * 업데이트 안내용 버전 비교 — major.minor.patch만 비교한다 (엄밀한 semver 우선순위 아님).
 * prerelease(0.5.28-idlogin.1 같은 로컬 빌드)를 Number()로 바꾸면 NaN → 0.5.0으로 취급되어
 * 잘못된 업데이트 안내가 떴다. 같은 core에서 빌드한 로컬 버전에 같은 릴리스를 안내하지 않도록 -prerelease, +metadata는 버린다.
 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => v.split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = core(a);
  const pb = core(b);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

export async function checkForUpdates(
  currentVersion: string,
  options: { noUpdateCheck?: boolean; interactive?: boolean } = {}
): Promise<void> {
  if (options.noUpdateCheck) return;

  const cache = readCache();
  const now = Date.now();

  // 24시간 이내 체크했으면 스킵
  if (cache && now - cache.lastCheck < CHECK_INTERVAL_MS) {
    const latestVersion = cache.latestVersion;
    if (latestVersion && compareVersions(latestVersion, currentVersion) > 0) {
      printUpdateNotice(currentVersion, latestVersion);
    }
    return;
  }

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) return;

  writeCache({ lastCheck: now, latestVersion });

  if (compareVersions(latestVersion, currentVersion) > 0) {
    printUpdateNotice(currentVersion, latestVersion);
  }
}

function printUpdateNotice(current: string, latest: string): void {
  console.log('');
  console.log(
    chalk.yellow('🔄 새 버전이 있습니다:') +
      chalk.dim(` v${current}`) +
      chalk.yellow(' → ') +
      chalk.green(`v${latest}`)
  );
  console.log(chalk.dim('   업데이트하려면:'));
  console.log(chalk.cyan(`   npm install -g ${PACKAGE_NAME}@latest`));
  console.log('');
}
