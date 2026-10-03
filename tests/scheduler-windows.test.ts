/**
 * Windows 작업 스케줄러 등록 단위 테스트
 * - 사용자가 직접 등록한 작업과 schedule install로 자동 등록한 작업을 구분해 중복 등록을 막아야 한다 (이슈 #19).
 * - PowerShell 호출은 하지 않고 순수 함수만 검증한다 (CI는 Linux).
 */
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_TASK_NAME,
  WINDOWS_TASK_PATH,
  buildWindowsRegisterScript,
  buildWindowsTaskAction,
  classifyWindowsTasks,
  isSameTaskSet,
  psQuote,
} from '../src/scheduler';

describe('classifyWindowsTasks', () => {
  it('separates the auto-registered task from tasks the user registered manually', () => {
    const auto = { name: WINDOWS_TASK_NAME, path: WINDOWS_TASK_PATH, actions: ['node.exe "C:\\x\\dist\\index.js" run'] };
    const manual = {
      name: 'KT 자동 속도 측정',
      path: '\\Linus Custom\\',
      actions: ['npx --yes damn-my-slow-kt run --config C:\\Users\\me\\.damn-my-slow-isp\\config-kt.yaml'],
    };
    expect(classifyWindowsTasks([auto, manual])).toEqual({ auto, manual: [manual] });
  });

  it('treats a same-named task in another folder as manual', () => {
    const other = { name: WINDOWS_TASK_NAME, path: '\\Custom\\', actions: [] };
    expect(classifyWindowsTasks([other])).toEqual({ auto: null, manual: [other] });
  });

  it('handles no tasks', () => {
    expect(classifyWindowsTasks([])).toEqual({ auto: null, manual: [] });
  });
});

describe('isSameTaskSet', () => {
  const a = { name: 'A', path: '\\X\\', actions: ['npx --yes damn-my-slow-kt run'] };
  const b = { name: 'B', path: '\\', actions: ['damn-my-slow-kt run'] };

  it('matches the same tasks regardless of order', () => {
    expect(isSameTaskSet([a, b], [b, a])).toBe(true);
  });

  it('rejects a task added after the user approved the replacement', () => {
    expect(isSameTaskSet([a], [a, b])).toBe(false);
  });

  it('rejects a task whose action changed after approval', () => {
    expect(isSameTaskSet([a], [{ ...a, actions: ['something else'] }])).toBe(false);
  });
});

describe('buildWindowsTaskAction', () => {
  const configPath = 'C:\\Users\\me\\.damn-my-slow-isp\\config-kt.yaml';

  it('runs a stable install directly with node, quoting paths with spaces', () => {
    expect(
      buildWindowsTaskAction({
        scriptPath: 'C:\\Users\\My Name\\AppData\\Roaming\\npm\\node_modules\\damn-my-slow-kt\\dist\\index.js',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        configPath,
      }),
    ).toEqual({
      execute: 'C:\\Program Files\\nodejs\\node.exe',
      arguments:
        '"C:\\Users\\My Name\\AppData\\Roaming\\npm\\node_modules\\damn-my-slow-kt\\dist\\index.js" run --config "C:\\Users\\me\\.damn-my-slow-isp\\config-kt.yaml"',
    });
  });

  it('runs npx by absolute path when running from the npx temp cache (cache may disappear)', () => {
    expect(
      buildWindowsTaskAction({
        scriptPath: 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\damn-my-slow-kt\\dist\\index.js',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        npxPath: 'C:\\Program Files\\nodejs\\npx.cmd',
        configPath,
      }),
    ).toEqual({
      execute: 'C:\\Program Files\\nodejs\\npx.cmd',
      arguments: '--yes damn-my-slow-kt run --config "C:\\Users\\me\\.damn-my-slow-isp\\config-kt.yaml"',
    });
  });
});

describe('psQuote', () => {
  it('wraps in single quotes and doubles embedded single quotes', () => {
    expect(psQuote("C:\\O'Brien\\x")).toBe("'C:\\O''Brien\\x'");
  });
});

describe('buildWindowsRegisterScript', () => {
  it('registers one daily trigger per schedule time under the auto task name', () => {
    const script = buildWindowsRegisterScript({
      action: { execute: 'node.exe', arguments: '"C:\\a b\\index.js" run' },
      times: [
        { hour: 4, minute: 0 },
        { hour: 22, minute: 30 },
      ],
    });
    expect(script).toContain("New-ScheduledTaskAction -Execute 'node.exe' -Argument '\"C:\\a b\\index.js\" run'");
    expect(script).toContain("$triggers = @((New-ScheduledTaskTrigger -Daily -At '04:00'), (New-ScheduledTaskTrigger -Daily -At '22:30'))");
    expect(script).toContain(`-TaskName ${psQuote(WINDOWS_TASK_NAME)} -TaskPath ${psQuote(WINDOWS_TASK_PATH)}`);
    expect(script).toContain('-Force');
  });
});
