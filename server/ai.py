"""画像を AI（Replicate の prunaai/flux-kontext-fast）に掛けて、ペンプロッター用の線画にする。

流れ:
1. 受け取った画像を data URI にして、プロンプトと一緒に Replicate へ送る（予測 = prediction を作る）
2. 「Prefer: wait」で完成まで待つ。それでも終わっていなければ、終わるまで数秒おきに確認する
3. 出力された画像の URL から画像をダウンロードして返す

API キーは Cloudflare のシークレット REPLICATE_API_TOKEN（ローカルは .dev.vars）に置く。
"""

import asyncio
import base64
import json
import time

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


class AIError(Exception):
    """AI の処理に失敗したときに投げる。メッセージはそのまま利用者に見せる。"""


async def process_image(data: bytes, content_type: str, api_token: str) -> tuple[bytes, str]:
    """画像を線画に変換して (画像データ, Content-Type) を返す。"""
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

    # 1. 予測を作る。Prefer: wait で、終わるまで（最大60秒）その場で待ってもらう。
    resp = await fetch(
        MODEL_URL,
        method="POST",
        headers={**headers, "Prefer": "wait"},
        body=json.dumps(body),
    )
    prediction = await _read_json(resp)
    if resp.status == 401:
        raise AIError("Replicate の API キーが正しくありません")
    if resp.status >= 400:
        raise AIError(f"Replicate がエラーを返しました（HTTP {resp.status}）: {_detail(prediction)}")

    # 2. まだ終わっていなければ、終わるまで確認を繰り返す。
    deadline = time.time() + TIMEOUT
    while prediction.get("status") in ("starting", "processing"):
        if time.time() > deadline:
            raise AIError("AI の処理が時間内に終わりませんでした")
        await asyncio.sleep(POLL_INTERVAL)
        resp = await fetch(prediction["urls"]["get"], headers=headers)
        prediction = await _read_json(resp)

    if prediction.get("status") != "succeeded":
        raise AIError(f"AI の処理に失敗しました: {prediction.get('error') or prediction.get('status')}")

    # 3. 出力は画像の URL（念のためリストで返ってきた場合にも対応する）。
    output = prediction.get("output")
    if isinstance(output, list):
        output = output[0] if output else None
    if not isinstance(output, str):
        raise AIError("AI から画像が返ってきませんでした")

    img = await fetch(output)
    if img.status >= 400:
        raise AIError(f"出力画像をダウンロードできませんでした（HTTP {img.status}）")
    out_type = img.headers.get("Content-Type") or "image/png"
    return await img.bytes(), out_type


async def _read_json(resp) -> dict:
    try:
        result = await resp.json()
    except Exception:
        return {}
    return result if isinstance(result, dict) else {}


def _detail(prediction: dict) -> str:
    return str(prediction.get("detail") or prediction.get("error") or prediction or "詳細不明")
