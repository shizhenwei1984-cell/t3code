"""Exercise release activation and full profile rollback without touching an installed app."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("install", Path(__file__).resolve().parents[1] / "personal-install.py")
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)


class ActivationTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.profile = root / "profile"
        self.profile.mkdir()
        (self.profile / "session").write_text("history")
        self.old, self.new = root / "old", root / "new"
        self.old.mkdir()
        self.new.mkdir()
        self.current = root / "current"
        self.current.symlink_to(self.old)
        self.backups = root / "backups"
        self.backups.mkdir()
        self.runtime = Mock()

    def activate(self):
        return install.activate(self.current, self.new, self.profile, self.backups, self.runtime)

    def test_success_keeps_profile_and_previous_release(self):
        backup = self.activate()
        self.assertEqual(self.current.resolve(), self.new)
        self.assertEqual((self.profile / "session").read_text(), "history")
        self.assertEqual((backup / "profile/session").read_text(), "history")
        self.assertEqual((backup / "release").resolve(), self.old)
        self.runtime.start.assert_called_once_with(self.new)

    def test_failed_health_restores_data_after_migration(self):
        def start(release):
            if release == self.new:
                (self.profile / "session").write_text("migrated")
                raise RuntimeError("unhealthy")
        self.runtime.start.side_effect = start
        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            self.activate()
        self.assertEqual(self.current.resolve(), self.old)
        self.assertEqual((self.profile / "session").read_text(), "history")
        self.assertEqual(self.runtime.start.call_args.args, (self.old,))

    def test_manual_rollback_keeps_sessions_created_after_update(self):
        backup = self.activate()
        (self.profile / "session").write_text("new session")
        install.restore(self.current, self.profile, backup, self.runtime, check_busy=True)
        self.assertEqual((self.profile / "session").read_text(), "history")
        displaced, = self.backups.glob("restore-*/displaced-profile/session")
        self.assertEqual(displaced.read_text(), "new session")

    def test_never_stops_an_unrelated_desktop_or_terminal_scope(self):
        self.assertTrue(install.personal_unit("app-com.t3tools.T3Code-123.scope"))
        self.assertTrue(install.personal_unit("t3-personal-managed.service"))
        self.assertFalse(install.personal_unit("app-org.gnome.Terminal-123.scope"))
        self.assertFalse(install.personal_unit("app-com.openai.Codex-123.scope"))

    def test_busy_app_is_left_alone(self):
        self.runtime.stop.side_effect = RuntimeError("busy")
        with self.assertRaisesRegex(RuntimeError, "busy"):
            self.activate()
        self.assertEqual(self.current.resolve(), self.old)
        self.runtime.start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
