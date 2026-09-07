# PingPong production SMS gateway

The app no longer requires the Android/Termux SIM in production. Set:

```env
SMS_GATEWAY_MODE=http
SMS_GATEWAY_URL=https://YOUR-RAILWAY-SMS-GATEWAY/send
SMS_GATEWAY_TOKEN=...
```

The gateway receives `POST` JSON with `to`, `message`, and `channel`. It must return HTTP 2xx and JSON `{ "success": true }` only after the upstream SMS provider accepts the message. Keep provider credentials inside the Railway gateway, not in this app.

For local Termux testing, keep `SMS_GATEWAY_MODE=local`.
