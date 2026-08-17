# Edge

Uctan uca sifreli, koyu ve minimal temali ekip mesajlasma platformu.
Harici bir servise baglanmaz — sunucu, veritabani ve sifreleme tamamen bu depoda.

## Neler var

- **Nick ile hesap.** Herkes kendi nickini secer (`3-24` karakter). Parola sunucuya
  hicbir zaman gonderilmez.
- **Uctan uca sifreli mesajlasma.** Birebir sohbetler ve grup kanallari; sifreleme
  ve cozme yalnizca tarayicida olur.
- **Sirket olusturma.** Sirketi kuran kisi sahibi olur; uye ekler, rol verir
  (sahip / yonetici / uye).
- **Sirket ici gruplar.** Her grup kendi sifreli sohbet kanalini alir.
- **Gorev atama.** Gorev bir kisiye **veya** bir gruba atanir; oncelik, son tarih ve
  durum (yapilacak / devam / bitti) tutulur. "Gorevlerim" ekrani sana ve uyesi
  oldugun gruplara atanan her seyi bir arada gosterir.
- **Canli akis.** Mesajlar, gorev degisiklikleri, cevrimici durumu ve "yaziyor..."
  gostergesi WebSocket uzerinden aninda gelir.
- **Koyu, ferah arayuz.** Tek vurgu rengi, ince cizgiler, ic ice menu yok: sol serit
  (kimlik + sirketler), orta liste (sohbetler / kanallar), ana panel (sohbet veya
  sirket paneli).

## Kurulum

```bash
npm install
npm start           # http://localhost:3000
```

`PORT` ile portu, `EDGE_DATA_DIR` ile veritabani klasorunu degistirebilirsin.
Veritabani ilk caliştirmada `data/edge.db` olarak kendi kendine olusur.

Gelistirme icin: `npm run dev` (dosya degisiminde yeniden baslar).

## Sifreleme nasil calisiyor

| Adim | Ne oluyor |
| --- | --- |
| Kayit | Tarayicida ECDH P-256 kimlik anahtari uretilir. Acik anahtar sunucuya gider; gizli anahtar `PBKDF2(parola, tuz, 250k)` ile turetilen anahtarla AES-GCM zarfina konur ve **sifreli** olarak saklanir. |
| Giris | Sunucuya parola degil `PBKDF2(parola, "edge-auth\|nick")` turevi gonderilir; sunucu onu ayrica tuzlayip `scrypt` ile dogrular. Gizli anahtar zarfi indirilip yerelde acilir. |
| Mesaj gonderme | Her mesaj icin rastgele AES-256-GCM anahtari uretilir. Icerik onunla sifrelenir; anahtar, her alici icin `ECDH + HKDF-SHA256` ile turetilen ortak sirla ayri ayri sarilir. |
| Mesaj okuma | Alici kendi zarfini acar, mesaj anahtarini cikarir ve icerigi cozer. |
| Dogrulama | Profil ve sohbet ekranindaki **parmak izi** (acik anahtarin SHA-256 ozeti) baska bir kanaldan karsilastirilarak kimlik dogrulanabilir. |

Sunucunun gordugu tek sey sifreli govde ve zarflar; icerigi acacak anahtar hicbir
zaman sunucuya gitmez. Sayfa yenilendiginde anahtarlar bellekten silinir, bu yuzden
parola ile "kilit acma" ekrani gelir.

**Bilincli sinirlar:** gorev basliklari, sirket/grup adlari ve nickler sunucuda duz
metin tutulur (listeleme, filtreleme ve yetki kontrolu bunlar uzerinden yapilir).
Sifreli olan sey mesaj icerigidir. Gruba sonradan katilan biri, katilmadan onceki
mesajlari cozemez.

## Mimari

```
server/
  index.js     express + statik dosyalar + WebSocket baglantisi
  db.js        SQLite semasi (kullanici, sirket, grup, sohbet, mesaj, gorev)
  auth.js      kayit / giris / oturum dogrulama
  api.js       sirket, grup, sohbet, mesaj ve gorev uc noktalari
  realtime.js  WebSocket dagitimi (mesaj, gorev, presence, yaziyor)
  util.js      kimlik uretimi, scrypt, dogrulama yardimcilari
public/
  index.html   uygulama iskeleti (giris ekrani + uc kolonlu kabuk)
  styles.css   koyu tema
  crypto.js    uctan uca sifreleme katmani (Web Crypto)
  net.js       REST istekleri + WebSocket istemcisi
  dom.js       kucuk DOM/ikon/tarih yardimcilari
  app.js       arayuz mantigi (sohbet, sirket paneli, gorevler, diyaloglar)
  logo.svg     Edge logosu
```

Sunucu icerik guvenligi politikasi (CSP) ile calisir: harici script, stil veya font
yuklenmez; her sey ayni kaynaktan servis edilir.

## Uc noktalar (ozet)

| Yontem | Yol | Aciklama |
| --- | --- | --- |
| `POST` | `/auth/register`, `/auth/login`, `/auth/logout` | hesap ve oturum |
| `GET` | `/auth/params/:nick` | giris icin KDF parametreleri |
| `GET/PATCH` | `/api/me` | profil |
| `GET` | `/api/users?q=` | nick ile kullanici arama |
| `GET/POST` | `/api/companies` | sirket listesi / olusturma |
| `GET/PATCH/DELETE` | `/api/companies/:id` | sirket detayi ve yonetimi |
| `POST/PATCH/DELETE` | `/api/companies/:id/members[/:userId]` | uye ve rol yonetimi |
| `POST` | `/api/companies/:id/groups` | grup olusturma |
| `PATCH/DELETE` | `/api/groups/:id` | grup duzenleme / silme |
| `POST/DELETE` | `/api/groups/:id/members[/:userId]` | grup uyeligi |
| `GET` | `/api/conversations` | sohbet listesi (okunmamis sayisiyla) |
| `POST` | `/api/conversations/dm` | birebir sohbet ac |
| `GET/POST` | `/api/conversations/:id/messages` | sifreli mesajlar |
| `POST` | `/api/companies/:id/tasks` | gorev olusturma |
| `GET` | `/api/tasks/mine` | sana ve gruplarina atanan gorevler |
| `PATCH/DELETE` | `/api/tasks/:id` | gorev guncelleme / silme |

Yetki kurallari: sirket sahibi her seyi yapar; yoneticiler uye/grup/gorev yonetir;
uyeler kendilerine (veya grubuna) atanan gorevin durumunu degistirebilir.
