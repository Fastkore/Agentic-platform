"""Isolate FreeCAD and generated modelling scripts from the service and other requests."""
import os
from pathlib import Path
import stat
import subprocess
import tempfile

APP = Path(__file__).resolve().parent
LIMIT = 20 * 1024 * 1024


def run(folder, script, *args):
    command = [
        "/usr/bin/prlimit", "--fsize=" + str(LIMIT), "--cpu=45", "--",
        "/usr/local/bin/bwrap", "--unshare-all", "--unshare-user", "--die-with-parent",
        "--new-session", "--cap-drop", "ALL", "--clearenv",
        "--ro-bind", "/usr", "/usr", "--ro-bind", str(APP), "/opt/freecad-worker",
        "--ro-bind", "/etc/passwd", "/etc/passwd", "--ro-bind", "/etc/group", "/etc/group",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--bind", str(folder), "/work", "--chdir", "/work",
        "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "PYTHONPATH", "/usr/lib/freecad-python3/lib",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "PYTHONDONTWRITEBYTECODE", "1",
        "--", "/usr/bin/python3", "/opt/freecad-worker/" + script, *args,
    ]
    with tempfile.TemporaryFile() as log:
        proc = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log, timeout=50)
        if proc.returncode:
            log.seek(max(0, log.tell()-2400))
            raise ValueError(log.read().decode("utf8","replace").strip()[-2400:] or "FreeCAD process failed")


def result(folder, name, limit=LIMIT):
    fd = os.open(folder / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= limit:
            raise ValueError("Invalid output " + name)
        return f.read(limit+1)
