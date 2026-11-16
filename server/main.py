"""PlotSender の API。Cloudflare の Python Workers で実行する。

/api/health … サーバーの時刻を返す（動作確認用）
/api/ai     … 画像と TOTP トークンを受け取り、トークンが正しければ AI で線画にした画像を返す
/T/<6桁>    … パンタグラフの画面の QR から来る。トークンを付けてパンタグラフのタブへ移動させる
/api/correction … パンタグラフの補正データ。GET で最新を返す(ESP32 とページが読む)、
                  POST でページが作った表を受け取って保存する(QR のトークンを 1 回使う)
"""

import json
import math
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from ai import AIError, process_image
from auth import QR_VALID_SEC, match_qr_step, verify_totp

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 受け付ける画像は10MBまで

# QR の鍵と、その QR を出す機械(ページのタブ)。どの鍵のトークンかで、開くタブを決める。
# 鍵が登録されていない機械は飛ばす(描馬灯は準備中なので、鍵を登録したら使えるようになる)
QR_MACHINES = [
    ("b", "TOTP_KEY_QR"),          # パンタグラフ(cutting_machine)
    ("a", "TOTP_KEY_QR_BYOMATO"),  # 描馬灯
]


def error(message: str, status: int, **headers) -> Response:
    return Response.json({"error": message}, status=status, headers=headers or None)


CORRECTION_KEY = "correction:latest"


def check_table(t: dict) -> dict:
    """ページから届いた補正データを確かめて、必要な項目だけの dict にする。おかしければ ValueError"""
    def number(v, limit=1000.0):
        v = float(v)
        if not math.isfinite(v) or abs(v) > limit:
            raise ValueError(f"値が範囲外: {v}")
        return v
    nx, ny = int(t["nx"]), int(t["ny"])
    if not (2 <= nx <= 100 and 2 <= ny <= 100):
        raise ValueError("表の大きさ")
    dx, dy = [number(v, 100) for v in t["dx"]], [number(v, 100) for v in t["dy"]]
    if len(dx) != nx * ny or len(dy) != nx * ny:
        raise ValueError("表の数")
    d = t["dir"]
    xy, yx = [number(v, 10) for v in d["xy"]], [number(v, 10) for v in d["yx"]]
    if len(xy) != 3 or len(yx) != 3:
        raise ValueError("向きの係数の数")
    return {
        "nx": nx, "ny": ny, "x0": number(t["x0"]), "y0": number(t["y0"]), "step": number(t["step"]),
        "dx": dx, "dy": dy,
        "dir": {"cx": number(d["cx"]), "sx": number(d["sx"]), "cy": number(d["cy"]), "sy": number(d["sy"]), "xy": xy, "yx": yx},
        "mode": str(t.get("mode", ""))[:20],
    }


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # HTTPリクエストが届くたびに呼ばれる。クエリ文字列を除いたパスで振り分ける。
        path = urlsplit(request.url).path
        if path == "/api/health":
            return await self.health(request)
        if path == "/api/ai":
            return await self.ai(request)
        if path == "/api/correction":
            return await self.correction(request)
        if path[:3] in ("/T/", "/t/"):
            return self.qr_redirect(path[3:])
        return error("Not found", 404)

    def find_qr_machine(self, token):
        """QR のトークンがどの機械の鍵のものかを調べる → (タブ, 番号)。どれでもなければ (None, None)"""
        for mode, key_name in QR_MACHINES:
            key_hex = getattr(self.env, key_name, None)
            if not key_hex:
                continue
            step = match_qr_step(token, key_hex)
            if step is not None:
                return mode, step
        return None, None

    def qr_redirect(self, token):
        # QR の URL は短くするため大文字のパスにしてある。
        # トークンの鍵から機械を決めて、そのタブを開く(ここではまだ使用済みにしない)。
        mode, _ = self.find_qr_machine(token)
        location = f"/?mode={mode}&token={token}" if mode else "/?qr=invalid"
        return Response("", status=302, headers={"Location": location, "Cache-Control": "no-store"})

    async def check_token(self, token, kind):
        """トークンを確認する。正しければ (True, QR の使用済み記録のキー or None)、違えば (False, 理由)。

        kind が "qr" なら QR 用の鍵で照合し、15分以内・未使用なら使用済みにする（使い切り）。
        それ以外は従来どおり Web Serial 用の鍵（1分ごと）で照合する。
        """
        if kind != "qr":
            if verify_totp(token, self.env.TOTP_KEY):
                return True, None
            return False, "トークンが正しくありません"

        used = getattr(self.env, "KV", None)
        if used is None:
            return False, "サーバーに KV が設定されていません"
        mode, step = self.find_qr_machine(token)
        if mode is None:
            return False, "QR のトークンが正しくないか、15分の期限が切れています"
        used_key = f"qr:{mode}:{step}"
        if await used.get(used_key) is not None:
            return False, "この QR はもう使われています。新しい QR を読み取ってください"
        # 先に使用済みにしてから AI を呼ぶ(同時に 2 回送られても 1 回だけにする)。
        # 期限が切れたあとは番号が照合に出てこないので、記録も 15 分ほどで消してよい。
        await used.put(used_key, "1", expirationTtl=QR_VALID_SEC + 60)
        return True, used_key

    async def correction(self, request):
        """GET: 最新の補正データ(なければ 404)。POST: {token, table} を受け取って最新として保存する。"""
        if request.method == "GET":
            store = getattr(self.env, "KV", None)
            text = await store.get(CORRECTION_KEY) if store is not None else None
            if text is None:
                return error("補正データはまだありません", 404, **{"Cache-Control": "no-store"})
            return Response(text, headers={"Content-Type": "application/json", "Cache-Control": "no-store"})
        if request.method != "POST":
            return error("Method not allowed", 405, Allow="GET, POST")

        try:
            body = json.loads(await request.text())
            table = check_table(body["table"])
        except (ValueError, KeyError, TypeError) as e:
            return error(f"補正データの形が正しくありません({e})", 400)
        ok, detail = await self.check_token(str(body.get("token", "")), "qr")
        if not ok:
            return error(detail, 401)
        # いつの補正データかを付けて保存する(ESP32 の Setting タブに出る)。1 つ前のものも残しておく
        table["version"] = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
        text = json.dumps(table, separators=(",", ":"))
        previous = await self.env.KV.get(CORRECTION_KEY)
        if previous is not None:
            await self.env.KV.put(CORRECTION_KEY + ":previous", previous)
        await self.env.KV.put(CORRECTION_KEY, text)
        return Response.json({"ok": True, "version": table["version"]}, headers={"Cache-Control": "no-store"})

    async def health(self, request):
        # 呼び出した時点のUTC時刻を返す。キャッシュせず毎回計算する。
        if request.method != "GET":
            return error("Method not allowed", 405, Allow="GET")
        return Response.json(
            {
                "ok": True,
                "message": "Hello from Python",
                "server_time": datetime.now(timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z"),
            },
            headers={"Cache-Control": "no-store"},
        )

    async def ai(self, request):
        # multipart/form-data で image（画像）と token（6桁）を受け取る。
        if request.method != "POST":
            return error("Method not allowed", 405, Allow="POST")

        form = await request.form_data()
        token = form["token"] if "token" in form else ""
        kind = form["token_kind"] if "token_kind" in form else "serial"
        image = form["image"] if "image" in form else None

        if image is None or isinstance(image, str):
            return error("画像がありません", 400)
        if image.size > MAX_IMAGE_BYTES:
            return error("画像が大きすぎます（10MBまで）", 413)
        if not image.content_type.startswith("image/"):
            return error("画像ファイルではありません", 415)

        # 画像を読む前にトークンを確認する(QR のトークンはここで使用済みになる)。
        t = time.time()
        ok, detail = await self.check_token(token, kind)
        self.auth_ms = round((time.time() - t) * 1000)
        if not ok:
            return error(detail, 401)
        succeeded = False
        try:
            response, succeeded = await self.run_ai(image)
            return response
        finally:
            # AI が失敗したら、QR のトークンをもう一度使えるように戻す(使い切りは成功した 1 回だけ)
            if detail and not succeeded:
                await self.env.KV.delete(detail)

    async def run_ai(self, image):
        """AI で線画にする。(返すレスポンス, 成功したか) を返す。"""
        api_token = getattr(self.env, "REPLICATE_API_TOKEN", None)
        if not api_token:
            return error("サーバーに REPLICATE_API_TOKEN が設定されていません", 500), False

        t = time.time()
        try:
            data, content_type, timings = await process_image(
                await image.bytes(), image.content_type, api_token
            )
        except AIError as e:
            return error(str(e), 502), False
        timings = {"auth": getattr(self, "auth_ms", 0), **timings, "server": round((time.time() - t) * 1000)}
        # かかった時間をヘッダーで返す(ページに表示する。ブラウザの開発者ツールの Server-Timing でも見られる)
        server_timing = ", ".join(f"{k};dur={v}" for k, v in timings.items())
        return Response(
            data,
            headers={
                "Content-Type": content_type,
                "Cache-Control": "no-store",
                "Server-Timing": server_timing,
                "X-AI-Timings": json.dumps(timings),
            },
        ), True
