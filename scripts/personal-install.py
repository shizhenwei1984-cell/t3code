"""Activate a staged Linux personal desktop and verify its backend before committing the switch."""
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


def run(*args):
    subprocess.run(args, check=True)


def link(path, target):
    temp = path.with_name(path.name + ".next")
    temp.unlink(missing_ok=True)
    temp.symlink_to(target)
    os.replace(temp, path)


def copy_tree(source, destination):
    run("cp", "-a", "--reflink=auto", "--", source, destination)


class Desktop:
    unit = "t3-personal-managed.service"

    def __init__(self, profile):
        self.profile = profile
        self.runtime = profile / "userdata/server-runtime.json"

    def status(self):
        try:
            data = json.loads(self.runtime.read_text())
            proc = Path("/proc") / str(int(data["pid"]))
            return data, proc, (proc / "exe").resolve(strict=True)
        except (FileNotFoundError, ValueError, KeyError):
            return None

    def stop(self, release, check_busy=True):
        status = self.status()
        unit = self.unit
        if status:
            _, proc, exe = status
            if exe != (release / "t3code").resolve():
                raise RuntimeError("Personal runtime reports a different executable. Close the personal desktop first.")
            unit = (proc / "cgroup").read_text().splitlines()[-1].rsplit("/", 1)[-1]
            if not re.fullmatch(r"(?:app-[\w.\\-]+\.scope|t3-personal-[\w-]+\.service)", unit):
                raise RuntimeError("Close the personal desktop before updating its unmanaged process.")
        if check_busy:
            db = self.profile / "userdata/statev2.sqlite"
            with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as conn:
                busy = conn.execute("""select count(*) from orchestration_v2_projection_runs
                    where status in ('preparing','queued','starting','running','waiting')""").fetchone()[0]
            if busy:
                raise RuntimeError(f"{busy} active turns. Finish them before updating.")
        if subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit]).returncode == 0:
            run("systemctl", "--user", "stop", unit)
        if self.status() or (self.profile / "config/t3code-v2/SingletonLock").exists():
            raise RuntimeError("Personal desktop still open. Close it and retry.")

    def start(self, release):
        run("systemd-run", "--user", "--collect", "--unit=" + self.unit,
            str(Path.home() / ".local/bin/t3code-personal"))
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            status = self.status()
            if status:
                data, _, exe = status
                if exe == (release / "t3code").resolve():
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{int(data['port'])}/", timeout=2) as res:
                            if res.status == 200 and b"<html" in res.read(4096).lower():
                                print("Healthy:", data["serverVersion"], release, flush=True)
                                return
                    except OSError:
                        pass
            time.sleep(0.5)
        raise RuntimeError("Personal desktop failed its 60-second HTTP readiness check.")


def restore(current, profile, backup, runtime, check_busy):
    old = (backup / "release").resolve(strict=True)
    # Prepare the replacement before touching the current profile.
    staging = Path(tempfile.mkdtemp(prefix="restore-", dir=backup.parent))
    copy_tree(backup / "profile", staging / "profile")
    runtime.stop(current.resolve(strict=True), check_busy=check_busy)
    if profile.exists():
        profile.rename(staging / "displaced-profile")
    (staging / "profile").rename(profile)
    link(current, old)
    runtime.start(old)
    print("Restored previous release. Displaced profile retained at", staging, flush=True)


def activate(current, new, profile, backups, runtime):
    old = current.resolve(strict=True)
    backup = Path(tempfile.mkdtemp(prefix="update-", dir=backups))
    runtime.stop(old)
    try:
        copy_tree(profile, backup / "profile")
        (backup / "release").symlink_to(old)
        link(backups / "pending", backup)
    except BaseException:
        runtime.start(old)
        raise
    try:
        link(current, new)
        runtime.start(new)
        link(backups / "previous", backup)
    except BaseException:
        restore(current, profile, backup, runtime, check_busy=False)
        (backups / "pending").unlink()
        raise
    (backups / "pending").unlink()
    print("Rollback snapshot:", backup, flush=True)
    return backup


if __name__ == "__main__":
    home = Path.home()
    current = home / ".local/opt/t3code-personal-current"
    profile = home / ".local/share/t3code-personal"
    backups = home / ".local/state/t3code-personal-updates"
    backups.mkdir(parents=True, exist_ok=True, mode=0o700)
    runtime = Desktop(profile)
    pending = backups / "pending"
    if pending.exists():
        restore(current, profile, pending.resolve(strict=True), runtime, check_busy=True)
        pending.unlink()
        print("Recovered interrupted update. Run the update again to install.")
        sys.exit(1)
    if sys.argv[1] == "--recover":
        sys.exit(0)
    if sys.argv[1] == "--rollback":
        restore(current, profile, (backups / "previous").resolve(strict=True), runtime, check_busy=True)
    else:
        activate(current, Path(sys.argv[1]).resolve(strict=True), profile, backups, runtime)
