#!/usr/bin/env python3
"""
Gold/Silver ratio chart renderer (TradingView-style, two panels).

Reads JSON from stdin, outputs PNG to stdout.

Input JSON schema:
{
  "candles": [{"timestamp": ms, "open": n, "high": n, "low": n, "close": n}, ...],
  "rsi":     [{"timestamp": ms, "value": n | null}, ...],
  "meta": {
    "symbol": str,        # e.g. "GOLDSILVER (GLD/SLV)"
    "timeframe": str,     # e.g. "1h"
    "rsiPeriod": int,
    "liveRsi": float | null,
    "side": str | null    # "short_gold_long_silver" | "long_gold_short_silver" | null
  }
}
"""

import datetime
import io
import json
import sys

from PIL import Image, ImageDraw, ImageFont  # type: ignore[import-not-found]

# ── Palette (matches the operator's wolfe_chart.py) ─────────────────────────
BG        = (18, 18, 24)
PANEL_BG  = (22, 22, 30)
GRID      = (35, 35, 48)
BORDER    = (55, 55, 75)
TEXT      = (200, 200, 220)
TEXT_DIM  = (110, 110, 140)

BULL_BODY = (38, 166, 91)
BEAR_BODY = (239, 83, 80)
WICK      = (120, 120, 140)

RSI_LINE  = (100, 180, 255)
RSI_FILL  = (100, 180, 255)
MID_LINE  = (255, 200, 0)   # RSI 50 — the strategy line
BAND_LINE = (70, 70, 95)    # RSI 30/70

SIDE_COLORS = {
    "short_gold_long_silver": (239, 83, 80),
    "long_gold_short_silver": (38, 166, 91),
}

# ── Layout ───────────────────────────────────────────────────────────────────
W, H    = 1280, 860
PAD_L   = 10
PAD_R   = 96    # price/RSI axis
PAD_T   = 54
PAD_B   = 46

PRICE_H = 470                    # top panel height
GAP     = 14
RSI_H   = H - PAD_T - PAD_B - PRICE_H - GAP

FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD    = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def price_fmt(p):
    if p >= 1000:
        return f"{p:,.2f}"
    if p >= 10:
        return f"{p:.3f}"
    return f"{p:.4f}"


def render(data: dict) -> bytes:
    candles = data["candles"]
    rsi     = data.get("rsi", [])
    meta    = data.get("meta", {})

    n_show = min(90, len(candles))
    candles = candles[-n_show:]
    rsi     = rsi[-n_show:] if rsi else []

    all_prices = []
    for c in candles:
        all_prices += [c["high"], c["low"]]
    p_min = min(all_prices)
    p_max = max(all_prices)
    p_rng = p_max - p_min or 1
    p_min -= p_rng * 0.05
    p_max += p_rng * 0.05
    p_rng = p_max - p_min

    cx0 = PAD_L
    cx1 = W - PAD_R
    pw  = cx1 - cx0
    py0 = PAD_T
    py1 = PAD_T + PRICE_H
    ph  = py1 - py0

    ry0 = py1 + GAP
    ry1 = ry0 + RSI_H

    def x_of(col):
        return cx0 + (col + 0.5) * pw / n_show

    def y_price(p):
        return py1 - (p - p_min) / p_rng * ph

    def y_rsi(v):
        return ry1 - v / 100.0 * RSI_H

    img  = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    font_sm   = load_font(FONT_REGULAR, 11)
    font_md   = load_font(FONT_REGULAR, 13)
    font_bold = load_font(FONT_BOLD, 14)
    font_lg   = load_font(FONT_BOLD, 17)

    # ── Price panel: grid ─────────────────────────────────────────────────────
    for i in range(7):
        gp = p_min + p_rng * i / 6
        gy = y_price(gp)
        draw.line([(cx0, gy), (cx1, gy)], fill=GRID, width=1)
        draw.text((cx1 + 4, gy - 7), price_fmt(gp), fill=TEXT_DIM, font=font_sm)
    draw.rectangle([cx0, py0, cx1, py1], outline=BORDER, width=1)

    # ── Price panel: candles ──────────────────────────────────────────────────
    candle_w = max(2, pw / n_show * 0.62)
    for i, c in enumerate(candles):
        cx = x_of(i)
        o, h_, l_, cl = c["open"], c["high"], c["low"], c["close"]
        bull = cl >= o
        color = BULL_BODY if bull else BEAR_BODY
        draw.line([(cx, y_price(h_)), (cx, y_price(l_))], fill=WICK, width=1)
        y_top = y_price(max(o, cl))
        y_bot = y_price(min(o, cl))
        draw.rectangle(
            [cx - candle_w / 2, y_top, cx + candle_w / 2, max(y_top + 1, y_bot)],
            fill=color,
        )

    # ── Price panel: last-price tag ───────────────────────────────────────────
    last = candles[-1]["close"]
    ly = y_price(last)
    tag_color = BULL_BODY if candles[-1]["close"] >= candles[-1]["open"] else BEAR_BODY
    lbl = price_fmt(last)
    draw.rectangle([cx1 + 1, ly - 9, cx1 + PAD_R - 2, ly + 9], fill=tag_color)
    draw.text((cx1 + 4, ly - 6), lbl, fill=BG, font=font_sm)
    draw.line([(cx0, ly), (cx1, ly)], fill=tag_color, width=1)

    # ── RSI panel ─────────────────────────────────────────────────────────────
    draw.rectangle([cx0, ry0, cx1, ry1], outline=BORDER, width=1)
    for level in (30, 70):
        y = y_rsi(level)
        x = cx0
        on = True
        while x < cx1:                      # dashed band lines
            xe = min(x + 6, cx1)
            if on:
                draw.line([(x, y), (xe, y)], fill=BAND_LINE, width=1)
            x = xe
            on = not on
        draw.text((cx1 + 4, y - 7), str(level), fill=TEXT_DIM, font=font_sm)
    # RSI 50 — solid, the strategy line
    y50 = y_rsi(50)
    draw.line([(cx0, y50), (cx1, y50)], fill=MID_LINE, width=1)
    draw.text((cx1 + 4, y50 - 7), "50", fill=MID_LINE, font=font_sm)
    for level in (0, 100):
        y = y_rsi(level)
        draw.line([(cx0, y), (cx1, y)], fill=GRID, width=1)
        draw.text((cx1 + 4, y - 7), str(level), fill=TEXT_DIM, font=font_sm)

    # RSI line
    pts = []
    for i, r in enumerate(rsi):
        value = r.get("value")
        if value is None:
            continue
        value = float(value)  # defensive: payload values may arrive as strings
        pts.append((x_of(i), y_rsi(max(0.0, min(100.0, value)))))
    if len(pts) >= 2:
        draw.line(pts, fill=RSI_LINE, width=2)
    # RSI area fill (subtle)
    if len(pts) >= 2:
        poly = pts + [(pts[-1][0], ry1), (pts[0][0], ry1)]
        overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        od = ImageDraw.Draw(overlay)
        od.polygon(poly, fill=RSI_FILL + (28,))
        img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(img)

    # Live RSI dot + label
    live_rsi = meta.get("liveRsi")
    if live_rsi is not None and pts:
        lx, lyy = pts[-1]
        draw.ellipse([lx - 5, lyy - 5, lx + 5, lyy + 5], fill=RSI_LINE, outline=BG, width=2)
        live_lbl = f"RSI {live_rsi:.1f}"
        bb = draw.textbbox((0, 0), live_lbl, font=font_bold)
        lw = bb[2] - bb[0]
        ly2 = max(ry0 + 2, min(ry1 - 18, lyy - 24))
        draw.rectangle([lx - lw - 10, ly2, lx - 4, ly2 + 16], fill=(30, 40, 60))
        draw.text((lx - lw - 6, ly2 + 2), live_lbl, fill=RSI_LINE, font=font_sm)

    # ── Time axis ─────────────────────────────────────────────────────────────
    step = max(1, n_show // 8)
    for i in range(0, n_show, step):
        ts = candles[i]["timestamp"]
        hhmm = datetime.datetime.fromtimestamp(
            ts / 1000, datetime.UTC
        ).strftime("%H:%M")
        draw.text((x_of(i) - 14, ry1 + 6), hhmm, fill=TEXT_DIM, font=font_sm)
    draw.text((cx0, ry1 + 22), "time (UTC)", fill=TEXT_DIM, font=font_sm)

    # ── Title ─────────────────────────────────────────────────────────────────
    side = meta.get("side")
    side_txt = ""
    side_color = TEXT
    if side == "short_gold_long_silver":
        side_txt = "  │  SHORT GOLD / LONG SILVER"
        side_color = SIDE_COLORS[side]
    elif side == "long_gold_short_silver":
        side_txt = "  │  LONG GOLD / SHORT SILVER"
        side_color = SIDE_COLORS[side]
    title = f"{meta.get('symbol', 'GOLDSILVER')}  {meta.get('timeframe', '')}"
    draw.text((cx0, 12), title + side_txt, fill=side_color, font=font_lg)
    sub = f"RSI({meta.get('rsiPeriod', 14)}) — TP on return across 50 with profit floor · SL market"
    draw.text((cx0, 36), sub, fill=TEXT_DIM, font=font_md)

    # ── Output PNG to stdout ──────────────────────────────────────────────────
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


if __name__ == "__main__":
    try:
        payload = json.loads(sys.stdin.read())
        sys.stdout.buffer.write(render(payload))
    except Exception as error:  # noqa: BLE001 — renderer must die loudly on stderr
        print(f"metal-ratio-chart render failed: {error}", file=sys.stderr)
        sys.exit(1)
