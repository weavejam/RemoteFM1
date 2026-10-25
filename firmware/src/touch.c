/* SPDX-License-Identifier: MPL-2.0
 * Copyright (C) 2026 Charles Vestal (from CTL-1 and MONK-1)
 * Copyright (C) 2026 RemoteFM1 contributors (the port: integer maths, no plat_ layer) */
/* Velocity and pressure from the FM-1's keys, with no change to the hardware: fm1-base's lib/touch.c
 * (github.com/charlesvestal/fm1-base aa2b3bc) and lib/touch.h, ported to RemoteFM1 (docs/VELOCITY.md). MPL-2.0 as
 * they came. What changed: one file (touch.h's interface is the functions below); the pressure in fixed point (no
 * FPU, as sense.c); no plat_ layer (the includer supplies touch_ms() and touch_sense(on), which hands the converter
 * to the scan); no curve or sensitivity setting (CTL-1's defaults: curve 0, sens 0); no host simulator (tests/
 * touch_test.c has its own model of the keys).
 *
 * While it is on, the 20 keys on the analog rows (F3 to C5) are sensed: their presses come from touch_take, with the
 * velocity they landed at, and a held one has a pressure (touch_update every few ms, touch_pressure). The seven keys
 * of the top row (C#5 to G5) have no converter: the digital scan sees them as usual, and touch_vel_contact gives
 * the velocity they were pressed at, from a probe through the LED line (no pressure).
 *
 * The includer defines, before including this file (remote.c; tests/touch_test.c):
 *   static uint32_t touch_ms(void);          milliseconds
 *   static void touch_sense(int on);         the scan's analog readings on (fm1_an: drive, probe, the clock) or off
 *   static uint32_t touch_analog_mask(void); bit k: key k is on an analog row (PA7 / PA8) */
#include "sense.c"

#define NKEYS SN_NKEYS

/* the scale, tuned by playing (CTL-1, 2026-10-15): the analog keys' driven reading for 127 and for 1, the curve's
 * exponent x 100 at curve 0; the top row's probe 0 / 43, its exponent 2.40 */
#define TOUCH_FIRM 530u
#define TOUCH_LIGHT 896u
#define TOUCH_CURVE 70u

enum { TOUCH_PRESS = 1, TOUCH_RELEASE = 2 };
typedef struct { uint8_t type, key, vel; } touch_ev_t;

static uint8_t touch_live;

/* Velo's settings, as MONK-1 and CTL-1 use them (curve 0: the exponent TOUCH_CURVE) */
static void touch_config(void)
{
    sn_cfg.touch = 900;
    sn_cfg.press = 400;
    sn_cfg.release = 600;
    sn_cfg.wait = 2;
    sn_cfg.v_lo = 0;
    sn_cfg.v_hi = 72;
    sn_cfg.vmax = 127;
    sn_cfg.at_range = 32;
    sn_cfg.drive = 2;
    sn_cfg.d_curve = TOUCH_CURVE;
    sn_cfg.d_ceil = TOUCH_LIGHT;
    sn_cfg.d_floor = TOUCH_FIRM;
    sn_cfg.d_at_range = 64;
    sn_cfg.t_lo = 0;                     /* the top row's probe: */
    sn_cfg.t_hi = 43;                    /* firm presses pile up at 43..45 */
    sn_cfg.t_curve = 240;
    sn_cfg.learn = 0;
}

/* the readings on or off (let every key go first: the keys change hands) */
static void touch_on(int on)
{
    on = on != 0;
    touch_config();
    if (on == touch_live)
        return;
    if (on) {
        sense_init(touch_analog_mask());   /* fresh key states: nothing was sampled while off */
        touch_config();
        sense_cal_reset();
    }
    touch_sense(on);
    touch_live = (uint8_t)on;
}
static int touch_is_on(void) { return touch_live; }
static int touch_sensed(uint32_t key) { return key < NKEYS && sense_is_analog(key); }

/* events: the next press (with its velocity) or release of a sensed key, 0 when none (main loop) */
static int touch_take(touch_ev_t *e)
{
    sense_ev_t s;
    while (touch_live && sense_take(&s)) {
        if (s.key >= NKEYS || (s.type != EV_ON && s.type != EV_OFF))
            continue;
        e->type = s.type == EV_ON ? TOUCH_PRESS : TOUCH_RELEASE;
        e->key = s.key;
        e->vel = s.vel ? s.vel : 1u;
        return 1;
    }
    return 0;
}

/* pressure, every 5 ms (MONK-1's): counted from where the key rests, not from where it landed (a key goes on
 * settling after the note), so the zero follows the driven reading down for P_SETTLE ms, then creeps after it,
 * and comes back up at once when the key is eased. The lean is the pill's resistance below its rest on a log
 * scale: P_DEAD of an octave is noise, P_SPAN more is 127. Smoothed over ~30 ms.
 * RemoteFM1: in fixed point, at sens 0 (fm1-base: P_SPAN(0.5) = 0.46 octave). The rest is Q12 counts, the lean and
 * the smoothed value Q16; the creeps 0.25 and 0.0008 (52 / 65536) a step, the smoothing 0.17 (11141 / 65536) */
#define P_SETTLE 250u                    /* ms */
#define P_DEAD 2621                      /* 0.04 octave of resistance, Q16 */
#define P_SPAN 30147u                    /* 0.46 octave, Q16 */
static uint32_t p_base[NKEYS];           /* the rest, Q12 counts above SN_DBASE */
static int32_t p_s[NKEYS];               /* the smoothed pressure, Q16 */
static uint32_t p_t0[NKEYS], p_t;
static uint8_t p_on[NKEYS], p_val[NKEYS];
static void touch_update(void)
{
    uint32_t i, now = touch_ms();
    if (!touch_live || now - p_t < 5u)
        return;
    p_t = now;
    for (i = 0; i < NKEYS; i++) {
        uint32_t d, d12, x;
        int32_t lean;
        if (!sense_is_analog(i) || sn_key[i].st != SN_DOWN || !sn_key[i].dn) {
            p_on[i] = 0;
            p_s[i] = 0;
            p_val[i] = 0;
            continue;
        }
        d = sn_key[i].d > SN_DBASE + 1u ? sn_key[i].d - SN_DBASE : 1u;
        d12 = d << 12;
        if (!p_on[i]) {
            p_on[i] = 1;
            p_base[i] = d12;
            p_t0[i] = now;
        }
        if (d12 > p_base[i]) {
            p_base[i] = d12;                                   /* eased off: that is the rest now */
        } else {
            int32_t diff = (int32_t)d12 - (int32_t)p_base[i];   /* <= 0 */
            p_base[i] = (uint32_t)((int32_t)p_base[i] + (now - p_t0[i] < P_SETTLE ? diff / 4 : diff * 52 / 65536));
        }
        lean = sn_log2q(p_base[i]) - 12 * 65536 - sn_log2q(d);   /* log2(rest / d), Q16 */
        x = lean <= P_DEAD ? 0u : sn_fracq((uint32_t)(lean - P_DEAD) < P_SPAN ? (uint32_t)(lean - P_DEAD) : P_SPAN,
                                           P_SPAN);
        p_s[i] += ((int32_t)x - p_s[i]) * 11141 / 65536;
        p_val[i] = (uint8_t)(((uint32_t)(p_s[i] > 0 ? p_s[i] : 0) * 127u + 32768u) >> 16);
    }
}
/* a held sensed key: how much harder it is pressed than it rests, 0..127 */
static uint8_t touch_pressure(uint32_t key) { return key < NKEYS ? p_val[key] : 0; }
/* a sensed key is seated (its pressure counts; lifting, it does not) */
static int touch_down(uint32_t key) { return key < NKEYS && touch_live && sn_key[key].st == SN_DOWN && sn_key[key].dn; }
/* a top-row key just pressed: its velocity, 0 when there is no reading */
static uint8_t touch_vel_contact(uint32_t key) { return touch_live ? sense_probe_velocity(key) : 0; }

/* ---- the scan's readings, by key (from its interrupt) */
static void app_key_sample(uint32_t key, uint32_t v, uint32_t ticks, int driven) { sense_sample(key, v, ticks, driven); }
static int app_key_drive(uint32_t key) { return sense_want_drive(key); }
static void app_key_probe(uint32_t key, uint32_t v, uint32_t pressed) { sense_probe(key, v, pressed); }
static int app_key_led_ok(uint32_t key) { return key >= NKEYS || sn_key[key].st == SN_OPEN; }   /* open: its column may light */
