"""Run proposals in a disposable copy, leaving checkout src unchanged."""
from pathlib import Path
import shutil,subprocess,re,json,sys
root=Path.cwd();stage=root/'.lane/claude-patch-check';stage.mkdir(exist_ok=True)
for name in ['data','schemas']:
    shutil.copytree(root/name,stage/name,dirs_exist_ok=True)
for name in ['package.json','tsconfig.json']:
    shutil.copy2(root/name,stage/name)
(stage/'test/validation').mkdir(parents=True,exist_ok=True)
shutil.copy2(root/'test/validation/dedup-claude-identity.test.ts',stage/'test/validation/dedup-claude-identity.test.ts')
report_path=root/'.lane/claude-proposal-checks.json'
previous=json.loads(report_path.read_text()) if report_path.exists() else []
results=[]
for number in ([int(sys.argv[1])] if len(sys.argv)>1 else range(1,5)):
    bug=f'DEDUP-CL-{number:02}'
    shutil.copytree(root/'src',stage/'src',dirs_exist_ok=True)
    dry=subprocess.run(['patch','--dry-run','-p1','-i',str(root/'.lane/fixes'/f'{bug}.patch')],cwd=stage,capture_output=True,text=True)
    apply=subprocess.run(['patch','-p1','-i',str(root/'.lane/fixes'/f'{bug}.patch')],cwd=stage,capture_output=True,text=True)
    check=subprocess.run([str(root/'node_modules/.bin/tsc'),'--noEmit'],cwd=stage,capture_output=True,text=True)
    tests=subprocess.run(['node','--test',f'--test-name-pattern={bug}', 'test/validation/dedup-claude-identity.test.ts'],cwd=stage,capture_output=True,text=True)
    log='APPLY CHECK\n'+dry.stdout+dry.stderr+'TYPECHECK\n'+check.stdout+check.stderr+'TEST\n'+tests.stdout+tests.stderr
    log=log.replace(str(root),'<checkout>')
    (root/'.lane'/f'{bug}-proposal-check.txt').write_text(log)
    results.append({'bug':bug,'apply':dry.returncode,'typecheck':check.returncode,'test':tests.returncode})
    print(json.dumps(results[-1]),flush=True)
merged={r['bug']:r for r in previous}
merged.update({r['bug']:r for r in results})
report_path.write_text(json.dumps([merged[k] for k in sorted(merged)],indent=2)+'\n')
