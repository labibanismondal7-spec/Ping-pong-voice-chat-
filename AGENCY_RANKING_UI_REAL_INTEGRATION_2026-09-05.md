# Agency Ranking UI — Real Integration

The original user-supplied PK Carnival Agency Ranking HTML is retained as the UI base.
Demo agency arrays, fake scores, generated hosts/gifters, random reward progress, demo editing, and fake names are removed/disabled.
The page fetches `/api/agency-ranking` with the existing `pp_auth_token` and listens for `agency-ranking:update` over Socket.IO.
Real Agency names and logos/profile images come from the server; ranking Diamonds come from confirmed gift history.
Only Agency identity is shown in the leaderboard; user/host/gifter names are not used for ranking display.
Rewards are read from the server event policy and are settled server-side after the persistent seven-day window.
