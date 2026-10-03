/**
 * 업데이트 후 마이그레이션 체크 시스템
 * 
 * 설정 파일의 _config_version을 기준으로 필요한 마이그레이션을 감지하고
 * 사용자에게 적용 여부를 묻는다.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { Config, saveConfig } from './config';
import { installSchedule, removeSchedule, getPlatform } from './scheduler';

/** 현재 최신 config version */
export const CURRENT_CONFIG_VERSION = 3;

interface Migration {
  /** 이 마이그레이션이 적용되는 target version */
  version: number;
  /** 사용자에게 보여줄 제목 */
  title: string;
  /** 상세 설명 */
  description: string;
  /** 마이그레이션 적용 함수. true 반환 시 config가 변경됨 */
  apply: (config: Config) => Config;
  /** 스케줄 재등록이 필요한지 여부 */
  requiresScheduleReinstall: boolean;
}

/**
 * 버전별 마이그레이션 목록.
 * version 오름차순으로 정의. 사용자의 현재 _config_version보다 높은 것만 실행.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    title: '설정 파일 경로 변경',
    description: '기본 경로가 ./config.yaml → ~/.damn-my-slow-isp/config-kt.yaml로 변경되었습니다.',
    apply: (config) => {
      // 경로 변경은 이미 코드에서 처리됨. config_version만 업데이트.
      return { ...config, _config_version: 2 };
    },
    requiresScheduleReinstall: false,
  },
  {
    version: 3,
    title: '다회 측정 지원 (하루 최대 10회)',
    description: [
      '기존: 하루 1회 측정',
      '변경: 하루 최대 10회, 2시간 간격으로 측정 (감면 성공 시 중단)',
      '',
      '속도가 정상으로 나올 수 있는 시간대를 피해 여러 번 측정합니다.',
      '스케줄 재등록이 필요합니다.',
    ].join('\n'),
    apply: (config) => {
      return {
        ...config,
        schedule: {
          ...config.schedule,
          max_attempts: 10,
          retry_interval_minutes: 120,
          stop_on_complaint_success: true,
        },
        _config_version: 3,
      };
    },
    requiresScheduleReinstall: true,
  },
];

/**
 * 대기 중인 마이그레이션이 있는지 확인하고 interactive하게 적용.
 * non-interactive (cron/launchd) 환경에서는 스킵하고 안내만 출력.
 */
export async function checkAndRunMigrations(
  config: Config,
  configPath: string,
  options: { interactive?: boolean } = {}
): Promise<Config> {
  const currentVersion = config._config_version || 1;
  
  if (currentVersion >= CURRENT_CONFIG_VERSION) {
    return config; // 최신 상태
  }

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return config;

  console.log('');
  console.log(chalk.yellow('📋 업데이트 후 변경 사항이 있습니다:'));
  console.log('');

  for (const migration of pending) {
    console.log(chalk.bold(`  [v${migration.version}] ${migration.title}`));
    for (const line of migration.description.split('\n')) {
      console.log(chalk.dim(`    ${line}`));
    }
    console.log('');
  }

  // non-interactive (cron/launchd 등)에서는 적용하지 않고 안내만
  const isInteractive = options.interactive !== undefined 
    ? options.interactive 
    : process.stdout.isTTY === true;

  if (!isInteractive) {
    console.log(chalk.yellow('  → 대화형 환경에서 "npx -y damn-my-slow-kt@latest run" 을 실행하여 마이그레이션을 적용하세요.'));
    console.log('');
    return config;
  }

  let updatedConfig = { ...config };
  let needScheduleReinstall = false;

  for (const migration of pending) {
    const { apply: doApply } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'apply',
        message: `[v${migration.version}] ${migration.title} - 적용하시겠습니까?`,
        default: true,
      },
    ]);

    if (doApply) {
      updatedConfig = migration.apply(updatedConfig);
      if (migration.requiresScheduleReinstall) {
        needScheduleReinstall = true;
      }
      console.log(chalk.green(`  ✅ v${migration.version} 적용 완료`));
    } else {
      // 거절해도 version은 올려서 다시 묻지 않도록
      updatedConfig._config_version = migration.version;
      console.log(chalk.dim(`  ⏭️  v${migration.version} 건너뜀`));
    }
  }

  // config 저장
  saveConfig(updatedConfig, configPath);
  console.log(chalk.dim(`\n  설정 파일 저장됨: ${configPath}`));

  // 스케줄 재등록
  if (needScheduleReinstall) {
    const platform = getPlatform();
    if (platform !== 'unknown') {
      const { reinstall } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'reinstall',
          message: '스케줄을 새 설정으로 재등록하시겠습니까?',
          default: true,
        },
      ]);

      if (reinstall) {
        try {
          removeSchedule();
          installSchedule(updatedConfig, configPath);
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(chalk.red(`스케줄 재등록 실패: ${err.message}`));
          console.error(chalk.dim(`수동으로 재등록하세요: npx -y damn-my-slow-kt@latest schedule install --config ${configPath}`));
        }
      }
    }
  }

  console.log('');
  return updatedConfig;
}
