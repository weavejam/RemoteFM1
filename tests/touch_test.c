/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 RemoteFM1 contributors */
/* RemoteFM1 0.2's velocity and pressure on the host (docs/VELOCITY.md): firmware/src/touch.c + sense.c (fm1-base's,
 * in fixed point) and rf_touch.c (the note-on that waits for its velocity, the poly aftertouch), compiled as the
 * device has them, fed by a model of the keys.
 *   - the fixed-point maths against libm, and the three curves against fm1-base's float code (copied below), on every
 *     reading: within one velocity step;
 *   - presses through the scan's sampling (one reading per key every three frames, driven when sense asks, a pulled
 *     one otherwise): the velocity each lands with is the one its landing reading was made for;
 *   - the merge with the digital scan: the note-on waits for the velocity, a key the sensing misses plays at 100
 *     after RF_VEL_WAIT_MS, the top row from the probe, a key let go before its velocity plays nothing;
 *   - the pressure against fm1-base's float touch_update, and the aftertouch messages and their rate.
 * Ends "touch_test: N checks, 0 failed" (exit 0). */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int checks, failed;
#define CHECK(c, ...)                                                                                                \
    do {                                                                                                             \
        checks++;                                                                                                    \
        if (!(c)) {                                                                                                  \
            failed++;                                                                                                \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);                                                              \
            printf(__VA_ARGS__);                                                                                     \
            printf("\n");                                                                                            \
        }                                                                                                            \
    } while (0)

/* ---- touch.c's and rf_touch.c's includer */
#include "../proto/rfm1.h"
static uint32_t T_ms;                    /* the clock */
static int sense_hw;                     /* touch_sense: the scan's readings on */
static uint32_t touch_ms(void) { return T_ms; }
static void touch_sense(int on) { sense_hw = on; }
static uint32_t touch_analog_mask(void) { return 0xFFFFFu; }   /* keys 0..19 on PA7 / PA8, 20..26 the top row */
static uint8_t rf_vel[27];
static uint32_t rfa_keys;                /* rfm_app.c's view: the keys whose note-on went out */
static uint32_t at_n, at_last_k, at_last_p, at_per_key[27];
static void rfm_app_key_pressure(uint32_t k, uint32_t p)
{
    if (k >= RFM_NKEYS || !((rfa_keys >> k) & 1u))
        return;
    at_n++;
    at_per_key[k]++;
    at_last_k = k;
    at_last_p = p;
}
#include "../firmware/src/touch.c"
#include "../firmware/src/rf_touch.c"

/* ---- fm1-base's float code (lib/sense.c, lib/touch.c at aa2b3bc; fastmath.h replaced by libm) */
static uint8_t ref_velocity_d(uint32_t d, uint32_t fl, uint32_t cl, uint32_t curve100)
{
    float top = 127.0f, r, r0, r1, t, c;
    if (d <= fl)
        return (uint8_t)top;
    if (d >= cl || cl <= fl + 1u)
        return 1;
    r = (float)(d > SN_DBASE ? d - SN_DBASE : 1u);
    r0 = (float)(fl > SN_DBASE ? fl - SN_DBASE : 1u);
    r1 = (float)(cl - SN_DBASE);
    t = log2f(r / r0) / log2f(r1 / r0);
    t = t < 0.0f ? 0.0f : t > 1.0f ? 1.0f : t;
    c = (float)curve100 * 0.01f;
    return (uint8_t)(1.0f + (top - 1.0f) * powf(1.0f - t, c) + 0.5f);
}
static uint8_t ref_probe_velocity(uint32_t pk, uint32_t lo, uint32_t hi, uint32_t curve100)
{
    float c = (float)curve100 * 0.01f, x;
    if (pk <= lo)
        return 1;
    if (pk >= hi)
        return 127;
    x = (float)(pk - lo) / (float)(hi - lo);
    return (uint8_t)(1.0f + 126.0f * powf(x, c) + 0.5f);
}
/* the driven landing reading that maps to velocity v (fm1-base touch.c touch_land_for, the curve inverted) */
static uint32_t ref_land_for(uint32_t v)
{
    float r0 = (float)(TOUCH_FIRM - SN_DBASE), r1 = (float)(TOUCH_LIGHT - SN_DBASE), c = TOUCH_CURVE * 0.01f, t;
    if (v >= 127u)
        return TOUCH_FIRM - 1u;
    t = 1.0f - powf(((float)v - 1.0f) / 126.0f, 1.0f / c);
    return SN_DBASE + (uint32_t)(r0 * powf(r1 / r0, t) + 0.5f);
}
/* touch_update at sens 0 */
static float rp_base[NKEYS], rp_s[NKEYS];
static uint32_t rp_t0[NKEYS], rp_t;
static uint8_t rp_on[NKEYS], rp_val[NKEYS];
static void ref_touch_update(void)
{
    uint32_t i, now = T_ms;
    float span = 0.8f * (1.0f - 0.85f * 0.5f);
    if (now - rp_t < 5u)
        return;
    rp_t = now;
    for (i = 0; i < NKEYS; i++) {
        float d, lean, x;
        if (!sense_is_analog(i) || sn_key[i].st != SN_DOWN || !sn_key[i].dn) {
            rp_on[i] = 0;
            rp_s[i] = 0.0f;
            rp_val[i] = 0;
            continue;
        }
        d = (float)(sn_key[i].d > SN_DBASE + 1u ? sn_key[i].d - SN_DBASE : 1u);
        if (!rp_on[i]) {
            rp_on[i] = 1;
            rp_base[i] = d;
            rp_t0[i] = now;
        }
        if (d > rp_base[i])
            rp_base[i] = d;
        else
            rp_base[i] += (d - rp_base[i]) * (now - rp_t0[i] < P_SETTLE ? 0.25f : 0.0008f);
        lean = log2f(rp_base[i] / d);
        x = (lean - 0.04f) / span;
        x = x < 0.0f ? 0.0f : x > 1.0f ? 1.0f : x;
        rp_s[i] += (x - rp_s[i]) * 0.17f;
        rp_val[i] = (uint8_t)(rp_s[i] * 127.0f + 0.5f);
    }
}

/* ---- a model of the keys and the scan. Each analog key is read once every three frames (~3.3 ms, phases PA7 / PA8
 * / probe), driven when sense asked for it at the previous reading. A pressed key reads PULL (the diode) pulled up and
 * land[k] driven; an open one 1023 both ways. The top row: a probe reading every three frames, PROBE_BASE open and
 * PROBE_BASE + rise[k] pressed. The digital scan: a key closed for two frames is down, open for eight is up. */
#define PULL 300u
#define PROBE_BASE 100u
static uint8_t m_down[NKEYS];            /* the key's contact closed */
static uint32_t m_land[NKEYS], m_rise[NKEYS];
static uint32_t m_cnt[NKEYS], m_keys;    /* the digital debounce, the debounced keys */
static uint32_t m_us;                    /* the model's clock (us); a frame is 1100 us */
static uint32_t out_keys, notes_on;      /* rf_keys_step's result; note-ons seen */
static uint8_t note_vel[NKEYS];

static void model_frame(void)
{
    uint32_t k, phase = (m_us / 1100u) % 3u;
    for (k = 0; k < NKEYS; k++) {        /* the digital debounce (fm1_input.h fm1__key) */
        uint32_t on = (m_keys >> k) & 1u, closed = m_down[k];
        if (closed == on) {
            m_cnt[k] = 0;
            continue;
        }
        if (++m_cnt[k] >= (on ? 8u : 2u)) {
            m_cnt[k] = 0;
            m_keys ^= 1u << k;
        }
    }
    for (k = 0; k < NKEYS; k++) {
        if (k < 20u && phase == (k < 10u ? 0u : 1u)) {      /* (which keys are on which row: any split will do) */
            int driven = app_key_drive(k);
            uint32_t v = !m_down[k] ? 1023u : driven ? m_land[k] : PULL;
            app_key_sample(k, v, m_us * 24u, driven);
        } else if (k >= 20u && phase == 2u) {
            app_key_probe(k, m_down[k] ? PROBE_BASE + m_rise[k] : PROBE_BASE, m_down[k]);
        }
    }
    m_us += 1100u;
}
/* run the model for ms milliseconds, the main loop's step once a millisecond (remote.c rf_ms_step) */
static void run_ms(uint32_t ms)
{
    uint32_t end = T_ms + ms;
    while (T_ms < end) {
        uint32_t i, ch;
        while (m_us < (T_ms + 1u) * 1000u)
            model_frame();
        T_ms++;
        out_keys = rf_keys_step(m_keys, T_ms);
        for (ch = out_keys & ~rfa_keys, i = 0; ch; ch >>= 1, i++)
            if (ch & 1u) {
                notes_on++;
                note_vel[i] = rf_vel[i];
            }
        rfa_keys = out_keys;
        rf_at_step(out_keys, T_ms);
        ref_touch_update();
    }
}

static void test_maths(void)
{
    uint32_t x, c, u, bad = 0;
    double worst = 0.0;
    for (x = 1; x < (1u << 23); x += x < 4096u ? 1u : x / 512u) {
        double e = fabs(sn_log2q(x) / 65536.0 - log2((double)x));
        if (e > worst)
            worst = e;
    }
    CHECK(worst < 1.5e-4, "sn_log2q: worst error %g", worst);
    printf("sn_log2q: worst error %.2g (Q16 %.1f ulp) on 1..2^23\n", worst, worst * 65536.0);
    for (c = 50; c <= 300; c += 10)
        for (u = 1; u <= 65536u; u += 7u) {
            double want = pow(u / 65536.0, c / 100.0), got = sn_powq(u, c) / 65536.0;
            if (fabs(got - want) > 6e-4)
                bad++;
        }
    CHECK(!bad, "sn_powq: %u values off by more than 6e-4", bad);
    for (u = 0; u < 5000u; u++) {
        uint32_t den = 1u + (uint32_t)rand() % 1000000u, num = (uint32_t)rand() % (den + 1u);
        uint32_t q = sn_fracq(num, den), want = (uint32_t)((double)num * 65536.0 / den);
        if (q != (want > 65536u ? 65536u : want) && !(num == den && q == 65536u))
            bad++;
    }
    CHECK(!bad, "sn_fracq: %u quotients wrong", bad);
}

static void test_curves(void)
{
    static const uint16_t ENDS[][2] = {{530, 896}, {450, 1000}, {300, 700}, {600, 1020}, {200, 400}, {800, 900}};
    uint32_t e, d, pk, curve, n = 0, off1 = 0, off2 = 0;
    for (e = 0; e < sizeof ENDS / sizeof ENDS[0]; e++)
        for (curve = 40; curve <= 250; curve += 30) {
            sn_cfg.d_curve = (uint16_t)curve;
            for (d = 0; d <= 1023u; d++) {
                int got = sense_velocity_d(d, ENDS[e][0], ENDS[e][1]), want = ref_velocity_d(d, ENDS[e][0], ENDS[e][1], curve);
                n++;
                if (got != want)
                    off1++;
                if (abs(got - want) > 1)
                    off2++;
            }
        }
    touch_config();
    CHECK(!off2, "sense_velocity_d: %u of %u readings more than one step from fm1-base's", off2, n);
    printf("sense_velocity_d: %u readings, %u one step off fm1-base's float curve, none more\n", n, off1);
    n = off1 = off2 = 0;
    for (curve = 100; curve <= 300; curve += 20) {
        sn_cfg.t_curve = (uint16_t)curve;
        for (pk = 0; pk <= 60u; pk++) {
            int got, want = ref_probe_velocity(pk, 0, 43, curve);
            sn_probe[20].down = 1;
            sn_probe[20].peak = (uint16_t)pk;
            got = sense_probe_velocity(20);
            n++;
            if (got != want)
                off1++;
            if (abs(got - want) > 1)
                off2++;
        }
    }
    sn_probe[20].down = 0;
    touch_config();
    CHECK(!off2, "sense_probe_velocity: %u of %u more than one step off", off2, n);
    printf("sense_probe_velocity: %u peaks, %u one step off, none more\n", n, off1);
}

static void reset_model(void)
{
    memset(m_down, 0, sizeof m_down);
    run_ms(60);                          /* everything open, released, debounced */
    notes_on = 0;
    memset(note_vel, 0, sizeof note_vel);
}

static void test_presses(void)
{
    uint32_t v, k, worst = 0, t0, lat_min = 999, lat_max = 0;
    for (v = 1; v <= 127u; v += 3) {
        k = v % 20u;
        m_land[k] = ref_land_for(v);
        m_down[k] = 1;
        t0 = T_ms;
        while (!((out_keys >> k) & 1u) && T_ms - t0 < 100u)
            run_ms(1);
        CHECK((out_keys >> k) & 1u, "key %u (velocity %u): no note-on", k, v);
        CHECK(T_ms - t0 <= 18u, "key %u: the note-on %u ms after the contact", k, T_ms - t0);   /* (wait 2: see VELOCITY.md) */
        lat_min = T_ms - t0 < lat_min ? T_ms - t0 : lat_min;
        lat_max = T_ms - t0 > lat_max ? T_ms - t0 : lat_max;
        CHECK(rf_vel_n[2] == 0, "key %u: the fixed velocity used", k);
        {
            uint32_t d = note_vel[k] > v ? note_vel[k] - v : v - note_vel[k];
            if (d > worst)
                worst = d;
            CHECK(d <= 1u, "key %u: landed for %u, played %u", k, v, note_vel[k]);
        }
        run_ms(40);
        m_down[k] = 0;
        run_ms(40);
        CHECK(!((out_keys >> k) & 1u), "key %u: still on after its release", k);
    }
    printf("analog presses: 43 velocities 1..127 through the scan model, worst %u step(s) off; note-on %u..%u ms "
           "after the contact\n", worst, lat_min, lat_max);
}

static void test_merge(void)
{
    uint32_t t0, k, n0;
    /* the sensing misses a key (its readings never come): 100 after RF_VEL_WAIT_MS of the digital press */
    reset_model();
    k = 5;
    m_down[k] = 1;
    m_land[k] = 1023u;                   /* (driven: reads open; pulled: PULL < press) */
    sn_cfg.press = 200;                  /* PULL never seats: no velocity from sense */
    t0 = T_ms;
    n0 = rf_vel_n[2];
    while (!((out_keys >> k) & 1u) && T_ms - t0 < 100u)
        run_ms(1);
    sn_cfg.press = 400;
    CHECK(rf_vel_n[2] == n0 + 1u && note_vel[k] == RFM_MIDI_KEY_VEL, "a missed key: fixed velocity %u", note_vel[k]);
    CHECK(T_ms - t0 >= RF_VEL_WAIT_MS && T_ms - t0 <= RF_VEL_WAIT_MS + 5u, "a missed key: note-on after %u ms",
          T_ms - t0);
    m_down[k] = 0;
    run_ms(40);
    /* let go before the velocity: no note */
    reset_model();
    sn_cfg.press = 200;
    m_down[k] = 1;
    run_ms(8);                           /* debounced down (2 frames), no velocity yet */
    CHECK(!((out_keys >> k) & 1u), "a key waiting for its velocity is not reported");
    m_down[k] = 0;
    run_ms(60);
    sn_cfg.press = 400;
    CHECK(notes_on == 0u, "a key let go before its velocity: %u note-ons", notes_on);
    /* the top row: the probe's peak */
    reset_model();
    for (k = 20; k < 27u; k++) {
        uint32_t want = ref_probe_velocity(6u * (k - 19u), 0, 43, 240);
        m_rise[k] = 6u * (k - 19u);
        m_down[k] = 1;
        t0 = T_ms;
        while (!((out_keys >> k) & 1u) && T_ms - t0 < 100u)
            run_ms(1);
        CHECK(note_vel[k] == want || note_vel[k] + 1u == want || note_vel[k] == want + 1u,
              "top key %u: probe rise %u, velocity %u (want %u)", k, m_rise[k], note_vel[k], want);
        CHECK(T_ms - t0 <= 10u, "top key %u: note-on %u ms after the contact", k, T_ms - t0);
        m_down[k] = 0;
        run_ms(40);
    }
    /* sensing off: 0.1's panel, 100 at the digital press */
    reset_model();
    touch_on(0);
    CHECK(!sense_hw && !rf_caps_dev(), "touch_on(0): the scan's readings off, no caps");
    m_down[3] = 1;
    t0 = T_ms;
    while (!((out_keys >> 3) & 1u) && T_ms - t0 < 100u)
        run_ms(1);
    CHECK(note_vel[3] == RFM_MIDI_KEY_VEL && T_ms - t0 <= 4u, "sensing off: velocity %u after %u ms", note_vel[3],
          T_ms - t0);
    m_down[3] = 0;
    run_ms(40);
    touch_on(1);
    CHECK(sense_hw && rf_caps_dev() == (RFM_CAP_VELOCITY | RFM_CAP_AFTERTOUCH), "touch_on(1): caps");
}

static void test_pressure(void)
{
    uint32_t k = 7, worst = 0, t, n0, d;
    reset_model();
    m_land[k] = ref_land_for(80);
    m_down[k] = 1;
    run_ms(400);                          /* landed and settled: the rest */
    n0 = at_n;
    CHECK(touch_pressure(k) == 0u, "resting: pressure %u", touch_pressure(k));
    for (t = 0; t < 600u; t++) {         /* lean in: the reading falls 40 % over 0.3 s, then holds */
        uint32_t land = ref_land_for(80);
        m_land[k] = t < 300u ? land - (land - SN_DBASE) * 2u * t / 1500u : land - (land - SN_DBASE) * 2u / 5u;
        run_ms(1);
        d = touch_pressure(k) > rp_val[k] ? touch_pressure(k) - rp_val[k] : rp_val[k] - touch_pressure(k);
        if (d > worst)
            worst = d;
    }
    CHECK(worst <= 2u, "pressure: %u off fm1-base's float touch_update", worst);
    CHECK(touch_pressure(k) >= 100u, "leaning in 40 %%: pressure %u", touch_pressure(k));
    CHECK(at_n > n0 && at_last_k == k && at_last_p == touch_pressure(k), "aftertouch sent: %u, last %u", at_n - n0,
          at_last_p);
    CHECK(at_n - n0 <= 600u / RF_AT_MS + 1u, "aftertouch rate: %u messages in 600 ms", at_n - n0);
    printf("pressure: worst %u off fm1-base's float touch_update; %u aftertouch messages in 600 ms\n", worst, at_n - n0);
    m_land[k] = ref_land_for(80);        /* eased off again: back towards 0 */
    run_ms(200);
    CHECK(touch_pressure(k) <= 2u && at_last_p <= 2u, "eased off: pressure %u, last sent %u", touch_pressure(k),
          at_last_p);
    m_down[k] = 0;
    run_ms(40);
    n0 = at_n;
    run_ms(100);
    CHECK(at_n == n0, "no aftertouch for a key that is up");
}

/* a press whose pill goes on compressing after the note (the FM-1 on 2026-10-25: every note-on was followed by
 * AF 2, 10, 8, 5, 2, 0 over ~200 ms with the finger still): no aftertouch while the key settles, then a lean
 * still comes through */
#ifndef SETTLE_FALL_MS
#define SETTLE_FALL_MS 40u
#endif
#ifndef SETTLE_FIRST_PCT
#define SETTLE_FIRST_PCT 60u
#endif
static void test_settle(void)
{
    uint32_t k = 9, t, n0, land = ref_land_for(80), settle_n, max_p = 0;
    uint32_t first = land + (1023u - land) * SETTLE_FIRST_PCT / 100u;
    reset_model();
    n0 = at_per_key[k];
    m_land[k] = first;
    m_down[k] = 1;
    for (t = 0; t < RF_AT_SETTLE_MS; t++) {   /* the reading falls to where the key rests over SETTLE_FALL_MS */
        m_land[k] = t < SETTLE_FALL_MS ? land + (first - land) * (SETTLE_FALL_MS - t) / SETTLE_FALL_MS : land;
        run_ms(1);
        if (at_per_key[k] != n0 && at_last_k == k && at_last_p > max_p)
            max_p = at_last_p;
    }
    settle_n = at_per_key[k] - n0;
    CHECK(settle_n == 0u, "settling: %u aftertouch messages (up to %u) with the finger still", settle_n, max_p);
    run_ms(100);
    CHECK(at_per_key[k] - n0 == 0u, "settled: %u aftertouch messages at rest", at_per_key[k] - n0);
    for (t = 0; t < 300u; t++) {              /* then a lean: it comes through */
        m_land[k] = land - (land - SN_DBASE) * 2u * t / 1500u;
        run_ms(1);
    }
    CHECK(at_per_key[k] - n0 > 0u && at_last_k == k && at_last_p >= 50u, "a lean after settling: last sent %u",
          at_last_p);
    printf("settle: %u aftertouch messages while the key settled; a lean then %u\n", settle_n, at_last_p);
    m_down[k] = 0;
    run_ms(40);
}

int main(void)
{
    touch_on(1);
    CHECK(sense_hw && touch_is_on(), "touch_on(1)");
    test_maths();
    test_curves();
    test_presses();
    test_merge();
    test_pressure();
    test_settle();
    printf("touch_test: %d checks, %d failed\n", checks, failed);
    return failed != 0;
}
