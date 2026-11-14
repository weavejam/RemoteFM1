// SPDX-License-Identifier: GPL-3.0-only
// The RemoteFM1 web installer (index.html), TransitFM1's (web/transit.js, GPL-3.0-only) with RemoteFM1's package:
// install RemoteFM1 on an FM-1 over Web MIDI, finish an install that was cut off, read what the FM-1 runs (RemoteFM1
// is told from the official V15 by its HELLO), install another package file (the way back to V15). The protocol is
// fm1ota.js (Felucca's, as ChoralRoot carries it), the package reading fm1pkg.js, both TransitFM1's copies,
// unchanged. Everything that decides is here and runs without a page (test_installer.mjs drives it against a fake
// FM-1): the page's DOM wiring is page.js, and the headless engine (../engine.js, docs/ENGINE.md) uses the same decisions.
//
// TransitFM1's lessons kept: 0.1.1 (a DAW's MIDI flooding the port stalled step 1: the page asks for every MIDI app
// to be closed), 0.1.2/0.1.3 (Baud Girl: a package whose flash.bin reaches past the app area is refused here, before
// the FM-1 is asked anything; the loader answers ota-FM-1_900, so Baud Girl's own installer refuses it), the loader
// identity (an install cut off is resumed only from our own update mode, ota-FM-1_9NN).
import { Updater, classifyFirmware } from "./fm1ota.js";
import { Package, productOf, logicalImage, sha256hex, STOCK_V15_SHA256 } from "./fm1pkg.js";

export const IDENTITY = "FM-1_015";               // RemoteFM1's (tools/build.py PRODUCT): the official V15's
const INFO_REQ = [0xF0, 0x7D, 0x46, 0x4C, 0x01, 0xF7];   // the backup protocol's INFO (Felucca, ChoralRoot, ...)
const HELLO_REQ = [0xF0, 0x7D, 0x52, 0x46, 0x01, 0xF7];  // RemoteFM1's HELLO (docs/PROTOCOL.md section 2), no body

// rf_unpack7 (firmware/src/remote_proto.h): groups of an MSB byte then up to 7 data bytes
export function rfUnpack7(a) {
  const out = [];
  let g = 0, msb = 0;
  for (const b of a) {
    if (!g) { msb = b; g = 1; continue; }
    out.push((b & 0x7F) | (((msb >> (g - 1)) & 1) << 7));
    g = g === 7 ? 0 : g + 1;
  }
  return out;
}
export function rfPack7(a) {
  const out = [];
  for (let i = 0; i < a.length; i += 7) {
    const g = a.slice(i, i + 7);
    out.push(g.reduce((m, b, k) => m | ((b >> 7) << k), 0), ...g.map((b) => b & 0x7F));
  }
  return out;
}

// listen for one SysEx answer; send req; resolve parse(data) or null after ms
function ask(input, output, req, parse, ms) {
  return new Promise(async (resolve) => {
    try { await input.open(); await output.open(); } catch (_) { return resolve(null); }
    const done = (v) => { clearTimeout(timer); input.onmidimessage = null; resolve(v); };
    const timer = setTimeout(() => done(null), ms);
    input.onmidimessage = (e) => { const v = parse(e.data); if (v !== undefined) done(v); };
    try { output.send(req); } catch (_) { done(null); }
  });
}
// the version text a Felucca-family firmware answers to INFO, or null (the stock firmware, RemoteFM1, others)
export function deviceInfo(input, output, ms = 1500) {
  return ask(input, output, INFO_REQ, (d) => {
    if (d.length < 6 || d[0] !== 0xF0 || d[1] !== 0x7D || d[2] !== 0x46 || d[3] !== 0x4C || d[4] !== 1) return undefined;
    const a = Array.from(d.slice(5, -1)), end = a.indexOf(0);
    return String.fromCharCode(...a.slice(0, end < 0 ? a.length : end)) || null;
  }, ms);
}
// RemoteFM1's HELLO_R: { name, proto, version } or null (anything else)
export function remoteHello(input, output, ms = 800) {
  return ask(input, output, HELLO_REQ, (d) => {
    if (d.length < 7 || d[0] !== 0xF0 || d[1] !== 0x7D || d[2] !== 0x52 || d[3] !== 0x46 || d[4] !== 0x41) return undefined;
    const b = rfUnpack7(Array.from(d.slice(5, -1)));
    const str = (o, n) => { const s = b.slice(o, o + n), z = s.indexOf(0); return String.fromCharCode(...(z < 0 ? s : s.slice(0, z))); };
    return { name: str(0, 16), proto: b[16], version: str(17, 8) };
  }, ms);
}

// what the connected FM-1 runs -> { none } | { several, list } | { loader, identity } |
// { identity, port, version, fw, remote: { name, proto, version } | null }; each found one also has ports: { input,
// output } (the MIDI port names) and endpoints: { input, output } (the MIDIInput / MIDIOutput objects themselves: the
// engine's endpoint session, protocol v1.1). opts.portRe: the port names probed (default fm1ota.js PORT_RE)
export async function look(access, log = () => {}, opts = {}) {
  const up = new Updater(access, log, opts.portRe);
  const all = await up.all();
  if (!all.length) return { none: true };
  if (all.length > 1) return { several: true, list: all.map((d) => `${d.id.text} (${d.name})`) };
  const d = all[0];
  const ports = { input: d.input.name, output: d.output.name }, endpoints = { input: d.input, output: d.output };
  if (/^ota-/i.test(d.id.model)) return { loader: true, identity: d.id.text, port: d.name, ports, endpoints };
  const remote = d.id.text === IDENTITY ? await remoteHello(d.input, d.output) : null;
  const version = remote ? null : await deviceInfo(d.input, d.output);
  return { identity: d.id.text, port: d.name, ports, endpoints, version, fw: classifyFirmware(d.id.text, version, d.name), remote };
}

// ---- the decisions, pure (no MIDI, no page): install() below, page.js and the headless engine (../engine.js) ----

// The firmwares told apart beyond classifyFirmware: the name to show, whether it keeps the player's own work (songs,
// patterns, presets) in the FM-1's flash, which a firmware install may overwrite, and its editor (where that work is
// backed up). Matched on the INFO text, else the USB port name. Sources: each firmware's own repository and README,
// and the FM-1 Firmware Hub's entry (web/site/data/hub-catalog.snapshot.json: "what", "editor").
export const FIRMWARE_PROFILES = [
  // SLOOP (github.com/isod89/sloop-fm1): a groovebox with tracks, a step sequencer and song mode; songs and presets
  // are kept on the unit and backed up with its web editor
  { id: "sloop", name: "SLOOP", info: /sloop/i, port: /sloop/i, holdsUserData: true,
    editorUrl: "https://isod89.github.io/sloop-fm1/webapp/editor/" },
  // JIANT FM (github.com/juanjiant-bit/JIANT): a groovebox on SLOOP's song mode, six tracks; its patterns and songs
  // stay on the unit, backed up with its web editor. Its port is "JIANT FM" (web/managers/managers.json "ports")
  { id: "jiant", name: "JIANT", info: /jiant/i, port: /jiant/i, holdsUserData: true,
    editorUrl: "https://juanjiant-bit.github.io/JIANT/webapp/editor/" },
  // Felucca (github.com/hugelton/Felucca): a sequencer and presets stored in the flash; the backup protocol (INFO,
  // above) and its web editor save and restore them
  { id: "felucca", name: "Felucca", info: /^felucca\b/i, port: /^felucca\b/i, holdsUserData: true,
    editorUrl: "https://hugelton.github.io/Felucca/webapp/editor/" },
  // Melodee (github.com/keremimo/melodee): recordings and presets on the unit, Felucca's backup protocol and editor
  { id: "melodee", name: "Melodee", info: /^melodee\b/i, port: /melodee/i, holdsUserData: true,
    editorUrl: "https://keremimo.github.io/melodee/webapp/editor/" },
  // ChoralRoot (github.com/Quixotic7/ChoralRootFM1): presets and its looper's data in the flash, backed up with its
  // device manager (index.html: "ChoralRoot users: back up first")
  { id: "choralroot", name: "ChoralRoot", info: /^choralroot\b/i, port: /choral/i, holdsUserData: true },
];
export function profileOf(st) {
  if (!st || !st.fw) return null;
  return FIRMWARE_PROFILES.find((p) => p.info.test(st.version || "")) ||
         FIRMWARE_PROFILES.find((p) => p.port.test(st.port || "")) || null;
}

// The firmwares installed over only by the way back through the official V15 (the "V15 detour"): their own updater
// takes M-VAVE's package (as their own instructions to go back to stock do: fm1ota.js refusalText), RemoteFM1's is
// refused over them. Sloop's rescue mode (FM-1_000), Bubba Machine (only M-VAVE's own package through its own
// updater) and identities the table does not know (Baud Girl's FM-1_101, other devices) are not.
export function detourAllowed(st) {
  if (!st || !st.fw || st.remote || st.fw.verdict !== "refuse") return false;
  const num = parseInt((/_(\d+)$/.exec(st.identity || "") || [])[1], 10);
  if (!/^FM-1_/.test(st.identity || "") || !(num >= 900)) return false;
  return ["sloop", "felucca-beta", "unknown"].includes(st.fw.kind);
}

// What may be done to the FM-1 look() found, with pkg (packageFrom/releasedPackage) -> { action: "install" | "resume" |
// "refuse", reason, overridable }. reason (refuse): none | several | bubba | firmware | midi. opts: override (install
// over a firmware refused by default), midiClosed (the page: the visitor says every other MIDI app is closed; the
// engine passes true, it detects a stalled port itself), detour (the official V15 over a firmware detourAllowed())
export function decide(st, pkg, opts = {}) {
  const refuse = (reason, overridable = false) => ({ action: "refuse", reason, overridable });
  if (st.none) return refuse("none");
  if (st.several) return refuse("several");
  if (st.loader) return { action: "resume", reason: "loader", overridable: false };
  if (st.fw.kind === "bubba") return refuse("bubba");
  if (st.fw.verdict === "refuse" && !opts.override && !(opts.detour && pkg && pkg.official && detourAllowed(st)))
    return refuse("firmware", true);
  if (!opts.midiClosed) return refuse("midi");
  return { action: "install", reason: st.fw.verdict === "refuse" ? (pkg && pkg.official ? "detour" : "override") : "allowed", overridable: false };
}

// The way to an install from what look() found: "none" (no FM-1), "several", "resume" (update mode: finish the cut-off
// install), "direct" (RemoteFM1 installs over it), "v15" (the official V15 first, then RemoteFM1), "external" (Bubba
// Machine: its own updater back to V15 first), "unsupported" (nothing from here)
export function restorePathOf(st) {
  if (st.none) return "none";
  if (st.several) return "several";
  if (st.loader) return "resume";
  if (st.remote || st.fw.verdict === "allow") return "direct";
  if (st.fw.kind === "bubba") return "external";
  return detourAllowed(st) ? "v15" : "unsupported";
}

// The update mode look() found: may install({ resume }) finish it? Our own loader (ota-FM-1_7NN..9NN, TransitFM1's and
// Felucca's) takes any FM-1 package; the official loader (ota-FM-1_0NN, an official V15 install cut off) only M-VAVE's
// own V15 -> null (not resumable) | "any" | "v15"
export function resumableWith(st) {
  if (!st.loader) return null;
  if (/^ota-FM-1_[789]\d\d$/i.test(st.identity)) return "any";
  if (/^ota-FM-1_0\d\d$/i.test(st.identity)) return "v15";
  return null;
}

const versionIn = (info) => ((/(\d+(?:\.\d+)+\S*)/.exec(info || "") || [])[1]) || undefined;

// look()'s result as the engine protocol's Fm1State (docs/ENGINE.md). ctx: { newest: the newest bundled RemoteFM1
// version, previous: what the unit ran before an install this session cut off (for update mode), releases: [{ version,
// sha256 }] (a RemoteFM1 previous gets its package's SHA-256) }. identity (protocol v1.1, additive): the update
// protocol's handshake identity ("FM-1_015", "ota-FM-1_900"), what a host passes back as install's expect.identity
export function stateOf(st, ctx = {}) {
  if (st.none || st.several) return { port: null, mode: "normal", firmware: null, resumable: false };
  const port = st.ports ? { input: st.ports.input, output: st.ports.output } : { input: st.port, output: st.port };
  const identity = st.identity ? { identity: st.identity } : {};
  if (st.loader) {
    const out = { port, mode: "update", firmware: null, resumable: !!resumableWith(st), ...identity };
    if (ctx.previous) out.previous = ctx.previous;
    return out;
  }
  let firmware, previous;
  if (st.remote) {
    const version = st.remote.version || "";
    firmware = { kind: "remote", version, current: !!ctx.newest && version === ctx.newest };
    const rel = (ctx.releases || []).find((r) => r.version === version);
    previous = { name: "RemoteFM1", version, ...(rel ? { sha256: rel.sha256 } : {}) };
  } else if (st.fw.kind === "stock") {
    firmware = { kind: "stock", identity: st.identity };
    previous = { name: st.identity };
  } else if (st.fw.kind === "bubba") {
    firmware = { kind: "bubba", name: st.fw.name };
    previous = { name: "Bubba Machine" };
  } else if (st.fw.verdict === "allow" || detourAllowed(st)) {
    const p = profileOf(st), version = versionIn(st.version);
    firmware = { kind: "custom", name: p ? p.name : st.fw.name, ...(version ? { version } : {}),
                 direct: st.fw.verdict === "allow", holdsUserData: p ? p.holdsUserData : false,
                 ...(p && p.editorUrl ? { editorUrl: p.editorUrl } : {}) };
    previous = { name: firmware.name, ...(version ? { version } : {}) };
  } else {
    firmware = { kind: "unknown", ...(st.identity ? { identity: st.identity } : {}) };
    previous = { name: st.identity || "unknown" };
  }
  return { port, mode: "normal", firmware, resumable: false, ...identity, previous };
}

// a sentence for "What is on my FM-1?"
export function describe(st) {
  if (st.none) return "No FM-1 found. Connect it with a USB data cable, switch it on, and close every other app that uses MIDI (DAWs, other browser tabs with an FM-1 page).";
  if (st.several) return `Several FM-1s answer (${st.list.join(", ")}). Connect only the one to install.`;
  if (st.loader) return `The FM-1 is in update mode (${st.identity}): an install was cut off. Choose the same firmware and press Install to finish it.`;
  if (st.remote) return `The FM-1 runs RemoteFM1 ${st.remote.version || ""} (it answers installers as the official V15, ${st.identity}).`.replace("  ", " ");
  if (st.fw.kind === "stock") return `The FM-1 answers as the official firmware (${st.identity}): stock V15, or TransitFM1, which answers the same.`;
  if (st.fw.kind === "bubba") return `The FM-1 runs Bubba Machine (${st.identity}). Its updater accepts only M-VAVE's own package: go back to V15 with Bubba Machine's installer first.`;
  return `The FM-1 runs ${st.fw.name}` + (st.fw.verdict === "allow" ? "." : `, which is not installed over from here (an install over it has left FM-1s that no longer start).`);
}

// the released package, as the site hosts it: fetched, its SHA-256 the one in releases.json, identity FM-1_015
// base: where the packages are (the page: firmware/ beside it; the engine: the host's firmwareBase). The errors carry a
// code (the engine's EngineError codes): firmwareUnavailable (with httpStatus), verifyFailed
export async function releasedPackage(rel, fetchFn = fetch, base = "firmware/") {
  const r = await fetchFn(`${base}remote-${rel.version}.fwsc`, { cache: "no-cache" });
  if (!r.ok) throw coded(new Error(`The package for RemoteFM1 ${rel.version} could not be downloaded (${r.status}).`), "firmwareUnavailable", { httpStatus: r.status });
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (await sha256hex(bytes) !== rel.sha256)
    throw coded(new Error(`The file for RemoteFM1 ${rel.version} is not the released one (its SHA-256 does not match). Nothing was written. Reload the page.`), "verifyFailed");
  return packageFrom(bytes, `RemoteFM1 ${rel.version}`);
}
const coded = (e, code, more = {}) => Object.assign(e, { code }, more);

// any FM-1 package (a file the user chose): its identity, the image the device reads, a name to show. Errors: code
// verifyFailed (not an FM-1 package), refused (too large for RemoteFM1's loader)
export async function packageFrom(bytes, label = null) {
  let product;
  try { product = productOf(bytes); } catch (e) { throw coded(new Error("This is not an FM-1 firmware package (.fwsc)."), "verifyFailed"); }
  if (!/^FM-1_\d+$/.test(product)) throw coded(new Error(`This package is not for the FM-1 (its identity is ${product || "empty"}).`), "verifyFailed");
  let flashSize = 0;
  try { flashSize = new Package(bytes).flashSize; } catch (_) { /* (a layout the reader does not know: the FM-1 decides) */ }
  if (flashSize > 0x93000)   // RemoteFM1's loader writes the app area only: Baud Girl's image grows past it
    throw coded(new Error("This firmware is larger than RemoteFM1 can install (its image reaches past the app area, as Baud Girl's does). Install the official V15 first, then this firmware with its own installer."), "refused");
  const official = await sha256hex(bytes) === STOCK_V15_SHA256;
  return { product, image: logicalImage(bytes), official,
           label: label || (official ? "the official V15 (M-VAVE's FM-1.fwsc)" : `the package ${product}`) };
}

const MIDI_FIRST = "First close every app that uses MIDI (a DAW, a synth editor, other browser tabs with an FM-1 page) and tick the box: their MIDI can stall an install.";

// install pkg on the connected FM-1, or finish an install that was cut off. ui: { say(text, kind), progress(0..1),
// confirm(text) -> bool, log(text) }; opts.override: install over a firmware that is refused by default;
// opts.midiClosed: the visitor says every other MIDI app is closed (required for a fresh install). Returns
// "done" | "resumed" | "refused" | "cancelled"; throws with a message the page shows. opts.onRefused(decision): told
// decide()'s answer when it refuses (the page offers the override when it is overridable)
export async function install(access, pkg, ui, opts = {}) {
  const up = new Updater(access, ui.log);
  const st = await look(access, ui.log);
  const d = decide(st, pkg, opts);
  if (d.action === "refuse") {
    if (opts.onRefused) opts.onRefused(d);
    ui.say(d.reason === "midi" ? MIDI_FIRST : describe(st), "bad");
    return "refused";
  }
  const step = (k, n) => {
    if (k === "start") ui.say(`Starting the update on ${n}...`);
    if (k === "verify") ui.progress(Math.min(0.05, n / 1500));
    if (k === "loader") ui.say("The FM-1 restarts into update mode...");
    if (k === "write") { ui.say("Writing. Do not unplug the FM-1 or switch it off."); ui.progress(Math.min(0.99, 0.05 + n / 1250)); }
    if (k === "reboot") ui.say("Restarting...");
    if (k === "done") ui.progress(1);
  };
  if (d.action === "resume") {
    ui.say(`The FM-1 is in update mode (${st.identity}): finishing the write of ${pkg.label}...`);
    const ok = await up.resume(pkg.image, step, pkg.official ? { product: pkg.product } : { package: pkg.product });
    if (!ok) throw new Error("The write did not finish. Keep the FM-1 connected, switch it off and on if its screen stays black, and press Install again.");
    ui.say(`Done: ${pkg.label} is installed.`, "ok");
    return "resumed";
  }
  const over = st.remote ? `RemoteFM1 ${st.remote.version}` : st.fw.kind === "stock" ? "the firmware that answers as V15" : st.fw.name;
  if (!ui.confirm(`Install ${pkg.label} over ${over}? ` +
                  "The FM-1 must be charged and connected directly to this computer; do not unplug it while it writes."))
    return "cancelled";
  await up.install(pkg.image, pkg.product, step);
  ui.say(`Done: ${pkg.label} is installed.`, "ok");
  return "done";
}
