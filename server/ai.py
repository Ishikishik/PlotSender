"""画像を AI に掛ける処理。今はまだ AI を呼ばず、受け取った画像をそのまま返す。"""


async def process_image(data: bytes, content_type: str) -> tuple[bytes, str]:
    """画像を加工して (画像データ, Content-Type) を返す。

    TODO: ここで AI の API を呼び、ペンプロッター用の画像に変換する。
    """
    return data, content_type
