const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initAgencyCommission, DEFAULT_POLICY, calculateCommission, weeklyPeriod, buildSalaryPdf } = require('../agencyCommission.js');

function makeHarness() {
  const routes = { get: {}, post: {}, put: {} };
  const app = { get(p,...h){routes.get[p]=h}, post(p,...h){routes.post[p]=h}, put(p,...h){routes.put[p]=h} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-agency-commission-'));
  const previous = weeklyPeriod(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
  const current = weeklyPeriod();
  const users = {
    a1:{userId:'OWNER1',name:'Agency One Owner',beans:100},
    a2:{userId:'OWNER2',name:'Agency Two Owner',beans:200},
    a3:{userId:'OWNER3',name:'Agency Three Owner',beans:300},
    bad:{userId:'BADOWNER',name:'Bad Owner',beans:0}
  };
  const agencies = {
    ag1:{agencyId:'ag1',name:'Agency One',ownerUserId:'OWNER1',hostIds:['H1'],countryId:'IN',weeklyTargetValue:5000000},
    ag2:{agencyId:'ag2',name:'Agency Two',ownerUserId:'OWNER2',hostIds:['H2'],countryId:'IN',weeklyTargetValue:5000000},
    ag3:{agencyId:'ag3',name:'Agency Three',ownerUserId:'OWNER3',hostIds:['H3'],countryId:'IN',weeklyTargetValue:500000000},
    agBad:{agencyId:'agBad',name:'Bad Agency',ownerUserId:'MISSING',hostIds:[],countryId:'IN',weeklyTargetValue:5000000}
  };
  const giftHistory = [
    {transactionId:'g1',agencyId:'ag1',hostId:'H1',diamondAmount:4000000,timestamp:new Date(previous.startMs+1000).toISOString(),status:'confirmed'},
    {transactionId:'g2',agencyId:'ag2',hostId:'H2',diamondAmount:5000000,timestamp:new Date(previous.startMs+2000).toISOString(),status:'confirmed'},
    {transactionId:'g3',agencyId:'ag3',hostId:'H3',diamondAmount:500000000,timestamp:new Date(previous.startMs+3000).toISOString(),status:'confirmed'},
    {transactionId:'ignored',agencyId:'ag1',hostId:'H1',diamondAmount:999999999,timestamp:new Date(previous.startMs+4000).toISOString(),status:'failed'},
    {transactionId:'gBad',agencyId:'agBad',hostId:'HBad',diamondAmount:5000000,timestamp:new Date(previous.startMs+5000).toISOString(),status:'confirmed'}
  ];
  const saved = {};
  const notifications=[]; const updates=[]; const tx=[]; const audits=[]; const hooks=[];
  const owner={id:'admin1',username:'owner',role:'owner',countryId:null};
  let allow=true;
  const rbac={ROLES:{OWNER:'owner'},hasPermission:()=>allow,logAction:(x)=>audits.push(x)};
  const deps={
    app,DATA_FOLDER:tmp,safeRead:(file,fallback)=>fallback,safeWrite:(file,data)=>{saved[file]=JSON.parse(JSON.stringify(data));},
    users,findUserByUserId:(id)=>{for(const [mobile,user] of Object.entries(users)) if(user.userId===id) return {mobile,user}; return null;},saveUsers:()=>{},agencies,saveAgencies:()=>{},
    giftHistory,registerGiftRecordedHook:(fn)=>hooks.push(fn),logTransaction:(uid,currency,amount,note)=>{tx.push({id:'txn'+(tx.length+1),userId:uid,currency,amount,note});},getTransactions:()=>tx,
    pushWalletUpdate:(uid)=>updates.push(uid),clampBeansBalance:(uid,n)=>Math.floor(n),sendSystemMessage:(uid,msg)=>{notifications.push({uid,msg});return {success:true}},
    rbac,requireAdmin:(req,res,next)=>next(),requirePermission:(perm)=>(req,res,next)=>allow?next():res.status(403).json({success:false,message:'denied'}),
    actorCanAccessCountry:()=>true,countryDeniedResponse:(res)=>res.status(403).json({success:false}),reqUserAgent:()=> 'test'
  };
  const service=initAgencyCommission(deps);
  function run(route,req){
    const handlers=route; const res={statusCode:200,body:null,headers:{},status(c){this.statusCode=c;return this},json(b){this.body=b;return this},set(k,v){this.headers[k]=v;return this},send(b){this.body=b;return this}};
    let i=0; function next(){const h=handlers[i++]; if(!h)return; return h.length>=3?h(req,res,next):h(req,res)} next(); return res;
  }
  return {routes,tmp,previous,current,users,agencies,owner,saved,notifications,updates,tx,audits,hooks,service,run,setAllow:v=>allow=v};
}

assert.deepStrictEqual(calculateCommission(4999999,DEFAULT_POLICY).commissionPercent,10);
assert.deepStrictEqual(calculateCommission(5000000,DEFAULT_POLICY).commissionPercent,30);
assert.deepStrictEqual(calculateCommission(5000001,DEFAULT_POLICY).commissionPercent,30);
assert.deepStrictEqual(calculateCommission(500000001,DEFAULT_POLICY).commissionPercent,40);
assert.strictEqual(calculateCommission(5000000,DEFAULT_POLICY).salary,1500000);
assert.strictEqual(calculateCommission(500000000,DEFAULT_POLICY).salary,200000000);

const h=makeHarness();
const prev=h.previous;
const preview=h.run(h.routes.get['/api/admin/agency-commission/preview'],{adminAccount:h.owner,query:{periodStart:prev.start,periodEnd:prev.end}});
assert.strictEqual(preview.statusCode,200);
assert.strictEqual(preview.body.summary.totalAgencies,4);
const r1=preview.body.rows.find(r=>r.agencyId==='ag1');
const r2=preview.body.rows.find(r=>r.agencyId==='ag2');
const r3=preview.body.rows.find(r=>r.agencyId==='ag3');
assert.strictEqual(r1.commissionPercent,10); assert.strictEqual(r1.calculatedSalary,400000);
assert.strictEqual(r2.commissionPercent,30); assert.strictEqual(r2.calculatedSalary,1500000);
assert.strictEqual(r3.commissionPercent,40); assert.strictEqual(r3.calculatedSalary,200000000);
assert.strictEqual(r1.actualAchieved,4000000);
assert.strictEqual(r1.remainingTarget,1000000);

const pay2=h.run(h.routes.post['/api/admin/agency-commission/pay'],{adminAccount:h.owner,body:{agencyId:'ag2',periodStart:prev.start,periodEnd:prev.end},ip:'127.0.0.1',headers:{}});
assert.strictEqual(pay2.statusCode,200); assert.strictEqual(h.users.a2.beans,1500200); assert.strictEqual(h.notifications.length,1); assert.strictEqual(h.updates[0],'OWNER2');
assert.ok(h.tx[0].note.includes('ag2')); assert.strictEqual(pay2.body.payout.status,'paid');
const dup=h.run(h.routes.post['/api/admin/agency-commission/pay'],{adminAccount:h.owner,body:{agencyId:'ag2',periodStart:prev.start,periodEnd:prev.end},ip:'127',headers:{}});
assert.strictEqual(dup.statusCode,409); assert.strictEqual(h.users.a2.beans,1500200); assert.strictEqual(h.notifications.length,1);

const batch=h.run(h.routes.post['/api/admin/agency-commission/pay-all'],{adminAccount:h.owner,body:{periodStart:prev.start,periodEnd:prev.end},ip:'127',headers:{}});
assert.strictEqual(batch.statusCode,200); assert.strictEqual(batch.body.sent,2); assert.strictEqual(batch.body.failed,1); assert.strictEqual(batch.body.skipped,1);
assert.strictEqual(h.users.a1.beans,400100); assert.strictEqual(h.users.a3.beans,200000300); assert.strictEqual(h.users.a2.beans,1500200);
assert.strictEqual(h.notifications.length,3);

const history=h.run(h.routes.get['/api/admin/agency-commission/history'],{adminAccount:h.owner,query:{}});
assert.strictEqual(history.body.periods.filter(p=>p.status==='paid').length,3);
assert.ok(history.body.periods.find(p=>p.agencyId==='ag2' && p.payoutId));

const pdf=h.run(h.routes.get['/api/admin/agency-commission/pdf'],{adminAccount:h.owner,query:{agencyId:'ag2',periodStart:prev.start,periodEnd:prev.end}});
assert.strictEqual(pdf.statusCode,200); assert.ok(Buffer.isBuffer(pdf.body)); assert.strictEqual(pdf.body.slice(0,8).toString(),'%PDF-1.4');
const directPdf=buildSalaryPdf(history.body.periods.find(p=>p.agencyId==='ag2'));
assert.ok(directPdf.includes(Buffer.from('AGENCY SALARY REPORT')));

// Current period is a new 7-day bucket: achievement is zero and history remains.
const current=h.run(h.routes.get['/api/admin/agency-commission/preview'],{adminAccount:h.owner,query:{periodStart:h.current.start,periodEnd:h.current.end}});
assert.ok(current.body.rows.every(r=>r.actualAchieved===0));
assert.ok(h.service.getPeriods()[`ag2|${prev.key}`].status==='paid');
h.hooks.forEach(fn => fn({transactionId:'late',agencyId:'ag2',hostId:'H2',diamondAmount:999999999,timestamp:new Date(prev.startMs+6000).toISOString(),status:'confirmed'}));
const paidSnapshot=h.service.getPeriods()[`ag2|${prev.key}`];
assert.strictEqual(paidSnapshot.actualAchieved,5000000); assert.strictEqual(paidSnapshot.calculatedSalary,1500000);

// Target validation and current-period assignment.
const setTarget=h.run(h.routes.put['/api/admin/agency-commission/agencies/:agencyId/target'],{adminAccount:h.owner,params:{agencyId:'ag1'},body:{weeklyTarget:7000000},ip:'127',headers:{}});
assert.strictEqual(setTarget.statusCode,200); assert.strictEqual(h.agencies.ag1.weeklyTargetValue,7000000); assert.strictEqual(setTarget.body.period.weeklyTarget,7000000);
const badTarget=h.run(h.routes.put['/api/admin/agency-commission/agencies/:agencyId/target'],{adminAccount:h.owner,params:{agencyId:'ag1'},body:{weeklyTarget:-1},ip:'127',headers:{}});
assert.strictEqual(badTarget.statusCode,400);

// RBAC gate must reject an unauthorized caller.
h.setAllow(false);
const denied=h.run(h.routes.get['/api/admin/agency-commission/policy'],{adminAccount:{id:'bad',username:'bad',role:'admin'},query:{}});
assert.strictEqual(denied.statusCode,403);

fs.rmSync(h.tmp,{recursive:true,force:true});
console.log('agencyCommission.test.js: PASS');
