// Regression tests for granular Owner Access Control.
// Run: node test/rbacAccessControl.test.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const rbac = require(path.join(__dirname, "..", "rbac"));

let pass=0, fail=0;
function assert(c,m){if(c){pass++;console.log("  ✓",m)}else{fail++;console.error("  ✗ FAIL:",m)}}

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rbac-access-control-"));
const store=rbac.makeStore(dir);
const owner=store.ensureOwnerAccount("owner","ownerpw123456");

console.log("=== Catalog ===");
const catalog=store.accessControlCatalog();
assert(Array.isArray(catalog.permissions) && catalog.permissions.includes("agencies:manage"),"catalog exposes Agency manage permission");
assert(catalog.groups.agencies.some(x=>x.id==="agencies:view"),"catalog groups permissions by module");
assert(catalog.nonOwnerOnly.includes("role:manage"),"role:manage is marked protected");
assert(catalog.moderatorMaxPermissions.every(p=>catalog.permissions.includes(p)),"Moderator cap contains only registered permissions");
assert(catalog.permissions.includes("admin-accounts:manage"),"catalog exposes subordinate admin-management permission");
assert(catalog.permissions.includes("rooms:global-control"),"catalog exposes global room-control permission");

console.log("=== Explicit permission sets ===");
const made=store.createAccount({
  creator: owner, username:"adm1", password:"pw123456", fullName:"Admin 1",
  role:store.ROLES.ADMIN, countryId:"IN", permissions:["users:view","agencies:view"]
});
assert(made.success,"Owner can create an Admin with a custom permission set");
let acc=store.findById(made.account.id);
assert(acc.permissionsExplicit===true,"custom account is marked explicit");
assert(store.effectivePermissions(acc).length===2,"effective permissions equal custom set");

let edit=store.updateAccount(owner,acc.id,{permissions:["users:view"]});
assert(edit.success,"Owner can remove a permission");
acc=store.findById(acc.id);
assert(store.effectivePermissions(acc).length===1 && store.effectivePermissions(acc)[0]==="users:view","removed permission stays removed");

edit=store.updateAccount(owner,acc.id,{permissions:[]});
assert(edit.success,"Owner can remove the final permission");
acc=store.findById(acc.id);
assert(store.effectivePermissions(acc).length===0,"empty explicit permission set does not restore role defaults");

console.log("=== Non-owner delegation remains fail-closed ===");
const cmRes=store.createAccount({creator:owner,username:"cm",password:"pw123456",role:store.ROLES.COUNTRY_MANAGER,countryId:"IN"});
const cm=store.findById(cmRes.account.id);
const admRes=store.createAccount({creator:cm,username:"adm2",password:"pw123456",role:store.ROLES.ADMIN,countryId:"IN",permissions:["users:view","payment:manage"]});
assert(admRes.success,"Country Manager can create a subordinate Admin");
const csaRes=store.createAccount({creator:owner,username:"csa",password:"pw123456",role:store.ROLES.COUNTRY_SUPER_ADMIN,countryId:"IN"});
const csa=store.findById(csaRes.account.id);
const csaAdmin=store.createAccount({creator:csa,username:"csa-admin",password:"pw123456",role:store.ROLES.ADMIN,countryId:"IN"});
assert(csaRes.success && csaAdmin.success,"Country Super Admin can create an Admin in its country");
assert(!admRes.account.permissions.includes("payment:manage"),"creator cannot delegate an unheld permission");

fs.rmSync(dir,{recursive:true,force:true});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
