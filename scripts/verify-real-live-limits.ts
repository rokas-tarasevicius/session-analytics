/** Independent quota/subscription arithmetic over retained, content-free session evidence.
 * Unsupported supplemental histories and fields remain strict comparison inputs. */
type Row = Record<string, any>;
const array = (value: unknown): Row[] => { if (!Array.isArray(value)) throw new Error('Missing quota operands.'); return value; };
const finite = (value: unknown): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Missing quota number.'); return value; };
const millis = (value: unknown): number => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Missing quota date.'); return Date.parse(value); };
function canonical(value: any): any { return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value; }
const exact = (a: any, b: any) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function equal(a: any, b: any, field=''): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return /Usd$|Minutes$|^share|Percent$|Coverage$|^leverage$/.test(field) && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= 1e-8 + Math.max(Math.abs(a), Math.abs(b))*1e-12;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a)!==Array.isArray(b)) return false;
  const keys=Object.keys(a).sort(); return exact(keys,Object.keys(b).sort()) && keys.every(key=>equal(a[key],b[key],key));
}
const windowFields = ['observations', 'historyLimited', 'timelineSampled', 'timeline', 'latest', 'latestNumeric', 'headroomExpiresAt', 'stale', 'headroomPercent', 'timeToLimitMinutes', 'observedMinutes', 'above90Minutes', 'shareAbove90'];
const selected = (value: Row, fields: string[]) => Object.fromEntries(fields.map(field=>[field,value[field]]));
const ordered = (a: Row,b: Row) => millis(a.timestamp)-millis(b.timestamp) || (statusRank[a.status]??0)-(statusRank[b.status]??0) || (a.usedPercent??-1)-(b.usedPercent??-1) || JSON.stringify(a).localeCompare(JSON.stringify(b));
const statusRank: Record<string, number> = { rejected: 3, allowed_warning: 2, allowed: 1 };
function retained(rows: Row[]): Row[] {
  const byKey=new Map<string,Row>();
  for(const row of rows){
    millis(row.timestamp); if(row.usedPercent!==null&&(finite(row.usedPercent)<0||row.usedPercent>100))throw new Error('Invalid quota usage.');
    const key=`${row.timestamp}:${row.source}`,old=byKey.get(key);
    if(!old){byKey.set(key,{...row});continue;}
    if(exact(old,row))continue;
    // Equal timestamps conservatively preserve higher utilization and rejection.
    const winner=ordered(old,row)<0?row:old;
    byKey.set(key,{...winner});
  }
  return [...byKey.values()].sort(ordered);
}
/** All displayed samples are independently checked against exact retained source facts. */
export function quotaWindowProof(observations: Row[], actual: Row, policy: Row, now: string) {
  const all=retained(observations), rows=all.slice(-20_000), numeric=rows.filter(r=>r.usedPercent!==null);
  if(!rows.length)throw new Error('Missing quota observations.');
  const latest=rows.at(-1)!, latestNumeric=numeric.at(-1)??null, clock=millis(now), fresh=finite(policy.freshnessMinutes)*60_000, gap=finite(policy.maximumObservationGapMinutes)*60_000;
  let observed=0,above=0;
  for(let i=1;i<rows.length;i++){
    const previous=rows[i-1]!, next=rows[i]!;if(previous.usedPercent===null||next.usedPercent===null)continue;const start=millis(previous.timestamp), end=millis(next.timestamp);
    if(end>clock||start>clock||end-start>gap)continue;
    const minutes=Math.max(0,Math.min(end,previous.resetsAt===null?Infinity:millis(previous.resetsAt))-start)/60_000;
    observed+=minutes;if(previous.usedPercent>=90)above+=minutes;
  }
  const newest=latestNumeric??latest,subsequent=latestNumeric?rows.filter(r=>millis(r.timestamp)>=millis(latestNumeric.timestamp)):[];
  const expires=Math.min(millis(newest.timestamp)+fresh,newest.resetsAt===null?Infinity:millis(newest.resetsAt),...subsequent.filter(r=>r.resetsAt!==null).map(r=>millis(r.resetsAt)));
  const contradiction=latestNumeric&&rows.some(r=>millis(r.timestamp)>=millis(latestNumeric.timestamp)&&((r.status==='rejected'&&latestNumeric.usedPercent<100)||(r.resetsAt!==null&&latestNumeric.resetsAt!==null&&r.resetsAt!==latestNumeric.resetsAt)));
  const stale=clock<millis(newest.timestamp)||clock>=expires;
  let projection:number|null=null;
  if(!stale&&latestNumeric&&!contradiction){
    if(latestNumeric.usedPercent>=100)projection=0;
    else if(numeric.length>=3&&latestNumeric.resetsAt!==null){
      const last=numeric.slice(-3),first=last[0]!,duration=(millis(latestNumeric.timestamp)-millis(first.timestamp))/60_000,growth=latestNumeric.usedPercent-first.usedPercent;
      if(duration>=finite(policy.minimumObservedMinutes)&&growth>0&&last.every((r,i)=>r.resetsAt===latestNumeric.resetsAt&&(i===0||r.usedPercent>=last[i-1]!.usedPercent&&millis(r.timestamp)-millis(last[i-1]!.timestamp)<=gap))){
        const estimate=(100-latestNumeric.usedPercent)*duration/growth;
        if(latestNumeric.resetsAt===null||millis(latestNumeric.timestamp)+estimate*60_000<=millis(latestNumeric.resetsAt))projection=estimate;
      }
    }
  }
  const timeline=array(actual.timeline), sampled=rows.length>480;
  if(!sampled){if(!exact(timeline,rows))throw new Error('Quota timeline differs from retained facts.');}
  else {
    const facts=new Set(rows.map(r=>JSON.stringify(canonical(r))));
    if(!exact(timeline,Array.from({length:480},(_,i)=>rows[Math.round(i*(rows.length-1)/479)]))||timeline.length!==480||!exact(timeline[0],rows[0])||!exact(timeline.at(-1),rows.at(-1))||new Set(timeline.map(r=>JSON.stringify(canonical(r)))).size!==timeline.length||timeline.some((r,i)=>!facts.has(JSON.stringify(canonical(r)))||i>0&&ordered(timeline[i-1]!,r)>0))throw new Error('Quota sampled timeline is not supported by retained facts.');
  }
  return {observations:rows.length,historyLimited:all.length>20_000,timelineSampled:sampled,timeline,latest,latestNumeric,headroomExpiresAt:latestNumeric?new Date(expires).toISOString():null,stale,headroomPercent:stale||!latestNumeric||contradiction?null:100-latestNumeric.usedPercent,timeToLimitMinutes:projection,observedMinutes:observed,above90Minutes:above,shareAbove90:numeric.filter(r=>millis(r.timestamp)<=clock).length>=finite(policy.minimumRequests)&&observed>=finite(policy.minimumObservedMinutes)?above/observed:null};
}
function evidence(sessions: Row[], profile: string){return sessions.flatMap(s=>array(s.limitsCache?.quotaEvidence??[]).filter(e=>e.profileKey===profile).map(e=>({sessionKey:s.sessionKey,...e})));}
function latestField(rows: Row[], field: 'plan'|'credits'){
  const eligible=rows.filter(r=>field==='plan'?r.planObservedAt!==null:r.credits!==null);
  const at=(r:Row)=>millis(field==='plan'?r.planObservedAt:r.credits.observedAt);
  eligible.sort((a,b)=>at(a)-at(b));const row=eligible.at(-1);if(!row)return field==='plan'?{planType:null,planObservedAt:null}:null;
  const value=(r:Row)=>field==='plan'?{planType:r.planType,planObservedAt:r.planObservedAt}:r.credits;
  if(eligible.some(r=>at(r)===at(row)&&!exact(value(r),value(row))))throw new Error('Ambiguous latest quota metadata.');
  return value(row);
}
function subscriptions(sessions: Row[], actual: Row[], now: string): Row[]{
  const groups=new Map<string,Row>(), configuration=new Map<string,Row>();
  for(const r of actual){const previous=configuration.get(r.profileKey);if(previous&&(!exact(previous.monthlyPriceUsd,r.monthlyPriceUsd)||previous.scope!==r.scope))throw new Error('Ambiguous subscription configuration.');configuration.set(r.profileKey,r);}
  for(const s of sessions){const profile=s.limitsCache?.profileKey;if(!profile||s.costBasis!=='api-list-price-equivalent')continue;
    for(const bucket of array(s.limitsCache.buckets)){
      if(bucket.day===null)continue;if(!/^\d{4}-\d{2}-\d{2}$/.test(bucket.day))throw new Error('Invalid economics day.');
      const month=bucket.day.slice(0,7),key=`${profile}:${month}`;let row=groups.get(key);
      if(!row){row={profileKey:profile,month,apiEquivalentUsd:0,observedTokens:0,pricedTokens:0,days:new Set()};groups.set(key,row);}
      row.apiEquivalentUsd+=finite(bucket.apiEquivalentUsd);row.observedTokens+=finite(bucket.observedTokens);row.pricedTokens+=finite(bucket.pricedTokens);row.days.add(bucket.day);
    }
  }
  return [...groups.values()].sort((a,b)=>a.profileKey.localeCompare(b.profileKey)||a.month.localeCompare(b.month)).map(row=>{
    const config=configuration.get(row.profileKey);if(!config)throw new Error('Missing subscription configuration.');
    const price=config.monthlyPriceUsd;if(price!==null&&finite(price)<0)throw new Error('Invalid monthly price.');
    const coverage=row.observedTokens?row.pricedTokens/row.observedTokens:null,days=row.days.size;
    return {profileKey:row.profileKey,month:row.month,apiEquivalentUsd:row.apiEquivalentUsd,monthlyPriceUsd:price,leverage:price!==null&&price>0&&days>=3&&coverage===1?row.apiEquivalentUsd/price:null,observedTokens:row.observedTokens,pricedTokens:row.pricedTokens,pricingCoverage:coverage,activeDays:days,partialMonth:row.month===now.slice(0,7),scope:config.scope};
  });
}
const normalizeSubscriptions=(rows:Row[])=>[...rows].sort((a,b)=>String(a.profileKey).localeCompare(String(b.profileKey))||String(a.month).localeCompare(String(b.month)));
export function proveLiveLimits(before:Row,after:Row,excluded:ReadonlySet<string>){
  const left={...before,limitsCache:structuredClone(before.limitsCache)},right={...after,limitsCache:structuredClone(after.limitsCache)},accepted:Row[]=[],failures:string[]=[];
  if(!left.limitsCache||!right.limitsCache)return {left,right,accepted,failures};
  const aSessions=array(before.sessions),bSessions=array(after.sessions),oldStable=aSessions.filter(s=>!excluded.has(s.sessionKey)),newStable=bSessions.filter(s=>!excluded.has(s.sessionKey));
  const oldProfiles=array(left.limitsCache.profiles),newProfiles=array(right.limitsCache.profiles);
  if(!exact(before.limitsCache.policy,after.limitsCache.policy))return {left,right,accepted,failures};
  for(const a of oldProfiles){const b=newProfiles.find(p=>p.key===a.key);if(!b||exact(a,b))continue;
    const scope=`limitsCache.profile:${a.key}`;
    try{
      const oldEvidence=evidence(aSessions,a.key),newEvidence=evidence(bSessions,a.key);
      if(!exact(evidence(oldStable,a.key),evidence(newStable,a.key)))throw new Error('Stable quota evidence changed.');
      for(const field of ['plan','credits'] as const){
        const fields=field==='plan'?['planType','planObservedAt']:['credits'];if(exact(selected(a,fields),selected(b,fields)))continue;
        const oldValue=latestField(oldEvidence,field),newValue=latestField(newEvidence,field);
        if(!exact(field==='plan'?selected(a,fields):a.credits,oldValue)||!exact(field==='plan'?selected(b,fields):b.credits,newValue)){failures.push(`${scope}.${field}`);continue;}
        for(const key of fields)b[key]=structuredClone(a[key]);accepted.push({scope,field});
      }
      for(const wa of array(a.windows)){const wb=array(b.windows).find(w=>w.key===wa.key);if(!wb||exact(wa,wb))continue;
        const raws=(rows:Row[])=>rows.flatMap(e=>array(e.windows).filter(w=>w.key===wa.key).flatMap(w=>{if(w.historyLimited)throw new Error('Incomplete session quota history.');return array(w.observations);}));
        const ra=raws(oldEvidence),rb=raws(newEvidence);
        // Supplemental observations not retained per session are never inferred.
        if(!ra.length||!rb.length)continue;
        const expectedA=quotaWindowProof(ra,wa,before.limitsCache.policy,before.generatedAt),expectedB=quotaWindowProof(rb,wb,after.limitsCache.policy,after.generatedAt);
        if(!equal(selected(wa,windowFields),expectedA)||!equal(selected(wb,windowFields),expectedB)){failures.push(`${scope}.window:${wa.key}`);continue;}
        for(const field of windowFields)wb[field]=structuredClone(wa[field]);accepted.push({scope,field:`window:${wa.key}`});
      }
    }catch{failures.push(`${scope}.unavailable`);}
  }
  if(!exact(left.limitsCache.subscriptions,right.limitsCache.subscriptions))try{
    const oldActual=array(left.limitsCache.subscriptions),newActual=array(right.limitsCache.subscriptions),oldExpected=subscriptions(aSessions,oldActual,before.generatedAt),newExpected=subscriptions(bSessions,newActual,after.generatedAt);
    const stableA=subscriptions(oldStable,oldActual,before.generatedAt),stableB=subscriptions(newStable,newActual,before.generatedAt);
    if(!equal(normalizeSubscriptions(oldActual),oldExpected)||!equal(normalizeSubscriptions(newActual),newExpected)||!equal(stableA,stableB))throw new Error('Subscription contribution mismatch.');
    left.limitsCache.subscriptions=stableA;right.limitsCache.subscriptions=stableA;accepted.push({scope:'limitsCache',field:'subscriptions'});
  }catch{failures.push('limitsCache.subscriptions');}
  return {left,right,accepted,failures:[...new Set(failures)].sort()};
}
