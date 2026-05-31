/*
 * Peeky freeze-frame region selector (its own fullscreen window: capture.html).
 *
 * Flow: the Rust side froze the whole screen and parked it, then showed this
 * window sized to the full logical screen and emitted `peeky://region-init`. We
 * fetch the frozen frame (`get_region_shot`), show it dimmed, and let the user
 * drag a rectangle with a magnifier loupe (a 田-grid crosshair) to pick a precise
 * region. On release we send the rect (in FROZEN-IMAGE pixels) to `region_submit`;
 * Esc / a stray click sends `region_cancel`. The backend hides this window and
 * routes the crop to Explain (stream) or Ask (question box).
 */

import "./capture.css";
import { initI18n, t } from "./i18n/index";

/* ----------------------------------------------------------------- Tauri glue */
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return (
    typeof w.__TAURI_INTERNALS__ !== "undefined" ||
    typeof w.__TAURI__ !== "undefined"
  );
}
async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!inTauri()) return undefined;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[peeky] invoke "${cmd}" failed:`, err);
    return undefined;
  }
}
async function safeListen(event: string, handler: () => void): Promise<void> {
  if (!inTauri()) return;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen(event, () => handler());
  } catch (err) {
    console.warn(`[peeky] listen "${event}" failed:`, err);
  }
}

interface RegionShot {
  url: string; // ready-to-use data: URL (JPEG)
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ DOM build */
const root = document.getElementById("capture-root");
if (!root) throw new Error("missing #capture-root");

const shot = document.createElement("img");
shot.className = "cap-shot";
const dim = document.createElement("canvas");
dim.className = "cap-dim";
const loupe = document.createElement("div");
loupe.className = "cap-loupe cap-hidden";
const loupeCanvas = document.createElement("canvas");
const loupeReadout = document.createElement("div");
loupeReadout.className = "cap-readout";
loupe.appendChild(loupeCanvas);
loupe.appendChild(loupeReadout);
const hint = document.createElement("div");
hint.className = "cap-hint";

root.appendChild(shot);
root.appendChild(dim);
root.appendChild(loupe);
root.appendChild(hint);

/* --------------------------------------------------------------------- state */
const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const LOUPE_CSS = 132; // on-screen size of the magnifier
const ZOOM = 6; // magnification factor
const MIN_SELECT = 5; // CSS px: smaller drags are treated as a cancel-click

let natW = 0; // FULL image width (px) — what we crop from
let natH = 0;
let ready = false;
let loadSerial = 0;

/**
 * The displayed screenshot's on-screen rect. All selection math is relative to
 * THIS (not the window), so any offset between the window and the screen can't
 * shift the crop. `object-fit: fill` means a CSS point maps linearly to image px.
 */
function imgRect(): DOMRect {
  return shot.getBoundingClientRect();
}
/** Map a viewport CSS point to FULL-image pixels. */
function toImg(px: number, py: number): { x: number; y: number } {
  const r = imgRect();
  const w = r.width || 1;
  const h = r.height || 1;
  return {
    x: ((px - r.left) / w) * natW,
    y: ((py - r.top) / h) * natH,
  };
}

let cursor = { x: 0, y: 0 };
let selecting = false;
let haveRect = false;
let start = { x: 0, y: 0 };
let rect = { x: 0, y: 0, w: 0, h: 0 };

const dimCtx = dim.getContext("2d");
const loupeCtx = loupeCanvas.getContext("2d");

/* ---------------------------------------------------------------- size setup */
function sizeCanvases(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  dim.width = vw;
  dim.height = vh;
  dim.style.width = `${vw}px`;
  dim.style.height = `${vh}px`;
  loupeCanvas.width = LOUPE_CSS * dpr;
  loupeCanvas.height = LOUPE_CSS * dpr;
  loupeCanvas.style.width = `${LOUPE_CSS}px`;
  loupeCanvas.style.height = `${LOUPE_CSS}px`;
}

/* ------------------------------------------------------------------- drawing */
function currentRect(): { x: number; y: number; w: number; h: number } {
  if (selecting) {
    const x = Math.min(start.x, cursor.x);
    const y = Math.min(start.y, cursor.y);
    return { x, y, w: Math.abs(cursor.x - start.x), h: Math.abs(cursor.y - start.y) };
  }
  return rect;
}

function redraw(): void {
  if (!dimCtx) return;
  const vw = dim.width;
  const vh = dim.height;
  dimCtx.clearRect(0, 0, vw, vh);
  // Dim the whole frozen screen.
  dimCtx.fillStyle = "rgba(0, 0, 0, 0.5)";
  dimCtx.fillRect(0, 0, vw, vh);

  const showRect = selecting || haveRect;
  if (showRect) {
    const r = currentRect();
    // Punch a crisp hole so the selected region shows at full brightness.
    dimCtx.clearRect(r.x, r.y, r.w, r.h);
    // Accent border.
    dimCtx.strokeStyle = "#2fbfa0";
    dimCtx.lineWidth = 1.5;
    dimCtx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.w - 1), Math.max(0, r.h - 1));
  } else {
    // Full-length crosshair guides at the cursor before a drag starts.
    dimCtx.strokeStyle = "rgba(47, 191, 160, 0.55)";
    dimCtx.lineWidth = 1;
    dimCtx.beginPath();
    dimCtx.moveTo(cursor.x + 0.5, 0);
    dimCtx.lineTo(cursor.x + 0.5, vh);
    dimCtx.moveTo(0, cursor.y + 0.5);
    dimCtx.lineTo(vw, cursor.y + 0.5);
    dimCtx.stroke();
  }
}

function updateLoupe(): void {
  if (!loupeCtx || !ready) return;
  loupe.classList.remove("cap-hidden");

  // Position the loupe near the cursor, flipping away from screen edges.
  const margin = 22;
  let lx = cursor.x + margin;
  let ly = cursor.y + margin;
  if (lx + LOUPE_CSS > window.innerWidth - 8) lx = cursor.x - margin - LOUPE_CSS;
  if (ly + LOUPE_CSS + 22 > window.innerHeight - 8) ly = cursor.y - margin - LOUPE_CSS - 22;
  loupe.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;

  // Sample the DISPLAYED image in ITS OWN pixel space (low-res copy), relative to
  // the image's actual rect so the loupe shows exactly what's under the cursor.
  const ir = imgRect();
  const dispScaleX = (shot.naturalWidth || natW) / (ir.width || 1);
  const dispScaleY = (shot.naturalHeight || natH) / (ir.height || 1);
  const Lpx = LOUPE_CSS * dpr;
  const sampW = (LOUPE_CSS / ZOOM) * dispScaleX;
  const sampH = (LOUPE_CSS / ZOOM) * dispScaleY;
  const cxImg = (cursor.x - ir.left) * dispScaleX;
  const cyImg = (cursor.y - ir.top) * dispScaleY;
  const srcX = cxImg - sampW / 2;
  const srcY = cyImg - sampH / 2;

  loupeCtx.imageSmoothingEnabled = false;
  loupeCtx.clearRect(0, 0, Lpx, Lpx);
  try {
    loupeCtx.drawImage(shot, srcX, srcY, sampW, sampH, 0, 0, Lpx, Lpx);
  } catch {
    /* drawImage can throw if the source rect is fully off-image; ignore */
  }

  // 田-grid crosshair: a vertical + horizontal line through the center, plus a
  // 1-magnified-pixel center cell marking the exact point.
  const mid = Lpx / 2;
  const cell = ZOOM * dpr; // one source pixel, magnified
  loupeCtx.strokeStyle = "rgba(47, 191, 160, 0.95)";
  loupeCtx.lineWidth = 1 * dpr;
  loupeCtx.beginPath();
  loupeCtx.moveTo(mid + 0.5, 0);
  loupeCtx.lineTo(mid + 0.5, Lpx);
  loupeCtx.moveTo(0, mid + 0.5);
  loupeCtx.lineTo(Lpx, mid + 0.5);
  loupeCtx.stroke();
  loupeCtx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  loupeCtx.lineWidth = 1 * dpr;
  loupeCtx.strokeRect(mid - cell / 2, mid - cell / 2, cell, cell);

  // Readout: cursor point, or selection size while dragging.
  if (selecting) {
    const r = currentRect();
    loupeReadout.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
  } else {
    loupeReadout.textContent = `${Math.round(cursor.x)}, ${Math.round(cursor.y)}`;
  }
}

function frame(): void {
  redraw();
  updateLoupe();
}

function canSelect(): boolean {
  return ready && natW > 0 && natH > 0 && shot.complete && shot.naturalWidth > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setShotSrc(src: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      shot.removeEventListener("load", done);
      shot.removeEventListener("error", done);
      resolve();
    };
    shot.addEventListener("load", done, { once: true });
    shot.addEventListener("error", done, { once: true });
    shot.src = src;
  });
}

/* -------------------------------------------------------------- interactions */
window.addEventListener("pointermove", (e) => {
  cursor = { x: e.clientX, y: e.clientY };
  frame();
});

window.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (!canSelect()) {
    void loadShot();
    return;
  }
  selecting = true;
  haveRect = false;
  start = { x: e.clientX, y: e.clientY };
  cursor = start;
  frame();
});

window.addEventListener("pointerup", (e) => {
  if (e.button !== 0 || !selecting) return;
  // Compute the rect WHILE still "selecting" — currentRect() only reflects the
  // live drag in that state; reading it after clearing the flag returns a stale
  // 0×0 and would make every selection look like a cancel-click.
  const r = currentRect();
  selecting = false;
  rect = r;
  haveRect = true;
  // Too small to be a deliberate region → treat as "click to cancel".
  if (r.w < MIN_SELECT || r.h < MIN_SELECT) {
    void cancel();
    return;
  }
  if (!canSelect()) {
    reset();
    void loadShot();
    return;
  }
  // Map the selection corners through the image's actual rect → full-image px.
  const a = toImg(r.x, r.y);
  const b = toImg(r.x + r.w, r.y + r.h);
  void safeInvoke("region_submit", {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  });
  reset();
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    void cancel();
  }
});

async function cancel(): Promise<void> {
  reset();
  await safeInvoke("region_cancel");
}

function reset(): void {
  selecting = false;
  haveRect = false;
  rect = { x: 0, y: 0, w: 0, h: 0 };
  loupe.classList.add("cap-hidden");
}

window.addEventListener("resize", () => {
  sizeCanvases();
  frame();
});

/* ------------------------------------------------------------------ shot load */
async function loadShot(): Promise<void> {
  const serial = ++loadSerial;
  ready = false;
  natW = 0;
  natH = 0;
  shot.removeAttribute("src");
  reset();
  sizeCanvases();
  hint.textContent = t("capture.loading");
  frame();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const data = await safeInvoke<RegionShot | null>("get_region_shot");
    if (serial !== loadSerial) return;

    if (data && data.w > 0 && data.h > 0 && data.url) {
      natW = data.w;
      natH = data.h;
      await setShotSrc(data.url);
      if (serial !== loadSerial) return;

      ready = shot.naturalWidth > 0 && shot.naturalHeight > 0;
      reset();
      sizeCanvases();
      hint.textContent = ready ? t("capture.hint") : t("capture.loading");
      frame();
      return;
    }

    await sleep(Math.min(250, 40 + attempt * 25));
  }
}

/* ------------------------------------------------------------------- kickoff */
async function boot(): Promise<void> {
  await initI18n();
  hint.textContent = t("capture.hint");
  // Re-load whenever the backend re-shows us with a fresh frozen frame.
  await safeListen("peeky://region-init", () => void loadShot());
  window.addEventListener("focus", () => void loadShot());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void loadShot();
  });
  // Also load on first mount (covers the case where the event fired before we
  // finished subscribing).
  await loadShot();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
