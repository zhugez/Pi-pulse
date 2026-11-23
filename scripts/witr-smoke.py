import json
import os
from pathlib import Path
import pwd
import select
import subprocess
import sys
from uuid import uuid4

if len(sys.argv) == 1:
    ancestor_marker = f'witr-smoke-ancestor-{uuid4().hex}'
    os.execve(sys.executable, [sys.executable, __file__, ancestor_marker],
              {**os.environ, 'WITR_SMOKE_MARKER': ancestor_marker})

ancestor_marker = sys.argv[1]
child_marker = f'witr-smoke-child-{uuid4().hex}'
uid = os.geteuid()
owners = {str(uid)}
try:
    owners.add(pwd.getpwuid(uid).pw_name)
except KeyError:
    pass
skill = Path(__file__).resolve().parents[1] / 'skills/witr/SKILL.md'
example = skill.read_text().split('```bash\n', 1)[1].split('```', 1)[0]
listener = '''
import socket
import sys
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    print(sock.getsockname()[1], flush=True)
    sys.stdin.read()
'''


def run_example(target='--port 3000', setup=''):
    return subprocess.run(
        ['bash', '-eu', '-o', 'pipefail', '-c', setup + example.replace('--port 3000', target)],
        capture_output=True, text=True, timeout=5,
    )


def read_report(result):
    assert result.returncode == 0 and not result.stderr
    report, status = result.stdout.rsplit('\nwitr exit: ', 1)
    return json.loads(report), int(status)


with subprocess.Popen(
    [sys.executable, '-c', listener, child_marker],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    env={**os.environ, 'WITR_SMOKE_MARKER': child_marker},
) as child:
    try:
        assert select.select([child.stdout], [], [], 5)[0], 'listener did not report its port'
        port = int(child.stdout.readline())
        raw = subprocess.run(['witr', '--json', '--port', str(port)], capture_output=True, text=True, timeout=5)
        assert raw.returncode in (0, 1, 6)
        payload = json.loads(raw.stdout)
        ancestor = next(entry for entry in payload['Ancestry'] if entry['PID'] == os.getpid())
        for entry, marker in [(payload['Process'], child_marker), (ancestor, ancestor_marker)]:
            assert marker in json.dumps(entry['Cmdline']) and marker in json.dumps(entry['Env'])

        for target in (f'--port {port}', f'--pid {child.pid}'):
            result = run_example(target)
            assert all(marker not in result.stdout + result.stderr for marker in (ancestor_marker, child_marker))
            report, status = read_report(result)
            assert status in (0, 1, 6)
            assert set(report) == {'process', 'ancestry', 'source', 'matches'}
            assert set(report['process']) == {'PID', 'Command', 'User'}
            assert report['process']['PID'] == child.pid and report['process']['User'] in owners
            assert all(set(entry) == {'PID', 'Command'} for entry in report['ancestry'])
            assert {os.getpid(), child.pid} <= {entry['PID'] for entry in report['ancestry']}
            assert report['source'] is None or set(report['source']) == {'Type', 'Name'}
            assert report['matches'] == []
    finally:
        child.stdin.close()

report, status = read_report(run_example(setup='''
witr() {
    printf '%s\\n' '{"Target":{"Type":"port","Value":"3000"},"Error":"ambiguous target","Matches":[{"PID":42,"Command":"test","Cmdline":"test first-secret"},{"PID":43,"Command":"test","Cmdline":"test second-secret"}]}'
    return 4
}
'''))
assert status == 4 and report == {
    'process': None, 'ancestry': [], 'source': None,
    'matches': [{'PID': 42, 'Command': 'test'}, {'PID': 43, 'Command': 'test'}],
}

for payload in ('', '"not a report"', 'malformed secret', '{}',
                '{"Process":{"Command":{"Env":["secret"]}}}',
                '{"Process":{},"Ancestry":[{"PID":["secret"]}]}',
                '{"Process":{},"Source":{"Name":{"Cmdline":["secret"]}}}',
                '{"Matches":[{"Command":["secret"]}]}',
                '{"Process":{},"Ancestry":{"Env":{"Command":"secret"}}}',
                '{"Process":{},"Matches":{"Env":{"Command":"secret"}}}'):
    result = run_example(setup=f"witr() {{ printf '%s' '{payload}'; printf 'private stderr' >&2; }}\n")
    assert result.returncode != 0 and not result.stdout
    assert result.stderr == 'Cannot produce a safe witr report (witr exit: 0).\n'

result = run_example(setup='''
witr() { printf '%s\\n' '{"Process":{"PID":42}}'; }
jq() { read -r input; printf '%s\\n' 'partial output'; return 2; }
''')
assert result.returncode != 0 and not result.stdout
assert result.stderr == 'Cannot produce a safe witr report (witr exit: 0).\n'

result = run_example(setup="PATH=''\nwitr() { return 0; }\n")
assert result.returncode != 0 and not result.stdout
assert result.stderr == 'Cannot produce a safe witr report: witr and jq are required.\n'

print('witr smoke test passed')
