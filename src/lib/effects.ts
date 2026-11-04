import { createHmac } from "node:crypto";
import { createEffect, S } from "envio";
import { createPublicClient, hexToString, http, parseAbi } from "viem";

const RPC_URL =
  process.env.ENVIO_ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const client = createPublicClient({ transport: http(RPC_URL, { batch: true }) });

const KUDO_ABI = parseAbi([
  "struct CovenantData { address agentWallet; uint256 agentId; uint8 status; string nftType; string ask; string covenantPromise; string promiseDetail; string askSettlementData; uint256 askSettledAt; string promiseSettlementData; }",
  "function getCovenant(uint256 nftId) view returns (CovenantData)",
]);

const IDENTITY_REGISTRY_ABI = parseAbi([
  "function getMetadata(uint256 agentId, string key) view returns (bytes)",
]);

// The ERC-8004 Identity Registry on Robinhood Chain (kudo-client
// src/lib/constants/contracts.ts).
const IDENTITY_REGISTRY =
  (process.env.ENVIO_IDENTITY_REGISTRY_ADDRESS as `0x${string}` | undefined) ||
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

/**
 * What CovenantMinted leaves out: the agent's ERC-8004 id, and that
 * identity's display name.
 *
 * Both are read at the chain's head, not the mint block: the public RPC is
 * pruned, and agentId never changes after mint. The name can change, so it is
 * the name as of indexing. A failed read is returned empty and not cached, so
 * a resync tries again.
 */
export const getCovenantAgent = createEffect(
  {
    name: "getCovenantAgent",
    input: { contract: S.string, nftId: S.bigint },
    output: { agentId: S.union([S.bigint, null]), name: S.union([S.string, null]) },
    cache: true,
    rateLimit: { calls: 20, per: "second" },
  },
  async ({ input, context }) => {
    // Tests run on simulated covenants that do not exist on chain.
    if (process.env.ENVIO_CONTRACT_READS === "off") {
      context.cache = false;
      return { agentId: null, name: null };
    }

    let agentId: bigint;
    try {
      const covenant = await client.readContract({
        address: input.contract as `0x${string}`,
        abi: KUDO_ABI,
        functionName: "getCovenant",
        args: [input.nftId],
      });
      agentId = covenant.agentId;
    } catch (error) {
      context.log.warn(`getCovenant(${input.nftId}) on ${input.contract} failed: ${error}`);
      context.cache = false;
      return { agentId: null, name: null };
    }

    try {
      const raw = await client.readContract({
        address: IDENTITY_REGISTRY,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: "getMetadata",
        args: [agentId, "name"],
      });
      const name = raw && raw !== "0x" ? hexToString(raw).trim() : "";
      return { agentId, name: name || null };
    } catch (error) {
      context.log.warn(`getMetadata(${agentId}, "name") failed: ${error}`);
      context.cache = false;
      return { agentId, name: null };
    }
  },
);

const WEBHOOK_URL = process.env.ENVIO_KUDO_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.ENVIO_KUDO_WEBHOOK_SECRET;

export const webhookConfigured = () => !!WEBHOOK_URL;

/**
 * POST one covenant event to Kudo's webhook, so `watchSettlement` in the SDK
 * can be pushed to rather than poll.
 *
 * The body is signed with HMAC-SHA256 over the raw body, hex, in
 * `x-kudo-signature` when ENVIO_KUDO_WEBHOOK_SECRET is set. Delivery is
 * best-effort: a failure is logged and never halts indexing. Receivers should
 * dedupe on `id` and treat a delivery as provisional until the block is final.
 */
export const postWebhook = createEffect(
  {
    name: "postWebhook",
    input: { id: S.string, body: S.string },
    output: S.boolean,
    cache: false,
    rateLimit: { calls: 10, per: "second" },
  },
  async ({ input, context }) => {
    if (!WEBHOOK_URL) return false;

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-kudo-event-id": input.id,
    };
    if (WEBHOOK_SECRET) {
      headers["x-kudo-signature"] = createHmac("sha256", WEBHOOK_SECRET)
        .update(input.body)
        .digest("hex");
    }

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers,
        body: input.body,
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        context.log.warn(`Webhook ${input.id} answered ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      context.log.warn(`Webhook ${input.id} failed: ${error}`);
      return false;
    }
  },
);
