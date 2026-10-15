import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const preparer = path.resolve('deploy/prepare-caddy-migration.mjs');
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-caddy-migration-')); roots.push(root);
  const release = path.join(root, 'releases/new');
  const legacy = path.join(root, 'app-data/caddy');
  const unit = path.join(root, 'current-caddy.service');
  const staging = path.join(root, 'prepared');
  fs.mkdirSync(path.join(release, 'deploy/systemd'), { recursive: true });
  fs.copyFileSync('deploy/systemd/super-error-log-caddy.service', path.join(release, 'deploy/systemd/super-error-log-caddy.service'));
  fs.mkdirSync(path.join(legacy, 'caddy/certificates'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'caddy/certificates/synthetic.key'), 'synthetic-private-key', { mode: 0o600 });
  fs.mkdirSync(path.join(legacy, 'caddy/acme'), { mode: 0o700 });
  fs.writeFileSync(path.join(legacy, 'caddy/acme/account.json'), '{"synthetic":true}', { mode: 0o600 });
  fs.writeFileSync(unit, `[Service]\nUser=caddy\nEnvironment=XDG_DATA_HOME=${legacy}\n`);
  const run = (extra: string[] = []) => spawnSync(process.execPath, [preparer,
    '--release', release, '--current-unit', unit, '--legacy-xdg', legacy, '--staging', staging, ...extra],
  { encoding: 'utf8', timeout: 10_000 });
  return { root, release, legacy, unit, staging, run };
}

describe('offline Caddy migration preparation', () => {
  it('仅创建全新 0700 私有迁移目标，不读取或安装任何服务', () => {
    const f = fixture(); const destination = path.join(f.root, 'new-private-storage');
    const result = spawnSync(process.execPath, [preparer, '--create-private-destination', destination], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('目标目录已存在时拒绝创建，原有内容和权限不变', () => {
    const f = fixture(); const destination = path.join(f.root, 'existing-storage');
    fs.mkdirSync(destination, { mode: 0o755 });
    fs.chmodSync(destination, 0o755);
    fs.writeFileSync(path.join(destination, 'keep'), 'existing-content');
    const result = spawnSync(process.execPath, [preparer, '--create-private-destination', destination], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(destination, 'keep'), 'utf8')).toBe('existing-content');
  });

  it('目标为符号链接时拒绝创建，不修改链接或其目标', () => {
    const f = fixture(); const target = path.join(f.root, 'link-target');
    const destination = path.join(f.root, 'linked-storage');
    fs.mkdirSync(target, { mode: 0o755 }); fs.chmodSync(target, 0o755);
    fs.writeFileSync(path.join(target, 'keep'), 'linked-content');
    fs.symlinkSync(target, destination);
    const result = spawnSync(process.execPath, [preparer, '--create-private-destination', destination], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(destination)).toBe(target);
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(target, 'keep'), 'utf8')).toBe('linked-content');
  });

  it('暂存新版单元与完整私有备份，既不覆盖当前单元也不改旧证书', () => {
    const f = fixture(); const previousUnit = fs.readFileSync(f.unit, 'utf8');
    const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(f.unit, 'utf8')).toBe(previousUnit);
    expect(fs.readFileSync(path.join(f.staging, 'previous.service'), 'utf8')).toBe(previousUnit);
    const next = fs.readFileSync(path.join(f.staging, 'next.service'), 'utf8');
    expect(next).toContain('Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log');
    expect(next).toContain('User=caddy');
    expect(fs.statSync(f.staging).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.staging, 'legacy-xdg.tar')).mode & 0o777).toBe(0o600);
    const restored = path.join(f.root, 'isolated-restore'); fs.mkdirSync(restored);
    execFileSync('tar', ['-xf', path.join(f.staging, 'legacy-xdg.tar'), '-C', restored]);
    expect(fs.readFileSync(path.join(restored, 'caddy/certificates/synthetic.key'), 'utf8')).toBe('synthetic-private-key');
    expect(fs.readFileSync(path.join(restored, 'caddy/acme/account.json'), 'utf8')).toBe('{"synthetic":true}');
    expect(fs.statSync(path.join(restored, 'caddy/certificates/synthetic.key')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(f.legacy, 'caddy/certificates/synthetic.key'), 'utf8')).toBe('synthetic-private-key');
    expect(result.stdout + result.stderr).not.toContain('synthetic-private-key');
    const manifest = JSON.parse(fs.readFileSync(path.join(f.staging, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ ready: true, sourceRelease: fs.realpathSync(f.release),
      targetXdg: '/var/lib/caddy-super-error-log', actualStorage: '/var/lib/caddy-super-error-log/caddy',
      rollbackKeepsIndependentStorage: true });
  });

  it('旧发布物不含新版单元时前置失败，不产生半份迁移备份', () => {
    const f = fixture(); fs.unlinkSync(path.join(f.release, 'deploy/systemd/super-error-log-caddy.service'));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('新版发布物缺少 Caddy 单元');
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it('回滚配置保留旧运行参数但不退回应用内的证书路径', () => {
    const f = fixture();
    fs.appendFileSync(f.unit, `ReadWritePaths=${f.legacy}\nRestartSec=9s\n`);
    expect(f.run().status).toBe(0);
    const rollbackPath = path.join(f.staging, 'rollback.service');
    expect(fs.existsSync(rollbackPath), '迁移必须同时准备安全回滚配置').toBe(true);
    const rollback = fs.readFileSync(rollbackPath, 'utf8');
    expect(rollback).toContain('RestartSec=9s');
    expect(rollback).toContain('Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log');
    expect(rollback).toContain('ReadWritePaths=/var/lib/caddy-super-error-log');
    expect(rollback).not.toContain(f.legacy);
  });

  it('拒绝旧单元中第二个 Environment 赋值，避免回滚重新指向应用目录', () => {
    const f = fixture();
    fs.appendFileSync(f.unit, `Environment=OTHER=value XDG_DATA_HOME=${f.legacy}\n`);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('旧单元与指定旧 XDG 路径不一致');
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it.each([
    ['Environment', 'Environment = OTHER=value XDG_DATA_HOME='],
    ['ReadWritePaths', 'ReadWritePaths = '],
    ['EnvironmentFile', 'EnvironmentFile = '],
    ['User', 'User = '],
  ])('拒绝旧单元用空格绕过 %s 检查，不生成回滚单元', (_name, directive) => {
    const f = fixture();
    fs.appendFileSync(f.unit, `${directive}${_name === 'User' ? 'root' : f.legacy}\n`);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it('拒绝候选单元用空格绕过运行用户检查', () => {
    const f = fixture();
    const candidate = path.join(f.release, 'deploy/systemd/super-error-log-caddy.service');
    fs.appendFileSync(candidate, '\n[Service]\nUser = root\n');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it('只检查前置条件不创建备份或修改活动文件', () => {
    const f = fixture(); const original = fs.readFileSync(f.unit, 'utf8');
    expect(f.run(['--check']).status).toBe(0);
    expect(fs.existsSync(f.staging)).toBe(false);
    expect(fs.readFileSync(f.unit, 'utf8')).toBe(original);
  });

  it('旧证书引用外部文件时拒绝自动备份，不能复制或改动链接目标', () => {
    const f = fixture(); const external = path.join(f.root, 'unrelated'); fs.writeFileSync(external, 'keep-private');
    fs.symlinkSync(external, path.join(f.legacy, 'caddy/link'));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('旧存储含链接或特殊文件');
    expect(fs.existsSync(f.staging)).toBe(false);
    expect(fs.readFileSync(external, 'utf8')).toBe('keep-private');
  });

  it('拒绝复用已存在的准备目录，保留其中旧备份', () => {
    const f = fixture(); fs.mkdirSync(f.staging); fs.writeFileSync(path.join(f.staging, 'keep'), 'previous-backup');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('准备目录已存在');
    expect(fs.readFileSync(path.join(f.staging, 'keep'), 'utf8')).toBe('previous-backup');
    expect(fs.readdirSync(f.staging)).toEqual(['keep']);
  });

  it.each(['Environment=XDG_DATA_HOME=/var/lib/super-error-log/caddy', 'User=root'])('拒绝不安全的候选配置：%s', replacement => {
    const f = fixture(); const target = path.join(f.release, 'deploy/systemd/super-error-log-caddy.service');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(
      replacement.startsWith('User') ? 'User=caddy' : 'Environment=XDG_DATA_HOME=/var/lib/caddy-super-error-log', replacement));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('候选单元安全约束不满足');
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it('拒绝缺少实际 caddy 子目录的空旧存储，不能把重新签证书冒充迁移', () => {
    const f = fixture(); fs.renameSync(path.join(f.legacy, 'caddy'), path.join(f.legacy, 'not-caddy'));
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('旧 XDG 目录缺少 caddy 存储');
    expect(fs.existsSync(f.staging)).toBe(false);
  });

  it('实际 caddy 存储为空时不被 XDG 根目录的无关文件误判为已迁移', () => {
    const f = fixture();
    fs.rmSync(path.join(f.legacy, 'caddy'), { recursive: true });
    fs.mkdirSync(path.join(f.legacy, 'caddy'));
    fs.writeFileSync(path.join(f.legacy, 'unrelated.txt'), 'not-caddy-storage');
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(f.staging)).toBe(false);
  });
});
