// =====================================================
//  HelmLock Locker - ESP32 firmware (with WiFi + server)
//  Your original code (QR scanner, LEDs, buzzer, servo lock, LCD,
//  Allan P5 coin slot, foil door sensor), plus:
//    - every QR is checked by the HelmLock server
//    - the server says how much to pay (including the late fee)
//    - the server is only told "used" AFTER the door really opened
//    - LEDs follow the server (green free / yellow reserved / red helmet inside)
//
//  NOT TESTED ON YOUR CABINET. It was written without your hardware.
//  Test with the servo only first, and watch the Serial Monitor (115200).
//
//  Libraries to install (Arduino IDE > Library Manager):
//    ArduinoJson (Benoit Blanchon), version 7
//    plus the ones you already use: LiquidCrystal I2C, ESP32Servo
// =====================================================

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>
#include <ESP32Servo.h>
#include <Preferences.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "soc/gpio_reg.h"

// ================== CHANGE THESE 4 THINGS ==================
const char* WIFI_SSID  = "YOUR_WIFI_NAME";                   // 2.4 GHz only (ESP32 can't use 5 GHz)
const char* WIFI_PASS  = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "https://YOUR-APP.onrender.com";    // no slash at the end. Same as API_URL in the app
const char* LOCKER_KEY = "PUT-THE-SAME-LOCKER_KEY-AS-RENDER";
// ===========================================================

// ---------- Locker settings ----------
const char* LOCKER_NUMBER = "01";

// ---------- Pins (from the HelmLock Wiring Guide) ----------
#define GREEN_LED    25
#define YELLOW_LED   26
#define RED_LED      33
#define BUZZER       32
#define SERVO_PIN    13      // servo orange wire
#define COIN_PIN     27      // coin slot white (COIN) wire
#define DOOR_PIN     14      // foil pad 1 (foil pad 2 -> GND)
#define SCANNER_RX   16      // RX2 <- scanner blue wire (TX)
#define SCANNER_TX   17      // TX2 (not used yet)
#define SCANNER_BAUD 115200
#define LCD_SDA      21
#define LCD_SCL      22

// ---------- Prices (the server decides; these are only shown before the first answer) ----------
#define COIN_VALUE   5       // one Allan coin = P5
#define DROP_OFF_FEE 5

// ---------- Coin check ----------
#define COIN_MIN_MS  3       // shorter than this = electrical noise, ignored
#define COIN_MAX_MS  150     // longer than this = not a falling coin, rejected
#define CREDIT_TIMEOUT_SECONDS 120   // unused credit expires after 2 minutes

// ---------- Lock settings ----------
#define LOCK_ANGLE    0
#define OPEN_ANGLE    90
#define SERVO_STEP_MS 10

// ---------- Door settings ----------
#define OPEN_WAIT_SECONDS    20
#define CLOSE_REMIND_SECONDS 30

// ---------- Server settings ----------
#define SCAN_TIMEOUT_MS       25000    // a sleeping free server needs up to ~1 minute to wake: keep the host awake with UptimeRobot
#define HEARTBEAT_EVERY_MS    30000    // ask the server for the locker status every 30 s
#define HEARTBEAT_TIMEOUT_MS  6000
#define COMMIT_RETRY_EVERY_MS 10000

// ---------- Locker status (follows the server) ----------
enum LockerStatus { LOCKER_AVAILABLE, LOCKER_RESERVED, LOCKER_OCCUPIED };
LockerStatus lockerStatus = LOCKER_AVAILABLE;

HardwareSerial Scanner(2);
LiquidCrystal_I2C* lcd = nullptr;
Servo lockServo;
Preferences memory;
int servoAngle = LOCK_ANGLE;

String scanBuffer = "";
unsigned long lastSaveMs = 0;

// What the next person must pay (the server tells us)
int serverDue = DROP_OFF_FEE;
unsigned long lastHeartbeatMs = 0;

// A scan the server hasn't been told about yet (door opened but the network failed)
String pendingToken = "";
int pendingCoins = 0;
unsigned long lastCommitTryMs = 0;

// ---------- Coins ----------
volatile int idleLevel = 1;
volatile int coinPulses = 0;
volatile int rejectedPulses = 0;
volatile unsigned long blockStartUs = 0;
volatile unsigned long lastWidthMs = 0;
volatile unsigned long lastCoinMs = 0;
int credit = 0;
unsigned long lastActivityMs = 0;

void IRAM_ATTR onCoinChange() {
  int level = (REG_READ(GPIO_IN_REG) >> COIN_PIN) & 1;
  bool blocked = (level != idleLevel);
  unsigned long nowUs = micros();

  if (blocked) {
    blockStartUs = nowUs;
  } else if (blockStartUs != 0) {
    unsigned long widthMs = (nowUs - blockStartUs) / 1000;
    blockStartUs = 0;
    if (widthMs < COIN_MIN_MS) return;
    lastWidthMs = widthMs;
    if (widthMs <= COIN_MAX_MS && millis() - lastCoinMs > 200) {
      coinPulses++;
      lastCoinMs = millis();
    } else if (widthMs > COIN_MAX_MS) {
      rejectedPulses++;
    }
  }
}

// =====================================================
//  LCD
// =====================================================

void startLcd() {
  Wire.begin(LCD_SDA, LCD_SCL);
  byte addresses[] = {0x27, 0x3F};
  for (byte i = 0; i < 2; i++) {
    Wire.beginTransmission(addresses[i]);
    if (Wire.endTransmission() == 0) {
      lcd = new LiquidCrystal_I2C(addresses[i], 16, 2);
      lcd->init();
      lcd->backlight();
      Serial.print("LCD found at 0x");
      Serial.println(addresses[i], HEX);
      return;
    }
  }
  Serial.println("LCD not found! Check SDA/SCL wiring and power.");
}

String fit(String text) {
  if (text.length() > 16) return text.substring(0, 16);
  return text;
}

void show(String line1, String line2) {
  Serial.println("[SCREEN] " + line1 + " | " + line2);
  if (lcd == nullptr) return;
  lcd->clear();
  lcd->setCursor(0, 0);
  lcd->print(fit(line1));
  lcd->setCursor(0, 1);
  lcd->print(fit(line2));
}

// =====================================================
//  LEDs + buzzer
// =====================================================

void beep(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER, HIGH);
    delay(150);
    digitalWrite(BUZZER, LOW);
    delay(150);
  }
}

void allLedsOff() {
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(YELLOW_LED, LOW);
  digitalWrite(RED_LED, LOW);
}

void showStatusLed() {
  allLedsOff();
  if (lockerStatus == LOCKER_AVAILABLE) digitalWrite(GREEN_LED, HIGH);
  if (lockerStatus == LOCKER_RESERVED)  digitalWrite(YELLOW_LED, HIGH);
  if (lockerStatus == LOCKER_OCCUPIED)  digitalWrite(RED_LED, HIGH);
}

void blinkLed(int pin, int times) {
  allLedsOff();
  for (int i = 0; i < times; i++) {
    digitalWrite(pin, HIGH);
    delay(250);
    digitalWrite(pin, LOW);
    delay(250);
  }
}

// =====================================================
//  Memory (the locker remembers its status after a restart)
// =====================================================

void saveState() {
  memory.begin("helmlock", false);
  memory.putInt("status", (int)lockerStatus);
  memory.end();
  lastSaveMs = millis();
}

void loadState() {
  memory.begin("helmlock", true);
  lockerStatus = (LockerStatus)memory.getInt("status", (int)LOCKER_AVAILABLE);
  memory.end();
}

// =====================================================
//  Door sensor (foils touching = door closed)
// =====================================================

bool doorIsClosed() {
  return digitalRead(DOOR_PIN) == LOW;
}

bool doorReallyOpen() {
  for (int i = 0; i < 6; i++) {
    if (doorIsClosed()) return false;
    delay(50);
  }
  return true;
}

bool doorReallyClosed() {
  for (int i = 0; i < 6; i++) {
    if (!doorIsClosed()) return false;
    delay(50);
  }
  return true;
}

// =====================================================
//  WiFi + server
// =====================================================

void connectWifi(bool showScreen) {
  if (WiFi.status() == WL_CONNECTED) return;
  if (showScreen) show("Connecting WiFi", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 15000) delay(250);
  if (WiFi.status() == WL_CONNECTED) Serial.println("WiFi OK: " + WiFi.localIP().toString());
  else Serial.println("WiFi failed");
}

// One request to the server. Returns the HTTP code (0 = could not reach the server). The answer goes into `doc`.
int httpJson(bool post, const String& path, const String& body, JsonDocument& doc, int timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi(false);
    if (WiFi.status() != WL_CONNECTED) return 0;
  }
  String url = String(SERVER_URL) + path;
  WiFiClientSecure secure;
  WiFiClient plain;
  HTTPClient http;
  if (url.startsWith("https")) {
    secure.setInsecure();               // skips the certificate check: fine for a demo, see README
    http.begin(secure, url);
  } else {
    http.begin(plain, url);
  }
  http.setTimeout(timeoutMs);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Locker-Key", LOCKER_KEY);
  int code = post ? http.POST(body) : http.GET();
  if (code > 0) deserializeJson(doc, http.getString());
  http.end();
  return code > 0 ? code : 0;
}

String scanBody(const String& token, int coins, bool dry) {
  return String("{\"token\":\"") + token + "\",\"coins\":" + String(coins) + ",\"locker\":\"" + LOCKER_NUMBER + "\",\"dry\":" + (dry ? "true" : "false") + "}";
}

int amountDue() {
  return serverDue > 0 ? serverDue : DROP_OFF_FEE;
}

// Ask the server for the locker status (also tells the server we are alive)
void heartbeat() {
  lastHeartbeatMs = millis();
  JsonDocument doc;
  int code = httpJson(false, "/api/locker/status", "", doc, HEARTBEAT_TIMEOUT_MS);
  if (code != 200) {
    Serial.println("Heartbeat failed: " + String(code));
    return;
  }
  String status = doc["status"] | "";
  LockerStatus s = lockerStatus;
  if (status == "available") s = LOCKER_AVAILABLE;
  else if (status == "reserved") s = LOCKER_RESERVED;
  else if (status == "occupied") s = LOCKER_OCCUPIED;
  int due = doc["due"] | 0;

  bool changed = (s != lockerStatus) || (due > 0 && due != serverDue);
  lockerStatus = s;
  if (due > 0) serverDue = due;
  if (changed) {
    saveState();
    if (credit == 0) showIdle();
    else showStatusLed();
  }
}

// Tell the server "the door opened, this QR is used". Returns true when the server accepted it.
bool commitScan(const String& token, int coins) {
  JsonDocument doc;
  int code = httpJson(true, "/api/locker/scan", scanBody(token, coins, false), doc, SCAN_TIMEOUT_MS);
  if (code == 0) return false;
  // The server answered. Even a "no" must not be retried forever.
  bool ok = doc["ok"] | false;
  if (!ok) Serial.println("Commit refused: " + String((const char*)(doc["message"] | "?")));
  return true;
}

// Best effort: tell the server something happened at the door
void tellServerDoor(const char* event) {
  JsonDocument doc;
  httpJson(true, "/api/locker/door", String("{\"event\":\"") + event + "\"}", doc, HEARTBEAT_TIMEOUT_MS);
}

// =====================================================
//  Money screen
// =====================================================

void showIdle() {
  int due = amountDue();

  if (credit >= due) {
    show("Credit: P" + String(credit), lockerStatus == LOCKER_OCCUPIED ? "Scan OUT QR" : "Scan your QR");
  } else if (credit > 0) {
    show("Credit: P" + String(credit), "Insert P" + String(due - credit) + " more");
  } else if (lockerStatus == LOCKER_OCCUPIED) {
    show("Locker " + String(LOCKER_NUMBER) + " in use", "Get: P" + String(due) + " +OUT QR");
  } else if (lockerStatus == LOCKER_RESERVED) {
    show("Reserved", "Insert P" + String(due) + " + QR");
  } else {
    show("HelmLock " + String(LOCKER_NUMBER), "Reserve in the app");
  }
  showStatusLed();
}

void checkCoins() {
  noInterrupts();
  int pulses = coinPulses;
  int rejected = rejectedPulses;
  unsigned long width = lastWidthMs;
  coinPulses = 0;
  rejectedPulses = 0;
  interrupts();

  if (rejected > 0) {
    Serial.println("REJECTED: sensor blocked " + String(width) + " ms (too slow for a coin)");
    show("Not a valid coin", "Drop a P5 coin");
    beep(3);
    delay(1500);
    showIdle();
  }

  if (pulses > 0) {
    credit += pulses * COIN_VALUE;
    lastActivityMs = millis();
    Serial.println("COIN! (" + String(width) + " ms) Credit: P" + String(credit));
    beep(1);
    showIdle();
  }
}

void checkCreditTimeout() {
  if (credit > 0 && millis() - lastActivityMs > CREDIT_TIMEOUT_SECONDS * 1000UL) {
    Serial.println("Credit expired: P" + String(credit));
    credit = 0;
    show("Credit expired", "No QR scanned");
    beep(2);
    delay(2000);
    showIdle();
  }
}

// =====================================================
//  QR check (quick local check before bothering the server)
// =====================================================

bool isHelmLockQr(String code) {
  if (code.length() != 64) return false;
  for (int i = 0; i < 64; i++) {
    char c = code[i];
    bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    if (!ok) return false;
  }
  return true;
}

// =====================================================
//  Lock
// =====================================================

void moveServo(int target) {
  int step = (target > servoAngle) ? 1 : -1;
  while (servoAngle != target) {
    servoAngle += step;
    lockServo.write(servoAngle);
    delay(SERVO_STEP_MS);
  }
}

void lockDoor() {
  moveServo(LOCK_ANGLE);
  Serial.println("LOCK: LOCKED");
}

void unlockDoor() {
  moveServo(OPEN_ANGLE);
  Serial.println("LOCK: OPEN");
}

// Unlock, wait for the student to open and close the door, then lock.
// Returns false if the door was never opened.
bool openDoor(String line1, String line2) {
  show(line1, line2);
  blinkLed(GREEN_LED, 2);
  beep(1);
  unlockDoor();
  digitalWrite(GREEN_LED, HIGH);

  unsigned long start = millis();
  while (!doorReallyOpen()) {
    if (millis() - start > OPEN_WAIT_SECONDS * 1000UL) {
      Serial.println("DOOR: never opened");
      show("Door not opened", "Locking again");
      lockDoor();
      beep(2);
      delay(2000);
      return false;
    }
  }
  Serial.println("DOOR: OPENED");

  unsigned long openedAt = millis();
  unsigned long lastReminder = 0;
  while (!doorReallyClosed()) {
    if (millis() - openedAt > CLOSE_REMIND_SECONDS * 1000UL &&
        millis() - lastReminder > 3000) {
      show("Please close", "the door");
      beep(2);
      lastReminder = millis();
    }
  }
  Serial.println("DOOR: CLOSED");

  show("Locking...", "Please wait");
  delay(1000);
  lockDoor();
  beep(1);
  return true;
}

void reject(String line1, String line2) {
  show(line1, line2);
  beep(3);
  blinkLed(RED_LED, 3);
  delay(2000);
}

void checkForcedOpen() {
  if (doorIsClosed()) return;
  if (!doorReallyOpen()) return;

  Serial.println("ALERT: door opened while locked!");
  show("ALERT!", "Door forced open");
  while (!doorReallyClosed()) {
    digitalWrite(RED_LED, HIGH);
    digitalWrite(BUZZER, HIGH);
    delay(200);
    digitalWrite(RED_LED, LOW);
    digitalWrite(BUZZER, LOW);
    delay(200);
  }
  Serial.println("Door closed again");
  tellServerDoor("forced_open");
  scanBuffer = "";
  delay(500);
  showIdle();
}

// =====================================================
//  What happens after a scan: the SERVER decides
// =====================================================

void handleScan(String code) {
  Serial.println();
  Serial.println("SCANNED: " + code);
  lastActivityMs = millis();

  // 1. Not shaped like a HelmLock QR (the credit stays, they can try again)
  if (!isHelmLockQr(code)) {
    reject("Invalid QR", "Use HelmLock app");
    showIdle();
    return;
  }

  // 2. Ask the server: "dry" = only check, nothing is changed yet
  show("Checking QR...", "Please wait");
  JsonDocument doc;
  int http = httpJson(true, "/api/locker/scan", scanBody(code, credit, true), doc, SCAN_TIMEOUT_MS);

  if (http == 0) {
    reject("No connection", "Try again");
    showIdle();
    return;
  }
  if (http == 401) {
    Serial.println("Server says: bad locker key. LOCKER_KEY must match the server.");
    reject("Cabinet error", "Tell the admin");
    showIdle();
    return;
  }

  bool ok = doc["ok"] | false;
  String action = doc["action"] | "";

  // 3. The server said no (fake QR, used QR, wrong locker, expired...)
  if (!ok) {
    String l1 = doc["lcd"][0] | "Not allowed";
    String l2 = doc["lcd"][1] | "";
    reject(l1, l2);
    showIdle();
    return;
  }

  // 4. Valid QR, but not enough coins yet
  if (action == "pay") {
    int due = doc["due"] | 0;
    if (due > 0) serverDue = due;
    reject("Insert coin first", "Pay P" + String(max(0, amountDue() - credit)) + " more");
    showIdle();
    return;
  }

  // 5. Allowed: open the door
  int due = doc["due"] | 0;
  bool isIn = (action == "store");
  if (action != "store" && action != "retrieve") {
    reject("Unknown answer", "Try again");
    showIdle();
    return;
  }

  bool opened = openDoor("Door open", isIn ? "Store helmet" : "Get your helmet");
  if (opened) {
    credit -= due;
    if (credit < 0) credit = 0;
    Serial.println("PAID P" + String(due) + (isIn ? " (IN)" : " (OUT)"));

    // 6. Door really opened: now tell the server the QR is used
    show("Saving...", "Please wait");
    if (!commitScan(code, due)) {
      pendingToken = code;     // network problem: try again in the background
      pendingCoins = due;
      Serial.println("Commit saved for later");
    }
    lockerStatus = isIn ? LOCKER_OCCUPIED : LOCKER_AVAILABLE;
    saveState();
    serverDue = isIn ? due : DROP_OFF_FEE;
    if (isIn) beep(2);
  }
  // door never opened: nothing was changed on the server, and the credit stays

  lastActivityMs = millis();
  showIdle();
}

// Try again to tell the server about a door that opened while the network was down
void retryPendingCommit() {
  if (pendingToken.length() == 0) return;
  if (millis() - lastCommitTryMs < COMMIT_RETRY_EVERY_MS) return;
  lastCommitTryMs = millis();
  if (commitScan(pendingToken, pendingCoins)) {
    Serial.println("Pending commit delivered");
    pendingToken = "";
    pendingCoins = 0;
  }
}

// =====================================================
//  Serial Monitor commands (for testing)
//    reset  = make the locker AVAILABLE again and clear credit
//    status = print what the cabinet thinks
// =====================================================

void checkSerialCommands() {
  if (!Serial.available()) return;
  String cmd = Serial.readStringUntil('\n');
  cmd.trim();
  if (cmd == "reset") {
    lockerStatus = LOCKER_AVAILABLE;
    credit = 0;
    pendingToken = "";
    saveState();
    Serial.println("Locker reset to AVAILABLE (the server is not changed)");
    showIdle();
  } else if (cmd == "status") {
    Serial.println("WiFi: " + String(WiFi.status() == WL_CONNECTED ? "connected" : "NOT connected") + "  credit: P" + String(credit) + "  due: P" + String(amountDue()) + "  status: " + String((int)lockerStatus));
  }
}

// =====================================================
//  Setup + loop
// =====================================================

void setup() {
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(300);
  Scanner.begin(SCANNER_BAUD, SERIAL_8N1, SCANNER_RX, SCANNER_TX);

  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  pinMode(DOOR_PIN, INPUT_PULLUP);
  allLedsOff();

  Serial.println();
  Serial.println("=== HelmLock Locker " + String(LOCKER_NUMBER) + " ===");

  startLcd();
  show("Starting...", "Please wait");
  loadState();

  if (!doorReallyClosed()) {
    show("Please close", "the door");
    while (!doorReallyClosed()) delay(100);
  }

  lockServo.setPeriodHertz(50);
  lockServo.attach(SERVO_PIN, 500, 2400);
  lockServo.write(LOCK_ANGLE);
  servoAngle = LOCK_ANGLE;
  delay(800);
  Serial.println("LOCK: LOCKED");

  pinMode(COIN_PIN, INPUT_PULLUP);
  delay(300);
  idleLevel = digitalRead(COIN_PIN);
  Serial.println("Coin sensor with no coin reads: " + String(idleLevel == HIGH ? "HIGH" : "LOW"));
  coinPulses = 0;
  rejectedPulses = 0;
  attachInterrupt(digitalPinToInterrupt(COIN_PIN), onCoinChange, CHANGE);

  connectWifi(true);
  show("Contacting server", "Please wait");
  heartbeat();

  Serial.println("Type 'status' or 'reset' + Enter in the Serial Monitor.");
  beep(1);
  showIdle();
}

void loop() {
  checkCoins();
  checkCreditTimeout();
  checkForcedOpen();

  // Keep the status and price in step with the server
  if (millis() - lastHeartbeatMs > HEARTBEAT_EVERY_MS) heartbeat();
  retryPendingCommit();

  checkSerialCommands();

  // Read the scanner, one character at a time, until Enter
  while (Scanner.available()) {
    char c = Scanner.read();
    if (c == '\n') {
      scanBuffer.trim();
      if (scanBuffer.length() > 0) handleScan(scanBuffer);
      scanBuffer = "";
    } else if (c != '\r') {
      scanBuffer += c;
    }
  }
}
