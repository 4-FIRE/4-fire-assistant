"""Create or verify the current user's shared ffa virtual environment."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import venv

REQUIREMENTS = Path(__file__).resolve().parent.parent / "python" / "requirements.lock"
INSPECT = """
import importlib.metadata as m, json, sys
print(json.dumps({
    "prefix": sys.prefix, "basePrefix": sys.base_prefix,
    "version": list(sys.version_info[:3]),
    "packages": {d.metadata["Name"]: d.version for d in m.distributions()}
}))
"""


def directory():
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/ffa/python/.venv"
    data = os.environ.get("XDG_DATA_HOME", "")
    root = Path(data) if os.path.isabs(data) else Path.home() / ".local/share"
    return root / "ffa/python/.venv"


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def locked_packages():
    result = {}
    for line in REQUIREMENTS.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line)
        if not match:
            raise ValueError("requirements.lock 必须逐行使用 name==version。")
        name, version = match.groups()
        key = normalize(name)
        if key in result:
            raise ValueError("requirements.lock 存在重复依赖。")
        result[key] = version
    if not result:
        raise ValueError("requirements.lock 不能为空。")
    return result


def inspect_environment(target):
    if target.is_symlink():
        raise ValueError("共享环境目录不能是符号链接。")
    if not target.exists():
        return None
    config = target / "pyvenv.cfg"
    if not target.is_dir() or not config.is_file() or config.is_symlink():
        raise ValueError("共享环境位置已被非 venv 数据占用；不会覆盖或删除。")
    if re.search(r"include-system-site-packages\s*=\s*true", config.read_text(), re.I):
        raise ValueError("共享 venv 不能继承系统 site-packages。")
    info = json.loads(subprocess.check_output([str(target / "bin/python"), "-I", "-B", "-c", INSPECT], text=True))
    if Path(info["prefix"]).resolve() != target.resolve() or info["prefix"] == info["basePrefix"]:
        raise ValueError("解释器不属于共享 venv；不会修改其他 Python 环境。")
    if info["version"][:2] < [3, 11]:
        raise ValueError("共享环境需要 Python 3.11+；不会自动替换其基础解释器。")
    info["packages"] = {normalize(name): version for name, version in info["packages"].items()}
    return info


def plan(target):
    required = locked_packages()
    current = inspect_environment(target)
    installed = (current or {}).get("packages", {})
    return {
        "directory": str(target), "python": str(target / "bin/python"),
        "current": current, "required": required,
        "changes": [{"package": name, "from": installed.get(name), "to": version}
                    for name, version in required.items() if installed.get(name) != version],
    }


def setup(target):
    target.parent.mkdir(parents=True, exist_ok=True)
    # Never unlink this file: concurrent installers must lock the same inode.
    fd = os.open(str(target) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("共享环境锁必须是普通文件。")
        # Concurrent startups wait, then inspect again rather than apply stale plans.
        fcntl.flock(fd, fcntl.LOCK_EX)
        actual = plan(target)
        if actual["current"] is None:
            venv.EnvBuilder(with_pip=True).create(target)
        python = str(target / "bin/python")

        def run(args):
            subprocess.run([python, "-I", "-B", *args], check=True, pass_fds=(fd,),
                           stdout=sys.stderr, env={**os.environ, "PIP_CONFIG_FILE": os.devnull})

        current = inspect_environment(target)
        if "pip" not in current["packages"]:
            run(["-m", "ensurepip"])
        pip = ["-m", "pip", "--isolated", "--disable-pip-version-check"]
        if actual["changes"]:
            with tempfile.TemporaryDirectory(prefix="ffa-python-") as temp:
                locked = Path(temp) / "requirements.txt"
                locked.write_text("".join(name + "==" + version + "\n" for name, version in actual["required"].items()))
                run([*pip, "download", "--only-binary=:all:", "--no-deps", "-r", str(locked), "--dest", temp])
                run([*pip, "install", "--no-index", "--find-links", temp, "--no-deps", "-r", str(locked)])
        run([*pip, "check"])
        verified = inspect_environment(target)
        if any(verified["packages"].get(name) != version for name, version in actual["required"].items()):
            raise RuntimeError("安装后版本检查未通过。")
        run(["-c", "import matplotlib; matplotlib.use('Agg'); "
             "import numpy, pandas, talib, backtesting, scipy, statsmodels.api, "
             "matplotlib.pyplot, sklearn, pyarrow, openpyxl, seaborn; "
             "assert talib.SMA(numpy.arange(1., 6.), 3)[-1] == 4."])
        return {"directory": str(target), "python": python, "packages": verified["packages"]}
    finally:
        os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查共享环境，不创建或安装")
    args = parser.parse_args()
    if sys.platform not in ("linux", "darwin") or sys.version_info < (3, 11):
        raise RuntimeError("需要 Linux/macOS 和 Python 3.11+。")
    target = directory()
    print(json.dumps(plan(target) if args.check else setup(target), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(str(error), file=sys.stderr)
        print("共享 Python 环境未就绪。请检查 Python 3.11+、venv/ensurepip、网络、安装权限和 wheel；修复后执行 /ffa python setup 或重启。不会删除现有环境、改用系统环境安装或编译 C 库。", file=sys.stderr)
        sys.exit(1)
