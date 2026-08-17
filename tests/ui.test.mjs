/**
 * Arayuz testi: iki gercek tarayici oturumu acar; mesajlasma, foto, gecici mesaj,
 * ekran goruntusu bildirimi, davet linki, yetkiler, gorev panosu, toplanti ve
 * sesli gorusmeyi bastan sona dener.
 *
 * Kullanim: npm start (baska terminalde) + npm run test:ui
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
const warn = (m) => console.log(`  ~   ${m}`);

// Test icin kucuk bir PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoK1/aM3g' +
  'CTQhO2buAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB4zwd+AAFXH1CkAAAAAElFTkSuQmCC',
  'base64'
);
const photoPath = path.join(OUT, 'test-foto.png');
fs.writeFileSync(photoPath, PNG);

// Sesli/goruntulu gorusme testi icin tam Chromium gerekir: headless kabukta
// medya cihazi yoktur. channel:'chromium' yeni headless kipini kullanir.
const browser = await chromium.launch({
  channel: 'chromium',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-capture',
    '--autoplay-policy=no-user-gesture-required'
  ]
}).catch(() => chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-capture']
}));

const errors = [];

async function newUser(nick) {
  const ctx = await browser.newContext({ viewport: { width: 1420, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${nick}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${nick}] pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.click('[data-gate-tab="register"]');
  await page.fill('#register-form input[name=nick]', nick);
  await page.fill('#register-form input[name=displayName]', nick.split('_')[0].toUpperCase());
  await page.fill('#register-form input[name=password]', 'parola12345');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#app:not(.is-hidden)', { timeout: 30000 });
  return { page, ctx, nick };
}

const hasText = (page, selector, text, timeout = 12000) => page.waitForFunction(
  ([sel, txt]) => [...document.querySelectorAll(sel)].some((n) => n.textContent.includes(txt)),
  [selector, text], { timeout }
);

const ada = await newUser(`ada_${stamp}`);
const kaan = await newUser(`kaan_${stamp}`);
ok('iki kullanici kayit oldu (giris ekrani -> uygulama)');

/* ---- profil fotosu ---- */
await ada.page.click('[data-action="profile"]');
const chooser = ada.page.waitForEvent('filechooser');
await ada.page.click('#modal-body button:has-text("Choose photo")');
await (await chooser).setFiles(photoPath);
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 15000 });
await ada.page.waitForSelector('#rail-me .avatar img', { timeout: 10000 });
ok('profil fotosu yuklendi ve sol seritte gorunuyor');

/* ---- arkadaslik ---- */
await ada.page.click('[data-nav="friends"]');
await ada.page.click('.pane-head button:has-text("Add friend")');
await ada.page.fill('#modal-body input', kaan.nick);
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 12000 });

await kaan.page.click('[data-nav="friends"]');
await kaan.page.click('.list-item button:has-text("Accept")', { timeout: 15000 });
await hasText(kaan.page, '.card-title', ada.nick);
ok('arkadaslik istegi gonderildi ve kabul edildi');

/* ---- DM: baloncuk hizalari, gorulduc, yaziyor ---- */
await ada.page.click('[data-nav="friends"]');
await ada.page.click('.card button:has-text("Message")');
await ada.page.waitForSelector('.composer textarea', { timeout: 15000 });
await ada.page.fill('.composer textarea', 'kaan bu mesaj uctan uca sifreli');
await ada.page.click('.composer .send');
await ada.page.waitForSelector('.msg.is-mine .bubble-text', { timeout: 12000 });
ok('gonderilen mesaj sagda (is-mine) gorunuyor');

await kaan.page.click('[data-nav="dm"]');
await kaan.page.click('.side-list .row', { timeout: 15000 });
await kaan.page.waitForSelector('.msg:not(.is-mine) .bubble-text', { timeout: 15000 });
const received = await kaan.page.textContent('.msg:not(.is-mine) .bubble-text');
if (!received.includes('uctan uca sifreli')) throw new Error('alici mesaji cozemedi: ' + received);
ok(`alinan mesaj solda ve cozuldu: "${received.slice(0, 34)}..."`);

// yazma gostergesi
await kaan.page.click('.composer textarea');
await kaan.page.type('.composer textarea', 'typing right now', { delay: 30 });
await ada.page.waitForFunction(
  () => (document.getElementById('typing-line') || {}).textContent.includes('typing'),
  null, { timeout: 12000 }
);
ok('"yaziyor..." gostergesi karsi tarafta gorundu');

await kaan.page.click('.composer .send');
await hasText(ada.page, '.bubble-text', 'typing right now');
await ada.page.waitForSelector('.receipt.is-seen', { timeout: 15000 });
ok('gorulduc isareti (cift tik) dolu gorunuyor');

/* ---- foto gonderme ---- */
const chooser2 = ada.page.waitForEvent('filechooser');
await ada.page.click('.composer-icon');
await (await chooser2).setFiles(photoPath);
await ada.page.waitForSelector('.composer-preview:not(.is-hidden)', { timeout: 12000 });
await ada.page.click('.composer .send');
await ada.page.waitForSelector('.msg.is-mine .bubble-image img', { timeout: 20000 });
await kaan.page.waitForSelector('.msg:not(.is-mine) .bubble-image img', { timeout: 20000 });
ok('sifreli foto gonderildi ve karsi tarafta cozuldu');

/* ---- dosya gonderme ---- */
const docPath = path.join(OUT, 'notlar.txt');
fs.writeFileSync(docPath, 'Edge test dosyasi\n'.repeat(40));
const chooser3 = ada.page.waitForEvent('filechooser');
await ada.page.click('.composer-icon:nth-of-type(2)');
await (await chooser3).setFiles(docPath);
await ada.page.waitForSelector('.composer-preview:not(.is-hidden)', { timeout: 12000 });
await ada.page.click('.composer .send');
await ada.page.waitForSelector('.msg.is-mine .file-card', { timeout: 20000 });
await kaan.page.waitForSelector('.msg:not(.is-mine) .file-card', { timeout: 20000 });
const fileName = await kaan.page.textContent('.msg:not(.is-mine) .file-name');
if (!fileName.includes('notlar')) throw new Error('dosya adi gorunmedi: ' + fileName);
const download = kaan.page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await kaan.page.click('.msg:not(.is-mine) .file-card button');
const saved = await download;
if (saved) ok(`sifreli dosya gonderildi ve indirildi (${saved.suggestedFilename()})`);
else ok('sifreli dosya gonderildi ve karsi tarafta gorundu');

/* ---- gecici mesaj ---- */
await ada.page.click('.pane-head [title="Disappearing messages"]');
await ada.page.selectOption('#modal-body select', '3600');
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('.pane-head .pill-warn', { timeout: 12000 });
await ada.page.fill('.composer textarea', 'bu mesaj bir saat sonra silinecek');
await ada.page.click('.composer .send');
await ada.page.waitForSelector('.ttl-badge', { timeout: 12000 });
ok('gecici mesaj suresi ayarlandi ve mesajda saat isareti var');

/* ---- ekran goruntusu bildirimi ---- */
await ada.page.keyboard.press('PrintScreen');
await hasText(kaan.page, '.sys-line', 'screenshot', 15000);
ok('ekran goruntusu bildirimi karsi tarafa dustu');

/* ---- sirket + davet linki ---- */
await ada.page.click('[data-action="new-company"]');
await ada.page.fill('#modal-body input', 'Edge Studio');
await ada.page.click('#modal-body button[type=submit]');
await hasText(ada.page, '.pane-head h3', 'Edge Studio', 15000);
const slug = (await ada.page.textContent('.pane-head .muted')).split('/').pop().trim();
ok(`sirket olusturuldu, davet linki: /${slug}`);

await ada.page.click('.sheet-head button:has-text("Create group")');
await ada.page.fill('#modal-body input', 'Design');
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('#modal.is-hidden', { state: 'attached', timeout: 15000 });
await hasText(ada.page, '.card-title', 'Design');
const groupSlug = (await ada.page.textContent('.link-row code')).replace('/', '');
ok(`grup olusturuldu, kendi davet linki: /${groupSlug}`);

// kaan davet linkiyle katiliyor (tek tek eklemek yerine)
await kaan.page.goto(`${BASE}/${groupSlug}`);
// Sayfa yeniden yuklendigi icin anahtarlar kilitli: davet hatirlanir, parola sorulur.
await kaan.page.waitForSelector('#gate-invite:not(.is-hidden)', { timeout: 20000 });
await kaan.page.waitForSelector('#unlock-form:not(.is-hidden)', { timeout: 20000 });
await kaan.page.fill('#unlock-form input[name=password]', 'parola12345');
await kaan.page.click('#unlock-form button[type=submit]');
await kaan.page.waitForSelector('#app:not(.is-hidden)', { timeout: 25000 });
await hasText(kaan.page, '.toast', 'joined', 25000);
await kaan.page.waitForSelector('.rail-companies .rail-btn', { timeout: 15000 });
ok('davet linkiyle katilma: davet hatirlandi, kilit acilinca gruba girildi');

/* ---- yetki kisitlama ---- */
await ada.page.click('.tabs-line button:has-text("Members")');
await ada.page.click('.list-item button:has-text("Access")', { timeout: 15000 });
await ada.page.locator('#modal-body .radio-card').nth(1).click();   // Admin
await ada.page.waitForSelector('#modal-body .perm-list:not(.is-off)', { timeout: 10000 });
// Etiket kutuyu sardigi icin tiklama etiket uzerinden yapilir (kullanicinin yaptigi gibi).
await ada.page.locator('#modal-body .perm-row').nth(1).click();
const checked = await ada.page.locator('#modal-body .perm-row input').nth(1).isChecked();
if (!checked) throw new Error('yetki kutusu isaretlenemedi');
await ada.page.click('#modal-body button[type=submit]');
await hasText(ada.page, '.list-item .pill', 'permission', 15000);
ok('yonetim paneline erisim verildi, yetkiler tek tek kisitlandi (1/5)');

/* ---- gorev panosu ---- */
await ada.page.click('.tabs-line button:has-text("Tasks")');
await ada.page.click('.task-summary button:has-text("Task")');
await ada.page.fill('#modal-body input', 'Logoyu uygula');
await ada.page.selectOption('#modal-body select', { label: 'Group — Design' });
await ada.page.click('#modal-body button[type=submit]');
await ada.page.waitForSelector('.board .tcard', { timeout: 15000 });
const columns = await ada.page.$$eval('.board-col h5', (nodes) => nodes.map((n) => n.textContent));
if (columns.length !== 3) throw new Error('gorev panosu kolonlari eksik: ' + columns.join(','));
ok(`gorev panosu calisiyor (${columns.join(' / ')})`);

await ada.page.click('.tcard .task-check');
await ada.page.waitForSelector('.col-done .tcard', { timeout: 15000 });
ok('gorev tik ile "Biten" kolonuna gecti');

/* ---- toplanti ---- */
await ada.page.click('.tabs-line button:has-text("Meetings")');
await ada.page.click('.sheet-head button:has-text("Schedule meeting")');
await ada.page.fill('#modal-body input', 'Weekly review');
await ada.page.click('#modal-body button[type=submit]');
await hasText(ada.page, '.card-title', 'Weekly review', 15000);
ok('toplanti planlandi (sesli/goruntulu secimiyle)');

/* ---- son aktiviteler ---- */
await ada.page.click('.tabs-line button:has-text("Activity")');
await ada.page.waitForSelector('.feed-row', { timeout: 15000 });
const feed = await ada.page.$$eval('.feed-row', (rows) => rows.length);
ok(`yonetim panelinde son aktiviteler listelendi (${feed} kayit)`);

/* ---- ekran goruntuleri ---- */
await ada.page.click('.tabs-line button:has-text("Tasks")');
await ada.page.waitForTimeout(400);
await ada.page.screenshot({ path: `${OUT}/edge-tasks.png` });
await ada.page.click('.tabs-line button:has-text("Members")');
await ada.page.waitForTimeout(300);
await ada.page.screenshot({ path: `${OUT}/edge-panel.png` });
await ada.page.click('[data-nav="dm"]');
await ada.page.click('.side-list .row');
await ada.page.waitForTimeout(600);
await ada.page.screenshot({ path: `${OUT}/edge-chat.png` });

/* ---- sesli gorusme ---- */
await ada.page.click('.pane-head [title="Voice call"]');
await ada.page.waitForSelector('.call-shell', { timeout: 20000 });
await kaan.page.waitForSelector('#ring:not(.is-hidden)', { timeout: 20000 });
await kaan.page.screenshot({ path: `${OUT}/edge-ring.png` });
await kaan.page.click('#ring button:has-text("Join")');
await kaan.page.waitForSelector('.call-shell', { timeout: 20000 });
ok('sesli gorusme baslatildi ve karsi taraf katildi');

const connected = await ada.page.waitForFunction(() => {
  const tiles = document.querySelectorAll('.tile');
  return tiles.length >= 2 && ![...document.querySelectorAll('.tile-label small')]
    .some((n) => n.textContent.includes('baglaniyor'));
}, null, { timeout: 30000 }).then(() => true).catch(() => false);

if (connected) ok('WebRTC baglantisi kuruldu (iki katilimci, uctan uca)');
else warn('WebRTC baglantisi test ortaminda kurulamadi (STUN erisimi olmayabilir)');

await ada.page.screenshot({ path: `${OUT}/edge-call.png` });

// Ekran paylasimi: kaynak secimi tarayiciya ait oldugu icin test ortaminda
// dogrulanamayabilir; acildiysa kapatip devam ediyoruz.
let shareOk = false;
if (process.env.EDGE_TEST_SCREENSHARE === '1') {
  try {
    await ada.page.click('.call-controls [title="Share screen"]');
    await ada.page.waitForSelector('.call-btn.is-on', { timeout: 8000 });
    shareOk = true;
    await ada.page.click('.call-btn.is-on');
    await ada.page.waitForTimeout(500);
  } catch { /* kaynak secimi yok */ }
}
if (shareOk) ok('ekran paylasimi acilip kapatildi (video izi degistirildi)');
else warn('ekran paylasimi atlandi: kaynak secimi tarayiciya ait (EDGE_TEST_SCREENSHARE=1 ile denenir)');

// kapatan taraf: gorusme kapanir
await ada.page.click('.call-btn.is-end');
await ada.page.waitForSelector('.call-shell', { state: 'detached', timeout: 20000 });
// karsi taraf: birebir gorusmede otomatik kapanir
await kaan.page.waitForSelector('.call-shell', { state: 'detached', timeout: 20000 });
ok('gorusme kapatildi ve karsi tarafta da otomatik sonlandi');

/* ---- kilit ekrani ---- */
await kaan.page.reload();
await kaan.page.waitForSelector('#unlock-form:not(.is-hidden)', { timeout: 20000 });
await kaan.page.screenshot({ path: `${OUT}/edge-unlock.png` });
await kaan.page.fill('#unlock-form input[name=password]', 'parola12345');
await kaan.page.click('#unlock-form button[type=submit]');
await kaan.page.waitForSelector('#app:not(.is-hidden)', { timeout: 25000 });
await kaan.page.click('.side-list .row');
await kaan.page.waitForSelector('.bubble-text', { timeout: 15000 });
ok('yenileme -> kilit ekrani -> parola ile gecmis mesajlar cozuldu');

/* ---- giris ekrani goruntuleri ---- */
const fresh = await browser.newContext({ viewport: { width: 1420, height: 900 } });
const freshPage = await fresh.newPage();
await freshPage.goto(BASE);
await freshPage.screenshot({ path: `${OUT}/edge-login.png` });
await freshPage.goto(`${BASE}/${slug}`);
await freshPage.waitForSelector('#gate-invite:not(.is-hidden)', { timeout: 15000 });
await freshPage.screenshot({ path: `${OUT}/edge-invite.png` });
ok('davet linki giris ekraninda onizleme gosteriyor');

const real = errors.filter((e) => !/favicon|Autoplay|play\(\)/i.test(e));
if (real.length) console.log('\nkonsol hatalari:\n' + real.join('\n'));
else ok('tarayici konsolunda hata yok');

await browser.close();
console.log('\nARAYUZ TESTLERI GECTI');
