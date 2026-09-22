import { expect, type Page, test } from "@playwright/test";
import { routeGateway } from "./gateway-fixtures";

/**
 * Visão da rede with **no promoted model** — which is the state production has
 * been in for weeks, and which used to render as two sentences and three panels
 * below the fold.
 *
 * Every panel now answers what settled data can answer with no artifact at all:
 * the map, the four rows, the 24-hour profile, the wind/solar split and the two
 * day figures. That is the gain. The risk it buys is a single one, and it is
 * what this file exists for:
 *
 * > a reader taking a **settled** figure for a **forecast**.
 *
 * A unit test can assert that the two vocabularies are separate in the source.
 * Only a browser can assert that they are separate *on the screen*, which is
 * where a reader meets them — so the two states are driven against the same
 * export, a region's actual painted `fill` is read out of the DOM in each, and
 * the two are required to differ. That assertion is the reason this file is not
 * a unit test: `fill` is what the eye sees, and nothing upstream of the renderer
 * can promise it.
 */

/** A region on the map, by the `data-region` the map stamps on its path. */
function region(page: Page, code: string) {
  return page.locator(`[data-region="${code}"]`);
}

async function screenText(page: Page): Promise<string> {
  return (await page.locator("body").textContent()) ?? "";
}

/** Every region's painted fill, in display order. */
async function fills(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const code of ["N", "NE", "SE", "S"]) {
    out.push((await region(page, code).getAttribute("fill")) ?? "");
  }
  return out;
}

async function labels(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const code of ["N", "NE", "SE", "S"]) {
    out.push((await region(page, code).getAttribute("aria-label")) ?? "");
  }
  return out;
}

test.describe("with nothing promoted, the screen still shows the grid", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: false });
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
  });

  test("the map renders, and reads as settled energy rather than risk", async ({
    page,
  }) => {
    await expect(region(page, "NE")).toHaveCount(1);
    const spoken = await labels(page);
    for (const label of spoken) {
      // What a screen reader hears. It must name the measurement and the
      // window, and must not name a risk class or a probability — the map is
      // the single place on this screen where one word would turn a
      // measurement into a claim about tomorrow.
      expect(label).toMatch(/MWh/);
      expect(label).toMatch(/liquidad|settled/i);
      expect(label).not.toMatch(/risco|risk/i);
      expect(label).not.toMatch(/previs|forecast/i);
    }
    // The figure itself is printed on the region, so the map reads with the
    // hues removed — and so the observed map cannot be mistaken for the
    // forecast one, which prints a three-step glyph and no number.
    const text = await screenText(page);
    expect(text).toMatch(/Observado/);
  });

  test("the five panels a model used to gate are all on the screen", async ({ page }) => {
    const text = await screenText(page);
    for (const heading of [
      // The map and its rows.
      "Os quatro subsistemas",
      // The 24-hour profile, as the settled day.
      "o último dia liquidado",
      // The two day figures.
      "Energia cortada liquidada, dia inteiro",
      "Maior hora liquidada",
      // And the episode list, which was always here.
      "Episódios recentes",
    ]) {
      expect(text, `"${heading}" is on the screen`).toContain(heading);
    }
    /*
      Wind and solar used to be the sixth heading in that list, on a card of
      their own. The card is gone and the division is a line on each of the
      rail's four rows instead, so the assertion moved with it: what must be on
      screen is the split itself, not a heading over one region's copy of it.
    */
    expect(text).toMatch(/eólica\s+\S+\s+·\s+solar\s+\S+/);
  });

  test("no panel claims an interval, and the screen says why", async ({ page }) => {
    const text = await screenText(page);
    // The honest refusal survives: what is missing is the model's interval, and
    // the screen names it rather than leaving a gap where a band was.
    expect(text).toMatch(/Sem previsão para este dia|No forecast for this day/);
    expect(text).toMatch(/P10–P90/);
    // And no settled figure is dressed as one: the forecast cards' own
    // footnotes — which only exist beside a band — are not on this screen.
    expect(text).not.toContain("é uma previsão conjunta lida do ensemble");
    expect(text).not.toContain("A maior hora dentro de um dia sorteado");
  });

  test("the rows beside the map carry figures, not dashes", async ({ page }) => {
    const text = await screenText(page);
    // The four settled totals from `GET /v1/grid/now`, as `f.compact` renders
    // them in pt-BR — the figures the fixture publishes, not rounded stand-ins.
    for (const figure of ["1.843", "311", "275", "96,2"]) {
      expect(text, `${figure} MWh is on the screen`).toContain(figure);
    }
  });

  test("picking a region still selects without navigating", async ({ page }) => {
    await region(page, "S").click();
    await expect(page).toHaveURL(/\/app(\?|$)/);
    await expect(page).toHaveURL(/[?&]subsystem=S(&|$)/);
    await expect(page.locator('[data-testid="selected-region-name"]')).toHaveText(/SUL/);
  });

  test("arrow keys still walk the four regions", async ({ page }) => {
    await region(page, "NE").focus();
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(/[?&]subsystem=SE(&|$)/);
    await expect(region(page, "SE")).toBeFocused();
  });
});

test.describe("a promoted model puts the forecast map back", () => {
  test.beforeEach(async ({ page }) => {
    await routeGateway(page, { forecast: true });
    await page.goto("/app");
    await expect(page.locator('[data-testid="selected-region"]')).toBeVisible();
  });

  test("the map is the risk map again, in words and in colour", async ({ page }) => {
    const spoken = await labels(page);
    for (const label of spoken) {
      expect(label).toMatch(/risco|risk/i);
      expect(label).not.toMatch(/MWh/);
    }
    const text = await screenText(page);
    // The forecast panels are back in their own vocabulary…
    expect(text).toContain("Perfil de 24 horas");
    expect(text).toContain("Energia cortada, dia inteiro");
    expect(text).toContain("Pico de potência horária");
    // …and the settled panels keep their own section, still marked.
    expect(text).toContain("Liquidado nos quatro subsistemas");
  });
});

/**
 * The assertion the whole design rests on, made where a reader would make it.
 *
 * Both states are loaded in one test, against one export, and the four regions'
 * painted fills are compared. Any region painted the same colour in both would
 * mean the two maps are, at that region, literally indistinguishable — which is
 * the failure the colour argument in `observed-scale.ts` exists to prevent, and
 * which no amount of source-level separation can rule out on its own.
 */
test("the two maps are never painted the same", async ({ page }) => {
  await routeGateway(page, { forecast: true });
  await page.goto("/app");
  await expect(region(page, "NE")).toHaveCount(1);
  const forecastFills = await fills(page);
  const forecastLabels = await labels(page);

  await routeGateway(page, { forecast: false });
  await page.goto("/app");
  await expect(region(page, "NE")).toHaveCount(1);
  const observedFills = await fills(page);
  const observedLabels = await labels(page);

  expect(forecastFills.some((each) => each === "")).toBe(false);
  expect(observedFills.some((each) => each === "")).toBe(false);
  for (let i = 0; i < 4; i++) {
    expect(
      observedFills[i],
      `region ${i} is painted differently in the two states`,
    ).not.toBe(forecastFills[i]);
    expect(observedLabels[i]).not.toBe(forecastLabels[i]);
  }
});
