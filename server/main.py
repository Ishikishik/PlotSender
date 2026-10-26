"""PlotSender の API。Cloudflare の Python Workers で実行する。

/api/health … サーバーの時刻を返す（動作確認用）
/api/ai     … 画像と TOTP トークンを受け取り、トークンが正しければ AI で線画にした画像を返す
"""

from datetime import datetime, timezone
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint

from ai import AIError, process_image
from auth import verify_totp

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
        return error("Not found", 404)

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
        image = form["image"] if "image" in form else None

        # 先にトークンを確認し、間違っていれば画像は読まずに断る。
        if not verify_totp(token, self.env.TOTP_KEY):
            return error("トークンが正しくありません", 401)

        if image is None or isinstance(image, str):
            return error("画像がありません", 400)
        if image.size > MAX_IMAGE_BYTES:
            return error("画像が大きすぎます（10MBまで）", 413)
        if not image.content_type.startswith("image/"):
            return error("画像ファイルではありません", 415)

        api_token = getattr(self.env, "REPLICATE_API_TOKEN", None)
        if not api_token:
            return error("サーバーに REPLICATE_API_TOKEN が設定されていません", 500)

        try:
            data, content_type = await process_image(
                await image.bytes(), image.content_type, api_token
            )
        except AIError as e:
            return error(str(e), 502)
        return Response(data, headers={"Content-Type": content_type, "Cache-Control": "no-store"})
