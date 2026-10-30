/**
 * A venue drawing made ready to trace over (section 10, phase B), in the
 * browser: a PDF page is drawn into an image with pdfjs-dist (already used by
 * the certificate editor, worker self-hosted at /pdfjs/), and an image larger
 * than needed is scaled down. The server then only ever stores images.
 *
 * Browser only: it uses canvas, and imports pdfjs-dist on demand so the plan
 * editor's bundle does not carry it until a PDF is chosen.
 */
import { DRAWING_LONG_SIDE, MAX_DRAWING_BYTES } from "./underlay";

export interface DrawingImage {
  file: File;
  px: [number, number];
  /** Pages in the PDF (1 for an image), so the editor can offer another page. */
  pages: number;
}

const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

/** A file name short enough for the plan (120 characters), its extension kept (review MED: a longer one made the plan unsaveable). */
export function drawingName(name: string): string {
  if (name.length <= 120) return name;
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(name)?.[0] ?? "";
  return name.slice(0, 120 - ext.length) + ext;
}

/** The file name with a new extension: "Conrad 2F.pdf" page 2 becomes "Conrad 2F, page 2.jpg". */
function renamed(name: string, ext: string, page?: number): string {
  const base = name.replace(/\.[^.]+$/, "").slice(0, 100) || "Venue drawing";
  return `${base}${page && page > 1 ? `, page ${page}` : ""}.${ext}`;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The drawing could not be turned into an image"))), type, quality));
}

/**
 * A white-backed JPEG of the canvas, as small as needed to fit the upload limit: a CAD export full of colour
 * can be large, so the quality steps down before giving up.
 */
async function fitBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const q of [0.9, 0.8, 0.65]) {
    const blob = await toBlob(canvas, "image/jpeg", q);
    if (blob.size <= MAX_DRAWING_BYTES) return blob;
  }
  throw new Error("The drawing is too detailed to upload. Try exporting it as a smaller image.");
}

function whiteCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw the image");
  // A PDF page or a PNG can be see-through; on the plan, white reads as paper.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  return { canvas, ctx };
}

/** Page `page` of a PDF (1-based), drawn so its longest side is DRAWING_LONG_SIDE pixels. */
async function fromPdf(file: File, page: number): Promise<DrawingImage> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const p = await pdf.getPage(Math.min(Math.max(1, page), pdf.numPages));
    const base = p.getViewport({ scale: 1 });
    const viewport = p.getViewport({ scale: DRAWING_LONG_SIDE / Math.max(base.width, base.height) });
    const { canvas, ctx } = whiteCanvas(Math.round(viewport.width), Math.round(viewport.height));
    await p.render({ canvasContext: ctx, viewport }).promise;
    const blob = await fitBlob(canvas);
    return { file: new File([blob], renamed(file.name, "jpg", page), { type: "image/jpeg" }), px: [canvas.width, canvas.height], pages: pdf.numPages };
  } finally {
    await pdf.destroy();
  }
}

/** An image as it is when it is small enough, else scaled down to DRAWING_LONG_SIDE. */
async function fromImage(file: File): Promise<DrawingImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (long <= DRAWING_LONG_SIDE * 1.5 && file.size <= MAX_DRAWING_BYTES && /^image\/(png|jpeg|webp)$/.test(file.type)) {
      return { file, px: [bitmap.width, bitmap.height], pages: 1 };
    }
    const k = Math.min(1, DRAWING_LONG_SIDE / long);
    const { canvas, ctx } = whiteCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await fitBlob(canvas);
    return { file: new File([blob], renamed(file.name, "jpg"), { type: "image/jpeg" }), px: [canvas.width, canvas.height], pages: 1 };
  } finally {
    bitmap.close();
  }
}

/** The drawing as an image ready to upload: a PDF's page `page`, or the image itself. */
export function prepareDrawing(file: File, page = 1): Promise<DrawingImage> {
  return isPdf(file) ? fromPdf(file, page) : fromImage(file);
}
