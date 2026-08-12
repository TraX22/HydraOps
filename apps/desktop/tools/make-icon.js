/**
 * make-icon.js — genera el icono de la aplicación a partir del logo 🐙 que la
 * UI muestra junto al nombre en la barra lateral.
 *
 * Se renderiza con el propio Chromium de Electron en lugar de con una librería
 * de imagen porque así el emoji sale exactamente igual que en la interfaz
 * (GDI+ no dibuja emoji en color).
 *
 * Uso:  electron tools/make-icon.js
 * Salida: build/icon.png (512) y build/icon.ico (multi-resolución)
 */
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const OUT_DIR = path.join(__dirname, "..", "build");
const SIZE = 512;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const PAGE = `
<html><head><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;overflow:hidden;background:transparent;}
  body{display:flex;align-items:center;justify-content:center;}
  div{font-size:${Math.round(SIZE * 0.82)}px;line-height:1;
      font-family:'Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji',sans-serif;}
</style></head><body><div>🐙</div></body></html>`;

/**
 * Empaqueta varios PNG en un .ico. El formato admite PNG embebido desde Vista,
 * así que basta con la cabecera ICONDIR + una entrada por tamaño.
 */
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // 1 = icono
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  pngBuffers.forEach(({ size, data }, i) => {
    const e = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, e + 0); // 0 significa 256
    entries.writeUInt8(size >= 256 ? 0 : size, e + 1);
    entries.writeUInt8(0, e + 2);  // colores de paleta
    entries.writeUInt8(0, e + 3);  // reservado
    entries.writeUInt16LE(1, e + 4);   // planos
    entries.writeUInt16LE(32, e + 6);  // bits por píxel
    entries.writeUInt32LE(data.length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });

  return Buffer.concat([header, entries, ...pngBuffers.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: false },
  });

  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(PAGE));
  await new Promise((r) => setTimeout(r, 600)); // que asiente la fuente de emoji

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, "icon.png"), image.toPNG());

  const variants = ICO_SIZES.map((size) => ({
    size,
    data: image.resize({ width: size, height: size, quality: "best" }).toPNG(),
  }));
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), buildIco(variants));

  console.log(`icon.png (${SIZE}px) e icon.ico (${ICO_SIZES.join(", ")}) escritos en ${OUT_DIR}`);
  win.destroy();
  app.quit();
});
