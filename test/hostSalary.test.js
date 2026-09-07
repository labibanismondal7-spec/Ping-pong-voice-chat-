const assert = require('assert');
const { initHostSalary, LEVELS } = require('../hostSalary.js');

function makeHarness() {
  const routes = { get: {}, post: {}, put: {} };
  const app = {
    get(path, ...handlers) { routes.get[path] = handlers; },
    post(path, ...handlers) { routes.post[path] = handlers; },
    put(path, ...handlers) { routes.put[path] = handlers; }
  };
  const users = {
    a: { userId: 'HBD1', name: 'BD Host', isHost: true, agencyId: 'ag_bd', countryId: 'BD', country: 'BD', beans: 0 },
    b: { userId: 'HIN1', name: 'IN Host', isHost: true, agencyId: 'ag_in', countryId: 'IN', country: 'IN', beans: 10 },
    c: { userId: 'NOAG', name: 'No Agency', isHost: true, agencyId: null, countryId: 'BD', country: 'BD', beans: 0 },
    o: { userId: 'AGOWNER', name: 'Agency Owner', isHost: false, agencyId: 'ag_bd', countryId: 'BD', country: 'BD', beans: 0 }
  };
  const agencies = {
    ag_bd: { agencyId: 'ag_bd', name: 'BD Agency', ownerUserId: 'AGOWNER', hostIds: ['HBD1'], countryId: 'BD' },
    ag_in: { agencyId: 'ag_in', name: 'IN Agency', ownerUserId: 'HINOWNER', hostIds: ['HIN1'], countryId: 'IN' }
  };
  users.inowner = { userId: 'HINOWNER', name: 'IN Agency Owner', isHost: false, agencyId: 'ag_in', countryId: 'IN', country: 'IN', beans: 0 };
  const giftHistory = [
    { hostId: 'HBD1', agencyId: 'ag_bd', diamondAmount: 200000, timestamp: '2026-08-10T00:00:00.000Z' },
    { hostId: 'HIN1', agencyId: 'ag_in', diamondAmount: 500000, timestamp: '2026-08-12T00:00:00.000Z' },
    { hostId: 'NOAG', agencyId: null, diamondAmount: 99999999, timestamp: '2026-08-12T00:00:00.000Z' }
  ];
  const saved = {};
  const notifications = [];
  const hooks = [];
  const rbac = { logAction: () => {}, ROLES: { OWNER: 'owner' }, COUNTRIES: [{id:'IN'},{id:'BD'},{id:'OTHERS'}], COUNTRY_IDS: ['IN','BD','OTHERS'] };
  const owner = { id: 'owner1', username: 'owner', role: 'owner', countryId: null };
  const deps = {
    app, DATA_FOLDER: '/tmp/host-salary-test', safeRead: (file, fallback) => fallback,
    safeWrite: (file, data) => { saved[file] = JSON.parse(JSON.stringify(data)); },
    users, findUserByUserId: (id) => { for (const [mobile, user] of Object.entries(users)) if (user.userId === id) return { mobile, user }; return null; },
    saveUsers: () => {}, agencies, giftHistory,
    registerGiftRecordedHook: (fn) => hooks.push(fn), emitToUser: () => {}, logTransaction: () => {}, pushWalletUpdate: () => {},
    sendSystemMessage: (toUserId, message) => { notifications.push({ toUserId, message }); return { success: true }; },
    clampBeansBalance: (id, v) => Math.floor(v), rbac,
    requireAdmin: (req,res,next) => next(), requirePermission: () => (req,res,next) => next(),
    actorCanAccessCountry: () => true, countryDeniedResponse: (res) => res.status(403).json({success:false}), reqUserAgent: () => 'test'
  };
  const service = initHostSalary(deps);
  return { routes, users, agencies, owner, service, hooks, saved, notifications };
}

function runRoute(route, req) {
  const handlers = route;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
    setHeader() {}
  };
  let i = 0;
  const next = () => {
    const h = handlers[i++];
    if (!h) return;
    if (h.length >= 3) return h(req, res, next);
    return h(req, res);
  };
  next();
  return res;
}

const h = makeHarness();
const preview = runRoute(h.routes.get['/api/admin/host-salary/preview'], { adminAccount: h.owner, query: { from: '2026-08-01', to: '2026-08-31' } });
assert.strictEqual(preview.body.success, true);
assert.strictEqual(preview.body.eligibleCount, 2);
assert.strictEqual(preview.body.totalBeans, 840000);
const bd = preview.body.rows.find(r => r.userId === 'HBD1');
const india = preview.body.rows.find(r => r.userId === 'HIN1');
assert.deepStrictEqual([bd.level, bd.targetDiamonds, bd.rewardBeans], [1, 200000, 240000]);
assert.deepStrictEqual([india.level, india.targetDiamonds, india.rewardBeans], [2, 500000, 600000]);
assert.strictEqual(bd.cashEstimate.local, 43.2);
assert.strictEqual(india.cashEstimate.local, 81);

const send = runRoute(h.routes.post['/api/admin/host-salary/send-all'], { adminAccount: h.owner, body: { from: '2026-08-01', to: '2026-08-31' } });
assert.strictEqual(send.body.success, true);
assert.strictEqual(send.body.sent, 2);
assert.strictEqual(h.users.a.beans, 240000);
assert.strictEqual(h.users.b.beans, 600010);
assert.strictEqual(h.notifications.length, 2);
assert.ok(h.notifications.some(n => n.toUserId === 'HBD1' && n.message.includes('Salary Received — 240,000 Beans')));
assert.ok(h.notifications.some(n => n.toUserId === 'HIN1' && n.message.includes('Salary Received — 600,000 Beans')));

const previewAgain = runRoute(h.routes.get['/api/admin/host-salary/preview'], { adminAccount: h.owner, query: { from: '2026-08-01', to: '2026-08-31' } });
assert.strictEqual(previewAgain.body.eligibleCount, 0);
assert.ok(previewAgain.body.rows.find(r => r.userId === 'HBD1').alreadyPaid);

const manual = runRoute(h.routes.post['/api/admin/host-salary/manual-host'], { adminAccount: h.owner, body: { userId: 'HBD1', beans: 1000, reason: 'Adjustment' } });
assert.strictEqual(manual.body.success, true);
assert.strictEqual(h.users.a.beans, 241000);
assert.strictEqual(h.notifications.length, 3);
assert.ok(h.notifications.some(n => n.toUserId === 'HBD1' && n.message.includes('Beans Received — 1,000 Beans')));

const badManual = runRoute(h.routes.post['/api/admin/host-salary/manual-host'], { adminAccount: h.owner, body: { userId: 'NOAG', beans: 1000, reason: 'Should fail' } });
assert.strictEqual(badManual.body.success, false);

const agency = runRoute(h.routes.post['/api/admin/host-salary/manual-agency'], { adminAccount: h.owner, body: { agencyId: 'ag_bd', beans: 5000, reason: 'Agency support' } });
assert.strictEqual(agency.body.success, true);
assert.strictEqual(h.users.o.beans, 5000);
assert.strictEqual(h.notifications.length, 4);
assert.ok(h.notifications.some(n => n.toUserId === 'AGOWNER' && n.message.includes('Agency Beans Received — 5,000 Beans')));

assert.strictEqual(LEVELS.length, 20);
assert.strictEqual(LEVELS[0].rewardBeans / LEVELS[0].targetDiamonds, 1.2);
assert.strictEqual(LEVELS[19].rewardBeans / LEVELS[19].targetDiamonds, 1.2);
console.log('hostSalary.test.js: PASS');
