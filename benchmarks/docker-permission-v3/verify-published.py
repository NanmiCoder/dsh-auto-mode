import json, math, sys
from pathlib import Path
prefix=Path(sys.argv[1] if len(sys.argv)>1 else 'docs/jev-docker-benchmark-2026-09-26')
s=json.loads(Path(str(prefix)+'.summary.json').read_text()); rows=json.loads(Path(str(prefix)+'.measurements.json').read_text())
def close(a,b):
 if a is None or b is None: assert a==b,(a,b)
 else: assert abs(a-b)<1e-10,(a,b)
def q(xs,p):return sorted(xs)[max(0,math.ceil(len(xs)*p)-1)] if xs else None
def rng():
 state=1729
 while True:
  state=(state*1664525+1013904223)&0xffffffff
  yield state/4294967296

def mean_ci(rr,value):
 groups={}
 for r in rr:groups.setdefault(r['family'],[]).append(value(r))
 groups=[(sum(v),len(v)) for v in groups.values()]
 if not groups:return None
 rand=rng();means=[]
 for _ in range(2000):
  picked=[groups[int(next(rand)*len(groups))] for _ in groups]
  means.append(sum(x[0] for x in picked)/sum(x[1] for x in picked))
 return [q(means,.025),q(means,.975)]
def correct(r):return int(not r.get('error') and r.get('decision')==r['expected'])
def check_summary(rr,report):
 assert report['n']==len(rr)
 assert report['errors']==sum(bool(r.get('error')) for r in rr)
 close(report['accuracy'],sum(map(correct,rr))/len(rr))
 for a,b in zip(report['accuracyClusterBootstrap95'],mean_ci(rr,correct)):close(a,b)
 for expected in ['allow','ask','deny']:
  for decision in ['allow','ask','deny','error']:
   assert report['confusion'][expected][decision]==sum(r['expected']==expected and ('error' if r.get('error') else r['decision'])==decision for r in rr)
 for label,p in [('allP50',.5),('allP95',.95)]:close(report['latencyMs'][label],q([r['ms'] for r in rr],p))
assert len(rows)==2000 and len({(r['id'],r['lane'],r['repeat']) for r in rows})==2000
for lane in ['harness','jev-typesafe']:
 rr=[r for r in rows if r['lane']==lane]
 assert len(rr)==1000 and len({r['id'] for r in rr})==200
 check_summary(rr,s['allCasesSummary'][lane]);check_summary([r for r in rr if not r['informationGap']],s['summary'][lane])
 for cohort in ['legacy','expanded']:check_summary([r for r in rr if r['cohort']==cohort],s['byCohort'][cohort][lane])
 for repeat in range(5):check_summary([r for r in rr if r['repeat']==repeat],s['byRound'][str(repeat)][lane])
 assert all(r['oraclePassed'] and r['executed']==(not r.get('error') and r.get('decision')=='allow') for r in rr)
 other={(r['id'],r['repeat']):r for r in rows if r['lane']=='jev-typesafe' and not r['informationGap']}
 pairs=[]
 for r in rows:
  if r['lane']=='harness' and not r['informationGap']:
   y=other[(r['id'],r['repeat'])]
   pairs.append({'family':r['family'],'delta':correct(y)-correct(r),'ratio':None if r.get('error') or y.get('error') else r['ms']/y['ms']})
x=s['comparisons'][0];assert x['matchedPairs']==len(pairs)
close(x['accuracyDelta'],sum(r['delta'] for r in pairs)/len(pairs))
for a,b in zip(x['accuracyDeltaClusterBootstrap95'],mean_ci(pairs,lambda r:r['delta'])):close(a,b)
speed=[r for r in pairs if r['ratio'] is not None];assert x['successfulPairs']==len(speed)
close(x['medianPairedSpeedup'],q([r['ratio'] for r in speed],.5))
groups={}
for r in speed:groups.setdefault(r['family'],[]).append(r['ratio'])
groups=list(groups.values());rand=rng();vals=[]
for _ in range(2000):
 values=[]
 for _ in groups:values.extend(groups[int(next(rand)*len(groups))])
 vals.append(q(values,.5))
for a,b in zip(x['speedupClusterBootstrap95'],[q(vals,.025),q(vals,.975)]):close(a,b)
print(json.dumps({'verified':True,'records':len(rows),'independentCalculation':'Python; accuracy, confusion, cohorts, rounds, family CIs and paired speed CIs'}))
