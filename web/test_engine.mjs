// SPDX-License-Identifier: GPL-3.0-only
// The headless engine (engine.js, protocol v1.1, docs/ENGINE.md) driven through a real MessagePort (Node's
// MessageChannel) against the simulated FM-1 of installer/fake_fm1.mjs and a fake fetch: the handshake, look for each
// firmware and mode, a direct install, the V15 detour (refused direct, V15, then RemoteFM1), resume from update mode,
// the errors (firmwareUnavailable on a 404 and a network error, portBusy, sysexDenied, disconnected mid-write, busy,
// refused, cancelled, timeout on a loader's stall) and the progress order; a cancel at every sync point before and
// after the commit to the write (no write SysEx after an acknowledged cancel; cancelled even when the awaited operation
// then fails: a download error, sysex denied, a port that won't open, a silent FM-1); the dispatch (unknown, inherited,
// non-string and missing ops, malformed arguments: one reply each); v1.1 (expect: unitChanged, ambiguousUnit, on a bench of
// fake units swapped or added while an install is held). Plus installer.js's pure decisions. Never against
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
  // (a rejected rx point: the fake FM-1 never takes that message nor any after it, it goes silent). A bench (below):
  // each of its units, plugged in or not yet
  for (const u of dev && dev.units ? dev.units : [dev])
    if (u && u.gate === null) u.gate = (kind) => kind === "open" ? point("open") : point(`rx ${kind}`).catch(() => new Promise(() => {}));
  // (the engine's log: its commit to the write goes into sync.trace as "commit", a marker, not a point)
  const engine = createEngine({ requestMIDIAccess: midi || (async () => { await point("midi"); return dev.access; }), fetch: fakeFetch(routes), releases,
                                v15Sha256: V15_SHA, idleMs, log: (s) => { if (s === "install: commit") sync.trace.push("commit"); } });
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
// a bench: several fake FM-1s on one MIDI access (protocol v1.1's tests). units: every unit of the test (all gated);
// plugged: those connected at first. pull(u): unplugged; plug(u): connected (the access lists it from then on);
// flap(u): its very port objects disconnected and connected again, at once (a browser that keeps a replugged unit's
// MIDIPort objects and ids: only the statechange events tell). The units' statechange events reach the bench's access
function bench(units, plugged = units) {
  const on = new Set(plugged);
  const merged = (k) => new Map([...on].flatMap((u) => [...u.access[k]]));
  const access = { get inputs() { return merged("inputs"); }, get outputs() { return merged("outputs"); }, onstatechange: null };
  const fire = (port) => { if (access.onstatechange) access.onstatechange({ port }); };
  for (const u of units) u.access.onstatechange = (ev) => { if (on.has(u) || ev.port.state === "disconnected") fire(ev.port); };
  return { units, access,
           pull(u) { u.unplug(); on.delete(u); },
           plug(u) { on.add(u); fire(u.input); fire(u.output); },
           flap(u) { for (const p of [u.input, u.output]) { p.state = "disconnected"; fire(p); } for (const p of [u.input, u.output]) { p.state = "connected"; fire(p); } } };
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
     posted[0][0].minor === 1 && posted[0][1] === "https://tutti.example", "boot: posts rfm1-engine-ready, protocol 1 (minor 1: v1.1), to the parent's origin");
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
// ---- the shipped releases (installer/releases.json as Pages serves it, its real packages): 0.2.1 is current, 0.1.1
// older (offered the update); installing writes 0.2.1's image, its blocks counted
{
  const relDoc = JSON.parse(readFileSync(new URL("./installer/releases.json", import.meta.url), "utf8"));
  const fw = (v) => new Uint8Array(readFileSync(new URL(`./installer/firmware/remote-${v}.fwsc`, import.meta.url)));
  const raw021 = fw("0.2.1"), raw011 = fw("0.1.1");
  const sha021 = createHash("sha256").update(raw021).digest("hex");
  const pkg021 = await packageFrom(raw021), pkg011 = await packageFrom(raw011);
  const BLOCKS021 = Math.ceil(pkg021.image.length / 512);
  ok(relDoc.releases[0].version === "0.2.1" && relDoc.releases[0].latest === true && sha021 === "62a6b619c73b88248591067bd414124b288fa7628b26cc2b3895a2957f52f362"
     && relDoc.releases[0].sha256 === sha021 && relDoc.releases.some((r) => r.version === "0.1.1"),
     "releases.json: 0.2.1 first and latest (TuttiDAW's SHA-256), 0.1.1 still listed");
  ok(pkg021.image.length !== pkg011.image.length || pkg021.image.some((b, i) => b !== pkg011.image[i]), "0.2.1's image is not 0.1.1's");
  // releases: null: the engine reads releases.json itself (the route serves the file's own content)
  const routes = { [`${BASE}remote-0.2.1.fwsc`]: raw021, [`${BASE}remote-0.1.1.fwsc`]: raw011, [V15]: raw, [RELEASES_URL]: relDoc };
  const shipped = async (o) => { const dev = new FakeFM1(pkg021.image, o); return { dev, r: await configured({ dev, routes, releases: null }) }; };
  let { dev, r } = await shipped({ remote: "0.1.1" });
  m = await r.call("look", {}); r.close();
  ok(m.ok && J(m.result.firmware) === J({ kind: "remote", version: "0.1.1", current: false }) && m.result.previous.sha256 === relDoc.releases[1].sha256,
     "look on a 0.1.1 unit: RemoteFM1 0.1.1, not current (the update to 0.2.1 is offered)", J(m));
  ({ dev, r } = await shipped({ remote: "0.2.1" }));
  m = await r.call("look", {}); r.close();
  ok(m.ok && J(m.result.firmware) === J({ kind: "remote", version: "0.2.1", current: true }) && m.result.previous.sha256 === sha021,
     "look on a 0.2.1 unit: RemoteFM1 0.2.1, current", J(m));
  ({ dev, r } = await shipped({ remote: "0.1.1", finalRemote: "0.2.1" }));
  const res = await r.call("install", { target: { kind: "remote" } });
  const writes = r.events.filter((e) => e.stage === "write");
  ok(res.ok && J(res.result.installed.firmware) === J({ kind: "remote", version: "0.2.1", current: true }) && dev.bad === 0 && dev.upgrades === 2,
     "install over 0.1.1: 0.2.1's image served byte for byte, the unit answers 0.2.1, current", J([res, dev.bad]));
  ok(writes.length === 7 && writes.every((e) => e.total === BLOCKS021) && writes.map((e) => e.done).join() === "0,1,2,3,4,5,6",
     `install 0.2.1: progress write counts 0.2.1's blocks (total ${BLOCKS021})`, J(writes));
  const dl = r.events.filter((e) => e.stage === "download").pop();
  ok(dl && dl.done === raw021.length && dl.total === raw021.length, `install 0.2.1: download progress ends at its ${raw021.length} B`, J(dl));
  r.close();
}

// ---- cancel and busy, held at the sync points (no clock: each test stops the engine at a point, answers, releases)

// run an install to its sync point key (null: through, no stop) -> { hit, reply, cancel, sentAtAck, trace }
// whileHeld(r, dev): what the host does while the engine is held there (default: a cancel)
const IDLE = { step1: 1000, write: 1000 };            // (the stall tests: how long a silent FM-1 is waited for)
// fail: the held operation then rejects (with failureAt(key)) instead of going on
// scn.bound: protocol v1.1, the host's look first, its expect (session included) with scn.args
async function installHeld(scn, key, whileHeld = async (r) => ({ cancel: await r.send("cancel", {}) }), { fail = false } = {}) {
  const dev = scn.dev(), r = await configured({ dev, releases: null });
  let args = scn.args;
  if (scn.bound) { const l = await r.call("look", {}); args = { ...args, expect: { ...expectOf(l.result), ...scn.bound } }; }
  sync.trace = []; sync.target = key;
  const hit = key ? new Promise((res) => { sync.hit = res; }) : null;
  const inst = r.send("install", args);
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
// the sync points of a run before its last update request (upgrades: the loader's; the resume's first; a bound
// install's step 1) and where the commit to the write is: the number of points before the engine's "commit" marker
function pointsOf(trace, upgrades) {
  const upAt = trace.findIndex((k) => k === `rx upgrade#${upgrades}`);
  const upto = trace.slice(0, upAt + 1).filter((k) => !k.startsWith("rx data"));
  const commit = upto.indexOf("commit");
  return { head: upto.filter((k) => k !== "commit"), commit };
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
// protocol v1.1: the host's expect, from its look -> { port, mode, identity, firmware: { kind, name?, version? }, session }
const expectOf = (st) => ({ port: st.port, mode: st.mode, ...(st.identity ? { identity: st.identity } : {}),
  ...(st.firmware ? { firmware: { kind: st.firmware.kind, ...(st.firmware.name ? { name: st.firmware.name } : {}), ...(st.firmware.version ? { version: st.firmware.version } : {}) } } : {}),
  ...(st.session ? { session: st.session } : {}) });
const EXPECT_STOCK = { port: { input: "FM-1", output: "FM-1" }, mode: "normal", identity: "FM-1_015", firmware: { kind: "stock" } };
const EXPECT_LOADER = { port: { input: "Felucca Update", output: "Felucca Update" }, mode: "update", identity: "ota-FM-1_900" };
{
  const noSession = (x) => { const { session, ...rest } = x; return rest; };
  const s1 = (await lookAs({})).result, s2 = (await lookAs({ identity: "ota-FM-1_900", name: "Felucca Update" })).result;
  ok(J(noSession(expectOf(s1))) === J(EXPECT_STOCK) && J(noSession(expectOf(s2))) === J(EXPECT_LOADER) && typeof s1.session === "string" && s1.session.length >= 16 &&
     typeof s2.session === "string" && s1.session !== s2.session, "v1.1: look reports the identity and an opaque session token; the scenarios' expects are look's own", J([s1, s2]));
  const none = (await (async () => { const r = await configured({ dev: { access: { inputs: new Map(), outputs: new Map() } } }); const x = await r.call("look", {}); r.close(); return x; })()).result;
  ok(none.port === null && none.session === undefined, "v1.1: a look that finds no FM-1 opens no session", J(none));
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
  // protocol v1.1: the same cancel semantics with expect from the host's look (its session; its unit count at the
  // start, its re-read and the updater's re-validation on the session's endpoints: more points, the same rule). A
  // bound install stops after step 1 (unitChanged, continuity-lost: step 2 is a resume); the resume is confirmed
  { what: "v1.1 (expect): RemoteFM1 over the V15, step 1", args: { target: { kind: "remote" } }, bound: {}, upgrades: 1,
    finished: (t) => !t.reply.ok && t.reply.error.code === "unitChanged" && t.reply.error.detail === "continuity-lost" && t.dev.upgrades === 1 && t.dev.writes.length === 0,
    dev: () => new FakeFM1(pkg.image, { finalRemote: "9.9" }) },
  { what: "v1.1 (expect, mode update, confirmed): resume", args: { target: { kind: "remote" }, resume: true }, bound: { confirmedSameUnit: true }, upgrades: 1,
    dev: () => new FakeFM1(pkg.image, { identity: "ota-FM-1_900", name: "Felucca Update", finalRemote: "9.9" }) },
];
// how a scenario's install ends when nothing stops it: installed (finished: its own end, a bound install's step 1)
const finishedOf = (scn, t) => (scn.finished ? scn.finished(t) : t.reply.ok && t.dev.bad === 0);
for (const scn of SCENARIOS) {
  const ref = await installHeld(scn, null);
  const { head, commit } = pointsOf(ref.trace, scn.upgrades);
  ok(finishedOf(scn, ref) && commit > 0 && head.length > commit, `cancel, ${scn.what}: the run through (${commit} points before the write, ${head.length - commit} after)`,
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
      const good = t.hit && !t.cancel.ok && t.cancel.error.code === "busy" && finishedOf(scn, t);
      if (good) post++; else bad.push([head[k], t.cancel, t.reply]);
    }
  }
  ok(pre === commit, `cancel, ${scn.what}: at each of the ${commit} points before the write: cancelled, no write SysEx after the ack`, J(bad));
  ok(post === head.length - commit, `cancel, ${scn.what}: at each of the ${head.length - commit} after (to the last update request): busy, the install goes on to its end`, J(bad));
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
    if (c.hit && (c.reply.ok || finishedOf(scn, c) ? c.dev.bad === 0 : c.reply.error.code !== "cancelled" && c.dev.upgrades === 0)) own++;
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

// ---- protocol v1.1: install binds to the verified unit (expect): the endpoint session, continuity, unitChanged,
// ambiguousUnit. A bench of fake FM-1s, the host's look on the unit first (its expect and session, expectOf), then the
// install held at a sync point (the paused-run harness: no clock), where act(bench) swaps, adds or replugs a unit;
// release; then(r, bench): what the host does next on the same engine. -> { look, expect, reply, hit, trace, events, after }
const DL = "fetch remote-9.9.fwsc#1";                  // (the download of the bundled RemoteFM1)
async function bound({ units, plugged = [units[0]], args = { target: { kind: "remote" } }, at = null, act = () => {}, expect = true, confirm, tweak = (x) => x, then = null }) {
  const bn = bench(units, plugged), r = await configured({ dev: bn });
  const l = await r.call("look", {});
  const exp = expect ? tweak({ ...expectOf(l.result), ...(confirm !== undefined ? { confirmedSameUnit: confirm } : {}) }) : undefined;
  sync.trace = []; sync.target = at;
  const hit = at ? new Promise((res) => { sync.hit = res; }) : null;
  const inst = r.call("install", { ...args, ...(exp ? { expect: exp } : {}) });
  const h = at ? await Promise.race([hit, inst.then(() => null)]) : null;
  if (h) { act(bn); h.release(); }
  const reply = await inst;
  sync.target = null;
  const trace = sync.trace.slice(), events = r.events.slice();
  const after = then ? await then(r, bn, l) : null;
  r.close();
  return { look: l, expect: exp, reply, hit: !!h, trace, events, after };
}
// step 2 the host's way, after a bound install's step 1: a fresh look (after the re-enumeration), the user asked "Is
// this the FM-1 you were setting up?" (confirm: their yes), a resume with that look's session
const step2 = ({ target = { kind: "remote" }, confirm = true, before = () => {} } = {}) => async (r, bn, first) => {
  before(bn);
  const l = await r.call("look", {});
  const res = await r.call("install", { target, resume: true, expect: { ...expectOf(l.result), ...(confirm ? { confirmedSameUnit: true } : {}) } });
  return { look: l, res, first };
};
const swap = (a, b) => (bn) => { bn.pull(a); bn.plug(b); };
const untouched = (...us) => us.every((u) => u.upgrades === 0 && u.served === 0 && u.writes.length === 0 && !u.sent.some((k) => WRITE_KINDS.includes(k)));
const code = (t) => (t.reply.ok ? "ok" : t.reply.error.code);
const lost = (x) => !!x && !x.ok && x.error.code === "unitChanged" && x.error.detail === "continuity-lost";
// A: the unit the host verified (stock, "FM-1"); B: another unit holding user data (Felucca 1.0.1, its own port name);
// twin(): a unit identical to A (port names, OTA identity, firmware), optionally with A's very port ids
const unitA = (o = {}) => new FakeFM1(pkg.image, { finalRemote: "9.9", ...o });
const unitB = (o = {}) => new FakeFM1(pkg.image, { identity: "FM-1_910", name: "Felucca", version: "FELUCCA v1.0.1", finalRemote: "9.9", ...o });
const ourLoader = (o = {}) => new FakeFM1(pkg.image, { identity: "ota-FM-1_900", name: "Felucca Update", finalRemote: "9.9", ...o });
const officialLoader = (o = {}) => new FakeFM1(pkg.image, { identity: "ota-FM-1_015", name: "ota-FM-1", final: "FM-1_015", finalRemote: null, ...o });
{   // the happy path: expect from look, the same unit. Step 1, then the stop at the loader (continuity-lost: the restart
    // ends the link), then step 2 the host's way (a fresh look on the loader, confirmed, resumed): installed
  const a = unitA(), t = await bound({ units: [a], then: step2() });
  ok(t.look.result.identity === "FM-1_015" && lost(t.reply) && /update mode/.test(t.reply.error.message) && t.after.first.ok &&
     t.events.some((e) => e.stage === "enter-update" && e.done === 1) && !t.events.some((e) => e.stage === "write"),
     "v1.1: a bound install over the same unit: step 1, then unitChanged/continuity-lost at the loader, the app area untouched", J(t.reply));
  ok(t.after.look.result.mode === "update" && t.after.look.result.resumable && t.after.look.result.session !== t.look.result.session && t.after.res.ok &&
     t.after.res.result.installed.firmware.kind === "remote" && J(a.writes) === J(["FM-1_015"]) && a.upgrades === 2 && a.bad === 0,
     "v1.1: step 2: a fresh look on the loader (a new session), confirmedSameUnit, resume: installed (two update requests in all: step 1, the loader)", J(t.after));
}
{   // the review's first case: A swapped for B during the download
  const a = unitA(), b = unitB(), t = await bound({ units: [a, b], at: DL, act: swap(a, b) });
  ok(t.hit && lost(t.reply) && untouched(a, b) && !t.events.some((e) => e.stage === "enter-update"),
     "v1.1: A swapped for B (Felucca, user data) during the download: unitChanged (continuity-lost), no write SysEx to either", J([t.reply, b.sent]));
  // v1 (no expect), the same swap: B is flashed. The gap v1.1 closes; v1's behavior is unchanged
  const a1 = unitA(), b1 = unitB(), v1 = await bound({ units: [a1, b1], at: DL, act: swap(a1, b1), expect: false });
  ok(v1.hit && v1.reply.ok && b1.writes.length === 1 && b1.upgrades === 2, "v1 (expect absent), the same swap: B is written in one op, both steps (v1 unchanged; the gap v1.1 closes)", J([v1.reply, b1.writes]));
}
{   // HIGH 1: two IDENTICAL units (Felucca 1.0.1, the same port names, OTA identity and firmware: nothing but the
    // endpoints tells them apart) swapped at every sync point before the update request. Three ways a browser may show
    // the swap: new port objects with new ids; new port objects under the same ids; the very same objects replugged
    // (only the statechange tells). Each: unitChanged at every point, no write SysEx to either unit
  const twinA = (o = {}) => unitB(o);
  const ref = await bound({ units: [twinA()] });
  const head = ref.trace.slice(0, ref.trace.indexOf("rx upgrade#1")).filter((k) => k !== "commit");
  ok(lost(ref.reply) && head.length > 20 && ref.trace.includes("commit"), `v1.1 identical units: the reference run (${head.length} points before the update request)`, J(ref.reply));
  for (const [how, make, act] of [
    ["new port objects, new ids", () => { const a = twinA(), b = twinA(); return [a, b]; }, (a, b) => swap(a, b)],
    ["new port objects, the same ids", () => { const a = twinA({ portId: "twin" }), b = twinA({ portId: "twin" }); return [a, b]; }, (a, b) => swap(a, b)],
    ["the same port objects replugged", () => { const a = twinA(); return [a, a]; }, (a) => (bn) => bn.flap(a)],
  ]) {
    const seen = new Map(), badSwap = [];
    for (const key of head) {
      const [a, b] = make(), t = await bound({ units: a === b ? [a] : [a, b], at: key, act: act(a, b) });
      seen.set(code(t), (seen.get(code(t)) || 0) + 1);
      if (!t.hit || code(t) !== "unitChanged" || !untouched(a, b)) badSwap.push([key, t.reply, a.upgrades, b.upgrades]);
    }
    ok(badSwap.length === 0 && seen.get("unitChanged") === head.length,
       `v1.1 identical units, ${how}: swapped at each of the ${head.length} points: unitChanged, nothing written (${J([...seen])})`, J(badSwap.slice(0, 3)));
  }
  // and the same swap without expect (v1): the twin is written
  const a1 = twinA(), b1 = twinA(), v1 = await bound({ units: [a1, b1], at: DL, act: swap(a1, b1), expect: false });
  ok(v1.reply.ok && b1.writes.length === 1 && untouched(a1), "v1 (expect absent), identical units swapped during the download: the twin is written (v1 unchanged)", J(v1.reply));
}
{   // a second FM-1 at the start: ambiguousUnit before the download
  const a = unitA(), b = unitB(), bn = bench([a, b], [a]), r = await configured({ dev: bn });
  const l = await r.call("look", {});
  bn.plug(b);
  sync.trace = [];
  const res = await r.call("install", { target: { kind: "remote" }, expect: expectOf(l.result) });
  const trace = sync.trace.slice();
  // v1 (no expect): several FM-1s stay refused, as before
  const v1 = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "ambiguousUnit" && untouched(a, b) && !trace.includes(DL),
     "v1.1: a second FM-1 plugged in at the start: ambiguousUnit, before the download, nothing sent to either", J([res, trace]));
  ok(!v1.ok && v1.error.code === "refused" && /several/.test(v1.error.detail) && untouched(a, b), "v1 (expect absent): two FM-1s: refused, as before", J(v1));
}
{   // HIGH 2: the updater re-selects nothing. It writes through the session's endpoints, re-validating the full
    // expectation (mode, identity, firmware) on them, just before the update request
  const ref = await bound({ units: [unitA()] });
  const after = ref.trace.slice(ref.trace.indexOf("commit") + 1, ref.trace.indexOf("rx upgrade#1"));
  ok(after.length > 3 && after.every((k) => /^(open|rx (hs|hello|info))#/.test(k)), "v1.1: between the commit and the update request: the updater's handshake and re-read only", J(after));
  // a same-name, same-identity replacement running another firmware (RemoteFM1 0.1 answers FM-1_015 on "FM-1" too),
  // swapped in at each point the updater asks the unit: unitChanged, nothing written
  const badRe = [];
  for (const key of after) {
    const a = unitA(), b = unitA({ remote: "0.1" }), t = await bound({ units: [a, b], at: key, act: swap(a, b) });
    if (!t.hit || code(t) !== "unitChanged" || !untouched(a, b)) badRe.push([key, t.reply]);
  }
  ok(badRe.length === 0, `v1.1: a same-name, same-identity replacement with other firmware at each of the updater's ${after.length} points: unitChanged, nothing written`, J(badRe));
  // the firmware changes on the very endpoints (no unplug: continuity holds): the updater's own re-read refuses it
  const a = unitA(), t = await bound({ units: [a], at: after[0], act: () => { a.remote = "0.1"; } });
  ok(t.hit && code(t) === "unitChanged" && /firmware/.test(t.reply.error.detail) && untouched(a) && t.trace.includes("rx hello#2"),
     "v1.1: other firmware on the same endpoints at the updater's selection: its full re-validation (HELLO) refuses it: unitChanged", J(t.reply));
  // no rescan: a second FM-1 plugged in after the commit is never asked anything; A, bound, gets step 1
  const a2 = unitA(), b2 = unitB(), t2 = await bound({ units: [a2, b2], at: after[0], act: (bn) => bn.plug(b2) });
  ok(t2.hit && lost(t2.reply) && a2.upgrades === 1 && b2.sent.length === 0, "v1.1: a second FM-1 plugged in at the updater's selection: never asked (no rescan); A gets step 1", J([t2.reply, b2.sent]));
  // and in source: the bound select() scans nothing (no find / answering), and the update request follows alive() with no await
  const ota = readFileSync(new URL("./installer/fm1ota.js", import.meta.url), "utf8");
  const sel = ota.slice(ota.indexOf("  async select(filter) {"), ota.indexOf("  async waitFor("));
  const boundSel = sel.slice(sel.indexOf("if (!this.bind) return this.find(filter);") + "if (!this.bind) return this.find(filter);".length);
  const req = ota.slice(ota.indexOf("  request(link) {"), ota.indexOf("  // serve read requests"));
  ok(!/this\.(find|all|answering|candidates)\(/.test(boundSel) && /this\.bind\.verify\(input, output\)/.test(boundSel) && /new Link\(input, output\)/.test(boundSel) &&
     /this\.bind\.alive\(\);\s*this\.requested\+\+;\s*return link\.send\(UPGRADE\);/.test(req) && (ota.match(/send\(UPGRADE\)/g) || []).length === 1,
     "v1.1 (source): the bound updater asks only the session's endpoints and re-validates on them; alive() is right before the one update request (a counter only between)", boundSel);
}
{   // HIGH 3: step 2 of the detour (after step 1 the unit restarts into its loader; continuity cannot survive it).
    // A's loader replaced by B's: without confirmedSameUnit, unitChanged / continuity-lost; with a fresh session and
    // the flag the resume proceeds, if the loader fits the target
  const replaceLoader = (b) => (bn) => { for (const u of bn.units) if (u !== b && u.identity.startsWith("ota-")) bn.pull(u); bn.plug(b); };
  {
    const a = unitA(), b = officialLoader();
    const t = await bound({ units: [a, b], then: step2({ confirm: false, before: replaceLoader(b) }) });
    ok(lost(t.reply) && a.upgrades === 1 && lost(t.after.res) && t.after.look.result.identity === "ota-FM-1_015" && untouched(b) && a.writes.length === 0,
       "v1.1 detour step 2: A's loader replaced by B's official loader, no confirmedSameUnit: unitChanged/continuity-lost, nothing written", J(t.after.res));
    const a2 = unitA(), b2 = officialLoader();
    const t2 = await bound({ units: [a2, b2], then: step2({ before: replaceLoader(b2) }) });
    ok(lost(t2.reply) && !t2.after.res.ok && t2.after.res.error.code === "refused" && /V15 only/.test(t2.after.res.error.detail) && untouched(b2),
       "v1.1 detour step 2: B's official loader, confirmed: refused (it takes the V15 only, never RemoteFM1), nothing written", J(t2.after.res));
  }
  {
    const a = unitA(), b = ourLoader();
    const t = await bound({ units: [a, b], then: step2({ confirm: false, before: replaceLoader(b) }) });
    ok(lost(t.after.res) && untouched(b), "v1.1 detour step 2: an identical loader (ours) in place of A's, no confirmedSameUnit: continuity-lost, nothing written", J(t.after.res));
    const a2 = unitA(), b2 = ourLoader();
    const t2 = await bound({ units: [a2, b2], then: step2({ before: replaceLoader(b2) }) });
    ok(t2.after.res.ok && J(b2.writes) === J(["FM-1_015"]) && a2.writes.length === 0,
       "v1.1 detour step 2: a fresh session and confirmedSameUnit (the user's yes): proceeds on the loader the user confirmed", J(t2.after.res));
  }
  {   // the session of the look before step 1 is spent (stale), and a missing one is refused
    const a = unitA(), t = await bound({ units: [a], then: async (r, bn, first) => ({
      stale: await r.call("install", { target: { kind: "remote" }, resume: true, expect: { ...expectOf(first.result), mode: "update", identity: "ota-FM-1_900",
                                                                                   port: { input: "Felucca Update", output: "Felucca Update" }, confirmedSameUnit: true } }),
      missing: await r.call("install", { target: { kind: "remote" }, resume: true, expect: { ...EXPECT_LOADER, confirmedSameUnit: true } }) }) });
    ok(lost(t.reply) && !t.after.stale.ok && t.after.stale.error.code === "unitChanged" && t.after.stale.error.detail === "session-stale" &&
       !t.after.missing.ok && t.after.missing.error.code === "unitChanged" && t.after.missing.error.detail === "session-missing" && a.writes.length === 0 && a.upgrades === 1,
       "v1.1 detour step 2: the pre-step-1 session (spent): session-stale; no session: session-missing; nothing written", J(t.after));
  }
  {   // a loader that fits no FM-1 package: another firmware's (SMK) under its own name
    const l = new FakeFM1(pkg.image, { identity: "ota-SMK-37 Pro_900", name: "Felucca Update" });
    const t = await bound({ units: [l], args: { target: { kind: "remote" }, resume: true }, confirm: true });
    ok(code(t) === "refused" && untouched(l), "v1.1: resume on a loader that does not take the target (ota-SMK-37 Pro, an FM-1 package): refused", J(t.reply));
  }
}
{   // resume (a unit already in update mode: it re-enumerated before the look), with and without the flag
  const l = ourLoader(), t = await bound({ units: [l], args: { target: { kind: "remote" }, resume: true } });
  ok(lost(t.reply) && untouched(l), "v1.1: resume without confirmedSameUnit: unitChanged/continuity-lost, nothing written", J(t.reply));
  const l2 = ourLoader(), t2 = await bound({ units: [l2], args: { target: { kind: "remote" }, resume: true }, confirm: false });
  ok(lost(t2.reply) && untouched(l2), "v1.1: resume with confirmedSameUnit: false: continuity-lost", J(t2.reply));
  const l3 = ourLoader(), t3 = await bound({ units: [l3], args: { target: { kind: "remote" }, resume: true }, confirm: true });
  ok(t3.reply.ok && t3.expect.mode === "update" && J(l3.writes) === J(["FM-1_015"]) && l3.bad === 0, "v1.1: resume with confirmedSameUnit: installed", J(t3.reply));
  const s1 = officialLoader(), s = await bound({ units: [s1], args: { target: { kind: "v15" }, resume: true }, confirm: true });
  ok(s.reply.ok && s1.writes.length === 1, "v1.1: the official loader, confirmed: the V15's resume accepted (the official loader we accept)", J(s.reply));
  // a resume whose loader is swapped (for an identical one) during the download, confirmed: the continuity from that
  // look is still required
  const l4 = ourLoader(), l5 = ourLoader(), t4 = await bound({ units: [l4, l5], args: { target: { kind: "remote" }, resume: true }, confirm: true, at: DL, act: swap(l4, l5) });
  ok(t4.hit && lost(t4.reply) && untouched(l4, l5), "v1.1: resume, confirmed, its loader swapped for an identical one during the download: continuity-lost", J(t4.reply));
  // v1 (no expect): a resume needs no flag, as before
  const l6 = ourLoader(), t6 = await bound({ units: [l6], args: { target: { kind: "remote" }, resume: true }, expect: false });
  ok(t6.reply.ok && l6.writes.length === 1, "v1 (expect absent): resume as before, no flag", J(t6.reply));
}
{   // after a write every unit has re-enumerated: the next bound install (the detour's RemoteFM1 over the V15) needs
    // the user's confirmation too; v1 installs after a look are unchanged (both steps in one op)
  const a = unitA(), t = await bound({ units: [a], then: async (r) => {
    const s2 = await step2()(r);
    const l = await r.call("look", {});
    const bare = await r.call("install", { target: { kind: "remote" }, expect: expectOf(l.result) });
    const yes = await r.call("install", { target: { kind: "remote" }, expect: { ...expectOf(l.result), confirmedSameUnit: true } });
    return { s2, bare, yes };
  } });
  ok(t.after.s2.res.ok && lost(t.after.bare) && lost(t.after.yes) && a.upgrades === 3 && a.writes.length === 1,
     "v1.1: after a write, a normal-mode install needs confirmedSameUnit (without: continuity-lost, nothing sent; with: step 1)", J([t.after.bare, t.after.yes]));
  const v = unitA(), r = await configured({ dev: v });
  const l = await r.call("look", {}), res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(l.result.session && res.ok && v.upgrades === 2 && J(v.writes) === J(["FM-1_015"]), "v1 (expect absent) after a look: installed in one op, both steps (unchanged)", J(res));
}
{   // update mode: a loader swapped under another port name (ours or the official one) during the download breaks
    // continuity; the unit now in normal mode under the loader's port name too
  for (const [what, x, y] of [["our loader re-enumerated as \"FM-1 Update\"", ourLoader(), ourLoader({ name: "FM-1 Update" })],
                              ["the official loader under another port name", officialLoader(), officialLoader({ name: "FM-1 Update" })],
                              ["the unit now in normal mode (same port name)", ourLoader(), unitA({ name: "Felucca Update" })]]) {
    const args = { target: { kind: x.identity === "ota-FM-1_015" ? "v15" : "remote" }, resume: true };
    const t = await bound({ units: [x, y], args, confirm: true, at: args.target.kind === "v15" ? "fetch FM-1.fwsc#1" : DL, act: swap(x, y) });
    ok(t.hit && code(t) === "unitChanged" && untouched(x, y), `v1.1: resume, ${what} during the download: unitChanged, nothing written`, J(t.reply));
  }
}
{   // firmware, identity, mode mismatches (the same port name "FM-1"), each swapped in during the download: unitChanged
  const cases = [
    ["firmware (stock -> RemoteFM1 0.1)", unitA(), unitA({ remote: "0.1" })],
    ["firmware version (RemoteFM1 0.1 -> 0.2)", unitA({ remote: "0.1" }), unitA({ remote: "0.2" })],
    ["identity (FM-1_015 -> FM-1_920 ChoralRoot)", unitA(), unitA({ identity: "FM-1_920", version: "ChoralRoot 0.25.1" })],
    ["mode (normal -> update)", unitA(), unitA({ identity: "ota-FM-1_900" })],
  ];
  for (const [what, a, b] of cases) {
    const t = await bound({ units: [a, b], at: DL, act: swap(a, b) });
    ok(t.hit && code(t) === "unitChanged" && untouched(a, b), `v1.1: ${what}: unitChanged, nothing written`, J(t.reply));
  }
  // and without a swap: an expect that does not match the unit (identity, firmware name, port output)
  for (const [what, tweak] of [["identity", (x) => ({ ...x, identity: "FM-1_014" })], ["firmware", (x) => ({ ...x, firmware: { kind: "custom", name: "SLOOP" } })],
                               ["port output", (x) => ({ ...x, port: { input: "FM-1", output: "FM-1 #2" } })]]) {
    const a = unitA(), t = await bound({ units: [a], tweak });
    ok(code(t) === "unitChanged" && untouched(a), `v1.1: an expect whose ${what} is not the unit's: unitChanged, nothing written`, J(t.reply));
  }
  // the identity as INFO reports it (a Felucca-family unit) also binds: step 1, then the stop at the loader
  const b = unitB(), t = await bound({ units: [b], tweak: (x) => ({ ...x, identity: "FELUCCA v1.0.1" }) });
  ok(lost(t.reply) && b.upgrades === 1, "v1.1: expect.identity as INFO reports it (FELUCCA v1.0.1): the same unit, step 1 sent", J(t.reply));
}
{   // the check sits immediately before the commit: in engine.js, the final continuity and same-unit check (bound) is
    // between the last cancel check and op.writing = true; with expect nothing is awaited from the re-read (prepare's
    // last await: context() was read before it, `ctx || await context()` never awaits then) to the commit
  const src = readFileSync(new URL("./engine.js", import.meta.url), "utf8");
  const reread = "const st = await probe(acc, null, !!expect);";
  const from = src.indexOf(reread), ret = src.indexOf("return { target, src, acc, pkg, st, d, prev };", from);
  const tail = src.slice(from + reread.length, ret);
  const call = src.indexOf("try { pre = await prepare(a, op, expect, s); }"), to = src.indexOf("op.writing = true;", call);
  const between = src.slice(src.indexOf("\n", call), to);
  const strip = (x) => x.replace(/\/\/[^\n]*/g, "");
  ok(from > 0 && ret > from && call > ret && to > call && !/\bawait\b/.test(strip(tail).replace("ctx || await context()", "")) && !/\bawait\b/.test(strip(between)) &&
     /check\(\);\s*if \(expect\) bound\(st, expect, s, pkg\);\s*$/.test(between) && /const ctx = expect \? await context\(\) : null;\s*check\(\);\s*\/\/[^\n]*\n\s*const st = await probe/.test(src),
     "v1.1: the final continuity / same-unit check is right before op.writing = true; no await from the re-read to the commit", between);
}
// interrupted: a write cut off after its update request (the app area may be partly programmed): never "nothing written"
const interrupted = (x) => !!x && !x.ok && x.error.code === "disconnected" && x.error.detail === "interrupted-write" &&
  !/nothing was written|untouched/i.test(x.error.message || "");
{   // a swap mid-transfer: after the bound update request (step 1's, or a confirmed resume's loader), A's very endpoint
    // objects are disconnected and reconnected to B, whose updater waits for data (the reviewer's case: a browser that
    // reuses the MIDIPort objects). At every transfer step, B asking for a data block or straight for the completion:
    // the continuity check right before each response stops it. disconnected / interrupted-write, and not one byte to B
  const STEP1 = [[0, 64], [0x40, 160], [0x1000, 512], [0xE0000000, 8]], LOADER = [...Array.from({ length: 6 }, (_, k) => [k * 512, 512]), [0xF0000000, 8]];
  const rewire = (a, b, finish) => (bn) => {
    bn.flap(a); a.mute = true;                              // (A's objects disconnected and reconnected: A answers no more)
    b.input = a.input; a.output.send = b.output.send;       // (and they carry B now)
    const q = b.identity.startsWith("ota-") ? LOADER : STEP1;
    b.queue = finish ? q.slice(-1) : q.slice(); b.next();   // (B asks: a data block, or the completion)
  };
  // the transfer steps of a run: the update request and each data block but the last (each is answered next)
  const stepsOf = (trace, up) => { const k = trace.indexOf(up), d = []; for (let i = k + 1; i < trace.length && trace[i].startsWith("rx data#"); i++) d.push(trace[i]); return [up, ...d.slice(0, -1)]; };
  for (const [what, mk, args, confirm, up] of [
    ["step 1 (normal mode)", () => [unitA(), unitA()], { target: { kind: "remote" } }, undefined, "rx upgrade#1"],
    ["a confirmed resume (the loader's write)", () => [ourLoader(), ourLoader()], { target: { kind: "remote" }, resume: true }, true, "rx upgrade#1"],
  ]) {
    const [r0] = mk(), ref = await bound({ units: [r0], args, confirm });
    const steps = stepsOf(ref.trace, up);
    ok(steps.length >= 4 && (confirm ? ref.reply.ok : lost(ref.reply)), `v1.1 mid-transfer swap, ${what}: the reference run (${steps.length} transfer steps)`, J([ref.reply, steps]));
    const badMid = [];
    let n = 0;
    for (const key of steps) for (const finish of [false, true]) {
      const [a, b] = mk(), t = await bound({ units: [a, b], plugged: [a], args, confirm, at: key, act: rewire(a, b, finish) });
      n++;
      if (!t.hit || !interrupted(t.reply) || b.sent.length || b.served || b.writes.length || a.writes.length) badMid.push([key, finish, t.reply, b.sent, b.writes]);
    }
    ok(badMid.length === 0, `v1.1 mid-transfer swap, ${what}: B at each of ${n} steps (data, completion): interrupted-write, nothing sent to B`, J(badMid.slice(0, 2)));
  }
  // and in source: serve() answers only through the guarded send (no bare link.send(response(...)))
  const ota = readFileSync(new URL("./installer/fm1ota.js", import.meta.url), "utf8");
  const serve = ota.slice(ota.indexOf("  async serve("), ota.indexOf("  interrupted(finishAddr"));
  ok(!/link\.send\(response/.test(serve) && (serve.match(/respond\(response/g) || []).length === 2 && /const respond = \(bytes\) => \{ guard\(\); return link\.send\(bytes\); \};/.test(serve),
     "v1.1 (source): every transfer response in serve() goes through the synchronous continuity guard", serve.slice(0, 400));
}
{   // a failed resume after its data began: an interrupted write (resumable), never unitChanged / "nothing was written"
  const l = ourLoader({ unplugAt: 3 }), t = await bound({ units: [l], args: { target: { kind: "remote" }, resume: true }, confirm: true });
  ok(interrupted(t.reply) && l.loaderReads === 3 && /partially programmed/.test(t.reply.error.message) && t.events.some((e) => e.stage === "write" && e.done > 0),
     "v1.1: a confirmed resume unplugged mid-write: disconnected/interrupted-write (partly programmed), not unitChanged", J(t.reply));
  // v1 (no expect): the same unplug stays disconnected with its sentence
  const l1 = ourLoader({ unplugAt: 3 }), t1 = await bound({ units: [l1], args: { target: { kind: "remote" }, resume: true }, expect: false });
  ok(code(t1) === "disconnected" && t1.reply.error.detail !== "interrupted-write", "v1 (expect absent): a resume unplugged mid-write: disconnected, as before", J(t1.reply));
}
{   // a continuity break before a write is remembered across the session replacement: a fresh normal-mode look does not
    // forget it. The confirmation is required until an install with it commits
  const flapThen = async (rejectOld) => {
    const a = unitA(), bn = bench([a]), r = await configured({ dev: bn });
    const l0 = await r.call("look", {});
    bn.flap(a);                                                         // (disconnected and reconnected)
    const old = rejectOld ? await r.call("install", { target: { kind: "remote" }, expect: expectOf(l0.result) }) : null;
    await r.call("look", {});                                           // (looks again, and again: still remembered)
    const l1 = await r.call("look", {});
    const bare = await r.call("install", { target: { kind: "remote" }, expect: expectOf(l1.result) });
    const upBare = a.upgrades + a.sent.filter((k) => k === "upgrade").length;
    const l2 = await r.call("look", {});
    const yes = await r.call("install", { target: { kind: "remote" }, expect: { ...expectOf(l2.result), confirmedSameUnit: true } });
    r.close();
    return { a, old, l1, bare, upBare, yes };
  };
  const t = await flapThen(true);
  ok(lost(t.old) && t.l1.result.mode === "normal" && lost(t.bare) && /continuity/.test(t.bare.error.message) && t.upBare === 0,
     "v1.1: continuity lost, the old session rejected, a fresh normal-mode look: a retry without confirmedSameUnit is continuity-lost, no step 1", J([t.old, t.bare]));
  ok(lost(t.yes) && t.a.upgrades === 1 && t.a.writes.length === 0, "v1.1: ... and with confirmedSameUnit (the user's yes) on a fresh look: step 1 proceeds", J(t.yes));
  const t2 = await flapThen(false);
  ok(lost(t2.bare) && t2.upBare === 0 && t2.a.upgrades === 1, "v1.1: the session's ports disconnected and reconnected (no install in between), a fresh look: confirmation still required", J(t2.bare));
  // control: no loss, two looks: no confirmation needed (step 1 runs)
  const c = unitA(), bn = bench([c]), r = await configured({ dev: bn });
  await r.call("look", {});
  const l = await r.call("look", {}), res = await r.call("install", { target: { kind: "remote" }, expect: expectOf(l.result) });
  r.close();
  ok(lost(res) && /update mode/.test(res.error.message) && c.upgrades === 1, "v1.1: without a continuity loss, a fresh look needs no confirmation (step 1 runs)", J(res));
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
                    ["look", { portHint: 5 }], ["look", { portHint: "" }], ["config", { v15Url: 5 }], ["config", { firmwareBase: {} }],
                    // v1.1's expect: an object with port { input, output }, mode normal | update, identity and firmware typed
                    ["install", { target: { kind: "remote" }, expect: 5 }], ["install", { target: { kind: "remote" }, expect: { port: "FM-1", mode: "normal" } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "uboot" } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", identity: 15 } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", firmware: { name: "x" } } }],
                    // a non-string session and a non-boolean confirmedSameUnit (a missing session is unitChanged, not these)
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", session: 5 } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", session: { token: "x" } } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", session: "s", confirmedSameUnit: "yes" } }],
                    ["install", { target: { kind: "remote" }, expect: { port: { input: "FM-1", output: "FM-1" }, mode: "normal", session: "s", confirmedSameUnit: 1 } }]];
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
