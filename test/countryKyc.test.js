const assert=require("assert");
const k=require("../countryKyc");
let r=k.validate("IN",{aadhaar:"123456789012",pan:"ABCDE1234F",accountHolder:"A",accountNumber:"123456789",confirmAccountNumber:"123456789",ifsc:"HDFC0123456",bankName:"HDFC Bank"});
assert(r.valid,"India KYC validates Aadhaar/PAN/IFSC");
r=k.validate("BD",{nationalId:"1234567890123",accountHolder:"A",accountNumber:"12345678",confirmAccountNumber:"12345678",routingNumber:"123456789",bankName:"Bank"});
assert(r.valid,"Bangladesh KYC validates NID/routing");
r=k.validate("IN",{nationalId:"123",accountHolder:"A",accountNumber:"123456789",confirmAccountNumber:"123456789",ifsc:"BAD",bankName:"B"});
assert(!r.valid && r.errors.some(x=>/Aadhaar|PAN|IFSC/.test(x)),"country-specific fields reject wrong document set");
console.log("countryKyc: 3 passed");
