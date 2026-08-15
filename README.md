# THE TOWER OF ASH — Online

Multiplayer RPG with a server-authoritative backend. Accounts, gold, XP, items and
progress live on the server, so console cheats do nothing unless your account is an admin.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install          # installs express + ws
node server.js       # starts the game on port 8000
```

Then open **http://localhost:8000** in a browser. Sign up, and you are in.

Do NOT double-click `public/index.html` — opening the game as a `file://` page means
there is no server to connect to. If you do open the file directly, the login screen
will ask for a server address; type `http://localhost:8000` there.

## Playing with friends

Everyone needs to reach the machine running `server.js`.

- Same Wi-Fi: friends open `http://<your-local-ip>:8000` (e.g. `http://192.168.1.20:8000`).
- Over the internet: forward port 8000 on your router, or run a tunnel such as
  `npx localtunnel --port 8000` / `cloudflared tunnel --url http://localhost:8000`,
  and share the address it prints.

## Netlify, GitHub Pages, Vercel static — read this

Those are **static file hosts**. They serve `index.html`, but they cannot run
`server.js`, so there is nothing for the WebSocket to connect to and you get
`WebSocket connection to 'wss://…/ws' failed`. That is expected, not a bug in the game.

Two ways to fix it:

**Option A — host the whole thing on a Node host (simplest).**
Render, Railway, Fly.io, Glitch, or any VPS. The repo already contains `render.yaml`
and a `Procfile`, and the server reads `process.env.PORT`, so it works as-is.
On [Render](https://render.com): New → Web Service → point at this folder/repo →
build `npm install`, start `node server.js`. The server serves the game itself, so
`https://your-app.onrender.com` is the whole game. You do not need Netlify at all.

**Option B — keep the page on Netlify, put the server elsewhere.**
Host `server.js` on Render (above), then open your Netlify page with the server in
the URL:

```
https://your-site.netlify.app/?server=https://your-app.onrender.com
```

Or just load the page and type the server address into the **Server address** box
that appears on the login screen when no server is found. Use `https://` for the
server if the page itself is served over `https://`, or the browser will block it.

## Admin

- The first account created becomes an admin.
- The username when reposting this game  put your username here `put username here` are always admins on signup (see `OWNERS` in `server.js`).
- Admins grant admin to others with `/admin <user>` and revoke it with `/unadmin <user>`.

Admin chat commands: `/gold <n>` `/xp <n>` `/level <n>` `/heal` `/god`
`/give <item name|all>` `/cape` `/unlockboss` `/tp <x> <y>` `/floor <n>`
`/freeplay <n>` `/boss` `/kill` `/who` `/admin <user>` `/unadmin <user>`
`/kick <user>` `/say <text>`

Non-admins get `Blocked: "/gold" is an admin command…`, and every attempt is reported
to online admins and printed in the server log.

## Why cheats don't work

The browser never owns the game state. It sends only "I am holding W" and "I swung",
and draws whatever the server sends back. Movement speed, attack range and cooldowns,
enemy AI, the Giant, loot rolls, the shop and your inventory are all simulated in
`server.js`. Editing `hero.gold` in the console changes nothing, because your gold was
never in the browser.

## Files

- `server.js` — game simulation, accounts, WebSocket sync, admin commands
- `public/index.html` — the whole client (rendering, input, UI)
- `data.db` — JSON save file, created automatically. Delete it to wipe all accounts.

## Controls

WASD/Arrows move · Space or J attack · E interact · I inventory · Tab shop buy/sell ·
`[` `]` page · R respawn · Enter chat · Esc close panel · type K-I-L-O quickly for the secret cape.
