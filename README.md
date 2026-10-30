# CS2 emote relay: setup from scratch

This is a small Node.js WebSocket relay. CS2 still runs movement, collision and hit registration. This server sends emote identifiers and start times. It never receives meshes, frame poses or game physics.

The relay accepts valid emote identifiers from new packs without a bundled allowlist. New emotes do not require another server deployment. Clients still use their catalog fingerprint to share a room only with compatible DLLs; each client renders identifiers supported by its installed pack. `catalog.json` describes the bundled pack for diagnostics.

## 1. Put the server on GitHub

1. Unzip `relay-server.zip` into a new empty folder.
2. Create a new GitHub repository called `cs2-emote-relay`. **Public is fine** and lets other people inspect and host their own relay. A private repository works too.
3. Open the repository and choose **Add file â†’ Upload files**.
4. Upload the **contents** of the extracted folder. You should see `server.js`, `package.json`, `package-lock.json`, `catalog.json` and `render.yaml` at the repository's top level. Do not upload `node_modules`.
5. Commit the upload.

If you instead upload this entire source workspace, the server lives under `relay/`: use `relay` as Render's Root Directory in the next section. For the supplied standalone ZIP, leave Root Directory blank.

## 2. Deploy on Render

1. Sign in at [Render](https://dashboard.render.com/).
2. Choose **New â†’ Web Service**.
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

The DLL automatically connects to `wss://cs2-emote-relay.onrender.com/v1` with sharing ON by default. New configs receive these defaults. On injection, older configs automatically gain missing sharing settings; missing or blank relay URL and default-server access-code fields are populated too. Existing OFF settings, custom addresses, room codes and key bindings are preserved. No config deletion, pack redownload or manual config editing is needed to use the default server with this DLL.

The server's `RELAY_TOKEN` must match the DLL's distributed access code. This is a shared code visible in the DLL and config, not a private server secret. Hosting account passwords and API keys must never be put into the DLL or config.

The following manual steps are only for connecting to a different, self-hosted relay:

For automatic sharing in a match, every client must use the same relay URL and compatible emote catalog. The DLL automatically groups clients by the human Steam IDs visible in the CS2 server and broadcasts active emotes; players do not need to enter a room code for a normal match. Each participant performs the emote on their own existing character model.

1. Close CS2 before editing the config.
2. Open **Documents â†’ Emotes â†’ emotes.ini**.
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
   | WAITING FOR STEAM | The local Steam identity is unavailable |
   | FINDING LOBBY / SESSION | Looking for a joined Steam lobby or game roster |
   | CONNECTING | Opening the WebSocket |
   | CONNECTED | Joined the relay room |
   | RECONNECTING | Retrying after a connection failure |
   | OFF | Sharing disabled |

6. Give each participant the same DLL version, emote pack, server URL and token.
7. Join the same match and start a Fortnite emote. Other connected participants render it on your existing CS2 pawn. Players without this DLL see ordinary CS2 behavior.

In games, including private practice and community servers, the DLL builds a deterministic room from the sorted human player roster. It does not require a Valve matchmaking ID. Bots are ignored. When a player joins or leaves, clients converge to the new roster room and retain their original emote start timestamp. Allow a few seconds for roster replication and reconnection after a session change.

### Lobby / main menu

Join the same CS2 party/lobby and keep `relay_room=` blank. The DLL reads the current matchmaking session and Steam lobby information, then verifies that your own Steam ID is an actual lobby member before choosing that room. Friend presence can supply lobby candidates, but simply having a friend playing CS2 does not put you in their room. Both clients need sharing ON and the same relay/catalog.

`relay_room` remains an optional manual override for custom sessions; it applies in menus and matches. Leave it blank for automatic discovery.

The DLL maps Steam IDs using the same ordered PartyListAPI collection as CS2's main-menu script, then replaces each dancing member's actual `dynamic_player` preview in its existing position using that preview's agent model. It hides the original while the replacement dances and restores it afterward. Unmapped or unloaded slots are skipped instead of inventing a position or copying your own agent. The built-in CS2 clip tab has been removed; the Fortnite Dances and Emotes tabs remain.

## 4. Set up UptimeRobot

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

## 6. Updating your relay

When a new relay release is provided, update your server repository with its files, including `catalog.json`, and redeploy. Use the relay release matching your clients' DLL version. The catalog separates incompatible versions into different rooms.

Hosting a relay does not require uploading an emote ZIP or maintaining an emote-pack release. Players' DLLs download assets through the existing pack updater; the relay only sends emote state.

## How synchronization works

* The client samples only local CS2 entities. It sends `hello`, `start`, `stop` and occasional clock pings.
* The relay owns room membership and seats. It attaches the connection's identity to each change; an event body cannot target a different player.
* A start carries its absolute server-clock time. Clock pings estimate the offset from Windows' monotonic clock using the lowest round-trip sample. Animation phase and WAV seeking use elapsed time from that start. Songs play to completion and loop without being cut by a short body animation.
* New connections receive a reset, active state records and a snapshot-end marker. Late joiners immediately seek to the current animation and audio phase.
* Reconnects use bounded backoff and reannounce the original local start. State carries a server epoch and increasing revision; disconnects remove peers and reclaim empty rooms.
* The nearest audible remote song uses continuous distance attenuation and equal-power headphone panning from the rendered camera's right axis. Your own song retains its original stereo channels and takes priority. Mono source WAVs are expanded to stereo output before positioning. Live gains ramp across audio blocks to avoid clicks; volume never changes CS2's process-wide sound level.
* HTTP/WebSocket work runs off the game/render thread. Packet payloads are capped at 4 KB, room size at 64, pending output at 64 KB per client, and event rate at a 40-message burst / 10 messages per second. There are no animation-frame packets, physics updates or databases.

The server is intentionally one instance with in-memory state. Do not scale it to multiple independent Render instances: clients in the same room could be split. Add Redis pub/sub and shared seat ownership before horizontal scaling.

### Identity and access limits

`RELAY_TOKEN` controls access to your relay; TLS protects it in transit. Steam IDs are client-reported, not cryptographically authenticated Steam session tickets. In matches the DLL also requires a matching existing local CS2 player before rendering an event, but a modified authorized client could still impersonate another reported Steam ID. For a public service that must resist malicious authorized clients, add Steam ticket authentication before accepting `hello`. A shared token in a distributed DLL is not a substitute for account authentication.

## Local development / verification

Compatible clients load new emote definitions from `Emotes/emote-catalog.json`.
Keep that file in pack ZIPs; the exporter/release builder generates it automatically.
Adding asset-pack emotes no longer requires a client DLL or relay redeployment.
Clients use the stable `fnemotes-state-v1` relay namespace rather than a table hash.

Deploy this server version once for shared song timelines: `musicStart` is the
same for everyone playing one emote, survives the first dancer leaving, and is
sent in late-join snapshots. Animation starts remain independent. Existing
servers still relay emotes, but lack this persistent shared song epoch.

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
* **Both connected but no remote emotes:** verify the same match/room, matching DLL/catalog and pack. Leave `relay_room` blank for automatic discovery, or make sure any manual override matches. Look for `relay-session` lines in `Documents/Emotes/emotes.log` to compare the detected mode, Steam ID, human count, lobby and room. Steam ID zero/bots cannot advertise as human Steam users.
* **Server restarts:** clients reconnect and republish active state automatically. RAM-only state is expected to reset on deployment.

## Sources checked

* [Epic: traversal, beat-synced and synced emotes](https://www.epicgames.com/help/c-34254770/c-33726977/a10354219)
* [Epic: Lil' Supercar â€” Group Emote](https://www.fortnite.com/item-shop/emotes/lil-supercar-48e96744?assetType=Bundle&itemNotAvailable=true&title=Bundle+CCFN+C5S1)
* Installed Fortnite item definitions and English localization, inspected with this workspace's extractor.
* [Render: WebSockets](https://render.com/docs/websocket)
* [Render: free instances and their limits](https://render.com/docs/free)
* [UptimeRobot: free monitoring](https://help.uptimerobot.com/en/articles/11604710-who-should-use-uptimerobot-s-free-plan)
* [Microsoft: WinHTTP concurrency and cancellation](https://learn.microsoft.com/en-us/windows/win32/winhttp/concurrency-in-winhttp)

## Emote joining

Deploy the joining-capable server and client DLL once. The host advertises bounded role/variant counts from its pack catalog. The server reserves a unique role on `join`, publishes an approaching participant, and activates it on `ready`. Participants inherit the host's animation/song epochs. A host switch, stop, disconnect or room change removes dependent participants; a non-traversal participant cancellation stops its group. Vehicle colors are assigned on the server, exclude the red host color, prefer unused non-red variants, and remain in snapshots.

The server remains a signaling relay. It does not move pawns or run terrain/physics. Clients handle proximity prompts, direct approach input, formation rendering and movement cancellation against CS2's native pawn state. Positions and Steam IDs remain client-reported/trusted within the existing relay model. Adding supported participant assets later does not require a server catalog update.
