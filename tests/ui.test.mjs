/** Gercek tarayicida iki kullanici acip arayuzu ve E2EE mesajlasmayi dener. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// playwright yerelde ya da global kurulumda olabilir
let chromium;
for (const mod of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(mod)); break; } catch { /* sonrakini dene */ }
}
if (!chromium) {
  console.error('playwright bulunamadi: npm i -D playwright');
  process.exit(1);
}

const BASE = process.env.EDGE_URL || 'http://127.0.0.1:3000';
const OUT = process.env.EDGE_SHOTS || path.join(os.tmpdir(), 'edge-shots');
fs.mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36);
const ok = (m) => console.log(`  ok  ${m}`);

const browser = await chromium.launch();

async function newUser(nick) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(BASE);
  await page.click('[data-gate-tab="register"]');
  await page.fill('#register-form input[name=nick]', nick);
  await page.fill('#register-form input[name=displayName]', nick.split('_')[0].toUpperCase());
  await page.fill('#register-form input[name=password]', 'parola12345');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#app:not(.is-hidden)', { timeout: 25000 });
  return { page, errors, nick };
}

const ada = await newUser(`ada_${stamp}`);
const kaan = await newUser(`kaan_${stamp}`);
ok('iki kullanici kayit oldu, uygulama acildi');

// Ada -> Kaan DM
await ada.page.click('[data-action="new-dm"]');
await ada.page.fill('#modal-body input', kaan.nick);
await ada.page.waitForSelector(`#modal-body .check-row`, { timeout: 8000 });
await ada.page.click('#modal-body .check-row');
await ada.page.waitForSelector('.composer textarea', { timeout: 8000 });
await ada.page.fill('.composer textarea', 'kaan bu mesaj uctan uca sifreli, sunucu okuyamaz');
await ada.page.click('.composer .send');
await ada.page.waitForSelector('.msg-text', { timeout: 8000 });
ok('DM gonderildi (gonderende gorunuyor)');

// Kaan tarafinda canli geldi mi?
await kaan.page.waitForSelector('.side-list .row', { timeout: 10000 });
await kaan.page.click('.side-list .row');
await kaan.page.waitForSelector('.msg-text', { timeout: 10000 });
const received = await kaan.page.textContent('.msg-text');
if (!received.includes('uctan uca sifreli')) throw new Error('alici mesaji cozemedi: ' + received);
ok('mesaj karsi tarafta canli cozuldu: "' + received.slice(0, 40) + '..."');

// Kaan yanit yaziyor -> yazma gostergesi + iki yon
await kaan.page.fill('.composer textarea', 'aldim, tema de guzel olmus');
await kaan.page.click('.composer .send');
await ada.page.waitForFunction(
  () => [...document.querySelectorAll('.msg-text')].some((n) => n.textContent.includes('tema de guzel')),
  null, { timeout: 10000 }
);
ok('iki yonlu mesajlasma calisiyor');

// Sirket + grup + gorev akisi (Ada)
await ada.page.click('[data-action="new-company"]');
await ada.page.fill('#modal-body input', 'Edge Studio');
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('.pane-head h3:text("Edge Studio")', { timeout: 10000 });
ok('sirket olusturuldu');

await ada.page.click('.side-list .row:has-text("Uye ekle")');
await ada.page.fill('#modal-body input', kaan.nick);
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 10000 });
ok('sirkete uye eklendi');

await ada.page.click('.side-list .row:has-text("Grup olustur")');
await ada.page.fill('#modal-body input', 'Tasarim');
const boxes = await ada.page.$$('#modal-body .check-row input:not([disabled])');
for (const b of boxes) await b.check();
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 10000 });
await ada.page.waitForSelector('.side-list .row:has-text("Tasarim")', { timeout: 10000 });
ok('grup olusturuldu ve kanal listede');

await ada.page.click('.side-list .row:has-text("Gorev olustur")');
await ada.page.fill('#modal-body input', 'Logoyu uygula');
await ada.page.selectOption('#modal-body select', { label: 'Grup — Tasarim' });
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 10000 });
await ada.page.waitForSelector('.card-title:text("Logoyu uygula")', { timeout: 10000 });
ok('gruba gorev atandi');

// Kaan gorevi "Gorevlerim"de gormeli
await kaan.page.click('[data-nav="tasks"]');
await kaan.page.waitForSelector('.card-title:text("Logoyu uygula")', { timeout: 12000 });
ok('gorev atanan kisinin Gorevlerim ekraninda gorundu');
await kaan.page.click('.task-check');
// bitti isaretlenince "Acik gorevler" filtresinden dusmeli
await kaan.page.waitForFunction(
  () => !document.querySelector('.card-title'), null, { timeout: 10000 }
);
await kaan.page.click('.side-list .row:has-text("Bitenler")');
await kaan.page.waitForSelector('.task.is-done .card-title:text("Logoyu uygula")', { timeout: 10000 });
ok('atanan kisi gorevi bitti isaretledi (filtreler dogru)');

// grup sohbeti
await ada.page.click('.side-list .row:has-text("Tasarim")');
await ada.page.fill('.composer textarea', 'ekip, toplanti 15:00');
await ada.page.click('.composer .send');
await ada.page.waitForFunction(
  () => [...document.querySelectorAll('.msg-text')].some((n) => n.textContent.includes('toplanti 15:00')),
  null, { timeout: 10000 }
);
ok('grup kanalinda mesaj gonderildi');

// ekran goruntuleri
await ada.page.screenshot({ path: `${OUT}/edge-chat.png` });
await ada.page.click('.side-list .row:has-text("Sirket paneli")');
await ada.page.waitForSelector('.tabs-line', { timeout: 8000 });
await ada.page.screenshot({ path: `${OUT}/edge-company.png` });
await ada.page.click('.tabs-line button:has-text("Gorevler")');
await ada.page.waitForTimeout(400);
await ada.page.screenshot({ path: `${OUT}/edge-tasks.png` });
await kaan.page.click('[data-nav="dm"]');
await kaan.page.waitForTimeout(400);
await kaan.page.screenshot({ path: `${OUT}/edge-dm.png` });

// kilit ekrani: sayfa yenilendiginde parola sorulmali
await kaan.page.reload();
await kaan.page.waitForSelector('#unlock-form:not(.is-hidden)', { timeout: 10000 });
await kaan.page.screenshot({ path: `${OUT}/edge-unlock.png` });
await kaan.page.fill('#unlock-form input[name=password]', 'parola12345');
await kaan.page.click('#unlock-form button[type=submit]');
await kaan.page.waitForSelector('#app:not(.is-hidden)', { timeout: 20000 });
await kaan.page.click('.side-list .row');
await kaan.page.waitForSelector('.msg-text', { timeout: 10000 });
const afterUnlock = await kaan.page.textContent('.msg-text');
if (!afterUnlock.includes('uctan uca')) throw new Error('kilit acildiktan sonra gecmis cozulemedi');
ok('yenileme -> kilit ekrani -> parola ile gecmis mesajlar cozuldu');

// giris ekrani goruntusu
const fresh = await browser.newContext({ viewport: { width: 1360, height: 880 } });
const freshPage = await fresh.newPage();
await freshPage.goto(BASE);
await freshPage.screenshot({ path: `${OUT}/edge-login.png` });

const allErrors = [...ada.errors, ...kaan.errors].filter((e) => !/favicon/i.test(e));
if (allErrors.length) console.log('\nkonsol hatalari:\n' + allErrors.join('\n'));
else ok('tarayici konsolunda hata yok');

await browser.close();
console.log('\nARAYUZ TESTLERI GECTI');
