/**
 * Attach an image to the LinkedIn share composer.
 * 2026 compose UI is /sharing/compose — toolbar button aria-label="Media",
 * then a file input (accept includes image/*) and Next.
 */

import fs from "node:fs";
import type { Locator, Page } from "playwright";
import { humanDelay } from "../linkedin-safety.js";

async function firstVisible(
  locators: Locator[],
  timeoutMs = 800,
): Promise<Locator | null> {
  for (const loc of locators) {
    const first = loc.first();
    if (await first.isVisible({ timeout: timeoutMs }).catch(() => false)) {
      return first;
    }
  }
  return null;
}

async function findMediaButton(page: Page): Promise<Locator | null> {
  return firstVisible(
    [
      page.locator('button[aria-label="Media"]'),
      page.getByRole("button", { name: /^media$/i }),
      page.locator('button[aria-label="Add media"]'),
      page.locator('button[aria-label="Add a photo"]'),
      page.getByRole("button", { name: /^photo$/i }),
    ],
    1500,
  );
}

async function findImageFileInput(page: Page): Promise<Locator | null> {
  for (const frame of page.frames()) {
    const loc = frame.locator(
      'input[type="file"][accept*="image"], input[type="file"][accept*="png"], input[type="file"][accept*="jpeg"]',
    );
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      return loc.nth(i);
    }
    const any = frame.locator('input[type="file"]');
    const n = await any.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const input = any.nth(i);
      const accept = (
        (await input.getAttribute("accept").catch(() => "")) ?? ""
      ).toLowerCase();
      if (accept.includes("video") && !accept.includes("image")) continue;
      return input;
    }
  }
  return null;
}

async function waitForImageFileInput(
  page: Page,
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = await findImageFileInput(page);
    if (input) return input;
    await page.waitForTimeout(200);
  }
  return null;
}

async function clickNextOrDone(page: Page): Promise<string | undefined> {
  const btn = await firstVisible(
    [
      page.getByRole("button", { name: /^next$/i }),
      page.getByRole("button", { name: /^done$/i }),
      page.getByRole("button", { name: /^apply$/i }),
    ],
    4000,
  );
  if (!btn) return undefined;
  const disabled =
    (await btn.isDisabled().catch(() => false)) ||
    (await btn.getAttribute("aria-disabled").catch(() => "")) === "true";
  if (disabled) {
    await page.waitForTimeout(2000);
  }
  const label = ((await btn.textContent().catch(() => "")) ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  await humanDelay("click");
  await btn.click({ force: true }).catch(() => undefined);
  await humanDelay("type_burst", { minMs: 800, maxMs: 1600 });
  return label || "next";
}

async function mediaPreviewVisible(page: Page): Promise<boolean> {
  const preview = await firstVisible(
    [
      page.locator("img[src*='blob:'], img[src*='licdn'], img[src*='media']"),
      page.locator("img[src^='data:image']"),
      page.getByRole("button", {
        name: /remove|edit image|delete photo|edit photo/i,
      }),
    ],
    5000,
  );
  return Boolean(preview);
}

export async function attachImageToComposer(
  page: Page,
  imagePath: string,
): Promise<string[]> {
  const notes: string[] = [];
  if (!fs.existsSync(imagePath)) {
    notes.push(`image_missing:${imagePath}`);
    return notes;
  }

  let input = await findImageFileInput(page);
  if (!input) {
    const mediaBtn = await findMediaButton(page);
    if (!mediaBtn) {
      notes.push("image_media_button_missing");
      return notes;
    }
    const chooserP = page
      .waitForEvent("filechooser", { timeout: 5000 })
      .then((c) => c)
      .catch(() => null);
    await mediaBtn.click({ force: true }).catch(() => undefined);
    notes.push("image_media_clicked");
    await page
      .getByText(/select files to begin|share images/i)
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => undefined);

    const chooser = await chooserP;
    if (chooser) {
      await chooser.setFiles(imagePath);
      notes.push("image_filechooser");
    } else {
      input = await waitForImageFileInput(page, 8000);
    }
  }

  if (input) {
    try {
      await input.setInputFiles(imagePath);
      notes.push("image_file_input");
    } catch (err) {
      notes.push(
        `image_set_input_failed:${err instanceof Error ? err.message : String(err)}`,
      );
      return notes;
    }
  } else if (!notes.includes("image_filechooser")) {
    notes.push("image_upload_control_missing");
    return notes;
  }

  await humanDelay("type_burst", { minMs: 1500, maxMs: 2800 });
  const first = await clickNextOrDone(page);
  if (first) notes.push(`image_editor_${first}`);
  const second = await clickNextOrDone(page);
  if (second) notes.push(`image_editor_${second}`);

  if (await mediaPreviewVisible(page)) {
    notes.push("image_attached");
  } else {
    notes.push("image_preview_missing");
  }
  return notes;
}
