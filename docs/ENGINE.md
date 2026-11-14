# The headless installer engine (protocol v1)

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
   `{ type: 'rfm1-engine-ready', protocol: 1 }` from `iframe.contentWindow`. The engine posts it to `window.parent`
   on load, with its own origin as the target origin.
2. The host sends `{ type: 'rfm1-engine-connect' }` with a transferred `MessagePort`:
   `iframe.contentWindow.postMessage({ type: 'rfm1-engine-connect' }, origin, [port2])`. The engine accepts it only
   when `event.source === window.parent` and the origin is its own. A later connect replaces the earlier port.
3. Everything after that goes over the port.

## Host → engine

Each request is `{ id, op, ...args }`. Each op gets exactly one final reply, `{ id, ok: true, result }` or
`{ id, ok: false, error: EngineError }`.

- `config({ v15Url, firmwareBase })` → `{ protocol: 1, v15Url, firmwareBase }`. The URLs the host provides, so the
  engine never hard-codes an API. Send it once after connect.
  - `v15Url`: the official V15 package (M-VAVE's `FM-1.fwsc`). The engine checks it against the official V15's
    SHA-256 (`fm1pkg.js` `STOCK_V15_SHA256`).
  - `firmwareBase`: where the RemoteFM1 packages are. The bundled RemoteFM1 is
    `firmwareBase + 'remote-' + version + '.fwsc'`, with `version` and `sha256` taken from the vendored
    `installer/releases.json` (its first release). A missing trailing `/` is added.
- `look({ portHint? })` → `Fm1State`. Reads what is on the FM-1: the OTA identity (the update protocol's handshake),
  RemoteFM1's HELLO (only to a unit that answers as V15), the INFO backup protocol, and update mode.
  `portHint` (a MIDI port name) restricts the probe to that port. Without it, two answering FM-1s are refused.
- `install({ target, resume? })` → `{ installed: Fm1State }`. `target` is one of:
  - `{ kind: 'remote' }`: the bundled newest RemoteFM1;
  - `{ kind: 'v15' }`: the official V15, fetched from `v15Url`;
  - `{ kind: 'package', url, sha256, label }`: a restore. `sha256` (64 hex digits) is required, and the download must
    match it.

  The engine refuses unsafe targets with `error.code = 'refused'` (the installer's refusal rules, below). In update
  mode the engine always finishes the cut-off write, whether or not `resume` is set. With `resume: true` and no update
  mode, the install is refused.
- `cancel()` → `{ cancelled: boolean }`. Aborts an install before the write starts: during the download, the check
  or the look. The cancelled install's own reply is `error.code = 'refused'` with `detail` starting
  `cancelled`. Once the write has started (the update request has been sent), it can't be aborted, and `cancel`
  gets an `error.code = 'busy'` reply. With nothing running, the reply is `{ cancelled: false }`.

Exactly one op (`config`, `look` or `install`) runs at a time. Any of them sent while another runs gets
`error.code = 'busy'`. Only `cancel` is answered while an op runs.

## Engine → host events (no `id`)

- `{ event: 'progress', stage, done, total }`. The stages come in this order:
  - `download` (bytes; `total` is the Content-Length, or 0 while unknown);
  - `verify` (0/1, then 1/1: the SHA-256 and the package checks);
  - `enter-update` (0/2 when the update request is sent, 1/2 when the FM-1 restarts into update mode);
  - `write` (blocks the loader has read, of `ceil(image / 512)`);
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
  previous?: { name: string; version?: string; sha256?: string };   // what the unit ran (INFO), for the restore record
}
type EngineError = { code: 'firmwareUnavailable' | 'portBusy' | 'sysexDenied' | 'disconnected' | 'refused' | 'verifyFailed' | 'timeout' | 'busy' | 'internal'; detail: string; httpStatus?: number };
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
| `portBusy` | An FM-1-named port can't be opened (another app holds it), or doesn't answer the handshake (flooded or held), or step 1 stalled after the update request (TransitFM1 0.1.1: a DAW's MIDI flooding the port). Nothing was written. This replaces "close every MIDI app". |
| `sysexDenied` | `requestMIDIAccess({ sysex: true })` was rejected (`SecurityError` / `NotAllowedError`), or the browser has no Web MIDI. |
| `disconnected` | No FM-1 to install on, or the port disappeared mid-install (unplugged). Run `look`: in update mode `resumable` tells whether `install({ resume: true })` finishes it. |
| `refused` | The refusal rules above, an unknown target, a resume outside update mode, or a cancelled install (`detail` starts with `cancelled`). |
| `verifyFailed` | The SHA-256 or the package check failed, or after the install the FM-1 reports another firmware than the one written. |
| `timeout` | The loader didn't appear, stalled mid-write, or the FM-1 didn't come back after the write. |
| `busy` | Another op runs, or a `cancel` came after the write started. |
| `internal` | No `config` yet (`v15Url` / `firmwareBase` missing), an unknown op, or anything unexpected. |

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
- the order of the progress events.

`node web/installer/test_installer.mjs` still tests the page's decisions. CI runs both
(`.github/workflows/installer-tests.yml` on pull requests, and the Pages build).
