"""Synthetic checks for the release backup: archive before stop, no secrets, keep 3."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'deploy/ci/sel-ci-deploy.py'
spec = importlib.util.spec_from_file_location('deploy_backup', str(SOURCE))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def release_archive(path):
    files = {'dist/main.js': 'export {};', 'dist/db/schema.js': 'schema-v1',
             'dist/studentHost/registry.js': 'registry-v1', 'package.json': '{}',
             'package-lock.json': '{"packages": {}}',
             'deploy/ci-release.json': json.dumps({'commit': 'a' * 40, 'run': '123-1'})}
    with tarfile.open(str(path), 'w:gz') as tar:
        for name, text in files.items():
            data = text.encode()
            info = tarfile.TarInfo('super-error-log/' + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))


class BackupChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'app'
        self.old = self.root / 'releases/previous'
        (self.old / 'dist/db').mkdir(parents=True)
        (self.old / 'dist/db/schema.js').write_text('schema-v1')
        (self.old / 'dist/studentHost').mkdir()
        (self.old / 'dist/studentHost/registry.js').write_text('registry-v1')
        (self.root / 'current').symlink_to(self.old)
        self.state = self.base / 'state'
        self.job = self.state / '123-1'
        self.job.mkdir(parents=True)
        self.backups = self.base / 'backups'
        self.backups.mkdir()
        self.data = self.base / 'data'
        student = self.data / 'student-host/students/synthetic'
        (student / 'photos').mkdir(parents=True)
        (student / 'photos/page-1.jpg').write_bytes(b'\xff\xd8synthetic-jpeg')
        (student / 'app.db').write_bytes(b'SQLite format 3\x00synthetic')
        (student / 'app.db-wal').write_bytes(b'wal')
        (self.data / 'student-host/registry.db').write_bytes(b'SQLite format 3\x00registry')
        # Things that must never land in a release backup.
        (self.data / 'env').write_text('SEL_AI_API_KEY=fake-secret')
        (self.data / 'tls').mkdir()
        (self.data / 'tls/key.pem').write_text('-----BEGIN PRIVATE KEY-----fake')
        (self.data / 'server.key').write_text('fake-key')
        (self.data / 'old.env').write_text('X=1')
        deploy.write_json(self.job / 'status.json', {'commit': 'a' * 40, 'run': '123-1', 'phase': 'submitted'})
        release_archive(self.job / 'release.tar.gz')
        for name, value in [('ROOT', self.root), ('STATE', self.state), ('BACKUPS', self.backups), ('DATA', self.data)]:
            p = patch.object(deploy, name, value)
            p.start()
            self.addCleanup(p.stop)

    def perform(self, failure=None, real_tar=False):
        calls = []
        real_run = deploy.run
        def command(args, **kwargs):
            calls.append(args)
            if failure:
                failure(args)
            if real_tar and args[0] == '/usr/bin/tar':
                return real_run(args, **kwargs)
        with patch.object(deploy, 'run', side_effect=command), \
                patch.object(deploy, 'busy', return_value=0), \
                patch.object(deploy, 'healthy', return_value=True), \
                patch.object(deploy, 'wait_healthy'), \
                patch.object(deploy.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 10 * 1024 ** 3})()):
            try:
                deploy.deploy(self.job)
            except SystemExit:
                pass
        return calls

    def test_bulk_archive_runs_before_stop_and_only_sqlite_while_stopped(self):
        calls = self.perform()
        self.assertEqual(deploy.read_status(self.job)['phase'], 'succeeded')
        tars = [i for i, c in enumerate(calls) if c[0] == '/usr/bin/tar']
        stop = next(i for i, c in enumerate(calls) if c[:2] == ['/usr/bin/systemctl', 'stop'])
        start = next(i for i, c in enumerate(calls) if c[:2] == ['/usr/bin/systemctl', 'start'])
        self.assertEqual(len(tars), 2)
        self.assertLess(tars[0], stop)
        self.assertTrue(stop < tars[1] < start)
        self.assertIn('files.tar', ' '.join(calls[tars[0]]))
        self.assertNotIn('-czf', calls[tars[0]])
        self.assertIn('sqlite.tar', ' '.join(calls[tars[1]]))
        everything = ' '.join(' '.join(c) for c in calls)
        self.assertNotIn('etc/super-error-log/env', everything)

    def test_real_archives_exclude_env_and_private_keys(self):
        self.perform(real_tar=True)
        self.assertEqual(deploy.read_status(self.job)['phase'], 'succeeded')
        backup = self.backups / '123-1'
        with tarfile.open(str(backup / 'files.tar')) as tar:
            files = tar.getnames()
        with tarfile.open(str(backup / 'sqlite.tar')) as tar:
            sqlite = tar.getnames()
        rel = str(self.data.relative_to('/'))
        self.assertIn(rel + '/student-host/students/synthetic/photos/page-1.jpg', files)
        self.assertFalse([n for n in files if n.endswith(('.db', '.db-wal', '.db-shm'))])
        self.assertEqual(sorted(sqlite), sorted([rel + '/student-host/registry.db',
                                                 rel + '/student-host/students/synthetic/app.db',
                                                 rel + '/student-host/students/synthetic/app.db-wal']))
        for names in (files, sqlite):
            joined = '\n'.join(names)
            for secret in ('/env', 'key.pem', 'server.key', 'old.env', '/tls'):
                self.assertNotIn(secret, joined)
        manifest = json.loads((backup / 'release.json').read_text())
        self.assertEqual(manifest['contents'], ['files.tar', 'sqlite.tar'])

    def test_failed_bulk_archive_never_stops_the_service(self):
        def fail(args):
            if args[0] == '/usr/bin/tar':
                raise subprocess.CalledProcessError(2, 'tar')
        calls = self.perform(failure=fail)
        status = deploy.read_status(self.job)
        self.assertEqual((status['phase'], status['rollback']), ('failed', 'not_needed'))
        self.assertFalse(any(c[:2] == ['/usr/bin/systemctl', 'stop'] for c in calls))
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_tar_file_changed_exit_code_is_tolerated_only_for_live_archive(self):
        with patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            deploy.backup_files_live(self.backups, None)
            with self.assertRaises(subprocess.CalledProcessError):
                deploy.backup_sqlite_stopped(self.backups, None)
        with patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 2)):
            with self.assertRaises(subprocess.CalledProcessError):
                deploy.backup_files_live(self.backups, None)

    def test_sqlite_symlink_is_rejected(self):
        (self.data / 'evil.db').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            deploy.sqlite_file_list()

    def test_keeps_only_latest_three_backups_and_protected_releases(self):
        now = time.time()
        for index in range(6):
            folder = self.backups / ('10{}-1'.format(index))
            folder.mkdir()
            (folder / 'data-and-config.tar.gz').write_bytes(b'old')
            os.utime(str(folder), (now - 1000 + index, now - 1000 + index))
        (self.backups / 'notes').mkdir()
        (self.backups / '999-1-link').symlink_to(self.base)
        releases = self.root / 'releases'
        for index in range(5):
            folder = releases / ('ci-20{}-1'.format(index))
            folder.mkdir()
            os.utime(str(folder), (now - 500 + index, now - 500 + index))
        (self.root / 'current').unlink()
        (self.root / 'current').symlink_to(releases / 'ci-200-1')
        self.old = releases / 'ci-200-1'
        for relative in ('dist/db/schema.js', 'dist/studentHost/registry.js'):
            (self.old / relative).parent.mkdir(parents=True, exist_ok=True)
        (self.old / 'dist/db/schema.js').write_text('schema-v1')
        (self.old / 'dist/studentHost/registry.js').write_text('registry-v1')
        os.utime(str(self.old), (now - 10000, now - 10000))
        self.perform()
        self.assertEqual(deploy.read_status(self.job)['phase'], 'succeeded')
        kept = sorted(p.name for p in self.backups.iterdir())
        self.assertEqual(kept, ['104-1', '105-1', '123-1', '999-1-link', 'notes'])
        self.assertTrue((self.backups / '999-1-link').is_symlink())
        self.assertTrue(self.base.exists())
        rel = sorted(p.name for p in releases.iterdir())
        # Newest 3 ci releases + protected previous (oldest) + this run + manual release.
        self.assertEqual(rel, ['ci-123-1', 'ci-200-1', 'ci-202-1', 'ci-203-1', 'ci-204-1', 'previous'])

    def test_recover_while_archiving_does_not_restart(self):
        deploy.state(self.job, 'archiving', previous=self.old.name)
        with patch.object(deploy, 'run') as command:
            deploy.recover(self.job)
            command.assert_not_called()
        status = deploy.read_status(self.job)
        self.assertEqual((status['phase'], status['rollback']), ('failed', 'not_needed'))


if __name__ == '__main__':
    unittest.main()
