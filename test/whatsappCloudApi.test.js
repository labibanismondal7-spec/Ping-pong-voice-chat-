const assert = require("assert");
const gateway = require("../whatsapp/cloudApi");

const oldFetch = global.fetch;
const old = {};
for (const k of ["WHATSAPP_CLOUD_API_TOKEN","WHATSAPP_PHONE_NUMBER_ID","WHATSAPP_API_VERSION","WHATSAPP_OTP_TEMPLATE_NAME","WHATSAPP_OTP_TEMPLATE_LANGUAGE"]) old[k]=process.env[k];

process.env.WHATSAPP_CLOUD_API_TOKEN="TEST_TOKEN";
process.env.WHATSAPP_PHONE_NUMBER_ID="123456";
process.env.WHATSAPP_API_VERSION="v23.0";
process.env.WHATSAPP_OTP_TEMPLATE_NAME="pingpong_otp";
process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE="en_US";

let seen=null;
global.fetch=async (url,opts)=>{
  seen={url,opts,payload:JSON.parse(opts.body)};
  return {ok:true,status:200,text:async()=>JSON.stringify({messages:[{id:"wamid.TEST"}]})};
};

(async()=>{
  const r=await gateway.sendOtp({to:"+919876543210",otp:"123456",message:"PingPong verification code: 123456"});
  assert(r.success);
  assert.strictEqual(r.providerMessageId,"wamid.TEST");
  assert.strictEqual(seen.payload.to,"919876543210");
  assert.strictEqual(seen.payload.type,"template");
  assert.strictEqual(seen.payload.template.name,"pingpong_otp");
  assert.strictEqual(seen.payload.template.components[0].parameters[0].text,"123456");
  console.log("WhatsApp Cloud API integration contract: PASS");
  global.fetch=oldFetch;
  for (const k of Object.keys(old)) {
    if (old[k] === undefined) delete process.env[k]; else process.env[k]=old[k];
  }
})().catch(e=>{global.fetch=oldFetch; console.error(e); process.exit(1);});
