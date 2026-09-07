const assert = require('assert');
const { initPayoutWithdrawal } = require('../payoutWithdrawal.js');

function makeHarness() {
  const routes = { get: {}, post: {} };
  const app = {
    get(path, ...handlers) { routes.get[path] = handlers; },
    post(path, ...handlers) { routes.post[path] = handlers; }
  };
  const users = {
    m1: { userId: 'U1', name: 'User One', beans: 100000000 },
    m2: { userId: 'U2', name: 'User Two', beans: 50000 }
  };
  const files = {};
  const notifications = [];
  const emits = [];
  const owner = { id: 'owner1', username: 'owner', role: 'owner' };
  const reviewer = { id: 'rev1', username: 'reviewer', role: 'country_manager' };

  const rbac = { logAction: () => {} };
  const deps = {
    app, DATA_FOLDER: '/tmp/payout-withdrawal-test',
    safeRead: (file, fallback) => (files[file] !== undefined ? files[file] : fallback),
    safeWrite: (file, data) => { files[file] = JSON.parse(JSON.stringify(data)); },
    users,
    findUserByUserId: (id) => { for (const [mobile, user] of Object.entries(users)) if (user.userId === id) return { mobile, user }; return null; },
    saveUsers: () => {},
    logTransaction: () => {},
    pushWalletUpdate: () => {},
    clampBeansBalance: (id, v) => Math.max(0, Math.floor(v)),
    sendSystemMessage: (toUserId, message) => { notifications.push({ toUserId, message }); return { success: true }; },
    emitToUser: (userId, event, payload) => { emits.push({ userId, event, payload }); },
    rbac,
    requireAdmin: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
    reqUserAgent: () => 'test',
    userAuth: { requireUserAuth: (req, res, next) => next() },
    resolveUserKey: (req) => req.mobile
  };
  const service = initPayoutWithdrawal(deps);
  return { routes, users, service, notifications, emits, owner, reviewer };
}

// ---- 1. Beans conversion math (spec #2/#3) ----
{
  const h = makeHarness();
  const r1 = h.service.convertBeans('U1', 200000);
  assert.strictEqual(r1.success, true);
  assert.strictEqual(r1.usdCentsCreated, 100);
  assert.strictEqual(h.users.m1.beans, 100000000 - 200000);

  const r2 = h.service.convertBeans('U1', 400000);
  assert.strictEqual(r2.usdCentsCreated, 200);

  const r3 = h.service.convertBeans('U1', 2000000);
  assert.strictEqual(r3.usdCentsCreated, 1000);

  const state = h.service.getUserWithdrawState('U1');
  assert.strictEqual(state.availableCents, 100 + 200 + 1000);
  assert.strictEqual(state.beans, 100000000 - 200000 - 400000 - 2000000);
  console.log('PASS: beans conversion math (200k/400k/2m beans)');
}

// ---- 2. Cannot convert more beans than balance; balance untouched ----
{
  const h = makeHarness();
  const bad = h.service.convertBeans('U2', 999999999);
  assert.strictEqual(bad.success, false);
  assert.strictEqual(h.users.m2.beans, 50000);
  console.log('PASS: insufficient beans rejected, balance untouched');
}

// ---- 3. Negative / invalid conversion rejected (spec #34) ----
{
  const h = makeHarness();
  assert.strictEqual(h.service.convertBeans('U1', -5000).success, false);
  assert.strictEqual(h.service.convertBeans('U1', 0).success, false);
  assert.strictEqual(h.service.convertBeans('U1', 'abc').success, false);
  console.log('PASS: negative/invalid beans conversion rejected');
}

// ---- 4. Withdrawal blocked before KYC verified (spec #7/#11) ----
{
  const h = makeHarness();
  h.service.convertBeans('U1', 20000000);
  const attempt = h.service.requestWithdrawal('U1', 10000);
  assert.strictEqual(attempt.success, false);
  assert.match(attempt.message, /KYC/);
  console.log('PASS: withdrawal blocked before KYC verified');
}

// ---- 5. KYC submit -> pending -> admin verify -> withdrawal enabled ----
{
  const h = makeHarness();
  const kycInput = {
    pan: 'abcpd1234e', aadhaar: '123456789012',
    accountHolder: 'User One', accountNumber: '1234567890', confirmAccountNumber: '1234567890',
    ifsc: 'hdfc0001234', bankName: 'HDFC Bank'
  };
  const sub = h.service.submitKyc('U1', kycInput);
  assert.strictEqual(sub.success, true);
  assert.strictEqual(sub.kyc.status, 'PENDING');

  h.service.convertBeans('U1', 20000000);
  const blocked = h.service.requestWithdrawal('U1', 10000);
  assert.strictEqual(blocked.success, false);

  const verify = h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  assert.strictEqual(verify.success, true);
  assert.strictEqual(verify.kyc.status, 'VERIFIED');

  const ok = h.service.requestWithdrawal('U1', 10000);
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.status, 'PENDING');
  console.log('PASS: KYC submit -> verify -> withdrawal enabled flow');
}

// ---- 6. KYC format validation + reject/resubmit cycle ----
{
  const h = makeHarness();
  assert.strictEqual(h.service.submitKyc('U1', { pan: 'BADPAN', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' }).success, false);
  assert.strictEqual(h.service.submitKyc('U1', { pan: 'ABCPD1234E', aadhaar: '12345', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' }).success, false);
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  assert.strictEqual(h.service.submitKyc('U1', good).success, true);
  const rej = h.service.adminRejectKyc({ adminAccount: h.owner, ip: '::1' }, 'U1', 'PAN mismatch');
  assert.strictEqual(rej.success, true);
  assert.strictEqual(rej.kyc.status, 'REJECTED');
  const resub = h.service.submitKyc('U1', good);
  assert.strictEqual(resub.success, true);
  console.log('PASS: KYC format validation + reject/resubmit cycle');
}

// ---- 7. Minimum withdrawal: $99 rejected, $100 accepted (spec #12) ----
{
  const h = makeHarness();
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  h.service.submitKyc('U1', good);
  h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  h.service.convertBeans('U1', 19800000);
  const tooLow = h.service.requestWithdrawal('U1', 9900);
  assert.strictEqual(tooLow.success, false);
  h.service.convertBeans('U1', 200000);
  const exact = h.service.requestWithdrawal('U1', 10000);
  assert.strictEqual(exact.success, true);
  console.log('PASS: $99 rejected, exactly $100 accepted');
}

// ---- 8. Reservation on request; reject releases it back ----
{
  const h = makeHarness();
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  h.service.submitKyc('U1', good);
  h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  h.service.convertBeans('U1', 50000000);
  const req1 = h.service.requestWithdrawal('U1', 10000);
  assert.strictEqual(req1.success, true);
  let state = h.service.getUserWithdrawState('U1');
  assert.strictEqual(state.availableCents, 15000);
  assert.strictEqual(state.reservedCents, 10000);

  const rejected = h.service.adminDecideWithdrawal({ adminAccount: h.reviewer, ip: '::1' }, req1.withdrawalId, 'reject', { reason: 'test' });
  assert.strictEqual(rejected.success, true);
  state = h.service.getUserWithdrawState('U1');
  assert.strictEqual(state.availableCents, 25000);
  assert.strictEqual(state.reservedCents, 0);
  console.log('PASS: reservation on request, release on reject');
}

// ---- 9. Successful payment consumes reservation; duplicate payment blocked (spec #20/#23) ----
{
  const h = makeHarness();
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  h.service.submitKyc('U1', good);
  h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  h.service.convertBeans('U1', 20000000);
  const req1 = h.service.requestWithdrawal('U1', 10000);

  h.service.adminDecideWithdrawal({ adminAccount: h.reviewer, ip: '::1' }, req1.withdrawalId, 'approve');
  h.service.adminDecideWithdrawal({ adminAccount: h.reviewer, ip: '::1' }, req1.withdrawalId, 'processing');
  const paid = h.service.adminDecideWithdrawal({ adminAccount: h.owner, ip: '::1' }, req1.withdrawalId, 'paid', { payoutTxnId: 'TXN123' });
  assert.strictEqual(paid.success, true);
  assert.strictEqual(paid.withdrawal.status, 'PAID');

  const state = h.service.getUserWithdrawState('U1');
  assert.strictEqual(state.reservedCents, 0);
  assert.strictEqual(state.availableCents, 0);

  const dup = h.service.adminDecideWithdrawal({ adminAccount: h.owner, ip: '::1' }, req1.withdrawalId, 'paid', { payoutTxnId: 'TXN999' });
  assert.strictEqual(dup.success, false);
  assert.match(dup.message, /duplicate/i);
  const paidNotifications = h.notifications.filter(n => n.message.includes('Withdrawal Paid'));
  assert.strictEqual(paidNotifications.length, 1);
  console.log('PASS: duplicate payout blocked, exactly one success notification');
}

// ---- 10. Failed payment never marks PAID, balance stays reserved (spec #22) ----
{
  const h = makeHarness();
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  h.service.submitKyc('U1', good);
  h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  h.service.convertBeans('U1', 20000000);
  const req1 = h.service.requestWithdrawal('U1', 10000);
  h.service.adminDecideWithdrawal({ adminAccount: h.reviewer, ip: '::1' }, req1.withdrawalId, 'approve');
  h.service.adminDecideWithdrawal({ adminAccount: h.reviewer, ip: '::1' }, req1.withdrawalId, 'processing');
  const failed = h.service.adminDecideWithdrawal({ adminAccount: h.owner, ip: '::1' }, req1.withdrawalId, 'failed');
  assert.strictEqual(failed.success, true);
  assert.strictEqual(failed.withdrawal.status, 'FAILED');
  const state = h.service.getUserWithdrawState('U1');
  assert.strictEqual(state.reservedCents, 10000);
  const anyPaidNotif = h.notifications.some(n => n.message.includes('Withdrawal Paid'));
  assert.strictEqual(anyPaidNotif, false);
  console.log('PASS: failed payment keeps reservation, no false success notification');
}

// ---- 11. Withdrawal history scoped per-user (spec #32) ----
{
  const h = makeHarness();
  const good = { pan: 'ABCPD1234E', aadhaar: '123456789012', accountHolder: 'X', accountNumber: '111111', confirmAccountNumber: '111111', ifsc: 'HDFC0001234' };
  h.service.submitKyc('U1', good);
  h.service.adminVerifyKyc({ adminAccount: h.owner, ip: '::1' }, 'U1');
  h.service.convertBeans('U1', 40000000);
  h.service.requestWithdrawal('U1', 10000);
  h.service.requestWithdrawal('U1', 10000);
  const historyU1 = h.service.getUserWithdrawalHistory('U1');
  const historyU2 = h.service.getUserWithdrawalHistory('U2');
  assert.strictEqual(historyU1.length, 2);
  assert.strictEqual(historyU2.length, 0);
  console.log('PASS: withdrawal history scoped per-user');
}

// ---- 12. Rate change never recalculates historical conversions (spec #27/#28) ----
{
  const h = makeHarness();
  const before = h.service.convertBeans('U1', 200000);
  assert.strictEqual(before.usdCentsCreated, 100);
  const settingsResult = h.service.adminUpdateSettings({ adminAccount: h.owner, ip: '::1' }, { beansPerUsd: 100000 });
  assert.strictEqual(settingsResult.success, true);
  const stateAfterRateChange = h.service.getUserWithdrawState('U1');
  assert.strictEqual(stateAfterRateChange.availableCents, 100);
  const after = h.service.convertBeans('U1', 200000);
  assert.strictEqual(after.usdCentsCreated, 200);
  console.log('PASS: rate change does not touch historical conversions');
}

// ---- 13. Every admin route is gated by requireAdmin + requirePermission ----
{
  const h = makeHarness();
  const getAdmin = Object.keys(h.routes.get).filter(p => p.startsWith('/api/admin/'));
  const postAdmin = Object.keys(h.routes.post).filter(p => p.startsWith('/api/admin/'));
  assert.ok(getAdmin.length + postAdmin.length >= 9);
  for (const p of getAdmin) assert.ok(h.routes.get[p].length >= 3, `admin GET route ${p} missing an auth/permission gate`);
  for (const p of postAdmin) assert.ok(h.routes.post[p].length >= 3, `admin POST route ${p} missing an auth/permission gate`);
  console.log('PASS: every admin route is gated by requireAdmin + requirePermission');
}

console.log('\nAll payoutWithdrawal tests passed.');
