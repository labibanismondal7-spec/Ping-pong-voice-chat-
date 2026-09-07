/* PingPong WhatsApp Cloud API OTP delivery.
 * Requires a Meta WhatsApp Business Cloud API phone-number ID, permanent/
 * system-user access token, and an approved authentication template.
 * No credentials are hard-coded.
 */
"use strict";

async function sendOtp({to, otp, message}) {
  const token = String(process.env.WHATSAPP_CLOUD_API_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const version = String(process.env.WHATSAPP_API_VERSION || "v23.0").trim();
  const templateName = String(process.env.WHATSAPP_OTP_TEMPLATE_NAME || "").trim();
  const language = String(process.env.WHATSAPP_OTP_TEMPLATE_LANGUAGE || "en_US").trim();

  if (!token || !phoneNumberId || !templateName) {
    return { success:false, error:"WhatsApp Cloud API is not fully configured (token, phone number ID, template name required)" };
  }

  const digits = String(to || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return { success:false, error:"Invalid WhatsApp recipient number" };
  }

  const code = String(otp || "").trim();
  if (!/^\d{4,8}$/.test(code)) {
    return { success:false, error:"Invalid OTP code" };
  }

  const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneNumberId)}/messages`;
  const controller = new AbortController();
  const timeoutMs = Math.min(Math.max(Number(process.env.WHATSAPP_API_TIMEOUT_MS || 10000), 3000), 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      messaging_product: "whatsapp",
      to: digits,
      type: "template",
      template: {
        name: templateName,
        language: { code: language },
        components: [{
          type: "body",
          parameters: [{ type:"text", text:code }]
        }]
      }
    };
    const response = await fetch(url, {
      method:"POST",
      headers:{
        "Authorization":`Bearer ${token}`,
        "Content-Type":"application/json",
        "Accept":"application/json"
      },
      body:JSON.stringify(payload),
      signal:controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok || data.error) {
      return {
        success:false,
        error:data?.error?.message || `WhatsApp Cloud API HTTP ${response.status}`
      };
    }
    const messageId = data?.messages?.[0]?.id || null;
    return { success:true, providerMessageId:messageId };
  } catch (err) {
    return {
      success:false,
      error:err?.name === "AbortError" ? "WhatsApp Cloud API timeout" : "WhatsApp Cloud API request failed"
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendOtp };
