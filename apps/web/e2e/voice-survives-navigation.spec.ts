import { expect, type Page, test } from "@playwright/test";

/**
 * **The session survives a tool-call navigation.**
 *
 * `docs/plans/voice-copilot.md` §8 names this as the risk that would make the
 * feature break at the moment it worked:
 *
 * > A dock mounted per screen would tear down its WebSocket, drop the mic, and
 * > cut the sentence in half **every time a tool call succeeded**.
 *
 * Every other check on this feature — the unit suite, the source guards — can
 * be satisfied by a tree that *looks* right. Only a browser can answer whether
 * the socket that was open before `router.push` is the same object afterwards,
 * because the thing that would break it is React unmounting a subtree, and no
 * static reading of the source shows you that.
 *
 * ## What is faked, and what is not
 *
 * Faked, because it is xAI's and not ours:
 *
 *  - **`GET /v1/voice/session`** is intercepted and answers a credential. The
 *    route is `apps/api`'s and has its own tests; what matters here is the
 *    browser's half.
 *  - **`WebSocket`** is replaced with a recorder that counts constructions,
 *    closes and sends, and lets the test push a realtime frame in. The frames
 *    are the real protocol shapes `session.ts` parses.
 *
 * Not faked, and this is the point:
 *
 *  - **The microphone.** Chromium runs with its fake capture device, so
 *    `getUserMedia`, the `AudioContext`, the inlined `AudioWorklet` and
 *    `levelFromFloat` all really run. A session whose capture silently failed
 *    would never reach `listening`, and every assertion below depends on it.
 *  - **The navigation.** `router.push` really navigates the exported bundle.
 *  - **The provider tree.** This is the exported `dist/`, not a test harness.
 */

/** A credential shaped exactly like `GET /v1/voice/session`'s 200. */
const MINTED = {
  client_secret: "test-ephemeral-secret",
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  model: "grok-realtime-test",
  voice: "test",
};

/**
 * The recorder that stands in for the realtime socket.
 *
 * It counts constructions and closes, because those two numbers are the whole
 * test: a navigation that tore the provider down would show a second
 * construction, a first close, or both. `__voiceEmit` pushes a frame into the
 * live socket so a tool call can be driven with no model in the room.
 */
const SOCKET_RECORDER = `
  (() => {
    const stats = { opened: 0, closed: 0, sent: [] };
    globalThis.__voiceStats = stats;
    const Real = globalThis.WebSocket;
    class RecordingSocket {
      constructor(url, protocols) {
        stats.opened += 1;
        this.url = url;
        this.protocols = protocols;
        this.readyState = 1;
        globalThis.__voiceSocket = this;
        setTimeout(() => this.onopen && this.onopen({}), 0);
      }
      send(payload) { stats.sent.push(payload); }
      close() { stats.closed += 1; this.readyState = 3; }
    }
    RecordingSocket.OPEN = Real ? Real.OPEN : 1;
    globalThis.WebSocket = RecordingSocket;
    globalThis.__voiceEmit = (frame) => {
      const socket = globalThis.__voiceSocket;
      if (socket && socket.onmessage) {
        socket.onmessage({ data: JSON.stringify(frame) });
      }
    };
  })();
`;

/**
 * Arm the browser: a stubbed socket, a credential, and a gateway that refuses.
 *
 * The catch-all is registered **before** the specific route, and the order is
 * not stylistic. Playwright matches handlers most-recently-registered first, so
 * a wildcard over every `/v1/` path added last swallows the voice-session route
 * — and the symptom is a dock that never appears, which reads exactly like the
 * feature being broken rather than like the test being wrong. It cost a run.
 */
async function armVoice(page: Page, credential = mintedResponse()): Promise<void> {
  await page.addInitScript(SOCKET_RECORDER);
  // The gateway is not running in this suite. Every read refusing is a *known*
  // state for `ServingProvider` and the dock has to work in it — which is also
  // the state the product is actually in today, with nothing promoted.
  await page.route("**/v1/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "DATA_UNAVAILABLE", message: "no gateway in e2e" },
      }),
    }),
  );
  await page.route("**/v1/voice/session", (route) => route.fulfill(credential));
}

function mintedResponse() {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(MINTED),
  };
}

/**
 * Open a live session and wait until the microphone is **actually capturing**.
 *
 * Not "until the ACTIVE pill appears": `connecting` renders the same pill, so
 * that would pass on a session whose `getUserMedia` never resolved and every
 * assertion downstream would be about a dead socket. What proves a live
 * microphone is an `input_audio_buffer.append` frame on the wire — that frame
 * only exists because the worklet delivered real samples from Chromium's fake
 * capture device, through `encodePCM16Base64`, to `send`.
 */
async function startSession(page: Page): Promise<void> {
  await page.getByTestId("voice-trigger").click();
  await expect(page.getByTestId("voice-dock-active")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () =>
      globalThis.__voiceStats.sent.some((frame) =>
        frame.includes("input_audio_buffer.append"),
      ),
    undefined,
    { timeout: 15_000 },
  );
}

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
});

test.describe("the voice session outlives a tool-call navigation", () => {
  test("a navigating tool call does not close or rebuild the socket", async ({
    page,
  }) => {
    await armVoice(page);
    await page.goto("/app");
    await startSession(page);

    const before = await page.evaluate(() => ({ ...globalThis.__voiceStats }));
    expect(before.opened).toBe(1);
    expect(before.closed).toBe(0);

    // The demo script's step 2: "Por quê?" → `explain{NE}`. Driven as the
    // realtime frame the API actually sends.
    await page.evaluate(() =>
      globalThis.__voiceEmit({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "explain",
          call_id: "call-1",
          arguments: '{"subsystem":"NE"}',
        },
      }),
    );

    await expect(page).toHaveURL(/\/app\/explain/);
    await expect(page).toHaveURL(/subsystem=NE/);

    // **The assertion the whole spec exists for.** Same socket, still open,
    // after a route change the agent itself caused.
    const after = await page.evaluate(() => ({ ...globalThis.__voiceStats }));
    expect(after.opened).toBe(1);
    expect(after.closed).toBe(0);

    // And the dock is still there, on the new screen, still live.
    await expect(page.getByTestId("voice-dock")).toBeVisible();
    await expect(page.getByTestId("voice-dock-active")).toBeVisible();
  });

  test("the tool call is answered back to the model", async ({ page }) => {
    await armVoice(page);
    await page.goto("/app");
    await startSession(page);

    await page.evaluate(() =>
      globalThis.__voiceEmit({
        type: "response.function_call_arguments.done",
        name: "focus",
        call_id: "call-2",
        arguments: '{"technology":"solar"}',
      }),
    );

    await expect(page).toHaveURL(/technology=solar/);
    // A tool call the conversation never answers leaves the model's next turn
    // built on a gap, and the gap is where it invents a figure.
    const sent = await page.evaluate(() => globalThis.__voiceStats.sent.join(" | "));
    expect(sent).toContain("function_call_output");
    expect(sent).toContain("call-2");
  });

  test("a highlight lights the screen the reader is on and navigates nowhere", async ({
    page,
  }) => {
    await armVoice(page);
    await page.goto("/app");
    await startSession(page);

    await page.evaluate(() =>
      globalThis.__voiceEmit({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          name: "highlight",
          call_id: "call-3",
          arguments: '{"subsystem":"NE"}',
        },
      }),
    );

    /*
      The step that proves the thesis: the assistant answers where the reader
      already is. A URL that changed here would be a lesser product.

      Asserting an *absence* is the one case a fixed wait is honest. There is no
      positive signal to poll for, because the passing behaviour is that nothing
      happens — `expect.poll` would re-check a condition that is already true at
      t = 0 and pass instantly, proving nothing. 500 ms is an order of magnitude
      beyond the ~30 ms a `highlight` intent takes to reach the router here.
    */
    // biome-ignore lint/nursery/noPlaywrightWaitForTimeout: an absence needs elapsed time; see above.
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname.replace(/\/$/, "")).toBe("/app");
    await expect(page.getByTestId("voice-dock")).toBeVisible();
  });
});

test.describe("a deployment with no key looks like a product without voice", () => {
  test("VOICE_NOT_CONFIGURED leaves no dock and no trigger behind", async ({ page }) => {
    await armVoice(page, {
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "VOICE_NOT_CONFIGURED", message: "no key on this instance" },
      }),
    });

    await page.goto("/app");
    // The trigger is offered once, because that press is how the app finds out
    // which of the two refusals this deployment is.
    await page.getByTestId("voice-trigger").click();

    await expect(page.getByTestId("voice-trigger")).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId("voice-dock")).toHaveCount(0);
    // No socket was ever opened: the credential refused before one could be.
    expect(await page.evaluate(() => globalThis.__voiceStats.opened)).toBe(0);
  });
});

test.describe("there is no voice outside /app", () => {
  for (const path of ["/pt/", "/pitch", "/pt/privacy"]) {
    test(`no dock and no trigger on ${path}`, async ({ page }) => {
      await armVoice(page);
      await page.goto(path);
      // §9: "A microphone on the marketing page is a gimmick with nothing
      // behind it." The provider mounts on the `/app` layout only.
      await expect(page.getByTestId("voice-dock")).toHaveCount(0);
      await expect(page.getByTestId("voice-trigger")).toHaveCount(0);
      expect(await page.evaluate(() => globalThis.__voiceStats.opened)).toBe(0);
    });
  }
});

/**
 * What `SOCKET_RECORDER` installs, declared so the `page.evaluate` bodies above
 * type-check. `var` is what `declare global` requires for a global binding.
 */
/*
  `declare global` accepts only `var` for a global binding — `let` and `const`
  are module-scoped and would not describe a property of `globalThis`, which is
  what the injected socket recorder actually installs. `useVarsOnTop` is about
  hoisting hazards in executable code; this block declares types and emits none.
*/
declare global {
  // biome-ignore lint/nursery/useVarsOnTop: `declare global` requires `var`; see above.
  var __voiceStats: { opened: number; closed: number; sent: string[] };
  // biome-ignore lint/nursery/useVarsOnTop: `declare global` requires `var`; see above.
  var __voiceEmit: (frame: unknown) => void;
}
