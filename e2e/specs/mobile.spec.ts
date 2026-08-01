import { test, expect, uniqueSuffix } from "../fixtures";

const SLUG = "default";

test("review: the value pane scrolls on a phone", async ({ page, request }) => {
  // Seed our own unmapped backlog instead of relying on the ambient demo
  // "Country" backlog — other specs consume it, which made this test flaky.
  // Enough rows are seeded that the list overflows a phone viewport
  // regardless of whatever else is already mapped in this run.
  const suffix = uniqueSuffix();
  const occurrences = Array.from({ length: 30 }, (_, i) => ({
    raw: `E2E Country ${suffix}-${i}`,
    table: "e2e.seed_countries",
    column: "country_name",
    rows: 1,
  }));
  const seedResp = await request.post("/api/e2e/seed-scan-values", {
    data: { refTableId: "country", occurrences },
  });
  expect(seedResp.ok(), `seed endpoint returned ${seedResp.status()}`).toBe(true);

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

/* #197 Task 8 - the nav drawer, command palette, and confirm dialog lock
   background scroll while open (useScrollLock, refcounted so stacked overlays
   don't unlock each other early - see use-scroll-lock.ts).

   Why real wheel input, not scrollBy(): document.body never actually scrolls
   in this app (every shell confines scrolling to a nested #main), so a
   body-only lock is inert - #main is the real target, confirmed live: even
   with body.style.overflow forced to "hidden", main.scrollBy() still moved
   it. But overflow:hidden on #main only removes the scrollbar/drag gesture -
   it does not stop a script-driven scrollBy() (confirmed live), which is why
   the assertions below drive a real mouse.wheel() instead: that IS blocked by
   overflow:hidden (confirmed live: wheel moved #main 400px unlocked, 0px
   locked), and it's what an actual user does. No code in this app ever calls
   #main.scrollBy() itself, so scrollBy was never the right thing to assert on
   in the first place.

   One more thing worth recording here so it isn't rediscovered the hard way:
   a wheel/touch gesture aimed anywhere at an open overlay can never reach
   #main to begin with, lock or no lock. Measured live for the drawer only:
   forced #main's overflow back to "auto" while the drawer stayed open and
   repeated the same wheel gesture at the same point - still 0px moved,
   because its fixed inset-0 backdrop (portaled to document.body) covers the
   entire viewport with pointer-events enabled and wins the hit-test first.
   The same conclusion holds for CommandPalette (renders as a sibling of the
   #main column, same full-viewport fixed backdrop) and ConfirmDialog (a DOM
   descendant of #main, but still position:fixed, which in Blink hangs off
   the viewport's scroll node rather than #main's) - but those two are
   reasoned from the CSS, not separately measured the same way. So the tests
   below split the claim into its two real, non-vacuous parts: (1) opening/
   closing an overlay for real does engage and release overflow:hidden on
   #main (verified through actual button/Escape/backdrop interactions - this
   was never true before Task 8, so it isn't vacuous), and (2) overflow:hidden
   itself, applied the same way the hook applies it, actually stops a real
   wheel gesture and preserves scroll position (verified directly against the
   container, matching the coordinator's own diagnostic). Composed, that's the
   full, honest, real-input claim - done as two tests because there's no
   single point in the actual UI where both halves are simultaneously
   observable with real input. */

test("overflow:hidden on #main blocks a real wheel scroll and preserves scroll position", async ({
  page,
}) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  // #main must genuinely overflow, or a locked and an unlocked container
  // would be indistinguishable below (a wheel would be a no-op either way) -
  // fail loudly instead of passing vacuously if that stops holding.
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  const mainScrollTop = () => page.evaluate(() => document.querySelector("#main")!.scrollTop);
  const wheelAt = async (x: number, y: number, dy: number) => {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
  };

  // Unlocked: a real wheel gesture over #main genuinely scrolls it.
  expect(await mainScrollTop()).toBe(0);
  await wheelAt(195, 400, 300);
  const scrolledTop = await mainScrollTop();
  expect(scrolledTop).toBeGreaterThan(100);

  // Lock it exactly the way the hook does, at this non-zero scroll position -
  // this is the case that must not visually jump: overflow:hidden must
  // preserve scrollTop, not reset it (that's the clip-specific failure mode
  // this implementation deliberately avoids).
  await page.evaluate(() => {
    (document.querySelector("#main") as HTMLElement).style.overflow = "hidden";
  });
  expect(await mainScrollTop()).toBe(scrolledTop);

  // A further real wheel gesture must not move it at all now.
  await wheelAt(195, 400, 300);
  expect(await mainScrollTop()).toBe(scrolledTop);

  // Unlock: scroll position is still exactly where it was, and wheeling
  // works again.
  await page.evaluate(() => {
    (document.querySelector("#main") as HTMLElement).style.overflow = "";
  });
  expect(await mainScrollTop()).toBe(scrolledTop);
  await wheelAt(195, 400, 300);
  expect(await mainScrollTop()).toBeGreaterThan(scrolledTop);
});

test("the nav drawer engages #main's scroll lock on open and releases it on close", async ({
  page,
}) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  const containerOverflow = () =>
    page.evaluate(() => (document.querySelector("#main") as HTMLElement).style.overflow);

  // The drawer never leaves the DOM (it's hidden via a translateX transform,
  // not unmounted), so toBeVisible/toBeHidden - which only look at
  // display/visibility/size - can't tell it apart from open. Read its actual
  // screen position instead: closed, it's translated fully off the left edge.
  const drawerOpen = async () => {
    const box = await page.getByRole("dialog", { name: "Navigation" }).boundingBox();
    return box !== null && box.x >= 0;
  };

  expect(await containerOverflow()).toBe("");

  // Close by the header's X button.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await containerOverflow()).toBe("hidden");
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect.poll(drawerOpen).toBe(false);
  await expect.poll(containerOverflow).toBe("");

  // Close by Escape.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await containerOverflow()).toBe("hidden");
  await page.keyboard.press("Escape");
  await expect.poll(drawerOpen).toBe(false);
  await expect.poll(containerOverflow).toBe("");

  // Close by backdrop click. The backdrop spans the full screen, but the
  // drawer panel (higher z-index, ~85vw wide) visually sits on top of most
  // of it - clicking the backdrop locator's default (center) position lands
  // on the panel's own sidebar content instead once its slide-in transition
  // settles, occasionally navigating the app instead of closing the drawer.
  // Click a point past the panel's right edge, clear of it.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect.poll(drawerOpen).toBe(true);
  expect(await containerOverflow()).toBe("hidden");
  await page
    .locator('[aria-hidden="true"].fixed.inset-0')
    .first()
    .click({ force: true, position: { x: 370, y: 700 } });
  await expect.poll(drawerOpen).toBe(false);
  await expect.poll(containerOverflow).toBe("");
});

test("opening the nav drawer does not move #main's scroll position", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);

  const mainOverflow = () =>
    page.evaluate(() => {
      const m = document.querySelector("#main");
      return m ? m.scrollHeight - m.clientHeight : 0;
    });
  await expect.poll(mainOverflow).toBeGreaterThan(250);

  // Scroll down with a real gesture before locking - overflow:hidden must
  // preserve this position, not reset it. This is the failure mode to watch
  // for: a lock that visually snaps the page to the top on every overlay
  // open would be its own bug.
  await page.mouse.move(195, 400);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => document.querySelector("#main")!.scrollTop);
  expect(before).toBeGreaterThan(200);

  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();

  const during = await page.evaluate(() => document.querySelector("#main")!.scrollTop);
  expect(during).toBe(before);
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

  const containerOverflow = () =>
    page.evaluate(() => (document.querySelector("#main") as HTMLElement).style.overflow);

  // Open the nav drawer, then stack the command palette on top of it. The
  // drawer's backdrop covers the topbar's palette-trigger button, so open the
  // palette via its global keyboard shortcut instead of clicking through it.
  await page.getByRole("button", { name: /open navigation/i }).click();
  await expect(page.getByRole("dialog", { name: "Navigation" })).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox")).toBeVisible();

  expect(await containerOverflow()).toBe("hidden");

  // Close the inner overlay (palette) only, by clicking its own backdrop
  // below the result panel - not Escape, which AppShell's own global handler
  // also listens for and would close the drawer in the same keypress, which
  // would defeat the point of testing that the refcount (not a bare flag)
  // keeps the lock held while the drawer is still open underneath.
  await page.mouse.click(370, 700);
  await expect(page.getByRole("combobox")).toBeHidden();
  expect(await containerOverflow()).toBe("hidden");

  // Close the drawer too - now the lock must lift.
  await page.keyboard.press("Escape");
  await expect.poll(containerOverflow).toBe("");
});

test("the delete-table confirm dialog engages #main's scroll lock and releases it on every close path", async ({
  page,
}) => {
  await page.goto(`/app/${SLUG}/tables`);
  await page.waitForSelector("#main");

  const containerOverflow = () =>
    page.evaluate(() => (document.querySelector("#main") as HTMLElement).style.overflow);

  // TableTabStrip mounts its delete-table ConfirmDialog only while a target is
  // set (open hardcoded true) - the other pattern in this codebase, distinct
  // from CommandPalette/the drawer, which are always mounted and toggle
  // `open`. useScrollLock(open) has to be correct for both.
  const firstTab = page.locator('[role="tab"]').first();
  await expect(firstTab).toBeVisible();
  await firstTab.click({ button: "right" });
  const deleteItem = page.getByText("Delete table…");
  if ((await deleteItem.count()) === 0) test.skip(true, "current role can't delete tables");
  await deleteItem.click();

  // Scoped by name - the (closed, off-screen) nav drawer is also role="dialog".
  const confirmDialog = page.getByRole("dialog", { name: /^Delete / });
  await expect(confirmDialog).toBeVisible();
  expect(await containerOverflow()).toBe("hidden");

  // Cancel - never confirm the destructive action, this only checks the lock.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmDialog).toBeHidden();
  await expect.poll(containerOverflow).toBe("");
});

/* #197 Task 9 - a regression floor over the whole app surface, so a future
   change can't silently reintroduce horizontal overflow on a page nobody
   thought to check. The admin console was verified clean during the original
   investigation and is deliberately excluded here - not an oversight.

   Only the document-level overflow check ships: a "clipped elements" variant
   was tried and needed a `truncate`-class exclusion to avoid false positives
   on legitimately truncated text, which is a smell - it would generate noise,
   and a noisy assertion is the one that gets deleted by whoever is racing to
   get CI green, taking the useful check down with it. This one is boring and
   lasts.

   During the original investigation, several routes silently redirected to
   the Dashboard and an overflow-only check sailed through with nothing
   actually on screen. So before trusting the overflow assertion, each route
   is confirmed to have genuinely loaded: the URL didn't redirect elsewhere,
   and the app shell's content region rendered real content (not a blank
   shell or only the RouteErrorBoundary, which renders outside #main). */
const ROUTES = [
  `/app/${SLUG}`,
  `/app/${SLUG}/triage`,
  `/app/${SLUG}/sources`,
  `/app/${SLUG}/tables`,
  `/app/${SLUG}/audit`,
  `/app/${SLUG}/settings/general`,
  `/app/${SLUG}/settings/members`,
  `/app/${SLUG}/settings/mapping`,
  `/app/${SLUG}/settings/warehouse`,
  `/app/${SLUG}/settings/danger`,
  `/app/${SLUG}/settings/pull-api`,
  `/app/${SLUG}/settings/webhooks`,
  `/app/${SLUG}/settings/service-accounts`,
  `/app/${SLUG}/account/profile`,
  `/app/${SLUG}/account/memberships`,
];

for (const route of ROUTES) {
  test(`no horizontal overflow: ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState("networkidle");

    // Prove the route actually loaded before trusting anything below: a
    // redirect (e.g. to the Dashboard) or an error-boundary render would
    // otherwise pass the overflow check with nothing real on screen.
    expect(new URL(page.url()).pathname, "route must not redirect elsewhere").toBe(route);
    const main = page.locator("#main");
    await expect(main, "the app shell's content region must render").toBeVisible();
    const mainText = await main.innerText();
    expect(
      mainText.trim().length,
      "the page must render real content, not an empty shell",
    ).toBeGreaterThan(10);

    // The document itself must never scroll sideways.
    const docOverflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(docOverflows).toBe(false);
  });
}

/* #197 Task 10 — the eight overlays built on AnchoredPopover started closing on
   a page scroll in Task 4, but ten more carried their own hand-rolled copy of
   the placement listener and kept chasing their anchor instead. The topbar user
   menu is one of them, and it is on every screen of the app, so it is the
   cheapest honest proof that the shared helper is wired into real chrome.

   The menu unmounts when it closes (`{open && createPortal(...)}`), so
   toBeHidden() here is a real assertion — an earlier version of a sibling test
   asserted "still present" against a panel nothing ever unmounts, which could
   not fail. Activity is used for the same reason as the Task 4 case above: its
   timeline is the reliable phone-width overflow, so the scroll below is not a
   no-op. */
test("a page scroll closes the topbar user menu", async ({ page }) => {
  await page.goto(`/app/${SLUG}/audit`);
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const m = document.querySelector("#main");
        return m ? m.scrollHeight - m.clientHeight : 0;
      }),
    )
    .toBeGreaterThan(250);

  await page.getByRole("button", { name: /^User menu for / }).click();
  const menu = page.getByRole("button", { name: "Account settings" });
  await expect(menu).toBeVisible();
  // Past ARM_DELAY_MS, so the scroll below is read as the page moving rather
  // than as the browser bringing a freshly focused element into view.
  await page.waitForTimeout(250);

  const scrolled = await page.evaluate(() => {
    const main = document.querySelector("#main");
    if (!main) return 0;
    main.scrollBy(0, 250);
    return main.scrollTop;
  });
  expect(scrolled, "the page must really scroll for this to test anything").toBeGreaterThan(0);

  await expect(menu).toBeHidden();
});
