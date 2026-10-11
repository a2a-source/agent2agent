import { test } from "node:test";
import assert from "node:assert/strict";
import { validateNewsBodyClaims } from "../src/research-guidance.js";
import type { Observation } from "../src/agent-runtime.js";
import { pageObservation, sameNewsTitle } from "../src/research-tools.js";

const url = "https://publisher.example/article";
function report(
  headline: string,
  status = "FULL_TEXT",
  relevance = "context",
  asset = "BTCB",
) {
  return {
    summary: "News context",
    recommendation: "Observe",
    sections: [
      {
        id: "asset_news",
        content:
          `asset=${asset}; status=` +
          status +
          "; headline=" +
          headline +
          "; publishedAt=unknown; publisherUrl=" +
          url +
          "; relevance=" +
          relevance,
        evidenceRefs: [url],
      },
    ],
  };
}
function observations(
  title: string,
  body = true,
  asset = "BTCB",
): Observation[] {
  return [
    {
      tool: "asset_news",
      input: {},
      output: {
        data: [
          {
            asset,
            items: [{ title, publisherCandidates: [{ url }] }],
          },
        ],
      },
    },
    ...(body
      ? [
          {
            tool: "fetch_page",
            input: { url },
            output: {
              data: "Article text describing the news event",
              pageTitle: title,
              finalUrl: url,
              sources: [{ url }],
            },
          },
        ]
      : []),
  ];
}
test("a negated prose mention cannot waive an explicit FULL_TEXT status", () => {
  assert.throws(
    () =>
      validateNewsBodyClaims(
        "news",
        report(
          "Update",
          "FULL_TEXT",
          "Another FULL_TEXT claim was not verified",
        ),
        observations("Update", false),
      ),
    /matching article evidence/,
  );
});
test("a real headline containing a semicolon retains its article binding", () => {
  const title = "Bitcoin recovers; traders assess policy";
  assert.doesNotThrow(() =>
    validateNewsBodyClaims("news", report(title), observations(title)),
  );
});
test("FULL_TEXT within a headline is not a verification status", () => {
  const title = "Publisher launches FULL_TEXT archive";
  assert.doesNotThrow(() =>
    validateNewsBodyClaims(
      "news",
      report(title, "HEADLINE_ONLY"),
      observations(title, false),
    ),
  );
});
test("an unrelated fetched article cannot verify a discovery headline", () => {
  const obs = observations("Bitcoin bridge hacked");
  Object.assign(obs[1]!.output, { pageTitle: "Unrelated sports article" });
  assert.throws(
    () => validateNewsBodyClaims("news", report("Bitcoin bridge hacked"), obs),
    /matching article evidence/,
  );
});
test("a wrapper redirect cannot verify a publisher article", () => {
  const obs = observations("Update");
  Object.assign(obs[1]!.output, { finalUrl: "https://news.google.com/home" });
  assert.throws(
    () => validateNewsBodyClaims("news", report("Update"), obs),
    /matching article evidence/,
  );
});
test("an exact-title web follow-up can recover a known news item", () => {
  const obs = observations("Bitcoin policy update");
  obs[0]!.output.data![0]!.items[0]!.publisherCandidates = [];
  const followup = {
    tool: "web_search",
    input: { query: '"Bitcoin policy update"' },
    output: {
      data: [{ title: "Bitcoin policy update", url }],
      sources: [{ url }],
    },
  };
  assert.doesNotThrow(() =>
    validateNewsBodyClaims("news", report("Bitcoin policy update"), [
      obs[0]!,
      followup,
      obs[1]!,
    ]),
  );
});
test("prose describing missing coverage is not a structured verification claim", () => {
  const r = report("Update", "HEADLINE_ONLY");
  r.summary = "No items could be verified as FULL_TEXT.";
  assert.doesNotThrow(() => validateNewsBodyClaims("news", r, []));
});
test("page evidence retains the actual destination and rejects a challenge body", () => {
  const finalUrl = "https://publisher.example/canonical";
  const page = pageObservation(
    "<title>Update</title><article>Article content</article>",
    url,
    finalUrl,
  );
  assert.equal(page.requestedUrl, url);
  assert.equal(page.finalUrl, finalUrl);
  assert.equal(page.sources[0]!.url, finalUrl);
  const obs = observations("Update");
  Object.assign(obs[1]!.output, page);
  const r = report("Update");
  r.sections[0]!.content = r.sections[0]!.content.replace(url, finalUrl);
  r.sections[0]!.evidenceRefs = [finalUrl];
  assert.doesNotThrow(() => validateNewsBodyClaims("news", r, obs));
  const challenge = pageObservation(
    "<main>Please enable JavaScript to verify you are human</main>",
    url,
    url,
  );
  assert.equal(challenge.data, null);
  assert.deepEqual(challenge.sources, []);
});
test("title identity tolerates publisher suffixes without accepting unrelated subjects", () => {
  assert(
    sameNewsTitle(
      "Bitcoin policy update - Reuters",
      "Bitcoin policy update | Reuters",
    ),
  );
  assert(!sameNewsTitle("Bitcoin bridge hacked", "Unrelated sports article"));
  assert(!sameNewsTitle("Bitcoin - bridge hacked", "Bitcoin - sports update"));
});

test("metadata-only pages and titled JS barriers are not article bodies", () => {
  for (const html of [
    "<html><head><title>Bitcoin policy update</title></head><body></body></html>",
    "<title>Bitcoin policy update</title><main>Please enable JavaScript</main>",
  ]) {
    const page = pageObservation(html, url, url);
    assert.equal(page.data, null);
    assert.deepEqual(page.sources, []);
  }
});

test("news titles normalize numeric and common named HTML entities", () => {
  assert(sameNewsTitle("Bitcoin’s rally", "Bitcoin&#8217;s rally"));
  assert(sameNewsTitle("Bitcoin’s rally", "Bitcoin&#x2019;s rally"));
  assert(sameNewsTitle("Bitcoin – rally", "Bitcoin &ndash; rally"));
});

for (const asset of [
  "BTCB",
  "ETH",
  "WBNB",
  "QBTC",
  "QETH",
  "QBNB",
  "A2",
  "ABCDEFGHIJKL",
]) {
  test(`observed ${asset} keeps its exact asset binding for FULL_TEXT`, () => {
    assert.doesNotThrow(() =>
      validateNewsBodyClaims(
        "news",
        report("Policy update", "FULL_TEXT", "context", asset),
        observations("Policy update", true, asset),
      ),
    );
  });
}

for (const asset of [
  "UNKNOWN",
  "QETH",
  "BTCB",
  "qbtc",
  "Q-BTC",
  "Q",
  "ABCDEFGHIJKLM",
]) {
  test(`claim ${asset} cannot borrow the QBTC article`, () => {
    assert.throws(
      () =>
        validateNewsBodyClaims(
          "news",
          report("Policy update", "FULL_TEXT", "context", asset),
          observations("Policy update", true, "QBTC"),
        ),
      /source-bound asset row|matching article evidence/,
    );
  });
}

for (const asset of ["qbtc", "Q-BTC", "Q", "ABCDEFGHIJKLM"]) {
  test(`malformed observed symbol ${asset} does not authorize FULL_TEXT`, () => {
    assert.throws(
      () =>
        validateNewsBodyClaims(
          "news",
          report("Policy update", "FULL_TEXT", "context", asset),
          observations("Policy update", true, asset),
        ),
      /source-bound asset row/,
    );
  });
}

for (const fault of [
  "title",
  "body",
  "requested",
  "finalUrl",
  "sources",
  "refs",
  "headline",
  "cross-asset",
]) {
  test(`QBTC FULL_TEXT retains the ${fault} evidence guard`, () => {
    const r = report(
      "One-year after flash crash - CoinDesk",
      "FULL_TEXT",
      "context",
      "QBTC",
    );
    const obs = observations(
      "One-year after flash crash - CoinDesk",
      true,
      "QBTC",
    );
    const page = obs[1]!;
    if (fault === "title")
      page.output.pageTitle = "One-year later, flash crash";
    if (fault === "body") page.output.data = "   ";
    if (fault === "requested")
      page.input = { url: "https://publisher.example/other" };
    if (fault === "finalUrl")
      page.output.finalUrl = "https://publisher.example/other";
    if (fault === "sources") page.output.sources = [];
    if (fault === "refs") r.sections[0]!.evidenceRefs = ["context.facts"];
    if (fault === "headline")
      r.sections[0]!.content = r.sections[0]!.content.replace(
        "after flash crash",
        "later, flash crash",
      );
    if (fault === "cross-asset") {
      obs[0]!.output.data.push({
        asset: "QETH",
        items: [{ title: "Ethereum update", publisherCandidates: [{ url }] }],
      });
      r.sections[0]!.content = r.sections[0]!.content.replace(
        "asset=QBTC",
        "asset=QETH",
      );
    }
    assert.throws(
      () => validateNewsBodyClaims("news", r, obs),
      /matching article evidence/,
    );
    if (fault === "title") {
      r.sections[0]!.content = r.sections[0]!.content.replace(
        "status=FULL_TEXT",
        "status=HEADLINE_ONLY",
      );
      assert.doesNotThrow(() => validateNewsBodyClaims("news", r, obs));
    }
  });
}
