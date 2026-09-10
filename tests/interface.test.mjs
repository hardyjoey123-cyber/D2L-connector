/**
 * The countdown interface, in a real browser.
 *
 * Not part of `npm test`: it needs Playwright and a running server, so it stays
 * a deliberate step. See tests/README.md for how to run it.
 */
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:8917";
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.on("pageerror", (e) => { console.log("PAGE ERROR:", e.message); failures++; });
await page.goto(BASE);
await page.waitForTimeout(900);

async function ask(text) {
  await page.keyboard.press("/");
  await page.fill("#typed-input", text);
  await page.keyboard.press("Enter");
}

// 1. The countdown banner, not the typed dialog.
await ask("buy fifty dollars of nvidia");
await page.waitForSelector("#placing:not([hidden])", { timeout: 5000 });
check("1 the countdown banner appears", true);
check("2 the type-the-ticker dialog does NOT appear", await page.isHidden("#confirm"));
check("3 the order is named", (await page.textContent("#placing-summary")).includes("NVDA"),
  await page.textContent("#placing-summary"));
const firstCount = Number(await page.textContent("#placing-count"));
await page.screenshot({ path: "./20-countdown.png" });
await page.waitForTimeout(1100);
const laterCount = Number(await page.textContent("#placing-count"));
check("4 it counts down", laterCount < firstCount, `${firstCount} then ${laterCount}`);

// It should place itself and say so.
await page.waitForSelector("#placing", { state: "hidden", timeout: 12000 });
const log = await page.textContent("#log");
check("5 the placement is reported", /Order placed: Buy \$50 of NVDA/.test(log),
  log.split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" / "));

// 2. Cancelling with the button places nothing.
await page.waitForTimeout(600);
await ask("buy fifty dollars of nvidia");
await page.waitForSelector("#placing:not([hidden])", { timeout: 5000 });
await page.click("#placing-cancel");
check("6 the banner closes on cancel", await page.isHidden("#placing"));
await page.waitForTimeout(5000);
const log2 = await page.textContent("#log");
check("7 cancelling is recorded", /Cancelled: Buy \$50 of NVDA/.test(log2));
check("8 nothing was placed after a cancel",
  (log2.match(/Order placed/g) ?? []).length === 1,
  `${(log2.match(/Order placed/g) ?? []).length} placements in the log`);

// 3. Escape also cancels.
await ask("buy fifty dollars of nvidia");
await page.waitForSelector("#placing:not([hidden])", { timeout: 5000 });
await page.click("body");
await page.keyboard.press("Escape");
check("9 Escape cancels the countdown", await page.isHidden("#placing"));
await page.waitForTimeout(4500);
const log3 = await page.textContent("#log");
check("10 Escape placed nothing", (log3.match(/Order placed/g) ?? []).length === 1,
  `${(log3.match(/Order placed/g) ?? []).length} placements in the log`);

await page.screenshot({ path: "./21-after.png" });
await browser.close();
console.log(failures === 0 ? "\nVERDICT: the countdown interface works." : `\nVERDICT: ${failures} failing.`);
process.exit(failures === 0 ? 0 : 1);
