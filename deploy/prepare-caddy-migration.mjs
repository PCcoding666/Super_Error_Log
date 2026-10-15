#!/usr/bin/env node
// Offline preparation only: never installs a unit, changes live storage, or starts a service.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const targetXdg = '/var/lib/caddy-super-error-log';
const unitName = 'super-error-log-caddy.service';
const fail = message => { throw new Error(message); };
const exists = name => { try { fs.lstatSync(name); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const below = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function optionsFor(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--check') { options.check = true; continue; }
    if (!['--release', '--current-unit', '--legacy-xdg', '--staging'].includes(key)
      || !args[index + 1] || args[index + 1].startsWith('--') || options[key]) fail('迁移准备参数不合法');
    options[key] = args[++index];
  }
  for (const key of ['--release', '--current-unit', '--legacy-xdg', '--staging']) {
    if (!options[key] || !path.isAbsolute(options[key])) fail(`${key} 必须是明确的绝对路径`);
  }
  return options;
}

function serviceFields(text) {
  const fields = new Map(); let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) { section = line; continue; }
    if (section !== '[Service]') continue;
    // Reject whitespace/aliases around directive names instead of silently
    // treating e.g. "Environment =" as an unrelated key during safety checks.
    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!assignment) fail('服务单元含不支持的语法');
    const [, key, value] = assignment;
    fields.set(key, [...(fields.get(key) ?? []), value]);
  }
  return fields;
}

function validateCandidate(text) {
  const fields = serviceFields(text);
  const one = (key, value) => fields.get(key)?.length === 1 && fields.get(key)[0] === value;
  if (!one('User', 'caddy') || !one('Group', 'caddy')
    || !one('Environment', `XDG_DATA_HOME=${targetXdg}`)
    || !one('ReadWritePaths', targetXdg) || !one('NoNewPrivileges', 'true')
    || !one('ExecStart', '/usr/local/bin/caddy run --config /opt/super-error-log/current/deploy/caddy/Caddyfile')
    || fields.has('EnvironmentFile')) fail('候选单元安全约束不满足；请审查配置，不可自动降低权限');
}

function safeRollback(text, legacyXdg) {
  const fields = serviceFields(text);
  const environments = fields.get('Environment') ?? [];
  const writes = fields.get('ReadWritePaths') ?? [];
  if (environments.length !== 1 || environments[0] !== `XDG_DATA_HOME=${legacyXdg}`
    || fields.get('User')?.length !== 1 || fields.get('User')[0] !== 'caddy'
    || fields.has('EnvironmentFile') || writes.length > 1 || (writes.length && writes[0] !== legacyXdg)) {
    fail('旧单元与指定旧 XDG 路径不一致或包含自定义权限；请核对生效配置');
  }
  let section = '';
  return text.split(/\r?\n/).flatMap(raw => {
    const line = raw.trim();
    if (line.startsWith('[')) section = line;
    if (section !== '[Service]') return [raw];
    if (line === `Environment=XDG_DATA_HOME=${legacyXdg}`) {
      return [`Environment=XDG_DATA_HOME=${targetXdg}`, `ReadWritePaths=${targetXdg}`];
    }
    return line.startsWith('ReadWritePaths=') ? [] : [raw];
  }).join('\n');
}

function checkTree(directory) {
  let count = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('旧存储含链接或特殊文件，需人工审查');
    if (entry.isDirectory()) count += checkTree(name);
    else { fs.accessSync(name, fs.constants.R_OK); count++; }
  }
  return count;
}

try {
  process.umask(0o077);
  const args = process.argv.slice(2);
  if (args[0] === '--create-private-destination') {
    if (args.length !== 2 || !path.isAbsolute(args[1])) fail('私有目标必须是明确的绝对路径');
    // mkdir without recursive mode is exclusive: an existing directory or symlink
    // fails before any metadata or contents can be changed.
    fs.mkdirSync(args[1], { mode: 0o700 });
    console.log('全新私有目标目录已创建；尚未复制证书或变更服务。');
    process.exit(0);
  }
  const options = optionsFor(args);
  const release = fs.realpathSync(options['--release']);
  const sourceUnit = path.join(release, 'deploy/systemd', unitName);
  if (!exists(sourceUnit) || !fs.lstatSync(sourceUnit).isFile()) fail('新版发布物缺少 Caddy 单元');
  const candidate = fs.readFileSync(sourceUnit, 'utf8'); validateCandidate(candidate);
  const legacy = fs.realpathSync(options['--legacy-xdg']);
  const actualStorage = path.join(legacy, 'caddy');
  if (!exists(actualStorage) || !fs.lstatSync(actualStorage).isDirectory()) fail('旧 XDG 目录缺少 caddy 存储');
  if (!checkTree(legacy)) fail('旧存储为空，不能证明迁移了原有证书');
  if (!checkTree(actualStorage)) fail('实际 caddy 存储为空，不能证明迁移了原有证书');
  const currentUnit = fs.realpathSync(options['--current-unit']);
  const previous = fs.readFileSync(currentUnit, 'utf8');
  const rollback = safeRollback(previous, options['--legacy-xdg']);
  const staging = path.resolve(options['--staging']);
  if (exists(staging)) fail('准备目录已存在；拒绝覆盖已有备份');
  const stagingParent = fs.realpathSync(path.dirname(staging));
  const destination = path.join(stagingParent, path.basename(staging));
  if (below(destination, legacy) || below(destination, release)) fail('准备目录不能位于旧存储或发布物内部');
  if (options.check) {
    console.log('前置检查通过；尚未备份、迁移或重启服务。仍须检查线上 drop-in 与跨用户权限。');
    process.exit(0);
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.writeFileSync(path.join(destination, 'previous.service'), previous, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'next.service'), candidate, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'rollback.service'), rollback, { flag: 'wx', mode: 0o600 });
  const archive = path.join(destination, 'legacy-xdg.tar');
  // Entire XDG root, including caddy/; tar retains owners/modes for a later root restore.
  execFileSync('tar', ['-cf', archive, '-C', legacy, '.'], { stdio: 'pipe', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.chmodSync(archive, 0o600);
  execFileSync('tar', ['-tf', archive], { stdio: 'pipe' });
  const digest = name => createHash('sha256').update(fs.readFileSync(name)).digest('hex');
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({
    ready: true, sourceRelease: release, sourceUnit: currentUnit, legacyXdg: legacy,
    targetXdg, actualStorage: `${targetXdg}/caddy`, rollbackKeepsIndependentStorage: true,
    sha256: { archive: digest(archive), previousUnit: digest(path.join(destination, 'previous.service')),
      nextUnit: digest(path.join(destination, 'next.service')), rollbackUnit: digest(path.join(destination, 'rollback.service')) },
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`准备完成：${destination}；尚未安装单元、迁移存储或重启服务。`);
} catch (error) {
  console.error(`迁移准备失败：${error.message}。任何半份准备目录须保留调查，不能用于上线。`);
  process.exitCode = 1;
}
