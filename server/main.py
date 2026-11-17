"""PlotSender の API。Cloudflare の Python Workers で実行する。

/api/health … サーバーの時刻を返す（動作確認用）
/api/ai     … 画像と TOTP トークンを受け取り、トークンが正しければ AI で線画にした画像を返す
/T/<6桁>    … パンタグラフの画面の QR から来る。トークンを付けてパンタグラフのタブへ移動させる
/api/correction … パンタグラフの補正データ。GET で最新を返す(ESP32 とページが読む)、
                  POST でページが作った表を受け取って保存する(QR のトークンを 1 回使う)
/api/plots       … ページが作った絵(.bez)を、パンタグラフが取りに来るまで預かる
    POST /api/plots                 ページから {token, token_kind, data(base64)}。番号(UUID)を付けて預かる
    GET  /api/plots/pending?token=  機械から(機械の鍵の TOTP)。まだ取りに来ていない絵の一覧
    GET  /api/plots/file?id=&token= 機械から。絵のデータ(base64 の文字列)
    POST /api/plots/ack?id=&token=  機械から。SD に保存し終わった絵を消す
"""

import base64
import json
import math
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

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
CORRECTION_ID_PREFIX = "correction:id:"     # 番号ごとの補正データ(機械が使っている表を「更新」の元にするため)
CORRECTION_COUNTER = "correction:counter"
CORRECTION_KEEP_SEC = 90 * 24 * 3600         # 番号ごとの補正データを残す期間


PLOTS_PENDING_KEY = "plots:pending"        # まだ機械が取りに来ていない絵の一覧(JSON の配列)
PLOT_PREFIX = "plot:"                      # 絵のデータ(base64)。番号は UUID
PLOT_KEEP_SEC = 30 * 24 * 3600             # 取りに来なかった絵を預かる期間
PLOT_MAX_BYTES = 1500 * 1024               # 1 枚の絵の大きさの上限
PLOT_STALE_SEC = 180                       # 一覧にあるのにデータがない絵を、一覧から消すまでの時間
# KV は書いた内容がほかの場所から見えるまで最大 60 秒ほどかかる(結果整合)。一覧を読んで書き戻すので、
# 受け取り済み(データを消した)の番号が一覧に戻ることがある。そういう番号は機械が取りに来たときに一覧から消す


def check_plot(data_b64: str):
    """ページから届いた絵(.bez の BEZ2 形式、base64)を確かめる → (中身, 番号, 名前, 星)。おかしければ ValueError
    形式は firm/src/jobs/SdPlot.h と public/js/sdsend.js の先頭に書いてある:
      "BEZ2", 線の数 u16, 印 u8(1 = 星), 名前のバイト数 u8, 作った時刻 u32, UUID 16 バイト, 名前(UTF-8), 線…"""
    raw = base64.b64decode(data_b64, validate=True)
    if len(raw) > PLOT_MAX_BYTES:
        raise ValueError("絵が大きすぎる")
    if len(raw) < 28 or raw[:4] != b"BEZ2" or len(raw) < 28 + raw[7]:
        raise ValueError("形式が違う")
    plot_id = raw[12:28].hex()
    if plot_id == "0" * 32:
        raise ValueError("番号がない")
    name = raw[28:28 + raw[7]].decode("utf-8")
    return raw, plot_id, name, bool(raw[6] & 1)


def base36(n: int) -> str:
    digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


# 機構の寸法の項目と、受け付ける値の上限(長さ [mm]、角度 [度]、平行移動 [mm])。firm/src/motion/Geometry.h と同じ並び
GEOM_LIMITS = {"d": 300.0, "l1a": 300.0, "l1b": 300.0, "l2a": 300.0, "l2b": 300.0, "e": 300.0,
               "offA": 30.0, "offB": 30.0, "tx": 50.0, "ty": 50.0, "rot": 20.0}


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
    out = {
        "nx": nx, "ny": ny, "x0": number(t["x0"]), "y0": number(t["y0"]), "step": number(t["step"]),
        "dx": dx, "dy": dy,
        "dir": {"cx": number(d["cx"]), "sx": number(d["sx"]), "cy": number(d["cy"]), "sy": number(d["sy"]), "xy": xy, "yx": yx},
        "mode": str(t.get("mode", ""))[:20],
    }
    # 機構の寸法(写真から逆算したもの)。無いときは、機械はファームの設計値を使う
    if t.get("geom") is not None:
        g = t["geom"]
        out["geom"] = {k: number(g[k], limit) for k, limit in GEOM_LIMITS.items()}
        for k in ("d", "l1a", "l1b", "l2a", "l2b", "e"):
            if out["geom"][k] <= 0:
                raise ValueError(f"長さが 0 以下: {k}")
    # 線の波(モーターの角度のむら)の係数。無いときは、機械はファームの値を使う
    if t.get("wave") is not None:
        w = t["wave"]
        h = [number(v, 16) for v in w["h"]]
        if not (1 <= len(h) <= 6) or any(v <= 0 for v in h):
            raise ValueError("波の成分の数か周波数")
        wave = {"h": h}
        for axis in ("a", "b"):
            wave[axis] = {k: [number(v, 0.5) for v in w[axis][k]] for k in ("cos", "sin")}
            if any(len(wave[axis][k]) != len(h) for k in ("cos", "sin")):
                raise ValueError("波の係数の数")
        out["wave"] = wave
    return out


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
        if path.startswith("/api/plots"):
            return await self.plots(request, path[len("/api/plots"):])
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

    def qr_redirect(self, rest):
        # QR の URL は短くするため大文字のパスにしてある: /T/<トークン>/<機械が使っている補正データの番号>
        # トークンの鍵から機械を決めて、そのタブを開く(ここではまだ使用済みにしない)。
        token, _, base = rest.partition("/")
        mode, _ = self.find_qr_machine(token)
        location = f"/?mode={mode}&token={token}" if mode else "/?qr=invalid"
        if mode and base.isalnum() and len(base) <= 8:
            location += f"&base={base}"
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

    async def plots(self, request, sub):
        """絵を預かって、機械に渡す(ファイルの先頭のコメントを参照)"""
        store = getattr(self.env, "KV", None)
        if store is None:
            return error("サーバーに KV が設定されていません", 500)
        nocache = {"Cache-Control": "no-store"}
        query = parse_qs(urlsplit(request.url).query)

        async def pending():
            text = await store.get(PLOTS_PENDING_KEY)
            return json.loads(text) if text else []

        if sub == "" and request.method == "POST":
            # ページから。QR のトークンなら、AI 生成とは別に「保存 1 回」として使う
            try:
                body = json.loads(await request.text())
                raw, plot_id, name, starred = check_plot(str(body["data"]))
            except (ValueError, KeyError, TypeError) as e:
                return error(f"絵のデータが正しくありません({e})", 400)
            token, kind = str(body.get("token", "")), str(body.get("token_kind", "serial"))
            if kind == "qr":
                mode, step = self.find_qr_machine(token)
                if mode != "b":
                    return error("QR のトークンが正しくないか、15分の期限が切れています", 401)
                used_key = f"qrsave:{mode}:{step}"
                if await store.get(used_key) is not None:
                    return error("この QR ではもう保存しました。新しい QR を読み取ってください", 401)
                await store.put(used_key, "1", expirationTtl=QR_VALID_SEC + 60)
            elif not verify_totp(token, self.env.TOTP_KEY):
                return error("トークンが正しくありません", 401)
            # 番号はページが付けた UUID(機械はこれをファイル名にする)。同じ番号を 2 回は受け取らない
            if await store.get(PLOT_PREFIX + plot_id) is not None:
                return error("同じ番号の絵がもう届いています", 409)
            await store.put(PLOT_PREFIX + plot_id, base64.b64encode(raw).decode(), expirationTtl=PLOT_KEEP_SEC)
            items = await pending()
            items.append({"id": plot_id, "size": len(raw), "name": name,
                          "starred": starred, "at": int(time.time())})
            await store.put(PLOTS_PENDING_KEY, json.dumps(items, ensure_ascii=False))
            return Response.json({"ok": True, "id": plot_id, "waiting": len(items)}, headers=nocache)

        # ここから下は機械から(機械の鍵の TOTP。60 秒ごとに変わる)
        if not verify_totp(query.get("token", [""])[0], self.env.TOTP_KEY):
            return error("トークンが正しくありません", 401, **nocache)
        plot_id = query.get("id", [""])[0]
        if sub == "/pending" and request.method == "GET":
            # 機械は名前などを .bez の中から読むので、番号と大きさだけを渡す(ESP32 で読みやすいように)
            items = await pending()
            return Response.json({"plots": [{"id": i["id"], "size": i["size"]} for i in items]}, headers=nocache)
        if not (len(plot_id) == 32 and all(c in "0123456789abcdef" for c in plot_id)):
            return error("番号が正しくありません", 400, **nocache)
        if sub == "/file" and request.method == "GET":
            text = await store.get(PLOT_PREFIX + plot_id)
            if text is None:
                # 送った直後でまだ見えていないだけなら 404(機械はあとでやり直す)。
                # 古いものは受け取り済みか期限切れなので、一覧から消して 410(機械は飛ばす)
                items = await pending()
                item = next((i for i in items if i["id"] == plot_id), None)
                if item is not None and time.time() - item.get("at", 0) < PLOT_STALE_SEC:
                    return error("その絵はまだ届いていません", 404, **nocache)
                if item is not None:
                    await store.put(PLOTS_PENDING_KEY, json.dumps([i for i in items if i["id"] != plot_id], ensure_ascii=False))
                return error("その絵はもうありません", 410, **nocache)
            return Response(text, headers={"Content-Type": "text/plain", **nocache})
        if sub == "/ack" and request.method == "POST":
            items = [i for i in await pending() if i["id"] != plot_id]
            await store.put(PLOTS_PENDING_KEY, json.dumps(items, ensure_ascii=False))
            await store.delete(PLOT_PREFIX + plot_id)
            return Response.json({"ok": True, "waiting": len(items)}, headers=nocache)
        return error("Not found", 404)

    async def correction(self, request):
        """GET: 最新の補正データ(なければ 404)。POST: {token, table} を受け取って最新として保存する。"""
        if request.method == "GET":
            # ?id=番号 ならその番号の補正データ、なければ最新
            store = getattr(self.env, "KV", None)
            want = parse_qs(urlsplit(request.url).query).get("id", [""])[0]
            key = CORRECTION_ID_PREFIX + want if want.isalnum() else CORRECTION_KEY
            text = await store.get(key) if store is not None else None
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
        # いつの補正データかと番号を付けて保存する(ESP32 の Setting タブと QR に出る)
        table["version"] = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d %H:%M")
        count = int(await self.env.KV.get(CORRECTION_COUNTER) or 0) + 1
        await self.env.KV.put(CORRECTION_COUNTER, str(count))
        table["id"] = base36(count)
        table["base"] = str(body.get("base", ""))[:8]   # 更新のときに元にした番号(記録用)
        text = json.dumps(table, separators=(",", ":"))
        await self.env.KV.put(CORRECTION_ID_PREFIX + table["id"], text, expirationTtl=CORRECTION_KEEP_SEC)
        await self.env.KV.put(CORRECTION_KEY, text)
        return Response.json({"ok": True, "version": table["version"], "id": table["id"]},
                             headers={"Cache-Control": "no-store"})

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
        mode = form["mode"] if "mode" in form else "moderate"   # detailed: 細かく、moderate: ほどほど(ai.py の PROMPTS)
        if mode not in ("detailed", "moderate"):
            mode = "moderate"

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
            response, succeeded = await self.run_ai(image, mode)
            return response
        finally:
            # AI が失敗したら、QR のトークンをもう一度使えるように戻す(使い切りは成功した 1 回だけ)
            if detail and not succeeded:
                await self.env.KV.delete(detail)

    async def run_ai(self, image, mode="moderate"):
        """AI で線画にする。(返すレスポンス, 成功したか) を返す。"""
        api_token = getattr(self.env, "REPLICATE_API_TOKEN", None)
        if not api_token:
            return error("サーバーに REPLICATE_API_TOKEN が設定されていません", 500), False

        t = time.time()
        try:
            data, content_type, timings = await process_image(
                await image.bytes(), image.content_type, api_token, mode
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
