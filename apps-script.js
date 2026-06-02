/**
 * LAUM Vending — Google Apps Script
 * ─────────────────────────────────
 * โครงสร้าง Sheet (ชีต1):
 *   A=ชื่อสินค้า  B=เลขช่อง  C=ต้นทุน  D=ต้นทุนต่อขวด
 *   E=จำนวนขวด(ซื้อมา)  F=ราคาขาย  G=กำไรต่อขวด  H=ขายหมดได้กำไร
 *   I=ชนิด  J=ใส่ได้(max)  K=สต็อกปัจจุบัน  L=รูปภาพ
 *
 * Deploy:
 *   Extensions → Apps Script → วางโค้ดนี้
 *   Deploy → New Deployment → Web App
 *   Execute as: Me · Access: Anyone → Copy URL
 */

const CONFIG = {
  SHEET_NAME:    "ชีต1",
  LINE_TOKEN:    "YOUR_LINE_CHANNEL_ACCESS_TOKEN",
  LINE_USER_ID:  "YOUR_LINE_USER_ID",
  LINE_MODE:     "critical",  // "every" | "critical" | "summary"
  LOW_STOCK_PCT: 0.25,
};

// คอลัมน์ index (0-based) — ตรงกับ Sheet จริง
const COL = {
  name:   0,   // A ชื่อสินค้า
  slot:   1,   // B เลขช่อง
  cost:   3,   // D ต้นทุนต่อขวด
  price:  5,   // F ราคาขาย
  type:   8,   // I ชนิด
  maxQty: 9,   // J ใส่ได้ (max)
  stock:  10,  // K สต็อกปัจจุบัน ← webhook ตัด/รีเซ็ทที่นี่
  imgUrl: 11,  // L รูปภาพ
};

// ════════════════════════════════════════════════════
// GET — ดึงข้อมูลสินค้าทั้งหมด (Web App เรียกใช้)
// ════════════════════════════════════════════════════
function doGet(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const action = (e.parameter.action || "products");
    const sheet  = (e.parameter.sheet  || CONFIG.SHEET_NAME);
    let result;
    if      (action === "products") result = getProducts(sheet);
    else if (action === "ping")     result = { ok: true, time: new Date().toISOString() };
    else                            result = { ok: false, error: "Unknown action: " + action };
    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }
  return output;
}

function getProducts(sheetName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName || CONFIG.SHEET_NAME);
  if (!sheet) throw new Error("ไม่พบ Sheet: " + sheetName);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, products: [] };

  const products = data.slice(1)
    .filter(row => row[COL.slot] && row[COL.name])
    .map(row => {
      const maxQty   = parseInt(row[COL.maxQty]) || 20;
      const stockRaw = row[COL.stock];
      // ถ้า K ว่าง → ใช้ max เป็น default
      const stock = (stockRaw !== "" && stockRaw !== null && !isNaN(parseInt(stockRaw)))
                      ? parseInt(stockRaw)
                      : maxQty;
      return {
        slot:   parseInt(row[COL.slot])    || 0,
        name:   String(row[COL.name]       || ""),
        cost:   parseFloat(row[COL.cost])  || 0,
        price:  parseFloat(row[COL.price]) || 15,
        type:   String(row[COL.type]       || "ขวด"),
        maxQty: maxQty,
        stock:  stock,
        imgUrl: String(row[COL.imgUrl]     || ""),
      };
    })
    .sort((a, b) => a.slot - b.slot);

  return { ok: true, products, updatedAt: new Date().toISOString() };
}

// ════════════════════════════════════════════════════
// POST — รับ webhook จาก ESP32
// ════════════════════════════════════════════════════
function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;
    if      (action === "sale")   handleSale(data);
    else if (action === "stuck")  handleStuck(data);
    else if (action === "refill") handleRefill(data);
    else if (action === "refill_all") handleRefillAll(data);
    output.setContent(JSON.stringify({ ok: true }));
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }
  return output;
}

// ════════════════════════════════════════════════════
// 💰 ขายสำเร็จ → ลด K -1
// ════════════════════════════════════════════════════
function handleSale(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);
  logTransaction(ss, data, product, "sale");

  if (product) {
    const maxQty   = parseInt(product.row[COL.maxQty]) || 20;
    const curStock = parseInt(product.row[COL.stock])  || 0;
    const newStock = Math.max(0, curStock - 1);
    // อัปเดตคอลัมน์ K (index 10 → column 11)
    sheet.getRange(product.rowNum, COL.stock + 1).setValue(newStock);

    const pct = newStock / maxQty;
    if (CONFIG.LINE_MODE === "every") {
      sendLine(`💰 ขายสำเร็จ\nช่อง ${data.slot} · ${product.row[COL.name]}\nราคา ฿${product.row[COL.price]}\nเหลือ ${newStock}/${maxQty} ขวด`);
    } else if (CONFIG.LINE_MODE === "critical") {
      if (newStock === 0) {
        sendLine(`⛔ สินค้าหมด!\nช่อง ${data.slot} · ${product.row[COL.name]}\nกรุณาเติมสินค้าด่วน`);
      } else if (pct <= CONFIG.LOW_STOCK_PCT) {
        sendLine(`⚠️ สต็อกใกล้หมด\nช่อง ${data.slot} · ${product.row[COL.name]}\nเหลือ ${newStock}/${maxQty} ขวด`);
      }
    }
  }
}

// ════════════════════════════════════════════════════
// 🚨 สินค้าติดตู้
// ════════════════════════════════════════════════════
function handleStuck(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);
  logTransaction(ss, data, product, "stuck");
  sendLine(`🚨 สินค้าติดตู้!\nช่อง ${data.slot}${product ? " · " + product.row[COL.name] : ""}\nลูกค้าจ่ายเงินแล้วแต่สินค้าไม่ออก\n⚡ กรุณาตรวจสอบด่วน!`);
}

// ════════════════════════════════════════════════════
// 🔄 รีเซ็ทสต็อกทีละช่อง → ตั้ง K = J (max)
// ════════════════════════════════════════════════════
function handleRefill(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);
  if (product) {
    const maxQty = parseInt(product.row[COL.maxQty]) || 20;
    sheet.getRange(product.rowNum, COL.stock + 1).setValue(maxQty);
    sendLine(`✅ เติมสินค้าแล้ว\nช่อง ${data.slot} · ${product.row[COL.name]}\nสต็อก: ${maxQty}/${maxQty}`);
  }
}

// ════════════════════════════════════════════════════
// 🔄 รีเซ็ทสต็อกทั้งหมด → K = J ทุก row
// ════════════════════════════════════════════════════
function handleRefillAll(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  let count   = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][COL.slot] || !rows[i][COL.name]) continue;
    const maxQty = parseInt(rows[i][COL.maxQty]) || 20;
    sheet.getRange(i + 1, COL.stock + 1).setValue(maxQty);
    count++;
  }
  sendLine(`✅ รีเซ็ทสต็อกทั้งหมด ${count} รายการเรียบร้อย`);
}

// ════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════
function findProduct(sheet, slot) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (parseInt(data[i][COL.slot]) === parseInt(slot)) {
      return { row: data[i], rowNum: i + 1 };
    }
  }
  return null;
}

function logTransaction(ss, data, product, type) {
  let logSheet = ss.getSheetByName("log");
  if (!logSheet) {
    logSheet = ss.insertSheet("log");
    logSheet.appendRow(["เวลา", "ตู้", "ช่อง", "สินค้า", "ราคา", "ประเภท"]);
  }
  logSheet.appendRow([
    new Date(),
    data.machineId || "M1",
    data.slot,
    product ? product.row[COL.name]  : "ไม่ทราบ",
    product ? product.row[COL.price] : 0,
    type,
  ]);
}

// ════════════════════════════════════════════════════
// 📊 ส่งสรุปประจำวัน (trigger 3 ครั้ง/วัน)
// ════════════════════════════════════════════════════
function sendDailySummary() {
  const ss       = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("log");
  const sheet    = ss.getSheetByName(CONFIG.SHEET_NAME);

  // คำนวณจาก log
  let revenue = 0, sales = 0, stuck = 0;
  if (logSheet) {
    const today = new Date(); today.setHours(0,0,0,0);
    logSheet.getDataRange().getValues().slice(1).forEach(r => {
      if (new Date(r[0]) >= today) {
        if (r[5] === "sale")  { revenue += parseFloat(r[4])||0; sales++; }
        if (r[5] === "stuck") stuck++;
      }
    });
  }

  // นับสต็อกจาก K
  let emptyCount = 0, lowCount = 0;
  if (sheet) {
    sheet.getDataRange().getValues().slice(1)
      .filter(r => r[COL.slot] && r[COL.name])
      .forEach(r => {
        const cur = parseInt(r[COL.stock]) || 0;
        const max = parseInt(r[COL.maxQty]) || 20;
        if (cur === 0) emptyCount++;
        else if (cur / max <= CONFIG.LOW_STOCK_PCT) lowCount++;
      });
  }

  const h      = new Date().getHours();
  const period = h < 12 ? "🌅 เช้า" : h < 17 ? "☀️ บ่าย" : "🌆 เย็น";
  sendLine([
    `📊 สรุปยอด ${period}`,
    `💰 รายได้: ฿${revenue.toLocaleString()}`,
    `🥤 ขาย: ${sales} ขวด`,
    `🚨 ติดตู้: ${stuck} ครั้ง`,
    `⚠️ ใกล้หมด: ${lowCount} ช่อง`,
    `⛔ หมด: ${emptyCount} ช่อง`,
  ].join("\n"));
}

// ════════════════════════════════════════════════════
// 📱 LINE Messaging API
// ════════════════════════════════════════════════════
function sendLine(message) {
  if (!CONFIG.LINE_TOKEN || CONFIG.LINE_TOKEN.startsWith("YOUR_")) {
    console.log("[LINE not configured]", message);
    return;
  }
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.LINE_TOKEN },
      payload: JSON.stringify({ to: CONFIG.LINE_USER_ID, messages: [{ type: "text", text: message }] }),
      muteHttpExceptions: true,
    });
  } catch (err) { console.error("LINE error:", err); }
}

// ════════════════════════════════════════════════════
// ⏰ ตั้ง Trigger (รันครั้งเดียว)
// ════════════════════════════════════════════════════
function setupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendDailySummary")
    .forEach(t => ScriptApp.deleteTrigger(t));
  [9, 14, 19].forEach(h => {
    ScriptApp.newTrigger("sendDailySummary").timeBased().atHour(h).everyDays(1).create();
  });
  Logger.log("Triggers: 09:00, 14:00, 19:00");
}

// ════════════════════════════════════════════════════
// 🧪 ทดสอบ
// ════════════════════════════════════════════════════
function testGetProducts()  { Logger.log(JSON.stringify(getProducts(), null, 2)); }
function testLine()         { sendLine("🤖 LAUM Vending ทดสอบ ✅"); }
function testSale()         { handleSale({ action:"sale",  machineId:"M1", slot:19 }); }
function testRefill()       { handleRefill({ action:"refill", machineId:"M1", slot:19 }); }
function testRefillAll()    { handleRefillAll({ action:"refill_all", machineId:"M1" }); }
