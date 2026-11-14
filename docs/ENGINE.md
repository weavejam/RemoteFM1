# The headless installer engine (protocol v1.1)

`web/engine.html` + `web/engine.js` are the RemoteFM1 installer without a page. A host such as TuttiDAW's FM-1 setup
wizard runs the engine in a **hidden same-origin iframe** with `allow="midi"` and talks to it only through a
`MessagePort`. The engine owns the Web MIDI SysEx access while it works. It decides nothing of its own: what the
FM-1 runs, what may be installed over it and how is `web/installer/installer.js` (`look`, `decide`, `stateOf`,
`restorePathOf`, `resumableWith`, `packageFrom`), the same code the installer page (`web/installer/page.js`) uses.
The update protocol is `web/installer/fm1ota.js` (Felucca's, as TransitFM1 carries it), and the package reader is
`web/installer/fm1pkg.js`.

Licence: GPL-3.0-only, like the rest of this repository. The host must not import any of these modules into its own
bundle. It loads them in the iframe and exchanges only the messages below.

## Handshake

1. The host creates the iframe (`<iframe src=".../engine.html" allow="midi" hidden>`) and waits for
   `{ type: 'rfm1-engine-ready', protocol: 1, minor: 1 }` from `iframe.contentWindow`. `minor: 1` (protocol v1.1)
   means the engine honours `install`'s `expect` (below). A v1.0 engine sends no `minor` and ignores `expect`, so a
   host that relies on the binding checks `minor >= 1` first. The engine posts it to `window.parent`
   on load, with its own origin as the target origin.
2. The host sends `{ type: 'rfm1-engine-connect' }` with a transferred `MessagePort`:
   `iframe.contentWindow.postMessage({ type: 'rfm1-engine-connect' }, origin, [port2])`. The engine accepts it only
   when `event.source === window.parent` and the origin is its own. A later connect replaces the earlier port.
3. Everything after that goes over the port.

## Host → engine

Each request is `{ id, op, ...args }`. Each request (a message with an `id` or an `op`) gets exactly one final reply,
`{ id, ok: true, result }` or `{ id, ok: false, error: EngineError }`. That includes a request the engine can't
serve:

- an `op` that isn't one of the ops below gets `error.code = 'internal'`. This covers an unknown name, a name
  inherited from `Object.prototype` (`toString`, `constructor`…), an `op` that isn't a string, and a missing `op`;
- malformed arguments get `error.code = 'refused'` with `detail` starting `bad request`, and nothing is done. For
  example: `install` without a `target` object, a `target.kind` or `config` URL that isn't a string, a
  non-boolean `resume`, an empty or non-string `portHint`, or a malformed `expect` (not an object, a `port` without
  `input` and `output` names, a `mode` other than `'normal'` or `'update'`, a non-string `identity`, a `firmware`
  without a string `kind`, a `session` that isn't a non-empty string, or a non-boolean `confirmedSameUnit`). A
  missing `expect.session` is not a bad request: it is `unitChanged` (`session-missing`).

A message that is neither (not an object, or with no `id` and no `op`) gets no reply.

- `config({ v15Url, firmwareBase })` → `{ protocol: 1, minor: 1, v15Url, firmwareBase }`. The URLs the host provides, so the
  engine never hard-codes an API. Send it once after connect.
  - `v15Url`: the official V15 package (M-VAVE's `FM-1.fwsc`). The engine checks it against the official V15's
    SHA-256 (`fm1pkg.js` `STOCK_V15_SHA256`).
  - `firmwareBase`: where the RemoteFM1 packages are. The bundled RemoteFM1 is
    `firmwareBase + 'remote-' + version + '.fwsc'`, with `version` and `sha256` taken from the vendored
    `installer/releases.json` (its first release). A missing trailing `/` is added.
- `look({ portHint? })` → `Fm1State`. Reads what is on the FM-1: the OTA identity (the update protocol's handshake),
  RemoteFM1's HELLO (only to a unit that answers as V15), the INFO backup protocol, and update mode.
  `portHint` (a MIDI port name) restricts the probe to that port. Without it, two answering FM-1s are refused.
  v1.1: a `look` that finds a unit also opens an endpoint session on the ports it read and returns its token as
  `session` (see [The endpoint session](#the-endpoint-session)). Each `look` ends the previous session.
- `install({ target, resume?, expect? })` → `{ installed: Fm1State }`. `expect` (protocol v1.1) binds the install
  to the unit the host verified: see [Protocol v1.1](#protocol-v11-install-binds-to-the-verified-unit). With `expect`
  in normal mode, the install stops after step 1 (`unitChanged`, `continuity-lost`), and step 2 is a confirmed
  resume. `target` is one of:
  - `{ kind: 'remote' }`: the bundled newest RemoteFM1;
  - `{ kind: 'v15' }`: the official V15, fetched from `v15Url`;
  - `{ kind: 'package', url, sha256, label }`: a restore. `sha256` (64 hex digits) is required, and the download must
    match it.

  The engine refuses unsafe targets with `error.code = 'refused'` (the installer's refusal rules, below). In update
  mode the engine always finishes the cut-off write, whether or not `resume` is set. With `resume: true` and no update
  mode, the install is refused.
- `cancel()` → `{ cancelled: boolean }`. Aborts an install before the write: during the download, the check, the
  look, or anything else the install waits on before it commits to the write. A `{ cancelled: true }` reply is a
  promise: that install never sends a write SysEx, and its own reply is `error.code = 'cancelled'` (`detail` starts
  `cancelled`), even when the wait it was in then fails (a download error, a denied MIDI permission, a port that
  won't open, a silent FM-1): an acknowledged cancel takes precedence over that error. The engine checks for a
  cancel after each of those waits, and makes its last check and its commit with nothing in between. From the
  commit on (the update's own handshake, just before the update request), the install can't be aborted. `cancel`
  then gets an `error.code = 'busy'` reply, never `cancelled`, and the install goes on to its own reply. A `cancel`
  during `config` or `look` is also `busy`. With nothing running, the reply is `{ cancelled: false }`. The V15
  detour is two installs (the V15, then RemoteFM1), and each has its own checks and commit.

Exactly one op (`config`, `look` or `install`) runs at a time. Any of them sent while another runs gets
`error.code = 'busy'`. Only `cancel` is answered while an op runs.

## Protocol v1.1: install binds to the verified unit

Protocol v1.1 is additive. `expect` is optional, so v1 hosts still work: without it `install` behaves exactly as in
v1. TuttiDAW always sends it. In v1, `install` probes the ports again after the download with nothing to tie the
probe to the unit the host verified. A user who swaps unit A for unit B (one that holds user data) during the
download gets B flashed without B's consent. With `expect`, the install writes only the unit the host verified.

MIDI gives no hardware serial number. Two identical units, for example two FM-1s running Felucca 1.0.1, have the same
port names, the same OTA identity and the same firmware. Nothing they answer tells them apart. So the binding rests
on **connection continuity**: the engine writes only through the very MIDI endpoints the host's `look` read, and only
while they have stayed connected since that `look`. Swapping two units means unplugging one, which always breaks
continuity.

```ts
interface InstallExpect {
  session: string;                             // the `session` of the `look` the host verified the unit with
  confirmedSameUnit?: boolean;                 // the user said yes to "Is this the FM-1 you were setting up?" (below)
  port: { input: string; output: string };     // the ports `look` returned for this unit
  mode: 'normal' | 'update';                   // the mode the host verified
  identity?: string;                           // the OTA identity / INFO identity `look` reported
  firmware?: { kind: string; name?: string; version?: string };  // the firmware `look` reported (normal mode)
}
```

The host builds `expect` from its own `look` of the unit: `session`, `port`, `mode`, `identity` (`Fm1State.identity`,
the handshake identity) and `firmware`'s `kind`, `name` and `version`. When `expect` is given, the engine applies these
rules.

### The endpoint session

- **`look` opens a session.** A `look` that finds a unit returns an opaque `session` token (`Fm1State.session`). The
  session holds the exact `MIDIInput` and `MIDIOutput` objects that `look` read, and their `id`s. It keeps them open
  and listens to `statechange` on them from the `look` until the update request. Each `look` ends the session before
  it. A `look` that finds no unit (or several) returns no `session`.
- **`install` must carry it.** `expect.session` must be the token of the last `look`, unused:
  - no `expect.session`: `unitChanged`, `detail: 'session-missing'`;
  - a token from an earlier `look`, or one an install already committed with: `unitChanged`,
    `detail: 'session-stale'`.

  The engine checks the session first, before it fetches anything. A malformed token (not a string) is a `bad
  request`.
- **Continuity.** Each of the following breaks continuity and gives `unitChanged` with `detail: 'continuity-lost'`.
  Nothing is written.
  - a `disconnected` statechange on either endpoint, at any time from the `look` to the update request;
  - an endpoint whose `state` is `disconnected`;
  - an endpoint whose `id` changed, or whose `id` the MIDI access now lists under another port object (or not at all);
  - a re-read of the unit that answers on other endpoints than the session's.

  The engine checks continuity at the start of the install, after its re-read of the unit, at its commit, at the
  updater's selection, and synchronously right before each update request. If the install fails before the commit
  for any reason while continuity is broken, the reply is `unitChanged`, not the other error. The disconnect is what
  the host needs to know.
- **Through the validated link.** The updater does not scan the ports. The engine passes it the session's endpoint
  objects, and it writes through those. At its selection it does the update handshake on them, then re-validates the
  **full** expectation on the same pair with `look`'s probes: mode, identity, and firmware (`kind`, `name`, `version`,
  from HELLO / INFO). For a loader it also checks that the loader fits the package (below). A same-name,
  same-identity unit running other firmware is `unitChanged`.

### Re-enumeration: `confirmedSameUnit`

Continuity can't survive a restart. When the FM-1 restarts into its update loader, or into its new firmware, it
re-enumerates with new endpoints. After that, only the user can say it is the same unit. So:

- **A bound install stops after step 1.** With `expect` in normal mode, the engine runs step 1 (the running firmware
  stages the loader). It waits for the loader to answer, then ends with `unitChanged`,
  `detail: 'continuity-lost'`. The app area is not written. The unit is in update mode, and `look` reports it
  `resumable`. The engine never chains step 2 itself.
- **Step 2 is a resume with a fresh session and the user's yes.** After any re-enumeration, the install needs two
  things:
  - `expect.session` from a **fresh** `look` that the host made **after** the re-enumeration;
  - `expect.confirmedSameUnit: true`.

  The flag means the host explicitly asked the user "Is this the FM-1 you were setting up?" and got yes. Without the
  flag (missing or `false`), the reply is `unitChanged`, `detail: 'continuity-lost'`, and nothing is sent. A re-enumeration is:
  - step 1 → the loader for step 2;
  - any resume: a `look` that finds update mode;
  - any `look` after this engine instance committed a write. Each write restarts the unit, so this includes the V15
    detour's RemoteFM1 install over the V15.
- **The loader must fit the target.** A loader's model and identity must be one that the package supports. Otherwise
  the install is `refused`, and nothing is written:
  - our own loader (`fm1ota.js` `OUR_LOADER`, `ota-FM-1_7NN..9NN`) takes any FM-1 package;
  - the official loader (`ota-FM-1_0NN`) takes M-VAVE's V15 only. RemoteFM1 then goes on through an install over the
    V15 (the V15 → RemoteFM1 chain);
  - another firmware's loader, or another model's (an SMK-37's), is never written.

The host's flow for a normal-mode unit:

1. `look`.
2. `install({ expect })` ends with `unitChanged` / `continuity-lost` after step 1.
3. `look` again (update mode, a new `session`).
4. Ask the user.
5. `install({ resume: true, expect: { ...fresh, confirmedSameUnit: true } })`.

If the user says no, the host doesn't resume. It tells the user to reconnect the FM-1 it was setting up.

### The other rules

- **Exactly one candidate unit.** Exactly one FM-1-family unit must answer the update protocol's handshake at the
  start of the install (before the download) and at the engine's re-read. Zero units is `disconnected`. More than one
  is `ambiguousUnit` ("unplug the other FM-1s"), and nothing is sent to any of them. An FM-1 port that another app
  holds is `portBusy`, as in v1. A unit plugged in after the re-read is never asked anything, because the updater
  only uses the session's endpoints.
- **Same unit.** The engine re-reads the unit after the download, with the same probes as `look`. The updater
  re-reads it again on the same endpoints. Each time:
  - its mode must equal `expect.mode`;
  - in normal mode its ports must equal `expect.port`;
  - `expect.identity`, when given, must equal the handshake identity (in normal mode the INFO text also matches);
  - `expect.firmware`, when given (normal mode), must match: the same `kind`, plus `name` and `version` when given.

  A mismatch is `unitChanged` (`detail` says what differs), and nothing is written. These checks come before the
  refusal rules, so a unit swapped in is `unitChanged`, whatever the rules would say of it. A loader under another
  port name than `expect.port` is accepted only if it is our own (`OUR_LOADER`). Any other loader there is `refused`.
- **Order.** The engine's final check (continuity and same unit) runs after any download, immediately before the
  commit point. The cancel check sits at the same point, and there is no await between the final check and setting
  `writing`. With `expect`, the engine reads the release list before it re-reads the unit, so that re-read is the
  last await before the commit. After the commit, the updater's last continuity check comes right before the update
  request, again with no await between them.

`unitChanged` and `ambiguousUnit` both mean nothing was written to the app area. Step 1's stop
(`continuity-lost` after the update request) leaves the unit in update mode, and `look` then reports it `resumable`.

## Engine → host events (no `id`)

- `{ event: 'progress', stage, done, total }`. The stages come in this order:
  - `download` (bytes; `total` is the Content-Length, or 0 while unknown);
  - `verify` (0/1, then 1/1: the SHA-256 and the package checks);
  - `enter-update` (0/2 when the update request is sent, 1/2 when the FM-1 restarts into update mode);
  - `write` (blocks the loader has read, of `ceil(image / 512)`: 0 once the loader is found, before its update
    request, then 1, 2…);
  - `reboot` (0/1 when it restarts into the new firmware, 1/1 when it is back);
  - `confirm` (0/1, then 1/1 once `look` shows the firmware that was installed).

  A resume skips `enter-update`.
- `{ event: 'port', state: 'found' | 'lost' }`: an FM-1 MIDI input appeared or disappeared. This includes the
  restarts during an install.

## Types

```ts
type Fm1Firmware =
  | { kind: 'remote'; version: string; current: boolean }   // current = newest bundled
  | { kind: 'stock'; identity: string }                     // V15 or TransitFM1
  | { kind: 'custom'; name: string; version?: string; direct: boolean; holdsUserData: boolean; editorUrl?: string }
  | { kind: 'bubba'; name: string }                          // needs its own updater back to V15
  | { kind: 'unknown'; identity?: string };
interface Fm1State {
  port: { input: string; output: string } | null;          // null = no FM-1 found
  mode: 'normal' | 'update' | 'uboot';                     // update = 3 flashes, black screen; uboot = WL82 UBOOT1.00
  firmware: Fm1Firmware | null;                            // null when not in normal mode
  resumable: boolean;                                      // an install cut off that `install({ resume: true })` finishes
  identity?: string;                                       // v1.1: the handshake identity ("FM-1_015", "ota-FM-1_900"), for expect.identity
  session?: string;                                        // v1.1: look only, when a unit was found: the endpoint session's token, for expect.session
  previous?: { name: string; version?: string; sha256?: string };   // what the unit ran (INFO), for the restore record
}
type EngineError = { code: 'firmwareUnavailable' | 'portBusy' | 'sysexDenied' | 'disconnected' | 'refused' | 'cancelled' | 'verifyFailed' | 'timeout' | 'busy' | 'internal'
                         | 'unitChanged' | 'ambiguousUnit';   // v1.1 (install with expect)
                     detail: string; httpStatus?: number;
                     message?: string };                    // v1.1: the sentence for logs when detail is a token ('continuity-lost', 'session-missing', 'session-stale')
```

Errors are machine-readable. `detail` is for logs and "Copy details" only, and the host writes all user-facing text.

### How the engine fills `Fm1State`

| What the FM-1 answers | `firmware` |
| --- | --- |
| `FM-1_015` and RemoteFM1's HELLO | `remote`, `version` from HELLO; `current` when it is the first release in `releases.json` |
| `FM-1_001`..`FM-1_099`, no HELLO | `stock` (the official V15 and TransitFM1 answer the same) |
| A firmware `classifyFirmware` allows (ChoralRoot, Melodee, Felucca 1.0 and later) | `custom`, `direct: true` |
| SLOOP, a Felucca beta, an unknown `FM-1_9NN` (JIANT…) | `custom`, `direct: false`: the V15 detour |
| Bubba Machine (its port name) | `bubba` |
| Anything else (Baud Girl's `FM-1_101`, Sloop's rescue mode, other devices) | `unknown` |

- `name`, `holdsUserData` and `editorUrl` come from `FIRMWARE_PROFILES` in `installer.js`. That table cites each
  firmware's repository and its FM-1 Firmware Hub entry.
- `mode` is `update` when the handshake answers `ota-…`. `resumable` is true for our own loader
  (`ota-FM-1_7NN..9NN`, which takes any FM-1 package) and for the official loader (`ota-FM-1_0NN`, which takes only
  the official V15).
- `previous` in normal mode is the running firmware: its name, the version from INFO or HELLO, and, for a RemoteFM1
  release, the package's SHA-256. In update mode, `previous` is what the unit ran before the cut-off install, when
  this engine instance started that install.
- `mode: 'uboot'` is in the type but the engine never reports it. A unit in the chip's ROM USB boot
  (`WL82 UBOOT1.00`) is a USB disk with no MIDI port, so Web MIDI can't see it. Such a unit looks like "no FM-1"
  (`port: null`). After a `disconnected` error, a `look` that finds no port is the host's cue for its recovery screen.

### Refusal rules (`decide` in `installer.js`)

- No FM-1: `disconnected`. Several FM-1s: `refused`.
- Update mode: the write is finished (resume). The official loader takes the official V15 only, and another
  firmware's loader is never written.
- Bubba Machine: `refused`, for every target (only its own updater goes back to V15).
- A firmware the installer refuses (SLOOP, Felucca betas, unknown `FM-1_9NN`): RemoteFM1 or another package is
  `refused`. The official V15 is allowed (the detour: V15, then RemoteFM1 over it).
- An identity the table does not know (`unknown`): `refused`, for every target.
- A package whose image reaches past the app area (as Baud Girl's does): `refused` before the FM-1 is asked anything.
- A package that is not an FM-1 package, or whose SHA-256 is not the expected one: `verifyFailed`.

### Error codes

| Code | When |
| --- | --- |
| `firmwareUnavailable` | The download failed: a network error (no `httpStatus`), or a response that is not 200 (`httpStatus`). Nothing was written. |
| `portBusy` | An FM-1-named port can't be opened (another app holds it), or doesn't answer the handshake (flooded or held), or step 1 stalled after the update request (TransitFM1 0.1.1: a DAW's MIDI flooding the port). Nothing was written. This replaces "close every MIDI app". A stall once the loader is found is `timeout`. |
| `sysexDenied` | `requestMIDIAccess({ sysex: true })` was rejected (`SecurityError` / `NotAllowedError`), or the browser has no Web MIDI. |
| `disconnected` | No FM-1 to install on, or the port disappeared mid-install (unplugged). Run `look`: in update mode `resumable` tells whether `install({ resume: true })` finishes it. |
| `refused` | The refusal rules above, an unknown target, a resume outside update mode, or a malformed request (`detail` starts with `bad request`). |
| `cancelled` | The install's own reply after a `cancel` was acknowledged (`{ cancelled: true }`). It always comes before the write, so nothing was written. (Earlier drafts of protocol v1 used `refused` with `detail` "cancelled…".) |
| `verifyFailed` | The SHA-256 or the package check failed, or after the install the FM-1 reports another firmware than the one written. |
| `timeout` | The loader didn't appear, stalled (before its first read or mid-write), or the FM-1 didn't come back after the write. |
| `busy` | Another op runs, or a `cancel` came after the install committed to the write (or during `config` / `look`). |
| `unitChanged` | v1.1, `install` with `expect`: the unit about to be written may not be the one the host verified. Nothing was written to the app area. `detail` is one of the following. `'session-missing'`: no `expect.session`. `'session-stale'`: the token is not the last `look`'s, or an install already used it. `'continuity-lost'`: the session's endpoints were disconnected, changed id or were replaced, or the unit re-enumerated and `confirmedSameUnit` is not `true`. A bound install's step 1 also ends this way, at the loader: the unit is then in update mode and `resumable`. Otherwise `detail` is a sentence: the unit's mode, ports, identity or firmware differ from `expect`, at the engine's re-read after the download or at the updater's re-validation on the same endpoints. Run `look` again, ask the user whether it is the same FM-1, and pass `confirmedSameUnit: true` with the fresh `session`. |
| `ambiguousUnit` | v1.1, `install` with `expect`: more than one FM-1 answers, at the start of the install or at the engine's re-read. Nothing was written. The host asks the user to unplug the other FM-1s. |
| `internal` | No `config` yet (`v15Url` / `firmwareBase` missing), an unknown, inherited, non-string or missing op, or anything unexpected. |

## Vendoring

Copy these files byte for byte, keeping their layout (`engine.js` imports `./installer/…`):

```
engine.html
engine.js
installer/installer.js
installer/fm1ota.js
installer/fm1pkg.js
installer/releases.json
```

- The firmware packages are not part of the engine. The host serves them (`firmwareBase`, `v15Url`, restore URLs).
  The RemoteFM1 package the host serves at `firmwareBase` must be the one `releases.json` names, with the same SHA-256
  as `web/installer/firmware/SHA256SUMS`.
- Add a `SOURCE.md` beside the copy with this repository's URL and the commit, and the licence (GPL-3.0-only).
- Update by copying the same set from a newer commit. The protocol version is `PROTOCOL` in `engine.js` and the
  `protocol` field of the ready message.

The published site also serves the engine: `engine.html` and `engine.js` at its root, beside `installer/`.

## Tests

`node web/test_engine.mjs` drives `engine.js` through a real `MessageChannel` against the simulated FM-1
(`web/installer/fake_fm1.mjs`) and a fake `fetch`. It covers:

- the handshake;
- `look` for each firmware and mode;
- a direct install;
- the V15 detour;
- resume;
- every error code;
- the order of the progress events;
- cancel at every point an install waits on the outside world before its write. Those points are each fetch, the MIDI
  access, each port's open, each message the FM-1 takes and the SHA-256. The scenarios are both installs of the V15
  detour, a restore and a resume. Each run holds the engine at one point with its timers frozen, so it moves only on
  the cancel message, never on the clock. Before the commit, the cancel must be acknowledged and no write SysEx may
  follow. After it, the cancel must be `busy` and the install must finish;
- the stalls: step 1's (`portBusy`) and the loader's before its first read (`timeout`);
- the dispatch: unknown, inherited, non-string and missing ops, malformed arguments, one reply per request, and no
  unhandled rejection;
- protocol v1.1 (`expect`), on a bench of fake units. The paused-run harness swaps, adds or replugs units while an
  install is held:
  - `look` returns an opaque `session` (none when it finds no unit);
  - unit A swapped for unit B during the download is `unitChanged` / `continuity-lost`, with no write SysEx to either
    unit. Without `expect`, the same swap writes B (v1 is unchanged);
  - two **identical** units (the same port names, identity and firmware) are swapped at every sync point before the
    update request, in three ways: new port objects with new ids, new port objects under the same ids, and the very
    same objects replugged (only the statechange tells). Every point gives `unitChanged`, and nothing is written;
  - the updater re-selects nothing. A same-name, same-identity replacement running other firmware, swapped in at each
    of the updater's points, is `unitChanged`. Other firmware on the same endpoints (no unplug) is refused by the
    updater's own re-read. A second FM-1 plugged in after the commit is never asked. A source check confirms that the
    bound `select()` scans nothing and that `alive()` comes right before the one update request;
  - detour step 2. A's loader is replaced by B's official loader or by an identical loader:
    - without `confirmedSameUnit`: `continuity-lost`;
    - with a fresh session and the flag: the identical loader proceeds, and the official loader is `refused` for
      RemoteFM1 (it takes the V15 only);
    - the pre-step-1 session is `session-stale`, and no session is `session-missing`;
  - a resume: without the flag `continuity-lost`, with it installed. The official loader's V15 resume is accepted, an
    SMK loader is refused for an FM-1 package, and a loader swapped during the download is `continuity-lost`;
  - after a write, a normal-mode install needs the flag too. v1 installs and resumes are unchanged;
  - a second FM-1 at the start is `ambiguousUnit`;
  - firmware, version, identity and mode mismatches are `unitChanged`;
  - the final check sits right before `op.writing = true`, with no await from the re-read to the commit;
  - the cancel tests above, run again with `expect` (a bound install's step 1, and a confirmed resume).

`node web/installer/test_installer.mjs` still tests the page's decisions. CI runs both
(`.github/workflows/installer-tests.yml` on pull requests, and the Pages build).
