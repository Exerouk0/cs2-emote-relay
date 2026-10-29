# CS2 emote relay: setup from scratch

This is a small Node.js WebSocket relay. CS2 still runs movement, collision and hit registration. This server sends emote names, start times and group seats. It never receives meshes, frame poses or game physics.

## 1. Put the server on GitHub

1. Unzip `relay-server.zip` into a new empty folder.
2. Create a new GitHub repository called `cs2-emote-relay`. **Public is fine** and lets other people inspect and host their own relay. A private repository works too.
3. Open the repository and choose **Add file → Upload files**.
4. Upload the **contents** of the extracted folder. You should see `server.js`, `package.json`, `package-lock.json`, `catalog.json` and `render.yaml` at the repository's top level. Do not upload `node_modules`.
5. Commit the upload.

If you instead upload this entire source workspace, the server lives under `relay/`: use `relay` as Render's Root Directory in the next section. For the supplied standalone ZIP, leave Root Directory blank.

## 2. Deploy on Render

1. Sign in at [Render](https://dashboard.render.com/).
2. Choose **New → Web Service**.
3. Connect GitHub and select the repository you created.
4. Set:

   | Setting | Value |
   |---|---|
   | Name | Any available name, for example `my-cs2-emotes` |
   | Region | Closest to your players, e.g. Frankfurt for central Europe |
   | Language / Runtime | Node |
   | Branch | Your repository's default branch |
   | Root Directory | Blank for the standalone ZIP |
   | Build Command | `npm ci --omit=dev` |
   | Start Command | `npm start` |
   | Instance Type | Free for testing, paid for reliable availability |
   | Health Check Path | `/healthz` |

5. Under Environment, set `RELAY_TOKEN` to the access code used by your clients. For the supplied DLL's default server, use the distributed code configured in `src/core/Config.h`. This code is visible to everyone receiving the DLL or config; it is **not a private credential or proof of player identity**. A self-hosted relay can use its own shared code, or omit `RELAY_TOKEN` to accept clients without one. Keep actual hosting credentials and API keys private.
6. Click **Deploy Web Service**. Wait for the log line `Emote relay listening; protocol 1` and a Live status.
7. Render shows a URL such as `https://my-cs2-emotes.onrender.com`.
8. Open `https://my-cs2-emotes.onrender.com/healthz`. A working server returns JSON containing `"ok":true`, a protocol number and a catalog ID.

The server listens on Render's `PORT` automatically. You do not open a separate WebSocket port. Render supplies HTTPS/WSS certificates.

## 3. Point the DLL at the shared relay

The DLL automatically connects to `wss://cs2-emote-relay.onrender.com/v1` with sharing ON by default. New configs receive these defaults. On injection, older configs automatically gain the missing sharing and join-key settings; missing or blank relay URL and default-server access-code fields are populated too. Existing OFF settings, custom addresses, room codes and key bindings are preserved. No config deletion, pack redownload or manual config editing is needed to use the default server with this DLL.

The server's `RELAY_TOKEN` must match the DLL's distributed access code. This is a shared code visible in the DLL and config, not a private server secret. Hosting account passwords and API keys must never be put into the DLL or config.

The following manual steps are only for connecting to a different, self-hosted relay:

For automatic sharing in a match, every client must use the same relay URL and compatible emote catalog. The DLL automatically groups clients by the CS2 match ID and broadcasts active emotes; players do not need to enter a room code for a normal match. The **join key is only for taking a Fortnite group-emote role** (such as joining the Chugga-Chugga wagon). It is not needed to see another player's ordinary emote.

1. Close CS2 before editing the config.
2. Open **Documents → Emotes → emotes.ini**.
3. Under the existing `[emotes]` section, set these keys. Replace the example hostname and token:

```ini
multiplayer=1
relay_url=wss://my-cs2-emotes.onrender.com/v1
relay_token=YOUR_SHARED_ACCESS_CODE
relay_room=
```

Sharing defaults to ON even when older configs lack `multiplayer`.

4. Save the config, start CS2 and inject the new DLL.
5. Open the wheel's Settings tab. **SHARE EMOTES** is animated and defaults to ON. Its subtitle reports the connection:

   | Status | Meaning |
   |---|---|
   | SET SERVER URL | `relay_url` is empty |
   | WAITING FOR MATCH / ROOM | No usable Steam ID or room yet |
   | CONNECTING | Opening the WebSocket |
   | CONNECTED | Joined the relay room |
   | RECONNECTING | Retrying after a connection failure |
   | OFF | Sharing disabled |

6. Give each participant the same DLL version, emote pack, server URL and token.
7. Join the same match and start a Fortnite emote. Other connected participants render it on your existing CS2 pawn. Players without this DLL see ordinary CS2 behavior.

The DLL derives an automatic room from `C_CSGameRules.m_ullLocalMatchID`. Some local/community sessions expose zero or lack this field. For those matches, put the same unique room code in everyone's `relay_room`. Use a different code for a different session.

### Lobby / main menu

The main menu has no CS2 match ID to group by. For menu sharing, set the same `relay_room=friends-friday` (or another unique code) on every participant's client. A nonempty room is an explicit override in menus **and in matches**; clear it when you want automatic match grouping again. Automatic menu grouping would require a stable lobby identifier supplied by the game or a separate friend/lobby discovery service.

The main menu lacks the remote in-match pawn entities. The DLL therefore draws up to seven remote Fortnite emote previews beside your local preview, using your available local agent model as the stand-in. It does not download another player's loadout. Native CS2 pose clips are shared in matches; lobby stand-ins use the Fortnite catalog.

## 4. Join an emote

1. Keep SHARE EMOTES on and verify CONNECTED on both clients.
2. Have one player start one of these emotes:

   | Emote | Joining behavior |
   |---|---|
   | Chugga-Chugga | A passenger with the exported wagon animation follows the leader's recorded path. Up to 32 wagon seats. |
   | Lil' Supercar | Up to three joining drivers use blue, purple and gold vehicles. The leader keeps red. |
   | Get Schwifty | One joining player takes the exported partner role. |
   | In The End | Up to three joining players take the exported instrument roles. |
   | Bazooka | One joining player takes the exported partner role. |

3. Approach within 220 CS2 units of a leader. Press E when **[E] Emote Together** appears.
4. The relay assigns a free seat and the leader's original start timestamp. A real participant replaces the corresponding decorative copy.
5. Use your existing Stop Emoting key (F6 by default) to leave. When the leader stops, switches emotes or disconnects, its group is disbanded.

The wording is from the installed English Fortnite localization: `Fortnite_locchunk10.locres`, namespace `FortPlayerPawn`, key `GroupEmote`, value `Emote Together`. The five supported group emotes were confirmed from their exported item definitions. This is not a claim that every Fortnite group emote has already been ported.

Group placement is a local visual effect. It does not teleport CS2's real pawn, alter hitboxes, or let the relay drive movement. To physically travel together, players still use CS2 movement.

## 5. Set up UptimeRobot

UptimeRobot monitors the HTTP health endpoint. **Render hosts the server; UptimeRobot does not.**

1. Sign in at [UptimeRobot](https://dashboard.uptimerobot.com/).
2. Choose **Add New Monitor** / **New Monitor**.
3. Select **HTTP(s)** / **HTTP / Website**.
4. Name it `CS2 emote relay`.
5. Use `https://my-cs2-emotes.onrender.com/healthz` as the monitored URL. Replace the hostname.
6. Use GET and a five-minute interval on the free plan. Expected status is HTTP 200. If your UI offers a keyword check, use `"ok":true`.
7. Choose your notification destination and create the monitor.
8. Trigger the monitor's manual check if offered. Verify that it becomes UP.

Render's free service can sleep after 15 minutes without incoming HTTP requests or WebSocket messages; waking can take about a minute. This client sends application pings while connected, so active sessions provide inbound traffic. Five-minute health checks also provide traffic while idle, but monitoring cannot guarantee continuous availability or bypass Render's quotas/restarts. Render currently provides 750 free instance hours per workspace per month. Use a paid instance if interruptions are unacceptable.

## 6. Updating the pack and server

Upload the supplied updated **Emotes.zip** to the existing CS2 emote-pack release. It contains the new joined car resources and the full restored music. The DLL's existing updater installs that pack; the relay does not distribute assets.

When exporting more emotes, run:

```powershell
py tools/generate_relay_catalog.py
```

Then rebuild the DLL and deploy the corresponding `relay/catalog.json`. The catalog fingerprint separates clients with different animation tables so they do not apply an incompatible sequence index. Wire IDs use stable sequence names, never a menu row index. The server checks emote names against the generated catalog. The Supercar prop publishing path rebuilds its joined color variants automatically.

## How synchronization works

* The client samples only local CS2 entities. It sends `hello`, `start`, `stop`, `join` and occasional clock pings.
* The relay owns room membership and seats. It attaches the connection's identity to each change; an event body cannot target a different player.
* A start carries its absolute server-clock time. Clock pings estimate the offset from Windows' monotonic clock using the lowest round-trip sample. Animation phase and WAV seeking use elapsed time from that start. Songs play to completion and loop without being cut by a short body animation.
* New connections receive a reset, active state records and a snapshot-end marker. Late joiners immediately seek to the current animation and audio phase.
* Reconnects use bounded backoff and reannounce the original local start. State carries a server epoch and increasing revision; disconnects remove peers and reclaim empty rooms.
* Only one nearby remote song is selected at a time, with your own emote taking priority. This limits audio work and avoids stacking multiple copies of the same group music.
* HTTP/WebSocket work runs off the game/render thread. Packet payloads are capped at 4 KB, room size at 64, pending output at 64 KB per client, and event rate at a 40-message burst / 10 messages per second. There are no animation-frame packets, physics updates or databases.

The server is intentionally one instance with in-memory state. Do not scale it to multiple independent Render instances: clients in the same room could be split. Add Redis pub/sub and shared seat ownership before horizontal scaling.

### Identity and access limits

`RELAY_TOKEN` controls access to your relay; TLS protects it in transit. Steam IDs are client-reported, not cryptographically authenticated Steam session tickets. In matches the DLL also requires a matching existing local CS2 player before rendering an event, but a modified authorized client could still impersonate another reported Steam ID. For a public service that must resist malicious authorized clients, add Steam ticket authentication before accepting `hello`. A shared token in a distributed DLL is not a substitute for account authentication.

## Local development / verification

```powershell
cd relay
npm ci
npm test
npm start
```

Local URL: `ws://127.0.0.1:10000/v1`; health: `http://127.0.0.1:10000/healthz`. Plain WebSockets are accepted by the DLL only for localhost. Hosted connections require WSS/HTTPS. Native WinHTTP integration tests run on Windows when `work/native_regression/build/Release/production_relay_probe.exe` has been built. The tests exercise the production transport, not a simulated C++ client.

## Troubleshooting

* **Health URL does not load:** check Render's deploy log, build/start commands and Root Directory. Wait for a free service to wake.
* **Health works but CONNECTED never appears:** the DLL URL needs `/v1`; UptimeRobot uses `/healthz`. Check the token and allow outbound HTTPS.
* **Both connected but no remote emotes:** verify the same match/room, matching DLL/catalog and pack. In a local game, set the same `relay_room` explicitly. Steam ID zero/bots cannot advertise as human Steam users.
* **Emote Together does not appear:** the leader must be performing one of the five supported group emotes, not already following someone else; approach closer and close the wheel.
* **A joined vehicle does not appear:** ensure the new pack contains `lil_supercar_join1.vmdl_c`, `lil_supercar_join2.vmdl_c` and `lil_supercar_join3.vmdl_c` and their compiled material/texture dependencies.
* **Server restarts:** clients reconnect and republish active state automatically. RAM-only state is expected to reset on deployment.

## Sources checked

* [Epic: traversal, beat-synced and synced emotes](https://www.epicgames.com/help/c-34254770/c-33726977/a10354219)
* [Epic: Lil' Supercar — Group Emote](https://www.fortnite.com/item-shop/emotes/lil-supercar-48e96744?assetType=Bundle&itemNotAvailable=true&title=Bundle+CCFN+C5S1)
* Installed Fortnite item definitions and English localization, inspected with this workspace's extractor.
* [Render: WebSockets](https://render.com/docs/websocket)
* [Render: free instances and their limits](https://render.com/docs/free)
* [UptimeRobot: free monitoring](https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan)
* [Microsoft: WinHTTP concurrency and cancellation](https://learn.microsoft.com/en-us/windows/win32/winhttp/concurrency-in-winhttp)
