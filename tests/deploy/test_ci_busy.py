"""Synthetic idle-probe checks: material jobs count as busy (P0-13). No student data, no root."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / 'deploy/ci/sel-ci-deploy.py'
spec = importlib.util.spec_from_file_location('deploy_busy', str(SOURCE))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class BusyProbe(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name).resolve() / 'data'
        p = patch.object(deploy, 'DATA', self.data)
        p.start()
        self.addCleanup(p.stop)

    def student_db(self, name, jobs):
        folder = self.data / 'students' / name
        folder.mkdir(parents=True)
        db = sqlite3.connect(str(folder / 'app.db'))
        db.execute("CREATE TABLE material_job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, "
                   "updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        for index, (state, age_minutes) in enumerate(jobs):
            db.execute("INSERT INTO material_job (id, kind, state, updated_at) VALUES (?, 'extract', ?, datetime('now', ?))",
                       ('job-%d' % index, state, '-%d minutes' % age_minutes))
        db.commit()
        db.close()

    def test_idle_when_no_material_jobs_are_active(self):
        self.student_db('a', [('succeeded', 1), ('failed', 1), ('interrupted', 1), ('stale', 1)])
        self.assertEqual(deploy.busy_count(), 0)

    def test_recent_queued_and_running_material_jobs_are_busy(self):
        self.student_db('a', [('queued', 1), ('running', 0), ('succeeded', 0)])
        self.student_db('b', [('queued', 5)])
        self.assertEqual(deploy.busy_count(), 3)

    def test_dormant_leftover_job_does_not_block_forever(self):
        old = deploy.MATERIAL_BUSY_WINDOW_MINUTES + 30
        self.student_db('a', [('queued', old), ('running', old)])
        self.assertEqual(deploy.busy_count(), 0)

    def test_database_without_material_table_still_probes(self):
        folder = self.data / 'students' / 'legacy'
        folder.mkdir(parents=True)
        sqlite3.connect(str(folder / 'app.db')).close()
        self.assertEqual(deploy.busy_count(), 0)


if __name__ == '__main__':
    unittest.main()
