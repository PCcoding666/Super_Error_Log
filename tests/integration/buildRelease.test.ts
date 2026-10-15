import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const scriptPath = path.resolve('scripts/build-release.sh');
const projectRoot = path.resolve('.');
const tempDirs: string[] = [];
afterAll(() => {
  tempDirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-release-'));
  tempDirs.push(dir);
  return dir;
}

// 合成 dist：只放 server.js 入口形状的最小文件。测试不依赖真实构建产物，
// verify 顺序（typecheck → test → build）下测试先于 build 执行也能跑。
function makeSyntheticDist(): { dir: string; relative: string } {
  const root = makeTempDir();
  const dir = path.join(root, 'synthetic-dist');
  fs.mkdirSync(path.join(dir, 'mobile'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mobile/server.js'), 'console.log("synthetic");\n');
  return { dir, relative: path.relative(projectRoot, dir) };
}

interface ReleaseRun {
  status: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
}

// 执行打包脚本：在临时目录产出发布包。distDir 一律注入合成目录（hermetic）。
function runRelease(outputDir: string, options: { distDir?: string; version?: string } = {}): ReleaseRun {
  const args = [scriptPath, '--output', outputDir];
  if (options.distDir) args.push('--dist', options.distDir);
  if (options.version) args.push('--version', options.version);
  try {
    const stdout = execFileSync('/bin/bash', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 120_000
    });
    return { status: 0, stdout, stderr: '', artifacts: fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : [] };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      artifacts: fs.existsSync(outputDir) ? fs.readdirSync(outputDir) : []
    };
  }
}

function tarList(tarball: string): string[] {
  return execFileSync('/usr/bin/tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

describe('release packager (scripts/build-release.sh)', () => {
  it('脚本存在且可执行（RED 守卫）', () => {
    expect(fs.existsSync(scriptPath), 'scripts/build-release.sh 尚未创建').toBe(true);
    expect(() => fs.accessSync(scriptPath, fs.constants.X_OK)).not.toThrow();
  });

  it('在临时目录产出单一 tar.gz，清单只含白名单内容（合成 dist，hermetic）', () => {
    const output = makeTempDir();
    const synthetic = makeSyntheticDist();
    const run = runRelease(output, { distDir: synthetic.relative });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // 恰好一个 .tar.gz 制品（不落中间目录、不带时间戳文件名以外的杂项）。
    expect(run.artifacts.filter(name => name.endsWith('.tar.gz'))).toHaveLength(1);
    const tarball = path.join(output, run.artifacts.find(name => name.endsWith('.tar.gz'))!);
    const entries = tarList(tarball);

    // 白名单必含：服务器入口、锁清单、部署配置、配置模板。
    const mustContain = [
      'super-error-log/package.json',
      'super-error-log/package-lock.json',
      'super-error-log/dist/mobile/server.js',
      'super-error-log/deploy/caddy/Caddyfile',
      'super-error-log/deploy/systemd/super-error-log.service',
      'super-error-log/deploy/systemd/super-error-log-caddy.service',
      'super-error-log/deploy/prepare-caddy-migration.mjs',
      'super-error-log/deploy/README.md',
      'super-error-log/.env.example'
    ];
    for (const wanted of mustContain) {
      expect(entries, `清单缺 ${wanted}`).toContain(wanted);
    }

    // --dist 注入的合成内容真的进了包（--dist 语义是替换 dist 来源）。
    expect(entries).toContain('super-error-log/dist/mobile/server.js');

    // 严禁外泄：密钥、照片、运行数据、依赖、构建缓存、VCS、源代码。
    // 注意：.env.example 是白名单配置模板——只禁真实 .env 与 .env.*，显式放行 .env.example。
    const forbidden = [/^super-error-log\/\.env$/, /^super-error-log\/\.env\.(?!example$)/,
      /^super-error-log\/data\//, /^super-error-log\/fixtures\//,
      /^super-error-log\/node_modules\//, /^super-error-log\/\.git\//, /^super-error-log\/\.ai\//,
      /^super-error-log\/\.superpowers\//, /^super-error-log\/\.workbuddy-ai\//, /^super-error-log\/src\//,
      /^super-error-log\/tests\//, /^super-error-log\/iOS\//, /^super-error-log\/docs\//,
      /^super-error-log\/releases\//];
    for (const entry of entries) {
      for (const pattern of forbidden) {
        expect(entry, `清单出现违禁项：${entry}`).not.toMatch(pattern);
      }
    }
    // tar 内容不得包含顶层目录以外的任何前缀（无绝对路径、无设备级路径）。
    for (const entry of entries) {
      expect(entry.startsWith('super-error-log/'), `非白名单前缀：${entry}`).toBe(true);
    }

    // 制品可完整解包（gzip 流健康）。
    const extractDir = makeTempDir();
    execFileSync('/usr/bin/tar', ['-xzf', tarball, '-C', extractDir]);
    const manifest = JSON.parse(fs.readFileSync(path.join(extractDir, 'super-error-log/package.json'), 'utf8'));
    expect(manifest.name).toBe('super-error-log');
    // 合成 server.js 内容原样进入包（无意外改写）。
    const serverEntry = fs.readFileSync(path.join(extractDir, 'super-error-log/dist/mobile/server.js'), 'utf8');
    expect(serverEntry).toContain('synthetic');
  });

  it('不存在的 --dist 目录直接失败并给出可读错误（fail-fast，不产空包）', () => {
    const output = makeTempDir();
    const run = runRelease(output, { distDir: 'dist-missing' });
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toMatch(/dist/);
    expect(run.artifacts).toHaveLength(0);
  });

  it('--version 指定版号，产包文件名含该版号', () => {
    const output = makeTempDir();
    const synthetic = makeSyntheticDist();
    const run = runRelease(output, { distDir: synthetic.relative, version: '0.1.0-test.7' });
    expect(run.status).toBe(0);
    expect(run.artifacts.find(name => name.endsWith('.tar.gz'))).toMatch(/0\.1\.0-test\.7/);
  });

  it('未指定 --version 时从 package.json 解析版号（不在产包文件名留 unspecified）', () => {
    const output = makeTempDir();
    const synthetic = makeSyntheticDist();
    const run = runRelease(output, { distDir: synthetic.relative });
    expect(run.status).toBe(0);
    expect(run.stdout).not.toMatch(/unspecified/);
    const tarballName = run.artifacts.find(name => name.endsWith('.tar.gz'))!;
    // 文件名必须含 package.json 的真实版号（动态读取，不随发版腐烂）。
    const pkgVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version as string;
    expect(tarballName).toContain(pkgVersion);
  });

  it('版号无法解析（node 不可用）时 fail-hard，不产 unspecified 兜底包', () => {
    const output = makeTempDir();
    const synthetic = makeSyntheticDist();
    // PATH 清空到只剩系统目录：node 不在 PATH → default_version 解析失败。
    const args = [scriptPath, '--output', output, '--dist', synthetic.relative];
    let status = 0; let stderr = ''; let stdout = '';
    try {
      stdout = execFileSync('/bin/bash', args, {
        cwd: projectRoot, encoding: 'utf8',
        env: { ...process.env, PATH: '/usr/bin:/bin' }, timeout: 120_000
      });
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string };
      status = err.status ?? 1; stderr = err.stderr ?? ''; stdout = err.stdout ?? '';
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/版本号|version/i);
    expect(fs.existsSync(output) ? fs.readdirSync(output).filter(name => name.endsWith('.tar.gz')) : []).toHaveLength(0);
  });

  it('应用重复初始化不影响部署相邻目录的权限前提（证书存储与应用数据平级）', async () => {
    // 回归守卫（Task 01-A）：历史上应用启动把数据目录 chmod 0700，嵌套在内的
    // Caddy 证书存储随即不可访问（caddy 用户无法穿越 0700 父目录）。修复后证书存储
    // 与应用数据目录平级——本测试用同 UID 的兄弟目录证明：应用两次初始化只会
    // 动自己的数据目录，兄弟目录（证书存储位置）的权限保持部署时的 0700 不变。
    // 跨 UID 的真实权限验证（caddy 用户不能读应用数据）属于生产部署验收项。
    const { MobileRecognitionStore } = await import('../../src/mobile/store.js');
    const { PairingManager } = await import('../../src/mobile/pairing.js');
    const parent = makeTempDir();
    const appData = path.join(parent, 'super-error-log');
    const caddyData = path.join(parent, 'caddy-super-error-log');
    fs.mkdirSync(appData); fs.mkdirSync(caddyData);
    fs.chmodSync(caddyData, 0o700);
    // 首次初始化 + 再次初始化（重启路径）各跑一遍
    for (let round = 0; round < 2; round += 1) {
      await MobileRecognitionStore.open(appData);
      await PairingManager.open(appData);
    }
    const caddyMode = fs.statSync(caddyData).mode & 0o777;
    expect(caddyMode, '应用初始化不得改动平级证书存储目录的权限').toBe(0o700);
    // 应用自己的数据目录仍被强制私有化（既有安全语义不破）
    expect(fs.statSync(appData).mode & 0o777).toBe(0o700);
  });
});
