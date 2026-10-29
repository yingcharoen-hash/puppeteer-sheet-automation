import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';
import { google } from 'googleapis';
import 'dotenv/config';

// บังคับเขตเวลาของ Node.js เป็นเวลาประเทศไทย (UTC+7)
process.env.TZ = 'Asia/Bangkok';

// --- การตั้งค่า URL และ สเปรดชีต ---
const BASE_URL = process.env.WEB_URL || 'https://yingcharoen-parking.web.app';
const LOGIN_URL = `${BASE_URL.replace(/\/+$/, '')}/login.html`;
const EXPORT_URL = `${BASE_URL.replace(/\/+$/, '')}/export.html`;

const SPREADSHEET_ID = '1Dts7FA1GIN-8-uNSMjwUod2p1TmYwwq-Ngj9rYbJk94';
const RAW_DATA_SHEET_NAME = 'ข้อมูล';
const SUMMARY_SHEET_NAME = 'สรุป';
const PIVOT_DATE_FIELD_NAME = 'วันที่ตามกะงาน';

const DOWNLOAD_DIR = path.resolve(process.cwd(), 'downloads');

/**
 * คำนวณวันที่ตามเขตเวลาประเทศไทย (GMT+7 / Asia/Bangkok)
 * @param {number} offsetDays จำนวนวันที่ต้องการบวก/ลบ (-1 = เมื่อวาน, 0 = วันนี้)
 * @returns {string} วันที่ในรูปแบบ YYYY-MM-DD
 */
function getThaiDate(offsetDays = 0) {
  const now = new Date();
  const thaiTime = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
  thaiTime.setDate(thaiTime.getDate() + offsetDays);

  const year = thaiTime.getFullYear();
  const month = String(thaiTime.getMonth() + 1).padStart(2, '0');
  const day = String(thaiTime.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * แปลงค่า GOOGLE_SERVICE_ACCOUNT_KEY จาก Environment Variables ให้เป็น JSON Object
 * รองรับทั้ง Raw JSON, Pretty JSON, และ Base64 Encoded JSON
 */
function parseGoogleCredentials(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('กรุณาระบุ GOOGLE_SERVICE_ACCOUNT_KEY ใน GitHub Secrets');
  }

  let str = raw.trim();

  // ปลดเครื่องหมายคำพูดรอบนอกที่อาจติดมา
  if ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith('"') && str.endsWith('"'))) {
    str = str.slice(1, -1).trim();
  }

  // ปลด UTF-8 / UTF-16 BOM
  str = str.replace(/^\uFEFF/, '');

  // 1. กรณีที่ส่งมาเป็น JSON String ตรงๆ (ขึ้นต้นด้วย {)
  if (str.startsWith('{')) {
    try {
      return JSON.parse(str);
    } catch (err) {
      console.warn('⚠️ JSON Parse ตรงๆ ไม่ผ่าน กำลังลองปรับ Format Newlines...');
      try {
        return JSON.parse(str.replace(/[\r\n]+/g, ' '));
      } catch (err2) {
        console.error('❌ ไม่สามารถแปลงเนื้อหา JSON ได้:', err.message);
        throw new Error(`JSON parsing failed: ${err.message}`);
      }
    }
  }

  // 2. กรณีที่ส่งมาเป็น Base64
  try {
    const decoded = Buffer.from(str, 'base64').toString('utf-8').trim().replace(/^\uFEFF/, '');
    if (decoded.startsWith('{')) {
      return JSON.parse(decoded);
    }
  } catch (err) {
    // ไม่ใช่ Base64
  }

  throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY มีรูปแบบไม่ถูกต้อง กรุณาตรวจสอบเนื้อหา JSON ใน GitHub Secrets');
}

/**
 * เชื่อมต่อ Google Sheets API ด้วย Google Service Account Key
 */
function getGoogleSheetsClient() {
  const credentials = parseGoogleCredentials(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

/**
 * สั่งงาน Puppeteer เพื่อล็อกอิน, เลือกวันที่, เลือก Officer และดาวน์โหลดไฟล์ CSV
 */
async function runBot() {
  const email = process.env.WEB_EMAIL;
  const password = process.env.WEB_PASSWORD;

  if (!email || !password) {
    throw new Error('กรุณาระบุ WEB_EMAIL และ WEB_PASSWORD ให้ครบถ้วน');
  }

  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log('🚀 กำลังเริ่มต้น Chromium Browser...');
  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  };

  if (fs.existsSync('/usr/bin/google-chrome')) {
    launchOptions.executablePath = '/usr/bin/google-chrome';
    console.log('🌐 ใช้ Google Chrome ของระบบ: /usr/bin/google-chrome');
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // จำลองเขตเวลาของ Browser เป็นประเทศไทย (Asia/Bangkok / UTC+7) เพื่อให้เวลาใน CSV ตรงกับเวลาไทย
  await page.emulateTimezone('Asia/Bangkok');

  // ดักจับการดาวน์โหลดไฟล์ผ่าน Chrome DevTools Protocol (CDP)
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  try {
    // 1. ไปที่หน้า Login
    console.log(`🌐 ไปที่หน้าล็อกอิน: ${LOGIN_URL}`);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('🔑 กำลังกรอกข้อมูลล็อกอิน...');
    await page.waitForSelector('#email', { timeout: 15000 });
    await page.type('#email', email, { delay: 50 });
    await page.type('#password', password, { delay: 50 });

    console.log('🔘 กำลังกดปุ่ม Sign In...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click('#login-button'),
    ]);

    // ตรวจสอบ error alert จาก Firebase Auth
    const errorText = await page.evaluate(() => {
      const errEl = document.getElementById('error-message');
      return errEl && !errEl.classList.contains('hidden') ? errEl.innerText.trim() : null;
    });

    if (errorText) {
      throw new Error(`การเข้าสู่ระบบล้มเหลว: ${errorText}`);
    }

    console.log('✅ ล็อกอินสำเร็จเรียบร้อย');

    // 2. นำทางไปยังหน้า Export Data
    console.log(`🌐 นำทางไปยังหน้าส่งออกข้อมูล: ${EXPORT_URL}`);
    await page.goto(EXPORT_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('⏳ กำลังรอการยืนยันสิทธิ์ Role และโหลดเนื้อหาหน้า Export...');
    // รอจนกว่า #main-content จะปลด class hidden (แปลว่า Firebase Auth ตรวจสอบ Role สำเร็จ)
    await page.waitForFunction(() => {
      const denied = document.getElementById('access-denied');
      if (denied && !denied.classList.contains('hidden')) {
        throw new Error('บัญชีนี้ไม่มีสิทธิ์เข้าถึงหน้า Export (ต้องการสิทธิ์ admin หรือ super-admin)');
      }
      const main = document.getElementById('main-content');
      return main && !main.classList.contains('hidden');
    }, { timeout: 30000 });

    // รอให้ loadOfficers() ทำงานเสร็จ
    await page.waitForFunction(() => {
      const select = document.getElementById('officer-select');
      return select && select.options.length > 0;
    }, { timeout: 15000 });

    // คำนวณช่วงเวลา: Start Date = เมื่อวาน, End Date = วันนี้
    const startDate = getThaiDate(-1);
    const endDate = getThaiDate(0);
    console.log(`📅 กำหนดช่วงเวลา: Start Date = ${startDate} | End Date = ${endDate}`);

    await page.evaluate((s, e) => {
      const startEl = document.getElementById('start-date');
      const endEl = document.getElementById('end-date');
      if (startEl) {
        startEl.value = s;
        startEl.dispatchEvent(new Event('change', { bubbles: true }));
        startEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (endEl) {
        endEl.value = e;
        endEl.dispatchEvent(new Event('change', { bubbles: true }));
        endEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, startDate, endDate);

    // 3. เลือก Officer เป็น "All Officers"
    console.log('👤 เลือก Officer เป็น "All Officers"...');
    await page.select('#officer-select', 'all');

    // 4. คลิกปุ่มสีเขียว "Export to CSV" ผ่าน evaluate เพื่อการันตีการคลิก 100%
    console.log('📥 กำลังคลิกปุ่มสีเขียว "Export to CSV"...');
    await page.evaluate(() => {
      const btn = document.getElementById('export-button');
      if (btn) btn.click();
    });

    // ตรวจสอบสถานะการดึงข้อมูลบนหน้าเว็บ
    console.log('⏳ กำลังรอผลการค้นหาข้อมูลจาก Firebase...');
    const exportResult = await page.waitForFunction(() => {
      const el = document.getElementById('export-status');
      if (!el) return null;
      const text = el.innerText.trim();
      if (text.includes('Successfully exported') || text.includes('No data found') || text.includes('Error:')) {
        return text;
      }
      return null;
    }, { timeout: 35000 });

    const statusMessage = await exportResult.jsonValue();
    console.log(`ℹ️ สถานะบนหน้าเว็บ: "${statusMessage}"`);

    if (statusMessage.includes('No data found')) {
      console.log('ℹ️ ไม่พบรายการข้อมูลใหม่ในช่วงเวลาที่เลือก (No data found)');
      return null;
    }

    if (statusMessage.includes('Error:')) {
      throw new Error(`เกิดข้อผิดพลาดในการ Export บนหน้าเว็บ: ${statusMessage}`);
    }

    // รอการดาวน์โหลดไฟล์ CSV
    console.log('⏳ รอการดาวน์โหลดไฟล์ CSV...');
    const downloadedFilePath = await waitForFileDownload(DOWNLOAD_DIR, 35000);
    console.log(`📁 ได้รับไฟล์ CSV เรียบร้อย: ${downloadedFilePath}`);

    return downloadedFilePath;
  } finally {
    await browser.close();
  }
}

/**
 * รอจนกว่าจะมีไฟล์ .csv ดาวน์โหลดลงในโฟลเดอร์สมบูรณ์
 */
async function waitForFileDownload(downloadPath, timeoutMs = 35000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(downloadPath)) {
      const files = fs.readdirSync(downloadPath);
      const csvFile = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (csvFile) {
        const fullPath = path.join(downloadPath, csvFile);
        const stats = fs.statSync(fullPath);
        if (stats.size > 0) {
          return fullPath;
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('หมดเวลารอการดาวน์โหลดไฟล์ CSV');
}

/**
 * นำข้อมูลจาก CSV ไป Append ต่อท้ายแถวล่าสุดในชีท "ข้อมูล"
 */
async function appendDataToSheet(sheets, csvFilePath) {
  console.log(`📊 กำลังอ่านข้อมูลดิบจาก ${csvFilePath}...`);
  let fileContent = fs.readFileSync(csvFilePath, 'utf-8');

  // ปลด UTF-8 BOM ที่เว็บสร้างมา
  fileContent = fileContent.replace(/^\uFEFF/, '');

  const records = parse(fileContent, {
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (records.length <= 1) {
    console.log('⚠️ ไม่พบแถวข้อมูลใหม่ในไฟล์ CSV (มีเฉพาะ Header หรือไม่มีข้อมูล)');
    return;
  }

  // ข้ามแถวที่ 1 (Header: รหัสพนักงาน, ชื่อ-นามสกุล, เวลาที่สแกน, สแกนโดย)
  const rowsToAppend = records.slice(1);
  console.log(`➕ กำลังนำข้อมูลจำนวน ${rowsToAppend.length} แถว Append ต่อท้ายในชีท "${RAW_DATA_SHEET_NAME}"...`);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${RAW_DATA_SHEET_NAME}'!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: rowsToAppend,
    },
  });

  console.log('✅ บันทึกข้อมูลเข้า Google Sheets สำเร็จเรียบร้อย');
}

/**
 * ตั้งค่าฟิลเตอร์ใน Pivot Table หน้าชีท "สรุป" ตรงฟิลด์ "วันที่ตามกะงาน" เป็น "Select all"
 * โดยคงเงื่อนไขของฟิลเตอร์อื่นๆ เช่น "ปี" ไว้ตามเดิม 100%
 */
async function resetPivotTableDateFilter(sheets) {
  console.log(`🔄 กำลังอัปเดตฟิลเตอร์ "วันที่ตามกะงาน" ใน Pivot Table ให้เป็น Select all (คงฟิลเตอร์ "ปี" ไว้)...`);

  // 1. ดึงรายการวันที่ทั้งหมดที่มีในคอลัมน์ G (วันที่ตามกะงาน) ของชีท "ข้อมูล"
  const valRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${RAW_DATA_SHEET_NAME}'!G2:G`,
  });

  const uniqueDates = Array.from(
    new Set((valRes.data.values || []).map(r => r[0] || ''))
  );
  console.log(`📅 พบรายการวันที่ทั้งหมดในชีท "${RAW_DATA_SHEET_NAME}": ${uniqueDates.length} รายการ`);

  // 2. ดึงข้อมูล Pivot Table และจำนวนแถวทั้งหมด
  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties,data.rowData.values.pivotTable)',
  });

  const summarySheet = res.data.sheets.find(s => s.properties.title === SUMMARY_SHEET_NAME);
  const rawSheet = res.data.sheets.find(s => s.properties.title === RAW_DATA_SHEET_NAME);

  if (!summarySheet || !summarySheet.data) {
    console.log(`⚠️ ไม่พบข้อมูลชีท "${SUMMARY_SHEET_NAME}" หรือไม่มี Pivot Table`);
    return;
  }

  const totalRawRows = rawSheet?.properties?.gridProperties?.rowCount || 20000;
  const sheetId = summarySheet.properties.sheetId;
  const requests = [];

  for (const gridData of summarySheet.data) {
    const startRow = gridData.startRow || 0;
    const startCol = gridData.startColumn || 0;
    if (!gridData.rowData) continue;

    for (let r = 0; r < gridData.rowData.length; r++) {
      const row = gridData.rowData[r];
      if (!row.values) continue;

      for (let c = 0; c < row.values.length; c++) {
        const cell = row.values[c];
        if (cell.pivotTable) {
          const pivot = cell.pivotTable;

          // ขยายขอบเขตของข้อมูลต้นฉบับให้คลุมแถวล่าสุดทั้งหมดของชีทข้อมูล
          if (pivot.source) {
            pivot.source.endRowIndex = totalRawRows;
          }

          if (!pivot.filterSpecs) {
            pivot.filterSpecs = [];
          }

          // ค้นหาฟิลเตอร์ของ "วันที่ตามกะงาน" (คอลัมน์ index 6)
          let dateFilter = pivot.filterSpecs.find(f => f.columnOffsetIndex === 6);
          if (dateFilter) {
            // ตั้งค่า visibleValues ให้ครบทุกค่า = "Select all"
            dateFilter.filterCriteria = { visibleValues: uniqueDates };
          } else {
            pivot.filterSpecs.push({
              columnOffsetIndex: 6,
              filterCriteria: { visibleValues: uniqueDates },
            });
          }

          // **สำคัญ**: ฟิลเตอร์ของ "ปี" (คอลัมน์ index 7) และฟิลเตอร์อื่นๆ จะถูกปล่อยไว้เหมือนเดิม ไม่แตะต้อง

          requests.push({
            updateCells: {
              rows: [{ values: [{ pivotTable: pivot }] }],
              fields: 'pivotTable',
              start: { sheetId, rowIndex: startRow + r, columnIndex: startCol + c },
            },
          });
        }
      }
    }
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    console.log(`✅ อัปเดตฟิลเตอร์ "วันที่ตามกะงาน" เป็น Select all (${uniqueDates.length} รายการ) สำเร็จ โดยคงเงื่อนไข "ปี" ไว้เรียบร้อยแล้ว`);
  } else {
    console.log(`ℹ️ ไม่พบ Pivot Table ที่ต้องอัปเดต`);
  }
}

/**
 * ฟังก์ชันหลักในการรัน Process ทั้งหมด
 */
async function main() {
  try {
    console.log('=== เริ่มต้นกระบวนการ Daily Automation ===');

    // ตรวจสอบ GitHub Secrets
    const missingVars = [];
    if (!process.env.WEB_EMAIL) missingVars.push('WEB_EMAIL');
    if (!process.env.WEB_PASSWORD) missingVars.push('WEB_PASSWORD');
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) missingVars.push('GOOGLE_SERVICE_ACCOUNT_KEY');

    if (missingVars.length > 0) {
      console.error('\n======================================================');
      console.error('❌ ตรวจพบว่ายังไม่ได้ตั้งค่า GitHub Secrets ดังต่อไปนี้:');
      missingVars.forEach(v => console.error(`   - ${v}`));
      console.error('👉 วิธีแก้ไข: ไปที่ Repo บน GitHub -> Settings -> Secrets and variables -> Actions');
      console.error('   แล้วกดปุ่ม "New repository secret" เพื่อเพิ่มตัวแปรให้ครบถ้วน');
      console.error('======================================================\n');
      process.exit(1);
    }

    const sheets = getGoogleSheetsClient();

    // ขั้นตอนที่ 1: ดึงไฟล์ CSV
    const csvFilePath = await runBot();

    // ขั้นตอนที่ 2: นำข้อมูลไปต่อท้ายในชีท "ข้อมูล" (หากมีไฟล์)
    if (csvFilePath) {
      await appendDataToSheet(sheets, csvFilePath);
      fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    } else {
      console.log('ℹ️ ข้ามการ Append เนื่องจากไม่มีข้อมูล CSV ใหม่');
    }

    // ขั้นตอนที่ 3: ล้างฟิลเตอร์ Pivot Table ในชีท "สรุป"
    await resetPivotTableDateFilter(sheets);

    console.log('🎉 เสร็จสิ้นกระบวนการทำงานทุกขั้นตอนเรียบร้อย 100%');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err.message || err);
    process.exit(1);
  }
}

main();
