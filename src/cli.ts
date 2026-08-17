/**
 * CLI 커맨드 정의 - commander 기반
 *
 * Usage:
 *   damn-my-slow-kt init              # 초기 설정 (~/.damn-my-slow-isp/config-kt.yaml)
 *   damn-my-slow-kt run               # 측정 + 감면 신청 (설정에 따라 다회 반복)
 *   damn-my-slow-kt run --once        # 1회만 측정
 *   damn-my-slow-kt run --dry-run     # 측정만 (감면 신청 생략)
 *   damn-my-slow-kt history           # 이력 조회
 *   damn-my-slow-kt report            # 요약 리포트
 *   damn-my-slow-kt schedule install  # 스케줄 등록
 *   damn-my-slow-kt schedule remove   # 스케줄 제거
 */

import { Command } from "commander";
import inquirer from "inquirer";
import chalk from "chalk";
import path from "path";
import { execSync } from "child_process";
import fs from "fs";

import {
  loadConfig,
  saveConfig,
  getDefaultConfig,
  DEFAULT_CONFIG_PATH,
  DATA_DIR,
  Config,
  validateRequiredFields,
} from "./config";
import {
  isInsideDocker,
  isDockerAvailable,
  isSharedLibraryError,
  reExecInDocker,
  printDockerInstallGuide,
} from "./docker";
import { SpeedDatabase } from "./db";
import {
  KTProvider,
  KT_SLA_GUARANTEE_RATIO,
  parseMbpsValue,
  SpeedTestResult,
} from "./kt";
import { sendNotifications } from "./notify";
import { printHistory, printStats } from "./report";
import { installSchedule, removeSchedule, getPlatform } from "./scheduler";
import { checkForUpdates } from "./updater";
import { checkAndRunMigrations, CURRENT_CONFIG_VERSION } from "./migration";

// package.json에서 버전 읽기
const pkg = require("../package.json") as { version: string; name: string };

export function buildCli(): Command {
  const program = new Command();

  program
    .name("damn-my-slow-kt")
    .description("🐌 느린 KT 인터넷? 자동으로 환불받자.")
    .version(pkg.version)
    .option("--no-update-check", "자동 업데이트 체크 비활성화");

  // ─────────────────────────────────────
  // init
  // ─────────────────────────────────────
  program
    .command("init")
    .description("초기 설정: 설정 파일 생성 + 자동 스케줄 설치 여부 질문")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .option("-f, --force", "기존 파일 덮어쓰기", false)
    .action(async (opts: { config: string; force: boolean }) => {
      const configPath = opts.config;

      if (fs.existsSync(configPath) && !opts.force) {
        // 기존 설정 파일이 있으면 마이그레이션 체크 후 종료
        let cfg = loadConfig(configPath);
        cfg = await checkAndRunMigrations(cfg, configPath, {
          interactive: true,
        });

        if (cfg._config_version >= CURRENT_CONFIG_VERSION) {
          const missingFields = validateRequiredFields(cfg);
          if (missingFields.length > 0) {
            console.log(chalk.yellow(`⚠️  설정 파일은 있지만 필수 항목이 누락되었습니다:`));
            for (const field of missingFields) {
              console.log(chalk.yellow(`   • ${field}`));
            }
            console.log(
              `\n'npx -y damn-my-slow-kt@latest init --force' 명령으로 설정을 다시 진행하세요.`,
            );
          } else {
            console.log(
              chalk.green(`✅ 설정이 최신 상태입니다. (v${cfg._config_version})`),
            );
            console.log(chalk.dim(`   ${configPath}`));
            console.log(
              chalk.dim("\n   새로 설정하려면 --force 옵션을 사용하세요."),
            );
          }
        }
        return;
      }

      let existing: Config | null = null;
      if (fs.existsSync(configPath)) {
        try { existing = loadConfig(configPath); } catch { existing = null; }
      }

      console.log(chalk.cyan("\n🐌 damn-my-slow-kt 초기 설정\n"));
      console.log(
        chalk.yellow("⚠️  KT SLA 측정은 유선(LAN) 연결에서만 유효합니다."),
      );
      console.log(
        chalk.yellow("   Wi-Fi로 측정하면 감면 신청이 거부될 수 있습니다."),
      );
      if (existing) {
        console.log(chalk.dim("\n   기존 설정값이 표시됩니다. 엔터를 누르면 기존 값을 유지합니다."));
      }
      printSpeedAgentInstallGuide();

      // 1단계: KT 아이디 먼저 수집
      const idAnswer = await inquirer.prompt([
        {
          type: "input",
          name: "id",
          message: "KT 아이디 (이메일 또는 ID):",
          default: existing?.credentials.id || undefined,
          validate: (v: string) => v.trim() !== "" || "아이디를 입력하세요.",
        },
      ]);

      // 비밀번호 입력 직전 — 입력하면서 볼 수 있도록 소스 코드 링크 안내 (회색)
      // 비밀번호는 로컬 YAML 설정 파일에만 저장되며, 외부 서버로 전송되지 않음
      console.log(chalk.dim("   🔍 비밀번호는 로컬에만 저장됩니다. 무서우시면 직접 확인하세요:"));
      console.log(chalk.dim("      저장 방식: https://github.com/kargnas/damn-my-slow-kt/blob/main/src/config.ts#L124"));
      console.log(chalk.dim("      로그인 로직: https://github.com/kargnas/damn-my-slow-kt/blob/main/src/kt.ts#L341"));
      console.log(chalk.dim("      이 화면 코드: https://github.com/kargnas/damn-my-slow-kt/blob/main/src/cli.ts"));

      // 2단계: 비밀번호 수집
      const pwAnswer = await inquirer.prompt([
        {
          type: "password",
          name: "password",
          message: existing?.credentials.password
            ? "KT 비밀번호 (엔터 시 기존 비밀번호 사용):"
            : "KT 비밀번호:",
          mask: "*",
          validate: (v: string) => {
            if (!v.trim() && existing?.credentials.password) return true;
            return v.trim() !== "" || "비밀번호를 입력하세요.";
          },
        },
      ]);

      // 3단계: 나머지 설정 수집
      const restAnswers = await inquirer.prompt([
        {
          type: "input",
          name: "phone",
          message: "연락처 (휴대폰 번호 — 이의신청 시 필요):",
          default: existing?.phone || undefined,
          validate: (v: string) => {
            if (!v.trim()) return "연락처를 입력하세요. 이의신청 시 필수입니다.";
            return /^01[0-9]{8,9}$/.test(v.replace(/-/g, "")) || "올바른 휴대폰 번호를 입력하세요. (예: 01012345678)";
          },
        },
        {
          type: "input",
          name: "discord_webhook",
          message: "Discord 웹훅 URL (없으면 엔터):",
          default: existing?.notification.discord_webhook || "",
        },
        {
          type: "input",
          name: "slack_webhook",
          message: "Slack 웹훅 URL (없으면 엔터):",
          default: existing?.notification.slack_webhook || "",
        },
        {
          type: "input",
          name: "telegram_token",
          message: "Telegram 봇 토큰 (없으면 엔터):",
          default: existing?.notification.telegram_bot_token || "",
        },
        {
          type: "confirm",
          name: "headless",
          message: "브라우저를 숨김 모드로 실행할까요?",
          default: existing?.headless ?? true,
        },
      ]);

      // 세 단계 응답 합산 — 이후 코드는 기존 answers 변수 구조 그대로 사용
      const answers = { ...idAnswer, ...pwAnswer, ...restAnswers };

      let telegramChatId = existing?.notification.telegram_chat_id || "";
      if (answers.telegram_token) {
        const chatAnswer = await inquirer.prompt([
          {
            type: "input",
            name: "chat_id",
            message: "Telegram 채팅 ID:",
            default: telegramChatId || "",
          },
        ]);
        telegramChatId = chatAnswer.chat_id;
      }

      const defaults = getDefaultConfig();
      const cfg: Config = {
        _config_version: defaults._config_version,
        credentials: {
          id: answers.id,
          password: answers.password || existing?.credentials.password || "",
        },
        phone: answers.phone ? answers.phone.replace(/-/g, "") : "",
        plan: { speed_mbps: existing?.plan.speed_mbps || defaults.plan.speed_mbps },
        schedule: existing?.schedule || {
          time: "04:00",
          timezone: "Asia/Seoul",
          max_attempts: defaults.schedule.max_attempts,
          retry_interval_minutes: defaults.schedule.retry_interval_minutes,
          stop_on_complaint_success:
            defaults.schedule.stop_on_complaint_success,
        },
        notification: {
          discord_webhook: answers.discord_webhook,
          slack_webhook: answers.slack_webhook,
          telegram_bot_token: answers.telegram_token,
          telegram_chat_id: telegramChatId,
        },
        headless: answers.headless,
        db_path: existing?.db_path || defaults.db_path,
      };

      // 설정 파일 저장
      const dir = path.dirname(configPath);
      if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
      saveConfig(cfg, configPath);

      console.log(`\n${chalk.green(`✅ 설정 파일 생성 완료: ${configPath}`)}`);
      console.log(chalk.dim(`주의: ${configPath} 에는 비밀번호가 포함됩니다.`));
      console.log(
        chalk.dim(
          `기본 설정: 하루 최대 ${cfg.schedule.max_attempts}회, ${cfg.schedule.retry_interval_minutes}분 간격 측정 (감면 성공 시 중단)`,
        ),
      );

      // 자동 스케줄 설치 여부 물어보기
      const platform = getPlatform();
      if (platform !== "windows" && platform !== "unknown") {
        const { installSched } = await inquirer.prompt([
          {
            type: "confirm",
            name: "installSched",
            message: "매일 자동으로 속도 측정을 실행할까요?",
            default: true,
          },
        ]);

        if (installSched) {
          try {
            installSchedule(cfg, configPath);
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            console.log("");
            console.log(
              chalk.yellow(
                "⚠️  설정 저장은 완료되었으나, 자동 스케줄 등록에 실패했습니다.",
              ),
            );
            console.log(chalk.dim(`   원인: ${err.message}`));
            console.log("");
            console.log("   수동으로 실행하려면:");
            console.log(
              chalk.bold(
                `     npx --yes damn-my-slow-kt run --config ${configPath}`,
              ),
            );
            console.log("");
            console.log("   스케줄을 다시 등록하려면:");
            console.log(
              chalk.bold(
                `     npx --yes damn-my-slow-kt schedule install --config ${configPath}`,
              ),
            );
          }
        }
      } else if (platform === "windows") {
        console.log("\nWindows에서는 작업 스케줄러를 수동으로 설정하세요:");
        console.log(
          `  npx -y damn-my-slow-kt@latest schedule install --config ${configPath}`,
        );
      }

      console.log(chalk.dim("\n지금 테스트하려면 실행해보세요:"));
      console.log(chalk.bold("  npx -y damn-my-slow-kt@latest run"));

      await askForStar();
    });

  // ─────────────────────────────────────
  // run - 1회 측정 후 종료. cron/launchd가 다회 트리거.
  // 매 실행 시 오늘 이미 감면 성공했는지 DB에서 확인.
  // ─────────────────────────────────────
  program
    .command("run")
    .description("1회 측정 + 감면 신청 (스케줄러가 다회 트리거)")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .option("--dry-run", "측정만 하고 감면 신청 생략", false)
    .option("--force", "오늘 완료 여부 무시하고 강제 실행", false)
    .option("-v, --verbose", "상세 로그 출력", false)
    .option("--screenshot", "측정 완료 후 스크린샷 저장", false)
    .option(
      "--debug",
      "브라우저 창을 열고 느린 모드(slowMo)로 실행 — 문제 진단용",
      false,
    )
    .action(
      async (opts: {
        config: string;
        dryRun: boolean;
        force: boolean;
        verbose: boolean;
        screenshot: boolean;
        debug: boolean;
      }) => {
        // 업데이트 체크
        const noUpdateCheck = program.opts().noUpdateCheck as
          | boolean
          | undefined;
        await checkForUpdates(pkg.version, { noUpdateCheck });

        let cfg: Config;
        try {
          cfg = loadConfig(opts.config);
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(chalk.red(`❌ ${err.message}`));
          process.exit(1);
        }

        // 마이그레이션 체크 (업데이트 후 설정 변경 안내)
        cfg = await checkAndRunMigrations(cfg, opts.config);

        const missingFields = validateRequiredFields(cfg);
        if (missingFields.length > 0) {
          console.error(chalk.red("❌ 필수 설정이 누락되었습니다:"));
          for (const field of missingFields) {
            console.error(chalk.red(`   • ${field}`));
          }
          console.error(
            `\n'npx -y damn-my-slow-kt@latest init' 명령으로 설정을 다시 진행하세요.`,
          );
          process.exit(1);
        }

        // ── 오늘 상태 체크 ──
        const db = new SpeedDatabase(cfg.db_path);
        const todayRecords = db.getTodayRecords(cfg.schedule.timezone);
        const todayCount = todayRecords.length;
        const maxAttempts = cfg.schedule.max_attempts || 10;
        const alreadySucceeded = db.hasTodayComplaintSuccess(
          cfg.schedule.timezone,
        );
        const isInteractive = process.stdout.isTTY === true;

        if (!opts.force) {
          // 오늘 감면 성공 완료
          if (
            alreadySucceeded &&
            cfg.schedule.stop_on_complaint_success !== false
          ) {
            if (isInteractive) {
              console.log(
                chalk.green(
                  `\n✅ 오늘 이미 감면 신청에 성공했습니다. (${todayCount}회 측정)`,
                ),
              );
              const { proceed } = await inquirer.prompt([
                {
                  type: "confirm",
                  name: "proceed",
                  message: "그래도 추가 측정하시겠습니까?",
                  default: false,
                },
              ]);
              if (!proceed) {
                db.close();
                return;
              }
            } else {
              // non-interactive (cron/launchd): 스킵 + --force 안내
              console.log(
                `[skip] 오늘 감면 성공 완료 (${todayCount}회 측정). 스킵합니다.`,
              );
              console.log(
                `       강제 실행하려면: npx -y damn-my-slow-kt@latest run --force`,
              );
              db.close();
              return;
            }
          }

          // 오늘 최대 횟수 도달
          if (todayCount >= maxAttempts) {
            if (isInteractive) {
              console.log(
                chalk.yellow(
                  `\n⚠️  오늘 이미 ${todayCount}회 측정했습니다. (최대 ${maxAttempts}회)`,
                ),
              );
              const { proceed } = await inquirer.prompt([
                {
                  type: "confirm",
                  name: "proceed",
                  message: "최대 횟수를 초과하여 추가 측정하시겠습니까?",
                  default: false,
                },
              ]);
              if (!proceed) {
                db.close();
                return;
              }
            } else {
              console.log(
                `[skip] 오늘 ${todayCount}/${maxAttempts}회 완료. 스킵합니다.`,
              );
              console.log(
                `       강제 실행하려면: npx -y damn-my-slow-kt@latest run --force`,
              );
              db.close();
              return;
            }
          }
        }

        // ── 측정 실행 ──
        console.log(chalk.cyan("\n🐌 damn-my-slow-kt 실행"));
        console.log(
          `KT | ${opts.dryRun ? "dry-run 모드" : "감면 신청 활성화"}`,
        );
        console.log(
          chalk.dim("유선(LAN) 연결 확인 필수 — Wi-Fi 측정은 SLA 인정 불가"),
        );
        if (isInteractive) {
          printSpeedAgentInstallGuide();
        }
        if (todayCount > 0) {
          console.log(
            chalk.dim(
              `오늘 ${todayCount + 1}번째 측정 (최대 ${maxAttempts}회)`,
            ),
          );
        }
        console.log("");

        const provider = new KTProvider(cfg);
        const measuredAt = new Date().toISOString();

        const localTime = new Date(measuredAt).toLocaleString('ko-KR', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: false,
        });
        console.log(`측정 시작: ${localTime}`);
        if (opts.debug) {
          console.log(
            chalk.yellow(
              "🔍 디버그 모드: 브라우저 창을 열고 느린 속도로 실행합니다 (slowMo + DevTools)",
            ),
          );
          console.log(
            chalk.dim(
              "   config 파일의 headless 설정을 무시하고 이번 실행만 임시로 끕니다.",
            ),
          );
        } else if (cfg.headless) {
          console.log(chalk.dim("headless 모드로 실행합니다"));
        } else {
          console.log(chalk.dim("브라우저 창이 열립니다 (headless=false)"));
        }

        let result: SpeedTestResult;
        try {
          result = await provider.run({ dryRun: opts.dryRun, debug: opts.debug });
        } catch (e: unknown) {
          const err = e instanceof Error ? e : new Error(String(e));

          // Linux에서 shared library 누락 → Docker 자동 전환
          if (process.platform === 'linux' && isSharedLibraryError(err)) {
            if (isInsideDocker()) {
              console.error(chalk.red('\n❌ Docker 내에서도 Chromium 실행 실패'));
              console.error(chalk.dim(`   ${err.message}`));
              db.close();
              process.exit(1);
            }

            if (isDockerAvailable()) {
              db.close();
              reExecInDocker();
            }

            printDockerInstallGuide(err.message);
            db.close();
            process.exit(1);
          }

          throw e;
        }

        const record = {
          isp: "kt",
          measured_at: measuredAt,
          download_mbps: result.download_mbps,
          upload_mbps: result.upload_mbps,
          ping_ms: result.ping_ms,
          sla_result: result.sla_result,
          complaint_filed: result.complaint_filed,
          complaint_result: result.complaint_result,
          raw_data: JSON.stringify(result.raw_data),
          error: result.error,
        };

        db.save(record);
        db.close();

        printRunResult(record, cfg.plan.speed_mbps);
        await sendNotifications(cfg, record);

        if (result.complaint_result === "success") {
          console.log(
            chalk.green(
              "\n🎉 감면 신청 성공! 다음 스케줄 실행 시 자동으로 스킵됩니다.",
            ),
          );
        }

        if (result.error) {
          console.error(`\n${chalk.red(`⚠️  오류 발생: ${result.error}`)}`);

          // 디버그 모드가 아니었다면 진단용 재실행 옵션 제공.
          // 이슈 #3 댓글들처럼 환경별 엣지 케이스(새 기기 등록, 다회선 주소지 선택,
          // 회선 미보유, 속도측정 프로그램 미설치 등)는 브라우저를 직접 관찰해야
          // 원인을 파악할 수 있는 경우가 많음.
          if (!opts.debug) {
            if (isInteractive) {
              // 인터랙티브 TTY: 바로 디버그 재실행 여부를 물어봄
              console.error("");
              const { retryDebug } = await inquirer.prompt([
                {
                  type: "confirm",
                  name: "retryDebug",
                  message:
                    "브라우저 창을 열어서 어디서 막혔는지 직접 확인해보시겠습니까? (디버그 모드)",
                  default: true,
                },
              ]);

              if (retryDebug) {
                console.log(chalk.yellow("\n🔍 디버그 모드로 재실행합니다..."));
                console.log("");

                const debugProvider = new KTProvider(cfg);
                try {
                  // 디버그 재실행도 일반 실행과 동일하게 이력 저장 + 감면 신청을 수행.
                  // dryRun은 원 호출의 opt를 그대로 따라가고, debug만 강제 true.
                  const debugMeasuredAt = new Date().toISOString();
                  const debugResult = await debugProvider.run({
                    dryRun: opts.dryRun,
                    debug: true,
                  });

                  const debugRecord = {
                    isp: "kt",
                    measured_at: debugMeasuredAt,
                    download_mbps: debugResult.download_mbps,
                    upload_mbps: debugResult.upload_mbps,
                    ping_ms: debugResult.ping_ms,
                    sla_result: debugResult.sla_result,
                    complaint_filed: debugResult.complaint_filed,
                    complaint_result: debugResult.complaint_result,
                    raw_data: JSON.stringify(debugResult.raw_data),
                    error: debugResult.error,
                  };

                  const debugDb = new SpeedDatabase(cfg.db_path);
                  debugDb.save(debugRecord);
                  debugDb.close();

                  printRunResult(debugRecord, cfg.plan.speed_mbps);
                  await sendNotifications(cfg, debugRecord);

                  if (debugResult.complaint_result === "success") {
                    console.log(
                      chalk.green(
                        "\n🎉 감면 신청 성공! 다음 스케줄 실행 시 자동으로 스킵됩니다.",
                      ),
                    );
                  }

                  // 재실행이 정상 종료된 경우 1차 실행의 에러만으로 exit(1) 하지 않음.
                  if (!debugResult.error) {
                    return;
                  }
                } catch (e: unknown) {
                  const err = e instanceof Error ? e : new Error(String(e));
                  console.error(chalk.red(`디버그 재실행 중 예외: ${err.message}`));
                }
              }
            } else {
              // non-interactive(cron/launchd): 텍스트 안내만 출력
              console.error("");
              console.error(
                chalk.yellow(
                  "💡 원인을 확인하려면 터미널에서 아래 명령으로 다시 실행해보세요:",
                ),
              );
              console.error(
                chalk.bold(
                  `     npx -y damn-my-slow-kt@latest run --debug${opts.dryRun ? " --dry-run" : ""}`,
                ),
              );
              console.error(
                chalk.dim(
                  "   (브라우저 창이 열리고, 에러 발생 시 상태를 확인할 수 있도록 대기합니다)",
                ),
              );
            }
          }

          process.exit(1);
        }
      },
    );

  // ─────────────────────────────────────
  // config show
  // ─────────────────────────────────────
  const configCmd = program.command("config").description("설정 관리");

  configCmd
    .command("show")
    .description("현재 설정 확인")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .action((opts: { config: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      console.log(chalk.cyan("\n⚙️  현재 설정 (KT)\n"));
      console.log(`설정 버전: v${cfg._config_version}`);
      console.log(`계정 ID: ${cfg.credentials.id}`);
      console.log(`비밀번호: ${"*".repeat(cfg.credentials.password.length)}`);
      console.log(`계약 속도: ${cfg.plan.speed_mbps} Mbps`);
      console.log(`첫 측정: ${cfg.schedule.time} (${cfg.schedule.timezone})`);
      console.log(
        `최대 측정: ${cfg.schedule.max_attempts}회/일 | ${cfg.schedule.retry_interval_minutes}분 간격`,
      );
      console.log(
        `감면 성공 시: ${cfg.schedule.stop_on_complaint_success ? "중단" : "계속 측정"}`,
      );
      console.log(
        `Discord 웹훅: ${cfg.notification.discord_webhook ? "설정됨" : "없음"}`,
      );
      console.log(
        `Slack 웹훅: ${cfg.notification.slack_webhook ? "설정됨" : "없음"}`,
      );
      console.log(
        `Telegram: ${cfg.notification.telegram_bot_token ? "설정됨" : "없음"}`,
      );
      console.log(`Headless 모드: ${cfg.headless}`);
      console.log(`DB 경로: ${cfg.db_path}`);
    });

  // ─────────────────────────────────────
  // history
  // ─────────────────────────────────────
  program
    .command("history")
    .description("측정 이력 조회")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .option("-n, --limit <number>", "표시할 이력 수", "20")
    .option("-m, --month <YYYY-MM>", "월 필터")
    .action((opts: { config: string; limit: string; month?: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      const db = new SpeedDatabase(cfg.db_path);
      const records = db.getHistory(parseInt(opts.limit) || 20, opts.month);
      db.close();
      printHistory(records);
    });

  // ─────────────────────────────────────
  // report
  // ─────────────────────────────────────
  program
    .command("report")
    .description("요약 리포트")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .option("-m, --month <YYYY-MM>", "월 필터")
    .action((opts: { config: string; month?: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      const db = new SpeedDatabase(cfg.db_path);
      const stats = db.getStats(opts.month);
      db.close();
      printStats(stats);
    });

  // ─────────────────────────────────────
  // schedule
  // ─────────────────────────────────────
  const schedCmd = program
    .command("schedule")
    .description("자동 실행 스케줄 관리");

  schedCmd
    .command("install")
    .description("자동 실행 스케줄 등록")
    .option("-c, --config <path>", "설정 파일 경로", DEFAULT_CONFIG_PATH)
    .action((opts: { config: string }) => {
      let cfg: Config;
      try {
        cfg = loadConfig(opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(err.message));
        process.exit(1);
      }

      try {
        installSchedule(cfg, opts.config);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(`❌ 스케줄 설치 실패: ${err.message}`));
        process.exit(1);
      }
    });

  schedCmd
    .command("remove")
    .description("자동 실행 스케줄 제거")
    .action(() => {
      try {
        removeSchedule();
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        console.error(chalk.red(`❌ 스케줄 제거 실패: ${err.message}`));
        process.exit(1);
      }
    });

  return program;
}

// ─── 속도 바 시각화 ─────────────────────────────────────────────

/** 터미널 너비에 맞춘 속도 게이지 바 */
function speedBar(mbps: number, maxMbps: number, width = 30): string {
  const ratio = Math.min(mbps / maxMbps, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;

  // 속도 비율에 따른 색상: <30% 빨강, <50% 노랑, >=50% 초록
  const colorFn =
    ratio < 0.3 ? chalk.red : ratio < 0.5 ? chalk.yellow : chalk.green;
  const bar = colorFn("█".repeat(filled)) + chalk.gray("░".repeat(empty));
  const pct = `${(ratio * 100).toFixed(0)}%`;

  return `${bar} ${chalk.bold(`${mbps.toFixed(1)}`)} Mbps ${chalk.dim(`(${pct})`)}`;
}

function getNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function inferPlanSpeedFromSlaReference(slaRefMbps: number): number {
  return slaRefMbps / KT_SLA_GUARANTEE_RATIO;
}

function inferContractSpeedFromRawData(rawData: string | undefined): number | null {
  if (!rawData) return null;

  try {
    const parsed = JSON.parse(rawData) as {
      inferred_plan_mbps?: unknown;
      sla_ref_mbps?: unknown;
      rounds?: Array<{ slaRef?: unknown }>;
    };

    const inferredPlan = getNumberValue(parsed.inferred_plan_mbps);
    if (inferredPlan !== null) return inferredPlan;

    const slaRef = getNumberValue(parsed.sla_ref_mbps);
    if (slaRef !== null) return inferPlanSpeedFromSlaReference(slaRef);

    const roundRefs =
      parsed.rounds
        ?.map((round) =>
          typeof round.slaRef === 'string'
            ? parseMbpsValue(round.slaRef)
            : null,
        )
        .filter((value): value is number => value !== null && Number.isFinite(value) && value > 0) || [];

    return roundRefs.length > 0
      ? inferPlanSpeedFromSlaReference(Math.max(...roundRefs))
      : null;
  } catch {
    return null;
  }
}

function displayWidth(text: string): number {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');

  return Array.from(plain).reduce((width, char) => {
    const code = char.codePointAt(0) ?? 0;
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2329 && code <= 0x232a) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x1f300 && code <= 0x1faff) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);

    return width + (isWide ? 2 : 1);
  }, 0);
}

function truncateDisplay(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsis = '...';
  const targetWidth = Math.max(0, maxWidth - displayWidth(ellipsis));
  let result = '';
  let width = 0;

  for (const char of Array.from(text)) {
    const nextWidth = displayWidth(char);
    if (width + nextWidth > targetWidth) break;
    result += char;
    width += nextWidth;
  }

  return `${result}${ellipsis}`;
}

function padBoxContent(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function boxLine(content: string, width: number, color: typeof chalk.green): string {
  return color("  │") + padBoxContent(content, width) + color("│");
}

function printRunResult(
  record: {
    sla_result: string;
    download_mbps: number;
    upload_mbps: number;
    ping_ms: number;
    complaint_filed: boolean;
    complaint_result: string;
    raw_data?: string;
    error?: string;
  },
  contractSpeed = 1000,
): void {
  const isFail = record.sla_result === "fail";
  const isPass = record.sla_result === "pass";
  const displayContractSpeed =
    inferContractSpeedFromRawData(record.raw_data) || contractSpeed;

  // 상단 구분선
  const headerColor = isFail ? chalk.red : isPass ? chalk.green : chalk.yellow;
  const headerIcon = isFail ? "❌" : isPass ? "✅" : "⚠️";
  const headerText = isFail ? "SLA 미달" : isPass ? "SLA 통과" : "SLA 불명";
  const headerLine = `  ${headerIcon}  ${chalk.bold(headerText)}`;
  const bodyLine = record.error
    ? chalk.yellow(truncateDisplay(`  ⚠ ${record.error}`, 80))
    : `  ⬇ 다운로드  ${speedBar(record.download_mbps, displayContractSpeed, 20)}`;
  const boxWidth = Math.max(46, displayWidth(headerLine), displayWidth(bodyLine));

  console.log("");
  console.log(headerColor(`  ┌${"─".repeat(boxWidth)}┐`));
  console.log(boxLine(headerLine, boxWidth, headerColor));
  console.log(headerColor(`  ├${"─".repeat(boxWidth)}┤`));

  console.log(boxLine(bodyLine, boxWidth, headerColor));

  // 이의신청 결과
  if (
    record.complaint_filed ||
    (isFail && record.complaint_result === "skipped")
  ) {
    console.log(headerColor(`  ├${"─".repeat(boxWidth)}┤`));

    if (record.complaint_result === "success") {
      console.log(boxLine(chalk.green("  🎉 감면 신청 성공!"), boxWidth, headerColor));
    } else if (record.complaint_result === "failed") {
      console.log(boxLine(chalk.red("  ⚠️  감면 신청 실패"), boxWidth, headerColor));
    } else if (record.complaint_result === "skipped") {
      console.log(boxLine(chalk.dim("  📋 감면 신청 생략 (dry-run)"), boxWidth, headerColor));
    }
  }

  console.log(headerColor(`  └${"─".repeat(boxWidth)}┘`));
}

// ─── KT 속도측정 프로그램 설치 안내 ────────────────────────────────

/**
 * KT SLA 측정을 위해 speed.kt.com의 속도측정 에이전트 설치가 필요.
 * macOS: ktspeed.pkg, Windows: 사이트에서 직접 설치.
 */
function printSpeedAgentInstallGuide(): void {
  const platform = process.platform;

  if (platform === "darwin") {
    console.log(chalk.yellow("\n📦 KT 속도측정 프로그램 사전 설치 필요"));
    console.log(
      chalk.dim("   macOS: 아래 링크에서 프로그램을 설치하세요 (최초 1회)"),
    );
    console.log(chalk.bold("   https://speed.kt.com/file/ktspeed.pkg"));
    console.log("");
  } else if (platform === "win32") {
    console.log(chalk.yellow("\n📦 KT 속도측정 프로그램 사전 설치 필요"));
    console.log(
      chalk.dim("   Windows: 아래 절차를 따라 설치하세요 (최초 1회)"),
    );
    console.log(chalk.dim("   1. https://speed.kt.com 접속"));
    console.log(chalk.dim("   2. 속도측정 → 품질보증(SLA) 테스트 클릭"));
    console.log(chalk.dim("   3. 안내에 따라 속도측정 프로그램 설치"));
    console.log("");
  } else {
    console.log(
      chalk.yellow("\n⚠️  KT 속도측정 프로그램이 Linux를 공식 지원하지 않습니다."),
    );
    if (isInsideDocker()) {
      console.log(
        chalk.dim("   🐳 Docker 컨테이너에서 실행 중 — 웹 측정을 시도합니다."),
      );
    } else {
      console.log(
        chalk.dim("   Chromium 실행 실패 시 Docker로 자동 전환됩니다."),
      );
    }
    console.log("");
  }
}

// ─── GitHub Star 요청 ─────────────────────────────────────────────

const STAR_FLAG_FILE = path.join(DATA_DIR, ".star-asked");
const REPO = "kargnas/damn-my-slow-kt";

/**
 * 첫 실행 시 한 번만 GitHub 스타 여부를 물어본다.
 * gh CLI가 없거나 non-interactive면 조용히 스킵.
 */
async function askForStar(): Promise<void> {
  // interactive가 아니면 스킵
  if (!process.stdout.isTTY) return;

  // 이미 물어본 적 있으면 스킵
  if (fs.existsSync(STAR_FLAG_FILE)) return;

  // 플래그 먼저 기록 (다시 묻지 않기 위해)
  try {
    fs.mkdirSync(path.dirname(STAR_FLAG_FILE), { recursive: true });
    fs.writeFileSync(STAR_FLAG_FILE, new Date().toISOString(), "utf8");
  } catch {
    return;
  }

  // gh CLI 존재 확인
  try {
    execSync("which gh 2>/dev/null", { stdio: "ignore" });
  } catch {
    return;
  }

  console.log("");
  const { star } = await inquirer.prompt([
    {
      type: "confirm",
      name: "star",
      message: `도움이 됐다면 GitHub에 ⭐ 하나 남겨주시겠어요? (${REPO})`,
      default: true,
    },
  ]);

  if (star) {
    try {
      execSync(`gh repo edit ${REPO} --star 2>/dev/null`, { stdio: "ignore" });
      console.log(chalk.green("⭐ 감사합니다!"));
    } catch {
      // gh api로 fallback
      try {
        execSync(`gh api -X PUT /user/starred/${REPO} 2>/dev/null`, {
          stdio: "ignore",
        });
        console.log(chalk.green("⭐ 감사합니다!"));
      } catch {
        console.log(chalk.dim(`직접 스타해주세요: https://github.com/${REPO}`));
      }
    }
  }
}
