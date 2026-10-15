"""Synthetic deployment checks: no SSH, systemd, student data, or root required."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'deploy/ci/sel-ci-deploy.py'
spec = importlib.util.spec_from_file_location('deploy', str(SOURCE))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def archive(path, entries=None):
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
        for info, data in entries or []:
            tar.addfile(info, io.BytesIO(data))


class DeploymentChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / 'app'
        self.old = self.root / 'releases/previous'
        self.old.mkdir(parents=True)
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
        deploy.write_json(self.job / 'status.json', {'commit': 'a' * 40, 'run': '123-1', 'phase': 'submitted'})
        archive(self.job / 'release.tar.gz')
        for name, value in [('ROOT', self.root), ('STATE', self.state), ('BACKUPS', self.backups)]:
            p = patch.object(deploy, name, value)
            p.start()
            self.addCleanup(p.stop)

    def perform(self, failure=None, health=None):
        calls = []
        def command(args, **kwargs):
            calls.append(args)
            if failure:
                failure(args)
        with patch.object(deploy, 'run', side_effect=command), \
                patch.object(deploy, 'busy', return_value=0), \
                patch.object(deploy, 'healthy', return_value=True), \
                patch.object(deploy, 'wait_healthy', side_effect=health), \
                patch.object(deploy.shutil, 'disk_usage', return_value=type('Disk', (), {'free': 10 * 1024 ** 3})()):
            try:
                deploy.deploy(self.job)
            except SystemExit:
                pass
        return calls

    def test_success_has_backup_before_switch(self):
        calls = self.perform()
        self.assertEqual(deploy.read_status(self.job)['phase'], 'succeeded')
        self.assertEqual((self.root / 'current').resolve().name, 'ci-123-1')
        backup = next(i for i, c in enumerate(calls) if c[0] == '/usr/bin/tar')
        start = next(i for i, c in enumerate(calls) if c[:2] == ['/usr/bin/systemctl', 'start'])
        self.assertLess(backup, start)

    def test_failed_new_health_restores_previous(self):
        self.perform(health=[RuntimeError('new failed'), None])
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(deploy.read_status(self.job)['rollback'], 'succeeded')

    def test_signal_between_switch_and_next_statement_restores_previous(self):
        original = deploy.point_to
        def interrupted_point(release):
            original(release)
            if release != self.old:
                raise RuntimeError('signal after atomic replace')
        with patch.object(deploy, 'point_to', side_effect=interrupted_point):
            self.perform()
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(deploy.read_status(self.job)['rollback'], 'succeeded')

    def test_install_failure_never_stops_live_service(self):
        def fail(args):
            if args[0] == '/usr/sbin/runuser':
                raise RuntimeError('npm failed')
        calls = self.perform(failure=fail)
        self.assertFalse(any(c[:2] == ['/usr/bin/systemctl', 'stop'] for c in calls))
        self.assertEqual((self.root / 'current').resolve(), self.old)

    def test_changed_database_code_rejected_before_stop(self):
        (self.old / 'dist/db/schema.js').write_text('different-schema')
        calls = self.perform()
        self.assertEqual(deploy.read_status(self.job)['phase'], 'failed')
        self.assertFalse(any(c[0] == '/usr/bin/systemctl' for c in calls))

    def test_rollback_failure_is_not_success(self):
        self.perform(health=[RuntimeError('new failed'), RuntimeError('old failed')])
        status = deploy.read_status(self.job)
        self.assertEqual((status['phase'], status['rollback']), ('failed', 'failed'))

    def test_archive_traversal_and_links_rejected(self):
        for kind in ('traversal', 'symlink', 'hardlink'):
            with self.subTest(kind=kind):
                info = tarfile.TarInfo('super-error-log/dist/../../escape' if kind == 'traversal' else 'super-error-log/dist/link')
                if kind != 'traversal':
                    info.type = tarfile.SYMTYPE if kind == 'symlink' else tarfile.LNKTYPE
                    info.linkname = '/etc/passwd'
                path = self.base / (kind + '.tar.gz')
                archive(path, [(info, b'')])
                with self.assertRaises(ValueError):
                    deploy.safe_unpack(path, self.base / kind)
        self.assertFalse((self.base / 'escape').exists())

    def test_installed_link_must_stay_inside_release(self):
        (self.old / 'external').symlink_to(self.job)
        with self.assertRaises(ValueError):
            deploy.validate_installed_links(self.old)

    def test_local_dependency_is_rejected(self):
        (self.old / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/x': {'resolved': 'file:/tmp/x'}}}))
        with self.assertRaises(ValueError):
            deploy.validate_dependencies(self.old)

    def test_busy_probe_runs_as_application_user(self):
        with patch.object(deploy.subprocess, 'check_output', return_value=b'0\n') as command:
            self.assertEqual(deploy.busy(), 0)
            self.assertIn('supererrorlog', command.call_args[0][0])
            self.assertIn('--busy', command.call_args[0][0])

    def test_hard_termination_after_switch_recovers_independently(self):
        new = self.root / 'releases/ci-123-1'
        new.mkdir()
        deploy.point_to(new)
        deploy.state(self.job, 'starting', previous=self.old.name)
        with patch.object(deploy, 'run'), patch.object(deploy, 'wait_healthy'):
            deploy.recover(self.job)
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(deploy.read_status(self.job)['rollback'], 'succeeded')

    def test_termination_before_stop_does_not_restart_app(self):
        deploy.state(self.job, 'preparing', previous=self.old.name)
        with patch.object(deploy, 'run') as command:
            deploy.recover(self.job)
            command.assert_not_called()
        self.assertEqual(deploy.read_status(self.job)['phase'], 'failed')

    def test_recovery_retries_an_interrupted_rollback(self):
        new = self.root / 'releases/ci-123-1'
        new.mkdir()
        deploy.point_to(new)
        deploy.state(self.job, 'failed', rollback='failed', previous=self.old.name)
        with patch.object(deploy, 'run') as command, patch.object(deploy, 'wait_healthy'):
            deploy.recover(self.job)
            self.assertIn(['/usr/bin/systemctl', 'restart', deploy.SERVICE], [c[0][0] for c in command.call_args_list])
        self.assertEqual((self.root / 'current').resolve(), self.old)
        self.assertEqual(deploy.read_status(self.job)['rollback'], 'succeeded')

    def test_ssh_cannot_request_root_busy_probe(self):
        with patch.object(deploy.sys, 'argv', ['sel-ci-deploy', '--busy']), \
                patch.object(deploy.os, 'geteuid', return_value=0), \
                patch.object(deploy, 'busy_count') as probe:
            with self.assertRaises(SystemExit):
                deploy.main()
            probe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
