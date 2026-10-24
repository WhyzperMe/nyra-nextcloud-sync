const SVG_NS = "http://www.w3.org/2000/svg";
/** Strokes stay 1.5 CSS pixels at every icon size (non-scaling), so small and large icons look equally light. */
const STROKE_WIDTH = "1.5";

type Shape =
  | { path: string }
  | { circle: [cx: number, cy: number, r: number] }
  | { rect: [x: number, y: number, width: number, height: number, radius?: number] }
  | { line: [x1: number, y1: number, x2: number, y2: number] }
  | { dot: [cx: number, cy: number] };

/** Outline icons (24×24, stroke-based, in the style of the Lucide set). */
const ICONS = {
  "refresh": [{ path: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }, { path: "M21 3v5h-5" }, { path: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }, { path: "M8 16H3v5" }],
  "check-circle": [{ circle: [12, 12, 10] }, { path: "m9 12 2 2 4-4" }],
  "alert": [{ path: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" }, { line: [12, 9, 12, 13] }, { dot: [12, 17] }],
  "shield": [{ path: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }, { path: "m9 12 2 2 4-4" }],
  "activity": [{ path: "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" }],
  "history": [{ path: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }, { path: "M3 3v5h5" }, { path: "M12 7v5l4 2" }],
  "trash": [{ path: "M3 6h18" }, { path: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" }, { path: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" }, { line: [10, 11, 10, 17] }, { line: [14, 11, 14, 17] }],
  "pause": [{ rect: [14, 4, 4, 16, 1] }, { rect: [6, 4, 4, 16, 1] }],
  "play": [{ path: "M6 3 20 12 6 21Z" }],
  "folder-plus": [{ path: "M12 10v6" }, { path: "M9 13h6" }, { path: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
  "arrow-up": [{ path: "m5 12 7-7 7 7" }, { path: "M12 19V5" }],
  "arrow-down": [{ path: "M12 5v14" }, { path: "m19 12-7 7-7-7" }],
  "arrow-right": [{ path: "M5 12h14" }, { path: "m12 5 7 7-7 7" }],
  "merge": [{ circle: [18, 18, 3] }, { circle: [6, 6, 3] }, { path: "M6 21V9a9 9 0 0 0 9 9" }],
  "git-compare": [{ circle: [18, 18, 3] }, { circle: [6, 6, 3] }, { path: "M13 6h3a2 2 0 0 1 2 2v7" }, { path: "M11 18H8a2 2 0 0 1-2-2V9" }],
  "info": [{ circle: [12, 12, 10] }, { line: [12, 16, 12, 12] }, { dot: [12, 8] }],
  "folder": [{ path: "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" }],
  "file": [{ path: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }, { path: "M14 2v4a2 2 0 0 0 2 2h4" }],
  "chevron-right": [{ path: "m9 18 6-6-6-6" }],
  "x-circle": [{ circle: [12, 12, 10] }, { path: "m15 9-6 6" }, { path: "m9 9 6 6" }]
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof ICONS;

/** Every available icon name; used by the design preview. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/** Builds an inline SVG icon that inherits the current text color. */
export function createIcon(name: IconName, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", STROKE_WIDTH);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("nyra-nc-icon", `nyra-nc-icon--${name}`);
  for (const shape of ICONS[name] as readonly Shape[]) {
    let element: SVGElement;
    if ("path" in shape) { element = document.createElementNS(SVG_NS, "path"); element.setAttribute("d", shape.path); }
    else if ("circle" in shape) {
      element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", String(shape.circle[0])); element.setAttribute("cy", String(shape.circle[1])); element.setAttribute("r", String(shape.circle[2]));
    } else if ("rect" in shape) {
      element = document.createElementNS(SVG_NS, "rect");
      const [x, y, width, height, radius] = shape.rect;
      element.setAttribute("x", String(x)); element.setAttribute("y", String(y)); element.setAttribute("width", String(width)); element.setAttribute("height", String(height));
      if (radius !== undefined) element.setAttribute("rx", String(radius));
    } else if ("dot" in shape) {
      element = document.createElementNS(SVG_NS, "circle");
      element.setAttribute("cx", String(shape.dot[0])); element.setAttribute("cy", String(shape.dot[1])); element.setAttribute("r", "1");
      element.setAttribute("fill", "currentColor"); element.setAttribute("stroke", "none");
    } else {
      element = document.createElementNS(SVG_NS, "line");
      element.setAttribute("x1", String(shape.line[0])); element.setAttribute("y1", String(shape.line[1])); element.setAttribute("x2", String(shape.line[2])); element.setAttribute("y2", String(shape.line[3]));
    }
    element.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(element);
  }
  return svg;
}

/**
 * The plugin mark: a flat accent tile with a cloud and two opposing arrows. It uses the
 * theme's accent color, so it fits any theme, and has no gradients or effects.
 */
export function createLogo(size = 32): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("nyra-nc-logo");
  const tile = document.createElementNS(SVG_NS, "rect");
  tile.setAttribute("width", "32"); tile.setAttribute("height", "32"); tile.setAttribute("rx", "8");
  tile.setAttribute("fill", "var(--interactive-accent)");
  const glyph = document.createElementNS(SVG_NS, "g");
  glyph.setAttribute("transform", "translate(16 16.2) scale(1.2) translate(-12 -12)");
  glyph.setAttribute("fill", "none");
  glyph.setAttribute("stroke", "var(--text-on-accent, #fff)");
  glyph.setAttribute("stroke-width", "1.4");
  glyph.setAttribute("stroke-linecap", "round");
  glyph.setAttribute("stroke-linejoin", "round");
  for (const d of [
    "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z", // cloud
    "M9 16v-4M7.4 13.4 9 11.8l1.6 1.6",                   // up arrow
    "M15 12v4M13.4 14.6 15 16.2l1.6-1.6"                  // down arrow
  ]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    glyph.appendChild(path);
  }
  svg.append(tile, glyph);
  return svg;
}
