#!/usr/bin/env python3
"""Apply reviewable patches to a temporary copy. Never modifies repository src/."""
from pathlib import Path
import tempfile, shutil, subprocess, sys
base=Path(__file__).resolve().parents[2]
patches=sys.argv[1:] or ['CODEX-02','CODEX-04','CODEX-05']
with tempfile.TemporaryDirectory(prefix='codex-validation-patches-') as temporary:
    target=Path(temporary)
    for name in ['src','test','data','schemas']:
        shutil.copytree(base/name,target/name)
    shutil.copy(base/'package.json',target/'package.json')
    with (base/'.lane/codex-proposed-patches-tests.log').open('w') as log:
        for name in patches:
            applied=subprocess.run(['patch','-p1','-i',str(base/'.lane/fixes'/f'{name}.patch')],cwd=target,stdout=log,stderr=subprocess.STDOUT)
            if applied.returncode:
                print(f'{name}: patch application failed; see sanitized test log')
                sys.exit(applied.returncode)
        tests=['test/validation/codex-broadcast.test.ts','test/validation/codex-replay.test.ts']
        result=subprocess.run(['node','--test',*tests],cwd=target,stdout=log,stderr=subprocess.STDOUT)
        print(f'Proposed patches: test exit {result.returncode}')
        sys.exit(result.returncode)
