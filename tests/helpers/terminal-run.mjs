// Drive the real terminal through a PTY. Each comma-separated key batch is sent separately.
export const terminalRun = `
import json, os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
keys = sys.argv[1].split(',')
sent = 0
raw_at = None
last_sent = None
output = bytearray()
deadline = time.monotonic() + 8
try:
    while child.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], 0.05)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break
        now = time.monotonic()
        raw = not (termios.tcgetattr(master)[3] & termios.ICANON)
        if raw and raw_at is None:
            raw_at = now
        if sent < len(keys) and raw_at is not None and now - (last_sent or raw_at) > 0.4:
            os.write(master, bytes.fromhex(keys[sent]))
            sent += 1
            last_sent = now
    try:
        code = child.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        code = None
    restored = bool(termios.tcgetattr(master)[3] & termios.ICANON)
    if code != 0:
        sys.stderr.write(output.decode('utf-8', errors='replace'))
    print(json.dumps({"sent": sent == len(keys), "code": code, "restored": restored}))
finally:
    if child.poll() is None:
        child.kill()
    child.wait()
    os.close(master)
`;
