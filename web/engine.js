// SPDX-License-Identifier: GPL-3.0-only
// The headless RemoteFM1 installer engine, protocol v1.1 (docs/ENGINE.md). engine.html loads it in a hidden same-origin
// iframe (allow="midi") of a host page (TuttiDAW's FM-1 setup wizard); the host talks to it only through a MessagePort.
// It owns the Web MIDI SysEx access during an install and decides nothing of its own: what the FM-1 runs, what may be
// installed over it and how, is installer/installer.js (decide, stateOf, restorePathOf, resumableWith), the protocol
// installer/fm1ota.js (Felucca's, as TransitFM1 carries it), the packages installer/fm1pkg.js, all GPL-3.0-only.
//
// Handshake: on load it posts { type: "rfm1-engine-ready", protocol: 1, minor: 1 } to window.parent; the parent (and only the
// parent, same origin) answers { type: "rfm1-engine-connect" } with a transferred MessagePort. Then, over the port:
//   host -> engine  { id, op: "config" | "look" | "install" | "cancel", ...args }
//   engine -> host  { id, ok: true, result } | { id, ok: false, error: { code, detail, httpStatus? } }   (one per op)
//                   { event: "progress", stage, done, total } | { event: "port", state: "found" | "lost" }
import { look as lookFm1, decide, stateOf, resumableWith, packageFrom } from "./installer/installer.js";
import { Updater, PORT_RE, boundMismatch } from "./installer/fm1ota.js";
import { sha256hex, STOCK_V15_SHA256 } from "./installer/fm1pkg.js";

export const PROTOCOL = 1;
// v1.1 (additive): install's expect binds the install to the unit the host verified (unitChanged, ambiguousUnit)
export const PROTOCOL_MINOR = 1;
// the ports probed: the installer's, and firmwares' own port names it does not list (web/managers/managers.json)
export const ENGINE_PORT_RE = new RegExp(`${PORT_RE.source}|jiant|loom|duell|pigeon|tonitor|coralflower|fimba|fomni|speak37|bubba`, "i");
// names that are an FM-1 (not a generic "USB-MIDI" interface): a port of these names that is held or silent is busy
const FM1_NAME = /fm-1|felucca|sloop|jiant|choral|melodee|bubba|remotefm1/i;
const BLOCK = 512;                                   // the loader's read size (fm1ota.js MAXDATA): write's total

export class EngineError extends Error {
  constructor(code, detail, extra = {}) { super(`${code}: ${detail}`); this.code = code; this.detail = detail; Object.assign(this, extra); }
  toJSON() { return { code: this.code, detail: this.detail, ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}) }; }
}
const CODES = new Set(["firmwareUnavailable", "portBusy", "sysexDenied", "disconnected", "refused", "cancelled", "verifyFailed", "timeout", "busy", "internal",
                       "unitChanged", "ambiguousUnit"]);

// an error of any origin -> EngineError. stage: where the install was ("prepare" | "enter-update" | "write" | "reboot")
export function toEngineError(e, stage = "prepare") {
  if (e instanceof EngineError) return e;
  const msg = (e && e.message) || String(e);
  const code = e && e.code;
  if (CODES.has(code)) return new EngineError(code, msg, e.httpStatus !== undefined ? { httpStatus: e.httpStatus } : {});
  switch (code) {                                    // fm1ota.js Updater's codes
    case "notfound": case "lost": return new EngineError("disconnected", msg);
    case "model": case "other": case "foreign": return new EngineError("refused", msg);
    // step 1 stalled: another app's MIDI flooding the port (TransitFM1 0.1.1); nothing was written
    case "stopped": return stage === "write" ? new EngineError("timeout", msg) : new EngineError("portBusy", msg);
    case "noloader": case "noreturn": return new EngineError("timeout", msg);
    case "mismatch": return new EngineError("verifyFailed", msg);
    // the binding (v1.1 expect): another unit than the one verified, or more than one: nothing was written
    case "changed": return new EngineError("unitChanged", msg);
    case "ambiguous": return new EngineError("ambiguousUnit", msg);
    default: return new EngineError("internal", msg);
  }
}

// opts: { requestMIDIAccess(opts) -> Promise<MIDIAccess> | null, fetch, releases?: [{ version, sha256 }] (default
// installer/releases.json beside this module), log?, v15Sha256? (the tests only: the official V15's SHA-256, default
// fm1pkg.js STOCK_V15_SHA256; M-VAVE's file is not in this tree), idleMs? (the tests only: fm1ota.js Updater's
// { step1, write } idle limits) }
export function createEngine({ requestMIDIAccess, fetch: fetchFn, releases = null, log: logFn = () => {}, v15Sha256 = STOCK_V15_SHA256, idleMs } = {}) {
  const log = (s) => { try { logFn(s); } catch (_) { /* (a host's logger never takes a reply away) */ } };
  const cfg = { v15Url: null, firmwareBase: null };
  let access = null, port = null, current = null, previous = null, rels = releases;
  const seen = new Set();                            // the FM-1 inputs connected (port events on a change only)

  const emit = (msg) => { if (port) port.postMessage(msg); };
  const progress = (stage, done, total) => emit({ event: "progress", stage, done, total });

  function watch(a) {
    for (const p of a.inputs.values()) if (p.state !== "disconnected" && ENGINE_PORT_RE.test(p.name || "")) seen.add(p.id);
    const on = (ev) => {
      const p = ev && ev.port;
      if (!p || p.type === "output" || !ENGINE_PORT_RE.test(p.name || "")) return;
      if (p.state === "disconnected") { if (seen.delete(p.id)) emit({ event: "port", state: "lost" }); }
      else if (!seen.has(p.id)) { seen.add(p.id); emit({ event: "port", state: "found" }); }
    };
    if (typeof a.addEventListener === "function") a.addEventListener("statechange", on); else a.onstatechange = on;
  }
  async function midi() {
    if (access) return access;
    if (!requestMIDIAccess) throw new EngineError("sysexDenied", "this browser has no Web MIDI (requestMIDIAccess)");
    try { access = await requestMIDIAccess({ sysex: true }); } catch (e) {
      if (e && (e.name === "SecurityError" || e.name === "NotAllowedError")) throw new EngineError("sysexDenied", (e && e.message) || e.name);
      throw new EngineError("internal", `requestMIDIAccess failed: ${(e && e.message) || e}`);
    }
    watch(access);
    return access;
  }
  async function releaseList() {
    if (rels) return rels;
    let r;
    try { r = await fetchFn(new URL("./installer/releases.json", import.meta.url).href, { cache: "no-cache" }); }
    catch (e) { throw new EngineError("firmwareUnavailable", `releases.json: ${(e && e.message) || e}`); }
    if (!r.ok) throw new EngineError("firmwareUnavailable", `releases.json: HTTP ${r.status}`, { httpStatus: r.status });
    rels = (await r.json()).releases;
    return rels;
  }

  // the FM-1-named ports another app holds (open() rejects) -> a port name, or null
  async function held(a) {
    for (const p of a.inputs.values()) {
      if (p.state === "disconnected" || !FM1_NAME.test(p.name || "")) continue;
      const out = [...a.outputs.values()].find((o) => o.name === p.name && o.state !== "disconnected");
      try { await p.open(); if (out) await out.open(); } catch (_) { return p.name; }
    }
    return null;
  }
  // an FM-1-named port is there but nothing answered the handshake: flooded or held -> a port name, or null
  const silent = (a) => { const p = [...a.inputs.values()].find((p) => p.state !== "disconnected" && FM1_NAME.test(p.name || "")); return p ? p.name : null; };
  const busyError = (name, why) => new EngineError("portBusy", `the port "${name}" ${why}`);

  // the MIDI ports of one name only (look's portHint), live
  const only = (a, name) => {
    const f = (m) => new Map([...m].filter(([, p]) => p.name === name));
    return { get inputs() { return f(a.inputs); }, get outputs() { return f(a.outputs); } };
  };

  // look() of installer.js, with the busy port told from no FM-1 -> its raw result. bound (an install with expect):
  // several FM-1s are ambiguousUnit, not refused
  async function probe(a, hint, bound = false) {
    const h = await held(hint ? only(a, hint) : a);
    if (h) throw busyError(h, "is held by another app (it cannot be opened)");
    const st = await lookFm1(hint ? only(a, hint) : a, log, { portRe: ENGINE_PORT_RE });
    if (st.none) { const s = silent(hint ? only(a, hint) : a); if (s) throw busyError(s, "does not answer (another app floods or holds it)"); }
    if (st.several && bound) throw new EngineError("ambiguousUnit", `several FM-1s answer (${st.list.join(", ")}): unplug the other FM-1s`);
    if (st.several) throw new EngineError("refused", `several FM-1s answer (${st.list.join(", ")}): connect one, or pass portHint`);
    return st;
  }

  // v1.1: the units an install with expect may write: exactly one answers (the FM-1-family ports that answer the
  // update protocol's handshake), else disconnected (none) or ambiguousUnit (several). A held FM-1 port is portBusy,
  // as in probe
  async function oneUnit(a) {
    const h = await held(a);
    if (h) throw busyError(h, "is held by another app (it cannot be opened)");
    const got = await new Updater(a, log, ENGINE_PORT_RE).answering();
    got.forEach((d) => d.link.close());
    if (got.length > 1) throw new EngineError("ambiguousUnit", `several FM-1s answer (${got.map((d) => `${d.id.text} (${d.name})`).join(", ")}): unplug the other FM-1s`);
    if (!got.length) {
      const s = silent(a);
      if (s) throw busyError(s, "does not answer (another app floods or holds it)");
      throw new EngineError("disconnected", "no FM-1 found");
    }
  }

  // v1.1: is the unit probe() just read the one the host verified (expect)? Its mode, its port (normal mode; in update
  // mode a loader under another port name must be our own: fm1ota.js boundMismatch), its identity (the handshake's, or
  // the INFO text) and its firmware (kind, name, version) -> nothing, or throws unitChanged (refused for another
  // firmware's loader under another port). Synchronous: install calls it with no await before its commit
  function sameUnit(st, expect) {
    const now = stateOf(st, {});
    const changed = (what) => new EngineError("unitChanged", `the FM-1 is not the one verified (${what}): nothing was written`);
    if (now.mode !== expect.mode) throw changed(`mode ${now.mode}, not ${expect.mode}`);
    const why = boundMismatch({ mode: expect.mode, port: expect.port.input }, { id: { text: st.identity, model: st.identity.split("_")[0] }, name: st.ports.input });
    if (why === "foreign") throw new EngineError("refused", `the FM-1 is in the update mode of another firmware under another port (${st.identity}, ${st.ports.input}): nothing was written`);
    if (why) throw changed(`port ${st.ports.input}, not ${expect.port.input}`);
    if (expect.mode === "normal" && now.port.output !== expect.port.output) throw changed(`port ${now.port.output}, not ${expect.port.output}`);
    if (expect.identity !== undefined && expect.identity !== st.identity && !(expect.mode === "normal" && expect.identity === st.version))
      throw changed(`identity ${st.identity}${st.version ? ` (${st.version})` : ""}, not ${expect.identity}`);
    const want = expect.firmware;
    if (want && expect.mode === "normal") {
      const fw = now.firmware || {};
      if (fw.kind !== want.kind || (want.name !== undefined && fw.name !== want.name) || (want.version !== undefined && fw.version !== want.version))
        throw changed(`firmware ${JSON.stringify(fw)}, not ${JSON.stringify(want)}`);
    }
  }
  async function context() {
    let list = [];
    try { list = await releaseList(); } catch (_) { /* (look still answers; current stays false) */ }
    return { newest: list[0] && list[0].version, releases: list, previous };
  }

  async function opConfig(a) {
    if (typeof a.v15Url === "string") cfg.v15Url = a.v15Url;
    if (typeof a.firmwareBase === "string") cfg.firmwareBase = a.firmwareBase.endsWith("/") ? a.firmwareBase : a.firmwareBase + "/";
    return { protocol: PROTOCOL, minor: PROTOCOL_MINOR, v15Url: cfg.v15Url, firmwareBase: cfg.firmwareBase };
  }

  async function opLook(a) {
    const st = await probe(await midi(), a.portHint || null);
    const state = stateOf(st, await context());
    if (state.mode === "normal" && state.firmware) previous = state.previous;
    return state;
  }

  // GET url with download progress -> Uint8Array; firmwareUnavailable on a network error or a non-200
  async function download(url, signal) {
    progress("download", 0, 0);
    let r;
    try { r = await fetchFn(url, { cache: "no-cache", signal }); } catch (e) {
      if (e && e.name === "AbortError") throw cancelled();
      throw new EngineError("firmwareUnavailable", `${url}: ${(e && e.message) || e}`);
    }
    if (!r.ok || (r.status !== undefined && r.status !== 200))
      throw new EngineError("firmwareUnavailable", `${url}: HTTP ${r.status}`, { httpStatus: r.status });
    const total = Number((r.headers && r.headers.get && r.headers.get("content-length")) || 0);
    try {
      if (r.body && typeof r.body.getReader === "function") {
        const rd = r.body.getReader(), parts = [];
        let n = 0, shown = 0;
        for (;;) {
          const { done, value } = await rd.read();
          if (done) break;
          parts.push(value); n += value.length;
          if (n - shown >= 65536) { shown = n; progress("download", n, total); }
        }
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        progress("download", n, total || n);
        return out;
      }
      const out = new Uint8Array(await r.arrayBuffer());
      progress("download", out.length, total || out.length);
      return out;
    } catch (e) {
      if (e && e.name === "AbortError") throw cancelled();
      throw new EngineError("firmwareUnavailable", `${url}: ${(e && e.message) || e}`);
    }
  }
  const cancelled = () => new EngineError("cancelled", "cancelled: the host cancelled the install before the write");

  // target -> { url, sha256, label, rel? } (what to fetch and the SHA-256 it must have)
  async function source(t) {
    if (!t || typeof t !== "object") throw new EngineError("refused", "install: no target");
    if (t.kind === "remote") {
      if (!cfg.firmwareBase) throw new EngineError("internal", "config: no firmwareBase");
      const rel = (await releaseList())[0];
      if (!rel) throw new EngineError("internal", "releases.json lists no release");
      return { url: `${cfg.firmwareBase}remote-${rel.version}.fwsc`, sha256: rel.sha256, label: `RemoteFM1 ${rel.version}`, rel };
    }
    if (t.kind === "v15") {
      if (!cfg.v15Url) throw new EngineError("internal", "config: no v15Url");
      return { url: cfg.v15Url, sha256: v15Sha256, label: "the official V15 (M-VAVE's FM-1.fwsc)" };
    }
    if (t.kind === "package") {
      if (typeof t.url !== "string" || !/^[0-9a-f]{64}$/i.test(t.sha256 || "")) throw new EngineError("refused", "package target: url and sha256 (64 hex digits) are required");
      return { url: t.url, sha256: t.sha256.toLowerCase(), label: t.label || "the package" };
    }
    throw new EngineError("refused", `unknown target kind ${JSON.stringify(t.kind)}`);
  }

  // install. A cancel may come at every await before the write (a MessagePort message runs between them): each is
  // followed by check(), and the last check and the commit to the write (op.writing) have no await between them, so a
  // cancel the host saw acknowledged never lets a write SysEx out, and one that comes after the commit gets busy
  async function opInstall(a, op) {
    const target = a.target;
    const check = () => { if (op.cancelled) throw cancelled(); };
    const expect = a.expect || null;                   // v1.1 (absent: v1, unchanged)
    const src = await source(target);
    check();
    const acc = await midi();
    check();
    // v1.1: with expect, exactly one unit from the start (a second FM-1 plugged in: ambiguousUnit before the download)
    if (expect) { await oneUnit(acc); check(); }
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    op.abort = () => { if (ac) ac.abort(); };

    const bytes = await download(src.url, ac ? ac.signal : undefined);
    check();
    progress("verify", 0, 1);
    if (await sha256hex(bytes) !== src.sha256) throw new EngineError("verifyFailed", `${src.url}: the SHA-256 is not ${src.sha256}`);
    const pkg = await packageFrom(bytes, src.label);   // (the identity, the app-area limit: releasedPackage's checks)
    // (M-VAVE's V15, by its SHA-256, as packageFrom tells it; never the bundled RemoteFM1, whatever its hash)
    pkg.official = target.kind !== "remote" && (pkg.official || src.sha256 === v15Sha256);
    if (target.kind === "v15" && !pkg.official) throw new EngineError("verifyFailed", "not M-VAVE's official V15 package");
    progress("verify", 1, 1);
    check();

    // v1.1: with expect, the release list is read before the unit (cached: no await after the re-read below), so the
    // re-read of the unit is the install's last await before its commit
    const ctx = expect ? await context() : null;
    check();
    // the re-read of the unit to write (look's probes), after the download
    const st = await probe(acc, null, !!expect);
    check();
    if (st.none) throw new EngineError("disconnected", "no FM-1 found");
    // v1.1: the same unit as the host verified, before the refusal rules (a swapped-in unit is unitChanged, whatever
    // the rules would say of it); checked again at the commit below
    if (expect) sameUnit(st, expect);
    const d = decide(st, pkg, { midiClosed: true, detour: true });
    if (a.resume && d.action !== "resume") throw new EngineError("refused", "resume: the FM-1 is not in update mode");
    if (d.action === "refuse") throw new EngineError("refused", `${d.reason}: ${st.fw ? st.fw.name : st.identity || ""}`.trim());
    if (d.action === "resume") {
      const rw = resumableWith(st);
      if (!rw) throw new EngineError("refused", `the FM-1 is in the update mode of another firmware (${st.identity}): finish it with its own updater`);
      if (rw === "v15" && !pkg.official) throw new EngineError("refused", `the official update mode (${st.identity}) takes M-VAVE's V15 only`);
    }
    check();
    const prev = d.action === "install" ? stateOf(st, ctx || await context()).previous : undefined;

    // the write: the last check and the commit, no await between them. From here no cancel (busy). (Each install of
    // the V15 detour, the V15 and then RemoteFM1, is an install op of its own, with its own checks and commit.)
    // v1.1: the final same-unit check sits here too, synchronous, between the cancel check and the commit
    check();
    if (expect) sameUnit(st, expect);
    op.writing = true;
    if (d.action === "install") previous = prev;
    const total = Math.ceil(pkg.image.length / BLOCK);
    let stage = d.action === "resume" ? "write" : "enter-update";
    const step = (k, n) => {
      if (k === "start") progress("enter-update", 0, 2);
      else if (k === "loader") progress("enter-update", 1, 2);
      // (the loader found, before its update request: a loader that stalls before its first read is a timeout)
      else if (k === "writing") { stage = "write"; progress("write", 0, total); }
      else if (k === "write") { stage = "write"; progress("write", Math.min(n, total), total); }
      else if (k === "reboot") { stage = "reboot"; progress("reboot", 0, 1); }
      else if (k === "done") progress("reboot", 1, 1);
    };
    // v1.1: the updater bound to that unit: at its own selection (the update's handshake, just before the update
    // request) it must still be the only unit, on its port with its identity (fm1ota.js Updater opts.bind)
    const bind = expect ? { mode: expect.mode, port: st.ports.input, identity: st.identity } : null;
    const up = new Updater(acc, log, ENGINE_PORT_RE, { ...(idleMs ? { idleMs } : {}), ...(bind ? { bind } : {}) });
    try {
      if (d.action === "resume") {
        const ok = await up.resume(pkg.image, step, pkg.official ? { product: pkg.product } : { package: pkg.product });
        if (!ok) {
          const gone = !(await lookFm1(acc, log, { portRe: ENGINE_PORT_RE })).loader;
          throw new EngineError(gone ? "disconnected" : "timeout", `the write of ${pkg.label} did not finish`);
        }
      } else {
        await up.install(pkg.image, pkg.product, step);
      }
    } catch (e) { throw toEngineError(e, stage); }

    // confirm: what the FM-1 runs now is what was installed (a firmware just started may be slow to answer HELLO:
    // asked again, three times)
    progress("confirm", 0, 1);
    const want = (st) => {
      const fw = st.firmware;
      return target.kind === "remote" ? !!fw && fw.kind === "remote" && fw.version === src.rel.version
           : target.kind === "v15" ? !!fw && fw.kind === "stock" : st.mode === "normal" && !!st.port;
    };
    let after;
    for (let k = 0; k < 3; k++) {
      if (k) await new Promise((r) => setTimeout(r, 1000));
      try { after = stateOf(await probe(acc, null), await context()); } catch (e) { if (k === 2) throw toEngineError(e, "confirm"); continue; }
      if (want(after)) break;
    }
    if (!after || !want(after)) throw new EngineError("verifyFailed", `installed ${pkg.label}, but the FM-1 now reports ${JSON.stringify(after && after.firmware)}`);
    progress("confirm", 1, 1);
    return { installed: after };
  }

  // the ops: an own-keys Map (never an inherited name such as toString), each with its arguments' check
  const OPS = new Map([["config", opConfig], ["look", opLook], ["install", opInstall]]);
  const bad = (detail) => new EngineError("refused", `bad request: ${detail}`);
  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const ARGS = {
    config(a) {
      for (const k of ["v15Url", "firmwareBase"]) if (a[k] !== undefined && typeof a[k] !== "string") throw bad(`config: ${k} must be a string`);
    },
    look(a) {
      if (a.portHint !== undefined && a.portHint !== null && (typeof a.portHint !== "string" || !a.portHint)) throw bad("look: portHint must be a port name");
    },
    install(a) {
      if (!isObj(a.target)) throw bad("install: target must be an object");
      if (typeof a.target.kind !== "string") throw bad("install: target.kind must be a string");
      if (a.resume !== undefined && typeof a.resume !== "boolean") throw bad("install: resume must be a boolean");
      if (a.expect === undefined || a.expect === null) return;                     // (v1: no binding)
      const x = a.expect, str = (v) => typeof v === "string" && v.length > 0;
      if (!isObj(x)) throw bad("install: expect must be an object");
      if (!isObj(x.port) || !str(x.port.input) || !str(x.port.output)) throw bad("install: expect.port must be { input, output } port names");
      if (x.mode !== "normal" && x.mode !== "update") throw bad("install: expect.mode must be 'normal' or 'update'");
      if (x.identity !== undefined && !str(x.identity)) throw bad("install: expect.identity must be a string");
      if (x.firmware !== undefined && (!isObj(x.firmware) || !str(x.firmware.kind) ||
          (x.firmware.name !== undefined && typeof x.firmware.name !== "string") || (x.firmware.version !== undefined && typeof x.firmware.version !== "string")))
        throw bad("install: expect.firmware must be { kind, name?, version? }");
    },
  };

  function cancelOp() {
    if (!current) return { cancelled: false };
    if (current.writing || current.op !== "install")
      throw new EngineError("busy", current.writing ? "the write has started: it cannot be cancelled" : `${current.op} cannot be cancelled`);
    current.cancelled = true;
    if (current.abort) current.abort();
    return { cancelled: true };
  }

  // one request (a message with an id or an op) -> exactly one reply; every check inside the one error boundary
  async function handle(msg) {
    let id;
    try {
      if (!isObj(msg) || !("id" in msg || "op" in msg)) return;      // not a request: nothing to answer
      id = msg.id;
    } catch (_) { return; }
    const reply = (r) => {
      if (!port) return;
      try { port.postMessage({ id, ...r }); } catch (e) { log(`reply ${String(id)}: ${(e && e.message) || e}`); }
    };
    let me = null;
    try {
      const op = msg.op;
      if (typeof op !== "string") throw new EngineError("internal", `op must be a string (got ${op === null ? "null" : typeof op})`);
      if (op === "cancel") return reply({ ok: true, result: cancelOp() });
      if (!OPS.has(op)) throw new EngineError("internal", `unknown op ${JSON.stringify(op)}`);
      ARGS[op](msg);
      if (current) throw new EngineError("busy", `${current.op} is running`);
      me = current = { op, cancelled: false, writing: false, abort: null };
      const result = await OPS.get(op)(msg, me);
      reply({ ok: true, result });
    } catch (e) {
      log(String((e && e.stack) || e));
      // a cancel acknowledged before the write takes precedence: whatever the pending await then rejected with (a
      // download error, a denied permission, a port that would not open, a silent FM-1), the host was promised
      // "cancelled". (cancelOp sets cancelled only while not writing; after the commit a cancel is busy.)
      const err = me && me.cancelled && !me.writing ? cancelled() : toEngineError(e);
      reply({ ok: false, error: err.toJSON() });
    } finally { if (me && current === me) current = null; }
  }

  return {
    // the host's port (a later connect replaces it)
    attach(p) {
      if (port && port !== p) try { port.close(); } catch (_) { /* */ }
      port = p;
      p.onmessage = (ev) => { handle(ev.data).catch(() => { /* (handle answers every request itself) */ }); };
      if (typeof p.start === "function") p.start();
    },
    handle,
  };
}

// the iframe: the handshake with window.parent (same origin only), then the port. win/nav: the window and navigator
// (the tests pass fakes)
export function boot(win, nav, opts = {}) {
  const engine = createEngine({
    requestMIDIAccess: nav && nav.requestMIDIAccess ? (o) => nav.requestMIDIAccess(o) : null,
    fetch: opts.fetch || ((...a) => win.fetch(...a)),
    releases: opts.releases || null,
    log: opts.log || (() => {}),
  });
  const origin = win.location.origin;
  win.addEventListener("message", (ev) => {
    if (ev.source !== win.parent || ev.origin !== origin) return;
    if (!ev.data || ev.data.type !== "rfm1-engine-connect" || !ev.ports || !ev.ports[0]) return;
    engine.attach(ev.ports[0]);
  });
  win.parent.postMessage({ type: "rfm1-engine-ready", protocol: PROTOCOL, minor: PROTOCOL_MINOR }, origin === "null" ? "*" : origin);
  return engine;
}

if (typeof window !== "undefined" && typeof document !== "undefined" && window.parent && window.parent !== window) boot(window, navigator);
