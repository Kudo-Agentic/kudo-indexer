import { describe, it } from "vitest";
import { createTestIndexer, TestHelpers } from "envio";

const { Addresses } = TestHelpers;

const CHAIN = 4663;
const CURRENT = "0x1930d0feab14b024353bf22ade03db989ad640c7";
const LEGACY = "0xc269c6176f3418a84fcda5911723b0d358971351";
// Simulated blocks must sit past config.yaml's start_block to be routed.
const B = 103_000_000;
const ZERO = "0x0000000000000000000000000000000000000000";

const agent = Addresses.mockAddresses[0].toLowerCase() as `0x${string}`;
const buyer = Addresses.mockAddresses[1].toLowerCase() as `0x${string}`;

/** The two logs a mint emits, in the order the contract emits them. */
const mint = (srcAddress: `0x${string}`, nftId: bigint, block: number) =>
  [
    {
      contract: "Kudo",
      event: "Transfer",
      srcAddress,
      block: { number: block, timestamp: 1_700_000_000 + (block - B) * 10 },
      params: { from: ZERO, to: agent, tokenId: nftId },
    },
    {
      contract: "Kudo",
      event: "CovenantMinted",
      srcAddress,
      block: { number: block, timestamp: 1_700_000_000 + (block - B) * 10 },
      transaction: { hash: `0x${"ab".repeat(31)}${nftId.toString(16).padStart(2, "0")}`, from: agent },
      params: {
        nftId,
        agent,
        nftType: "service",
        covenantPromise: "Write the report",
        ask: "Send 10 USDG",
      },
    },
  ] as const;

describe("Kudo covenants", () => {
  it("indexes a mint as an open covenant with its owner and agent", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({ chains: { [CHAIN]: { simulate: [...mint(CURRENT, 3n, B + 0)] } } });

    const covenant = await indexer.Covenant.getOrThrow(`${CURRENT}:3`);
    t.expect(covenant).toMatchObject({
      contract: CURRENT,
      nftId: 3n,
      isLegacy: false,
      hidden: false,
      agent_id: agent,
      owner: agent,
      recordedStatus: "Minted",
      status: "Minted",
      askOpen: true,
      ask: "Send 10 USDG",
      promise: "Write the report",
      mintedBlock: B,
      mintedAt: 1_700_000_000n,
    });

    t.expect(await indexer.Agent.getOrThrow(agent)).toMatchObject({
      total: 1,
      minted: 1,
      openAsks: 1,
      completionRate: undefined,
    });
    t.expect(await indexer.Stats.getOrThrow("global")).toMatchObject({
      covenants: 1,
      agents: 1,
      minted: 1,
      openAsks: 1,
    });
  });

  it("reads a covenant with both proofs written as completed", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...mint(CURRENT, 4n, B + 0),
            {
              contract: "Kudo",
              event: "AskSettlementSet",
              srcAddress: CURRENT,
              block: { number: B + 1, timestamp: 1_700_000_000 + 10 },
              transaction: { hash: "0xask", from: buyer },
              params: { nftId: 4n, askSettlement: "0xpaid", promiseDetails: "Spec: https://x" },
            },
            {
              contract: "Kudo",
              event: "PromiseSettlementSet",
              srcAddress: CURRENT,
              block: { number: B + 2, timestamp: 1_700_000_000 + 20 },
              transaction: { hash: "0xpromise", from: agent },
              params: { nftId: 4n, promiseSettlement: "https://report" },
            },
          ],
        },
      },
    });

    const covenant = await indexer.Covenant.getOrThrow(`${CURRENT}:4`);
    t.expect(covenant).toMatchObject({
      // The contract never advanced status; the proofs make it completed.
      recordedStatus: "Minted",
      status: "Completed",
      askOpen: false,
      askSettlement: "0xpaid",
      askSettledBy: buyer,
      askSettledTx: "0xask",
      askSettledAt: 1_700_000_010n,
      promiseDetail: "Spec: https://x",
      promiseSettlement: "https://report",
      promiseSettledBy: agent,
    });

    t.expect(await indexer.Agent.getOrThrow(agent)).toMatchObject({
      total: 1,
      minted: 0,
      completed: 1,
      openAsks: 0,
      completionRate: 1,
    });

    const kinds = (await indexer.CovenantEvent.getAll())
      .filter((row) => row.covenant_id === `${CURRENT}:4`)
      .map((row) => row.kind)
      .sort();
    t.expect(kinds).toEqual(["AskSettled", "Minted", "PromiseSettled"]);
  });

  it("decodes legacy statuses without MINTED and keeps blacklisted ids out of the counts", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...mint(LEGACY, 1n, B + 0),
            ...mint(LEGACY, 7n, B + 1),
            {
              contract: "Kudo",
              event: "CovenantPromiseSet",
              srcAddress: LEGACY,
              block: { number: B + 2, timestamp: 1_700_000_000 + 20 },
              params: { nftId: 1n, status: 2n },
            },
          ],
        },
      },
    });

    t.expect(await indexer.Covenant.getOrThrow(`${LEGACY}:1`)).toMatchObject({
      isLegacy: true,
      hidden: false,
      // 2 is Failed on the legacy contract; on the current one it is Completed.
      recordedStatus: "Failed",
      status: "Failed",
      askOpen: false,
    });
    t.expect(await indexer.Covenant.getOrThrow(`${LEGACY}:7`)).toMatchObject({
      hidden: true,
      // The legacy contract starts at ONGOING.
      status: "Ongoing",
    });

    t.expect(await indexer.Agent.getOrThrow(agent)).toMatchObject({
      total: 1,
      failed: 1,
      ongoing: 0,
      openAsks: 0,
      completionRate: 0,
    });
    t.expect(await indexer.Stats.getOrThrow("global")).toMatchObject({
      covenants: 1,
      agents: 1,
      failed: 1,
    });
  });

  it("follows the covenant NFT when it changes hands", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            ...mint(CURRENT, 5n, B + 0),
            {
              contract: "Kudo",
              event: "Transfer",
              srcAddress: CURRENT,
              block: { number: B + 1, timestamp: 1_700_000_000 + 10 },
              params: { from: agent, to: buyer, tokenId: 5n },
            },
          ],
        },
      },
    });

    t.expect((await indexer.Covenant.getOrThrow(`${CURRENT}:5`)).owner).toBe(buyer);
    const transfers = (await indexer.CovenantEvent.getAll()).filter(
      (row) => row.kind === "Transferred",
    );
    t.expect(transfers.map((row) => row.value)).toEqual([buyer]);
  });
});
