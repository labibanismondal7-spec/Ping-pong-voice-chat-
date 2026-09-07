/* PingPong Country-aware Withdrawal KYC Registry.
 * Country rules are server-authoritative. Raw KYC is never returned to the user.
 * Add a new ISO country by adding a rule; unknown countries use a conservative
 * document+bank fallback instead of silently applying another country's rules.
 */
"use strict";

const RULES = {
  IN: {
    name:"India", currency:"INR", bank:{accountNumber:/^[0-9]{6,18}$/, identifiers:[
      {key:"ifsc",label:"IFSC Code",required:true,pattern:/^[A-Z]{4}0[A-Z0-9]{6}$/},
      {key:"bankName",label:"Bank Name",required:false,pattern:/^.{2,120}$/}
    ]},
    documents:[
      {key:"aadhaar",label:"Aadhaar Number",required:true,pattern:/^[0-9]{12}$/},
      {key:"pan",label:"PAN",required:true,pattern:/^[A-Z]{5}[0-9]{4}[A-Z]$/}
    ]
  },
  BD: {
    name:"Bangladesh", currency:"BDT", bank:{accountNumber:/^[0-9]{8,20}$/, identifiers:[
      {key:"routingNumber",label:"Bank Routing Number",required:true,pattern:/^[0-9]{9}$/},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"nationalId",label:"National ID (NID)",required:true,pattern:/^[0-9]{10,17}$/},
      {key:"tin",label:"e-TIN",required:false,pattern:/^[0-9]{10,17}$/}]
  },
  PK: {
    name:"Pakistan", currency:"PKR", bank:{accountNumber:/^[0-9]{8,24}$/, identifiers:[
      {key:"iban",label:"IBAN",required:true,pattern:/^PK[0-9A-Z]{22}$/},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"cnic",label:"CNIC",required:true,pattern:/^[0-9]{13}$/}]
  },
  US: {
    name:"United States", currency:"USD", bank:{accountNumber:/^[0-9]{4,20}$/, identifiers:[
      {key:"routingNumber",label:"ABA Routing Number",required:true,pattern:/^[0-9]{9}$/},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"governmentId",label:"Government ID / Passport",required:true,pattern:/^.{4,80}$/}]
  },
  GB: {
    name:"United Kingdom", currency:"GBP", bank:{accountNumber:/^[0-9]{8}$/, identifiers:[
      {key:"sortCode",label:"Sort Code",required:true,pattern:/^[0-9]{6}$/,transform:v=>v.replace(/[^0-9]/g,"")},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"governmentId",label:"Government ID / Passport",required:true,pattern:/^.{4,80}$/}]
  },
  AE: {
    name:"United Arab Emirates", currency:"AED", bank:{accountNumber:/^[0-9]{8,24}$/, identifiers:[
      {key:"iban",label:"IBAN",required:true,pattern:/^AE[0-9A-Z]{21}$/},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"emiratesId",label:"Emirates ID",required:true,pattern:/^[0-9]{15}$/}]
  },
  SA: {
    name:"Saudi Arabia", currency:"SAR", bank:{accountNumber:/^[0-9]{10,24}$/, identifiers:[
      {key:"iban",label:"IBAN",required:true,pattern:/^SA[0-9A-Z]{22}$/},
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"nationalId",label:"National ID / Iqama",required:true,pattern:/^[0-9]{8,12}$/}]
  },
  NP: {
    name:"Nepal", currency:"NPR", bank:{accountNumber:/^[0-9]{6,24}$/, identifiers:[
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"nationalId",label:"National ID / Citizenship ID",required:true,pattern:/^.{5,40}$/}]
  },
  LK: {
    name:"Sri Lanka", currency:"LKR", bank:{accountNumber:/^[0-9]{8,24}$/, identifiers:[
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"nationalId",label:"National Identity Card",required:true,pattern:/^.{5,20}$/}]
  },
  MY: {
    name:"Malaysia", currency:"MYR", bank:{accountNumber:/^[0-9]{8,24}$/, identifiers:[
      {key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}
    ]},
    documents:[{key:"nationalId",label:"MyKad / Government ID",required:true,pattern:/^.{5,30}$/}]
  }
};

// Every ISO country is supported by the schema endpoint. Countries with a
// maintained local rule keep their stricter document/bank validation;
// countries without one use a conservative universal Government ID/Passport
// + bank-account schema instead of silently borrowing another country's rules.
const { COUNTRIES } = require("./countries");
for (const c of COUNTRIES) {
  if (c.id === "OTHERS" || RULES[c.id]) continue;
  RULES[c.id] = {
    name: c.name_en, currency: "LOCAL",
    bank: {
      accountNumber: /^[0-9A-Za-z]{6,34}$/,
      identifiers: [{ key:"bankName", label:"Bank Name", required:true, pattern:/^.{2,120}$/ }]
    },
    documents: [{ key:"governmentId", label:"Government ID / Passport", required:true, pattern:/^.{4,80}$/ }]
  };
}
Object.freeze(RULES);

function normalizeCountry(id){ return String(id||"OTHERS").trim().toUpperCase(); }
function ruleFor(country){ return RULES[normalizeCountry(country)] || {
  name:"Other Country", currency:"LOCAL",
  bank:{accountNumber:/^[0-9A-Za-z]{6,34}$/,identifiers:[{key:"bankName",label:"Bank Name",required:true,pattern:/^.{2,120}$/}]},
  documents:[{key:"governmentId",label:"Government ID / Passport",required:true,pattern:/^.{4,80}$/}]
};}
function schema(country){
  const r=ruleFor(country);
  return {countryId:normalizeCountry(country),countryName:r.name,currency:r.currency,
    documents:r.documents.map(x=>({key:x.key,label:x.label,required:x.required})),
    bank:{accountNumberRequired:true,identifiers:r.bank.identifiers.map(x=>({key:x.key,label:x.label,required:x.required}))}};
}
function clean(v,max=160){return String(v==null?"":v).trim().slice(0,max);}
function validate(country,input){
  const r=ruleFor(country), src=input&&typeof input==="object"?input:{};
  const errors=[], out={};
  for(const d of r.documents){
    let v=clean(src[d.key]);
    if(d.required&&!v) errors.push(`${d.label} is required`);
    if(v&&d.pattern&&!d.pattern.test(v.toUpperCase())) errors.push(`Invalid ${d.label}`);
    if(v) out[d.key]=v.toUpperCase();
  }
  const holder=clean(src.accountHolder,120);
  if(!holder) errors.push("Account holder name is required"); else out.accountHolder=holder;
  let acc=clean(src.accountNumber,40).replace(/\s+/g,"");
  const confirm=clean(src.confirmAccountNumber,40).replace(/\s+/g,"");
  if(!r.bank.accountNumber.test(acc)) errors.push("Invalid bank account number");
  if(acc!==confirm) errors.push("Bank account numbers do not match");
  if(acc) out.accountNumber=acc;
  for(const b of r.bank.identifiers){
    let v=clean(src[b.key]);
    if(b.transform)v=b.transform(v);
    if(b.required&&!v) errors.push(`${b.label} is required`);
    if(v&&b.pattern&&!b.pattern.test(v.toUpperCase())) errors.push(`Invalid ${b.label}`);
    if(v) out[b.key]=v.toUpperCase();
  }
  out.countryId=normalizeCountry(country);
  return {valid:errors.length===0,errors,value:out};
}
function mask(value, keep=4){const s=String(value||"");return s.length<=keep?"*".repeat(s.length):"*".repeat(Math.max(0,s.length-keep))+s.slice(-keep);}
module.exports={RULES,ruleFor,schema,validate,mask};
