#include "library.h"
#include <WiFi.h>
#include <mbedtls/md.h>

volatile bool timerFired = false;
static String rx;

// Wi-Fiに接続する。最大15秒待ち、つながれば true
bool wifiConnect(const char* ssid, const char* pass) {
  WiFi.begin(ssid, pass);
  for (int i = 0; i < 150 && WiFi.status() != WL_CONNECTED; i++) delay(100);
  return WiFi.status() == WL_CONNECTED;
}

// NTPサーバーから現在時刻を取得してESP32の時計を合わせる。最大10秒待ち、成功すれば true
bool syncTime() {
  configTzTime("JST-9", "ntp.nict.jp", "pool.ntp.org");
  struct tm t;
  return getLocalTime(&t, 10000);
}

// 現在時刻を stepSec 秒単位に四捨五入した「番号」を返す（60なら1分ごとに1増える）
// 四捨五入なので、前後 stepSec/2 秒以内のずれは同じ番号になる
uint32_t timeStep(uint32_t stepSec) {
  return (time(nullptr) + stepSec / 2) / stepSec;
}

// 秘密鍵と timeStep() の番号から、TOTP方式で6桁のトークンを作る
// （HMAC-SHA1を計算し、その中の4バイトを取り出して6桁にする）
String totp(const uint8_t* key, size_t keyLen, uint32_t stepSec) {
  uint64_t t = timeStep(stepSec);
  uint8_t msg[8], h[20];
  for (int i = 7; i >= 0; i--) { msg[i] = t & 0xFF; t >>= 8; }
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA1), key, keyLen, msg, 8, h);
  int o = h[19] & 0x0F;
  uint32_t code = ((h[o] & 0x7F) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  char buf[7];
  snprintf(buf, sizeof(buf), "%06lu", (unsigned long)code);
  return buf;
}

// 文字列を1行（末尾に改行付き）USBシリアルへ送る
void sendText(const String& text) { Serial.println(text); }

// USBシリアルから届いた文字をためて、1行そろったら out に入れて true を返す（待たない）
bool receiveText(String& out) {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') { out = rx; rx = ""; return true; }
    if (c != '\r') rx += c;
  }
  return false;
}

// タイマー割り込み。フラグを立てるだけ（重い処理は loop 側で行う）
static void IRAM_ATTR onTimer() { timerFired = true; }

// ハードウェアタイマーを開始し、ms ミリ秒ごとに timerFired を true にする
void startTimer(uint32_t ms) {
  hw_timer_t* t = timerBegin(1000000);   // 1MHz = 1µs単位
  timerAttachInterrupt(t, onTimer);
  timerAlarm(t, ms * 1000ULL, true, 0);  // 自動で繰り返す
}
