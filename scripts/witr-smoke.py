import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

skill = Path(__file__).resolve().parents[1] / 'skills/witr/SKILL.md'
example = skill.read_text().split('```bash\n', 1)[1].split('```', 1)[0]
marker = f'witr-smoke-{uuid4().hex}'

with subprocess.Popen(
    [sys.executable, '-c', 'import time; time.sleep(15)', marker],
    env={**os.environ, 'WITR_SMOKE_MARKER': marker},
) as child:
    try:
        target = f'--pid {child.pid}'
        raw = subprocess.run(['witr', '--pid', str(child.pid), '--json'], capture_output=True, text=True, timeout=5)
        assert raw.returncode in (0, 1)
        process = json.loads(raw.stdout)['Process']
        assert marker in json.dumps(process['Env']) and marker in json.dumps(process['Cmdline'])
        result = subprocess.run(['bash', '-c', example.replace('--port 3000', target)], capture_output=True, text=True, check=True, timeout=5)
        assert marker not in result.stdout + result.stderr
        report, status = result.stdout.rsplit('\nwitr exit: ', 1)
        assert status.strip() in ('0', '1') and json.loads(report)['process']['PID'] == child.pid
    finally:
        child.terminate()

print('witr smoke test passed')
