/**
 * Gorsel isleri ve ekran goruntusu sezgisi.
 * Fotolar gonderilmeden once tarayicida kucultulur; boylece sifreli ek kucuk kalir.
 */

export function pickFile(accept = 'image/*') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image.')); };
    img.src = url;
  });
}

function drawScaled(img, maxSide, square = false) {
  const canvas = document.createElement('canvas');
  let { naturalWidth: w, naturalHeight: h } = img;

  if (square) {
    const side = Math.min(w, h);
    canvas.width = canvas.height = Math.min(maxSide, side);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  const scale = Math.min(1, maxSide / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas, type, quality) =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

/** Profil fotosu / sirket logosu: kare, 128 piksel, kucuk webp. */
export async function toAvatarDataUrl(file) {
  const img = await loadImage(file);
  const canvas = drawScaled(img, 128, true);
  for (const quality of [0.82, 0.7, 0.6, 0.45]) {
    const blob = await toBlob(canvas, 'image/webp', quality);
    if (!blob) break;
    const dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length <= 58000) return dataUrl;
  }
  const jpeg = await toBlob(canvas, 'image/jpeg', 0.6);
  return blobToDataUrl(jpeg);
}

/** Sohbet fotosu: en uzun kenar 1600 piksel, jpeg. */
export async function toChatImage(file) {
  const img = await loadImage(file);
  const canvas = drawScaled(img, 1600);
  let blob = await toBlob(canvas, 'image/jpeg', 0.85);
  if (blob && blob.size > 3_500_000) blob = await toBlob(drawScaled(img, 1200), 'image/jpeg', 0.75);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    bytes, mime: 'image/jpeg', name: file.name || 'photo.jpg',
    size: bytes.byteLength, width: canvas.width, height: canvas.height, kind: 'image'
  };
}

/** Herhangi bir dosya: kucultme yok, oldugu gibi sifrelenir. */
export async function toAttachment(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > 4_000_000) {
    throw new Error('File is too large (4 MB max).');
  }
  return {
    bytes,
    mime: file.type || 'application/octet-stream',
    name: file.name || 'file',
    size: bytes.byteLength,
    width: 0,
    height: 0,
    kind: 'file'
  };
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(blob);
  });
}

export function bytesToObjectUrl(bytes, mime) {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

export function bytesToBase64(bytes) {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

export function base64ToBytes(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Ekran goruntusu sezgisi — bilincli olarak "en iyi caba".
 * Tarayicilar ekran goruntusu alindigini uygulamaya bildirmez. Yakalanabilen
 * durumlar: PrintScreen tusu, macOS Cmd+Shift+3/4/5 kisayollari ve sayfanin
 * ekran paylasimina alinmasi. Telefonla fotograf cekmek gibi yollar
 * algilanamaz; bu yuzden ozellik caydirici bir uyari olarak sunulur.
 */
export function watchScreenshots(onDetect) {
  const fire = (how) => { try { onDetect(how); } catch (err) { console.error(err); } };

  const onKey = (e) => {
    const key = e.key || '';
    if (key === 'PrintScreen' || e.code === 'PrintScreen') fire('printscreen');
    else if (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(key)) fire('macos');
    else if (e.metaKey && key === 'PrintScreen') fire('printscreen');
  };

  window.addEventListener('keyup', onKey, true);
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('keydown', onKey, true);
  };
}
