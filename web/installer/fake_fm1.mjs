// SPDX-License-Identifier: GPL-3.0-only
// A simulated FM-1 on a fake Web MIDI (MIDIAccess-shaped: inputs, outputs, onstatechange), for test_installer.mjs and
// ../test_engine.mjs (TransitFM1's web/test_installer.mjs, GPL-3.0-only, ported). Never a real unit: the only MIDI here
// is the fake's. It keeps the real setTimeout (imported before a test shortens the waits), so it answers at once.
//
// It answers the handshake, INFO (version: the backup protocol's answer, or none), RemoteFM1's HELLO (remote: the
// version it answers), step 1 (four reads and "success"), then the loader (six reads and the finish), then the
// firmware written (final; finalRemote: the HELLO version the written firmware answers, null for none).
// The failures the engine maps: held (open() rejects, as when another app holds the port on Windows), mute (the port
// answers nothing: another app floods it), stall (UPGRADE taken but no request follows: step 1 stalled, TransitFM1
// 0.1.1), loaderStall (the loader takes its UPGRADE but asks for nothing), unplugAt (unplugged after that many loader
// reads, mid-write), noReturn (the written firmware never appears). portId: its ports' ids ("i" / "o" + portId; default
// random): two identical units given one portId get the same ids, as a browser may give a unit plugged into the same
// socket.
// The tests' sync points: gate(kind, detail) -> a promise the fake waits on before it takes a message (kind "hs",
// "hello", "info", "upgrade" or "data"; in order, one at a time) or opens a port (kind "open"). sent: every message
// sent to it, by kind, logged the moment it is sent (before a gate holds it).
import { pack7, unpack7 } from "./fm1ota.js";
import { IDENTITY, rfPack7 } from "./installer.js";

const realTimeout = setTimeout;
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const HS = [0xF0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7F, 0xF7];
const UPGRADE = [0xF0, 0x22, 0x24, 0x35, 0x7F, 0xF7];

// a message to the FM-1, by kind: the handshake, RemoteFM1's HELLO, INFO, the update request, or a data block
export function kindOf(d) {
  if (d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x52 && d[3] === 0x46) return "hello";
  if (d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x46 && d[3] === 0x4C) return "info";
  if (eq(d, HS)) return "hs";
  if (eq(d, UPGRADE)) return "upgrade";
  return "data";
}

export class FakeFM1 {
  constructor(image, { identity = "FM-1_015", name = "FM-1", version = null, loader = "ota-FM-1_900", final = IDENTITY, remote = null,
                       finalRemote, finalVersion = null, held = false, mute = false, stall = false, loaderStall = false, unplugAt = -1,
                       noReturn = false, gate = null, portId = null } = {}) {
    this.image = image; this.served = 0; this.bad = 0; this.upgrades = 0; this.version = version; this.remote = remote; this.hellos = 0;
    this.loader = loader; this.final = final; this.finalRemote = finalRemote === undefined ? remote : finalRemote;
    this.finalVersion = finalVersion;
    this.held = held; this.mute = mute; this.stall = stall; this.loaderStall = loaderStall; this.unplugAt = unplugAt; this.noReturn = noReturn;
    this.portId = portId;
    this.loaderReads = 0; this.writes = []; this.sent = []; this.gate = gate; this.chain = Promise.resolve();
    this.access = { inputs: new Map(), outputs: new Map(), onstatechange: null };
    this.boot(identity, name);
  }
  // swap the image the next install serves (a second install on the same unit: the V15 detour)
  setImage(image, { final, finalRemote = null, finalVersion = null } = {}) {
    this.image = image; if (final) this.final = final; this.finalRemote = finalRemote; this.finalVersion = finalVersion;
  }
  statechange(port) { const f = this.access.onstatechange; if (f) realTimeout(() => f({ port }), 0); }
  unplug() {
    for (const m of [this.access.inputs, this.access.outputs]) {
      for (const p of m.values()) { p.state = "disconnected"; if (m === this.access.inputs) this.statechange(p); }
      m.clear();
    }
    this.waiting = null; this.queue = [];
  }
  boot(identity, name) {
    this.unplug();
    this.identity = identity; this.waiting = null; this.queue = [];
    const id = this.portId || Math.random().toString(36).slice(2), held = this.held;
    const open = (what) => async () => {
      if (this.gate) await this.gate("open", `${what} ${name}`);
      if (held) throw Object.assign(new Error("port in use"), { name: "InvalidAccessError" });
    };
    this.input = { id: "i" + id, name, type: "input", state: "connected", onmidimessage: null, open: open("input") };
    this.output = { id: "o" + id, name, type: "output", state: "connected", open: open("output"),
                    send: (d) => {
      if (this.output.state !== "connected") throw new Error("InvalidStateError");
      const m = Array.from(d);
      this.sent.push(kindOf(m));
      if (!this.gate) { realTimeout(() => this.rx(m), 1); return; }
      realTimeout(() => { this.chain = this.chain.then(() => this.gate(kindOf(m), this.identity)).then(() => this.rx(m)); }, 1);
    } };
    this.access.inputs.set(this.input.id, this.input);
    this.access.outputs.set(this.output.id, this.output);
    this.statechange(this.input);
  }
  tx(bytes) { const i = this.input; realTimeout(() => { if (i.state === "connected" && i.onmidimessage) i.onmidimessage({ data: Uint8Array.from(bytes) }); }, 1); }
  rx(d) {
    if (this.mute) return;
    if (d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x52 && d[3] === 0x46) {     // RemoteFM1's HELLO
      this.hellos++;
      if (d[4] === 0x01 && this.remote && this.identity === "FM-1_015") {
        const b = new Array(67).fill(0), put = (o, s) => [...new TextEncoder().encode(s)].forEach((c, i) => { b[o + i] = c; });
        put(0, "RemoteFM1"); b[16] = 2; put(17, this.remote); put(43, "FM-1_015");
        this.tx([0xF0, 0x7D, 0x52, 0x46, 0x41, ...rfPack7(b), 0xF7]);
      }
      return;
    }
    if (d[0] === 0xF0 && d[1] === 0x7D && d[2] === 0x46 && d[3] === 0x4C) {     // INFO
      if (d[4] === 1 && this.version && !this.identity.startsWith("ota-"))
        this.tx([0xF0, 0x7D, 0x46, 0x4C, 1, ...new TextEncoder().encode(this.version), 0, 0xF7]);
      return;
    }
    if (eq(d, HS)) {
      const t = [...new TextEncoder().encode(this.identity)];
      this.tx([0xF0, ...pack7([0, 0x59, 0x11, 0, 0, 0, ...t, ...new Array(28 - t.length).fill(0)]), 0xF7]);
    } else if (eq(d, UPGRADE)) {
      this.upgrades++;
      if (this.stall && !this.identity.startsWith("ota-")) return;
      if (this.loaderStall && this.identity.startsWith("ota-")) return;
      this.queue = this.identity.startsWith("ota-")
        ? [...Array.from({ length: 6 }, (_, k) => [k * 512, 512]), [0xF0000000, 8]]
        : [[0, 64], [0x40, 160], [0x1000, 512], [0xE0000000, 8]];
      this.next();
    } else if (this.waiting) {
      const u = unpack7(d.slice(1, -1));
      const [addr, len] = this.waiting;
      const got = u.slice(14, 14 + (addr >= 0xE0000000 ? 8 : len));
      const want = addr >= 0xE0000000 ? [...new TextEncoder().encode("success"), 0] : Array.from(this.image.subarray(addr, addr + len));
      if (!eq(got, want)) this.bad++;
      this.waiting = null;
      this.served++;
      if (this.identity.startsWith("ota-") && addr < 0xE0000000) {
        this.loaderReads++;
        if (this.loaderReads === this.unplugAt) { realTimeout(() => this.unplug(), 1); return; }
      }
      if (addr === 0xE0000000) realTimeout(() => this.boot(this.loader, "Felucca Update"), 20);
      else if (addr === 0xF0000000) {
        this.writes.push(this.final);
        realTimeout(() => {
          if (this.noReturn) { this.unplug(); return; }
          this.remote = this.finalRemote; this.version = this.finalVersion;
          this.boot(this.final, "FM-1");
        }, 20);
      } else this.next();
    }
  }
  next() {
    const r = this.queue.shift();
    if (!r) return;
    this.waiting = r;
    const [addr, len] = r;
    const u = [0, 0x59, 0x30, 0, 0, 0, 0, addr & 0xFF, (addr >>> 8) & 0xFF, (addr >>> 16) & 0xFF, (addr >>> 24) & 0xFF, len & 0xFF, len >> 8, 0];
    let s = 0;
    for (let i = 6; i < 14; i++) s += u[i];
    u.push(~s & 0xFF);
    this.tx([0xF0, ...pack7(u), 0xF7]);
  }
}
