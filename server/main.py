"""PlotSenderの動作確認API。CloudflareのPython Workersで実行する。"""

from datetime import datetime, timezone
from urllib.parse import urlsplit

from workers import Response, WorkerEntrypoint


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # HTTPリクエストが届くたびに呼ばれる。クエリ文字列を除いたパスで判定する。
        path = urlsplit(request.url).path

        if path != "/api/health":
            return Response.json({"error": "Not found"}, status=404)

        # 時刻を取得するAPIなのでGETだけ受け付ける。
        if request.method != "GET":
            return Response.json(
                {"error": "Method not allowed"},
                status=405,
                headers={"Allow": "GET"},
            )

        # 呼び出した時点のUTC時刻を返す。キャッシュせず毎回計算する。
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
