// SPDX-License-Identifier: GPL-3.0-only
// The RemoteFM1 web installer page (index.html): the DOM wiring of installer.js, which decides everything and runs
// without a page (the headless engine, ../engine.js, imports it too). Browser only.
import { install, look, describe, releasedPackage, packageFrom } from "./installer.js";

{
  const $ = (id) => document.getElementById(id);
  let access = null, rel = null, busy = false;
  const ui = {
    say(text, kind = "") { $("status").textContent = text; $("status").className = "status " + kind; },
    progress(f) { $("bar").hidden = false; $("bar").value = Math.round(f * 1000); },
    confirm: (t) => window.confirm(t),
    log(t) { $("log").textContent += t + "\n"; },
  };
  const midi = async () => {
    if (!navigator.requestMIDIAccess) throw new Error("This browser has no Web MIDI with SysEx: use Chrome or Edge on a computer.");
    if (!access) access = await navigator.requestMIDIAccess({ sysex: true });
    return access;
  };
  const run = async (what) => {
    if (busy) return;
    busy = true;
    document.body.classList.add("busy");
    $("bar").hidden = true;
    try { await what(); } catch (e) {
      ui.say(e && e.name === "SecurityError" ? "The browser refused MIDI access: allow it (the lock icon in the address bar) and try again." : (e && e.message) || String(e), "bad");
      ui.log(String(e && e.stack || e));
    } finally {
      busy = false;
      document.body.classList.remove("busy");
    }
  };
  // RemoteFM1 is on: the next step is the player (same origin: the MIDI permission just granted carries over)
  const showNext = () => { $("next").hidden = false; $("next").scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  let refusal = null;   // install()'s decision when it refused (decide() in installer.js: is the override offered?)
  const opts = () => ({ override: $("override").checked, midiClosed: $("midi-closed").checked, onRefused: (d) => { refusal = d; } });
  $("go").addEventListener("click", () => run(async () => {
    $("next").hidden = true;
    refusal = null;
    ui.say("Downloading and checking the package...");
    const pkg = await releasedPackage(rel);
    const r = await install(await midi(), pkg, ui, opts());
    if (r === "done" || r === "resumed") showNext();
    if (r === "refused" && !$("override").checked && refusal && refusal.overridable) $("override-box").hidden = false;
  }));
  $("check").addEventListener("click", () => run(async () => { ui.say("Looking for the FM-1..."); ui.say(describe(await look(await midi(), ui.log))); }));
  $("file").addEventListener("change", () => { $("file-go").disabled = !$("file").files.length; });
  $("file-go").addEventListener("click", () => run(async () => {
    const f = $("file").files[0];
    const pkg = await packageFrom(new Uint8Array(await f.arrayBuffer()), null);
    await install(await midi(), pkg, ui, opts());
  }));
  if (!navigator.requestMIDIAccess) $("browser-warn").hidden = false;
  // the player: ../ on the published site, ../site/ in the source tree (web/ served as is)
  fetch("../site/catalog.json", { method: "HEAD" }).then((r) => { if (r.ok) for (const a of document.querySelectorAll("a.player")) a.href = "../site/"; }, () => {});
  fetch("releases.json", { cache: "no-cache" }).then((r) => r.json()).then((list) => {
    rel = list.releases[0];
    $("go").textContent = `Install RemoteFM1 ${rel.version}`;
    $("go").disabled = false;
    const put = (id, f) => { const e = $(id); if (e) f(e); };   // (the page's text may change; installing must not)
    put("ver", (e) => { e.textContent = rel.version; });
    put("date", (e) => { e.textContent = rel.date; });
    put("sha", (e) => { e.textContent = rel.sha256; });
    put("notes", (e) => e.replaceChildren(...rel.notes.map((n) => Object.assign(document.createElement("li"), { textContent: n }))));
  }, (e) => {
    ui.say("The release list could not be loaded. Reload the page.", "bad");
    ui.log(String(e && e.stack || e));
  });
}
