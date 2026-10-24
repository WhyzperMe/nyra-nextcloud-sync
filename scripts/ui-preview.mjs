// Renders the settings UI with fake data in headless Chrome and writes screenshots (design review tool).
// Usage: node scripts/ui-preview.mjs <output-dir> [scenario,theme,width,tab ...]   e.g.  healthy,dark,1000
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const out = resolve(process.argv[2] ?? "ui-preview-out");
mkdirSync(out, { recursive: true });
await esbuild.build({
  entryPoints: ["e2e/ui-preview/preview.ts"], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: join(out, "preview.js"),
  alias: { obsidian: resolve("e2e/ui-preview/obsidian-dom.ts") }, logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' }
});
copyFileSync("styles.css", join(out, "styles.css"));
// Prefer Obsidian's real stylesheet (extract it from your install: npx @electron/asar extract-file <Obsidian>/resources/obsidian.asar app.css)
// so the preview shows what the app's own CSS does to the plugin; fall back to a small emulation of the theme variables.
const realCss = process.env.OBSIDIAN_APP_CSS;
copyFileSync(realCss && existsSync(realCss) ? realCss : "e2e/ui-preview/obsidian-base.css", join(out, "base.css"));
writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="styles.css"><body><script src="preview.js"></script>`);

const chrome = process.env.CHROME ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const shots = process.argv.slice(3).length ? process.argv.slice(3) : ["healthy,dark,1000", "healthy,light,1000"];
for (const shot of shots) {
  const [scenario, theme, width, tab = "", height = "2600", scale = "1", extra = ""] = shot.split(","); // extra: raw query suffix, e.g. open=1
  const file = join(out, `${scenario}-${theme}-${width}${tab ? `-${tab}` : ""}${extra ? `-${extra.replace(/[^a-z0-9]+/gi, "_")}` : ""}.png`);
  const page = scenario === "icons" ? "&page=icons" : "";
  const narrow = Number(width) < 600; // Chrome will not render windows narrower than ~500px, so emulate the pane width instead
  const url = `${pathToFileURL(join(out, "index.html")).href}?scenario=${scenario}&theme=${theme}${page}${tab ? `&tab=${tab}` : ""}${narrow ? `&w=${width}` : ""}${extra ? `&${extra.replaceAll(";", "&")}` : ""}`;
  const result = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${join(out, "profile")}`, "--hide-scrollbars", `--window-size=${narrow ? 600 : width},${height}`, `--force-device-scale-factor=${scale}`, `--screenshot=${file}`, url], { encoding: "utf8", timeout: 60000 });
  console.log(`${result.status === 0 ? "ok" : "FAILED"} ${file}`);
}
