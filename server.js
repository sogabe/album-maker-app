// 自己紹介アルバムメーカー — ローカル Web アプリ (ADR-0004)
// 状態は album.json と photos/ フォルダのみ。PDF はコンビニ入稿仕様 (ADR-0002)。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ROOT = __dirname;
const PHOTOS_DIR = path.join(ROOT, 'photos');
const CONVERTED_DIR = path.join(PHOTOS_DIR, '.converted'); // HEIC → JPEG 変換キャッシュ
const THUMBS_DIR = path.join(ROOT, '.thumbs');
const ALBUM_PATH = path.join(ROOT, 'album.json');
const PDF_PATH = path.join(ROOT, 'album.pdf');

const PORT = 5858;

// ---- 印刷仕様 (PrintSpec, ADR-0002 固定値) ----
const A4 = { w: 595.28, h: 841.89 }; // pt
const mm = (v) => (v * 72) / 25.4;
const MARGIN = mm(10); // 余白 5mm 以上の要件に対し 10mm で安全側
const DPI = 300;
const JPEG_QUALITY = 82;

// ---- 8ページ構成プリセット (ADR-0006) ----
const PRESET_PAGES = [
  { title: "Hello! I'm ...", photos: [] },
  { title: 'My Family', photos: [] },
  { title: 'My Town', photos: [] },
  { title: 'My Home', photos: [] },
  { title: 'My School', photos: [] },
  { title: 'My Hobbies', photos: [] },
  { title: 'My Favorites', photos: [] },
  { title: 'Thank You', photos: [] },
];

for (const dir of [PHOTOS_DIR, CONVERTED_DIR, THUMBS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---- アルバム定義 (album.json) ----
function loadAlbum() {
  try {
    return JSON.parse(fs.readFileSync(ALBUM_PATH, 'utf8'));
  } catch {
    const album = { pages: structuredClone(PRESET_PAGES) };
    saveAlbum(album);
    return album;
  }
}
function saveAlbum(album) {
  fs.writeFileSync(ALBUM_PATH, JSON.stringify(album, null, 2));
}

// ---- 写真フォルダ ----
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);

function listPhotos() {
  return fs
    .readdirSync(PHOTOS_DIR)
    .filter((f) => !f.startsWith('.') && IMAGE_EXTS.has(path.extname(f).toLowerCase()))
    .sort();
}

// HEIC は sharp が読めないため macOS 標準の sips で JPEG に変換してキャッシュする
function resolvePhotoPath(name) {
  const src = path.join(PHOTOS_DIR, path.basename(name));
  if (!fs.existsSync(src)) return null;
  const ext = path.extname(name).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') return src;
  const converted = path.join(CONVERTED_DIR, path.basename(name, ext) + '.jpg');
  if (!fs.existsSync(converted) || fs.statSync(converted).mtimeMs < fs.statSync(src).mtimeMs) {
    execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', converted], { stdio: 'ignore' });
  }
  return converted;
}

// ---- キャプション (ADR-0003: 短い英文のみ。Helvetica で表せない文字は落とす) ----
function sanitizeText(text) {
  return String(text || '').replace(/[^\x20-\x7E]/g, '').trim();
}

// ---- PDF 生成 ----
async function embedPhoto(pdfDoc, name, boxW, boxH) {
  const file = resolvePhotoPath(name);
  if (!file) return null;
  const pxW = Math.round((boxW / 72) * DPI);
  const pxH = Math.round((boxH / 72) * DPI);
  const buf = await sharp(file)
    .rotate() // EXIF の向きを反映
    .resize({ width: pxW, height: pxH, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
  return pdfDoc.embedJpg(buf);
}

function drawContain(page, img, box) {
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = box.x + (box.w - w) / 2;
  const y = box.y + (box.h - h) / 2;
  page.drawImage(img, { x, y, width: w, height: h });
  return { x, y, w, h };
}

function drawCenteredText(page, font, text, size, y, color) {
  let s = size;
  const maxW = A4.w - MARGIN * 2;
  while (s > 8 && font.widthOfTextAtSize(text, s) > maxW) s -= 1;
  const w = font.widthOfTextAtSize(text, s);
  page.drawText(text, { x: (A4.w - w) / 2, y, size: s, font, color });
}

// レイアウトは写真枚数から導出する (ADR-0005): 1枚 / 2段 / 2×2 グリッド
function photoBoxes(count, content) {
  const G = mm(6);
  if (count <= 1) {
    return [{ x: content.x, y: content.y, w: content.w, h: content.h }];
  }
  if (count === 2) {
    const h = (content.h - G) / 2;
    return [
      { x: content.x, y: content.y + h + G, w: content.w, h },
      { x: content.x, y: content.y, w: content.w, h },
    ];
  }
  const w = (content.w - G) / 2;
  const h = (content.h - G) / 2;
  return [
    { x: content.x, y: content.y + h + G, w, h },
    { x: content.x + w + G, y: content.y + h + G, w, h },
    { x: content.x, y: content.y, w, h },
    { x: content.x + w + G, y: content.y, w, h },
  ].slice(0, count);
}

async function buildPdf(album) {
  const pdfDoc = await PDFDocument.create();
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.15, 0.15, 0.2);
  const sub = rgb(0.35, 0.35, 0.42);
  let photoCount = 0;

  for (const pageDef of album.pages) {
    const page = pdfDoc.addPage([A4.w, A4.h]);
    const title = sanitizeText(pageDef.title);
    const titleY = A4.h - MARGIN - 26;
    if (title) drawCenteredText(page, fontBold, title, 26, titleY, ink);

    const photos = (pageDef.photos || []).slice(0, 4);
    const captionH = photos.length <= 1 ? 30 : photos.length === 2 ? 22 : 18;
    const capSize = photos.length <= 1 ? 14 : photos.length === 2 ? 11 : 9;
    const content = {
      x: MARGIN,
      y: MARGIN,
      w: A4.w - MARGIN * 2,
      h: titleY - mm(4) - MARGIN,
    };
    const boxes = photoBoxes(photos.length, content);

    for (let i = 0; i < photos.length; i++) {
      const { file, caption } = photos[i];
      const box = boxes[i];
      const imgBox = { x: box.x, y: box.y + captionH, w: box.w, h: box.h - captionH };
      const img = await embedPhoto(pdfDoc, file, imgBox.w, imgBox.h);
      if (!img) continue;
      const drawn = drawContain(page, img, imgBox);
      photoCount++;
      const cap = sanitizeText(caption);
      if (cap) {
        let s = capSize;
        while (s > 7 && font.widthOfTextAtSize(cap, s) > box.w) s -= 1;
        const w = font.widthOfTextAtSize(cap, s);
        // キャプションは描画された写真のすぐ下に置く(セル最下部だと写真と離れる)
        const capY = Math.max(box.y, drawn.y - s - 6);
        page.drawText(cap, { x: box.x + (box.w - w) / 2, y: capY, size: s, font, color: sub });
      }
    }
  }

  const bytes = await pdfDoc.save();
  fs.writeFileSync(PDF_PATH, bytes);
  return { pages: album.pages.length, photoCount, bytes: bytes.length };
}

// ---- HTTP ----
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/state', (req, res) => {
  const album = loadAlbum();
  const photos = listPhotos();
  const known = new Set(photos);
  const missing = [];
  for (const p of album.pages) {
    for (const ph of p.photos || []) {
      if (!known.has(ph.file)) missing.push(ph.file);
    }
  }
  res.json({ album, photos, missing });
});

app.put('/api/album', (req, res) => {
  const album = req.body;
  if (!album || !Array.isArray(album.pages)) {
    return res.status(400).json({ error: 'pages が必要です' });
  }
  for (const p of album.pages) {
    p.title = String(p.title || '');
    p.photos = (p.photos || []).slice(0, 4).map((ph) => ({
      file: path.basename(String(ph.file || '')),
      caption: String(ph.caption || ''),
    }));
  }
  saveAlbum(album);
  res.json({ ok: true });
});

app.get('/api/thumb/:name', async (req, res) => {
  try {
    const name = path.basename(req.params.name);
    const src = resolvePhotoPath(name);
    if (!src) return res.status(404).end();
    const thumb = path.join(THUMBS_DIR, name.replace(/\.[^.]+$/, '') + '.jpg');
    if (!fs.existsSync(thumb) || fs.statSync(thumb).mtimeMs < fs.statSync(src).mtimeMs) {
      await sharp(src).rotate().resize({ width: 480, withoutEnlargement: true }).jpeg({ quality: 75 }).toFile(thumb);
    }
    res.sendFile(thumb, { dotfiles: 'allow' });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.post('/api/pdf', async (req, res) => {
  try {
    const result = await buildPdf(loadAlbum());
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/album.pdf', (req, res) => {
  if (!fs.existsSync(PDF_PATH)) return res.status(404).send('まだ PDF がありません');
  res.sendFile(PDF_PATH);
});

app.listen(PORT, () => {
  console.log(`アルバムメーカー起動: http://localhost:${PORT}`);
  console.log(`写真フォルダ: ${PHOTOS_DIR}`);
});
