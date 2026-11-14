// SPDX-License-Identifier: GPL-3.0-only
// The headless engine (engine.js, protocol v1, docs/ENGINE.md) driven through a real MessagePort (Node's
// MessageChannel) against the simulated FM-1 of installer/fake_fm1.mjs and a fake fetch: the handshake, look for each
// firmware and mode, a direct install, the V15 detour (refused direct, V15, then RemoteFM1), resume from update mode,
// the errors (firmwareUnavailable on a 404 and a network error, portBusy, sysexDenied, disconnected mid-write, busy,
// refused, cancel) and the progress order. Plus installer.js's pure decisions. Never against a real unit.
//   node web/test_engine.mjs
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FakeFM1 } from "./installer/fake_fm1.mjs";
import { createEngine, boot, PROTOCOL } from "./engine.js";
import { decide, restorePathOf, stateOf, packageFrom, look } from "./installer/installer.js";

const realTimeout = setTimeout;                    // the protocol's waits (seconds) shortened 20 times
// (a floor of 300 ms: HELLO's 800 ms shortened to 40 raced Windows' timer granularity)
globalThis.setTimeout = (f, ms, ...a) => realTimeout(f, ms >= 200 ? Math.max(ms / 20, 300) : ms, ...a);

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

// a fake fetch: url -> bytes | status | "network" (throws, as fetch does offline) | { delay, bytes }
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push(url);
    let r = routes[url];
    if (r && r.delay) { await new Promise((res, rej) => { const t = realTimeout(res, r.delay); if (init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }); }); r = r.bytes; }
    if (r === "network") throw new TypeError("Failed to fetch");
    if (r === undefined) r = 404;
    if (typeof r === "number") return { ok: false, status: r, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: new Map([["content-length", String(r.length)]]), arrayBuffer: async () => r.slice().buffer };
  };
  f.calls = calls;
  return f;
}
const ROUTES = { [`${BASE}remote-9.9.fwsc`]: raw, [V15]: raw };

// an engine on a port; call(op, args) -> the final reply; events: every event since the last call
function rig({ dev = null, routes = ROUTES, midi, releases = RELEASES } = {}) {
  const { port1, port2 } = new MessageChannel();
  const engine = createEngine({ requestMIDIAccess: midi || (async () => dev.access), fetch: fakeFetch(routes), releases, v15Sha256: V15_SHA });
  engine.attach(port2);
  const waiting = new Map(), events = [];
  let n = 0;
  port1.onmessage = (ev) => {
    const m = ev.data;
    if (m.event) events.push(m);
    else if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  };
  const send = (op, args = {}) => { const id = ++n; const p = new Promise((r) => waiting.set(id, r)); port1.postMessage({ id, op, ...args }); return p; };
  return { send, events, close: () => { port1.close(); port2.close(); },
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
  ok(writes.length === 6 && writes.every((e) => e.total === BLOCKS) && writes.map((e) => e.done).join() === "1,2,3,4,5,6",
     `progress: write counts blocks (done 1..6 of ${BLOCKS})`, J(writes));
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
  const dev = new FakeFM1(pkg.image, { stall: true }), r = await configured({ dev });
  const res = await r.call("install", { target: { kind: "remote" } });
  r.close();
  ok(!res.ok && res.error.code === "portBusy" && dev.writes.length === 0, "portBusy: step 1 stalls after UPGRADE (TransitFM1 0.1.1): nothing written", J(res));
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
{   // busy: a second install while one runs; a cancel once the write started
  const dev = new FakeFM1(pkg.image, { finalRemote: "9.9" }), r = await configured({ dev });
  r.events.length = 0;
  const first = r.send("install", { target: { kind: "remote" } });
  const second = await r.send("install", { target: { kind: "remote" } });
  const lookMid = await r.send("look", {});
  ok(!second.ok && second.error.code === "busy" && !lookMid.ok && lookMid.error.code === "busy", "busy: a second install (and a look) while one runs", J([second, lookMid]));
  while (!r.events.some((e) => e.stage === "write")) await new Promise((res) => realTimeout(res, 5));
  const c = await r.send("cancel", {});
  ok(!c.ok && c.error.code === "busy", "cancel once the write started: busy", J(c));
  const f = await first;
  ok(f.ok && dev.bad === 0, "  ...and the install finishes", J(f));
  r.close();
}
{   // cancel before the write: during the download
  const dev = new FakeFM1(pkg.image, {}), r = await configured({ dev, routes: { [`${BASE}remote-9.9.fwsc`]: { delay: 300, bytes: raw } } });
  const first = r.send("install", { target: { kind: "remote" } });
  await new Promise((res) => realTimeout(res, 20));
  const c = await r.send("cancel", {}), f = await first;
  const idle = await r.send("cancel", {});
  r.close();
  ok(c.ok && c.result.cancelled && !f.ok && f.error.code === "refused" && /cancel/.test(f.error.detail) && dev.upgrades === 0,
     "cancel before the write: the install ends, nothing sent", J([c, f]));
  ok(idle.ok && idle.result.cancelled === false, "cancel with nothing running: ok, cancelled false");
}
{
  const r = await configured({ dev: new FakeFM1(pkg.image, {}) });
  const u = await r.call("frobnicate", {}), t = await r.call("install", { target: { kind: "nope" } });
  r.close();
  ok(!u.ok && u.error.code === "internal" && !t.ok && t.error.code === "refused", "an unknown op: internal; an unknown target: refused");
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

console.log(fails ? `engine: ${fails} of ${checks} FAILED` : `engine tests passed (${checks})`);
process.exit(fails ? 1 : 0);
