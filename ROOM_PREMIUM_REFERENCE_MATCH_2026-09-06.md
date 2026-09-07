# Premium Room Reference Match — 2026-09-06

- Replaced `public/images/room-default-theme.jpg` with the supplied portrait PingPong artwork.
- Default room background remains server/client compatible at the existing URL, so rooms without a custom theme show the supplied artwork full-screen with `cover` and no tiling.
- Reworked the room header into a lightweight transparent/glass identity card so the artwork remains visible.
- Kept the existing room name and live room ID bindings and the existing ⭐ level button.
- Moved the existing Room Ranking button into a dedicated strip directly below the header and above the seat grid. Existing `#btn-room-ranking` ID and event logic are preserved.
- Kept seats below Ranking with stable dimensions and premium glass treatment.
- Preserved existing room settings, gifts, chat, voice, games, reconnect and ranking logic; this patch is UI/asset focused.
