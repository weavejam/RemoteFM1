// SPDX-License-Identifier: GPL-3.0-only
// The headless engine (engine.js, protocol v1, docs/ENGINE.md) driven through a real MessagePort (Node's
// MessageChannel) against the simulated FM-1 of installer/fake_fm1.mjs and a fake fetch: the handshake, look for each
// firmware and mode, a direct install, the V15 detour (refused direct, V15, then RemoteFM1), resume from update mode,
// the errors (firmwareUnavailable on a 404 and a network error, portBusy, sysexDenied, disconnected mid-write, busy,
// refused, cancelled, timeout on a loader's stall) and the progress order; a cancel at every sync point before and
// after the commit to the write (no write SysEx after an acknowledged cancel; cancelled even when the awaited operation
// then fails: a download error, sysex denied, a port that won't open, a silent FM-1); the dispatch (unknown, inherited,
// non-string and missing ops, malformed arguments: one reply each). Plus installer.js's pure decisions. Never against
// a real unit.
//   node web/test_engine.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FakeFM1 } from "./installer/fake_fm1.mjs";
import { createEngine, boot, PROTOCOL } from "./engine.js";
import { decide, restorePathOf, stateOf, packageFrom, look } from "./installer/installer.js";

const realTimeout = setTimeout, realClear = clearTimeout;
// The protocol's waits (seconds) shortened 20 times, with a floor of 300 ms (HELLO's 800 ms shortened to 40 raced
// Windows' timer granularity). The engine's timers can be frozen: while a test holds the engine at a sync point
// (below), a timer that comes due waits for the release, so the engine moves only on a message (a cancel), never on
// the clock. (The fake FM-1 and the fake fetch keep the real setTimeout.)
let frozen = null;
class Timer { constructor() { this.cleared = false; this.t = null; } }
globalThis.setTimeout = (f, ms, ...a) => {
  const h = new Timer();
  const run = () => { if (!h.cleared) f(...a); };
  h.t = realTimeout(() => { if (frozen) frozen.push(run); else run(); }, ms >= 200 ? Math.max(ms / 20, 300) : ms);
  return h;
};
globalThis.clearTimeout = (h) => { if (h instanceof Timer) { h.cleared = true; realClear(h.t); } else realClear(h); };

// The sync points: every place the engine waits on the outside world calls point(label): a fetch, the MIDI access, a
// port's open, a message the fake FM-1 takes, the SHA-256 (crypto.subtle.digest). sync.trace: the labels, numbered
// ("rx hs#2": the second handshake). With sync.target set, the run stops at that point: the engine's timers frozen,
// sync.hit({ key, release, reject }) called; release() lets it go on, reject(e) makes the awaited operation fail with e
// (a fetch, the MIDI access, a port's open, the digest; at a message the fake FM-1 takes, it goes silent: see rig).
const sync = { trace: [], target: null, hit: null };
async function point(label) {
  const n = sync.trace.filter((k) => k.startsWith(label + "#")).length + 1, key = `${label}#${n}`;
  sync.trace.push(key);
  if (sync.target !== key) return;
  sync.target = null;
  frozen = [];
  const failure = await new Promise((go) => sync.hit({ key, release: () => go(null), reject: (e) => go(e) }));
  const due = frozen; frozen = null;
  due.forEach((f) => f());
  if (failure) throw failure;
}
const realDigest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (...a) => { await point("digest"); return realDigest(...a); };
let unhandled = 0;
process.on("unhandledRejection", (e) => { unhandled++; console.log("unhandled rejection:", e); });

let fails = 0, checks = 0;
const ok = (cond, what, more = "") => { checks++; if (!cond) fails++; console.log(`${what.padEnd(84)} ${cond ? "ok" : "FAIL " + more}`); };
const J = (x) => JSON.stringify(x);

const rels = JSON.parse(readFileSync(new URL("./installer/releases.json", import.meta.url), "utf8")).releases;
const raw = new Uint8Array(readFileSync(new URL(`./installer/firmware/remote-${rels[0].version}.fwsc`, import.meta.url)));
const sha = createHash("sha256").update(raw).digest("hex");
const RELEASES = [{ version: "9.9", sha256: sha }];
const BASE = "https://fw.example/rfm1/", V15 = "https://fw.example/v15/FM-1.fwsc";
// the "V15" of these tests: the same bytes (identity FM-1_015) under their own SHA-256, given as the V15's
const V15_SHA = sha;
const pkg = await packageFrom(raw);
const BLOCKS = Math.ceil(pkg.image.length / 512);

// a fake fetch: url -> bytes | status | "network" (throws, as fetch does offline) | an object (JSON). Each call is a
// sync point ("fetch <file name>"); an aborted signal rejects as fetch does
const RELEASES_URL = new URL("./installer/releases.json", import.meta.url).href;
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(url);
    await point(`fetch ${url.split("/").pop()}`);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    let r = routes[url];
    if (r === "network") throw new TypeError("Failed to fetch");
    if (r === undefined) r = 404;
    if (typeof r === "number") return { ok: false, status: r, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    if (!(r instanceof Uint8Array)) return { ok: true, status: 200, headers: new Map(), json: async () => r };
    return { ok: true, status: 200, headers: new Map([["content-length", String(r.length)]]), arrayBuffer: async () => r.slice().buffer };
  };
  f.calls = calls;
  return f;
}
const ROUTES = { [`${BASE}remote-9.9.fwsc`]: raw, [V15]: raw, [RELEASES_URL]: { releases: RELEASES } };

// an engine on a port; call(op, args) -> the final reply; events: every event since the last call; replies: every
// reply, in order. The MIDI access is a sync point ("midi"), and so are the fake FM-1's ports and messages
function rig({ dev = null, routes = ROUTES, midi, releases = RELEASES, idleMs } = {}) {
  const { port1, port2 } = new MessageChannel();
  // (a rejected rx point: the fake FM-1 never takes that message nor any after it, it goes silent)
  if (dev && dev.gate === null) dev.gate = (kind) => kind === "open" ? point("open") : point(`rx ${kind}`).catch(() => new Promise(() => {}));
  const engine = createEngine({ requestMIDIAccess: midi || (async () => { await point("midi"); return dev.access; }), fetch: fakeFetch(routes), releases,
                                v15Sha256: V15_SHA, idleMs });
  engine.attach(port2);
  const waiting = new Map(), events = [], replies = [];
  let n = 0;
  port1.onmessage = (ev) => {
    const m = ev.data;
    if (m.event) { events.push(m); return; }
    replies.push(m);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (op, args = {}) => { const id = ++n; const p = new Promise((r) => waiting.set(id, r)); port1.postMessage({ id, op, ...args }); return p; };
  // any message (not a request of send's): post it raw
  const post = (msg) => port1.postMessage(msg);
  return { send, post, events, replies, engine, close: () => { port1.close(); port2.close(); },
           async call(op, args) { events.length = 0; return send(op, args); } };
}
const configured = async (o) => { const r = rig(o); await r.call("config", { v15Url: V15, firmwareBase: BASE.slice(0, -1) }); return r; };
const stages = (evs) => evs.filter((e) => e.event === "progress").map((e) => e.stage).filter((s, i, a) => s !== a[i - 1]);

// ---- the handshake (boot): ready to the parent; connect only from the parent, same origin
{
  const posted = [], listeners = [];
  const parent = { postMessage: (m, o) => posted.push([m, o]) };
  const win = { location: { origin: "https://tutti.example" }, parent, addEventListener: (t, f) => listeners.push(f) };
  boot(win, {}, { releases: RELEASES, fetch: fakeFetch(ROUTES) });
  ok(posted.length === 1 && posted[0][0].type === "rfm1-engine-ready" && posted[0][0].protocol === PROTOCOL && PROTOCOL === 1 &&
     posted[0][1] === "https://tutti.example", "boot: posts rfm1-engine-ready, protocol 1, to the parent's origin");
  const tryConnect = async (source, origin) => {
    const { port1, port2 } = new MessageChannel();
    listeners.forEach((f) => f({ source, origin, data: { type: "rfm1-engine-connect" }, ports: [port2] }));
    const got = await new Promise((r) => { port1.onmessage = (e) => r(e.data); port1.postMessage({ id: 1, op: "config", firmwareBase: BASE }); realTimeout(() => r(null), 1000); });
    port1.close(); port2.close();
    return got;
  };
  ok(await tryConnect({}, "https://tutti.example") === null, "boot: a connect from another window than the parent is ignored");
  ok(await tryConnect(parent, "https://evil.example") === null, "boot: a connect from another origin is ignored");
  const r = await tryConnect(parent, "https://tutti.example");
  ok(r && r.id === 1 && r.ok && r.result.firmwareBase === BASE && r.result.protocol === 1, "boot: the parent's connect: the port serves config");
}

// ---- installer.js's pure decisions (the page and the engine both use them)
{
  const sloop = { identity: "FM-1_900", port: "Felucca", version: "FELUCCA SLOOP 2.2", fw: { verdict: "refuse", kind: "sloop", name: "Sloop" }, remote: null };
  const bubba = { identity: "FM-1_003", port: "FM-1 Bubba Machine", fw: { verdict: "refuse", kind: "bubba", name: "Bubba Machine (FM-1_003)" }, remote: null };
  const stock = { identity: "FM-1_015", port: "FM-1", fw: { verdict: "allow", kind: "stock", name: "x" }, remote: null };
  const baud = { identity: "FM-1_101", port: "FM-1+VA", fw: { verdict: "refuse", kind: "unknown", name: "x" }, remote: null };
  const v15 = { official: true }, rem = { official: false };
  ok(decide(sloop, rem, { midiClosed: true }).action === "refuse" && decide(sloop, rem, {}).overridable, "decide: RemoteFM1 over SLOOP refused, the page's override offered");
  ok(decide(sloop, v15, { midiClosed: true, detour: true }).reason === "detour", "decide: the official V15 over SLOOP (the detour) allowed");
  ok(decide(bubba, v15, { midiClosed: true, detour: true, override: true }).reason === "bubba" && !decide(bubba, v15, {}).overridable, "decide: Bubba Machine refused, even the V15, no override");
  ok(decide(baud, v15, { midiClosed: true, detour: true }).action === "refuse", "decide: Baud Girl (FM-1_101): no detour either");
  ok(decide(stock, rem, {}).reason === "midi" && decide(stock, rem, { midiClosed: true }).action === "install", "decide: over stock: the page's MIDI box, then install");
  ok(decide({ loader: true, identity: "ota-FM-1_900" }, rem, {}).action === "resume", "decide: update mode: resume");
  ok([stock, sloop, bubba, baud, { loader: true }, { none: true }].map(restorePathOf).join() === "direct,v15,external,unsupported,resume,none",
     "restorePathOf: direct, v15, external (Bubba), unsupported, resume, none");
  ok(stateOf({ none: true }).port === null, "stateOf: no FM-1: port null");
}

// ---- look, for each firmware and mode
const lookAs = async (o, extra = {}) => { const dev = new FakeFM1(pkg.image, o); const r = await configured({ dev, ...extra }); const m = await r.call("look", {}); r.close(); return m; };
let m = await lookAs({});
ok(m.ok && m.result.mode === "normal" && J(m.result.firmware) === J({ kind: "stock", identity: "FM-1_015" }) && J(m.result.port) === J({ input: "FM-1", output: "FM-1" }) &&
   m.result.resumable === false && m.result.previous.name === "FM-1_015", "look: stock V15 / TransitFM1 (no HELLO answer)", J(m));
m = await lookAs({ remote: "9.9" });
ok(m.ok && J(m.result.firmware) === J({ kind: "remote", version: "9.9", current: true }) && m.result.previous.sha256 === sha, "look: RemoteFM1, current (its previous record has the release's SHA-256)", J(m));
m = await lookAs({ remote: "0.1" });
ok(m.ok && J(m.result.firmware) === J({ kind: "remote", version: "0.1", current: false }), "look: RemoteFM1, older", J(m));
m = await lookAs({ identity: "FM-1_910", name: "Felucca", version: "FELUCCA v1.0.1" });
ok(m.ok && m.result.firmware.kind === "custom" && m.result.firmware.name === "Felucca" && m.result.firmware.version === "1.0.1" && m.result.firmware.direct &&
   m.result.firmware.holdsUserData && /hugelton/.test(m.result.firmware.editorUrl), "look: Felucca 1.0.1: custom, direct, holds user data, its editor", J(m));
m = await lookAs({ identity: "FM-1_920", name: "ChoralRoot FM-1", version: "ChoralRoot 0.25.1" });
ok(m.ok && m.result.firmware.kind === "custom" && m.result.firmware.name === "ChoralRoot" && m.result.firmware.direct, "look: ChoralRoot: custom, direct", J(m));
m = await lookAs({ identity: "FM-1_900", name: "Felucca", version: "FELUCCA SLOOP 2.2" });
ok(m.ok && m.result.firmware.kind === "custom" && m.result.firmware.name === "SLOOP" && m.result.firmware.version === "2.2" && !m.result.firmware.direct &&
   m.result.firmware.holdsUserData && /sloop-fm1/.test(m.result.firmware.editorUrl), "look: SLOOP: custom, V15 detour, holds user data", J(m));
m = await lookAs({ identity: "FM-1_900", name: "JIANT FM", version: "JIANT 0.9.10" });
ok(m.ok && m.result.firmware.kind === "custom" && m.result.firmware.name === "JIANT" && !m.result.firmware.direct && m.result.firmware.holdsUserData,
   "look: JIANT (its own port name): custom, V15 detour, holds user data", J(m));
m = await lookAs({ identity: "FM-1_909", name: "Felucca", version: "FELUCCA 0.9-BETA" });
ok(m.ok && m.result.firmware.kind === "custom" && !m.result.firmware.direct, "look: a Felucca beta: custom, V15 detour", J(m));
m = await lookAs({ identity: "FM-1_003", name: "FM-1 Bubba Machine" });
ok(m.ok && m.result.firmware.kind === "bubba", "look: Bubba Machine", J(m));
m = await lookAs({ identity: "FM-1_101", name: "FM-1+VA" });
ok(m.ok && J(m.result.firmware) === J({ kind: "unknown", identity: "FM-1_101" }), "look: an identity the table does not know (Baud Girl): unknown", J(m));
m = await lookAs({ identity: "ota-FM-1_900", name: "Felucca Update" });
ok(m.ok && m.result.mode === "update" && m.result.firmware === null && m.result.resumable, "look: update mode (our loader): resumable", J(m));
m = await lookAs({ identity: "ota-FM-1_015", name: "ota-FM-1" });
ok(m.ok && m.result.mode === "update" && m.result.resumable, "look: the official loader's update mode: resumable (with the V15)", J(m));
{
  const r = await configured({ dev: { access: { inputs: new Map(), outputs: new Map() } } });
  m = await r.call("look", {}); r.close();
  ok(m.ok && m.result.port === null && m.result.firmware === null, "look: no FM-1: port null", J(m));
}
{
  const a = new FakeFM1(pkg.image, { remote: "9.9" }), b = new FakeFM1(pkg.image, { identity: "FM-1_910", name: "Felucca", version: "FELUCCA v1.0.1" });
  const access = { inputs: new Map([...a.access.inputs, ...b.access.inputs]), outputs: new Map([...a.access.outputs, ...b.access.outputs]) };
  const r = await configured({ dev: { access } });
  const both = await r.call("look", {}), hinted = await r.call("look", { portHint: "Felucca" });
  r.close();
  ok(!both.ok && both.error.code === "refused" && /several/.test(both.error.detail) && hinted.ok && hinted.result.firmware.name === "Felucca",
     "look: two FM-1s refused; portHint picks one", J([both, hinted]));
}

// ---- a direct install, its progress order
{
  const dev = new FakeFM1(pkg.image, { finalRemote: "9.9" }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" } });
  const st = stages(r.events), writes = r.events.filter((e) => e.stage === "write");
  ok(res.ok && res.result.installed.firmware.kind === "remote" && res.result.installed.firmware.current && dev.upgrades === 2 && dev.bad === 0,
     "install remote over stock: installed, both steps served right, confirmed by HELLO", J(res));
  ok(J(st) === J(["download", "verify", "enter-update", "write", "reboot", "confirm"]), "progress: download, verify, enter-update, write, reboot, confirm", J(st));
  ok(writes.length === 7 && writes.every((e) => e.total === BLOCKS) && writes.map((e) => e.done).join() === "0,1,2,3,4,5,6",
     `progress: write counts blocks (done 0..6 of ${BLOCKS}: 0 once the loader is found)`, J(writes));
  ok(r.events.filter((e) => e.event === "progress").every((e) => typeof e.done === "number" && typeof e.total === "number"), "progress: every event has done and total");
  ok(r.events.some((e) => e.event === "port" && e.state === "lost") && r.events.some((e) => e.event === "port" && e.state === "found"),
     "port events: lost and found while the FM-1 restarts");
  r.close();
}
{
  const dev = new FakeFM1(pkg.image, { identity: "FM-1_910", name: "Felucca", version: "FELUCCA v1.0.1", finalRemote: "9.9" }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(res.ok && dev.bad === 0, "install remote over Felucca 1.0.1 (custom, direct): installed", J(res));
}

// ---- the V15 detour: refused direct, then V15, then RemoteFM1 (on the same unit)
{
  const dev = new FakeFM1(pkg.image, { identity: "FM-1_900", name: "Felucca", version: "FELUCCA SLOOP 2.2", final: "FM-1_015", finalRemote: null });
  const r = await configured({ dev });
  const direct = await r.call("install", { target: { kind: "remote" } });
  ok(!direct.ok && direct.error.code === "refused" && dev.upgrades === 0, "detour 1: RemoteFM1 over SLOOP refused, nothing sent", J(direct));
  const v = await r.call("install", { target: { kind: "v15" } });
  ok(v.ok && v.result.installed.firmware.kind === "stock" && dev.upgrades === 2 && dev.bad === 0, "detour 2: the official V15 over SLOOP: installed, the unit answers stock", J(v));
  dev.setImage(pkg.image, { final: "FM-1_015", finalRemote: "9.9" });
  const rem = await r.call("install", { target: { kind: "remote" } });
  ok(rem.ok && rem.result.installed.firmware.kind === "remote" && dev.upgrades === 4 && dev.bad === 0, "detour 3: then RemoteFM1 over the V15: installed", J(rem));
  ok(r.send && J(dev.writes) === J(["FM-1_015", "FM-1_015"]), "detour: two writes, no more");
  r.close();
}

// ---- resume from update mode
{
  const dev = new FakeFM1(pkg.image, { identity: "ota-FM-1_900", name: "Felucca Update", finalRemote: "9.9" }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" }, resume: true });
  const st = stages(r.events);
  ok(res.ok && res.result.installed.firmware.kind === "remote" && dev.upgrades === 1 && dev.bad === 0, "resume: the cut-off write finished from update mode", J(res));
  ok(J(st) === J(["download", "verify", "write", "reboot", "confirm"]), "resume progress: download, verify, write, reboot, confirm", J(st));
  r.close();
}
{
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" }, resume: true });
  r.close();
  ok(!res.ok && res.error.code === "refused" && dev.upgrades === 0, "resume: refused when the FM-1 is not in update mode", J(res));
}
{
  const dev = new FakeFM1(pkg.image, { identity: "ota-FM-1_015", name: "ota-FM-1" }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "package", url: `${BASE}remote-9.9.fwsc`, sha256: "0".repeat(64), label: "x" } });
  r.close();
  ok(!res.ok && res.error.code === "verifyFailed" && dev.upgrades === 0, "a package whose SHA-256 is not the one given: verifyFailed, nothing sent", J(res));
}

// ---- errors
{
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev, routes: {} });
  const res = await r.call("install", { target: { kind: "remote" } });
  ok(!res.ok && res.error.code === "firmwareUnavailable" && res.error.httpStatus === 404 && dev.upgrades === 0, "firmwareUnavailable: a 404, with httpStatus, nothing sent", J(res));
  const v = await r.call("install", { target: { kind: "v15" } });
  ok(!v.ok && v.error.code === "firmwareUnavailable" && v.error.httpStatus === 404, "firmwareUnavailable: the V15's URL 404", J(v));
  r.close();
}
{
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev, routes: { [`${BASE}remote-9.9.fwsc`]: "network" } });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "firmwareUnavailable" && res.error.httpStatus === undefined && dev.upgrades === 0, "firmwareUnavailable: a network error, nothing sent", J(res));
}
{
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev, routes: { [`${BASE}remote-9.9.fwsc`]: 503 } });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "firmwareUnavailable" && res.error.httpStatus === 503, "firmwareUnavailable: a 503", J(res));
}
for (const [o, what] of [[{ held: true }, "held by another app (open fails)"], [{ mute: true }, "flooded, answers nothing"]]) {
  const dev = new FakeFM1(pkg.image, o), r = await configured({ dev });
  const l = await r.call("look", {}), i = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!l.ok && l.error.code === "portBusy" && !i.ok && i.error.code === "portBusy" && dev.upgrades === 0, `portBusy: the port ${what}: look and install`, J([l, i]));
}
{
  const dev = new FakeFM1(pkg.image, { unplugAt: 3 }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" } });
  const after = await r.call("look", {});
  r.close();
  ok(!res.ok && res.error.code === "disconnected" && r.events.length >= 0 && after.ok && after.result.port === null, "disconnected: unplugged mid-write; look then finds no FM-1", J([res, after]));
}
{
  const r = await configured({ midi: async () => { throw Object.assign(new Error("denied"), { name: "SecurityError" }); } });
  const a = await r.call("look", {});
  r.close();
  const r2 = await configured({ midi: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
  const b = await r2.call("install", { target: { kind: "remote" } });
  r2.close();
  ok(!a.ok && a.error.code === "sysexDenied" && !b.ok && b.error.code === "sysexDenied", "sysexDenied: SecurityError and NotAllowedError", J([a, b]));
}
{
  const dev = new FakeFM1(pkg.image, { identity: "FM-1_003", name: "FM-1 Bubba Machine" }), r = await configured({ dev });
  const a = await r.call("install", { target: { kind: "remote" } }), b = await r.call("install", { target: { kind: "v15" } });
  r.close();
  ok(!a.ok && a.error.code === "refused" && !b.ok && b.error.code === "refused" && dev.upgrades === 0, "refused: Bubba Machine, RemoteFM1 or the V15; nothing sent", J([a, b]));
}
// ---- cancel and busy, held at the sync points (no clock: each test stops the engine at a point, answers, releases)

// run an install to its sync point key (null: through, no stop) -> { hit, reply, cancel, sentAtAck, trace }
// whileHeld(r, dev): what the host does while the engine is held there (default: a cancel)
const IDLE = { step1: 1000, write: 1000 };            // (the stall tests: how long a silent FM-1 is waited for)
// fail: the held operation then rejects (with failureAt(key)) instead of going on
async function installHeld(scn, key, whileHeld = async (r) => ({ cancel: await r.send("cancel", {}) }), { fail = false } = {}) {
  const dev = scn.dev(), r = await configured({ dev, releases: null });
  sync.trace = []; sync.target = key;
  const hit = key ? new Promise((res) => { sync.hit = res; }) : null;
  const inst = r.send("install", scn.args);
  const h = key ? await Promise.race([hit, inst.then(() => null)]) : null;
  let held = {}, sentAtAck = null;
  if (h) {
    held = await whileHeld(r, dev);
    sentAtAck = dev.sent.length;
    if (fail) h.reject(failureAt(h.key)); else h.release();
  }
  const reply = await inst;
  sync.target = null;
  const trace = sync.trace.slice();
  r.close();
  return { hit: !!h, reply, ...held, sentAtAck, dev, trace };
}
// the sync points of a run before the second update request (the loader's; the resume's first) and where the commit
// to the write is: the update's own handshake (its find(): the last port opened before the first update request)
function pointsOf(trace, upgrades) {
  const upAt = trace.findIndex((k) => k === `rx upgrade#${upgrades}`);
  const head = trace.slice(0, upAt + 1).filter((k) => !k.startsWith("rx data"));
  const firstUp = head.findIndex((k) => k === "rx upgrade#1");
  let commit = firstUp;
  while (commit > 0 && !head[commit - 1].startsWith("open")) commit--;
  while (commit > 0 && head[commit - 1].startsWith("open")) commit--;
  return { head, commit };
}
const WRITE_KINDS = ["upgrade", "data"];
// what a rejected sync point fails with: a download error, a denied permission, a port that won't open, a failed
// digest; at a message the fake FM-1 takes, (rig) it goes silent
function failureAt(key) {
  if (key.startsWith("fetch ")) return new TypeError("Failed to fetch");
  if (key.startsWith("midi")) return Object.assign(new Error("denied"), { name: "NotAllowedError" });
  if (key.startsWith("open")) return Object.assign(new Error("port in use"), { name: "InvalidAccessError" });
  if (key.startsWith("digest")) return new Error("digest failed");
  return new Error("silent");
}
const SCENARIOS = [
  // the V15 detour's two installs, each its own op: the V15 over SLOOP (its context() fetches releases.json last,
  // after the look: the review's case), then RemoteFM1 over the V15 the unit then runs
  { what: "detour 1: the V15 over SLOOP", args: { target: { kind: "v15" } }, upgrades: 2,
    dev: () => new FakeFM1(pkg.image, { identity: "FM-1_900", name: "Felucca", version: "FELUCCA SLOOP 2.2", final: "FM-1_015", finalRemote: null }) },
  { what: "detour 2: RemoteFM1 over the V15", args: { target: { kind: "remote" } }, upgrades: 2,
    dev: () => new FakeFM1(pkg.image, { finalRemote: "9.9" }) },
  { what: "a package (restore) over stock", args: { target: { kind: "package", url: `${BASE}remote-9.9.fwsc`, sha256: sha, label: "x" } }, upgrades: 2,
    dev: () => new FakeFM1(pkg.image, { finalRemote: "9.9" }) },
  { what: "resume from update mode", args: { target: { kind: "remote" }, resume: true }, upgrades: 1,
    dev: () => new FakeFM1(pkg.image, { identity: "ota-FM-1_900", name: "Felucca Update", finalRemote: "9.9" }) },
];
for (const scn of SCENARIOS) {
  const ref = await installHeld(scn, null);
  const { head, commit } = pointsOf(ref.trace, scn.upgrades);
  ok(ref.reply.ok && ref.dev.bad === 0 && commit > 0 && head.length > commit, `cancel, ${scn.what}: the run through (${commit} points before the write, ${head.length - commit} after)`,
     J([ref.reply, head]));
  let pre = 0, post = 0;
  const bad = [];
  for (let k = 0; k < head.length; k++) {
    const t = await installHeld(scn, head[k]);
    const after = t.sentAtAck === null ? [] : t.dev.sent.slice(t.sentAtAck);
    if (k < commit) {
      // before the write: the cancel is acknowledged, the install ends cancelled, and no write SysEx ever leaves
      const good = t.hit && t.cancel.ok && t.cancel.result.cancelled === true && !t.reply.ok && t.reply.error.code === "cancelled" &&
                   /^cancelled/.test(t.reply.error.detail) && !after.some((x) => WRITE_KINDS.includes(x)) && t.dev.upgrades === 0 && t.dev.served === 0;
      if (good) pre++; else bad.push([head[k], t.cancel, t.reply, after]);
    } else {
      // after the commit: busy, never "cancelled", and the install finishes
      const good = t.hit && !t.cancel.ok && t.cancel.error.code === "busy" && t.reply.ok && t.dev.bad === 0;
      if (good) post++; else bad.push([head[k], t.cancel, t.reply]);
    }
  }
  ok(pre === commit, `cancel, ${scn.what}: at each of the ${commit} points before the write: cancelled, no write SysEx after the ack`, J(bad));
  ok(post === head.length - commit, `cancel, ${scn.what}: at each of the ${head.length - commit} after (to the loader's UPGRADE): busy, the install finishes`, J(bad));
  // the same points, the awaited operation then rejected (a download error, sysex denied, a port that won't open, a
  // silent FM-1): an acknowledged cancel still ends "cancelled", never the failure, and no write SysEx leaves.
  // (The control, without the cancel: the same rejection ends in its own error, never "cancelled"; or the engine
  // tolerates it (a later probe's port that won't open, context()'s releases.json) and the install goes on.)
  let rej = 0, own = 0, fatal = 0;
  const badRej = [];
  for (let k = 0; k < commit; k++) {
    const t = await installHeld(scn, head[k], undefined, { fail: true });
    const after = t.sentAtAck === null ? [] : t.dev.sent.slice(t.sentAtAck);
    if (t.hit && t.cancel.ok && t.cancel.result.cancelled === true && !t.reply.ok && t.reply.error.code === "cancelled" &&
        /^cancelled/.test(t.reply.error.detail) && !after.some((x) => WRITE_KINDS.includes(x)) && t.dev.upgrades === 0 && t.dev.served === 0) rej++;
    else badRej.push([head[k], t.cancel, t.reply, after]);
    const c = await installHeld(scn, head[k], async () => ({}), { fail: true });
    if (c.hit && (c.reply.ok ? c.dev.bad === 0 : c.reply.error.code !== "cancelled" && c.dev.upgrades === 0)) own++;
    else badRej.push(["no cancel", head[k], c.reply]);
    if (!c.reply.ok) fatal++;
  }
  ok(rej === commit, `cancel, ${scn.what}: at each of the ${commit}, the operation then rejected: cancelled, no write SysEx`, J(badRej));
  ok(own === commit && fatal > 0, `cancel, ${scn.what}: (control) without the cancel: ${fatal} of them fail on their own error, never cancelled`, J(badRej));
}
{   // the review's case by name: a cancel while context() fetches releases.json, after the look, just before the write
  const scn = SCENARIOS[0];
  const t = await installHeld(scn, "fetch releases.json#1");
  ok(t.hit && t.cancel.ok && t.cancel.result.cancelled && !t.reply.ok && t.reply.error.code === "cancelled" && t.dev.upgrades === 0 && t.dev.sent.every((x) => !WRITE_KINDS.includes(x)) &&
     t.trace.includes("rx hs#1"), "cancel during the last await before the write (context(): releases.json): cancelled, nothing written", J([t.cancel, t.reply, t.dev.sent]));
}
{   // busy: a second install, a look, a cancel while held at step 1's update request and at the loader's
  const scn = SCENARIOS[1];
  const t = await installHeld(scn, "rx upgrade#1", async (r) => ({
    second: await r.send("install", { target: { kind: "remote" } }), look: await r.send("look", {}), cancel: await r.send("cancel", {}) }));
  ok(!t.second.ok && t.second.error.code === "busy" && !t.look.ok && t.look.error.code === "busy", "busy: a second install (and a look) while one runs", J([t.second, t.look]));
  ok(!t.cancel.ok && t.cancel.error.code === "busy" && t.reply.ok && t.dev.bad === 0 && J(t.dev.writes) === J(["FM-1_015"]),
     "cancel at the update request (step 1): busy; the install finishes", J([t.cancel, t.reply]));
  const l = await installHeld(scn, "rx upgrade#2");
  ok(!l.cancel.ok && l.cancel.error.code === "busy" && l.reply.ok && l.dev.bad === 0, "cancel at the loader's update request: busy; the install finishes", J([l.cancel, l.reply]));
}
{   // a cancel during the download aborts the fetch; a second cancel then, and one with nothing running
  const scn = SCENARIOS[1];
  const t = await installHeld(scn, "fetch remote-9.9.fwsc#1", async (r) => ({ cancel: await r.send("cancel", {}), again: await r.send("cancel", {}) }));
  ok(t.cancel.ok && t.cancel.result.cancelled && t.again.ok && t.again.result.cancelled && !t.reply.ok && t.reply.error.code === "cancelled" &&
     t.dev.sent.length === 0, "cancel during the download: cancelled, the MIDI port never touched", J([t.cancel, t.again, t.reply, t.dev.sent]));
  const r = await configured({ dev: scn.dev() });
  const idle = await r.send("cancel", {});
  r.close();
  ok(idle.ok && idle.result.cancelled === false, "cancel with nothing running: ok, cancelled false", J(idle));
}
{   // a look can't be cancelled
  const r = await configured({ dev: new FakeFM1(pkg.image, {}) });
  sync.trace = []; sync.target = "rx hs#1";
  const hit = new Promise((res) => { sync.hit = res; });
  const l = r.send("look", {});
  const h = await hit, c = await r.send("cancel", {});
  h.release();
  const lr = await l;
  r.close();
  ok(!c.ok && c.error.code === "busy" && lr.ok, "cancel during a look: busy (only an install is cancelled); the look answers", J([c, lr]));
}

// ---- stalls: step 1's (nothing written: portBusy) and the loader's, before its first read (timeout)
{
  const dev = new FakeFM1(pkg.image, { stall: true }), r = await configured({ dev, idleMs: IDLE });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "portBusy" && dev.writes.length === 0 && dev.upgrades === 1 && !dev.sent.includes("data"),
     "portBusy: step 1 stalls after UPGRADE (TransitFM1 0.1.1): nothing written", J(res));
}
{
  const dev = new FakeFM1(pkg.image, { loaderStall: true }), r = await configured({ dev, idleMs: IDLE });
  const res = await r.call("install", { target: { kind: "remote" } });
  const w = r.events.filter((e) => e.stage === "write");
  r.close();
  ok(!res.ok && res.error.code === "timeout" && dev.upgrades === 2 && dev.loaderReads === 0 && w.length === 1 && w[0].done === 0 && w[0].total === BLOCKS,
     "timeout: the loader stalls before its first read (not portBusy); progress write 0 came first", J([res, w]));
}
{
  const dev = new FakeFM1(pkg.image, { identity: "ota-FM-1_900", name: "Felucca Update", loaderStall: true }), r = await configured({ dev, idleMs: IDLE });
  const res = await r.call("install", { target: { kind: "remote" }, resume: true });
  r.close();
  ok(!res.ok && res.error.code === "timeout" && dev.loaderReads === 0, "timeout: a resume whose loader stalls before its first read", J(res));
}

// ---- the dispatch: own op names only, strings only, every check inside the error boundary; one reply per request
{
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev });
  const ids = [];
  const raw = (msg) => { ids.push(msg.id); r.post(msg); };
  const OPS_BAD = [["unknown", "frobnicate"], ["inherited", "toString"], ["inherited", "constructor"], ["inherited", "__proto__"],
                   ["inherited", "hasOwnProperty"], ["inherited", "valueOf"], ["non-string", 42], ["non-string", { op: "install" }],
                   ["non-string", ["install"]], ["non-string", null], ["non-string", true], ["non-string", 1n]];
  OPS_BAD.forEach(([, op], k) => raw({ id: `op-${k}`, op }));
  raw({ id: "no-op" });                                                       // missing op
  const ARGS_BAD = [["install", {}], ["install", { target: "remote" }], ["install", { target: ["remote"] }], ["install", { target: null }],
                    ["install", { target: { kind: 5 } }], ["install", { target: { kind: "remote" }, resume: "yes" }],
                    ["look", { portHint: 5 }], ["look", { portHint: "" }], ["config", { v15Url: 5 }], ["config", { firmwareBase: {} }]];
  ARGS_BAD.forEach(([op, a], k) => raw({ ...a, id: `args-${k}`, op }));
  r.post("install"); r.post(null); r.post(7); r.post({ foo: 1 });             // not requests: no id, no op
  const last = await r.send("config", {});                                   // (answered after every one above)
  const byId = (id) => r.replies.filter((m) => m.id === id);
  const opErr = OPS_BAD.map(([, op], k) => byId(`op-${k}`)).concat([byId("no-op")]);
  ok(opErr.every((a) => a.length === 1 && !a[0].ok && a[0].error.code === "internal"),
     "dispatch: unknown, inherited (toString, constructor...), non-string (an object, BigInt...) and missing ops: one internal reply each", J(opErr));
  const argErr = ARGS_BAD.map((_, k) => byId(`args-${k}`));
  ok(argErr.every((a) => a.length === 1 && !a[0].ok && a[0].error.code === "refused" && /^bad request/.test(a[0].error.detail)) && dev.sent.length === 0,
     "dispatch: malformed arguments: one refused (bad request) reply each, the FM-1 never touched", J(argErr));
  ok(last.ok && r.replies.length === ids.length + 2 && r.replies.every((m) => m.id !== undefined),
     "dispatch: exactly one reply per request, none to a message that is not one", J(r.replies.length));
  const after = await r.call("look", {});
  ok(after.ok && after.result.firmware.kind === "stock", "dispatch: the engine still serves after them (nothing left running)", J(after));
  // the same through handle() itself: a getter that throws, an op whose toString throws (never reached: not a string)
  const direct = await Promise.all([r.engine.handle({ id: "d1", op: { toString() { throw new Error("x"); } } }), r.engine.handle({ get id() { throw new Error("x"); }, op: "look" })]);
  const one = await r.send("config", {});
  ok(direct.every((x) => x === undefined) && one.ok && byId("d1").length === 1 && byId("d1")[0].error.code === "internal",
     "dispatch: handle() never throws (an op object with a throwing toString; an id getter that throws)", J(byId("d1")));
  r.close();
}
{
  const r = await configured({ dev: new FakeFM1(pkg.image, {}) });
  const t = await r.call("install", { target: { kind: "nope" } });
  r.close();
  ok(!t.ok && t.error.code === "refused", "an unknown target kind: refused", J(t));
}
{
  const dev = new FakeFM1(pkg.image, {}), r = rig({ dev });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "internal" && /firmwareBase/.test(res.error.detail), "install before config: internal (no firmwareBase), nothing fetched");
}
{   // the page's look() is unchanged by the engine's wider port list: JIANT's own port name is the engine's only
  const dev = new FakeFM1(pkg.image, { identity: "FM-1_900", name: "JIANT FM", version: "JIANT 0.9.10" });
  ok((await look(dev.access)).none, "the page's look(): JIANT FM's port not probed (the page unchanged)");
}

ok(unhandled === 0, "no unhandled rejection in the whole run", String(unhandled));
console.log(fails ? `engine: ${fails} of ${checks} FAILED` : `engine tests passed (${checks})`);
process.exit(fails ? 1 : 0);
