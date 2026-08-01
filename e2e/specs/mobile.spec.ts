import { test, expect } from "@playwright/test";

const SLUG = "default";

test("review: the value pane scrolls on a phone", async ({ page }) => {
  await page.goto(`/app/${SLUG}/triage`);
  await page.getByText("Country", { exact: false }).first().click();
  await expect(page.getByText("Choose record").first()).toBeVisible();

  const pane = page.locator(".min-h-0.flex-1.overflow-auto").first();
  const box = await pane.evaluate((el) => ({
    scrollH: el.scrollHeight,
    clientH: el.clientHeight,
  }));

  // The pane must be bounded by the viewport, not grown to content height.
  expect(box.clientH).toBeLessThan(844);
  expect(box.scrollH).toBeGreaterThan(box.clientH);
});

/* Touch-scrolling the page behind an open dropdown used to drag the dropdown
   across the screen, because every popover re-placed itself against its anchor
   on every scroll. It now closes instead — but only for a scroll of the page,
   not of the popover's own list (#197).

   The Activity page is the mobile home for this: its timeline overflows a phone
   viewport (the Sources page does not, so a scroll there is a no-op that would
   assert nothing) and its Who picker has an inner scroller of its own. */
test("a page scroll closes an open popover; scrolling its own list does not", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);
  // Wait for the timeline before opening anything: the page must already
  // overflow, or the scroll below is a no-op that would assert nothing.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const m = document.querySelector("#main");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(250);

  await page.getByRole("button", { name: /Who/ }).first().click();
  const panel = page.getByPlaceholder("Find a person…");
  await expect(panel).toBeVisible();
  // A popover ignores scrolls for its first ARM_DELAY_MS (AnchoredPopover), so
  // the browser scrolling a freshly focused input into view can't close it the
  // instant it opens. A person cannot scroll that fast; this test can.
  await page.waitForTimeout(250);

  // Scrolling the picker's own list must leave it open.
  await page.evaluate(() => {
    const list = document.querySelector("body > div ul.overflow-auto");
    list?.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await expect(panel).toBeVisible();

  // Scrolling the page underneath it must close it.
  const scrolled = await page.evaluate(() => {
    const main = document.querySelector("#main");
    if (!main) return 0;
    main.scrollBy(0, 250);
    return main.scrollTop;
  });
  expect(scrolled, "the page must really scroll for this to test anything").toBeGreaterThan(0);

  await expect(panel).toBeHidden();
});

test("source rows fit the screen and keep their actions reachable", async ({ page }) => {
  await page.goto(`/app/${SLUG}/sources`);
  await page.getByText("Raw", { exact: false }).first().click();

  const menuButton = page.getByRole("button", { name: "More actions" }).first();
  await expect(menuButton).toBeInViewport();

  // No row may be wider than the card that holds it.
  const overflowing = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[class*="grid-cols-"]'))
      .filter((el) => el.scrollWidth > el.clientWidth + 2).length,
  );
  expect(overflowing).toBe(0);
});

test("add source is gated with an explanation on a phone", async ({ page }) => {
  await page.goto(`/app/${SLUG}/sources`);

  const addSource = page.getByRole("button", { name: /add source/i });
  await expect(addSource).toBeVisible();

  await addSource.click();

  await expect(page.getByLabel("Add source")).toBeHidden();
  await expect(page.getByText(/larger screen/i)).toBeVisible();
});

test("modals stay inside the screen", async ({ page }) => {
  await page.goto(`/app/${SLUG}/settings/webhooks`);
  await page.getByRole("button", { name: /add endpoint|new webhook|create/i }).first().click();

  const panel = page.locator('[role="dialog"] > div, .fixed.inset-0 > div').first();
  await expect(panel).toBeVisible();

  // The backdrop is a flex container, which shrinks the panel to fit the
  // viewport by default regardless of its own width class — so a bounding-box
  // check alone can't tell a clamped panel from an unclamped one (both render
  // at 390px wide). Assert on the CSS itself: max-w-full must be present, so
  // max-width resolves to a pixel value instead of the unset "none".
  const maxWidth = await panel.evaluate((el) => getComputedStyle(el).maxWidth);
  expect(maxWidth).not.toBe("none");

  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

/* #197 Task 8 — the nav drawer, command palette, and confirm dialog now lock
   background scroll while open (useScrollLock, refcounted so stacked overlays
   don't unlock each other early).

   These assert the actual behaviour, not the lock's mechanism: with an
   overlay open, #main.scrollTop must not move for a scrollBy — not
   "document.body.style.overflow === 'hidden'". An earlier version of these
   tests asserted body's computed style instead, which is vacuous here: body
   never scrolls in this app (every shell confines scrolling to a nested
   overflow-y-auto region), so a body-only lock left #main scrolling right
   behind the backdrop while the body-style assertion stayed green throughout.
   useScrollLock now also freezes that real container (#main, or the admin
   shells' fallback) — see use-scroll-lock.ts. */
test("opening the nav drawer does not snap #main back to the top", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  // useScrollLock uses overflow:clip on #main (the only value that actually
  // blocks scrollBy — see use-scroll-lock.ts), which forces the browser to
  // repaint the container as if scrolled to 0 the instant it's applied —
  // #main.scrollTop itself reads 0 while clip is active regardless of the
  // fix, so it can't be the signal here. What must not move is what's
  // actually on screen: the hook compensates with a matching transform, so
  // assert on real paint position (getBoundingClientRect), not the property
  // that clip makes unreliable to read.
  const contentTop = () =>
    page.evaluate(() => {
      const el = document.querySelector("#main")?.querySelector("*");
      return el ? el.getBoundingClientRect().top : null;
    });

  await page.evaluate(() => document.querySelector("#main")?.scrollBy(0, 400));
  const before = await contentTop();
  expect(before).not.toBeNull();
  // Scrolled 400px down, content's top edge should now be well above (a very
  // negative number relative to) the viewport.
  expect(before!).toBeLessThan(-100);

  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();

  const during = await contentTop();
  expect(during).not.toBeNull();
  expect(Math.abs(during! - before!)).toBeLessThan(5);
});

test("the nav drawer locks background scroll and releases it on close", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  // #main must genuinely overflow on this page, or a locked and an unlocked
  // page would be indistinguishable below (scrollBy would be a no-op either
  // way) — fail loudly instead of passing vacuously if that stops holding.
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  const scrollMain = (delta: number) =>
    page.evaluate((d) => {
      const m = document.querySelector("#main");
      if (!m) return null;
      const before = m.scrollTop;
      m.scrollBy(0, d);
      return m.scrollTop !== before;
    }, delta);
  const resetMainScroll = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      if (m) m.scrollTop = 0;
    });

  // Sanity check the precondition end to end: unlocked, a scroll really moves it.
  expect(await scrollMain(300)).toBe(true);
  await resetMainScroll();

  // The drawer never leaves the DOM (it's hidden via a translateX transform,
  // not unmounted), so toBeVisible/toBeHidden — which only look at
  // display/visibility/size — can't tell it apart from open. Read its actual
  // screen position instead: closed, it's translated fully off the left edge.
  const drawerOpen = async () => {
    const box = await page.getByRole("dialog", { name: "Navigation" }).boundingBox();
    return box !== null && box.x >= 0;
  };

  // Re-check the overflow precondition before each "still scrollable" assert
  // below — Activity's feed can legitimately re-render between cycles (e.g.
  // on refocus), and a momentarily-shorter list would make scrollMain a
  // vacuous no-op rather than a real failure of the lock.
  const expectScrollableAgain = async () => {
    await expect.poll(mainOverflow).toBeGreaterThan(250);
    await expect
      .poll(() => scrollMain(300), "scrolling must work again once closed")
      .toBe(true);
  };

  // Close by the header's X button.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await scrollMain(300)).toBe(false);
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect.poll(drawerOpen).toBe(false);
  await expectScrollableAgain();
  await resetMainScroll();

  // Close by Escape.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await scrollMain(300)).toBe(false);
  await page.keyboard.press("Escape");
  await expect.poll(drawerOpen).toBe(false);
  await expectScrollableAgain();
  await resetMainScroll();

  // Close by backdrop click. The backdrop spans the full screen, but the
  // drawer panel (higher z-index, ~85vw wide) visually sits on top of most
  // of it — clicking the backdrop locator's default (center) position lands
  // on the panel's own sidebar content instead once its slide-in transition
  // settles, occasionally navigating the app instead of closing the drawer.
  // Click a point past the panel's right edge, clear of it.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await scrollMain(300)).toBe(false);
  await page
    .locator('[aria-hidden="true"].fixed.inset-0')
    .first()
    .click({ force: true, position: { x: 370, y: 700 } });
  await expect.poll(drawerOpen).toBe(false);
  await expectScrollableAgain();
});

test("scroll lock survives a stacked drawer + command palette and lifts only once both close", async ({
  page,
}) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  const scrollMain = (delta: number) =>
    page.evaluate((d) => {
      const m = document.querySelector("#main");
      if (!m) return null;
      const before = m.scrollTop;
      m.scrollBy(0, d);
      return m.scrollTop !== before;
    }, delta);

  // Open the nav drawer, then stack the command palette on top of it. The
  // drawer's backdrop covers the topbar's palette-trigger button, so open the
  // palette via its global keyboard shortcut instead of clicking through it.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox")).toBeVisible();

  expect(await scrollMain(300)).toBe(false);

  // Close the inner overlay (palette) only, by clicking its own backdrop
  // below the result panel — not Escape, which AppShell's own global handler
  // also listens for and would close the drawer in the same keypress, which
  // would defeat the point of testing that the refcount (not a bare flag)
  // keeps the lock held while the drawer is still open underneath.
  await page.mouse.click(370, 700);
  await expect(page.getByRole("combobox")).toBeHidden();
  expect(await scrollMain(300)).toBe(false);

  // Close the drawer too — now the lock must lift.
  await page.keyboard.press("Escape");
  await expect
    .poll(() => scrollMain(300), "scrolling must work again once both are closed")
    .toBe(true);
});

test("the delete-table confirm dialog locks background scroll and releases it on every close path", async ({
  page,
}) => {
  await page.goto(`/app/${SLUG}/tables`);
  await page.waitForSelector("#main");

  // Unlike Activity, #main on the Tables route doesn't naturally overflow —
  // TablePane's grid is its own internally-virtualized scroller and fills
  // the viewport exactly, so #main itself has nothing to scroll here. Force
  // genuine overflow rather than depend on that ever changing; the poll
  // below still asserts it explicitly, so this fails loudly (not vacuously)
  // if #main stops existing or stops being the real container.
  await page.evaluate(() => {
    const m = document.querySelector("#main");
    if (!m) return;
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    m.appendChild(spacer);
  });

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });

  const scrollMain = (delta: number) =>
    page.evaluate((d) => {
      const m = document.querySelector("#main");
      if (!m) return null;
      const before = m.scrollTop;
      m.scrollBy(0, d);
      return m.scrollTop !== before;
    }, delta);

  // TableTabStrip mounts its delete-table ConfirmDialog only while a target is
  // set (open hardcoded true) — the other pattern in this codebase, distinct
  // from CommandPalette/the drawer, which are always mounted and toggle
  // `open`. useScrollLock(open) has to be correct for both.
  const firstTab = page.locator('[role="tab"]').first();
  await expect(firstTab).toBeVisible();
  await firstTab.click({ button: "right" });
  const deleteItem = page.getByText("Delete table…");
  if ((await deleteItem.count()) === 0) test.skip(true, "current role can't delete tables");
  await deleteItem.click();

  // Scoped by name — the (closed, off-screen) nav drawer is also role="dialog".
  const confirmDialog = page.getByRole("dialog", { name: /^Delete / });
  await expect(confirmDialog).toBeVisible();
  await expect.poll(mainOverflow).toBeGreaterThan(250);
  expect(await scrollMain(300)).toBe(false);

  // Cancel — never confirm the delete phrase, this only checks the lock.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmDialog).toBeHidden();
  await expect
    .poll(() => scrollMain(300), "scrolling must work again once closed")
    .toBe(true);
});
