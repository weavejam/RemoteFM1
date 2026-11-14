// SPDX-License-Identifier: GPL-3.0-only
// The RemoteFM1 web installer's decisions (installer.js) against a simulated FM-1 on a fake Web MIDI, end to end in
// Node (TransitFM1's web/test_installer.mjs, GPL-3.0-only, ported): the released package checked (releases.json,
// SHA256SUMS and the file agree), installs over the firmwares that answer as V15, over RemoteFM1 itself (told by its
// HELLO) and over ChoralRoot; Bubba Machine and Sloop refused (Sloop only without the override); no fresh install
// before the visitor says the MIDI apps are closed; an install cut off finished from update mode; a cancel that
// sends nothing. Never against a real unit: the only MIDI here is the fake's.
//   node web/installer/test_installer.mjs [remote-X.Y.fwsc] [FM-1.fwsc]   (default: firmware/ of releases.json)
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { FakeFM1 } from "./fake_fm1.mjs";
import { fileURLToPath } from "node:url";
import { install, look, describe, packageFrom, releasedPackage, IDENTITY, rfPack7, rfUnpack7 } from "./installer.js";

const realTimeout = setTimeout;                    // the protocol's waits (seconds) shortened 20 times
globalThis.setTimeout = (f, ms, ...a) => realTimeout(f, ms >= 200 ? ms / 20 : ms, ...a);

let fails = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) fails++; console.log(`${what.padEnd(78)} ${cond ? "ok" : "FAIL"}`); };

const UI = (answer = true) => {
  const u = { said: [], kinds: [], confirms: 0, prog: 0 };
  return Object.assign(u, { say(t, k = "") { u.said.push(t); u.kinds.push(k); }, progress(f) { u.prog = f; },
                            confirm() { u.confirms++; return answer; }, log() {} });
};

// the page: every element transit.js looks up is in index.html (0.1.1's first page lost #ver: no install button)
{
  const page = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("./page.js", import.meta.url), "utf8");   // (the DOM wiring)
  const ids = [...new Set([...js.matchAll(/(?:\$|put)\("([\w-]+)"/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !new RegExp(`id="${id}"`).test(page));
  ok(ids.length >= 10 && !missing.length, `the page has every element installer.js uses (${ids.length})${missing.length ? ": missing " + missing.join(", ") : ""}`);
  for (const t of [/no sound on\s+its own/, /ChoralRoot users: back up first/, /answers\s+every installer as V15/, /Close every app that uses MIDI/, /Chrome or Edge/])
    ok(t.test(page), `the page says ${t.source.replace(/\\s\+/g, " ")}`);
}
{
  const a = [0, 1, 127, 128, 200, 255, 7, 77, 254];
  ok(rfUnpack7(rfPack7(a)).join() === a.join(), "RemoteFM1's 7-in-8 packing round-trips");
}

// the release the page installs: releases.json, firmware/SHA256SUMS and the file agree
const rels = JSON.parse(readFileSync(new URL("./releases.json", import.meta.url), "utf8")).releases;
const relPath = new URL(`./firmware/remote-${rels[0].version}.fwsc`, import.meta.url);
const pkgPath = process.argv[2] || fileURLToPath(relPath), v15Path = process.argv[3];
const raw = new Uint8Array(readFileSync(pkgPath));
const sha = createHash("sha256").update(raw).digest("hex");
if (!process.argv[2]) {
  const sums = readFileSync(new URL("./firmware/SHA256SUMS", import.meta.url), "utf8");
  ok(sha === rels[0].sha256 && sums.includes(`${sha}  remote-${rels[0].version}.fwsc`), `the released package ${rels[0].version}: releases.json, SHA256SUMS and the file agree`);
  // what Pages publishes (firmware/ as it is): only the listed releases, no earlier package left beside them
  const listed = rels.map((r) => `remote-${r.version}.fwsc`).sort().join();
  const files = readdirSync(new URL("./firmware/", import.meta.url)).filter((f) => f.endsWith(".fwsc")).sort().join();
  const summed = sums.trim().split("\n").map((l) => l.split(/\s+/)[1]).sort().join();
  ok(files === listed && summed === listed, `firmware/ holds the listed packages only (${files})`);
  ok(rels[0].version === "0.1.1" && !files.includes("remote-0.1.fwsc"), "RemoteFM1 0.1.1 is offered, 0.1 is not published");
}
const rel = { version: "9.9", sha256: sha };
const fakeFetch = (bytes) => async (url) => ({ ok: url === "firmware/remote-9.9.fwsc", status: 404, arrayBuffer: async () => bytes.buffer });

// the package
const pkg = await releasedPackage(rel, fakeFetch(raw));
ok(pkg.product === IDENTITY && !pkg.official && pkg.label === "RemoteFM1 9.9", `the released package: identity ${pkg.product}, labelled`);
let err = "";
try { const bad = raw.slice(); bad[5000] ^= 1; await releasedPackage(rel, fakeFetch(bad)); } catch (e) { err = e.message; }
ok(/not the released one/.test(err), "a package whose SHA-256 differs is refused before anything");
err = "";
try { await packageFrom(new Uint8Array(4000)); } catch (e) { err = e.message; }
ok(/not an FM-1|not for the FM-1/.test(err), "a file that is not an FM-1 package is refused");
if (v15Path) {
  const v15 = await packageFrom(new Uint8Array(readFileSync(v15Path)));
  ok(v15.official && v15.product === "FM-1_015" && /official V15/.test(v15.label), "M-VAVE's FM-1.fwsc: recognised as the official V15");
}

// what is on the FM-1
const st = async (o) => describe(await look(new FakeFM1(pkg.image, o).access));
ok(/official firmware \(FM-1_015\).*TransitFM1/.test(await st({})), "look: FM-1_015 with no HELLO answer is stock V15 or TransitFM1");
ok(/runs RemoteFM1 0\.1\.1 /.test(await st({ remote: "0.1.1" })), "look: RemoteFM1 told by its HELLO, with its version");
ok(/ChoralRoot 0\.25\.1\./.test(await st({ identity: "FM-1_920", name: "ChoralRoot FM-1", version: "ChoralRoot 0.25.1" })),
   "look: ChoralRoot by its INFO");
ok(/Bubba Machine/.test(await st({ identity: "FM-1_003", name: "FM-1 Bubba Machine" })), "look: Bubba Machine by its port");
ok(/update mode/.test(await st({ identity: "ota-FM-1_900", name: "Felucca Update" })), "look: update mode");
ok(/No FM-1 found/.test(describe(await look({ inputs: new Map(), outputs: new Map() }))), "look: nothing connected");

// installs
const run = async (o, opts = { midiClosed: true }, answer = true) => {
  const dev = new FakeFM1(pkg.image, o), ui = UI(answer);
  let r, e = null;
  try { r = await install(dev.access, pkg, ui, opts); } catch (x) { e = x; }
  return { dev, ui, r, e };
};
let t = await run({});
ok(t.r === "done" && t.dev.upgrades === 2 && t.dev.bad === 0 && t.dev.identity === IDENTITY && t.ui.confirms === 1 &&
   t.ui.prog === 1 && t.ui.kinds.at(-1) === "ok", "over the stock V15 (or TransitFM1): installed, both steps served right");
t = await run({ identity: "FM-1_920", name: "ChoralRoot FM-1", version: "ChoralRoot 0.25.1" });
ok(t.r === "done" && t.dev.bad === 0 && t.dev.identity === IDENTITY, "over ChoralRoot: installed");
t = await run({ identity: "FM-1_910", name: "Felucca", version: "FELUCCA v1.0.1" });
ok(t.r === "done" && t.dev.bad === 0, "over Felucca 1.0.1: installed");
t = await run({ remote: "0.1.1" });
ok(t.r === "done" && t.dev.bad === 0 && t.dev.identity === IDENTITY && t.dev.hellos >= 1, "over RemoteFM1 (a reinstall): installed");
t = await run({}, {});
ok(t.r === "refused" && t.dev.upgrades === 0 && t.ui.confirms === 0 && /close every app that uses MIDI/i.test(t.ui.said.at(-1)),
   "before the MIDI apps are said to be closed: refused, nothing sent");
t = await run({ identity: "FM-1_920", name: "ChoralRoot FM-1", version: "ChoralRoot 0.25.1" });
ok(t.dev.hellos === 0, "HELLO is sent only to an FM-1 that answers as V15 (ChoralRoot got none)");
t = await run({ identity: "FM-1_003", name: "FM-1 Bubba Machine" }, { override: true, midiClosed: true });
ok(t.r === "refused" && t.dev.upgrades === 0 && t.ui.confirms === 0 && /Bubba/.test(t.ui.said.at(-1)),
   "over Bubba Machine: refused, even with the override; nothing sent");
t = await run({ identity: "FM-1_900", name: "Felucca", version: "FELUCCA SLOOP 2.2" });
ok(t.r === "refused" && t.dev.upgrades === 0 && /Sloop/.test(t.ui.said.at(-1)), "over Sloop: refused, nothing sent");
t = await run({ identity: "FM-1_900", name: "Felucca", version: "FELUCCA SLOOP 2.2" }, { override: true, midiClosed: true });
ok(t.r === "done" && t.dev.bad === 0, "over Sloop with the override: installed");
t = await run({}, { midiClosed: true }, false);
ok(t.r === "cancelled" && t.dev.upgrades === 0, "the confirmation declined: nothing sent");
t = await run({ identity: "ota-FM-1_900", name: "Felucca Update" });
ok(t.r === "resumed" && t.dev.upgrades === 1 && t.dev.bad === 0 && t.dev.identity === IDENTITY && t.ui.confirms === 0,
   "in update mode (an install cut off): the write finished, no question");
t = await run({ identity: "ota-FM-1_015", name: "ota-FM-1" });
ok(t.e && /another firmware/.test(t.e.message) && t.dev.upgrades === 0,
   "in the official loader's update mode: not written (finish it with M-VAVE's own package)");

if (v15Path) {   // TransitFM1's loader writing M-VAVE's V15 answers ota-FM-1_015: cut off, it is finished as the return to stock
  const v15 = await packageFrom(new Uint8Array(readFileSync(v15Path)));
  const dev = new FakeFM1(v15.image, { identity: "ota-FM-1_015", name: "ota-FM-1", final: "FM-1_015" }), ui = UI();
  const r = await install(dev.access, v15, ui, { midiClosed: true });
  ok(r === "resumed" && dev.bad === 0 && dev.identity === "FM-1_015", "in update mode as ota-FM-1_015 with M-VAVE's V15 chosen: the write finished");
}
t = await run({ identity: "FM-1_101", name: "FM-1+VA" });
ok(t.r === "refused" && t.dev.upgrades === 0, "over Baud Girl (FM-1_101, a version the table does not know): refused, nothing sent");

if (process.env.LONG_PKG) {   // a flash.bin past the app area (as Baud Girl's): refused before the FM-1 is asked anything
  let e = "";
  try { await packageFrom(new Uint8Array(readFileSync(process.env.LONG_PKG))); } catch (x) { e = x.message; }
  ok(/larger than RemoteFM1 can install/.test(e) && /official V15 first/.test(e), "a package past the app area: refused, go through V15");
}

console.log(fails ? `installer: ${fails} of ${checks} FAILED` : `installer tests passed (${checks})`);
process.exit(fails ? 1 : 0);
