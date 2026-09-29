import { execFileSync } from "node:child_process";
import { chromium, expect, firefox, test } from "@playwright/test";

/**
 * ldapgate renders the login page in production, so this renders the same
 * template with Jinja and runs its real markup, CSS and script in each browser.
 * The specs launch their own browsers (Firefox needs a profile pref), so they
 * run once, under the chromium project.
 */
test.skip(({ browserName }) => browserName !== "chromium", "launches its own browsers");

const loginHtml = execFileSync(
  "uv",
  [
    "run",
    "python",
    "-c",
    [
      "from jinja2 import Environment, FileSystemLoader",
      "env = Environment(loader=FileSystemLoader('xwing/templates'), autoescape=True)",
      "print(env.get_template('login.html').render(csrf_nonce='n', csrf_token='t', login_path='/login', redirect='', error=None))",
    ].join("\n"),
  ],
  { cwd: "..", encoding: "utf8" },
);

const NATIVE_REVEAL_BUTTON = "layout.forms.reveal-password-button.enabled";

test("Firefox that draws its own reveal button shows only that one", async () => {
  const browser = await firefox.launch({ firefoxUserPrefs: { [NATIVE_REVEAL_BUTTON]: true } });
  try {
    const page = await browser.newPage();

    // Premise: Firefox reserves room for its button, so a bare password input is
    // narrower than a bare text input. If this fails, Firefox changed how the
    // button is laid out and browserDrawsRevealButton() in login.html no longer
    // sees it: open the login page in Firefox with the pref on and look for two eyes.
    await page.setContent('<input id="p" type="password"><input id="t" type="text">');
    const passwordWidth = await page.locator("#p").evaluate((el) => el.clientWidth);
    const textWidth = await page.locator("#t").evaluate((el) => el.clientWidth);
    expect(passwordWidth).toBeLessThan(textWidth);

    await page.setContent(loginHtml);
    await page.fill("#password", "hunter2");
    await expect(page.locator("#password-toggle")).toBeHidden();
    await expect(page.locator(".reveal-probe")).toHaveCount(0);
  } finally {
    await browser.close();
  }
});

const withoutBrowserRevealButton = [
  ["Firefox without its own reveal button", () => firefox.launch({ firefoxUserPrefs: { [NATIVE_REVEAL_BUTTON]: false } })],
  ["Chromium", () => chromium.launch()],
] as const;

for (const [name, launch] of withoutBrowserRevealButton) {
  test(`${name} shows the custom toggle and it works`, async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.setContent(loginHtml);
      await page.fill("#password", "hunter2");

      const toggle = page.getByRole("button", { name: "Show password" });
      await expect(toggle).toBeVisible();
      await expect(page.locator(".reveal-probe")).toHaveCount(0);

      await toggle.click();
      await expect(page.locator("#password")).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "Hide password" }).click();
      await expect(page.locator("#password")).toHaveAttribute("type", "password");
    } finally {
      await browser.close();
    }
  });
}
