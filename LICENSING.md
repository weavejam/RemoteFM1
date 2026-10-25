# Licensing

TransitFM1 is free software under the GNU General Public License, version 3 only (`GPL-3.0-only`, full text in
`LICENSE`). You may use, study, change and share it. If you give someone a firmware built from it, give them its
complete source under the same licence too.

## Who made what

| | |
| --- | --- |
| The platform: `firmware/hal/`, `firmware/loader/` (but for the order in `ldr_core.c`), `firmware/src/` (`usb.c`, `ota.c`, `recovery.c`, `lcd.c`, `gfx.c`, `libc.c`, `bootguard.h`, `uac_fir.h`), `tools/build.py`, `tools/fm1_install.py`, `tools/lz4blk.py` | Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments ([Felucca](https://github.com/hugelton/Felucca)), with the changes of [SLOOP](https://github.com/isod89/sloop-fm1) (isod89) |
| The wiring `firmware/src/platform.c`, as [Dinghy](https://github.com/zvenson/dinghy) has it | zvenson |
| The boot stub `firmware/stub/`, `firmware/crt0.S`, the stub's order in `ldr_core.c`, the kept loader in `ota.c`, `tools/fm1pkg_make.py` (the marker, the compensation), `tools/make_stub_test_pkg.py`, `tests/stub_test.c`, `tests/ota_test.c`, `tests/ldr_test.c`, `tests/stub_pkg_test.py` | ChoralRoot FM-1 contributors ([ChoralRoot FM-1](https://github.com/Quixotic7/ChoralRootFM1)) |
| RemoteFM1's parts: `firmware/src/remote.c`, `firmware/src/remote_proto.h`, the vendor interface and the app hooks in `usb.c` (REMOTE_VENDOR), the TIMER5 hook in `platform.c`, `tools/m0_bench.py`, `tools/m0_bulk.c`, `web/m0_bench.html`, `tests/proto_test.c`, `tests/m0_sim.py`; M1: `firmware/src/rfm_app.c`, `rfm_draw.[ch]`, `rfm_push.[ch]`, the CIN 0xF SysEx hook and the RAM-staged loader in `ota.c`, `tests/rfm_draw_test.c`, `tests/session_test.c`, `tests/usb_midi_test.c`, `proto/`, `docs/PROTOCOL.md`, everything in `host/`, `README.md`, `PLAN.md` | RemoteFM1 contributors |
| RemoteFM1 0.2 (velocity): `firmware/src/rf_touch.c`, the glue in `remote.c` and `fm1_input.h`, `tests/touch_test.c`, `docs/VELOCITY.md`, `.github/workflows/fwsc.yml` | RemoteFM1 contributors (the MPL-2.0 files it uses: below) |
| TransitFM1's parts: the foreign order and the commit after the package CRC in `ldr_core.c`, step 1 in `ota.c` (our own loader, restaged), `transit.c`, the identity, the tests of these, the docs | TransitFM1 contributors |

## Third-party material

| What | Licence | Where |
| --- | --- | --- |
| Key velocity and pressure (RemoteFM1 0.2, `docs/VELOCITY.md`): felucca-bsp's analog key rows and stepped ADC (Leo Kuroshita, Charles Vestal; [hugelton/felucca-bsp](https://github.com/hugelton/felucca-bsp) d6b8f77), fm1-base's key sensing (Charles Vestal, from fm1-velocity, MONK-1 and CTL-1; [charlesvestal/fm1-base](https://github.com/charlesvestal/fm1-base) aa2b3bc) | MPL-2.0 (<https://mozilla.org/MPL/2.0/>), file by file: each file keeps its `SPDX-License-Identifier: MPL-2.0` header and stays under MPL-2.0 (with the changes marked in it); the rest of RemoteFM1, which includes them, stays GPL-3.0-only (MPL-2.0 section 3.3) | `firmware/hal/fm1_adc.h` (felucca-bsp's, unchanged), `firmware/hal/fm1_input_an.h` (felucca-bsp's `fm1_input.h` analog-row code, in its own file), `firmware/src/sense.c` (fm1-base `lib/sense.c`, the curves in fixed point), `firmware/src/touch.c` (fm1-base `lib/touch.c` and `lib/touch.h`, ported) |
| Terminus font 8x16 (ter-u16n), rendered into `firmware/gen/felucca_font.h` | SIL OFL 1.1 | `assets/fonts/Terminus-LICENSE.txt` |
| JieLi AC79 SDK: `uboot.boot`, `cfg_tool.bin`, `eq_cfg_hw.bin` are read from your SDK checkout at build time and placed in the package; no SDK files are in this tree | Apache-2.0 | <https://gitee.com/Jieli-Tech/fw-AC79_AIoT_SDK> |

Dinghy's logo (the designburg signet) is not under the GPL and marks Dinghy itself: it is not part of TransitFM1.

## Trademarks

"Felucca" and "Hügelton Instruments" are names of Hügelton Instruments; "M-VAVE" and "FM-1" belong to their
owners. TransitFM1 answers the update protocol with the official firmware's identity (`FM-1_015`) only so that
installers accept it; it is not made or endorsed by M-VAVE, and its screen says what it is.
