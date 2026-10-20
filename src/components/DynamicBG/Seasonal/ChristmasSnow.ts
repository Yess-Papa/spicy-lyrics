import Global from "../../Global/Global.ts";
import { SpotifyPlayer } from "../../Global/SpotifyPlayer.ts";
import { PageContainer } from "../../Pages/PageView.ts";
import Fullscreen from "../../Utils/Fullscreen.ts";
import { onAnimationFrame } from "../../../utils/AnimationFrameLoop.ts";
import { $backgroundStyle, $showNpvDynamicBg } from "../../../utils/stores.ts";
import type { AudioAnalysisData, TimeInterval } from "../BackgroundAnimationController.ts";
import { getAudioAnalysisForTrack, getBackgroundStyle } from "../dynamicBackground.ts";
import ChristmasTrackIds from "./ChristmasTrackIds.ts";
import { $snowAmount, $snowFrost, $snowReactsToMusic, $snowWhen, getSnowWhen } from "./ChristmasSnowSettings.tsx";

/**
 * Christmas songs get falling snow and frosted edges, drawn between the background
 * and the content (cover, lyrics) of the lyrics page and of the Now Playing sidebar.
 * Set up in Settings → Christmas, where "No songs" turns it off.
 *
 * The snow follows the music: it falls faster and blows harder on loud parts and
 * eases off in quiet ones.
 *
 * A track counts as Christmas when its ID is in ChristmasTrackIds, or when its
 * title or album name matches CHRISTMAS_KEYWORDS (which catches re-releases and
 * covers the ID list doesn't know about).
 */

const christmasIds = new Set(ChristmasTrackIds.split(/\s+/).filter(Boolean));

// Kept strict: a false positive (snow on Green Day's "Holiday") is worse than a
// miss. Bare "holiday", "winter", "snow" and "santa" (Santa Fe, Santa Monica) are
// deliberately absent. Carols are listed by title: they rarely say "Christmas".
const CHRISTMAS_KEYWORDS = new RegExp(
  String.raw`(?<!\p{L})(${[
    String.raw`christmas\p{L}*`, "xmas", "x-mas", "navidad", String.raw`weihnacht\p{L}*`, "noël", "first noel",
    "jingle bells?", "santa claus", "santa baby", "here comes santa", "sleigh ride", "mistletoe",
    "rudolph", "frosty the snowman", "winter wonderland", "let it snow", "silver bells",
    "happy holidays", "nutcracker", "little drummer boy", "carol of the bells", "silent night",
    "o holy night", "deck the halls?", "joy to the world", "god rest ye", "hark[!,]? the herald",
    "away in a manger", "o come,? all ye faithful", "o little town of bethlehem",
    "we wish you a merry", "angels we have heard", "o come,? o come,? emmanuel",
    "good king wenceslas", "we three kings", "in the bleak midwinter", "the holly and the ivy",
    "it came upon (a|the) midnight clear",
  ].join("|")})(?!\p{L})`,
  "iu"
);

export function IsChristmasTrack(): boolean {
  if (SpotifyPlayer.GetContentType() === "episode") return false;
  const id = SpotifyPlayer.GetId();
  if (id && christmasIds.has(id)) return true;
  const text = `${SpotifyPlayer.GetName() ?? ""}\n${SpotifyPlayer.GetAlbumName() ?? ""}`;
  return CHRISTMAS_KEYWORDS.test(text);
}

function isSnowTime(): boolean {
  if (SpotifyPlayer.GetContentType() === "episode") return false;
  const when = getSnowWhen();
  if (when === "none") return false;
  return when === "all" || IsChristmasTrack();
}

type Flake = {
  x: number;
  y: number;
  /** 0 = far (small, faint, slow), 1 = near (large, bright, faster). */
  depth: number;
  radius: number;
  fallSpeed: number;
  swayPhase: number;
  swaySpeed: number;
  swayAmount: number;
  opacity: number;
};

// Flakes per 1920×1080 of host area at 100% Snow Amount; scaled to the real size and clamped.
const FLAKES_PER_FULL_HD = 110;
const MIN_FLAKES = 30;
const MAX_FLAKES = 180;
// Longer than one frame at the lowest FPS cap, so a stall doesn't teleport flakes.
const MAX_FRAME_DELTA_S = 0.1;
// Matches the CSS opacity transition on .SpicySnow.
const FADE_OUT_MS = 1200;
// The dimmed lyric lines are translucent, so a flake behind one shows through its
// letters. The snow fades out across the text; that region is re-measured this often,
// since lyrics load after the song changes and lines reflow with the layout.
const TEXT_REGION_INTERVAL_MS = 1000;
// How many lines to measure: enough to cover a duet's two sides.
const TEXT_REGION_SAMPLE_LINES = 60;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

// ─── Music ───────────────────────────────────────────────────────────────────

let analysis: AudioAnalysisData | null = null;
let analysisUri: string | null = null;

/** What the music is doing right now, smoothed so the snow never jerks. Shared by every layer. */
const music = {
  /** Loudness of the moment, 0..1. */
  energy: 0.5,
  speed: 1,
  /** Horizontal drift in px/s. */
  wind: 0,
};

function loadAnalysis() {
  const uri = SpotifyPlayer.GetUri() ?? null;
  if (uri === analysisUri) return;
  analysisUri = uri;
  analysis = null;
  if (!uri || uri.startsWith("spotify:local:")) return;
  void getAudioAnalysisForTrack(uri)
    .then((data) => {
      if (analysisUri === uri) analysis = data;
    })
    .catch(() => undefined);
}

/** The interval playing at `time` (seconds), by binary search: these lists run to thousands. */
function intervalAt<T extends TimeInterval>(list: T[], time: number): T | null {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].start <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const item = found >= 0 ? list[found] : null;
  return item && time < item.start + item.duration ? item : null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Frame-rate independent ease of `current` toward `target`, `rate` per second. */
const approach = (current: number, target: number, rate: number, dt: number) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

/** Advances the smoothed music state; returns this frame's fall-speed multiplier. */
function updateMusic(dt: number, timestamp: number): number {
  const playing = SpotifyPlayer.IsPlaying;
  const reacts = $snowReactsToMusic.get();

  let loudness = 0.5;
  let beatPulse = 0;
  if (reacts && analysis) {
    const time = SpotifyPlayer.GetPosition() / 1000;
    // The dB range a typical master spends its time in, mapped to 0..1.
    const segment = intervalAt(analysis.segments, time);
    if (segment) loudness = clamp01((segment.loudness_max + 30) / 25);
    const beat = intervalAt(analysis.beats, time);
    if (beat && beat.confidence > 0.4) {
      beatPulse = Math.exp(-6 * ((time - beat.start) / beat.duration)) * beat.confidence;
    }
  }

  music.energy = approach(music.energy, loudness, 4, dt);
  // Quiet passages slow it only so far: any slower and a ballad's snow reads as sparse.
  // Paused, it nearly hangs in the air rather than stopping dead.
  const pace = reacts ? 0.75 + 0.7 * music.energy : 1;
  music.speed = approach(music.speed, playing ? pace : 0.15, 3, dt);

  // A slow gust that swings side to side, stronger the louder the song.
  const gust = Math.sin(timestamp * 0.00009) * (reacts ? 10 + 45 * music.energy : 15);
  music.wind = approach(music.wind, playing ? gust : 0, 1, dt);

  // The beat only nudges the fall, after smoothing, so it reads as a pulse.
  return music.speed + (playing ? 0.25 * beatPulse : 0);
}

// ─── Frost ───────────────────────────────────────────────────────────────────

// How far the frost reaches in from an edge, as a fraction of the shorter side.
const FROST_REACH = 0.1;
// Crystals per 1000px of perimeter.
const FROST_CRYSTALS_PER_1000PX = 22;
const FROST_SEED = 0x5eed;

/** mulberry32: a tiny deterministic PRNG, uniform in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Frosted edges, as on a cold window: a pale glaze thickest in the corners,
 * fern-like crystals growing in from the edges, and a dusting of rime. Static, so
 * it's drawn once per size rather than per frame.
 */
function drawFrost(frost: HTMLCanvasElement, width: number, height: number) {
  const c = frost.getContext("2d");
  if (!c || width === 0 || height === 0) return;
  const dpr = frost.ownerDocument.defaultView?.devicePixelRatio ?? 1;
  frost.width = Math.round(width * dpr);
  frost.height = Math.round(height * dpr);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, width, height);

  const reach = Math.min(width, height) * FROST_REACH;
  // Seeded, so a resize redraws the same frost at the new size instead of a new pattern.
  const rand = seededRandom(FROST_SEED);

  // Glaze along each edge, then heavier in each corner.
  const edges: [number, number, number, number][] = [
    [0, 0, 0, reach],
    [0, height, 0, height - reach],
    [0, 0, reach, 0],
    [width, 0, width - reach, 0],
  ];
  for (const [x0, y0, x1, y1] of edges) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(225, 238, 255, 0.10)");
    g.addColorStop(1, "rgba(225, 238, 255, 0)");
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
  }
  for (const [cx, cy] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, reach * 1.3);
    g.addColorStop(0, "rgba(235, 244, 255, 0.26)");
    g.addColorStop(1, "rgba(235, 244, 255, 0)");
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
  }

  // A point near the edges: distance from the nearest edge falls off sharply.
  const nearEdge = (): [number, number, number] => {
    const depth = reach * rand() ** 3;
    const along = rand();
    switch (Math.floor(rand() * 4)) {
      case 0: return [along * width, depth, Math.PI / 2];
      case 1: return [along * width, height - depth, -Math.PI / 2];
      case 2: return [depth, along * height, 0];
      default: return [width - depth, along * height, Math.PI];
    }
  };

  c.lineCap = "round";
  const branch = (x: number, y: number, angle: number, length: number, level: number) => {
    const x2 = x + Math.cos(angle) * length;
    const y2 = y + Math.sin(angle) * length;
    c.globalAlpha = 0.07 + 0.05 * level;
    c.lineWidth = 0.35 + 0.25 * level;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x2, y2);
    c.stroke();
    if (level === 0) return;
    // Ice branches at roughly 60°, in pairs, along the stem.
    const forks = 2 + Math.floor(rand() * 3);
    for (let i = 1; i <= forks; i++) {
      const t = i / (forks + 1);
      const bx = x + (x2 - x) * t;
      const by = y + (y2 - y) * t;
      const sub = length * (0.45 - 0.25 * t);
      branch(bx, by, angle + Math.PI / 3, sub, level - 1);
      branch(bx, by, angle - Math.PI / 3, sub, level - 1);
    }
  };
  c.strokeStyle = "rgb(235, 244, 255)";
  const crystals = Math.round(((width + height) * 2) / 1000 * FROST_CRYSTALS_PER_1000PX);
  for (let i = 0; i < crystals; i++) {
    const [x, y, inward] = nearEdge();
    // Mostly growing inward, never straight.
    const angle = inward + (rand() - 0.5) * 1.6;
    branch(x, y, angle, reach * (0.12 + rand() * 0.28), 2);
  }

  // Rime: fine specks, densest at the edges.
  c.fillStyle = "rgb(240, 247, 255)";
  const specks = Math.round((width + height) * 1.6);
  for (let i = 0; i < specks; i++) {
    const [x, y] = nearEdge();
    c.globalAlpha = 0.08 + rand() * 0.22;
    const r = 0.4 + rand() * 0.9;
    c.fillRect(x - r / 2, y - r / 2, r, r);
  }
  c.globalAlpha = 1;
}

// ─── Layer ───────────────────────────────────────────────────────────────────

/**
 * A soft white dot, drawn once and stamped per flake: far cheaper than shadowBlur.
 * Its faint cool-grey rim vanishes on a dark background and outlines the flake on a
 * pale one, where plain white would disappear.
 */
function makeSprite(doc: Document): HTMLCanvasElement {
  const size = 64;
  const el = doc.createElement("canvas");
  el.width = el.height = size;
  const c = el.getContext("2d");
  if (c) {
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255, 255, 255, 1)");
    g.addColorStop(0.3, "rgba(255, 255, 255, 0.9)");
    g.addColorStop(0.5, "rgba(230, 236, 245, 0.55)");
    g.addColorStop(0.7, "rgba(70, 85, 105, 0.22)");
    g.addColorStop(1, "rgba(70, 85, 105, 0)");
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
  }
  return el;
}

type TextRegion = {
  /** Which way the lyrics' extent is measured, and so the axis the mask fades along. */
  axis: "x" | "y";
  /** The elements whose extent the snow keeps out from behind. */
  elements: (host: HTMLElement) => Iterable<Element>;
};

/**
 * Snow and frost over one host's background: a `.SpicySnow` element holding the
 * frost and flake canvases, kept right after the host's background layers.
 */
class SnowLayer {
  readonly host: HTMLElement;
  private readonly textRegion: TextRegion;
  private readonly el: HTMLElement;
  private readonly flakesCanvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly frost: HTMLCanvasElement;
  private readonly sprite: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly backgroundObserver: MutationObserver;
  private flakes: Flake[] = [];
  private width = 0;
  private height = 0;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** True from show() until the fade-out after hide() has finished. */
  rendering = false;

  constructor(host: HTMLElement, textRegion: TextRegion) {
    this.host = host;
    this.textRegion = textRegion;
    const doc = host.ownerDocument;
    this.el = doc.createElement("div");
    this.el.classList.add("SpicySnow");
    this.el.setAttribute("aria-hidden", "true");
    this.frost = doc.createElement("canvas");
    this.frost.classList.add("SnowFrost");
    this.flakesCanvas = doc.createElement("canvas");
    this.flakesCanvas.classList.add("SnowFlakes");
    this.ctx = this.flakesCanvas.getContext("2d");
    this.sprite = makeSprite(doc);
    this.el.append(this.frost, this.flakesCanvas);
    host.prepend(this.el);
    this.keepAboveBackground();
    // The background is (re)appended asynchronously, after the snow exists.
    this.backgroundObserver = new MutationObserver(() => this.keepAboveBackground());
    this.backgroundObserver.observe(host, { childList: true });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.el);
    this.resize();
  }

  get isAttached(): boolean {
    return this.el.isConnected && this.el.parentElement === this.host;
  }

  /**
   * The background is absolutely positioned with no z-index, and the content above
   * it is z-indexed, so the snow (also z-index: auto) sits between them as long as
   * it follows the background in the DOM.
   */
  private keepAboveBackground() {
    const backgrounds = this.host.querySelectorAll(":scope > .spicy-dynamic-bg");
    const last = backgrounds[backgrounds.length - 1];
    if (last && last.nextElementSibling !== this.el) last.after(this.el);
  }

  private resize() {
    if (!this.ctx) return;
    const dpr = this.host.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    this.width = this.el.clientWidth;
    this.height = this.el.clientHeight;
    this.flakesCanvas.width = Math.round(this.width * dpr);
    this.flakesCanvas.height = Math.round(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const flake of this.flakes) {
      if (flake.x > this.width) flake.x = Math.random() * this.width;
      if (flake.y > this.height) flake.y = Math.random() * this.height;
    }
    this.populate();
    this.redrawFrost();
    if (this.rendering) this.updateTextRegion();
  }

  private makeFlake(randomY: boolean): Flake {
    // Squaring biases toward far flakes, so most of the field reads as distant.
    const depth = Math.random() ** 2;
    return {
      x: Math.random() * this.width,
      y: randomY ? Math.random() * this.height : -10,
      depth,
      radius: 2.5 + depth * 5,
      fallSpeed: 14 + depth * 46,
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: 0.3 + Math.random() * 0.7,
      swayAmount: 6 + depth * 18,
      opacity: 0.4 + depth * 0.4,
    };
  }

  /** Match the flake count to the host's size and the Snow Amount setting. */
  populate() {
    const amount = Math.max(0.25, $snowAmount.get() / 100);
    const target = Math.round(((this.width * this.height) / (1920 * 1080)) * FLAKES_PER_FULL_HD * amount);
    const count = Math.round(Math.max(MIN_FLAKES * amount, Math.min(MAX_FLAKES * amount, target)));
    if (this.flakes.length > count) this.flakes.length = count;
    while (this.flakes.length < count) this.flakes.push(this.makeFlake(true));
  }

  redrawFrost() {
    const on = $snowFrost.get();
    this.frost.hidden = !on;
    if (on) drawFrost(this.frost, this.width, this.height);
  }

  /** Point the flakes' mask in ChristmasSnow.css at the lyrics' extent, or lift it. */
  updateTextRegion() {
    const horizontal = this.textRegion.axis === "x";
    let start = Infinity;
    let end = -Infinity;
    let sampled = 0;
    for (const element of this.textRegion.elements(this.host)) {
      if (sampled++ >= TEXT_REGION_SAMPLE_LINES) break;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      start = Math.min(start, horizontal ? rect.left : rect.top);
      end = Math.max(end, horizontal ? rect.right : rect.bottom);
    }
    const hasText = start < end;
    this.el.classList.toggle("AvoidText", hasText);
    this.el.classList.toggle("AvoidTextY", hasText && !horizontal);
    if (!hasText) return;
    const hostRect = this.host.getBoundingClientRect();
    const origin = horizontal ? hostRect.left : hostRect.top;
    this.flakesCanvas.style.setProperty("--SnowTextStart", `${Math.round(start - origin)}px`);
    this.flakesCanvas.style.setProperty("--SnowTextEnd", `${Math.round(end - origin)}px`);
  }

  render(dt: number, speed: number) {
    const ctx = this.ctx;
    if (!ctx || this.width === 0 || this.height === 0) return;
    const { width, height } = this;
    ctx.clearRect(0, 0, width, height);
    for (const flake of this.flakes) {
      flake.y += flake.fallSpeed * speed * dt;
      // Near flakes catch more of the wind, which reads as depth.
      flake.x += music.wind * (0.4 + 0.6 * flake.depth) * dt;
      flake.swayPhase += flake.swaySpeed * speed * dt;
      if (flake.y - flake.radius > height) {
        Object.assign(flake, this.makeFlake(false));
        flake.y = -flake.radius;
      }
      // Wrap sideways so a steady wind doesn't empty one edge.
      const margin = flake.radius + flake.swayAmount;
      if (flake.x < -margin) flake.x += width + margin * 2;
      else if (flake.x > width + margin) flake.x -= width + margin * 2;
      const x = flake.x + Math.sin(flake.swayPhase) * flake.swayAmount;
      const size = flake.radius * 2;
      ctx.globalAlpha = flake.opacity;
      ctx.drawImage(this.sprite, x - flake.radius, flake.y - flake.radius, size, size);
    }
    ctx.globalAlpha = 1;
  }

  show() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.rendering) {
      this.rendering = true;
      this.updateTextRegion();
    }
    // Next frame, so a freshly inserted layer transitions in from opacity 0.
    requestAnimationFrame(() => {
      if (this.rendering && !this.hideTimer) this.el.classList.add("Visible");
    });
    syncLoop();
  }

  hide() {
    if (!this.rendering || this.hideTimer) return;
    this.el.classList.remove("Visible");
    // Keep drawing through the fade so the flakes don't freeze mid-air.
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.rendering = false;
      syncLoop();
    }, FADE_OUT_MS);
  }

  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.rendering = false;
    this.backgroundObserver.disconnect();
    this.resizeObserver.disconnect();
    this.el.remove();
  }
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

/** The lyrics page: keep the snow out of the lyrics column. */
const PAGE_TEXT: TextRegion = {
  axis: "x",
  elements: (host) => host.querySelectorAll(".LyricsContainer .line"),
};

/** The NPV: keep the snow out of the band the lyrics card covers. */
const NPV_TEXT: TextRegion = {
  axis: "y",
  elements: (host) => host.querySelectorAll("#SpicyLyricsPage.CardMode .LyricsContainer"),
};

let pageLayer: SnowLayer | null = null;
let npvLayer: SnowLayer | null = null;

const layers = () => [pageLayer, npvLayer].filter((l): l is SnowLayer => l !== null);

/** The lyrics page's content box, when it has an animated background of its own to snow on. */
function pageHost(): HTMLElement | null {
  if (!PageContainer || PageContainer.classList.contains("CardMode")) return null;
  if (getBackgroundStyle() !== "dynamic") return null;
  return PageContainer.querySelector<HTMLElement>(".ContentBox");
}

/**
 * The Now Playing sidebar, while it shows our Animated Background and fullscreen isn't
 * covering it. Without that background, Spotify's own shading over the sidebar's top
 * would hide the snow there.
 */
function npvHost(): HTMLElement | null {
  if (!$showNpvDynamicBg.get() || Fullscreen.IsOpen) return null;
  return document.querySelector<HTMLElement>("aside.spicy-dynamic-bg-in-this");
}

/** Keep a layer on `host`: rebuilt when the host changed, shown or hidden to match `on`. */
function syncLayer(current: SnowLayer | null, host: HTMLElement | null, on: boolean, text: TextRegion) {
  if (current && (!host || current.host !== host || !current.isAttached)) {
    current.destroy();
    current = null;
  }
  if (!host) return null;
  if (!on) {
    current?.hide();
    return current;
  }
  current ??= new SnowLayer(host, text);
  current.show();
  return current;
}

/** Show, hide or tear down the snow on every host to match the track and settings. */
export function UpdateChristmasSnow() {
  const on = isSnowTime() && !reducedMotion.matches;
  snowing = on;
  if (on) loadAnalysis();
  pageLayer = syncLayer(pageLayer, pageHost(), on, PAGE_TEXT);
  npvLayer = syncLayer(npvLayer, npvHost(), on, NPV_TEXT);
  syncLoop();
}

// ─── Loop ────────────────────────────────────────────────────────────────────

/** Whether the current track and settings call for snow, wherever there's a host for it. */
let snowing = false;
let stopFrames: (() => void) | null = null;
let upkeepTimer: ReturnType<typeof setInterval> | null = null;
let lastTimestamp = 0;

function frame(timestamp: number) {
  const dt = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, MAX_FRAME_DELTA_S) : 0;
  lastTimestamp = timestamp;
  const speed = updateMusic(dt, timestamp);
  for (const layer of layers()) {
    if (layer.rendering) layer.render(dt, speed);
  }
}

/** Slow checks while it snows: the lyrics move, and Spotify opens, closes and swaps the sidebar. */
function upkeep() {
  if (layers().some((l) => !l.isAttached) || npvLayer?.host !== (npvHost() ?? undefined)) {
    UpdateChristmasSnow();
  }
  for (const layer of layers()) {
    if (layer.rendering) layer.updateTextRegion();
  }
}

/** Run the frame loop while some layer is drawing, and upkeep while it snows (to catch new hosts). */
function syncLoop() {
  const drawing = layers().some((l) => l.rendering);
  if (drawing && !stopFrames) {
    lastTimestamp = 0;
    stopFrames = onAnimationFrame(frame);
  } else if (!drawing && stopFrames) {
    stopFrames();
    stopFrames = null;
  }
  const watching = drawing || snowing;
  if (watching && !upkeepTimer) {
    upkeepTimer = setInterval(upkeep, TEXT_REGION_INTERVAL_MS);
  } else if (!watching && upkeepTimer) {
    clearInterval(upkeepTimer);
    upkeepTimer = null;
  }
}

Global.Event.listen("page:open", UpdateChristmasSnow);
Global.Event.listen("page:destroy", () => {
  pageLayer?.destroy();
  pageLayer = null;
  syncLoop();
});
Global.Event.listen("playback:songchange", () => {
  music.energy = 0.5;
  UpdateChristmasSnow();
});
Global.Event.listen("fullscreen:open", UpdateChristmasSnow);
Global.Event.listen("fullscreen:exit", UpdateChristmasSnow);
$backgroundStyle.listen(UpdateChristmasSnow);
$showNpvDynamicBg.listen(UpdateChristmasSnow);
$snowWhen.listen(UpdateChristmasSnow);
$snowAmount.listen(() => {
  for (const layer of layers()) layer.populate();
});
$snowFrost.listen(() => {
  for (const layer of layers()) layer.redrawFrost();
});
reducedMotion.addEventListener("change", UpdateChristmasSnow);

// The NPV background is applied asynchronously, after the song change, and goes away
// with the sidebar. app.tsx keeps this body class in step with it.
const NPV_BACKGROUND_CLASS = "SpicyLyrics_NPVDynamicBackground";
let npvHadBackground = document.body.classList.contains(NPV_BACKGROUND_CLASS);
new MutationObserver(() => {
  const has = document.body.classList.contains(NPV_BACKGROUND_CLASS);
  if (has === npvHadBackground) return;
  npvHadBackground = has;
  UpdateChristmasSnow();
}).observe(document.body, { attributes: true, attributeFilter: ["class"] });

