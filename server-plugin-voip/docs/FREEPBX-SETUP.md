# FreePBX setup runbook (agent prompt)

This is an instruction set for an AI agent configuring a **FreePBX 17 / Asterisk
20 (PJSIP)** box from scratch so it can act as the PBX side of this plugin —
placing/receiving real calls through a wholesale SIP trunk, and exposing ARI so
`server-plugin-voip` can observe, redirect, and record them. It's written from
a real, working end-to-end setup (trunk, 8 DIDs, ring-group hunting, ARI over
HTTPS, live recording, transcription) — every step below was actually run
against a live FreePBX GUI, and every gotcha was a real multi-hour debugging
session, not a hypothetical. Follow it in order; each section notes what to
ask the user for before touching the GUI.

Everything here is done through the FreePBX web GUI (Admin/Applications/
Connectivity/Settings menus) plus the Asterisk CLI page (Admin → Asterisk
CLI) for verification. SSH/shell access is not assumed for the FreePBX steps;
where it's genuinely needed, that's called out explicitly.

## Before starting — collect these from the user

Don't guess any of these. Ask up front, in one batch if possible:

1. **FreePBX admin URL + login** (e.g. `https://pbx.example.com`, username/password).
2. **SIP trunk provider details** — whatever they were given by their carrier:
   - SIP server host/IP
   - Outbound peer username + secret/password
   - Inbound context/registration string if provided (informs whether
     Registration should be Send/Receive/None — Send is by far the most
     common for a wholesale trunk customer)
   - Outbound CallerID number to present on calls
3. **The DID numbers** being provisioned (the actual phone numbers that ring
   in from the PSTN).
4. **Default hunt/ring behavior** — which internal extensions or external
   mobile numbers should ring when one of the DIDs is called, and in what
   order/strategy (ringall vs. hunt).
5. **Whether whitebox-pro's ARI observer/recording feature is wanted at all**
   for this box. If yes, also get: the hostname the whitebox server will
   use to reach this PBX, and the IP/CIDR of the whitebox server itself (for
   firewall trust).
6. **Whether HTTPS is required for ARI**, or whether HTTP scoped to a trusted
   subnet is acceptable. If HTTPS: a domain name that resolves to this PBX
   and an admin email for Let's Encrypt.
7. **Whether call recording + transcription is wanted.** If yes, confirm the
   spoken language(s) on these calls (affects transcription quality/config —
   see step 8).

## 1. Trunk (Connectivity → Trunks → Add Trunk → PJSIP)

**General tab:**
- Trunk Name: see the gotcha below — **name the trunk exactly as the SIP
  username the provider gave you**, not a descriptive label. Explanation
  under Gotchas.
- Outbound CallerID: the number from the user. Don't leave this blank —
  FreePBX blocks Submit with a native `confirm()` dialog if you do, which
  hangs browser automation (see Gotchas).

**pjsip Settings → General tab:**
- Username / Auth username: leave blank (see Gotchas — the trunk *name*
  covers this).
- Secret: the provider's password.
- Authentication: **Outbound** — not "Both". "Both" makes Asterisk challenge
  *inbound* INVITEs for digest auth too; most wholesale providers don't
  answer that challenge on real calls (only registration), so real inbound
  calls get silently rejected with "Failed to authenticate" even though
  registration and OPTIONS keepalives work fine. Outbound-only still lets us
  authenticate *to* the provider (needed for registration) while trusting
  their inbound traffic via IP match instead of digest.
- Registration: **Send** (this PBX registers out to the provider — standard
  for a trunk customer). Only use Receive/None if the user's provider
  details say otherwise.
- SIP Server: provider's SIP server IP/host.
- Context: `from-pstn` (FreePBX's own default inbound context — don't
  invent a custom one unless the user has a specific reason to).
- Transport: the default `0.0.0.0-udp` unless the user specifies TLS/TCP.

**pjsip Settings → Advanced tab:**
- Allow Unauthenticated: **Yes**. Note this only exempts OPTIONS pings from
  auth, not INVITEs — the real fix for inbound calls is the Authentication
  setting above, not this one. Still set it to Yes; it's needed for the
  OPTIONS keepalive exchange to stay clean.

Submit, then **Apply Config**.

**Verify via Asterisk CLI** (Admin → Asterisk CLI):
```
pjsip show endpoints
```
Look for `Contact: .../sip:<name>@<ip>  <hash>  Avail  <rtt>ms` — confirms
registration succeeded. If it shows `Unregistered` or the contact is
missing, re-check Secret and Registration direction before anything else.

## 2. Outbound Route (Connectivity → Outbound Routes)

A single catch-all route is usually sufficient unless the user specifies
otherwise:
- Dial Pattern: `.` (matches anything)
- Trunk Sequence: the trunk from step 1

## 3. Default hunt/ring destination (Applications → Ring Groups)

Ask the user for the ring strategy and target numbers if not already
gathered. Typical setup:
- Ring Strategy: `hunt` (or `ringall` if the user wants all targets to ring
  simultaneously)
- Extension List: one target per line. **External numbers need a trailing
  `#`** (e.g. `0894319536#`) — FreePBX's own inline help confirms this dials
  the number "on the appropriate trunk" without needing a separate Misc
  Destination object.
- Ring Time: 20s is a reasonable default; ask if unsure.
- Destination if no answer: Hangup, unless the user wants voicemail/another
  destination.

Note the ring group's extension number (e.g. `600`) — you'll need it in
step 6 if the whitebox ARI observer is being wired in.

## 4. Inbound Routes (Connectivity → Inbound Routes) — one per DID

For each DID number from the user's list:
- DID Number: the number, in whatever national format FreePBX shows for
  the others (match existing convention on the box).
- CallerID Number: `any` unless told otherwise.
- Set Destination: the Ring Group from step 3 — **for now**. If ARI/
  whitebox is being wired in (step 6), this gets repointed to a Custom
  Destination later; don't skip ahead.

**Do all of them.** It's easy to set up the pattern on DID #1, verify it,
and then forget to repeat it for the rest — verify count matches the DID
list before moving on (`Connectivity → Inbound Routes` shows all rows;
count them against the user's list).

Apply Config.

## 5. Firewall (Connectivity → Firewall → Networks tab)

Two entries are needed here, and **neither is automatic** — FreePBX's
Responsive Firewall only auto-trusts peers that register *into* this PBX
(extensions), not providers this PBX registers *out* to. A trunk's provider
IP is never auto-trusted no matter how successful registration is.

1. **The trunk provider's IP** (from step 1's SIP Server field) —
   add as `<ip>/32`. Use zone **Local**, not Trusted, unless the user
   specifically asks for Trusted — Local is the least-privilege choice that
   still lets inbound SIP through. Without this entry at all, inbound
   INVITEs from the provider are silently dropped — no log entry at all,
   not even a rejection. (Registration/OPTIONS still work because those
   ride on connections this PBX itself opened, which connection-tracking
   already permits — only *unsolicited* inbound INVITEs are affected, which
   is exactly what fails without this.)
2. **The whitebox server's IP/CIDR** (if wiring in ARI — step 6) — needed so
   the whitebox server can reach the ARI ports (8088/8089) at all. Same
   zone guidance: Local unless told otherwise.

Save, then **Apply Config** (this tab applies immediately — no separate
config regen needed, but Apply Config doesn't hurt).

## 6. ARI + whitebox observer wiring (skip if not using server-plugin-voip)

### 6a. Enable ARI

Settings → Advanced Settings → search/scroll to "Asterisk REST Interface" →
Enable the Asterisk REST Interface = Yes. Submit + Apply Config.

### 6b. Create the ARI user

Settings → Asterisk REST Interface Users → Add User. Username `whitebox`
(matches the Stasis app name used below — keep them the same unless you have
a reason not to). Set a password (generate one if the user doesn't supply
one).

### 6c. Custom dialplan (Admin → Config Edit → `extensions_custom.conf`)

This inserts the ARI observer *ahead of* the existing Ring Group. Replace
`<RING_GROUP_EXTEN>` with the ring group's extension number from step 3
(e.g. `600`):

```
[whitebox-observe]
exten => s,1,NoOp(whitebox observer: caller ${CALLERID(num)} -> DID ${CALLERID(dnid)})
 same => n,Goto(whitebox-observe,${CALLERID(dnid)},1)

exten => _X.,1,Stasis(whitebox)
 same => n,Goto(ext-group,<RING_GROUP_EXTEN>,1)
```

That's the whole thing — **do not add a separate `[whitebox-continue]`
context that the ARI code `continue`s into by name.** An earlier version of
this integration did exactly that (explicit `context`/`extension`/`priority`
params on the ARI `continue` call, jumping into a second context), and on
real PJSIP trunk channels — not on Local/test channels, which is why it went
unnoticed in initial testing — Asterisk accepts that `continue` call (`204`)
but silently defers actually executing it, sometimes for over a minute. Real
callers hang up long before it ever takes effect. The fix, baked into
`ari.js` already, is a **bare** `continue` (no explicit target) — it resumes
at the very next priority in the *same* context Stasis() was called from,
which is exactly the `Goto(ext-group,...)` line above, and it takes effect
immediately. Keep the dialplan shaped so that line is always the next
priority after `Stasis(whitebox)` — don't introduce a cross-context jump for
the handoff. See the Gotchas section for the full story; it also covers two
related fixes already implemented in `ari.js` (snoop-channel recording, and
explicit event re-subscription) that depend on this same shape.

Save, then **Apply Config** (or continue to 6d/6e first and apply once —
either order is fine now that there's no multi-context dependency to get
half-applied).

Why entering at extension `s` and immediately re-`Goto`-ing to
`${CALLERID(dnid)}` (the actual DID, a core Asterisk channel variable set
before any dialplan runs): it means `channel.dialplan.exten` is the real DID
by the time `StasisStart` fires — `ari.js` relies on this to resolve which
`lines[]` entry the call belongs to.

### 6d. Custom Destination (Admin → Custom Destinations)

- Target: `whitebox-observe,s,1`
- Description: something identifiable, e.g. "Whitebox Observer"
- Return: No

### 6e. Repoint every Inbound Route

Go back to **every** Inbound Route from step 4 and change Set Destination
from the Ring Group to Custom Destinations → the one just created. Verify
by re-listing Inbound Routes afterward — every row's Destination column
should say "Custom Destinations: <name>", not "Ring Groups: ...". This is
the same easy-to-miss-one-DID trap as step 4.

Apply Config.

### 6f. Verify

Asterisk CLI:
```
ari show apps
```
Should list `whitebox` once the whitebox server has connected (it registers
the app on connect, not on PBX boot — start/restart the whitebox server
first if this list is empty).

```
dialplan show whitebox-observe
```
Confirm there's exactly one context, with `Stasis(whitebox)` at priority 1
of the `_X.` extension and `Goto(ext-group,<RING_GROUP_EXTEN>,1)` at
priority 2 — **not** a separate context. If you see a `[whitebox-continue]`
context anywhere in `extensions_custom.conf`, that's leftover from the old
broken approach; remove it.

```
dialplan show ext-did-0002
```
(or whichever `ext-did-*` context holds the DIDs — check with
`dialplan show ext-did` for the include list) — the final step for each DID
should be `Goto(whitebox-observe,s,1)`, not `Goto(ext-group,...)` directly.

## 7. TLS for ARI (only if the user asked for HTTPS)

### 7a. Certificate

Admin → Certificate Management → **+ New Certificate → Generate Let's
Encrypt Certificate**. Needs port 80 reachable from the internet (Let's
Encrypt's HTTP-01 challenge — verify with a plain `curl http://<host>:80/`
from outside first if unsure). Fill in the hostname + email from the user.
Once issued, click the **Default** checkmark next to it in the certificate
list — this copies it into `/etc/asterisk/keys/integration/` where
Asterisk's built-in mini-HTTP server picks it up.

### 7b. Bind addresses

Settings → Advanced Settings → "Asterisk Builtin mini-HTTP server" section:
- HTTPS Bind Address: `0.0.0.0` (default is `127.0.0.1` — loopback-only,
  meaning nothing external, including the whitebox server, can ever reach
  it regardless of firewall rules downstream). Same for HTTP Bind Address
  if plain HTTP is also needed.
- Enable TLS for the mini-HTTP Server: Yes.

Submit + Apply Config.

### 7c. Verify

From the whitebox server (or anywhere outside the PBX box):
```
curl -sS -o /dev/null -w "%{http_code}\n" -u <ari_user>:<ari_pass> https://<host>:8089/ari/asterisk/info
```
Expect `200`. If it hangs or errors, re-check step 5's firewall entry and
step 7b's bind address before anything else.

### 7d. Admin GUI's own certificate (separate from ARI — optional, cosmetic)

The FreePBX admin panel itself (port 443, what you browse to) uses a
**completely different web server** (Apache) than Asterisk's mini-HTTP
server used for ARI. Fixing ARI's cert does not fix the browser warning on
the admin panel itself. Only do this if the user specifically asks about
the admin GUI's own SSL warning — it's cosmetic and doesn't affect calls,
whitebox, or ARI.

This requires the **System Admin module to be activated**, which means
creating/linking a Sangoma portal account (Admin → System Admin →
Activation → Activate). **Do not do this yourself** — account creation on a
third-party portal is something to hand to the user, not do on their
behalf. Once they've activated it: Admin → System Admin → HTTPS Setup →
Settings tab → pick the same cert from the Certificate Manager dropdown →
Install.

## 8. Call recording spool directory (only if recording is wanted)

Fresh FreePBX installs can be missing `/var/spool/asterisk/recording/`
entirely, which makes *every* ARI recording call fail with a bare
`500 Internal Server Error` / `{"error":"Allocation failed"}` — this can
only be diagnosed and fixed with real shell access (GUI/CLI-web-relay can't
reach it). If the user hasn't given you shell access and recording is
wanted, ask for it (or ask them to run this themselves):

```
sudo mkdir -p /var/spool/asterisk/recording
sudo chown asterisk:asterisk /var/spool/asterisk/recording
sudo chmod 775 /var/spool/asterisk/recording
```

Match ownership/permissions to sibling directories under
`/var/spool/asterisk/` (e.g. `monitor/`, `voicemail/`) if those differ from
the above on the box you're working on — check with `ls -la
/var/spool/asterisk/` first rather than assuming.

## 9. gpoint-whitebox / whitebox-pro side

`.env`:
```
WB_VOIP_ARI_URL="https://<pbx-host>:8089"   # or http://<pbx-host>:8088 if not using TLS
WB_VOIP_ARI_USER="whitebox"
WB_VOIP_ARI_PASSWORD="<the password from 6b>"
```

`whitebox.config.js` (or wherever `voip({...})` is composed — see main
README's Config shape section for the full field list):
```js
voip({
  ari: {
    url: process.env.WB_VOIP_ARI_URL,
    user: process.env.WB_VOIP_ARI_USER,
    password: process.env.WB_VOIP_ARI_PASSWORD,
    app: 'whitebox',
    // No continueContext here — ari.js hands the call back with a bare
    // continue (see step 6c). If you find a continueContext option being
    // reintroduced, that's a regression; don't add it back.
  },
  lines: [
    {
      tag: 'default',                       // ask the user if they want per-DID tags instead
      in: [ /* the DIDs from step 4, in E.164 */ ],
      out: [ /* the hunt targets from step 3, in E.164 */ ],
      strategy: 'hunt',                      // match step 3's Ring Strategy
    },
  ],
  transcription: true,                        // only if step 8's spool dir is set up
  // ...country, language, recordsFolder, url — see main README
})
```

Restart the whitebox server. Check its logs for:
```
[voip] ARI connected at https://<pbx-host>:8089
[voip] ARI Stasis app started: whitebox
```
If it hangs indefinitely at "Loading plugin: voip" with no error and no
success line — see the `ari-client` gotcha below.

## 10. End-to-end verification

**Don't** test by dialing one of the new DIDs from a phone/extension that's
*on the same trunk* — many wholesale providers refuse to route a call back
to the same account it came from, so a self-loop test reliably fails with
no useful signal (the call just never arrives, no log trace at all) even
when everything is configured correctly. This wastes time chasing a
non-existent bug.

Instead: place a call to one of the DIDs from a genuinely external line
(any phone not on this trunk). Watch the whitebox server's logs for, in
order:
```
[voip] Call ring: <caller> → <did> (<tag>)
```
— confirms the call reached Stasis and was recognized.
```
[voip] Call picked: <caller>
```
— confirms the hand-off to the ring group worked *and* the channel is still
producing events after leaving Stasis (this line silently never appearing,
on every single historical call, was the symptom of the subscription-
lifecycle bug described in the Gotchas — if you only ever see "Call ring"
and nothing after, re-check that fix is actually present in `ari.js`).

Then hang up and confirm:
```
[voip] Call ended: <caller> (<duration>s, transcribed)
```
with `recorded: true` (and `transcribed: true` if step 8/transcription is
configured). If you see `Call ended` but `recorded: false`, check the
step 8 spool directory. If `Call ended` never appears at all, that's the
subscription bug again.

If the call arrives at the PBX (visible in Asterisk's own logs / System Log
Files) but whitebox shows nothing: re-check step 6f (Stasis app registered,
dialplan repointed on *every* DID). If the call never arrives at the PBX at
all (nothing in the log, not even a rejection): that's provider-side DID
routing, not this box's config — nothing here can fix it; escalate to the
trunk provider.

## Gotchas (read before debugging blind)

- **Trunk Username/Auth Username fields visually reset to blank
  placeholder text on every page load**, and don't reliably persist across
  separate edit-then-resave cycles. When left blank, FreePBX/Asterisk falls
  back to using the **trunk's Name field itself** as the SIP auth username
  — this is by-design fallback behavior (the placeholder text literally
  says "username is trunk name"), not a bug. If a provider gives you a
  specific required username, the reliable fix is to **name the trunk that
  exact string**, not to fight the field persistence.
- **"Allow Unauthenticated" only exempts OPTIONS pings from auth, not real
  INVITEs.** If real inbound calls fail with "Failed to authenticate" in
  the log while OPTIONS keepalives work fine and registration succeeds,
  the fix is Authentication = Outbound (not Both) on the trunk — see step 1.
- **FreePBX's native `confirm()` dialogs (e.g. "no Outbound CallerID
  defined") block all further browser-automation calls** until a human
  dismisses them in the actual browser chrome — there's no way to dismiss
  them programmatically via CDP/browser-automation tooling. Avoid
  triggering them (e.g. always set Outbound CallerID) rather than
  discovering this the hard way.
- **After any Asterisk/FreePBX reboot, re-verify trunk settings actually
  match what the GUI displays** — this environment showed at least once
  where a reboot left the live `pjsip.conf` out of sync with the DB-stored
  values shown in the GUI (registration still worked, but inbound auth
  behavior reverted) until the trunk form was resubmitted and Applied
  again. If something that worked before a reboot stops working after one,
  resubmit + Apply Config on the trunk before looking anywhere else.
- **Don't use the `ari-client` npm package** if you're hand-rolling or
  auditing this integration. Its `swagger-client` dependency's resource-
  discovery step hangs indefinitely (no error, no timeout) when connecting
  over HTTPS specifically to Asterisk's built-in mini-HTTP server — plain
  HTTP works fine, which made this confusing to isolate. `ari.js` in this
  plugin already uses a small hand-rolled `fetch` + `ws` transport instead
  (no discovery step — the ARI surface this plugin needs is a handful of
  fixed REST calls + one WebSocket event stream), which doesn't have this
  problem. Don't reintroduce the dependency.
- **A stuck/zombie channel after `channel originate` testing**: if you use
  the Asterisk CLI to originate test calls, `channel request hangup
  <channel>` if one gets stuck rather than waiting — the CLI's web relay
  has no live console stream, so you can't watch call progress in real
  time, only poll discrete state with `core show channels verbose`. Also
  note a plain `Local/<exten>@<context>` origination with `application
  Answer` on the calling half will self-destruct the instant the far end
  answers (the Answer() app completes instantly with nothing else queued,
  tearing down the whole Local channel pair) — use `application Wait 300`
  instead if the test channel needs to stay alive to inspect.
- **ARI's `channel.record()` returning `500 Internal Server Error` /
  `{"error":"Allocation failed"}`** on a fresh install is almost always the
  `/var/spool/asterisk/recording/` directory not existing yet — see step 8.
- **ARI `continue` with an explicit `context`/`extension`/`priority` target
  is accepted (`204`) but silently delayed by 50+ seconds to several
  minutes on a real PJSIP channel** — long enough that real callers always
  hang up before it ever takes effect, making it look like the call is
  simply never redirected. This does **not** reproduce on Local/synthetic
  test channels, which is exactly why it can pass manual testing and still
  break every real call — always do end-to-end verification (step 10) with
  a genuine external call before considering this integration done. The fix
  (already in `ari.js`) is a bare `continue()` with no explicit target —
  see step 6c for the full explanation. Do not re-add a cross-context
  target to "simplify" the dialplan.
- **An active ARI-managed recording on a real PJSIP channel blocks that
  same channel's `continue` from ever taking effect** — confirmed directly
  by stopping a stuck recording mid-call and watching the channel leave
  Stasis immediately afterward. Recording also **cannot be started at all**
  on a channel that has already left Stasis (`409 Channel not in Stasis
  application`) — so recording-then-continuing and continuing-then-
  recording are *both* broken for the main channel. The fix (already in
  `ari.js`): record via a **snoop channel** (`POST
  /channels/{id}/snoop` with `spy: 'both'`, entering the same Stasis app
  with `appArgs: 'snoop'` so its own `StasisStart` is ignored), and record
  *that* channel instead of the main one. The main channel is then free to
  continue immediately since nothing is directly attached to it. When the
  main channel is destroyed, explicitly hang up its snoop channel first
  (`DELETE /channels/{snoopId}`) so the recording finalizes before you try
  to fetch it, rather than racing Asterisk's own cleanup ordering.
- **A channel's ARI event subscription ends the moment it leaves Stasis via
  `continue`** — its later `ChannelStateChange` and `ChannelDestroyed`
  events simply stop arriving on the app's websocket, with no error or
  warning anywhere. This is the single most expensive bug in this
  integration's history: it meant **"Call picked" and "Call ended" never
  logged for any call, ever**, going back through the system's entire
  history (confirmed via direct DB query — every historical row was stuck
  at `status: 'ringing'`, `ended_at: null`), even on calls that connected
  and completed perfectly from the caller's perspective. Recording never
  finalized, transcription never ran, and nothing in the logs pointed at
  why — the calls just looked "successful" on the phone and silently
  incomplete everywhere else. The fix (already in `ari.js`): explicitly
  call `POST /applications/{app}/subscription?eventSource=channel:{id}` for
  the channel right before continuing it, which keeps its events flowing
  independent of Stasis membership. If you ever see calls connect fine but
  never show `Call picked`/`Call ended` in the whitebox logs, this
  subscription call is the first thing to check.
