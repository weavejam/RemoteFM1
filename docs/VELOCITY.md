# Key velocity and pressure (RemoteFM1 0.2)

Before 0.2, RemoteFM1 sent every key as `9F 53+k 100`, with the same velocity every time. Starting with 0.2 it
measures how hard each key is pressed, on the stock hardware, and sends:

- **Note On** `9F 53+k v` with the measured velocity `v` (1..127). A key with no measurement still sends 100.
- **Poly aftertouch** `AF 53+k p` (0..127) for held keys on the two analog rows, which are the 20 keys F3..C5.
- **HELLO_R caps** bit 7 (`RFM_CAP_VELOCITY`) and bit 8 (`RFM_CAP_AFTERTOUCH`). See [PROTOCOL.md](PROTOCOL.md).

The wire format did not change. Version 0.1 already had the velocity byte; it just always held 100. A host that
ignores the new caps and aftertouch works as before.

**Status: built and host-tested, but not yet tested on an FM-1.** See "What must be verified on a real FM-1"
below.

## Where it comes from

The method is not ours. It comes from Charles Vestal's velocity work for the FM-1 (fm1-velocity, MONK-1, CTL-1), in
the MPL-2.0 trees felucca-bsp and fm1-base. MPL-2.0 works file by file and is compatible with the GPL. The MPL code
stays in files of its own with its MPL-2.0 headers (see [LICENSING.md](../LICENSING.md)).

| what | from | here |
|---|---|---|
| the analog-row sampling in the scan tick: row drive, PA10 probe, conversion start / take, the pot slot | felucca-bsp `boards/fm1/fm1_input.h` @ d6b8f77 (MPL-2.0) | `firmware/hal/fm1_input_an.h` (MPL-2.0); same code, moved into its own file. Added: `fm1__an_frame`, `fm1_an_pause` / `fm1_an_resume`, and a sample counter |
| the stepped ADC (`fm1_adc_start/done/take/abort`, `FM1_ADC_CON(div, delay)`, rows PA7 = ch0, PA8 = ch1) | felucca-bsp `boards/fm1/fm1_adc.h` @ d6b8f77 (MPL-2.0) | `firmware/hal/fm1_adc.h`, replaced by that file unchanged. It is a superset of the old one, and `fm1_adc_read` behaves the same |
| the per-key state machine, the driven floor / ceiling log curve, the probe curve | fm1-base `lib/sense.c` @ aa2b3bc (MPL-2.0) | `firmware/src/sense.c` (MPL-2.0); the three curves are rewritten in fixed point, everything else unchanged |
| CTL-1's settings, the events, MONK-1's pressure, the scan hooks | fm1-base `lib/touch.c`, `lib/touch.h` (MPL-2.0) | `firmware/src/touch.c` (MPL-2.0); the pressure is in fixed point, there is no `plat_` layer and no host simulator |
| the scan hooks by key (`FM1_INPUT_ANALOG/DRIVE/PROBE/LED_OK`), and `plat_sense` (who owns the converter, `FM1_ADC_CON(7, 2)`, drive + probe on) | fm1-base `device/unity.c`, `device/plat_fm1.c:283-305` | `firmware/src/remote.c` (the macros, `touch_sense`) |
| poly aftertouch from `touch_pressure`, every 5 ms | fm1-ctl `app/ui.c` `pressure()` | `firmware/src/rf_touch.c` `rf_at_step` (rate-limited, see below) |

### Why the maths is in fixed point

fm1-base computes the curves with `float` (its `fastmath.h`, built with `-mfprev1`), and `sense_sample` runs inside
the scan interrupt. RemoteFM1 builds without the FPU, and its ISR wrapper (`hal/fm1_isr.S`) saves only r0-r3, not the
FPU state. So 0.2 uses no floating point at all:

- `sn_log2q` gets log2 by repeated squaring;
- `sn_exp2nq` gets 2^-x as a product of 16 constants;
- `sn_powq` and `sn_fracq` (exact long division) are built on those.

`tests/touch_test.c` checks every one of these against fm1-base's float code (copied into the test):

- `sense_velocity_d` over all 1024 readings × 6 floor/ceiling pairs × 8 curves: never more than 1 velocity step
  off. 54 of 49,152 readings differ by one step.
- the probe curve: exact.
- MONK-1's pressure: exact, over a 600 ms lean-in.

## ADC ownership (what changed from 0.1)

In 0.1, the main loop called `fm1_adc_read` (blocking, with the SDK's slow clock) for MASTER every 5 ms and for the
battery every 250 ms. The scan never touched the converter.

In 0.2, `touch_on(1)` at boot runs `touch_sense(1)`, which works like fm1-base's `plat_sense`:

- `fm1_an.drive = 1`, `fm1_an.probe = 1`, `fm1_an.con = FM1_ADC_CON(7, 2)`.
- From then on the 10 kHz scan tick owns the converter. It starts one conversion after each latch, and the next
  tick takes the result, before it reads the rows and before RemoteFM1's glow/backlight pulses.
- Each frame of 11 columns has a phase: phase 0 reads PA7, phase 1 reads PA8, phase 2 probes the top row through
  PA10.
- **MASTER**: the pot's slot is phase 1, column 0 (PA8 there is OCT-, a button), so the pot is read every 3 frames,
  about every 3.3 ms. The main loop reads `fm1_an.master` every 5 ms, so the PANEL_R / CC 7+39 path is unchanged.
  `fm1_adc_read(MASTER)` is used only when the sensing is off.
- **Battery**: it needs the SDK's slow conversion, which doesn't fit between two ticks. Every 250 ms, and only while
  no key is down, `rf_batt_step` does `fm1_an_pause()`. That waits at most one tick for the conversion in flight,
  then it runs `fm1_adc_read(BATT)` and `fm1_an_resume()`. The scan misses at most one or two analog samples, and
  never while a key is held. The battery thresholds (531 / 561 / 591) are unchanged.
- `REMOTE_TOUCH=0` (compile-time) builds 0.1's behaviour back. The transit unit and the recovery scan
  (`fm1_input_scan`) never turn the analog rows on, so their tick is exactly 0.1's.

### LEDs

RemoteFM1's three LED layers (lit, the `fm1_led_dim` glow, the `fm1_led_bg` backlight, and the host's five levels
mapped onto them) keep working:

- `fm1__an_start` lights the next column with `fm1_led[n]`, as before. The exception is a column that holds a held
  analog key: that column stays dark for the one tick its key is read, because a lit LED lifts the reading. This is
  felucca-bsp's `FM1_INPUT_LED_OK` logic, answered by `app_key_led_ok`: a key that isn't open says no.
- On probe frames, the PA6-row LEDs of columns 0..6 (the top-row keys C#5..G5) are dark for that tick, because PA10
  is then an input.
- The glow and backlight pulses come after the take, so they are unchanged.

So the lit LEDs in a held analog key's column run at about 2/3 brightness (1/3 if keys on both rows are held), and
the lit top-row key LEDs at about 2/3 brightness at all times. Glow and backlight are unaffected.

## How a velocity is computed

This is fm1-base's sense.c with CTL-1's settings. The constants are in `touch.c` `touch_config`.

- **Sampling.** Each key on PA7 / PA8 is read every 3 frames (about 3.3 ms). An open key reads 1023, and the
  reading falls as the carbon pill under the key conducts.
- **States.** The touch threshold is 900. A key below the press threshold (400) is seated. The release threshold is
  600 and must be seen twice.
- **Drive.** Once a key is touched, every other sample is taken with its row driven high (DRIVE 2, HD0). With the
  row driven, the reading minus `SN_DBASE` (185: the diode and the 595) tracks the pill's resistance.
- **Velocity.** The lowest driven reading since the touch, once the key has seated after `wait = 2` samples, on a log
  scale between the firm floor `TOUCH_FIRM` (530, which means 127) and the light ceiling `TOUCH_LIGHT` (896, which
  means 1):
  - `t = log(r / r_floor) / log(r_ceil / r_floor)`
  - `vel = 1 + 126 (1 - t)^0.70`
  - Calibration learning is off (`learn = 0`, as in CTL-1), so every key uses the same fixed ends.
- **Top row** (C#5..G5, keys 20..26, no converter of their own). PA6 is driven and PA10 is read. Each key keeps its
  own open baseline and the peak rise since the contact:
  - `vel = 1 + 126 x^2.40`, with `x = rise / 43`.
  - `touch_vel_contact` reads it.
  - There is no pressure on this row.
- **Pressure.** This is MONK-1's: the driven reading's drop below where the key rests, on a log scale. Up to 0.04
  octave counts as noise, and 0.46 octave more is 127. It is smoothed over about 30 ms. The rest point follows the
  key down for 250 ms after the landing, then creeps slowly.

### When the note-on goes out (`firmware/src/rf_touch.c`)

The digital scan still decides whether a key is down or up, with 0.1's debounce: down after 2 frames, up after 8. What
changed is that a note-on waits for its velocity:

- **Analog-row key.** The note-on uses touch.c's press event for that key. That event is ready after the touch
  sample, two driven samples, and the seating sample. In the scan model that is **14..17 ms after the contact**, the
  timing CTL-1 was tuned with. In 0.1 the note-on came about 2.2 ms after the contact.
  - If no event arrives within `RF_VEL_WAIT_MS` (30 ms) of the digital press, the note-on goes out at 100.
  - An event that came more than `RF_VEL_EARLY_MS` (20 ms) before the digital press belongs to an older press and is
    dropped.
- **Top-row key.** The note-on uses the first probe velocity there is, or 100 after `RF_TOP_WAIT_MS` (4 ms).
- **Releases.** A key let go before its velocity arrived sends nothing. The note-off is the digital release, as in
  0.1.
- **Waiting keys and PANEL_R.** A key that is waiting for its velocity is not yet in PANEL_R's `keys32`, so the
  MIDI stream and PANEL_R agree.
- **Aftertouch.** The keys are checked every `RF_AT_MS` (20 ms). A key sends `AF` when its pressure moves by 2 or
  more, or reaches 0 or 127. A key that lifts off its seat while still held sends 0. There is no aftertouch after
  the note-off.

## Tests

- `tests/touch_test.c` is part of `tests/run_tests.sh`. It checks:
  - the maths and the three curves against fm1-base's float code;
  - 43 presses at velocities 1..127 through a model of the scan's sampling, where every press must land within one
    step of its target (worst case seen: 0 steps);
  - the digital merge: a missed key plays at 100 after 30 ms, a key let go early plays nothing, the top row uses the
    probe, and sensing off gives 0.1's behaviour;
  - the pressure against fm1-base's `touch_update`, and the aftertouch rate.
- `host/run_tests.sh` passes unchanged, including the cross test that runs `rfm_app.c`.

## What must be verified on a real FM-1

None of this has run on hardware yet. Before shipping 0.2 to users, check:

1. **Boot and update path unchanged.** Run docs/SAFETY.md's device test plan: the waiting screen shows `v0.2.0`, and
   OCT- at power-on enters update mode.
2. **Every key still plays and releases.** That includes all 27 keys, OCT-/OCT+ and every button. There must be no
   stuck notes and no double notes, at slow and fast playing, and with chords.
3. **Velocity range.**
   - Soft playing gives low values and hard playing high values, on every analog key (F3..C5) and every top-row key
     (C#5..G5).
   - Check whether the 530 / 896 ends and the top row's 0 / 43 fit this unit. Keys differ by up to about 120 at the
     firm end.
   - Count how often the fallback 100 appears. The waiting screen's fourth line shows `VEL m/p/f`: note-ons with a
     measured velocity, with a probed one, and with the fixed 100, each modulo 1000. `f` should stay near 0.
4. **Latency.** Analog keys now speak 14..17 ms after contact, against about 2 ms in 0.1. Check that this is
   acceptable when playing. If it isn't, the options are:
   - `wait = 1`, which halves the latency but needs the ends retuned;
   - probing the top row less often.
5. **MASTER pot.** It moves smoothly over its full range from the scan's fast conversion (`FM1_ADC_CON(7, 2)`), with
   no jumps, and with no jitter while keys are played.
6. **Battery.** The waiting screen's BATTERY level still reads right. It now pauses the scan, and only while no key
   is down.
7. **LEDs.** Check the glow, the backlight (host faint level) and lit LEDs under a held key. The column dims to
   about 2/3 while one of its keys is held; check that this looks acceptable and that nothing flickers. Also check
   the lit top-row key LEDs (C#5..G5), which are dark on every third frame for the probe.
8. **Aftertouch.** Leaning into a held key raises `AF`, easing off brings it back to 0, and the message rate stays
   reasonable (20 keys × 50/s at worst). Check that a resting finger doesn't send a constant stream.
9. **Scan timing.** Check that the scan ISR cost stays within the tick: no missed encoder steps, and USB stays
   healthy (the waiting screen's ERRORS line).
10. **Converter timeouts.** `fm1_an.timeouts` should stay 0. It shows as ` TO n` on the waiting screen's fourth
    line. A slow ADC clock on some units would show up here.
