# ROBBAN.IO — Snake Arena

A real-time multiplayer snake game (slither-style) for RobbaN and the Kick chat.
Everyone who opens the link plays in the **same arena** live: eat glowing orbs to grow,
make other snakes crash into your body, hold click / Space to boost.

**Features**
- Up to 100 players at once; bots fill the arena when few people are online
- Leaderboard, kill feed ("X ate Y"), minimap, rank, death stats
- Works on PC and phones (drag to steer, ⚡ button to boost)
- 12 colours including ROBBAN red/blue
- **Stream overlay mode** for OBS (`?obs=1`) — spectates the #1 snake with a "Join" banner
- Very light: ~7 KB/s per player, ~3% of one CPU core with 80 snakes

---

## 1. Try it on your PC (optional)

Install Node.js (LTS) from nodejs.org, then in this folder:

```
npm install
npm start
```

Open http://localhost:3000 — open a second tab to see two players.

## 2. Put it online (free) — Render.com

A game like this needs a server that stays running, which normal cPanel hosting
(robbangg.com) usually can't do. Render's free tier can.

1. Create a free account at **github.com**, make a new repository (e.g. `robban-snakes`)
   and upload all the files in this folder (not `node_modules`).
2. Create a free account at **render.com** → **New + → Web Service** → connect that GitHub repo.
3. Settings:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
4. Click **Create Web Service**. After ~2 minutes you get a link like
   `https://robban-snakes.onrender.com` — that's the game.

> Free tier note: the server sleeps after 15 minutes with nobody connected and takes
> about a minute to wake up. Open the game yourself a minute before you go live and it
> stays awake as long as anyone is playing. For zero wait, upgrade that one service to
> Render's cheapest paid instance.

## 3. Attach it to robbangg.com

### Option A — nice address: play.robbangg.com (recommended)
1. In Render → your service → **Settings → Custom Domains** → add `play.robbangg.com`.
2. Render shows a **CNAME** record. In cPanel → **Zone Editor** (or wherever your
   domain's DNS is) add: `play` → CNAME → the value Render gave you.
3. Wait for Render to verify (minutes to a few hours). Done: `https://play.robbangg.com`.

Then add a button anywhere on your site:

```html
<a href="https://play.robbangg.com" target="_blank"
   style="display:inline-block;padding:14px 28px;border-radius:12px;font-weight:800;
          color:#fff;text-decoration:none;background:linear-gradient(90deg,#2f7bff,#ff2d55)">
  🐍 PLAY SNAKE ARENA
</a>
```

### Option B — game inside a page of your site
Upload `embed/snake.html` from this folder to cPanel `public_html/` (so it opens at
`robbangg.com/snake.html`). Edit the one line in it with your Render (or play.robbangg.com) link.
Or paste this into any page:

```html
<iframe src="https://YOUR-GAME-LINK" style="width:100%;height:80vh;border:0;border-radius:16px"
        allow="fullscreen" title="ROBBAN Snake Arena"></iframe>
```

## 4. Use it on stream (OBS)

Add a **Browser Source** in OBS (1920×1080) with:

```
https://YOUR-GAME-LINK/?obs=1&join=Join at robbangg.com/snake
```

It shows the arena following the current #1 snake, the leaderboard, kill feed and your join banner.
Play yourself in a normal browser window at the same time.

## Settings (optional, Render → Environment)

| Variable      | Default | What it does                                   |
|---------------|---------|------------------------------------------------|
| `MIN_SNAKES`  | 12      | Bots keep the arena filled up to this many snakes (0 = no bots) |
| `MAX_PLAYERS` | 100     | Max human players at the same time             |

Extra link tricks: `?name=RobbaN` pre-fills the name box.

## Files
- `server.js` — game server (physics, collisions, bots, networking)
- `public/index.html` — the game page players see
- `embed/snake.html` — ready-made page for robbangg.com
