#!/usr/bin/python3
"""Fixed production deployment entry. Python 3.6+ (Alibaba Cloud Linux 3).

Installed root-owned outside releases. Never execute a helper from the upload.
SSH supports only `submit SHA CHECKSUM RUN-ATTEMPT` and `status RUN-ATTEMPT`.
The detached systemd job survives runner/SSH loss; private logs stay on server.
"""
import fcntl
import hashlib
import json
import os
import pwd
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import time

ROOT = Path('/opt/super-error-log')
STATE = Path('/var/lib/sel-ci')
DATA = Path('/var/lib/super-error-log')
BACKUPS = Path('/var/backups/super-error-log-ci')
SERVICE = 'super-error-log'
NODE = str(ROOT / 'node-v24/bin/node')
PUBLIC = 'https://study.pccoding666.com'
RUN = r'[0-9]{1,16}-[0-9]{1,4}'
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_UNPACKED = 128 * 1024 * 1024


def write_json(path, value):
    tmp = path.with_suffix('.tmp')
    with tmp.open('w') as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(tmp), str(path))


def run(args, timeout=60, cwd=None, log=None):
    # No shell and no inherited SSH/proxy/AI variables.
    env = {'PATH': str(ROOT / 'node-v24/bin') + ':/usr/sbin:/usr/bin:/sbin:/bin',
           'HOME': '/var/cache/sel-build', 'LANG': 'C.UTF-8',
           'NPM_CONFIG_CACHE': '/var/cache/sel-build/npm',
           'NPM_CONFIG_REPLACE_REGISTRY_HOST': 'always'}
    return subprocess.run(args, timeout=timeout, cwd=cwd, env=env, check=True,
                          stdout=log or subprocess.DEVNULL,
                          stderr=log or subprocess.DEVNULL)


def read_status(job):
    return json.loads((job / 'status.json').read_text())


def state(job, phase, **kwargs):
    value = read_status(job)
    value.update(kwargs)
    value['phase'] = phase
    value['updatedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_json(job / 'status.json', value)


def safe_unpack(archive, destination):
    """Reject links/special files/duplicates/traversal; copy only release whitelist."""
    with tarfile.open(str(archive), 'r:gz') as tar:
        seen, size, count = set(), 0, 0
        for entry in tar:
            count += 1
            parts = PurePosixPath(entry.name).parts
            if (count > 10000 or entry.name.startswith('/') or '..' in parts
                    or not parts or parts[0] != 'super-error-log'
                    or not (entry.isdir() or entry.isfile())):
                raise ValueError('Unsafe release archive')
            relative = parts[1:]
            if not relative:
                if not entry.isdir():
                    raise ValueError('Invalid archive root')
                continue
            allowed = relative[0] in ('dist', 'deploy') or (
                len(relative) == 1 and entry.isfile()
                and relative[0] in ('package.json', 'package-lock.json', '.env.example'))
            key = '/'.join(relative)
            if not allowed or key in seen:
                raise ValueError('Archive whitelist or duplicate violation')
            seen.add(key)
            size += entry.size
            if size > MAX_UNPACKED:
                raise ValueError('Unpacked release too large')
            target = destination.joinpath(*relative)
            if entry.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with tar.extractfile(entry) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                target.chmod(0o644)
    for required in ('dist/main.js', 'package.json', 'package-lock.json', 'deploy/ci-release.json'):
        if not (destination / required).is_file():
            raise ValueError('Incomplete release archive')


# A queued/running material job untouched for this long belongs to a worker that is not running.
MATERIAL_BUSY_WINDOW_MINUTES = 120


def busy_count():
    # Count only, never print photo names/questions. Unreadable state fails closed.
    count = 0
    for filename in DATA.rglob('job.json'):
        if filename.is_symlink():
            raise ValueError('Unexpected job symlink')
        job = json.loads(filename.read_text())
        if job.get('status') in ('queued', 'processing'):
            count += 1
    for filename in DATA.rglob('app.db'):
        if any(Path(str(filename) + suffix).is_symlink() for suffix in ('', '-shm', '-wal')):
            raise ValueError('Unexpected SQLite symlink')
        db = sqlite3.connect('file:' + str(filename) + '?mode=ro', uri=True, timeout=5)
        try:
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='v2_print_snapshot'").fetchone():
                count += db.execute("SELECT count(*) FROM v2_print_snapshot WHERE status='preparing'").fetchone()[0]
            # Material extraction/answer/grade jobs are the main photo path. Only recently touched
            # queued/running rows count, so a dormant student's leftover row cannot block deploys forever.
            if db.execute("SELECT 1 FROM sqlite_master WHERE name='material_job'").fetchone():
                count += db.execute("SELECT count(*) FROM material_job WHERE state IN ('queued','running') "
                                    "AND updated_at >= datetime('now', ?)",
                                    ('-%d minutes' % MATERIAL_BUSY_WINDOW_MINUTES,)).fetchone()[0]
        finally:
            db.close()
    return count


def busy():
    # SQLite may open WAL/SHM even in read-only mode. Never open app-owned DBs as root.
    output = subprocess.check_output(['/usr/sbin/runuser', '-u', 'supererrorlog', '--',
                                     '/usr/local/sbin/sel-ci-deploy', '--busy'], timeout=15)
    return int(output)


def validate_dependencies(release):
    lock = json.loads((release / 'package-lock.json').read_text())
    for dependency in lock.get('packages', {}).values():
        resolved = dependency.get('resolved', '')
        if dependency.get('link') or (resolved and not resolved.startswith('https://')):
            raise ValueError('Only locked HTTPS registry dependencies may deploy')


def validate_installed_links(release):
    for directory, dirs, files in os.walk(str(release)):
        for name in dirs + files:
            entry = Path(directory) / name
            if entry.is_symlink():
                target = entry.resolve(strict=True)
                if release not in target.parents:
                    raise ValueError('Installed dependency link escapes release')


def check_migrations(release, previous):
    # Known schema/startup migration locations need a separately planned manual release.
    # This is an accidental-migration guard, not a sandbox for malicious merged code.
    for relative in ('dist/db', 'dist/studentHost/registry.js'):
        new, old = release / relative, previous / relative
        def fingerprint(location):
            files = sorted(location.rglob('*')) if location.is_dir() else [location]
            return [(str(p.relative_to(location)) if location.is_dir() else p.name,
                     hashlib.sha256(p.read_bytes()).hexdigest())
                    for p in files if p.is_file()]
        if not old.exists() or fingerprint(new) != fingerprint(old):
            raise ValueError('Database migration code changed; manual release required')


def healthy(deadline=None):
    try:
        if deadline is None:
            deadline = time.monotonic() + 20
        def remaining():
            seconds = min(4, deadline - time.monotonic())
            if seconds <= 0:
                raise TimeoutError('Health check deadline reached')
            return seconds
        run(['/usr/bin/systemctl', 'is-active', '--quiet', SERVICE], timeout=remaining())
        # Resolve to loopback using curl, while checking the real HTTPS certificate/SNI.
        cmd = ['/usr/bin/curl', '--noproxy', '*', '--resolve',
               'study.pccoding666.com:443:127.0.0.1', '--silent', '--show-error',
               '--max-time', '3']
        login = subprocess.check_output(cmd + ['--fail', PUBLIC + '/s/'], timeout=remaining())
        if '邀请码'.encode('utf-8') not in login:
            return False
        assets = re.findall(rb'(?:src|href)="(/s/[^"?]+\.(?:js|css)(?:\?[^\"]*)?)"', login)
        if not assets or len(assets) > 4:
            return False
        for asset in assets:
            run(cmd + ['--fail', '--output', '/dev/null', PUBLIC + asset.decode('utf-8')], timeout=remaining())
        for route in ('/v1/health', '/v2/week'):
            code = subprocess.check_output(cmd + ['--output', '/dev/null', '--write-out', '%{http_code}', PUBLIC + route], timeout=remaining())
            if code != b'401':
                return False
        return True
    except (subprocess.SubprocessError, OSError):
        return False


def wait_healthy():
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if healthy(deadline):
            time.sleep(min(2, max(0, deadline - time.monotonic())))
            if healthy(deadline):
                return
        time.sleep(3)
    raise RuntimeError('Health checks failed')


def point_to(release):
    link = ROOT / 'current.ci-next'
    if link.is_symlink():
        link.unlink()
    link.symlink_to(release)
    os.replace(str(link), str(ROOT / 'current'))


def deploy(job):
    status = read_status(job)
    release = ROOT / 'releases' / ('ci-' + status['run'])
    previous = None
    stopped = False
    lock = (STATE / 'deploy.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        previous = (ROOT / 'current').resolve(strict=True)
        state(job, 'preparing', previous=previous.name, release=release.name)
        if shutil.disk_usage(str(ROOT)).free < 2 * 1024 ** 3:
            raise RuntimeError('Less than 2 GiB free disk space')
        release.mkdir(mode=0o755)
        safe_unpack(job / 'release.tar.gz', release)
        manifest = json.loads((release / 'deploy/ci-release.json').read_text())
        if manifest.get('commit') != status['commit'] or manifest.get('run') != status['run']:
            raise ValueError('Release identity mismatch')
        check_migrations(release, previous)
        validate_dependencies(release)
        run(['/usr/bin/chown', '-R', 'sel-build:sel-build', str(release)])
        with (job / 'install.log').open('w') as log:
            run(['/usr/sbin/runuser', '-u', 'sel-build', '--',
                 str(ROOT / 'node-v24/bin/npm'), 'ci', '--omit=dev', '--ignore-scripts',
                 '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund'],
                timeout=300, cwd=str(release), log=log)
        validate_installed_links(release)
        run(['/usr/bin/chown', '-hR', 'root:root', str(release)])
        # Allow the service user to load files, never grant write access to a release.
        run(['/usr/bin/chmod', '-R', 'go+rX,go-w', str(release)])
        state(job, 'waiting_for_idle')
        for _ in range(24):
            if not busy():
                break
            time.sleep(5)
        else:
            raise RuntimeError('Recognition or print jobs still active; rerun later')
        if not healthy():
            raise RuntimeError('Old service is not healthy; no automatic switch')
        state(job, 'backing_up')
        # Flag first: even a failed stop must restart the original service.
        stopped = True
        run(['/usr/bin/systemctl', 'stop', SERVICE], timeout=45)
        if busy():
            raise RuntimeError('New work arrived before stop; keeping old release')
        backup = BACKUPS / status['run']
        backup.mkdir(mode=0o700)
        with (backup / 'backup.log').open('w') as log:
            run(['/usr/bin/tar', '--exclude=*.sock', '-czf', str(backup / 'data-and-config.tar.gz'),
                 '-C', '/', 'var/lib/super-error-log', 'etc/super-error-log/env',
                 'etc/systemd/system/super-error-log.service'], timeout=120, log=log)
        write_json(backup / 'release.json', {'previous': str(previous), 'next': str(release),
                                            'commit': status['commit']})
        state(job, 'starting', backup=str(backup))
        point_to(release)
        run(['/usr/bin/systemctl', 'start', SERVICE], timeout=45)
        wait_healthy()
        state(job, 'succeeded')
    except BaseException as error:
        rollback = 'not_needed'
        if stopped:
            try:
                point_to(previous)
                run(['/usr/bin/systemctl', 'restart', SERVICE], timeout=45)
                wait_healthy()
                rollback = 'succeeded'
            except BaseException:
                rollback = 'failed'
        # Exceptions from commands never include captured output or student content.
        with (job / 'failure.log').open('w') as log:
            log.write(type(error).__name__ + ': ' + str(error) + '\n')
        state(job, 'failed', rollback=rollback,
              reason='Release failed; private server log has details')
        raise SystemExit(1)
    finally:
        lock.close()


def interrupted(_signal, _frame):
    raise RuntimeError('Deployment interrupted by service timeout')


def recover(job):
    """ExecStopPost safety net, including OOM/SIGKILL where finally cannot run."""
    lock = (STATE / 'deploy.lock').open('w')
    with lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        status = read_status(job)
        if status['phase'] == 'succeeded' or (status['phase'] == 'failed' and status.get('rollback') in ('succeeded', 'not_needed')):
            return
        rollback = 'not_needed'
        if status['phase'] in ('backing_up', 'starting') or status.get('rollback') == 'failed':
            try:
                previous = (ROOT / 'releases' / status['previous']).resolve(strict=True)
                if previous.parent != (ROOT / 'releases').resolve():
                    raise ValueError('Invalid previous release')
                point_to(previous)
                run(['/usr/bin/systemctl', 'restart', SERVICE], timeout=45)
                wait_healthy()
                rollback = 'succeeded'
            except BaseException:
                rollback = 'failed'
        state(job, 'failed', rollback=rollback, reason='Deployment process stopped unexpectedly')


def main():
    os.umask(0o077)
    if sys.argv[1:] == ['--busy']:
        if os.geteuid() == 0 or os.geteuid() != pwd.getpwnam('supererrorlog').pw_uid:
            raise SystemExit('Busy probe requires the application user')
        print(busy_count())
        return
    if os.geteuid() != 0:
        raise SystemExit('Root-owned deployment entry required')
    if len(sys.argv) == 3 and sys.argv[1] == '--execute' and re.fullmatch(RUN, sys.argv[2]):
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, interrupted)
        deploy(STATE / sys.argv[2])
        return
    if len(sys.argv) == 3 and sys.argv[1] == '--recover' and re.fullmatch(RUN, sys.argv[2]):
        recover(STATE / sys.argv[2])
        return
    if len(sys.argv) != 2:
        raise SystemExit('Invalid command')
    command = sys.argv[1]
    match = re.fullmatch(r'status (' + RUN + ')', command)
    if match:
        print(json.dumps(read_status(STATE / match[1])))
        return
    match = re.fullmatch(r'submit ([0-9a-f]{40}) ([0-9a-f]{64}) (' + RUN + ')', command)
    if not match:
        raise SystemExit('Only submit and status are allowed')
    sha, checksum, run_id = match.groups()
    job = STATE / run_id
    if job.exists():
        raise SystemExit('Run already submitted; query status or use a new attempt')
    job.mkdir(mode=0o700)
    signal.signal(signal.SIGALRM, interrupted)
    signal.alarm(90)
    digest, size = hashlib.sha256(), 0
    with (job / 'release.tar.gz').open('xb') as output:
        while True:
            chunk = sys.stdin.buffer.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_ARCHIVE:
                raise SystemExit('Archive too large')
            digest.update(chunk)
            output.write(chunk)
    signal.alarm(0)
    if digest.hexdigest() != checksum:
        raise SystemExit('Checksum mismatch')
    write_json(job / 'status.json', {'run': run_id, 'commit': sha, 'phase': 'submitted'})
    run(['/usr/bin/systemd-run', '--quiet', '--unit=sel-ci-' + run_id,
         '--property=RuntimeMaxSec=900', '--property=TimeoutStopSec=180',
         '--property=MemoryLimit=512M', '--property=CPUQuota=75%', '--property=Nice=10',
         '--property=ExecStopPost=/usr/local/sbin/sel-ci-deploy --recover ' + run_id,
         '/usr/local/sbin/sel-ci-deploy', '--execute', run_id], timeout=15)
    print(json.dumps(read_status(job)))


if __name__ == '__main__':
    main()
