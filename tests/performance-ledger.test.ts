import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { PerformanceLedger } from "../src/performance-ledger.js";

const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const amounts = (
  openingNAV = "100",
  closingNAV = "120",
  netCapitalFlow = "0",
) => ({
  openingNAV,
  closingNAV,
  netCapitalFlow,
  cashflowComplete: true,
  hasCapitalFlows: netCapitalFlow !== "0",
  missingReasons: [],
});
const fixture = () => ({
  version: "performance-input/1",
  currency: "micro-USDT",
  roundId: "round-1",
  chainId: 1,
  windowStartMs: 1,
  windowEndMs: 2,
  observedAt: 3,
  roster: [
    { agentId: "a", wallet: wallet(1) },
    { agentId: "b", wallet: wallet(2) },
  ],
  perAgent: [
    {
      agentId: "a",
      ...amounts(),
      investments: [{ investmentId: "position", ...amounts("100", "1000") }],
    },
    { agentId: "b", ...amounts("100", "80"), investments: [] },
  ],
});

test("aggregates portfolio PnL across full roster without double counting investments", () => {
  const db = new Store(":memory:");
  const ledger = new PerformanceLedger(db);
  try {
    const r = ledger.recordRound(fixture());
    assert.equal(r.agents[0]?.periodPnL, "20");
    assert.equal(r.agents[0]?.investments[0]?.periodPnL, "900");
    assert.equal(r.agents[1]?.periodPnL, "-20");
    assert.equal(r.network.periodPnL, "0");
    assert.deepEqual(r.network.periodReturn, {
      numerator: "0",
      denominator: "200",
    });
    assert.equal(db.all("performance-investment").length, 1);
    assert.equal(db.all("performance-agent").length, 2);
  } finally {
    db.close();
  }
});

test("deposits are excluded and returns with flows remain unknown", () => {
  const db = new Store(":memory:");
  try {
    const x = fixture();
    x.perAgent[0] = {
      agentId: "a",
      ...amounts("100", "320", "200"),
      investments: [],
    };
    const r = new PerformanceLedger(db).recordRound(x);
    assert.equal(r.agents[0]?.periodPnL, "20");
    assert.equal(r.agents[0]?.periodReturn, null);
    assert.equal(r.network.periodReturn, null);
  } finally {
    db.close();
  }
});

test("missing rows and incomplete cashflows remain unknown with a known subtotal", () => {
  const db = new Store(":memory:");
  try {
    const ledger = new PerformanceLedger(db);
    const x = fixture();
    x.perAgent.pop();
    const r = ledger.recordRound(x);
    assert.equal(r.network.periodPnL, null);
    assert.equal(r.network.knownPeriodPnL, "20");
    assert.equal(r.network.knownAgentCount, 1);
    assert.equal(r.network.missingAgentCount, 1);
    assert.equal(r.agents[1]?.periodPnL, null);
    assert.ok(r.agents[1]?.missingReasons.length);
    const y = fixture();
    y.roundId = "round-2";
    y.perAgent[0]!.cashflowComplete = false;
    const p = ledger.recordRound(y);
    assert.equal(p.agents[0]?.periodPnL, null);
    assert.equal(p.network.knownPeriodPnL, "-20");
  } finally {
    db.close();
  }
});

test("append-only corrections are idempotent, compare-and-swap guarded and survive restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "state.db");
  let db = new Store(path);
  try {
    let ledger = new PerformanceLedger(db);
    const input = fixture();
    const first = ledger.recordRound(input);
    assert.deepEqual(ledger.recordRound(input), first);
    const corrected = { ...input, observedAt: 4 };
    assert.throws(
      () => ledger.recordRound(corrected),
      /PERFORMANCE_REVISION_CONFLICT/,
    );
    const second = ledger.recordRound({
      ...corrected,
      supersedes: first.revisionHash,
    });
    assert.equal(second.revision, 2);
    assert.throws(
      () =>
        ledger.recordRound({
          ...corrected,
          observedAt: 5,
          supersedes: first.revisionHash,
        }),
      /PERFORMANCE_REVISION_CONFLICT/,
    );
    assert.deepEqual(ledger.recordRound(input), first);
    db.close();
    db = new Store(path);
    ledger = new PerformanceLedger(db);
    assert.equal(ledger.latest("round-1")?.revisionHash, second.revisionHash);
    assert.equal(ledger.list("round-1").length, 2);
    assert.equal(db.all("performance-agent").length, 4);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("strict invalid data never leaves any persisted rows", () => {
  const mutations: ((x: any) => void)[] = [
    (x) => (x.roster[0].wallet = wallet(0)),
    (x) => (x.perAgent[0].openingNAV = "1.5"),
    (x) => (x.perAgent[0].openingNAV = "01"),
    (x) => (x.perAgent[0].closingNAV = 100),
    (x) => (x.perAgent[0].netCapitalFlow = "-0"),
    (x) => x.roster.push(x.roster[0]),
    (x) => (x.roster[1].wallet = x.roster[0].wallet),
    (x) => x.perAgent.push(x.perAgent[0]),
    (x) => (x.perAgent[0].agentId = "foreign"),
    (x) => x.perAgent[0].investments.push(x.perAgent[0].investments[0]),
    (x) => (x.windowEndMs = 0),
    (x) => (x.observedAt = 1),
    (x) => (x.currency = "USD"),
    (x) => (x.extra = true),
    (x) => (x.roster[0].wallet = "bad"),
    (x) => (x.perAgent[0].openingNAV = "9".repeat(79)),
  ];
  for (const mutate of mutations) {
    const db = new Store(":memory:");
    try {
      const x = fixture();
      mutate(x);
      assert.throws(
        () => new PerformanceLedger(db).recordRound(x),
        /PERFORMANCE_INVALID_INPUT/,
      );
      assert.equal(db.all("performance-round").length, 0);
      assert.equal(db.all("performance-agent").length, 0);
      assert.equal(db.all("performance-investment").length, 0);
    } finally {
      db.close();
    }
  }
});

test("offsetting or unspecified cashflows prevent simple returns; nullable components do not invent gains", () => {
  const db = new Store(":memory:");
  try {
    const x: any = fixture();
    x.perAgent[0].hasCapitalFlows = true;
    delete x.perAgent[1].hasCapitalFlows;
    x.perAgent[0].investments[0].openingNAV = null;
    x.perAgent[0].investments[0].realizedPeriodPnL = "40";
    const r = new PerformanceLedger(db).recordRound(x);
    assert.equal(r.agents[0]?.periodReturn, null);
    assert.equal(r.agents[1]?.periodReturn, null);
    assert.equal(r.network.periodReturn, null);
    assert.equal(r.agents[0]?.investments[0]?.periodPnL, null);
    assert.equal(r.agents[0]?.investments[0]?.closingUnrealizedPnL, null);
    assert.equal(r.network.periodPnL, "0");
  } finally {
    db.close();
  }
});

test("late storage failure rolls back investment and agent writes", () => {
  const db = new Store(":memory:");
  try {
    db.sql.exec(
      "CREATE TRIGGER fail_round BEFORE INSERT ON records WHEN NEW.kind='performance-round' BEGIN SELECT RAISE(ABORT, 'test failure'); END",
    );
    assert.throws(
      () => new PerformanceLedger(db).recordRound(fixture()),
      /test failure/,
    );
    assert.equal(db.all("performance-agent").length, 0);
    assert.equal(db.all("performance-investment").length, 0);
    assert.equal(db.all("performance-input").length, 0);
  } finally {
    db.close();
  }
});

test("latest correction follows revision order even if the accounting window is corrected", () => {
  const db = new Store(":memory:");
  try {
    const l = new PerformanceLedger(db);
    const x = fixture();
    x.windowStartMs = 10;
    x.windowEndMs = 20;
    x.observedAt = 30;
    const r = l.recordRound(x);
    const corrected = l.recordRound({
      ...fixture(),
      supersedes: r.revisionHash,
    });
    assert.equal(l.latest("round-1")?.revisionHash, corrected.revisionHash);
    assert.equal(
      l.recordRound({
        ...fixture(),
        observedAt: 40,
        supersedes: corrected.revisionHash,
      }).revision,
      3,
    );
  } finally {
    db.close();
  }
});

test("normalized ordering and address case replay the same observation", () => {
  const db = new Store(":memory:");
  try {
    const ledger = new PerformanceLedger(db);
    const x = fixture();
    x.roster[0]!.wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const first = ledger.recordRound(x);
    x.roster[0]!.wallet = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    x.roster.reverse();
    x.perAgent.reverse();
    assert.equal(ledger.recordRound(x).revisionHash, first.revisionHash);
    assert.equal(ledger.list().length, 1);
  } finally {
    db.close();
  }
});

test("entirely unobserved roster is durable unknown and chain ambiguity is explicit", () => {
  const db = new Store(":memory:");
  try {
    const ledger = new PerformanceLedger(db);
    const x = fixture();
    x.perAgent = [];
    const first = ledger.recordRound(x);
    assert.deepEqual(first.network, {
      periodPnL: null,
      knownPeriodPnL: "0",
      knownAgentCount: 0,
      missingAgentCount: 2,
      periodReturn: null,
    });
    assert.equal(db.all("performance-agent").length, 2);
    ledger.recordRound({ ...x, chainId: 2 });
    assert.throws(() => ledger.latest(x.roundId), /PERFORMANCE_CHAIN_REQUIRED/);
    assert.equal(ledger.latest(x.roundId, 1)?.revisionHash, first.revisionHash);
  } finally {
    db.close();
  }
});
