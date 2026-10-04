"""Independent Python LF/hash cross-check of the two confirmed Claude usage discrepancies.
Only hashes, counters, timestamps and fixed field names are written. No raw IDs/paths/content.
"""
import pathlib,os,json,hashlib
h=pathlib.Path.home()
baseline=pathlib.Path('.lane/claude-oracle-v2-readline.json')
if not baseline.exists():baseline=pathlib.Path('.lane/claude-oracle.json')
old=json.loads(baseline.read_text())
wanted={f['fileKey']:(s['sessionKey'],f) for s in old['sessions'] if s['sessionKey'] in ['a813ba9378f1','f4a96af58145'] for f in s['fileSums']}
differences=[];changed=[];done=set();read_errors=0
roots=[p/'projects' for p in h.iterdir() if p.name=='.claude' or p.name.startswith('.claude-')]+[h/'.config/claude/projects',h/'Library/Application Support/Claude/local-agent-mode-sessions']
if os.environ.get('CLAUDE_CONFIG_DIR'):roots.append(pathlib.Path(os.environ['CLAUDE_CONFIG_DIR'])/'projects')
for root in roots:
 for directory,dirs,files in os.walk(root):
  for name in files:
   p=pathlib.Path(directory)/name;key=hashlib.sha256(str(p).encode()).hexdigest()[:12]
   if key not in wanted or key in done:continue
   done.add(key);m={};valid=0;bad=0;digest=hashlib.sha256()
   try:
    # Binary iteration splits only LF and preserves exact bytes for the hash.
    with p.open('rb') as stream:
     for line in stream:
      digest.update(line)
      if not line.strip():continue
      try:r=json.loads(line)
      except Exception:bad+=1;continue
      valid+=1
      if not isinstance(r,dict)or r.get('type')!='assistant' or not (r.get('message')or{}).get('usage'):continue
      msg=r['message'];u=msg['usage'];cache=u.get('cache_creation')or{}
      input_tokens=u.get('input_tokens',0)+u.get('cache_read_input_tokens',0)+max(u.get('cache_creation_input_tokens',0),cache.get('ephemeral_5m_input_tokens',0)+cache.get('ephemeral_1h_input_tokens',0))
      current={'input':input_tokens,'output':u.get('output_tokens',0),'reasoning':(u.get('output_tokens_details')or{}).get('thinking_tokens',0)}
      identity=msg.get('id',key+':'+str(valid));prior=m.get(identity)
      if prior is None or (current['output'],current['input'])>(prior['output'],prior['input']):m[identity]=current
   except OSError:read_errors+=1;continue
   prior=wanted[key][1];new_hash=digest.hexdigest()[:24]
   if new_hash!=prior['contentHash']:changed.append({'fileKey':key,'oldHash':prior['contentHash'],'newHash':new_hash})
   tok={k:sum(v[k] for v in m.values())for k in ['input','output','reasoning']}
   delta={'input':tok['input']-prior['tokens']['inputTokens'],'output':tok['output']-prior['tokens']['outputTokens'],'reasoning':tok['reasoning']-prior['tokens']['reasoningOutputTokens']}
   if any(delta.values())or valid!=prior['records']:differences.append({'fileKey':key,'sessionKey':wanted[key][0],'subagent':prior['subagent'],'oldRecords':prior['records'],'lfRecords':valid,'lfMalformed':bad,'oldMessages':prior['uniqueMessages'],'lfMessages':len(m),'delta':delta})
result={'baselineArtifact':str(baseline),'matchedFiles':len(done),'expectedFiles':len(wanted),'readErrors':read_errors,'contentHashChanges':changed,'differences':differences}
pathlib.Path('.lane/claude-framing-crosscheck.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'matchedFiles':len(done),'expectedFiles':len(wanted),'readErrors':read_errors,'contentHashChanges':len(changed),'changedProjections':len(differences)}))
