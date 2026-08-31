"use strict";

const { request: playwrightRequest } = require("playwright");
const {
  collectCookieSpecs,
  expandSessionTokenCookies,
  fetchLiveChatGptSession,
  installChatGptSession,
  isChallengeLike,
  isTransportSessionFailure,
  openLiveChatGptMainPage,
  refreshLiveChatGptAccessToken,
  acquireFreshChatGptAccessToken,
  refreshSessionAccessToken,
  buildExportableSessionJson,
  joinSessionTokenCookies,
  captureLiveChatGptSessionExport,
} = require("../session-auth");

function createToken(email, suffix) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      sub: suffix,
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email },
      "https://api.openai.com/auth": {
        chatgpt_account_id: `acct-${suffix}`,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

function apiResponse(status, data) {
  return {
    status: () => status,
    headers: () => ({ "content-type": "application/json" }),
    text: async () => JSON.stringify(data),
  };
}

describe("session-auth cookie helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("injects callback-url alongside a short sessionToken", () => {
    const specs = collectCookieSpecs(
      {
        sessionToken: "a".repeat(120),
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig",
      },
      null,
    );
    const names = specs.map((item) => item.name);
    expect(names).toContain("__Secure-next-auth.session-token");
    expect(names).toContain("__Secure-next-auth.callback-url");
    expect(
      specs.find((item) => item.name === "__Secure-next-auth.callback-url")
        .value,
    ).toBe("https://chatgpt.com/");
  });

  it("keeps a 3672-character sessionToken as a single cookie", () => {
    const chunks = expandSessionTokenCookies("b".repeat(3672));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].name).toBe("__Secure-next-auth.session-token");
    expect(chunks[0].value).toHaveLength(3672);
  });

  it("exports a pasteable session json with joined session-token cookies", () => {
    const token = createToken("user@example.com", "live");
    const json = buildExportableSessionJson(
      {
        user: { email: "user@example.com" },
        accessToken: token,
      },
      [
        { name: "__Secure-next-auth.session-token.0", value: "aaa" },
        { name: "__Secure-next-auth.session-token.1", value: "bbb" },
      ],
    );
    const parsed = JSON.parse(json);
    expect(parsed.accessToken).toBe(token);
    expect(parsed.sessionToken).toBe("aaabbb");
    expect(joinSessionTokenCookies([
      { name: "__Secure-next-auth.session-token", value: "one-piece" },
    ])).toBe("one-piece");
  });

  it("does not stitch unchunked session cookies together", () => {
    expect(
      joinSessionTokenCookies([
        { name: "__Secure-next-auth.session-token", value: "first-jwe" },
        { name: "__Secure-next-auth.session-token", value: "second-jwe-longer" },
      ]),
    ).toBe("second-jwe-longer");
    expect(
      buildExportableSessionJson(
        { user: null, accessToken: "" },
        [{ name: "__Secure-next-auth.session-token", value: "cookie-only" }],
      ),
    ).toBe("");
  });

  it("captures live session json from the page cookies", async () => {
    const token = createToken("user@example.com", "export");
    const page = {
      isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          user: { email: "user@example.com" },
          accessToken: token,
        },
      }),
      context: () => ({
        cookies: vi.fn().mockResolvedValue([
          { name: "__Secure-next-auth.session-token", value: "s".repeat(80) },
        ]),
      }),
    };

    const result = await captureLiveChatGptSessionExport(page);
    const parsed = JSON.parse(result.text);
    expect(result.ok).toBe(true);
    expect(parsed.accessToken).toBe(token);
    expect(parsed.sessionToken).toHaveLength(80);
  });

  it("treats a non-json 403 as a challenge instead of an expired cookie", () => {
    expect(
      isChallengeLike({
        status: 403,
        headerText: "",
        bodyText: "",
      }),
    ).toBe(true);
    expect(
      isChallengeLike({
        status: 200,
        headerText: "",
        bodyText: "{}",
      }),
    ).toBe(false);
  });

  it("treats HTTP 599 and proxy failures as transport errors", () => {
    expect(isTransportSessionFailure({ status: 599 })).toBe(true);
    expect(isTransportSessionFailure({ status: 502 })).toBe(true);
    expect(
      isTransportSessionFailure({ error: "net::ERR_PROXY_CONNECTION_FAILED" }),
    ).toBe(true);
    expect(
      isTransportSessionFailure({ status: 200, bodyText: "{}" }),
    ).toBe(false);
  });

  it("does not abort install when session verify hits a proxy 599", async () => {
    const token = createToken("user@example.com", "proxy599");
    const context = {
      addCookies: vi.fn().mockResolvedValue(),
      cookies: vi.fn().mockResolvedValue([
        {
          name: "__Secure-next-auth.session-token",
          value: "s".repeat(120),
        },
      ]),
      request: {
        get: vi.fn().mockResolvedValue({
          status: () => 599,
          headers: () => ({}),
          text: async () => "",
        }),
      },
      addInitScript: vi.fn().mockResolvedValue(),
      route: vi.fn().mockResolvedValue(),
    };
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get: vi.fn().mockResolvedValue({
        status: () => 599,
        headers: () => ({}),
        text: async () => "",
      }),
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await installChatGptSession(
      context,
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: token,
        sessionToken: "s".repeat(120),
      }),
      { verifyAttempts: 2, verifyRetryDelayMs: 0 },
    );

    expect(result.cookieVerified).toBe(false);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.request.get).toHaveBeenCalledTimes(2);
  });

  it("verifies cookies through a standalone proxy request after context 599", async () => {
    const oldToken = createToken("user@example.com", "old599");
    const freshToken = createToken("user@example.com", "fresh599");
    const context = {
      addCookies: vi.fn().mockResolvedValue(),
      cookies: vi.fn().mockResolvedValue([
        {
          name: "__Secure-next-auth.session-token",
          value: "s".repeat(120),
        },
      ]),
      request: {
        get: vi.fn().mockResolvedValue({
          status: () => 599,
          headers: () => ({}),
          text: async () => "",
        }),
      },
      addInitScript: vi.fn().mockResolvedValue(),
      route: vi.fn().mockResolvedValue(),
    };
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get: vi.fn().mockResolvedValue(
        apiResponse(200, {
          user: { email: "user@example.com" },
          accessToken: freshToken,
        }),
      ),
      dispose: vi.fn().mockResolvedValue(),
    });

    const result = await installChatGptSession(
      context,
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: oldToken,
        sessionToken: "s".repeat(120),
      }),
      { verifyAttempts: 1, verifyRetryDelayMs: 0, proxy: "http://proxy.example:8080" },
    );

    expect(result.cookieVerified).toBe(true);
    expect(result.accessToken).toBe(freshToken);
    expect(context.addInitScript).not.toHaveBeenCalled();
  });

  it("still rejects a real empty ChatGPT session", async () => {
    const token = createToken("user@example.com", "empty");
    const context = {
      addCookies: vi.fn().mockResolvedValue(),
      cookies: vi.fn().mockResolvedValue([
        {
          name: "__Secure-next-auth.session-token",
          value: "s".repeat(120),
        },
      ]),
      request: {
        get: vi.fn().mockResolvedValue(apiResponse(200, {})),
      },
      addInitScript: vi.fn().mockResolvedValue(),
      route: vi.fn().mockResolvedValue(),
    };

    await expect(
      installChatGptSession(
        context,
        JSON.stringify({
          user: { email: "user@example.com" },
          accessToken: token,
          sessionToken: "s".repeat(120),
        }),
      ),
    ).rejects.toThrow(/未被 ChatGPT 接受/);
  });

  it("refreshes a stale access token from a valid session-token cookie", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const dispose = vi.fn().mockResolvedValue();
    vi.spyOn(playwrightRequest, "newContext").mockResolvedValue({
      get: vi.fn().mockResolvedValue(
        apiResponse(200, {
          user: { email: "user@example.com" },
          accessToken: freshToken,
        }),
      ),
      dispose,
    });

    const result = await refreshSessionAccessToken(
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: oldToken,
        sessionToken: "s".repeat(120),
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
    });
    expect(result.sessionData.accessToken).toBe(freshToken);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("retries without proxy when the active proxy is blocked", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const proxyDispose = vi.fn().mockResolvedValue();
    const directDispose = vi.fn().mockResolvedValue();
    vi.spyOn(playwrightRequest, "newContext")
      .mockResolvedValueOnce({
        get: vi.fn().mockResolvedValue(apiResponse(403, {})),
        dispose: proxyDispose,
      })
      .mockResolvedValueOnce({
        get: vi.fn().mockResolvedValue(
          apiResponse(200, {
            user: { email: "user@example.com" },
            accessToken: freshToken,
          }),
        ),
        dispose: directDispose,
      });

    const result = await refreshSessionAccessToken(
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: oldToken,
        sessionToken: "s".repeat(120),
      }),
      { proxy: "http://proxy.example:8080" },
    );

    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
      usedProxy: false,
    });
    expect(playwrightRequest.newContext).toHaveBeenCalledTimes(2);
    expect(proxyDispose).toHaveBeenCalledTimes(1);
    expect(directDispose).toHaveBeenCalledTimes(1);
  });

  it("uses the cookie-refreshed token in the installed browser session", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const context = {
      addCookies: vi.fn().mockResolvedValue(),
      cookies: vi.fn().mockResolvedValue([
        {
          name: "__Secure-next-auth.session-token",
          value: "s".repeat(120),
        },
      ]),
      request: {
        get: vi.fn().mockResolvedValue(
          apiResponse(200, {
            user: { email: "user@example.com" },
            accessToken: freshToken,
          }),
        ),
      },
      addInitScript: vi.fn().mockResolvedValue(),
      route: vi.fn().mockResolvedValue(),
    };

    const result = await installChatGptSession(
      context,
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: oldToken,
        sessionToken: "s".repeat(120),
      }),
    );

    expect(result).toMatchObject({
      cookieVerified: true,
      tokenRefreshed: true,
      accessToken: freshToken,
    });
    expect(result.sessionData.accessToken).toBe(freshToken);
    expect(context.addInitScript).not.toHaveBeenCalled();
    expect(context.route).toHaveBeenCalledTimes(1);
    expect(context.route.mock.calls[0][0]).toBe("**/*");

    const routeHandler = context.route.mock.calls[0][1];
    const continueRequest = vi.fn().mockResolvedValue();
    await routeHandler({
      request: () => ({
        url: () => "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
        resourceType: () => "fetch",
        headers: () => ({}),
      }),
      continue: continueRequest,
      abort: vi.fn(),
    });
    expect(continueRequest).toHaveBeenCalledWith();
  });

  it("keeps bootstrap mocking for token-only sessions", async () => {
    const token = createToken("user@example.com", "token-only");
    const context = {
      addCookies: vi.fn().mockResolvedValue(),
      cookies: vi.fn().mockResolvedValue([]),
      request: { get: vi.fn() },
      addInitScript: vi.fn().mockResolvedValue(),
      route: vi.fn().mockResolvedValue(),
    };

    const result = await installChatGptSession(
      context,
      JSON.stringify({
        user: { email: "user@example.com" },
        accessToken: token,
      }),
    );

    expect(result.cookieVerified).toBe(false);
    expect(context.addInitScript).toHaveBeenCalledTimes(1);
    expect(context.addInitScript.mock.calls[0][1]).toMatchObject({
      accessToken: token,
    });
    expect(context.route).toHaveBeenCalledTimes(3);
  });

  it("reads the latest access token from the real page Session API", async () => {
    const freshToken = createToken("user@example.com", "post-payment");
    const page = {
      isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          user: { email: "user@example.com" },
          accessToken: freshToken,
        },
      }),
    };

    const result = await fetchLiveChatGptSession(page);

    expect(result).toMatchObject({
      ok: true,
      accessToken: freshToken,
    });
  });

  it("requests session rotation with integrity_state_missing", async () => {
    const page = {
      isClosed: () => false,
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: "rotated-token" },
      }),
    };

    await fetchLiveChatGptSession(page, { forceRefresh: true });

    expect(page.evaluate.mock.calls[0][1]).toMatchObject({
      forceRefresh: true,
    });
  });

  it("opens the ChatGPT home page and reloads before reading the live session", async () => {
    const freshToken = createToken("user@example.com", "reloaded");
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: {
          user: { email: "user@example.com" },
          accessToken: freshToken,
        },
      }),
    };

    const result = await openLiveChatGptMainPage(page);

    expect(page.goto).toHaveBeenCalledWith("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    expect(page.reload).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, accessToken: freshToken });
  });

  it("reloads the main page when refreshing a live access token", async () => {
    const freshToken = createToken("user@example.com", "refresh");
    const page = {
      isClosed: () => false,
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: freshToken },
      }),
    };

    await expect(refreshLiveChatGptAccessToken(page)).resolves.toBe(freshToken);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it("returns a post-payment session only when it differs from the old token", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: freshToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      onStatus: () => {},
    });

    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
    });
  });

  it("does not reuse the pre-payment token when session is unchanged", async () => {
    const oldToken = createToken("user@example.com", "old");
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: oldToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      maxAttempts: 2,
      onStatus: () => {},
    });

    expect(result).toMatchObject({
      ok: false,
      accessToken: "",
      refreshed: false,
    });
    expect(page.reload).toHaveBeenCalledTimes(2);
  });

  it("can keep the live page session when rotation is not required", async () => {
    const oldToken = createToken("user@example.com", "old");
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      reload: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: oldToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      requireRotated: false,
      maxAttempts: 1,
      onStatus: () => {},
    });

    expect(result).toMatchObject({
      ok: true,
      accessToken: oldToken,
      refreshed: false,
    });
  });

  it("rotates the post-payment token via the session refresh API", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const page = {
      isClosed: () => false,
      url: () => "https://chatgpt.com/checkout/openai_llc/oaics_x",
      goto: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: freshToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      tracker: { getRotatedToken: () => "", getToken: () => "" },
      onStatus: () => {},
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(page.evaluate.mock.calls[0][1]).toMatchObject({
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
    });
  });

  it("opens refresh_account only if the current page keeps the old token", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const page = {
      isClosed: () => false,
      url: () => "https://chatgpt.com/checkout/openai_llc/oaics_x",
      goto: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          status: 200,
          data: { accessToken: oldToken },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { accessToken: freshToken },
        }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      tracker: { getRotatedToken: () => "", getToken: () => oldToken },
      onStatus: () => {},
    });

    expect(page.goto).toHaveBeenCalledWith(
      "https://chatgpt.com/?refresh_account=true",
      expect.any(Object),
    );
    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
    });
  });

  it("does not navigate again when rotating after a failed cancel token", async () => {
    const oldToken = createToken("user@example.com", "old");
    const failedToken = createToken("user@example.com", "failed");
    const page = {
      isClosed: () => false,
      goto: vi.fn().mockResolvedValue(),
      waitForTimeout: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: failedToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      excludeToken: failedToken,
      tracker: { getRotatedToken: () => "", getToken: () => failedToken },
      allowNavigate: false,
      onStatus: () => {},
    });

    expect(page.goto).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      accessToken: "",
      refreshed: false,
    });
  });

  it("opens ChatGPT before rotating when the page is still blank", async () => {
    const oldToken = createToken("user@example.com", "old");
    const freshToken = createToken("user@example.com", "fresh");
    const page = {
      isClosed: () => false,
      url: () => "about:blank",
      goto: vi.fn().mockResolvedValue(),
      evaluate: vi.fn().mockResolvedValue({
        status: 200,
        data: { accessToken: freshToken },
      }),
    };

    const result = await acquireFreshChatGptAccessToken(page, {
      previousToken: oldToken,
      tracker: { getRotatedToken: () => "", getToken: () => "" },
      requireRotated: false,
      onStatus: () => {},
    });

    expect(page.goto).toHaveBeenCalledWith(
      "https://chatgpt.com/?refresh_account=true",
      expect.any(Object),
    );
    expect(page.evaluate.mock.calls[0][1]).toMatchObject({
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      ok: true,
      refreshed: true,
      accessToken: freshToken,
    });
  });
});
