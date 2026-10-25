/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 RemoteFM1 contributors */
/* RemoteFM1 0.2: the keys' velocity and pressure into the panel events (docs/VELOCITY.md). No HAL: remote.c includes
 * it after touch.c and rfm_app.c, tests/touch_test.c with a model of the keys. The includer defines rf_vel[27] (the
 * note-on velocities rfm_app.c sends, RFA_KEY_VEL) and RFA_* below as it likes.
 *
 * A note-on waits for its velocity. The digital scan stays the one that says a key is down or up (its debounce, as
 * 0.1), and its press is held back until the velocity is known:
 *  - a key on an analog row: touch.c's press of that key (the lowest driven reading after the touch; ~4..7 ms after
 *    the contact, a few ms after the digital press), or RFM_MIDI_KEY_VEL after RF_VEL_WAIT_MS without one (a key the
 *    sensing missed plays anyway). A press of touch.c's that came more than RF_VEL_EARLY_MS before the digital one
 *    belongs to an earlier press and is not used;
 *  - a top-row key: touch_vel_contact (the PA10 probe's peak since the contact), the first reading there is, or
 *    RFM_MIDI_KEY_VEL after RF_TOP_WAIT_MS;
 *  - with the sensing off: RFM_MIDI_KEY_VEL at once (0.1).
 * A key let go before its velocity came plays nothing. The note-off is the digital release, as in 0.1.
 *
 * Poly aftertouch (AF 53+k p) for the held keys on the analog rows, as touch.c measures their pressure: a change of
 * 2 or more (or to 0 / 127), the keys looked at every RF_AT_MS; 0 when a held key lifts off its seat. */
#ifndef RF_VEL_WAIT_MS
#define RF_VEL_WAIT_MS 30u
#endif
#ifndef RF_VEL_EARLY_MS
#define RF_VEL_EARLY_MS 20u
#endif
#ifndef RF_TOP_WAIT_MS
#define RF_TOP_WAIT_MS 4u
#endif
#ifndef RF_AT_MS
#define RF_AT_MS 20u
#endif
static uint8_t rf_tv[RFM_NKEYS];                        /* touch.c's velocity of each key's last press */
static uint32_t rf_tv_t[RFM_NKEYS], rf_tv_ok;           /* when it came; bit k: not used for a note yet */
static uint32_t rf_kprev, rf_kwait, rf_kwait_t[RFM_NKEYS];
static uint8_t rf_at[RFM_NKEYS];                        /* the pressure last sent per key */
static uint32_t rf_at_ms;
static uint32_t rf_vel_n[3];                            /* note-ons: measured (analog row), probed (top row), fixed */

static uint32_t rf_caps_dev(void) { return touch_is_on() ? RFM_CAP_VELOCITY | RFM_CAP_AFTERTOUCH : 0u; }

/* once a millisecond: the keys down (debounced) -> the keys whose note-on may go out (rf_vel[k] set for each) */
static uint32_t rf_keys_step(uint32_t keys, uint32_t now)
{
    touch_ev_t e;
    uint32_t i, b, on = keys & ~rf_kprev;
    while (touch_take(&e))
        if (e.type == TOUCH_PRESS && e.key < RFM_NKEYS) {
            rf_tv[e.key] = e.vel;
            rf_tv_t[e.key] = now;
            rf_tv_ok |= 1u << e.key;
        }
    rf_kwait &= keys;                                   /* let go before its velocity came: nothing to send */
    rf_kwait |= on;
    for (i = 0; i < RFM_NKEYS; i++) {
        uint32_t v = 0, sensed;
        b = 1u << i;
        if (on & b)
            rf_kwait_t[i] = now;
        if (!(rf_kwait & b))
            continue;
        sensed = (uint32_t)touch_sensed(i);
        if (!touch_is_on()) {
            v = RFM_MIDI_KEY_VEL;
        } else if (sensed) {
            if ((rf_tv_ok & b) && (int32_t)(rf_tv_t[i] - rf_kwait_t[i]) >= -(int32_t)RF_VEL_EARLY_MS) {
                v = rf_tv[i];
                rf_vel_n[0]++;
            }
            if ((rf_tv_ok & b) && (v || (on & b)))
                rf_tv_ok &= ~b;                         /* used, or older than this press */
        } else if ((v = touch_vel_contact(i)) != 0) {
            rf_vel_n[1]++;
        }
        if (!v && now - rf_kwait_t[i] >= (sensed ? RF_VEL_WAIT_MS : RF_TOP_WAIT_MS)) {
            v = RFM_MIDI_KEY_VEL;
            rf_vel_n[2]++;
        }
        if (v) {
            rf_vel[i] = (uint8_t)(v > 127u ? 127u : v);
            rf_kwait &= ~b;
        }
    }
    rf_kprev = keys;
    return keys & ~rf_kwait;
}

/* after rfm_app_panel(out, ..): the pressure of the held keys (touch_update keeps it, every 5 ms) */
static void rf_at_step(uint32_t out, uint32_t now)
{
    uint32_t i;
    touch_update();
    if (!touch_is_on() || now - rf_at_ms < RF_AT_MS)
        return;
    rf_at_ms = now;
    for (i = 0; i < RFM_NKEYS; i++) {
        uint32_t p, s = rf_at[i];
        if (!touch_sensed(i) || !((out >> i) & 1u)) {
            rf_at[i] = 0;                               /* (its note-off ends the pressure) */
            continue;
        }
        p = touch_down(i) ? touch_pressure(i) : 0u;
        if (p == s || (p && p != 127u && p + 1u >= s && p <= s + 1u))
            continue;
        rf_at[i] = (uint8_t)p;
        rfm_app_key_pressure(i, p);
    }
}
