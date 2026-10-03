#!/usr/bin/env python3
"""Bounded, content-free research audit. Stdout contains aggregate JSON only.

No transcript bytes, identifiers, paths, arbitrary error strings or arbitrary enums
are emitted. Local identifiers only join/deduplicate evidence in process memory.
The sampled file list is never persisted. This is a research artifact, not runtime
product code. Python stdlib only. Run --self-test before auditing a local history.
"""
import argparse
import collections
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile

MAX_FILE = 32 * 1024 * 1024
MAX_LINE = 8 * 1024 * 1024
SALT = b'session-analytics-research-audit-v1\0'
TOOLS = set('''Agent Task Bash Read Write Edit MultiEdit Glob Grep LS NotebookEdit NotebookRead WebFetch WebSearch TodoWrite TodoRead Skill ToolSearch AskUserQuestion ExitPlanMode EnterPlanMode TaskCreate TaskUpdate TaskGet TaskList TaskOutput TaskStop ListMcpResources ReadMcpResource LSP SendMessage TeamCreate TeamDelete WorktreeCreate WorktreeRemove EnterWorktree ExitWorktree Schedule CronCreate CronDelete CronList RemoteTrigger Sleep exec wait sleep exec_command write_stdin apply_patch read_file list_dir shell shell_command update_plan request_user_input spawn_agent send_input wait_agent close_agent resume_agent report_agent_job_result spawn_agents_on_csv search_query open click find screenshot image_query view_image python python_user_visible run_terminal_cmd run_terminal_command grep_search file_search codebase_search edit_file delete_file read_lints run_linter get_terminal_output run_terminal_output fetch_pull_request mcp list_mcp_resources list_mcp_resource_templates read_mcp_resource multi_tool_use parallel run Terminal Shell StrReplace Delete SemanticSearch FetchMcpResource ListMcpResources EditNotebook GenerateImage create_goal get_goal update_goal yield_control notify text image collaboration_spawn_agent collaboration_send_message collaboration_wait_agent collaboration_followup_task collaboration_interrupt_agent collaboration_list_agents'''.split())
TOOL_NAMESPACES = {'functions','tools','collaboration','web','clock','python','container','multi_tool_use'}
EFFORTS = {'none','minimal','low','medium','high','xhigh','max','ultra','auto'}
CACHE_REASONS = {'previous_message_not_found','messages_changed','tools_changed','system_changed','model_changed'}
PERMISSIONS = {'default','auto','bypassPermissions','plan','acceptEdits','dontAsk','ask','never','on-request','on-failure','untrusted','always'}
GIT_OPS = {'commit','push','pr created','pr merged','pr_create','pr_merge','pull','checkout','branch','rebase','merge'}
SOURCE_ENUMS = {'cli','exec','vscode','review','subagent','sdk','app-server'}
ATTACHMENTS = {'hook_success','hook_error','hook_stopped_continuation','hook_additional_context','deferred_tools_delta','failedMcpServers','skill_listing','invoked_skills','environment','hook_non_blocking_error','hook_cancelled','hook_skipped'}

def rec(x): return x if isinstance(x,dict) else {}
def seq(x): return x if isinstance(x,list) else []
def numeric(x): return isinstance(x,(int,float)) and not isinstance(x,bool) and math.isfinite(x)
def enum(x,allowed): return x if isinstance(x,str) and x in allowed else 'other'
def tool(x):
    if not isinstance(x,str): return 'unknown'
    if x in TOOLS: return x
    bits=x.split('.')
    if len(bits)==2 and bits[0] in TOOL_NAMESPACES and bits[1] in TOOLS: return x
    # MCP/server names can identify installations. Research uses category only.
    if x.startswith(('mcp__','mcp_')) or '__mcp__' in x: return 'mcp_tool_name_redacted'
    return 'other_tool_name_redacted'

def identity(value,fallback): return value if isinstance(value,str) and value else fallback

def percent(n,d): return round(100*n/d,2) if d else None

def summary(values):
    a=sorted(x for x in values if numeric(x))
    if not a:return {'n':0}
    def q(p):
        pos=(len(a)-1)*p;i=int(pos);j=min(i+1,len(a)-1)
        return round(a[i]+(a[j]-a[i])*(pos-i),3)
    return {'n':len(a),'min':round(a[0],3),'p25':q(.25),'median':q(.5),'p75':q(.75),'p90':q(.9),'p95':q(.95),'max':round(a[-1],3)}

def coverage(n,d):return {'present':n,'eligible':d,'percent':percent(n,d)}

class Audit:
    def __init__(self,provider,include_content_rules=False):
        self.provider=provider
        self.include_content_rules=include_content_rules
        self.c=collections.Counter({k:0 for k in ('parse_failures','non_object_records','oversize_lines_skipped','read_errors','changed_during_read','duplicate_session_files_skipped','missing_tool_call_ids','missing_tool_result_ids')});self.fields=collections.Counter();self.filefields=collections.Counter()
        self.enums=collections.defaultdict(collections.Counter);self.dist=collections.defaultdict(list)
        self.calls={};self.results={};self.messages={};self.sessions=set();self.field_denoms={}
        self.strata=collections.defaultdict(collections.Counter);self.messagefields=set();self.toolcounts=collections.Counter();self.nestedtools=collections.Counter();self.rate_seen=set()
    def mark(self,key,condition,flags):
        self.fields.setdefault(key,0);self.filefields.setdefault(key,0)
        if condition:self.fields[key]+=1;flags.add(key)
    def call(self,key,name):
        if key in self.calls:self.c['duplicate_tool_calls']+=1;return
        self.calls[key]=tool(name);self.toolcounts[tool(name)]+=1
    def result(self,key,error,status_present,flags,details=None,source=None):
        if key in self.results:self.c['duplicate_tool_results']+=1;return
        self.results[key]={'error':error,'status_present':status_present,'source':source or ('explicit_boolean' if status_present else 'unknown')}
        if details:
            for k,v in details.items():
                if v: self.fields[k]+=1;flags.add(k)
    def parse(self,path):
        flags=set();counts=collections.Counter();subagent=False;initial_results=set(self.results);initial_calls=set(self.calls);before=None;session_recorded=False;compactions=collections.Counter();effort=None;rate_max={}
        try:
            before=path.stat()
            with path.open('rb') as f:
                self.c['files_read']+=1
                line_no=0
                while True:
                    raw=f.readline(MAX_LINE+1)
                    if not raw:break
                    line_no+=1;self.c['lines_read']+=1
                    if len(raw)>MAX_LINE:
                        self.c['oversize_lines_skipped']+=1
                        while raw and not raw.endswith(b'\n'):raw=f.readline(MAX_LINE+1)
                        continue
                    if not raw.strip():self.c['blank_lines']+=1;continue
                    try:r=json.loads(raw)
                    except (ValueError,UnicodeError):self.c['parse_failures']+=1;continue
                    if not isinstance(r,dict):self.c['non_object_records']+=1;continue
                    self.c['records']+=1
                    self.mark('timestamp',isinstance(r.get('timestamp'),str),flags)
                    counts['records']+=1
                    # Paths/IDs are in-memory join keys only. No interpolation into output.
                    fallback=(str(path),line_no)
                    if self.provider=='claude':
                        t=r.get('type');m=rec(r.get('message'));usage=rec(m.get('usage'));st=r.get('subtype')
                        subagent=subagent or 'subagents' in path.parts or r.get('isSidechain') is True
                        self.mark('cwd',isinstance(r.get('cwd'),str),flags)
                        self.mark('gitBranch',isinstance(r.get('gitBranch'),str),flags)
                        self.mark('agentId',isinstance(r.get('agentId'),str),flags)
                        self.mark('entrypoint',isinstance(r.get('entrypoint'),str),flags)
                        self.mark('permissionMode','permissionMode' in r,flags)
                        if 'permissionMode' in r:self.enums['permissionMode'][enum(r['permissionMode'],PERMISSIONS)]+=1
                        if 'toolDenialKind' in r:self.enums['toolDenialKind'][enum(r['toolDenialKind'],{'permission','user','auto','safety','rejected','denied','plan'})]+=1
                        if t=='assistant':
                            self.c['assistant_records']+=1
                            mid=identity(m.get('id'),identity(r.get('uuid'),fallback))
                            prev=self.messages.setdefault(mid,{'fields':set(),'effort':None,'cache_reason':None,'output':0,'thinking':None,'input':None,'cache_read':None,'cache_creation':None,'api_error':False})
                            features={'message.id':isinstance(m.get('id'),str),'requestId':isinstance(r.get('requestId'),str),'effort':'effort' in r,'usage':bool(usage),'usage.output_tokens_details.thinking_tokens':numeric(rec(usage.get('output_tokens_details')).get('thinking_tokens')),'usage.cache_read_input_tokens':numeric(usage.get('cache_read_input_tokens')),'usage.cache_creation':isinstance(usage.get('cache_creation'),dict),'usage.server_tool_use':isinstance(usage.get('server_tool_use'),dict),'usage.iterations':isinstance(usage.get('iterations'),list),'attributionSkill':'attributionSkill' in r,'attributionAgent':'attributionAgent' in r,'attributionMcpServer':'attributionMcpServer' in r,'attributionPlugin':'attributionPlugin' in r,'stop_reason':'stop_reason' in m,'stop_details':'stop_details' in m,'message.diagnostics.cache_miss_reason.type':isinstance(rec(rec(m.get('diagnostics')).get('cache_miss_reason')).get('type'),str),'quotaLimits':isinstance(r.get('quotaLimits'),dict)}
                            self.messagefields.update(features)
                            for k,v in features.items():
                                if v:prev['fields'].add(k);flags.add(k)
                            if 'effort' in r:prev['effort']=enum(r['effort'],EFFORTS);effort=prev['effort']
                            reason=rec(rec(m.get('diagnostics')).get('cache_miss_reason')).get('type')
                            if isinstance(reason,str):prev['cache_reason']=enum(reason,CACHE_REASONS)
                            out=usage.get('output_tokens')
                            if numeric(out) and out>=prev['output']:
                                prev['output']=out
                                for k,source in [('input','input_tokens'),('cache_read','cache_read_input_tokens'),('cache_creation','cache_creation_input_tokens')]:
                                    if numeric(usage.get(source)):prev[k]=usage[source]
                                thinking=rec(usage.get('output_tokens_details')).get('thinking_tokens')
                                if numeric(thinking):prev['thinking']=thinking
                            if r.get('isApiErrorMessage') is True:prev['api_error']=True
                            if 'apiErrorStatus' in r:self.enums['apiErrorStatus'][str(r['apiErrorStatus']) if r['apiErrorStatus'] in (400,401,403,404,408,409,429,500,502,503,504,529) else 'other']+=1
                            if 'error' in r:self.enums['assistant_error'][enum(r['error'],{'rate_limit','server_error','authentication_failed','invalid_request','overloaded_error'})]+=1
                            for block_index,b in enumerate(seq(m.get('content'))):
                                b=rec(b)
                                if b.get('type')=='thinking':self.c['thinking_blocks']+=1;flags.add('thinking_block')
                                if b.get('type')=='tool_use':self.call(identity(b.get('id'),(fallback,block_index)),b.get('name'));counts['tool_call_records']+=1;self.c['missing_tool_call_ids']+=not bool(b.get('id'))
                        elif t=='user':
                            self.c['user_records']+=1
                            for block_index,b in enumerate(seq(m.get('content'))):
                                b=rec(b)
                                if b.get('type')!='tool_result':continue
                                self.c['tool_result_records']+=1
                                rid=identity(b.get('tool_use_id'),(fallback,block_index));terr=b['is_error'] if isinstance(b.get('is_error'),bool) else None;self.c['missing_tool_result_ids']+=not bool(b.get('tool_use_id'))
                                self.result(rid,terr,isinstance(b.get('is_error'),bool),flags)
                            tr=rec(r.get('toolUseResult'))
                            if tr:
                                self.c['tool_use_result_records']+=1
                                for k in ('interrupted','timedOutAfterMs','returnCodeInterpretation','gitOperation','structuredPatch','userModified','numLines','totalLines','truncatedByTokenCap','status','resolvedModel','totalDurationMs','totalTokens','toolStats','code','durationMs','bytes','durationSeconds','type'):
                                    self.mark('toolUseResult.'+k,k in tr,flags)
                                if tr.get('interrupted') is True:self.c['bash_interrupted_true']+=1
                                if 'gitOperation' in tr:self.enums['gitOperation'][enum(tr['gitOperation'],GIT_OPS)]+=1
                                if 'status' in tr:self.enums['toolUseResult.status'][enum(tr['status'],{'completed','complete','success','error','failed','running','interrupted','async_launched','pending','timeout'})]+=1
                        elif t=='system':
                            self.c['system_records']+=1
                            if st=='compact_boundary':
                                compactions['boundary']+=1;cm=rec(r.get('compactMetadata'))
                                for k in ('trigger','preTokens','postTokens','durationMs'):self.mark('compactMetadata.'+k,k in cm,flags)
                                if 'trigger' in cm:self.enums['compaction_trigger'][enum(cm['trigger'],{'auto','manual'})]+=1
                                for k in ('preTokens','postTokens','durationMs'):
                                    if numeric(cm.get(k)):self.dist['compaction_'+k].append(cm[k])
                            elif st=='stop_hook_summary':
                                self.c['stop_hook_summary']+=1
                                for k in ('hookCount','hookInfos','hookErrors','preventedContinuation'):self.mark('hook.'+k,k in r,flags)
                                hc=r.get('hookCount')
                                if numeric(hc):self.dist['hookCount'].append(hc)
                                for info in seq(r.get('hookInfos')):
                                    dur=rec(info).get('durationMs')
                                    if numeric(dur):self.dist['hook_duration_ms'].append(dur)
                                if r.get('preventedContinuation') is True:self.c['hook_prevented_continuation']+=1
                                he=r.get('hookErrors')
                                if isinstance(he,list):self.c['hook_errors']+=len(he)
                            elif st=='api_error':
                                self.c['api_error_system']+=1
                                for k in ('retryAttempt','retryInMs'):self.mark('api_error.'+k,k in r,flags)
                        elif t=='cost-state':
                            self.c['cost_state']+=1
                            for k in ('totalCostUSD','totalLinesAdded','totalLinesRemoved','totalAPIDuration','totalToolDuration','totalDuration'):self.mark('cost_state.'+k,k in r,flags)
                        elif t=='pr-link':self.c['pr_link']+=1;flags.add('pr_link')
                        elif t=='queue-operation':
                            self.c['queue_operation']+=1;self.enums['queue_operation'][enum(r.get('operation'),{'enqueue','dequeue','remove'})]+=1
                        elif t=='attachment':
                            a=rec(r.get('attachment'));self.enums['attachment_type'][enum(a.get('type'),ATTACHMENTS)]+=1
                            for k in ('isGitRepo','isWorktree'):self.mark('attachment.environment.'+k,k in a,flags)
                    elif self.provider=='codex':
                        t=r.get('type');p=rec(r.get('payload'));pt=p.get('type')
                        if t=='session_meta':
                            self.c['session_meta_records']+=1
                            sid=p.get('id')
                            if not session_recorded and isinstance(sid,str):
                                if sid in self.sessions:self.c['duplicate_session_files_skipped']+=1;return
                                self.sessions.add(sid);session_recorded=True
                            src=p.get('source');subagent='subagent' in rec(src)
                            self.enums['source']['subagent' if subagent else enum(src,SOURCE_ENUMS)]+=1
                            self.mark('session_meta.git',bool(rec(p.get('git'))),flags)
                            for k in ('forked_from_id','agent_role','agent_nickname','cli_version','cwd'):self.mark('session_meta.'+k,k in p,flags)
                        elif t=='turn_context':
                            self.c['turn_context_records']+=1
                            for k in ('model','effort','approval_policy','sandbox_policy','collaboration_mode'):self.mark('turn_context.'+k,k in p,flags)
                            if 'effort' in p:
                                e=enum(p['effort'],EFFORTS);self.enums['effort_by_turn_context'][e]+=1;effort=e
                            if 'approval_policy' in p:self.enums['approval_policy'][enum(p['approval_policy'],PERMISSIONS)]+=1
                            mode=rec(p.get('collaboration_mode')).get('mode')
                            if isinstance(mode,str):self.enums['collaboration_mode'][enum(mode,{'plan','default','pair','execute'})]+=1
                        elif t=='compacted':compactions['top_level']+=1
                        elif t=='response_item':
                            if pt in ('function_call','custom_tool_call'):
                                cid=identity(p.get('call_id'),identity(p.get('id'),fallback));self.call(cid,p.get('name'));counts['tool_call_records']+=1
                                if self.include_content_rules and pt=='custom_tool_call' and isinstance(p.get('input'),str):
                                    for name in re.findall(r'\btools\.([A-Za-z][A-Za-z0-9_]*)\s*\(',p['input']):self.nestedtools[tool(name)]+=1
                            elif pt in ('function_call_output','custom_tool_call_output'):
                                self.c['tool_result_records']+=1;out=p.get('output');err=None;explicit=False;source='unknown'
                                cid=identity(p.get('call_id'),identity(p.get('id'),fallback))
                                if isinstance(out,str):
                                    try:out_obj=rec(json.loads(out))
                                    except (ValueError,TypeError):out_obj={}
                                    # Lexical wrapper evidence is P2/exploratory, never a validated tool-error rate.
                                    if self.include_content_rules and self.calls.get(cid) in {'exec_command','write_stdin','shell','shell_command'} and out.startswith(('Chunk ID:','Wall time:','Process exited with code ')):
                                        exits=re.findall(r'(?:^|\n)Process exited with code (-?\d+)(?:\r?\n|$)',out[:1024])
                                        if len(exits)==1:err=int(exits[0])!=0;explicit=True;source='lexical_wrapper_exit'
                                else:out_obj=rec(out)
                                if isinstance(out_obj.get('isError'),bool):err=out_obj['isError'];explicit=True;source='explicit_boolean'
                                if numeric(out_obj.get('exit_code')):err=out_obj['exit_code']!=0;explicit=True;source='structured_exit_code'
                                self.result(cid,err,explicit,flags,source=source)
                        elif t=='event_msg':
                            if pt in ('task_started','task_complete','turn_aborted','token_usage_record','thread_goal_updated','user_message','agent_message'):
                                self.c[pt]+=1;counts[pt]+=1;flags.add(pt)
                            if pt=='task_complete':
                                for k in ('duration_ms','time_to_first_token_ms'):self.mark('task_complete.'+k,k in p,flags)
                                err=rec(p.get('error')).get('codex_error_info')
                                if err is not None:self.enums['task_complete_error'][enum(err,{'usage_limit_exceeded','internal_server_error','context_window_exceeded','sandbox_error','unauthorized','rate_limit_exceeded'})]+=1
                            if pt=='turn_aborted':self.enums['turn_aborted_reason'][enum(p.get('reason'),{'interrupted','replaced'})]+=1
                            if pt=='context_compacted':compactions['legacy']+=1
                            if pt=='item_completed':
                                item=rec(p.get('item'));it=item.get('type');allowed={'UserMessage','AgentMessage','CommandExecution','FileChange','McpToolCall','WebSearch','SubAgentActivity','ContextCompaction','ExitedReviewMode','Plan','ImageView'}
                                self.enums['item_completed_type'][enum(it,allowed)]+=1;flags.add('item_completed')
                                if it=='ContextCompaction':compactions['item']+=1
                                if it=='CommandExecution':
                                    self.c['command_items']+=1
                                    for k in ('exit_code','status','duration','parsed_cmd'):self.mark('command_item.'+k,k in item,flags)
                                    if numeric(item.get('exit_code')):self.c['command_items_exit_known']+=1;self.c['command_items_nonzero']+=item['exit_code']!=0
                                elif it=='FileChange':self.c['file_change_items']+=1;self.mark('file_change.changes',isinstance(item.get('changes'),dict),flags)
                                elif it=='McpToolCall':
                                    self.c['mcp_items']+=1
                                    for k in ('server','tool','status','duration','error','result'):self.mark('mcp_item.'+k,k in item,flags)
                                elif it=='SubAgentActivity':self.enums['subagent_kind'][enum(item.get('kind'),{'started','interacted','interrupted','completed'})]+=1
                            if pt=='token_count':
                                self.c['token_count_records']+=1;flags.add('token_count')
                                info=rec(p.get('info'))
                                for k in ('total_token_usage','last_token_usage','model_context_window'):self.mark('token_count.info.'+k,k in info,flags)
                                for k in ('input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens'):self.mark('token_count.last_token_usage.'+k,k in rec(info.get('last_token_usage')),flags)
                                rates=rec(p.get('rate_limits'));self.mark('token_count.rate_limits',bool(rates),flags)
                                for window in ('primary','secondary'):
                                    lim=rec(rates.get(window));used=lim.get('used_percent');minutes=lim.get('window_minutes')
                                    if numeric(used) and numeric(minutes):
                                        label='five_hour' if minutes==300 else 'seven_day' if minutes==10080 else 'other_window'
                                        self.c['rate_window_records']+=1
                                        key=(str(path),label,used,lim.get('resets_at'))
                                        if key not in self.rate_seen:
                                            self.rate_seen.add(key);self.dist['rate_used_percent_'+label].append(used);self.c['rate_headroom_le20_'+label]+=used>=80;self.c['rate_exhausted_'+label]+=used>=100
                                        rate_max[label]=max(rate_max.get(label,0),used)
                    else:
                        # Cursor transcript records have role/content and sometimes nested message.
                        self.c['transcript_records']+=1
                        m=rec(r.get('message'));role=r.get('role',m.get('role'))
                        self.enums['role'][enum(role,{'assistant','user','system','tool'})]+=1
                        content=r.get('content',m.get('content'))
                        if isinstance(content,str):self.c['string_content_records']+=1
                        for block_index,b in enumerate(seq(content)):
                            b=rec(b)
                            if b.get('type')=='tool_use':self.call(identity(b.get('id'),(fallback,block_index)),b.get('name'));counts['tool_call_records']+=1;self.c['missing_tool_call_ids']+=not bool(b.get('id'))
                            if b.get('type')=='tool_result':self.c['tool_result_records']+=1;self.result(identity(b.get('tool_use_id'),(fallback,block_index)),b['is_error'] if isinstance(b.get('is_error'),bool) else None,isinstance(b.get('is_error'),bool),flags)
        except OSError:self.c['read_errors']+=1;return
        after=path.stat()
        self.c['changed_during_read']+=(before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns)
        new_results=[self.results[k] for k in set(self.results)-initial_results if k in self.calls]
        known=[v for v in new_results if v['error'] is not None]
        self.dist['linked_results_per_file'].append(len(new_results))
        self.dist['errors_per_file'].append(sum(v['error'] is True for v in known))
        if known:self.dist['error_percent_per_file_with_classified_results'].append(100*sum(v['error'] is True for v in known)/len(known))
        if len(known)>=20:self.dist['error_percent_per_file_min20_classified_results'].append(100*sum(v['error'] is True for v in known)/len(known))
        stratum=('subagent' if 'subagents' in path.parts else 'main') if self.provider=='claude' else ('archive' if 'archived_sessions' in path.parts else 'active') if self.provider=='codex' else 'transcript'
        sc=self.strata[stratum];sc['files']+=1;sc['unique_tool_calls']+=len(set(self.calls)-initial_calls);sc['linked_results']+=len(new_results);sc['classified_results']+=len(known);sc['errors']+=sum(v['error'] is True for v in known);sc['files_with_turn_aborted']+=counts['turn_aborted']>0
        sc['compactions']+=max(compactions.values(),default=0);sc['files_with_compaction']+=max(compactions.values(),default=0)>0
        self.c['files_completed']+=1;self.c['subagent_files']+=subagent
        c=max(compactions.values(),default=0);self.c['compactions']+=c;self.c['files_with_compaction']+=c>0
        self.c['files_with_tool_calls']+=counts['tool_call_records']>0
        self.c['files_with_turn_aborted']+=counts['turn_aborted']>0
        self.dist['compactions_per_file'].append(c)
        self.dist['tool_call_records_per_file'].append(counts['tool_call_records'])
        self.dist['records_per_file'].append(counts['records'])
        for label,used in rate_max.items():self.dist['file_max_rate_used_percent_'+label].append(used)
        if effort:self.enums['latest_effort_per_file'][effort]+=1
        for flag in flags:self.filefields[flag]+=1
    def output(self):
        n=self.c['files_completed'];out={'counts':dict(self.c),'strata':{k:dict(v) for k,v in self.strata.items()},'file_coverage':{k:coverage(v,n) for k,v in sorted(self.filefields.items())},'record_field_counts':dict(sorted(self.fields.items())),'enums':{k:dict(sorted(v.items())) for k,v in sorted(self.enums.items())},'distributions':{k:summary(v) for k,v in sorted(self.dist.items())},'tools':dict(sorted(self.toolcounts.items())),'nested_static_tool_references':dict(sorted(self.nestedtools.items()))}
        linked=[(self.calls[k],v) for k,v in self.results.items() if k in self.calls]
        classified=[(t,v) for t,v in linked if v['error'] is not None]
        errors=sum(v['error'] is True for t,v in classified)
        sources=collections.defaultdict(collections.Counter)
        for t,v in linked:
            sources[v['source']]['linked_results']+=1;sources[v['source']]['errors']+=v['error'] is True
        by=collections.defaultdict(lambda:collections.Counter())
        for t,v in linked:
            by[t]['linked_results']+=1;by[t]['status_classified']+=v['error'] is not None;by[t]['errors']+=v['error'] is True;by[t]['explicit_status']+=v['source'] in {'explicit_boolean','structured_exit_code'}
        out['tool_results']={'status_sources':{k:dict(v) for k,v in sources.items()},'unique_calls':len(self.calls),'unique_results':len(self.results),'linked_results':len(linked),'unlinked_results':len(self.results)-len(linked),'calls_without_results':len(self.calls)-len(linked),'classified_results':len(classified),'errors':errors,'errors_percent_of_linked':percent(errors,len(linked)),'unknown_status_results':len(linked)-len(classified),'explicit_non_error_results':sum(v['error'] is False for t,v in linked),'error_percent_of_classified':percent(errors,len(classified)),'classification_percent_of_linked':percent(len(classified),len(linked)),'explicit_status_results':sum(v['source'] in {'explicit_boolean','structured_exit_code'} for t,v in linked),'by_tool':{k:dict(v) for k,v in sorted(by.items())}}
        if self.messages:
            mc=collections.Counter({k:0 for k in self.messagefields});ec=collections.Counter();cc=collections.Counter();d=collections.defaultdict(list)
            for m in self.messages.values():
                for k in m['fields']:mc[k]+=1
                if m['effort']:ec[m['effort']]+=1
                if m['cache_reason']:cc[m['cache_reason']]+=1
                if m['thinking'] is not None:d['thinking_tokens'].append(m['thinking'])
                d['output_tokens'].append(m['output'])
                if all(m[k] is not None for k in ('input','cache_read','cache_creation')):
                    total=m['input']+m['cache_read']+m['cache_creation']
                    if total:d['cache_read_percent'].append(100*m['cache_read']/total)
            out['assistant_messages']={'unique':len(self.messages),'field_coverage':{k:coverage(v,len(self.messages)) for k,v in sorted(mc.items())},'effort':dict(ec),'cache_miss_reason':dict(cc),'api_error_messages':sum(m['api_error'] for m in self.messages.values()),'distributions':{k:summary(v) for k,v in d.items()}}
        return out

def inventory(home):
    data=collections.defaultdict(list);stats=collections.defaultdict(collections.Counter)
    roots=[('claude',p) for p in sorted(home.glob('.claude*/projects'))]+[('codex',home/'.codex'/p) for p in ('sessions','archived_sessions')]+[('cursor',home/'.cursor/projects')]
    for provider,root in roots:
        if not root.is_dir():continue
        stats[provider]['roots']+=1
        for base,_,files in os.walk(root,followlinks=False):
            for filename in files:
                if not filename.endswith('.jsonl') or provider=='cursor' and 'agent-transcripts' not in Path(base).parts:continue
                path=Path(base)/filename
                stratum=('subagent' if 'subagents' in path.parts else 'main') if provider=='claude' else ('archive' if 'archived_sessions' in path.parts else 'active') if provider=='codex' else 'transcript'
                try:size=path.stat().st_size
                except OSError:stats[provider]['stat_errors']+=1;continue
                stats[provider]['discovered_files']+=1;stats[provider]['discovered_bytes']+=size;stats[provider]['discovered_'+stratum]+=1
                if size>MAX_FILE:stats[provider]['oversize_files_excluded']+=1;stats[provider]['oversize_'+stratum]+=1;continue
                if path.is_symlink():stats[provider]['symlink_files_excluded']+=1;continue
                stats[provider]['eligible_files']+=1;stats[provider]['eligible_'+stratum]+=1
                data[(provider,stratum)].append((path,size))
    selected=collections.defaultdict(list)
    quotas={('claude','main'):100,('claude','subagent'):80,('codex','active'):180,('codex','archive'):20,('cursor','transcript'):100}
    for key,files in data.items():
        files.sort(key=lambda x:hashlib.sha256(SALT+str(x[0].relative_to(home)).encode()).digest())
        chosen=files[:quotas[key]];selected[key[0]]+=chosen
        stats[key[0]]['selected_'+key[1]]=len(chosen);stats[key[0]]['selected_files']+=len(chosen);stats[key[0]]['selected_bytes']+=sum(size for _,size in chosen)
    return selected,{k:dict(v) for k,v in stats.items()}

def cursor_database(home):
    path=home/'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
    out={'available':path.is_file(),'read_only':True,'sample_limit':100}
    if not out['available']:return out
    try:
        db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);db.execute('PRAGMA query_only=ON')
        tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        out['known_tables']={t:t in tables for t in ('composerHeaders','cursorDiskKV','ItemTable')}
        if 'composerHeaders' in tables:
            cols={r[1] for r in db.execute('PRAGMA table_info(composerHeaders)')}
            out['header_known_columns']={c:c in cols for c in ('composerId','workspaceId','lastUpdatedAt','isSubagent','createdAt','name')}
            out['header_rows']=db.execute('SELECT COUNT(*) FROM composerHeaders').fetchone()[0]
            if 'isSubagent' in cols:out['header_subagent_rows']=db.execute('SELECT COUNT(*) FROM composerHeaders WHERE isSubagent=1').fetchone()[0]
        if 'cursorDiskKV' in tables:
            out['kv_rows']=db.execute('SELECT COUNT(*) FROM cursorDiskKV').fetchone()[0]
            for prefix,label in [('composerData:','composer'),('bubbleId:','bubble')]:
                out[label+'_rows']=db.execute('SELECT COUNT(*) FROM cursorDiskKV WHERE key LIKE ?', (prefix+'%',)).fetchone()[0]
                rows=db.execute('SELECT value FROM cursorDiskKV WHERE key LIKE ? AND length(value)<=? ORDER BY key LIMIT 100',(prefix+'%',MAX_LINE))
                fields=collections.Counter();parsed=0;failures=0
                keys=('composerId','createdAt','lastUpdatedAt','conversation','modelConfig','model','isBestOfNSubcomposer','subagentInfo','usageData','tokenCount','costInCents','type','toolFormerData','timingInfo')
                for row in rows:
                    try:value=rec(json.loads(row[0]))
                    except (ValueError,TypeError):failures+=1;continue
                    parsed+=1
                    for k in keys:fields[k]+=k in value
                out[label+'_sample']={'parsed':parsed,'parse_failures':failures,'field_coverage':{k:coverage(v,parsed) for k,v in fields.items()}}
        db.close()
    except sqlite3.Error:out['read_error_count']=1
    return out

def run(home,include_content_rules=False):
    started=datetime.now(timezone.utc).isoformat();selected,stats=inventory(home);out={'methodology':{'version':2,'p2_content_rules_enabled':include_content_rules,'captured_started_at':started,'corrective_pass':True,'file_cap_bytes':MAX_FILE,'line_cap_bytes':MAX_LINE,'sampling':'fixed SHA-256 ranking of home-relative paths with public fixed seed; no selected paths persisted','quotas':{'claude_main':100,'claude_subagent':80,'codex_active':180,'codex_archive':20,'cursor_transcript':100},'sampling_unit':'file; unweighted stratified convenience snapshot, not a representative population estimator','error_scope':'Claude/Cursor explicit boolean tool_result is_error only; missing is unknown; Codex explicit isError/direct exit_code structured status separated from P2 lexical wrapper exit-marker evidence for joined known command transports only; lexical evidence is exploratory, not validated tool-error status','codex_nested_names':'static tools.name(...) references in custom-tool input; invocation intent only, not execution or success','rate_sampling':'unique (file, window class, used percent, reset) snapshots; repeated identical observations collapsed per file; maxima per file also reported','ids':'provider IDs retained in memory for joins/deduplication; none serialized','unknown_names':'non-allowlisted tool names, MCP names, enums collapsed to category','canonical_codex_root_only':True},'inventory':stats}
    for provider in ('claude','codex','cursor'):
        a=Audit(provider,include_content_rules=include_content_rules)
        for path,_ in selected.get(provider,[]):a.parse(path)
        out[provider]=a.output()
    out['cursor_database']=cursor_database(home)
    out['methodology']['captured_completed_at']=datetime.now(timezone.utc).isoformat()
    out['methodology']['limitations']=['No time weighting; counts describe the sampled snapshot, including recent active files.', 'Zero observed Cursor events for unavailable signal families are not zero rates.', 'Claude missing is_error is unknown; explicit status availability is strongly tool-dependent.', 'Codex command exit markers are P2 exploratory evidence; no reliable nested invocation-to-output attribution.', 'Codex subagent_files uses the final session_meta classification in each file, not workload share.', 'Claude gitOperation was present as an object; string enum mapping remains unverified.', 'Metadata size/mtime comparison detects some concurrent writes but does not create an atomic snapshot.']
    return out

def self_test():
    sentinel='DO_NOT_EMIT_PRIVATE_91c2'
    checks=[]
    with tempfile.TemporaryDirectory() as d:
        p=Path(d)/'fixture.jsonl'
        def parse(provider,records,malformed=False,include_content_rules=False):
            p.write_text('\n'.join(json.dumps(r) for r in records)+('\ninvalid '+sentinel+'\n' if malformed else ''))
            a=Audit(provider,include_content_rules=include_content_rules);a.parse(p);v=a.output();encoded=json.dumps(v)
            assert sentinel not in encoded and str(p) not in encoded
            return v
        first={'type':'assistant','cwd':'/'+sentinel,'uuid':sentinel,'requestId':sentinel,'effort':sentinel,'error':sentinel,'message':{'id':sentinel,'diagnostics':{'cache_miss_reason':{'type':'messages_changed','private':sentinel}},'content':[{'type':'text','text':sentinel},{'type':'tool_use','id':sentinel,'name':sentinel,'input':{'command':sentinel}},{'type':'tool_use','id':'false-status','name':'Bash'},{'type':'tool_use','id':'missing-status','name':'Edit'},{'type':'tool_use','id':'invalid-status','name':'Read'}],'usage':{'output_tokens':3}}}
        final={'type':'assistant','message':{'id':sentinel,'diagnostics':{'cache_miss_reason':{'type':'messages_changed'}},'usage':{'output_tokens':12,'output_tokens_details':{'thinking_tokens':7}},'content':[{'type':'tool_use','id':sentinel,'name':sentinel,'input':sentinel}]}}
        result={'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':sentinel,'is_error':True,'content':sentinel},{'type':'tool_result','tool_use_id':'false-status','is_error':False,'content':sentinel},{'type':'tool_result','tool_use_id':'missing-status','content':sentinel},{'type':'tool_result','tool_use_id':'invalid-status','is_error':'true','content':sentinel}]},'toolUseResult':{'gitOperation':sentinel,'stderr':sentinel,'status':sentinel}}
        duplicate={'type':'user','message':{'content':[{'type':'tool_result','tool_use_id':sentinel,'is_error':True,'content':sentinel}]}}
        v=parse('claude',[first,final,result,duplicate,{'type':'system','subtype':'stop_hook_summary','hookErrors':[sentinel]}],True)
        assert v['counts']['parse_failures']==1;checks.append('malformed_line_count')
        assert v['tool_results']['unique_calls']==4 and v['tool_results']['linked_results']==4
        assert v['counts']['duplicate_tool_calls']==1 and v['counts']['duplicate_tool_results']==1;checks.append('streamed_call_result_deduplication')
        assert v['tool_results']['classified_results']==2 and v['tool_results']['errors']==1
        assert v['tool_results']['explicit_non_error_results']==1 and v['tool_results']['unknown_status_results']==2;checks.append('boolean_missing_invalid_status_separation')
        assert v['assistant_messages']['unique']==1 and v['assistant_messages']['distributions']['output_tokens']['max']==12
        assert v['assistant_messages']['distributions']['thinking_tokens']['max']==7;checks.append('maximal_streamed_usage')
        assert v['assistant_messages']['cache_miss_reason']=={'messages_changed':1}
        assert v['assistant_messages']['field_coverage']['message.diagnostics.cache_miss_reason.type']['present']==1;checks.append('nested_diagnostic_deduplication')
        codex=[{'type':'session_meta','payload':{'id':sentinel,'cwd':sentinel,'source':{'subagent':{'thread_spawn':{'parent_thread_id':sentinel}}}}},{'type':'response_item','payload':{'type':'function_call','call_id':sentinel,'name':'exec_command','arguments':sentinel}},{'type':'response_item','payload':{'type':'function_call_output','call_id':sentinel,'output':'Process exited with code 2\n'+sentinel}},{'type':'event_msg','payload':{'type':'turn_aborted','reason':sentinel}},{'type':'event_msg','payload':{'type':'token_count','rate_limits':{'primary':{'used_percent':82,'window_minutes':300,'resets_at':123}}}}]
        codex.append({'type':'response_item','payload':{'type':'custom_tool_call','call_id':'nested-reference','name':'exec','input':'await tools.exec_command('+sentinel+')'}})
        v=parse('codex',codex,include_content_rules=True)
        assert v['nested_static_tool_references']=={'exec_command':1};checks.append('content_rules_explicitly_enabled')
        assert v['tool_results']['status_sources']['lexical_wrapper_exit']['errors']==1
        assert v['tool_results']['explicit_status_results']==0
        assert v['tool_results']['by_tool']['exec_command']['explicit_status']==0;checks.append('lexical_wrapper_scope')
        assert v['counts']['subagent_files']==1;checks.append('subagent_source_classification')
        quoted=[{'type':'response_item','payload':{'type':'function_call','call_id':'a','name':'exec_command'}},{'type':'response_item','payload':{'type':'function_call_output','call_id':'a','output':'Document says: Exit code 1\nProcess exited with code 2\n'+sentinel}}]
        v=parse('codex',quoted,include_content_rules=True)
        assert v['tool_results']['unknown_status_results']==1 and v['tool_results']['errors']==0;checks.append('quoted_exit_marker_rejection')
        v=parse('codex',codex)
        assert v['tool_results']['unknown_status_results']==1 and v['tool_results']['errors']==0
        assert v['nested_static_tool_references']=={};checks.append('content_rules_default_disabled')
        v=parse('cursor',[{'role':'assistant','content':[{'type':'text','text':sentinel},{'type':'tool_use','name':'Read'},{'type':'tool_use','name':'Shell'},{'type':'tool_use','name':sentinel,'input':sentinel}]}])
        assert v['tool_results']['unique_calls']==3 and v['counts']['missing_tool_call_ids']==3;checks.append('cursor_idless_multiblock_count')
        assert v['tools']['other_tool_name_redacted']==1;checks.append('unknown_tool_name_redaction')
    return {'self_test':'passed','sentinel_cases':5,'behavior_cases':len(checks),'checks':checks}

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--self-test',action='store_true');ap.add_argument('--include-content-rules',action='store_true',help='Explicitly enable local P2 lexical wrapper and nested tool-reference rules; disabled by default.');args=ap.parse_args()
    try:print(json.dumps(self_test() if args.self_test else run(Path.home(),include_content_rules=args.include_content_rules),indent=2,sort_keys=True))
    except Exception:print(json.dumps({'audit_error':'internal_failure_redacted'}));sys.exit(1)
