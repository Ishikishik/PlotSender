// FQBN: esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,UploadMode=default,FlashSize=16M,PSRAM=opi
// 毎分0秒に TOTP トークンを Web Serial へ送る
#include "library.h"
#include "secret.h"

void setup() {
  Serial.begin(115200);
  delay(1500);
  sendText(wifiConnect(WIFI_SSID, WIFI_PASS) ? "wifi ok" : "wifi failed");
  sendText(syncTime() ? "time ok" : "time failed");

  struct tm now;                       // 毎分0秒まで待ってからタイマー開始
  getLocalTime(&now);
  delay((60 - now.tm_sec) * 1000);
  startTimer(60000);
}

void loop() {
  String msg;
  if (receiveText(msg)) {
    if (msg == "TOTP") sendText("TOTP " + totp(TOTP_KEY, TOTP_KEY_LEN, 60));  // 要求されたら今の分のトークンを返す
    else sendText("echo: " + msg);
  }
  if (timerFired) {
    timerFired = false;
    sendText("TOTP " + totp(TOTP_KEY, TOTP_KEY_LEN, 60));
  }
}
