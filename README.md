# Minecraft Java Edition Bot — Render-Ready (2 Hours Online / 1 Hour Offline)

An original **Minecraft Java Edition** version inspired by the functionality of [jshmssn/bedrock-bot](https://github.com/jshmssn/bedrock-bot). Uses [Mineflayer](https://github.com/PrismarineJS/mineflayer) instead of Bedrock protocol.

## How the repeating schedule works

```text
START
  |
  v
JOIN MINECRAFT JAVA SERVER
  |
  +-- Join fails or server is asleep?
  |     \--> Wait 60 seconds --> Try joining again --> (repeat until joined)
  |
  v
CONNECTED, ACTIVE FOR 2 HOURS
  |  (Only successfully connected time counts)
  |  If disconnected unexpectedly, wait 60 seconds and retry.
  |  Resume the unused portion of the two-hour online quota.
  v
DISCONNECT COMPLETELY
  |
  v
STAY DISCONNECTED FOR 1 FULL HOUR
  |  (No retries and no AFK actions during this hour)
  v
TRY TO JOIN AGAIN
  |  If asleep, repeat attempts every 60 seconds.
  +-----------------------------------------> Repeat forever
```

**Timing example:** If the bot actually spawns at **12:00**, it disconnects at **14:00**, remains offline until **15:00**, then attempts to join again. If the attempt fails, it tries again at **15:01**, **15:02**, etc., until it spawns. On that new successful join it starts a fresh two-hour online quota.

A connection attempt is considered successful when Mineflayer emits `spawn`, not just when the network socket opens. If a connection is interrupted during the two-hour window, time spent offline or waiting to spawn is **not** counted toward those two hours.

**Important:** The bot process must stay running for this schedule to continue, even during the one-hour Minecraft break. Restarting the Node.js process resets its current two-hour/one-hour schedule; no external persistent state is included. A sleeping Minecraft hosting provider may require manual startup or a supported wake-up feature; retrying does not guarantee the server will wake. Use bots only on servers that permit them.

## Features

- Automatic join and rejoin, with one-minute retries after failed attempts.
- Two hours online (based on actual time in the world), one hour entirely disconnected, forever.
- A join-timeout watchdog (120 seconds by default) to avoid being stuck on a half-open connection.
- Java Edition protocol keep-alive packets are automatically handled by Mineflayer.
- Optional sneaking once every 5 minutes while online, not during offline periods.
- Logs public chat; replies when someone says `hello bot` (with per-player anti-spam cooldown).
- `offline` auth for offline-mode servers; Microsoft authentication for online-mode Java servers.
- Works as a Node.js process on Windows, Linux, Render Web Services, Replit Reserved VMs, VPS, or Railway (subject to hosting limits).
- Includes a tiny HTTP health server for Render (`/health`, `/ping`, `/status`), even while the Minecraft bot is deliberately disconnected.

## Quick start

1. Install [Node.js 22 or newer](https://nodejs.org/).
2. Extract the ZIP, open a terminal **inside the `minecraft-java-bot` folder**, and install dependencies:

   ```bash
   npm install
   ```

3. Create `.env` from `.env.example`:

   **Windows PowerShell**
   ```powershell
   Copy-Item .env.example .env
   ```
   **Windows Command Prompt**
   ```cmd
   copy .env.example .env
   ```
   **Linux / macOS**
   ```bash
   cp .env.example .env
   ```

4. Change server details in `.env`:

   ```env
   MC_HOST=play.example.net
   MC_PORT=25565
   MC_USERNAME=JavaBot
   MC_AUTH=offline
   MC_VERSION=auto

   ACTIVE_DURATION_MS=7200000
   REST_DURATION_MS=3600000
   RECONNECT_DELAY_MS=60000
   JOIN_TIMEOUT_MS=120000
   ```

   **Note:** `MC_AUTH=offline` works only if the Java server explicitly allows offline-mode accounts. For most public Java Edition servers, see the Microsoft sign-in instructions below.

5. Run:

   ```bash
   npm start
   ```

6. Stop the entire cycle with **Ctrl+C**. To verify scheduling behavior without connecting to a server, run `npm test`.

## Deploy on Render Free + an external HTTP monitor

**Render Free sleeps after approximately 15 minutes without INBOUND HTTP/WebSocket traffic.** Its TCP connection to Minecraft, timers, and internal keep-alives **do not count** as inbound traffic. An application cannot ping itself after it has been suspended. To reduce idle spin-downs, use a monitoring service outside Render that calls `https://YOUR-SERVICE.onrender.com/health` every 5 minutes. This method cannot prevent Render maintenance, restarts, plan limits, or platform policy changes.

### Deploy the files

1. Push this project's **contents** to your own GitHub repository. Do not push `.env` or `auth-cache/`.
2. In the [Render Dashboard](https://dashboard.render.com/), choose **New > Web Service**, select the GitHub repository, and configure:

   | Render setting | Value |
   | --- | --- |
   | Runtime | Node |
   | Instance | Free |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Health Check Path (optional) | `/health` |

   Alternatively, Render can deploy the included `render.yaml` as a **Blueprint**; supply the required `MC_HOST` and `MC_USERNAME` environment variables during setup.

3. Under Render **Environment**, configure your Minecraft connection details (`MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_VERSION`). Keep the default durations or set `ACTIVE_DURATION_MS=7200000`, `REST_DURATION_MS=3600000`, and `RECONNECT_DELAY_MS=60000`. You **do not** need to set `PORT`; Render provides it.
4. Deploy and open `https://YOUR-SERVICE.onrender.com/status`. You should receive JSON containing the cycle, connection state, and remaining active time. `/health` responds with `{"status":"ok"}` even during the one-hour Minecraft rest; this is intentional so the bot's scheduler keeps running.
5. In [UptimeRobot](https://uptimerobot.com/), create a free **HTTP(s) monitor** for `https://YOUR-SERVICE.onrender.com/health` with the free plan's 5-minute interval. Leave it enabled through **both** the Minecraft online and offline phases. Otherwise Render may stop the whole Node.js scheduler during the break.
6. Review the Render **Logs** to see the actual Minecraft bot join/disconnect events. An HTTP 200 only means the **Node.js service** is running, not necessarily that the Minecraft server is online.

**What you get:** The Node.js process stays awake under normal inbound-traffic conditions, while the **Minecraft connection** still cycles: 2 hours online -> 1 hour disconnected -> reconnect, then retry every minute until joined. Your computer does not need to be on.

**Limitations and caveats:**

- Render Free currently provides **750 instance-hours per workspace per calendar month**, shared by Free web services. Keeping this one service running for an entire 31-day month would use approximately **744 hours**. Additional Free services can exhaust the shared allowance. Render also retains the right to restart the service at any time.
- **Unexpected restarts and deploys reset the running cycle**. The bot does not currently preserve its remaining active time or one-hour rest deadline externally. If precise scheduling across host restarts is essential, use persistent storage and a restart-aware scheduler, or use a paid always-on host.
- Render Free has an **ephemeral filesystem**. `MC_AUTH=microsoft` caches sign-in tokens to files, which can be lost on redeploy/restart. The first sign-in can also require interaction. Use proper secure persistent token storage on a supported host, or choose a host with a persistent disk; never commit tokens to GitHub.
- External HTTP requests to Render **do not automatically wake the Minecraft server**. If the Minecraft host requires dashboard activation (or does not support join-triggered startup), the bot's one-minute retries will not start it on their own.
- Free hosting can have CPU/RAM limits, cold starts and restrictions; obey the hosting provider's and Minecraft server's terms.

### Replit alternative

A Replit **development workspace** can still go idle, regardless of whether your home PC stays on. If you use Replit, a **published Reserved VM / background worker** is a more appropriate continuous-runtime option, but it incurs compute charges. A cloud deployment does **not** require your local computer to remain powered on. For no-cost experimentation, try Render Free with external monitoring; for predictable 24/7 operation, choose a paid always-on VM or VPS.

## Main configuration

| `.env` setting | Default | Meaning |
| --- | --- | --- |
| `MC_HOST` | `localhost` | Java server hostname or IP address (no `http://` and no port in host) |
| `PORT` | `10000` | Render web-service HTTP port; Render sets this automatically |
| `MC_PORT` | `25565` | Java Edition TCP port |
| `MC_USERNAME` | `JavaBot` | Offline username or Microsoft account identifier/email |
| `MC_VERSION` | `auto` | Auto-detect Java version; can pin to an officially supported version |
| `MC_AUTH` | `offline` | `offline` or `microsoft` |
| `MC_ENGINE` | `official` | Official Mineflayer, or optional third-party `community` package |
| `ACTIVE_DURATION_MS` | `7200000` | Total connected time in one cycle (**2 hours**) |
| `REST_DURATION_MS` | `3600000` | Fully disconnected period (**1 hour**) |
| `RECONNECT_DELAY_MS` | `60000` | Wait after each failed attempt (**1 minute**) |
| `JOIN_TIMEOUT_MS` | `120000` | Restart a connection that has not spawned after 2 minutes; set `0` to disable |
| `AFK_ENABLED` | `true` | Perform optional sneak activity only while connected |
| `AFK_INTERVAL_MS` | `300000` | Sneak once every 5 minutes |
| `AFK_SNEAK_DURATION_MS` | `1000` | Hold sneak for 1 second |
| `CHAT_ENABLED` | `true` | Enable chat replies |
| `CHAT_TRIGGER` | `hello bot` | Trigger phrase, case-insensitive |
| `CHAT_REPLY` | greeting | `{player}` is replaced by the sender's name |
| `CHAT_COOLDOWN_MS` | `15000` | Do not repeat a reply to the same user for 15 seconds |
| `MC_AUTH_CACHE_DIR` | `./auth-cache` | Private directory for Microsoft authentication cache |

The schedule is implemented in `lib/runner.js` as a state machine; it **does not** start a separate program on every reconnect and it does not attempt joins during the one-hour offline interval.

## Microsoft sign-in for online-mode Java servers

Set:

```env
MC_AUTH=microsoft
MC_USERNAME=your-microsoft-account@example.com
```

Run `npm start`. Mineflayer prompts for a browser/device-code authentication the first time. Use a Microsoft account that owns Minecraft Java Edition. A token cache is saved in `auth-cache/` so future reconnects should not normally need a new manual sign-in. Protect your `.env` and `auth-cache` files; never commit or upload them to a public repository.

If the first sign-in takes longer than 2 minutes, change `JOIN_TIMEOUT_MS` to `600000` (10 minutes) for setup, or `0` to disable the timeout. When deploying to a hosted container, persist the authentication cache on private storage and do not rely on an interactive login prompt after restarting an unattended worker.

## Java Edition version compatibility

The official Mineflayer documentation currently lists support through **Java 26.1**. The default is `MC_ENGINE=official` and `MC_VERSION=auto`; it works only with server protocol versions that the installed Mineflayer supports.

If your server is **Java 26.3**, an *unofficial* fork advertises support but has **not been validated against a live server in this project**. If you decide you trust it:

```bash
npm install @wp2508/mineflayer@4.42.7
```

Then set:

```env
MC_ENGINE=community
MC_VERSION=26.3
```

If the fork is unavailable or fails on your server, use a Java server version supported by official Mineflayer or a compatible protocol translation solution. Do not assume official Mineflayer can communicate with an unsupported version.

## Other deployment notes

- `npm start` runs both the HTTP health server (`PORT` defaults to 10000) and the Minecraft bot. The Minecraft server is an **outbound** TCP connection; do not put port 25565 into Render's `PORT` field.
- The included Dockerfile uses Node.js 22; `docker build -t java-bot .` and `docker run --env-file .env -p 10000:10000 java-bot` work for basic offline-mode environments (mount a private volume if Microsoft token cache persistence is required).
- Some Minecraft servers reject automation, AFK movements, or frequent joins; respect the server's rules.

## Troubleshooting

- **Server asleep or refused connection:** The bot retries one minute after each failure. It does not automatically turn on all hosting providers; check whether the provider supports joining to wake the server.
- **Online-mode auth error:** Use `MC_AUTH=microsoft` and a real account with Minecraft Java Edition access.
- **Version not supported:** Upgrade Mineflayer or choose a compatible server protocol.
- **Bot never leaves "connecting":** The join watchdog ends the connection after `JOIN_TIMEOUT_MS` and schedules a retry.
- **AFK kick:** Sneaking is optional and does not guarantee bypassing inactivity systems.
- **Unexpected full process restart:** The 2h/1h schedule restarts from the beginning. Persisted scheduling across process restarts is not included.
- **Render deploy complains about missing port:** This Render-ready release binds to `0.0.0.0:$PORT`; ensure you deployed this version and used `npm start`.
- **Render goes to sleep:** Check whether UptimeRobot is sending **inbound HTTP requests** to `/health` every five minutes. Render itself can still restart or suspend the service.
- **HTTP responds but bot is not in Minecraft:** Open `/status` and Render logs; `/health` intentionally checks the Node.js process, including the scheduled Minecraft rest.

## Tests

Run `npm test` for offline, clock-simulated tests covering repeated 2h/1h cycles, one-minute retries while the server is asleep, partial online-time accumulation after drops, join timeout, chat, AFK, timer cleanup, and the Render HTTP health server. These tests do **not** replace a live Minecraft server compatibility test.
