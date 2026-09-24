/**
 * CAPTCHA awareness — detection only. The agent never solves or bypasses a
 * CAPTCHA; a visible one always hands control to you.
 *
 * Greenhouse and Ashby embed invisible reCAPTCHA Enterprise and Lever embeds
 * invisible hCaptcha on every form, so "a captcha iframe exists" is always
 * true and means nothing. What matters is whether a challenge (image grid) or
 * an unticked checkbox widget is actually visible.
 */
const CHALLENGE = /recaptcha\/.*\/bframe|hcaptcha\.com\/.*frame=challenge|challenges\.cloudflare\.com/i;
const CHECKBOX = /recaptcha\/.*\/anchor(?!.*size=invisible)|hcaptcha\.com\/.*frame=checkbox(?!-invisible)|challenges\.cloudflare\.com/i;

export async function captchaChallengeVisible(page) {
  for (const frame of page.frames()) {
    const url = frame.url();
    if (!CHALLENGE.test(url) && !CHECKBOX.test(url)) continue;
    try {
      const el = await frame.frameElement();
      if (!(await el.isVisible())) continue;
      const box = await el.boundingBox();
      // Hidden challenge containers are parked off-screen or collapsed.
      if (!box || box.width < 60 || box.height < 60 || box.y < -100 || box.x < -100) continue;
      return true;
    } catch {
      // detached frame
    }
  }
  return false;
}
