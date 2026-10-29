import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';
import { google } from 'googleapis';
import 'dotenv/config';

// --- การตั้งค่าสเปรดชีตและพาธ ---
const TARGET_URL = process.env.WEB_URL || 'https://yingcharoen-parking.web.app';
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
 * เชื่อมต่อ Google Sheets API ด้วย Google Service Account Key
 */
function getGoogleSheetsClient() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv) {
    throw new Error('กรุณาระบุ GOOGLE_SERVICE_ACCOUNT_KEY ใน Environment Variables หรือ GitHub Secrets');
  }

  let credentials;
  try {
    credentials = JSON.parse(keyEnv);
  } catch (e) {
    const decoded = Buffer.from(keyEnv, 'base64').toString('utf-8');
    credentials = JSON.parse(decoded);
  }

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
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // ดักจับการดาวน์โหลดไฟล์ผ่าน Chrome DevTools Protocol (CDP)
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR,
  });

  try {
    console.log(`🌐 ไปที่หน้าล็อกอิน: ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // 1. กรอกข้อมูลล็อกอิน
    console.log('🔑 กำลังกรอกข้อมูลล็อกอิน...');
    const emailSelector = 'input[type="email"], input[name="email"], input[name="username"], #email';
    const passwordSelector = 'input[type="password"], input[name="password"], #password';
    const loginButtonSelector = 'button[type="submit"], input[type="submit"], .btn-login, button.btn-primary';

    await page.waitForSelector(emailSelector, { timeout: 15000 });
    await page.type(emailSelector, email, { delay: 50 });
    await page.type(passwordSelector, password, { delay: 50 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click(loginButtonSelector),
    ]);

    console.log('✅ ล็อกอินสำเร็จ');

    // 2. นำทางไปยังหน้า Export
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // คำนวณช่วงเวลา: Start Date = เมื่อวาน, End Date = วันนี้
    const startDate = getThaiDate(-1);
    const endDate = getThaiDate(0);
    console.log(`📅 กำหนดช่วงเวลา: Start Date = ${startDate} | End Date = ${endDate}`);

    const startDateSelector = 'input[name="startDate"], input[name="start_date"], #startDate, input[placeholder*="Start"]';
    const endDateSelector = 'input[name="endDate"], input[name="end_date"], #endDate, input[placeholder*="End"]';

    if (await page.$(startDateSelector)) {
      await page.click(startDateSelector, { clickCount: 3 });
      await page.type(startDateSelector, startDate);
    }

    if (await page.$(endDateSelector)) {
      await page.click(endDateSelector, { clickCount: 3 });
      await page.type(endDateSelector, endDate);
    }

    // 3. เลือก Officer: "All Officers"
    console.log('👤 เลือก Officer เป็น "All Officers"...');
    const officerDropdownSelector = 'select[name="officer"], select[name="officer_id"], #officerSelect';
    if (await page.$(officerDropdownSelector)) {
      const optionValue = await page.evaluate((selector) => {
        const select = document.querySelector(selector);
        for (const opt of select.options) {
          if (opt.text.toLowerCase().includes('all') || opt.value.toLowerCase().includes('all')) {
            return opt.value;
          }
        }
        return select.options[0]?.value;
      }, officerDropdownSelector);

      if (optionValue) {
        await page.select(officerDropdownSelector, optionValue);
      }
    }

    // 4. คลิกปุ่มสีเขียว "Export to CSV"
    console.log('📥 กำลังค้นหาและคลิกปุ่มสีเขียว "Export to CSV"...');
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const targetBtn = buttons.find(b => 
        (b.textContent && b.textContent.toLowerCase().includes('export to csv')) ||
        (b.classList && (b.classList.contains('btn-success') || b.classList.contains('bg-green-500')))
      );
      if (targetBtn) {
        targetBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      await page.click('button.btn-success, .export-btn, [data-action="export"]');
    }

    console.log('⏳ รอการดาวน์โหลดไฟล์ CSV...');
    const downloadedFilePath = await waitForFileDownload(DOWNLOAD_DIR, 30000);
    console.log(`📁 ได้รับไฟล์ CSV เรียบร้อย: ${downloadedFilePath}`);

    return downloadedFilePath;
  } finally {
    await browser.close();
  }
}

/**
 * รอจนกว่าจะมีไฟล์ .csv ดาวน์โหลดลงในโฟลเดอร์สมบูรณ์
 */
async function waitForFileDownload(downloadPath, timeoutMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (fs.existsSync(downloadPath)) {
      const files = fs.readdirSync(downloadPath);
      const csvFile = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (csvFile) {
        return path.join(downloadPath, csvFile);
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
  const fileContent = fs.readFileSync(csvFilePath, 'utf-8');

  const records = parse(fileContent, {
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (records.length <= 1) {
    console.log('⚠️ ไม่พบแถวข้อมูลใหม่ในไฟล์ CSV');
    return;
  }

  // ข้ามแถวที่ 1 (Header) เพราะในชีทมีหัวตารางอยู่แล้ว
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
 * สั่งล้างฟิลเตอร์ใน Pivot Table หน้าชีท "สรุป" ตรงฟิลด์ "วันที่ตามกะงาน"
 */
async function resetPivotTableDateFilter(sheets) {
  console.log(`🔄 กำลังตรวจสอบและล้างฟิลเตอร์ใน Pivot Table หน้าชีท "${SUMMARY_SHEET_NAME}"...`);

  const res = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets(properties,data.rowData.values.pivotTable)',
  });

  const summarySheet = res.data.sheets.find(s => s.properties.title === SUMMARY_SHEET_NAME);
  if (!summarySheet || !summarySheet.data) {
    console.log(`⚠️ ไม่พบข้อมูลชีท "${SUMMARY_SHEET_NAME}"`);
    return;
  }

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
          let modified = false;

          // ลบ criteria เก่าออกเพื่อให้เลือกแสดงข้อมูลวันที่ทั้งหมด
          if (pivot.criteria) {
            for (const colIndex of Object.keys(pivot.criteria)) {
              delete pivot.criteria[colIndex];
              modified = true;
            }
          }

          if (pivot.filterSpecs && pivot.filterSpecs.length > 0) {
            pivot.filterSpecs = [];
            modified = true;
          }

          if (modified) {
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
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests },
    });
    console.log(`✅ ล้างฟิลเตอร์ใน Pivot Table เรียบร้อยแล้ว (แสดงวันที่ทั้งหมดอัตโนมัติ)`);
  } else {
    console.log(`ℹ️ Pivot Table เปิดแสดงข้อมูลทั้งหมดอยู่แล้ว`);
  }
}

/**
 * ฟังก์ชันหลักในการรัน Process ทั้งหมด
 */
async function main() {
  try {
    console.log('=== เริ่มต้นกระบวนการ Automation ===');
    const sheets = getGoogleSheetsClient();

    // ขั้นตอนที่ 1: ดึงไฟล์ CSV
    const csvFilePath = await runBot();

    // ขั้นตอนที่ 2: นำข้อมูลไปต่อท้ายในชีท "ข้อมูล"
    await appendDataToSheet(sheets, csvFilePath);

    // ขั้นตอนที่ 3: ล้างฟิลเตอร์ Pivot Table ในชีท "สรุป"
    await resetPivotTableDateFilter(sheets);

    // ล้างไฟล์ดาวน์โหลดชั่วคราว
    fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
    console.log('🎉 เสร็จสิ้นกระบวนการทำงานทุกขั้นตอนเรียบร้อย 100%');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err);
    process.exit(1);
  }
}

main();

