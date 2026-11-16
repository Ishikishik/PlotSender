"""PlotSender の API。Cloudflare の Python Workers で実行する。

/api/health … サーバーの時刻を返す（動作確認用）
/api/ai     … 画像と TOTP トークンを受け取り、トークンが正しければ AI で線画にした画像を返す
/T/<6桁>    … パンタグラフの画面の QR から来る。トークンを付けてパンタグラフのタブへ移動させる
"""

from datetime import datetime, timezone
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from ai import AIError, process_image
from auth import QR_VALID_SEC, match_qr_step, verify_totp

MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 受け付ける画像は10MBまで


def error(message: str, status: int, **headers) -> Response:
    return Response.json({"error": message}, status=status, headers=headers or None)


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # HTTPリクエストが届くたびに呼ばれる。クエリ文字列を除いたパスで振り分ける。
        path = urlsplit(request.url).path
        if path == "/api/health":
            return await self.health(request)
        if path == "/api/ai":
            return await self.ai(request)
        if path[:3] in ("/T/", "/t/"):
            return self.qr_redirect(path[3:])
        return error("Not found", 404)

    def qr_redirect(self, token):
        # QR の URL は短くするため大文字のパスにしてある。トークンをクエリにしてトップページへ送る。
        if not (len(token) == 6 and token.isdigit()):
            return error("Not found", 404)
        return Response(
            "",
            status=302,
            headers={"Location": f"/?mode=b&token={token}", "Cache-Control": "no-store"},
        )

    async def check_token(self, token, kind):
        """トークンを確認する。正しければ (True, QR の使用済み記録のキー or None)、違えば (False, 理由)。

        kind が "qr" なら QR 用の鍵で照合し、15分以内・未使用なら使用済みにする（使い切り）。
        それ以外は従来どおり Web Serial 用の鍵（1分ごと）で照合する。
        """
        if kind != "qr":
            if verify_totp(token, self.env.TOTP_KEY):
                return True, None
            return False, "トークンが正しくありません"

        key_hex = getattr(self.env, "TOTP_KEY_QR", None)
        used = getattr(self.env, "USED_QR_TOKENS", None)
        if not key_hex or used is None:
            return False, "サーバーに TOTP_KEY_QR か USED_QR_TOKENS(KV)が設定されていません"
        step = match_qr_step(token, key_hex)
        if step is None:
            return False, "QR のトークンが正しくないか、15分の期限が切れています"
        used_key = f"qr:{step}"
        if await used.get(used_key) is not None:
            return False, "この QR はもう使われています。新しい QR を読み取ってください"
        # 先に使用済みにしてから AI を呼ぶ(同時に 2 回送られても 1 回だけにする)。
        # 期限が切れたあとは番号が照合に出てこないので、記録も 15 分ほどで消してよい。
        await used.put(used_key, "1", expirationTtl=QR_VALID_SEC + 60)
        return True, used_key

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
        ok, detail = await self.check_token(token, kind)
        if not ok:
            return error(detail, 401)
        succeeded = False
        try:
            response, succeeded = await self.run_ai(image)
            return response
        finally:
            # AI が失敗したら、QR のトークンをもう一度使えるように戻す(使い切りは成功した 1 回だけ)
            if detail and not succeeded:
                await self.env.USED_QR_TOKENS.delete(detail)

    async def run_ai(self, image):
        """AI で線画にする。(返すレスポンス, 成功したか) を返す。"""
        api_token = getattr(self.env, "REPLICATE_API_TOKEN", None)
        if not api_token:
            return error("サーバーに REPLICATE_API_TOKEN が設定されていません", 500), False

        try:
            data, content_type = await process_image(
                await image.bytes(), image.content_type, api_token
            )
        except AIError as e:
            return error(str(e), 502), False
        return Response(data, headers={"Content-Type": content_type, "Cache-Control": "no-store"}), True
