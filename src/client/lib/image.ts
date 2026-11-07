// Prepares the jewellery photo in the browser: keeps the camera orientation
// (browsers apply EXIF orientation when drawing an <img>), keeps the aspect
// ratio, shrinks to at most 1600 px, and adds a caption strip BELOW the photo
// (so nothing in the picture — especially the scale reading — is covered).

export const MIN_SIDE = 480;
const MAX_SIDE = 1600;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface Annotation { lines: string[] }

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as a photo. Use a JPEG, PNG or HEIC photo from the camera.')); };
    img.src = url;
  });
}

export async function checkPhoto(file: File): Promise<{ width: number; height: number }> {
  if (!file.type.startsWith('image/')) throw new Error('Please choose a photo (image file).');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That photo is too large (over 25 MB).');
  const img = await loadImage(file);
  if (Math.min(img.naturalWidth, img.naturalHeight) < MIN_SIDE) throw new Error(`The photo is too small. It must be at least ${MIN_SIDE} pixels on its shortest side.`);
  return { width: img.naturalWidth, height: img.naturalHeight };
}

export async function annotatePhoto(file: File, a: Annotation): Promise<Blob> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const font = Math.max(16, Math.round(w / 42));
  const pad = Math.round(font * 0.7);
  const strip = pad * 2 + a.lines.length * Math.round(font * 1.35);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h + strip;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process photos.');
  ctx.drawImage(img, 0, 0, w, h);
  ctx.fillStyle = '#0f3b2e';
  ctx.fillRect(0, h, w, strip);
  ctx.fillStyle = '#d4af5a';
  ctx.fillRect(0, h, w, Math.max(2, Math.round(font / 8)));
  ctx.fillStyle = '#fbf8f1';
  ctx.textBaseline = 'top';
  a.lines.forEach((line, i) => {
    ctx.font = `${i === 0 ? '600 ' : ''}${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.fillText(line, pad, h + pad + i * Math.round(font * 1.35), w - pad * 2);
  });

  for (const quality of [0.85, 0.75, 0.6]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) throw new Error('The photo could not be prepared.');
    if (blob.size <= 4.5 * 1024 * 1024) return blob;
  }
  throw new Error('The photo is still too large after compression. Try again with a lower camera resolution.');
}
