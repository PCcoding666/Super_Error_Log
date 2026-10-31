#!/usr/bin/python3
"""main 4806d18（#88 /s/native/web + #85 详情页）的人工发布。root 在服务器上执行。

为什么要人工：dist/db/schema.js 新增 3 张表 + 2 个索引（全是 CREATE ... IF NOT EXISTS，纯追加，不改旧数据），
自动发布程序对 run 40166845191-1 判定 "Database migration code changed; manual release required"。
registry.js 不变；package.json / package-lock.json 只多了 3 个仅客户端用的依赖；Caddyfile、systemd 单元、
发布程序与线上版本逐字节相同。不改发布程序的迁移指纹，不加绕过开关。

阶段（都要拿 deploy.lock；每个阶段单独执行，中间可以停下来看结果）：
  prepare   把 CI 构建、已校验 sha256 的发布包解到 releases/manual-4806d18，装 Linux 生产依赖。不碰服务。
  rehearse  对每个 app.db（旧单学生库 + 每个学生空间）做一致的在线副本，用新版打开、再用线上版本打开。
            不碰服务，不碰生产目录里的任何文件。
  execute   等空闲 → 停服 → 整份备份并逐字节核对 → 对真实库建表并核对 → 切 current → 启动 → 健康检查。
            失败自动把代码切回线上版本（演练已证明新表不影响旧版本）。
  status    打印 status.json。

用法：python3 release.py prepare | rehearse | execute | status
"""
import difflib
import fcntl
import hashlib
import importlib.machinery
import json
import os
import pwd
import shutil
import signal
import subprocess
import sys
import tarfile
import time
from pathlib import Path

ops = importlib.machinery.SourceFileLoader('sel_deploy', '/usr/local/sbin/sel-ci-deploy').load_module()

NAME = 'manual-4806d18'
SOURCE_RUN = '40166845191-1'
COMMIT = '4806d184e7f7c04a567fc646919deacd522fb914'
OLD_COMMIT = 'e28aa1b8f39975d3fe5b130c77a7b0c82ae27922'
# CI 发布包：Actions run 40166845191 attempt 1 上传、服务器 submit 时已按此 sha256 核对。
CHECKSUM = '472efb580c2fd54e962ecabb2d275c66a651f4294da7a7e1292fe810ec6864cc'
# git show 4806d18:package.json / package-lock.json 的 sha256（本地与服务器解包结果均一致）。
PACKAGE_JSON_SHA = '3b28757c18a7d6c9030e4ce3e9d298dcee15d7b831af758d85426765420c70a6'
PACKAGE_LOCK_SHA = 'a0567613d45dc221ee8b7ed4beb8dd49211ce83917045e9847e3db044f2bb1f7'

HERE = Path(__file__).resolve().parent
BASE = ops.STATE / NAME
SOURCE_ARCHIVE = ops.STATE / SOURCE_RUN / 'release.tar.gz'
RELEASE = ops.ROOT / 'releases' / NAME
PREVIOUS = ops.ROOT / 'releases' / 'ci-40128767005-1'
BACKUP = ops.BACKUPS / NAME
WORK = Path('/var/tmp') / NAME
ACCOUNT = pwd.getpwnam('supererrorlog')
ENV = Path('/etc/super-error-log/env')
UNIT = Path('/etc/systemd/system/super-error-log.service')
DROPIN = Path('/etc/systemd/system/super-error-log.service.d/small-box.conf')
GUARD = Path('/usr/local/sbin/sel-ci-deploy')

NEW_OBJECTS = ['idx_item_answer_photo_item', 'idx_item_insight_item', 'item_answer_photo', 'item_insight', 'item_note']
# dist/db/schema.js 相对线上版本允许的全部新增行（去掉空行和 -- 注释后）；不允许有删除行。
EXPECTED_SCHEMA_ADDITIONS = """
CREATE TABLE IF NOT EXISTS item_insight (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id) ON DELETE CASCADE,
  basis_hash TEXT NOT NULL,
  content_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_insight_item ON item_insight(item_id, created_at);
CREATE TABLE IF NOT EXISTS item_answer_photo (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES error_item(id) ON DELETE CASCADE,
  image BLOB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reading','done','not_found','failed')),
  text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_item_answer_photo_item ON item_answer_photo(item_id, created_at);
CREATE TABLE IF NOT EXISTS item_note (
  item_id TEXT PRIMARY KEY REFERENCES error_item(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
""".strip().splitlines()


def digest(filename):
    h = hashlib.sha256()
    with Path(filename).open('rb') as handle:
        for block in iter(lambda: handle.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def read_state():
    return json.loads((BASE / 'status.json').read_text()) if (BASE / 'status.json').exists() else {}


def state(phase, **kwargs):
    value = read_state()
    value.update(kwargs)
    value.update(phase=phase, commit=COMMIT, previous=str(PREVIOUS), release=str(RELEASE),
                 updatedAt=now(), sourceRun=SOURCE_RUN)
    ops.write_json(BASE / 'status.json', value)


def current():
    assert (ops.ROOT / 'current').resolve() == PREVIOUS, 'Production version changed'
    assert json.loads((PREVIOUS / 'deploy/ci-release.json').read_text())['commit'] == OLD_COMMIT


def fingerprints(root):
    return {str(p.relative_to(root)): digest(p) for p in root.rglob('*') if p.is_file()}


def service_node(script, args=(), timeout=180):
    """以服务账号跑一段 ESM 脚本（stdin），参数在 argv[2:]。"""
    return subprocess.run(
        ['/usr/sbin/runuser', '-u', 'supererrorlog', '--', ops.NODE, '--input-type=module', '-', *map(str, args)],
        input=script.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=timeout,
    ).stdout


def databases():
    found = sorted(p for p in ops.DATA.rglob('app.db') if p.is_file() and not p.is_symlink())
    assert found, 'no app.db found under ' + str(ops.DATA)
    return found


def label_of(db):
    relative = str(db.parent.relative_to(ops.DATA))
    return 'root' if relative == '.' else relative.replace('/', '__')


def extra_busy():
    code = (
        "import pathlib,sqlite3; n=0\n"
        "for p in pathlib.Path('/var/lib/super-error-log').rglob('app.db'):\n"
        " d=sqlite3.connect('file:'+str(p)+'?mode=ro',uri=True)\n"
        " for t,s in [('practice_work','recognizing'),('practice_submission','analyzing')]:\n"
        "  if d.execute('SELECT 1 FROM sqlite_master WHERE name=?',(t,)).fetchone(): "
        "n+=d.execute('SELECT count(*) FROM '+t+' WHERE status=?',(s,)).fetchone()[0]\n"
        " d.close()\n"
        "print(n)"
    )
    return int(subprocess.check_output(
        ['/usr/sbin/runuser', '-u', 'supererrorlog', '--', '/usr/bin/python3', '-c', code], timeout=15))


def check_schema_only_additions():
    old = (PREVIOUS / 'dist/db/schema.js').read_text().splitlines()
    new = (RELEASE / 'dist/db/schema.js').read_text().splitlines()
    removed, added = [], []
    for line in difflib.unified_diff(old, new, n=0, lineterm=''):
        if line.startswith('+++') or line.startswith('---') or line.startswith('@@'):
            continue
        if line.startswith('-'):
            removed.append(line[1:])
        elif line.startswith('+'):
            text = line[1:]
            if text.strip() and not text.lstrip().startswith('--'):
                added.append(text.rstrip())
    assert removed == [], 'schema.js removed lines: ' + repr(removed[:3])
    assert added == EXPECTED_SCHEMA_ADDITIONS, 'schema.js additions differ from the reviewed block'


def prepare():
    current()
    assert (HERE / 'schema-check.mjs').is_file(), 'schema-check.mjs must sit next to release.py'
    assert SOURCE_ARCHIVE.is_file() and digest(SOURCE_ARCHIVE) == CHECKSUM, 'CI archive missing or checksum mismatch'
    assert shutil.disk_usage(str(ops.ROOT)).free > 2 * 1024 ** 3, 'less than 2 GiB free'
    if RELEASE.exists():
        raise RuntimeError('Release directory already exists: ' + str(RELEASE))
    BASE.mkdir(mode=0o700, exist_ok=True)
    shutil.copy2(str(SOURCE_ARCHIVE), str(BASE / 'release.tar.gz'))
    shutil.copy2(str(HERE / 'schema-check.mjs'), str(BASE / 'schema-check.mjs'))
    shutil.copy2(str(Path(__file__).resolve()), str(BASE / 'release.py'))
    assert digest(BASE / 'release.tar.gz') == CHECKSUM
    RELEASE.mkdir(mode=0o755)
    ops.safe_unpack(BASE / 'release.tar.gz', RELEASE)
    manifest = json.loads((RELEASE / 'deploy/ci-release.json').read_text())
    assert manifest['commit'] == COMMIT and manifest['run'] == SOURCE_RUN, 'release identity mismatch'
    for name in ('deploy/caddy/Caddyfile', 'deploy/systemd/super-error-log.service', 'deploy/ci/sel-ci-deploy.py'):
        assert digest(RELEASE / name) == digest(PREVIOUS / name), 'Unexpected infrastructure change: ' + name
    assert digest(RELEASE / 'package.json') == PACKAGE_JSON_SHA, 'package.json differs from reviewed 4806d18'
    assert digest(RELEASE / 'package-lock.json') == PACKAGE_LOCK_SHA, 'package-lock.json differs from reviewed 4806d18'
    assert digest(RELEASE / 'dist/studentHost/registry.js') == digest(PREVIOUS / 'dist/studentHost/registry.js'), 'registry.js changed'
    old_db, new_db = fingerprints(PREVIOUS / 'dist/db'), fingerprints(RELEASE / 'dist/db')
    assert set(old_db) == set(new_db), 'dist/db file set changed'
    assert [k for k in sorted(new_db) if new_db[k] != old_db[k]] == ['schema.js'], 'dist/db: more than schema.js changed'
    check_schema_only_additions()
    ops.validate_dependencies(RELEASE)
    ops.run(['/usr/bin/chown', '-R', 'sel-build:sel-build', str(RELEASE)])
    with (BASE / 'install.log').open('w') as log:
        ops.run(['/usr/sbin/runuser', '-u', 'sel-build', '--',
                 str(ops.ROOT / 'node-v24/bin/npm'), 'ci', '--omit=dev', '--ignore-scripts',
                 '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'],
                timeout=600, cwd=str(RELEASE), log=log)
    ops.validate_installed_links(RELEASE)
    assert (RELEASE / 'node_modules/sharp/package.json').is_file(), 'sharp missing after npm ci'
    ops.run(['/usr/bin/chown', '-hR', 'root:root', str(RELEASE)])
    ops.run(['/usr/bin/chmod', '-R', 'go+rX,go-w', str(RELEASE)])
    state('prepared', sha256=CHECKSUM,
          note='dist/db: schema.js additive only (3 tables, 2 indexes); registry.js identical; infra identical; 3 client-only deps added')
    print(json.dumps(read_state()))


def live_copy(source, dest):
    """SQLite 在线备份 API 做一致副本（读 WAL 内容，不停服，不影响源库）。以服务账号执行。"""
    script = (
        "import { DatabaseSync, backup } from 'node:sqlite';\n"
        "const [src, dest] = process.argv.slice(2);\n"
        "const db = new DatabaseSync(src, { readOnly: true });\n"
        "try { await backup(db, dest); } finally { db.close(); }\n"
    )
    service_node(script, [source, dest], timeout=120)


def run_check(data_dir, mode):
    helper = (BASE / 'schema-check.mjs').read_text()
    result = json.loads(service_node(helper, [data_dir, RELEASE, PREVIOUS, mode], timeout=300))
    assert result['integrity'] == 'ok' and result['foreignKeys'] == 'ok'
    assert result['oldRowsUnchanged'] is True and result['idempotent'] is True
    assert sorted(result['added'] + result['alreadyMigrated']) == NEW_OBJECTS, 'unexpected objects: ' + repr(result)
    if mode == 'rehearse':
        assert result['oldVersionCompatible'] is True
    return result


def rehearse():
    assert read_state().get('phase') == 'prepared', 'run prepare first'
    current()
    if WORK.exists():
        shutil.rmtree(str(WORK))
    WORK.mkdir(mode=0o700)
    os.chown(str(WORK), ACCOUNT.pw_uid, ACCOUNT.pw_gid)
    results = {}
    for db in databases():
        label = label_of(db)
        copy_dir = WORK / label
        copy_dir.mkdir(mode=0o700)
        os.chown(str(copy_dir), ACCOUNT.pw_uid, ACCOUNT.pw_gid)
        live_copy(db, copy_dir / 'app.db')
        results[label] = run_check(copy_dir, 'rehearse')
    ops.write_json(BASE / 'rehearse-result.json', results)
    state('rehearsed', rehearsal={'databases': len(results), 'allPassed': True,
                                  'alreadyMigrated': sorted(k for k, v in results.items() if v['alreadyMigrated'])})
    print(json.dumps(read_state()))


def verify_backup(archive):
    expected = [p for p in ops.DATA.rglob('*') if p.is_file() and not p.name.endswith('.sock')]
    expected += [ENV, UNIT]
    if DROPIN.is_file():
        expected.append(DROPIN)
    with tarfile.open(str(archive), 'r:gz') as tar:
        members = {m.name: m for m in tar.getmembers()}
        for p in expected:
            assert not p.is_symlink()
            member = members[str(p).lstrip('/')]
            assert member.isfile() and member.size == p.stat().st_size
            h = hashlib.sha256()
            with tar.extractfile(member) as handle:
                for block in iter(lambda: handle.read(1048576), b''):
                    h.update(block)
            assert h.hexdigest() == digest(p), 'Backup content mismatch: ' + str(p)
    return {'verifiedFiles': len(expected), 'sha256': digest(archive), 'content': 'byte-for-byte verified'}


def execute():
    assert read_state().get('phase') == 'rehearsed', 'run rehearse first'
    current()
    assert (RELEASE / 'node_modules/sharp/package.json').is_file()
    stopped = False
    config_hash, guard_hash, unit_hash = digest(ENV), digest(GUARD), digest(UNIT)
    dropin_hash = digest(DROPIN) if DROPIN.is_file() else None
    try:
        state('waiting_for_idle')
        for _ in range(24):
            if not ops.busy() and not extra_busy():
                break
            time.sleep(5)
        else:
            raise RuntimeError('Active work did not become idle')
        assert ops.healthy(), 'Old service unhealthy'
        current()
        stopped = True
        state('backing_up')
        ops.run(['/usr/bin/systemctl', 'stop', ops.SERVICE], timeout=45)
        assert subprocess.check_output(
            ['/usr/bin/systemctl', 'show', ops.SERVICE, '-p', 'MainPID', '--value']).strip() == b'0'
        assert not ops.busy() and not extra_busy()
        assert not any(p.is_symlink() for p in ops.DATA.rglob('*'))
        BACKUP.mkdir(mode=0o700)
        archive = BACKUP / 'data-and-config.tar.gz'
        paths = ['var/lib/super-error-log', 'etc/super-error-log/env', 'etc/systemd/system/super-error-log.service']
        if DROPIN.is_file():
            paths.append('etc/systemd/system/super-error-log.service.d/small-box.conf')
        with (BASE / 'backup.log').open('w') as log:
            ops.run(['/usr/bin/tar', '--exclude=*.sock', '-czf', str(archive), '-C', '/', *paths], timeout=300, log=log)
        verified = verify_backup(archive)
        ops.write_json(BACKUP / 'verification.json', verified)
        ops.write_json(BACKUP / 'release.json', {
            'previous': str(PREVIOUS), 'next': str(RELEASE), 'commit': COMMIT, 'sourceRun': SOURCE_RUN,
            'note': 'code rollback: rollback-code.sh (new tables are ignored by the previous release); '
                    'data restore only after separate confirmation: tar -xzf data-and-config.tar.gz -C / with the service stopped',
        })
        rollback = (
            '#!/bin/sh\nset -eu\n'
            'exec 9>/var/lib/sel-ci/deploy.lock\nflock -n 9\n'
            'ln -s %s /opt/super-error-log/current.admin-rollback\n'
            'mv -Tf /opt/super-error-log/current.admin-rollback /opt/super-error-log/current\n'
            'systemctl restart super-error-log\n'
        ) % PREVIOUS
        (BACKUP / 'rollback-code.sh').write_text(rollback)
        (BACKUP / 'rollback-code.sh').chmod(0o700)

        state('migrating', backup=str(BACKUP), backupVerification=verified)
        applied = {}
        for db in databases():
            applied[label_of(db)] = run_check(db.parent, 'apply')
        ops.write_json(BASE / 'apply-result.json', applied)
        assert digest(ENV) == config_hash and digest(GUARD) == guard_hash and digest(UNIT) == unit_hash
        assert (digest(DROPIN) if DROPIN.is_file() else None) == dropin_hash
        state('starting', migration={'databases': len(applied), 'allPassed': True}, configuration='unchanged')
        ops.point_to(RELEASE)
        ops.run(['/usr/bin/systemctl', 'start', ops.SERVICE], timeout=45)
        ops.wait_healthy()
        assert (ops.ROOT / 'current').resolve() == RELEASE
        assert json.loads((RELEASE / 'deploy/ci-release.json').read_text())['commit'] == COMMIT
        state('succeeded', health='passed', configuration='unchanged', ciMigrationGuard='unchanged', completedAt=now())
        # 演练用的学生库副本只在发布期间需要；成功后删掉，不让学生数据多留一份。
        if WORK.exists():
            shutil.rmtree(str(WORK))
        print(json.dumps(read_state()))
    except BaseException as error:
        rollback = 'not_needed'
        if stopped:
            try:
                ops.point_to(PREVIOUS)
                ops.run(['/usr/bin/systemctl', 'restart', ops.SERVICE], timeout=45)
                ops.wait_healthy()
                rollback = 'succeeded'
            except BaseException as error2:
                rollback = 'failed: ' + type(error2).__name__
        state('failed', rollback=rollback, errorType=type(error).__name__, error=str(error)[:300])
        raise


def interrupted(_sig, _frame):
    raise RuntimeError('Manual release interrupted')


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 2 or sys.argv[1] not in ('prepare', 'rehearse', 'execute', 'status'):
        raise SystemExit('usage: release.py prepare | rehearse | execute | status')
    if sys.argv[1] == 'status':
        print(json.dumps(read_state(), ensure_ascii=False, indent=2))
        raise SystemExit(0)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupted)
    ops.STATE.mkdir(mode=0o700, exist_ok=True)
    with (ops.STATE / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        {'prepare': prepare, 'rehearse': rehearse, 'execute': execute}[sys.argv[1]]()
