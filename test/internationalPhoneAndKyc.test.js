const assert = require("assert");
const { PHONE_COUNTRIES, toE164 } = require("../phoneCountries");
const countries = require("../countries");
const kyc = require("../countryKyc");

assert.strictEqual(PHONE_COUNTRIES.length, 249, "All ISO country/territory phone entries must exist");
assert.strictEqual(toE164("IN", "9876543210"), "+919876543210");
assert.strictEqual(toE164("BD", "01712345678"), "+8801712345678");
assert.strictEqual(toE164("US", "2025550123"), "+12025550123");
assert.strictEqual(toE164("GB", "02079460000"), "+442079460000");

for (const c of PHONE_COUNTRIES) {
  assert(countries.COUNTRY_BY_ID[c.id], `country catalogue missing ${c.id}`);
  const schema = kyc.schema(c.id);
  assert.strictEqual(schema.countryId, c.id);
  assert(schema.documents.length > 0, `${c.id} missing KYC document schema`);
  assert(schema.bank.accountNumberRequired, `${c.id} missing bank account requirement`);
}

assert.strictEqual(kyc.ruleFor("IN").documents[0].key, "aadhaar");
assert.strictEqual(kyc.ruleFor("BD").documents[0].key, "nationalId");
assert.strictEqual(kyc.ruleFor("US").bank.identifiers[0].key, "routingNumber");

console.log(`International phone + country KYC checks: PASS (${PHONE_COUNTRIES.length} countries)`);
