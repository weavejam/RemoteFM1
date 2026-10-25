/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
 * Copyright (C) 2026 Charles Vestal (the analog key rows: fm1-velocity, fm1-monk)
 * Copyright (C) 2026 RemoteFM1 contributors (taken out into this file, the pause for the battery) */
/* FM-1 analog key rows: velocity and pressure from the keys, with no change to the hardware. The code of felucca-bsp's
 * boards/fm1/fm1_input.h (d6b8f77) that samples the rows, taken out into a file of its own so that RemoteFM1's scan
 * (fm1_input.h, GPL-3.0-only, with its own LED layers) includes it unchanged in what it does; this file stays under
 * MPL-2.0 as it came. fm1_input.h includes it after fm1_in, fm1_led and fm1__led_lines, and its tick calls
 * fm1__an_take / fm1__an_start / fm1__an_frame (docs/VELOCITY.md).
 *
 * With fm1_an.con set (the converter's clock, FM1_ADC_CON), the tick starts a conversion on row PA7 (frame phase 0)
 * or PA8 (phase 1) of the column it has just latched and takes the result at the next tick, so each key on those rows
 * is read once per two frames (~2.2 ms; three with the probe, ~3.3 ms): 1023 open, falling as the key's carbon pill
 * is pressed. The MASTER pot takes the slot of (phase 1, column 0, PA8 = OCT-) and lands in fm1_an.master. The app
 * gets each reading:
 *   FM1_INPUT_ANALOG(col, rowbit, v, driven)   rowbit 3 = PA7, 4 = PA8; the key is FM1_KEYMAP[rowbit][col]
 * With fm1_an.drive set, a key for which FM1_INPUT_DRIVE(col, rowbit) is nonzero (a held key) is read with its row
 * driven high by a weak output instead of pulled up: the pull-up alone sees little but the matrix diode, the driver
 * reads the pill's resistance. The row is an input with its pull-up again at the next tick, before the rows are read.
 * With fm1_an.probe set, a third frame phase reads the top row, PA6 (keys 20..26, columns 0..6, no converter of its
 * own), through PA10, its LED line: PA10 an input with its pull-up, PA6 driven, so a pressed key lifts the column's
 * low level, the more the harder it is pressed. FM1_INPUT_PROBE(col, rowbit, v, pressed) gets each reading, with
 * the scan's last view of that key. A lit LED in a column lifts its keys' readings: FM1_INPUT_LED_OK(col, rowbit)
 * answers 0 for a held key, whose column's LEDs then stay dark on the ticks that read it.
 *
 * One converter: while fm1_an.con is set the scan owns it. The main loop reads the pot from fm1_an.master and, for a
 * conversion of its own (the battery, with the SDK's slow clock), pauses the scan's: fm1_an_pause() (it waits for
 * the conversion in flight to be taken, at most a tick), fm1_adc_read(..), fm1_an_resume(). */
#pragma once
#include <stdint.h>
#include "fm1_gpio.h"
#include "fm1_adc.h"
#include "fm1_time.h"

#ifndef FM1_INPUT_ANALOG
#define FM1_INPUT_ANALOG(col, rowbit, v, driven) ((void)0)
#endif
#ifndef FM1_INPUT_DRIVE
#define FM1_INPUT_DRIVE(col, rowbit) 0
#endif
#ifndef FM1_INPUT_PROBE
#define FM1_INPUT_PROBE(col, rowbit, v, pressed) ((void)0)
#endif
#ifndef FM1_INPUT_LED_OK
#define FM1_INPUT_LED_OK(col, rowbit) 1
#endif
#define FM1_ADC_LED_PA10 2u
#define FM1_PROBE_COLS 7u

static volatile struct {
    uint16_t con;                /* the conversion's clock / start delay (FM1_ADC_CON); 0 = analog off */
    uint8_t drive;               /* a held key read with its row driven (FM1_INPUT_DRIVE) */
    uint8_t probe;               /* the top row read through PA10 (FM1_INPUT_PROBE) */
    uint8_t pend, col, rowbit;   /* a conversion runs for (col, rowbit); rowbit 0 = the pot */
    uint8_t driven;              /* the pending conversion's row is driven high (released at the take) */
    uint8_t probing;             /* the pending conversion is the probe (PA10 / PA6 released at the take) */
    uint8_t phase;               /* frame phase: 0 PA7, 1 PA8, 2 the probe */
    uint16_t master;             /* the MASTER pot, 0..1023 */
    uint16_t timeouts;           /* conversions not done after a tick (the clock too slow) */
    uint32_t samples;            /* conversions taken (diagnostics) */
} fm1_an;

/* a row driven high by a weak output: rowbit 3 = PA7, 4 = PA8, 2 = PA6 (the probe). hd0 1 for a held key (HD0 set:
 * Velo's DRIVE 2, the reading spread over the pressure), 0 for the probe (the weakest, as it was measured) */
static void fm1__row_drive(uint32_t rowbit, uint32_t hd0)
{
    uint32_t m = 1u << (rowbit == 3u ? 7 : rowbit == 4u ? 8 : 6);
    if (hd0)
        FM1_PR(FM1_PA, FM1_HD0) |= m;
    else
        FM1_PR(FM1_PA, FM1_HD0) &= ~m;
    FM1_PR(FM1_PA, FM1_HD) &= ~m;
    FM1_PR(FM1_PA, FM1_OUT) |= m;
    FM1_PR(FM1_PA, FM1_DIR) &= ~m;
}
static void fm1__row_release(uint32_t rowbit)
{
    uint32_t m = 1u << (rowbit == 3u ? 7 : rowbit == 4u ? 8 : 6);
    FM1_PR(FM1_PA, FM1_DIR) |= m;                  /* an input with its pull-up again */
    FM1_PR(FM1_PA, FM1_OUT) &= ~m;
    FM1_PR(FM1_PA, FM1_HD0) &= ~m;
}
/* PA10 (the LED line of row PA6): an input with a pull-up for the probe, an output again after */
static void fm1__pa10_probe(int on)
{
    uint32_t m = 1u << 10;
    if (on) {
        FM1_PR(FM1_PA, FM1_OUT) &= ~m;
        FM1_PR(FM1_PA, FM1_PU) |= m;
        FM1_PR(FM1_PA, FM1_DIR) |= m;
    } else {
        FM1_PR(FM1_PA, FM1_PU) &= ~m;
        FM1_PR(FM1_PA, FM1_DIR) &= ~m;
    }
}
/* the conversion started on the previous tick: its result to the app (FM1_INPUT_ANALOG / _PROBE) or the pot */
static void fm1__an_take(void)
{
    uint32_t driven = fm1_an.driven, probing = fm1_an.probing;
    (void)driven;                                  /* (FM1_INPUT_ANALOG may ignore it) */
    fm1_an.pend = 0;
    if (driven || probing)
        fm1__row_release(fm1_an.rowbit);
    if (probing)
        fm1__pa10_probe(0);
    fm1_an.driven = fm1_an.probing = 0;
    if (fm1_adc_done()) {
        uint32_t v = fm1_adc_take();
        fm1_an.samples++;
        if (probing)
            FM1_INPUT_PROBE(fm1_an.col, fm1_an.rowbit, v, (fm1_in.raw[fm1_an.col] >> fm1_an.rowbit) & 1u);
        else if (fm1_an.rowbit)
            FM1_INPUT_ANALOG(fm1_an.col, fm1_an.rowbit, v, driven);
        else
            fm1_an.master = (uint16_t)v;
    } else {
        fm1_adc_abort();
        fm1_an.timeouts++;
    }
}
/* column n is latched: light it (lit) and start its conversion, to be taken at the next tick */
static void fm1__an_start(uint32_t n, uint32_t lit)
{
    uint32_t ch, rowbit;
    if (fm1_an.phase == 2u) {                      /* the probe frame: the top row through PA10, keys only */
        if (n >= FM1_PROBE_COLS) {
            fm1__led_lines(lit);
            return;
        }
        fm1__led_lines(lit & ~(1u << 2));
        fm1__pa10_probe(1);
        fm1__row_drive(2u, 0u);
        fm1_an.col = (uint8_t)n;
        fm1_an.rowbit = 2u;
        fm1_an.probing = 1;
        fm1_adc_start(FM1_ADC_LED_PA10, fm1_an.con);
        fm1_an.pend = 1;
        return;
    }
    if (fm1_an.phase && n == 0u) {                 /* the pot's slot */
        ch = FM1_ADC_MASTER;
        rowbit = 0;
    } else {
        ch = fm1_an.phase ? FM1_ADC_ROW_PA8 : FM1_ADC_ROW_PA7;
        rowbit = fm1_an.phase ? 4u : 3u;
    }
    fm1__led_lines(rowbit && !FM1_INPUT_LED_OK(n, rowbit) ? 0u : lit);   /* a held key: no LED current in its column */
    fm1_an.col = (uint8_t)n;
    fm1_an.rowbit = (uint8_t)rowbit;
    if (rowbit && fm1_an.drive && FM1_INPUT_DRIVE(n, rowbit)) {
        fm1__row_drive(rowbit, 1u);
        fm1_an.driven = 1;
    }
    fm1_adc_start(ch, fm1_an.con);
    fm1_an.pend = 1;
}
/* a new frame (column 0 latched next): the rows' turn */
static void fm1__an_frame(void)
{
    fm1_an.phase = (uint8_t)(fm1_an.phase + 1u >= 2u + (fm1_an.probe != 0u) ? 0u : fm1_an.phase + 1u);
}

/* main loop: the converter back from the scan (it finishes the conversion in flight at its next tick, ~0.1 ms) and
 * returned. fm1_an_pause returns the clock to give back, 0 if the scan did not let go in time (then don't convert) */
static uint32_t fm1_an_pause(void)
{
    uint32_t con = fm1_an.con, t0 = fm1_ticks();
    fm1_an.con = 0;
    while (fm1_an.pend)
        if ((uint32_t)(fm1_ticks() - t0) >= 2000u * FM1_TICKS_PER_US) {   /* (the scan's timer stopped) */
            fm1_an.con = (uint16_t)con;
            return 0;
        }
    return con ? con : 0x10000u;                   /* (nonzero: "paused", even with the analog rows off) */
}
static void fm1_an_resume(uint32_t con) { fm1_an.con = (uint16_t)(con & 0xFFFFu); }
