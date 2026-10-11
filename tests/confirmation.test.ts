import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Epochs } from "../src/epochs.js";
import { hash } from "../src/protocol.js";
import { signingMessage } from "../src/qsp.js";
import {
  Confirmations,
  confirmationMessage,
  confirmationQuorum,
  verifyConfirmation,
} from "../src/confirmation.js";

async function fixture(n = 3, path = ":memory:") {
  const db = new Store(path),
    epochs = new Epochs(db),
    wallets = Array.from({ length: n }, () => Wallet.createRandom());
  const now = Date.now(),
    committee = wallets.map((w, i) => ({
      id: `a${i}`,
      wallet: w.address,
      stake: "300000000000000000",
      compute: "1000000",
    }));
  const epoch = epochs.open(
    0,
    committee,
    { termSlots: 7, committeeSize: 7, timeoutMs: 60000 },
    now,
  );
  const output = {
    version: "a2a-qsp/1" as const,
    epoch: epoch.id,
    view: epoch.view,
    master: epoch.master,
    committeeHash: hash(epoch.committee),
    configHash: hash({ roles: ["risk"] }),
    dataAt: now,
    reports: [
      {
        role: "risk",
        agent: epoch.committee.find((c) => c.id !== epoch.master)!.id,
        summary: "No execution",
        sources: [],
        missing: ["No market"],
      },
    ],
    signals: [],
    risks: ["No executable quote"],
    executed: false as const,
  };
  const wallet = (id: string) => wallets[Number(id.slice(1))]!;
  const signature = await wallet(epoch.master).signMessage(
    signingMessage(97, output),
  );
  const options = {
    chainId: 97,
    timeoutMs: 30000,
    roles: ["risk"],
    expectedConfigHash: output.configHash,
    toolsEnabled: false,
  };
  const book = new Confirmations(db),
    proposal = book.freeze(epoch, output, signature, options, now);
  async function vote(id: string, at = now + 1) {
    const message = book.intent(epoch, id, at);
    const signature = await wallet(id).signMessage(message);
    book.vote(epoch, id, signature, at);
    return signature;
  }
  return {
    db,
    epochs,
    epoch,
    output,
    signature,
    options,
    book,
    proposal,
    now,
    wallet,
    vote,
  };
}

test("confirmation requires 3/3 or 5/7 unique frozen committee signatures", async () => {
  assert.equal(confirmationQuorum(3), 3);
  assert.equal(confirmationQuorum(7), 5);
  for (const n of [3, 7]) {
    const f = await fixture(n);
    try {
      const threshold = confirmationQuorum(n);
      for (const member of f.epoch.committee.slice(0, threshold - 1))
        await f.vote(member.id);
      assert.throws(() => f.book.certificate(f.epoch, f.now + 2), /quorum/);
      const last = f.epoch.committee[threshold - 1]!;
      const sig = await f.vote(last.id);
      f.book.vote(f.epoch, last.id, sig, f.now + 2);
      const certificate = f.book.certificate(f.epoch, f.now + 3);
      assert.equal(certificate.votes.length, threshold);
      assert(
        verifyConfirmation(
          97,
          f.output,
          f.signature,
          certificate,
          f.epoch.committee,
          f.epoch.configHash,
        ),
      );
      assert(
        !verifyConfirmation(
          56,
          f.output,
          f.signature,
          certificate,
          f.epoch.committee,
          f.epoch.configHash,
        ),
      );
      assert(
        !verifyConfirmation(
          97,
          { ...f.output, risks: ["changed"] },
          f.signature,
          certificate,
          f.epoch.committee,
          f.epoch.configHash,
        ),
      );
      assert(
        !verifyConfirmation(
          97,
          f.output,
          f.signature,
          {
            ...certificate,
            votes: [...certificate.votes.slice(0, -1), certificate.votes[0]!],
          },
          f.epoch.committee,
          f.epoch.configHash,
        ),
      );
    } finally {
      f.db.close();
    }
  }
});

test("frozen proposal rejects replacement, wrong-domain votes and missing membership", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        f.book.freeze(
          f.epoch,
          { ...f.output, risks: ["other"] },
          f.signature,
          f.options,
          f.now + 1,
        ),
      /frozen|signature/,
    );
    assert.throws(
      () => f.book.intent(f.epoch, "outsider", f.now + 1),
      /committee/,
    );
    const member = f.epoch.committee[0]!;
    f.book.intent(f.epoch, member.id, f.now + 1);
    const wrong = await f
      .wallet(member.id)
      .signMessage(
        confirmationMessage({ ...f.proposal.descriptor, chainId: 56 }),
      );
    assert.throws(
      () => f.book.vote(f.epoch, member.id, wrong, f.now + 2),
      /signature/,
    );
    assert.throws(
      () => f.book.vote(f.epoch, member.id, "0x", f.now + 2),
      /signature/,
    );
    assert.throws(
      () => f.book.intent(f.epoch, member.id, f.proposal.descriptor.expiresAt),
      /expired/,
    );
  } finally {
    f.db.close();
  }
});

test("restart preserves candidate and one vote intent across coordinator views", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-confirmation-"));
  const f = await fixture(3, join(dir, "state.sqlite"));
  const member = f.epoch.committee[0]!,
    message = f.book.intent(f.epoch, member.id, f.now + 1);
  f.db.close();
  const db = new Store(join(dir, "state.sqlite"));
  try {
    const book = new Confirmations(db),
      live = db.get<any>("epoch", f.epoch.id)!;
    db.put("epoch", live.id, {
      ...live,
      view: 1,
      master: live.committee[1].id,
    });
    const next = db.get<any>("epoch", live.id)!;
    assert.equal(book.intent(next, member.id, f.now + 2), message);
    assert.equal(hash(book.proposal(next.id)!.output), hash(f.output));
    const signature = await f.wallet(member.id).signMessage(message);
    assert.throws(
      () => book.vote(f.epoch, member.id, signature, f.now + 3),
      /stale/,
    );
    book.vote(next, member.id, signature, f.now + 3);
    assert.equal(db.all("confirmation-intent").length, 1);
    const changed = {
      ...book.proposal(next.id)!,
      output: { ...f.output, risks: ["corrupted"] },
    };
    db.put("confirmation-proposal", next.id, changed);
    assert.throws(
      () => book.intent(next, next.committee[1].id, f.now + 4),
      /hash|changed/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("new epochs cannot publish without quorum; takeover retains candidate and fixed expiry", async () => {
  const f = await fixture();
  try {
    assert.equal(f.epoch.confirmationRequired, true);
    assert.throws(
      () =>
        f.epochs.publish(
          f.epoch.id,
          f.epoch.view,
          f.epoch.master,
          f.output,
          f.signature,
          f.now + 1,
        ),
      /quorum/,
    );
    await f.vote(f.epoch.committee[0]!.id);
    const frozen = f.epochs.get(f.epoch.id),
      next = f.epochs.takeover(f.epoch.id, 0, frozen.deadline);
    assert.equal(next.confirmationDeadline, frozen.confirmationDeadline);
    assert.equal(next.view, 1);
    for (const c of next.committee.slice(1)) {
      const msg = f.book.intent(next, c.id, frozen.deadline + 1);
      f.book.vote(
        next,
        c.id,
        await f.wallet(c.id).signMessage(msg),
        frozen.deadline + 2,
      );
    }
    assert.throws(
      () =>
        f.epochs.publish(
          next.id,
          next.view,
          next.master,
          { ...f.output, risks: ["replacement"] },
          f.signature,
          frozen.deadline + 3,
        ),
      /frozen/,
    );
    f.epochs.publish(
      next.id,
      next.view,
      next.master,
      f.output,
      f.signature,
      frozen.deadline + 3,
    );
    const published = f.epochs.get(next.id);
    assert.equal(published.status, "PUBLISHED");
    assert.notEqual(published.master, (published.output as any).master);
    assert(
      verifyConfirmation(
        97,
        published.output,
        published.signature!,
        published.confirmation!,
        published.committee,
        published.configHash,
      ),
    );
  } finally {
    f.db.close();
  }
});

test("confirmation expiry fails the round and permits the subsequent epoch", async () => {
  const f = await fixture();
  try {
    const deadline = f.proposal.descriptor.expiresAt;
    assert.equal(f.epochs.takeover(f.epoch.id, 0, deadline).status, "FAILED");
    assert.throws(
      () => f.book.intent(f.epoch, f.epoch.master, deadline),
      /stale|expired/,
    );
    assert.equal(
      f.epochs.open(1, f.epoch.committee, f.epoch.config, deadline + 1).status,
      "RUNNING",
    );
  } finally {
    f.db.close();
  }
});

test("scheduler resumes persisted confirmations without LLM or price calls; unavailable signer retries without new research", async () => {
  const { Runner } = await import("../src/runner.js");
  const { Scheduler } = await import("../src/scheduler.js");
  const { loadConfig } = await import("./test-config.js");
  const f = await fixture();
  let offline = f.epoch.committee[2]!.id,
    calls = 0;
  const config = loadConfig();
  const agents: any = {
    db: f.db,
    list: () => [],
    get: (id: string) => ({ id, launch: "CONFIRMED", jailed: false }),
    vault: {
      withWallet: async (w: any, fn: any) => {
        calls++;
        if (w.id === offline) throw Error("wallet temporarily unavailable");
        return fn(f.wallet(w.id));
      },
    },
  };
  for (const c of f.epoch.committee) {
    f.db.put("wallet", c.id, { id: c.id, address: c.wallet });
    f.db.put("chain-state", c.id, {
      known: true,
      observedAt: Date.now(),
      bonded: "300000000000000000",
      exit: "0",
    });
  }
  const fail = () => {
    throw Error("must not invoke LLM or price during confirmation");
  };
  const llm: any = {
    refreshPrice: fail,
    priceReady: fail,
    probeProvider: fail,
    call: fail,
  };
  const penalties: any = { observeResearch() {}, recoverOperational: fail };
  try {
    const runner = new Runner(agents, {} as any, f.epochs, llm, config);
    await assert.rejects(runner.run(f.epoch), /quorum/);
    assert.equal(f.db.all("confirmation-vote").length, 2);
    assert.equal(f.db.all("incident").length, 0);
    assert.equal(f.epochs.get(f.epoch.id).status, "RUNNING");
    const firstCalls = calls;
    offline = "";
    // A fresh Runner models a process restart. Only the missing signer is invoked.
    const restarted = new Runner(agents, {} as any, f.epochs, llm, config);
    const scheduler = new Scheduler(restarted, penalties);
    await scheduler.tick();
    await new Promise<void>((r) => setImmediate(r));
    await scheduler.stop();
    assert.equal(f.epochs.get(f.epoch.id).status, "PUBLISHED");
    assert.equal(calls - firstCalls, 1);
    assert.equal(f.db.all("llm-call").length, 0);
    assert.equal(f.db.all("confirmation-intent").length, 3);
  } finally {
    f.db.close();
  }
});

test("scheduler reaches FAILED at fixed confirmation expiry even with unavailable provider", async () => {
  const { Scheduler } = await import("../src/scheduler.js");
  const f = await fixture();
  try {
    // Shorten the stored timeout to model a restart after the confirmation window.
    const live = f.epochs.get(f.epoch.id);
    f.db.put("epoch", live.id, {
      ...live,
      deadline: Date.now() - 1,
      confirmationDeadline: Date.now() - 1,
    });
    let canceled = false;
    const fail = () => {
      throw Error("provider must not block timeout");
    };
    const runner: any = {
      agents: { db: f.db, list: () => [] },
      epochs: f.epochs,
      cancel() {
        canceled = true;
      },
      llm: { refreshPrice: fail },
      run: fail,
    };
    const scheduler = new Scheduler(runner, {
      observeResearch() {},
      recoverOperational: fail,
    } as any);
    await scheduler.tick();
    assert.equal(canceled, true);
    assert.equal(f.epochs.get(live.id).status, "FAILED");
    await scheduler.stop();
  } finally {
    f.db.close();
  }
});
