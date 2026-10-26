// serial.js  —  Web Serial 送受信ユーティリティ（1行 = 1メッセージ, 改行 '\n' 区切り）
// 使い方:
//   await serialConnect(115200);          // ポート選択ダイアログ → 接続
//   onSerialReceive(line => { ... });     // 1行受信するごとに呼ばれる
//   await serialSend("hello");            // 末尾に '\n' を付けて送信
//   await serialDisconnect();             // 切断
//   serialIsConnected();                  // 接続中なら true

let _port = null;
let _reader = null;
let _keepReading = false;
let _readLoopPromise = null;
let _rxCallback = null;
const _encoder = new TextEncoder();

function serialIsSupported() {
  return "serial" in navigator;
}

function serialIsConnected() {
  return _port !== null;
}

// 受信コールバック登録（1行ごと、改行は除去済み）
function onSerialReceive(callback) {
  _rxCallback = callback;
}

async function serialConnect(baudRate = 115200) {
  if (!serialIsSupported()) throw new Error("このブラウザはWeb Serial非対応です（Chrome/Edgeを使ってください）");
  if (_port) return;
  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });
  _port = port;
  _keepReading = true;
  _readLoopPromise = _readLoop();
}

async function serialDisconnect() {
  if (!_port) return;
  _keepReading = false;
  if (_reader) {
    try { await _reader.cancel(); } catch (e) {}
  }
  if (_readLoopPromise) await _readLoopPromise;
  try { await _port.close(); } catch (e) {}
  _port = null;
}

// 文字列を送信（末尾に改行を付ける）
async function serialSend(text) {
  if (!_port || !_port.writable) throw new Error("未接続です");
  const writer = _port.writable.getWriter();
  try {
    await writer.write(_encoder.encode(text + "\n"));
  } finally {
    writer.releaseLock();
  }
}

async function _readLoop() {
  const decoder = new TextDecoder();
  let buffer = "";
  while (_port && _port.readable && _keepReading) {
    _reader = _port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await _reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (_rxCallback) _rxCallback(line);
        }
      }
    } catch (e) {
      console.error("serial read error:", e);
      break;
    } finally {
      _reader.releaseLock();
      _reader = null;
    }
  }
}
