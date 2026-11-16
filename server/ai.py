"""画像を AI（Replicate の prunaai/flux-kontext-fast）に掛けて、ペンプロッター用の線画にする。

流れ:
1. 受け取った画像を data URI にして、プロンプトと一緒に Replicate へ送る（予測 = prediction を作る）
2. 「Prefer: wait」で完成まで待つ。それでも終わっていなければ、終わるまで数秒おきに確認する
3. 出力された画像の URL から画像をダウンロードして返す

かかった時間を段階ごとに測って返す(main.py がレスポンスのヘッダーに入れ、ページに表示する)。

API キーは Cloudflare のシークレット REPLICATE_API_TOKEN（ローカルは .dev.vars）に置く。
"""

import asyncio
import base64
import json
import time
from datetime import datetime

from workers import fetch

MODEL_URL = "https://api.replicate.com/v1/models/prunaai/flux-kontext-fast/predictions"

PROMPT = (
    "Simple black brush line art for a pen plotter. "
    "Uniform black ink, varying line width, smooth continuous strokes. "
    "Main contours only, minimal detail. "
    "White background and unfilled interiors. "
    "No color, shading, hatching, or dry-brush texture."
)

POLL_INTERVAL = 1.5  # 完成を確認する間隔（秒）
TIMEOUT = 90         # これ以上かかったら諦める（秒）

# 速さと仕上がりの調整用。None ならモデルの初期値(steps 30、size 1024)を使う
NUM_INFERENCE_STEPS = 20     # 初期値 30。少ないほど速い
IMAGE_SIZE = 768             # 初期値 1024(出力の長辺)。小さいほど速い
SPEED_MODE = None            # 例: "Extra Juiced 🔥 (more speed)"(モデルの選択肢と同じ文字列)


class AIError(Exception):
    """AI の処理に失敗したときに投げる。メッセージはそのまま利用者に見せる。"""


def _ms(start: float) -> int:
    return round((time.time() - start) * 1000)


def _parse_time(text) -> float | None:
    try:
        return datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


async def process_image(data: bytes, content_type: str, api_token: str) -> tuple[bytes, str, dict]:
    """画像を線画に変換して (画像データ, Content-Type, かかった時間 [ms]) を返す。

    かかった時間:
      create   … 予測を作る POST(Prefer: wait で完成まで待つことが多い)
      poll     … まだ終わっていなかったときに確認を繰り返した時間
      download … 出力画像のダウンロード
      queue    … Replicate の中で計算が始まるまでの待ち(起動待ちを含む)
      predict  … Replicate の中で AI が計算していた時間
    """
    timings = {}
    headers = {
        "Authorization": f"Bearer {api_token}",
        "Content-Type": "application/json",
    }
    data_uri = f"data:{content_type};base64,{base64.b64encode(data).decode('ascii')}"
    body = {
        "input": {
            "prompt": PROMPT,
            "img_cond_path": data_uri,   # 入力画像。出力の縦横比もこれに合わせる
            "output_format": "png",      # 線画なので JPEG のにじみが出ない PNG にする
        }
    }
    if NUM_INFERENCE_STEPS is not None:
        body["input"]["num_inference_steps"] = NUM_INFERENCE_STEPS
    if IMAGE_SIZE is not None:
        body["input"]["image_size"] = IMAGE_SIZE
    if SPEED_MODE is not None:
        body["input"]["speed_mode"] = SPEED_MODE

    # 1. 予測を作る。Prefer: wait で、終わるまで（最大60秒）その場で待ってもらう。
    t = time.time()
    resp = await fetch(
        MODEL_URL,
        method="POST",
        headers={**headers, "Prefer": "wait"},
        body=json.dumps(body),
    )
    prediction = await _read_json(resp)
    timings["create"] = _ms(t)
    if resp.status == 401:
        raise AIError("Replicate の API キーが正しくありません")
    if resp.status >= 400:
        raise AIError(f"Replicate がエラーを返しました（HTTP {resp.status}）: {_detail(prediction)}")

    # 2. まだ終わっていなければ、終わるまで確認を繰り返す。
    t = time.time()
    deadline = t + TIMEOUT
    while prediction.get("status") in ("starting", "processing"):
        if time.time() > deadline:
            raise AIError("AI の処理が時間内に終わりませんでした")
        await asyncio.sleep(POLL_INTERVAL)
        resp = await fetch(prediction["urls"]["get"], headers=headers)
        prediction = await _read_json(resp)
    timings["poll"] = _ms(t)

    # Replicate の中での時間(計算の時間と、始まるまでの待ち)
    metrics = prediction.get("metrics") or {}
    if isinstance(metrics.get("predict_time"), (int, float)):
        timings["predict"] = round(metrics["predict_time"] * 1000)
    created, started = _parse_time(prediction.get("created_at")), _parse_time(prediction.get("started_at"))
    if created and started:
        timings["queue"] = round((started - created) * 1000)

    if prediction.get("status") != "succeeded":
        raise AIError(f"AI の処理に失敗しました: {prediction.get('error') or prediction.get('status')}")

    # 3. 出力は画像の URL（念のためリストで返ってきた場合にも対応する）。
    output = prediction.get("output")
    if isinstance(output, list):
        output = output[0] if output else None
    if not isinstance(output, str):
        raise AIError("AI から画像が返ってきませんでした")

    t = time.time()
    img = await fetch(output)
    if img.status >= 400:
        raise AIError(f"出力画像をダウンロードできませんでした（HTTP {img.status}）")
    out_type = img.headers.get("Content-Type") or "image/png"
    out = await img.bytes()
    timings["download"] = _ms(t)
    print("ai timings [ms]:", timings)   # wrangler tail やダッシュボードのログで見られる
    return out, out_type, timings


async def _read_json(resp) -> dict:
    try:
        result = await resp.json()
    except Exception:
        return {}
    return result if isinstance(result, dict) else {}


def _detail(prediction: dict) -> str:
    return str(prediction.get("detail") or prediction.get("error") or prediction or "詳細不明")
