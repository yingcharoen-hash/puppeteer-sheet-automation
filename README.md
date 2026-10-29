# Puppeteer Google Sheets Daily Automation Bot

ระบบ Automation ด้วย Node.js (Puppeteer) เพื่อส่งออกข้อมูล CSV จากเว็บและนำเข้า Google Sheets พร้อมล้างฟิลเตอร์ Pivot Table ทุกเช้าเวลา 07.00 น. ผ่าน GitHub Actions

## สเปรดชีตเป้าหมาย
- **Spreadsheet ID:** `1Dts7FA1GIN-8-uNSMjwUod2p1TmYwwq-Ngj9rYbJk94`
- **ชีทข้อมูลดิบ:** `ข้อมูล`
- **ชีท Pivot Table:** `สรุป` (ฟิลด์: `วันที่ตามกะงาน`)

## GitHub Secrets ที่ต้องตั้งค่า
1. `WEB_EMAIL`: อีเมลสำหรับเข้าสู่ระบบเว็บ
2. `WEB_PASSWORD`: รหัสผ่านเข้าสู่ระบบเว็บ
3. `GOOGLE_SERVICE_ACCOUNT_KEY`: เนื้อหาของไฟล์ JSON Service Account จาก Google Cloud

## การตั้งค่าสิทธิ์ Google Sheet
- เพิ่มอีเมล `client_email` ของ Google Service Account ในสเปรดชีตด้วยสิทธิ์ **Editor**
