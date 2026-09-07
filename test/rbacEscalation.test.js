// test/rbacEscalation.test.js
// Regression tests for the privilege-escalation prevention fix in rbac.js
// (SRS item 18): an actor must never be able to (a) grant a permission it
// doesn't itself hold, (b) grant a system-level NON_OWNER_ONLY permission
// to any non-owner account, or (c) modify/delete an account of equal or
// higher rank, including its own. Runs the real module against a scratch
// data directory (removed after the run), not a re-implementation.
//
// Run: node test/rbacEscalation.test.js

const path = require("path");
const fs = require("fs");
const os = require("os");
const rbac = require(path.join(__dirname, "..", "rbac"));

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { pass++; console.log("  ✓", msg); }
    else { fail++; console.error("  ✗ FAIL:", msg); }
}

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rbac-escalation-test-"));
const store = rbac.makeStore(scratchDir);
const { ROLES } = store;

const owner = store.ensureOwnerAccount("owner", "ownerpw123456");

console.log("=== NON_OWNER_ONLY permissions can never land on a non-owner account ===");
{
    const res = store.createAccount({
        creator: owner, username: "gsa1", password: "pw123456", fullName: "GSA1",
        role: ROLES.GLOBAL_SUPER_ADMIN, permissions: ["role:manage", "country:manage", "users:view"]
    });
    assert(res.success, "owner can create a Global Super Admin");
    assert(!res.account.permissions.includes("role:manage"), "role:manage stripped even when Owner tries to grant it");
    assert(!res.account.permissions.includes("country:manage"), "country:manage stripped even when Owner tries to grant it");
    assert(res.account.permissions.includes("users:view"), "ordinary permission still passes through");
}

console.log("=== Delegation: actor can't grant a permission it doesn't itself hold ===");
{
    const cm = store.findById(store.createAccount({
        creator: owner, username: "cm1", password: "pw123456", fullName: "CM1",
        role: ROLES.COUNTRY_MANAGER, countryId: "IN"
    }).account.id);
    assert(!store.effectivePermissions(cm).includes("payment:manage"), "sanity: Country Manager default set excludes payment:manage");

    const adminRes = store.createAccount({
        creator: cm, username: "admX", password: "pw123456", fullName: "AdminX",
        role: ROLES.ADMIN, countryId: "IN", permissions: ["payment:manage", "users:view"]
    });
    assert(adminRes.success, "Country Manager can still create an Admin");
    assert(!adminRes.account.permissions.includes("payment:manage"), "cannot delegate a permission the creator doesn't hold");
    assert(adminRes.account.permissions.includes("users:view"), "can delegate a permission the creator does hold");

    // Same rule via updateAccount, not just createAccount
    const admin = store.findById(adminRes.account.id);
    const editRes = store.updateAccount(cm, admin.id, { permissions: ["payment:manage", "reports:view"] });
    assert(editRes.success, "Country Manager can still edit its subordinate Admin");
    assert(!editRes.account.permissions.includes("payment:manage"), "updateAccount also blocks delegating an unheld permission");
    assert(editRes.account.permissions.includes("reports:view"), "updateAccount still allows delegating a held permission");
}

console.log("=== Rank guard: can't modify/delete a peer or higher-ranked account ===");
{
    const gsaA = store.findById(store.createAccount({ creator: owner, username: "gsaA", password: "pw123456", fullName: "GSA A", role: ROLES.GLOBAL_SUPER_ADMIN }).account.id);
    const gsaB = store.findById(store.createAccount({ creator: owner, username: "gsaB", password: "pw123456", fullName: "GSA B", role: ROLES.GLOBAL_SUPER_ADMIN }).account.id);

    const peerEdit = store.updateAccount(gsaA, gsaB.id, { status: "suspended" });
    assert(!peerEdit.success, "Global Super Admin cannot edit a peer Global Super Admin");

    const peerDelete = store.deleteAccount(gsaA, gsaB.id);
    assert(!peerDelete.success, "Global Super Admin cannot delete a peer Global Super Admin");

    const csa = store.findById(store.createAccount({ creator: gsaA, username: "csaX", password: "pw123456", fullName: "CSA X", role: ROLES.COUNTRY_SUPER_ADMIN, countryId: "IN" }).account.id);
    const downEdit = store.updateAccount(gsaA, csa.id, { status: "suspended" });
    assert(downEdit.success, "Global Super Admin can still edit a lower-ranked account");

    const upEdit = store.updateAccount(csa, gsaA.id, { status: "suspended" });
    assert(!upEdit.success, "Country Super Admin cannot edit a higher-ranked Global Super Admin");

    // Owner is exempt from the rank guard both ways
    const ownerEditsGsa = store.updateAccount(owner, gsaA.id, { status: "active" });
    assert(ownerEditsGsa.success, "Owner is exempt from the rank guard when editing a Global Super Admin");
}

console.log("=== Self-escalation: an actor cannot modify or delete its own account via this path ===");
{
    const gsaC = store.findById(store.createAccount({ creator: owner, username: "gsaC", password: "pw123456", fullName: "GSA C", role: ROLES.GLOBAL_SUPER_ADMIN }).account.id);

    const selfPermEdit = store.updateAccount(gsaC, gsaC.id, { permissions: ["role:manage"] });
    assert(!selfPermEdit.success, "actor cannot edit its own account (self-escalation vector closed)");

    const selfDelete = store.deleteAccount(gsaC, gsaC.id);
    assert(!selfDelete.success, "actor cannot delete its own account");

    // Owner is exempt (used by the env-credential-resync login fallback in server.js)
    const ownerSelfEdit = store.updateAccount(owner, owner.id, { password: "newownerpw123456" });
    assert(ownerSelfEdit.success, "Owner remains exempt and can update its own account (needed for env-password resync)");
}

fs.rmSync(scratchDir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
