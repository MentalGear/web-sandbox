"""Review 3: a mitigation reverted, its named test run, the source restored.

usage (from the worktree's root): python3 docs/design/review-3/mutate.py NAME FILE OLD NEW TEST...

OLD must occur exactly once in FILE. The file is restored from its own text whatever the run does, so the
checkout is left as it was. Prints the vitest exit code and its summary line; the log goes to
docs/design/review-3/mutations/NAME.log.
"""
import os
import subprocess
import sys

name, path, old, new, *tests = sys.argv[1:]
text = open(path).read()
if text.count(old) != 1:
    sys.exit(f"{name}: OLD occurs {text.count(old)} times in {path}")
os.makedirs('docs/design/review-3/mutations', exist_ok=True)
log = f'docs/design/review-3/mutations/{name}.log'
try:
    open(path, 'w').write(text.replace(old, new))
    with open(log, 'w') as out:
        rc = subprocess.run(['timeout', '400', 'bunx', 'vitest', 'run', *tests], stdout=out, stderr=subprocess.STDOUT).returncode
finally:
    open(path, 'w').write(text)
summary = [line for line in open(log, errors='replace') if 'Tests ' in line and ('passed' in line or 'failed' in line)]
print(f"{name}: exit {rc}; {summary[-1].strip() if summary else 'no summary'}")
