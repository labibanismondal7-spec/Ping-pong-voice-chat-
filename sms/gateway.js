// PingPong SMS gateway abstraction. Modes: local (Termux SIM) or http (Railway/cloud gateway).
const localGateway = require("./localGateway");
const whatsappGateway = require("../whatsapp/cloudApi");
const MODE = String(process.env.SMS_GATEWAY_MODE || "local").trim().toLowerCase();
async function sendSms({to,message}) {
  if (!to || !message) return {success:false,error:"Missing destination number or message"};
  if (MODE === "demo") {
    console.log(`[SMS-DEMO] to=${String(to)} message=${JSON.stringify(String(message))}`);
    return {success:true, providerMessageId:"demo-"+Date.now()};
  }
  if (MODE === "local") return localGateway.sendSms({to,message});
  if (MODE === "whatsapp") {
    const otpMatch = String(message).match(/(?:code|OTP|verification code)\s*[:\-]?\s*(\d{4,8})/i);
    if (!otpMatch) return {success:false,error:"OTP code not found in message"};
    return whatsappGateway.sendOtp({to, otp:otpMatch[1], message});
  }
  if (MODE !== "http") return {success:false,error:`Unknown SMS_GATEWAY_MODE "${MODE}"`};
  const url=String(process.env.SMS_GATEWAY_URL||"").trim(); if(!url) return {success:false,error:"SMS_GATEWAY_URL is not configured"};
  const timeoutMs=Math.min(Math.max(Number(process.env.SMS_GATEWAY_TIMEOUT_MS||10000),3000),30000); const c=new AbortController(); const t=setTimeout(()=>c.abort(),timeoutMs);
  try { const headers={"content-type":"application/json",accept:"application/json"}; const token=String(process.env.SMS_GATEWAY_TOKEN||"").trim(); if(token) headers.authorization=`Bearer ${token}`;
    const r=await fetch(url,{method:"POST",headers,signal:c.signal,body:JSON.stringify({to:String(to),message:String(message),channel:"sms"})}); const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{}}catch(_){}
    if(!r.ok||d.success===false) return {success:false,error:d.error||d.message||`SMS gateway HTTP ${r.status}`}; return {success:true,providerMessageId:d.messageId||d.id||null};
  } catch(e) { return {success:false,error:e.name==="AbortError"?"SMS gateway timeout":"SMS gateway request failed"}; } finally {clearTimeout(t);}
}
module.exports={sendSms};
