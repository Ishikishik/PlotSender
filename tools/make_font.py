"""ShujiDB v2 のデータから、PlotSender の文字(public/js/svgtext.js)で使う軽いフォントを作る。

ペンで描くので、中心線(center)だけを使い、太さ(width)は捨てる。座標は 0.1 単位に丸める。
足りない記号(、。ー「」・ など)は、ここで手書きの線を足す。

使い方:
  python3 tools/make_font.py ~/Byomato/test/opencv/ShujiDB/v2/data/klee.json public/fonts/klee.json

出力: {"name", "license", "em": 109, "glyphs": {"字": [[[x0,y0,x1,y1,x2,y2,x3,y3], ...], ...]}}
  glyphs の値は画(1 回ペンを下ろす線)の並び。画は書き順どおり。座標は 109×109、左上が原点、y は下向き
"""

import json
import math
import sys


def line(*pts):
    """折れ線を 3 次ベジェの並び(1 画)にする"""
    segs = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        segs.append([x0, y0, x0 + (x1 - x0) / 3, y0 + (y1 - y0) / 3,
                     x0 + (x1 - x0) * 2 / 3, y0 + (y1 - y0) * 2 / 3, x1, y1])
    return segs


def circle(cx, cy, r):
    """円を 4 つの 3 次ベジェ(1 画)にする"""
    k = 0.5523 * r
    pts = [(cx + r, cy), (cx, cy + r), (cx - r, cy), (cx, cy - r), (cx + r, cy)]
    ctrl = [((cx + r, cy + k), (cx + k, cy + r)), ((cx - k, cy + r), (cx - r, cy + k)),
            ((cx - r, cy - k), (cx - k, cy - r)), ((cx + k, cy - r), (cx + r, cy - k))]
    return [[pts[i][0], pts[i][1], *ctrl[i][0], *ctrl[i][1], pts[i + 1][0], pts[i + 1][1]] for i in range(4)]


# 手書きで足す記号(横書きの位置。縦書きの位置は svgtext.js で直す)
EXTRA = {
    "、": [[[16, 80, 20, 84, 25, 90, 28, 97]]],
    "。": [circle(22, 88, 8)],
    "ー": [line((12, 54), (97, 54))],
    "－": [line((12, 54), (97, 54))],
    "-": [line((30, 56), (79, 56))],
    "・": [circle(54, 54, 3)],
    "「": [line((62, 14), (36, 14), (36, 62))],
    "」": [line((73, 48), (73, 96), (47, 96))],
    "（": [[[68, 8, 40, 30, 40, 80, 68, 102]]],
    "）": [[[41, 8, 69, 30, 69, 80, 41, 102]]],
    "(": [[[68, 8, 40, 30, 40, 80, 68, 102]]],
    ")": [[[41, 8, 69, 30, 69, 80, 41, 102]]],
    "：": [circle(54, 38, 3), circle(54, 74, 3)],
    ":": [circle(54, 38, 3), circle(54, 74, 3)],
    "/": [line((80, 10), (29, 99))],
    "／": [line((80, 10), (29, 99))],
    ".": [circle(22, 92, 3)],
    "，": [[[20, 88, 22, 92, 22, 96, 18, 101]]],
    ",": [[[20, 88, 22, 92, 22, 96, 18, 101]]],
    "！": [line((54, 12), (54, 74)), circle(54, 92, 3)],
    "!": [line((54, 12), (54, 74)), circle(54, 92, 3)],
    "＝": [line((16, 42), (93, 42)), line((16, 68), (93, 68))],
    "=": [line((16, 42), (93, 42)), line((16, 68), (93, 68))],
    "〒": [line((14, 16), (95, 16)), line((14, 40), (95, 40)), line((54, 40), (54, 98))],
}


def main(src, dst):
    d = json.load(open(src, encoding="utf-8"))
    rnd = lambda seg: [round(v, 1) for v in seg]
    glyphs = {ch: [[rnd(seg) for seg in s["center"]] for s in g["strokes"]] for ch, g in d["glyphs"].items()}
    added = []
    for ch, strokes in EXTRA.items():
        if ch not in glyphs:
            glyphs[ch] = [[rnd(seg) for seg in s] for s in strokes]
            added.append(ch)
    out = {
        "name": d.get("font", {}).get("label", ""),
        "license": "中心線は KanjiVG (CC BY-SA 3.0, Ulrich Apel) をもとに ShujiDB で作成",
        "em": 109,
        "glyphs": glyphs,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(glyphs)} glyphs ({len(added)} added: {''.join(added)}) -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
