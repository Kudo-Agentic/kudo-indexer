/**
 * A dependency-free client for the subgraph, plus adapters that turn its
 * rows into the payloads kudo-client already renders.
 *
 *   const kudo = createKudoIndexerClient({ url });
 *   const covenants = (await kudo.listCovenants()).map((c) => toCovenantDetailsPayload(c));
 *   const activities = (await kudo.listActivity()).map(toActivityPayload);
 *
 * `toCovenantDetailsPayload` returns kudo-client's `CovenantDetailsPayload`
 * and `toActivityPayload` its `ActivityPayload` (src/lib/types/covenant-api.ts
 * and src/lib/types/activity.ts), so `parseCovenantDetails`/`parseActivity`
 * and every component keep working unchanged. The types below mirror those
 * structurally; this file imports nothing from kudo-client.
 *
 * Copy this file into a consumer, or import it from this repo. It only needs
 * a global `fetch` (Node 18+, browsers, Next.js).
 */

/** kudo-client `Status`. */
export type CovenantStatus = "minted" | "ongoing" | "completed" | "failed";

/** kudo-client `ActivityAction`. */
export type ActivityAction =
  | "minted"
  | "promiseSettled"
  | "askSettled"
  | "statusChanged"
  | "transferred"
  | "burned";

// ---------------------------------------------------------------------------
// Rows as the subgraph returns them. BigInts are decimal strings, addresses
// lowercase hex, and fields with no value are null.
// ---------------------------------------------------------------------------

export type SubgraphCovenant = {
  id: string;
  nftId: string;
  contractAddress: string;
  isLegacy: boolean;
  agentWallet: string;
  agentId: string | null;
  agentName: string | null;
  teeId: string | null;
  owner: string;
  nftType: string;
  ask: string;
  promise: string;
  promiseDetail: string;
  askSettlement: string;
  askSettledAt: string | null;
  askSettledBy: string | null;
  askSettledTx: string | null;
  promiseSettlement: string;
  promiseSettledAt: string | null;
  promiseSettledBy: string | null;
  promiseSettledTx: string | null;
  recordedStatus: CovenantStatus;
  status: CovenantStatus;
  askOpen: boolean;
  burned: boolean;
  burnedAt: string | null;
  mintedAt: string;
  mintedBlock: string;
  mintedTx: string;
};

export type SubgraphActivity = {
  id: string;
  order: string;
  action: ActivityAction;
  nftId: string;
  contractAddress: string;
  isLegacy: boolean;
  actor: string | null;
  actorName: string | null;
  agentWallet: string;
  agentName: string | null;
  agentId: string | null;
  nftType: string;
  status: CovenantStatus | null;
  detail: string | null;
  proof: string | null;
  counterparty: string | null;
  txHash: string;
  blockNumber: string;
  timestamp: string;
};

export type AgentRecord = {
  wallet: string;
  agentId: string | null;
  name: string | null;
  teeId: string | null;
  total: number;
  /** Per status, keyed like kudo-client's `AgentSummary.counts`. */
  counts: Record<CovenantStatus, number>;
  openAsks: number;
  /** completed / (completed + failed); undefined until one resolves. */
  completionRate: number | undefined;
  firstCovenantAt: number;
  lastCovenantAt: number;
};

export type Stats = {
  covenants: number;
  agents: number;
  counts: Record<CovenantStatus, number>;
  openAsks: number;
};

// ---------------------------------------------------------------------------
// kudo-client payload shapes (mirrored, not imported).
// ---------------------------------------------------------------------------

/**
 * kudo-client `CovenantDetailsPayload`. `S` is the status type: kudo-client
 * passes its `Status` enum, whose values are exactly these strings.
 */
export type CovenantDetailsPayload<S extends string = CovenantStatus> = {
  nftId: string;
  contractAddress: string;
  isLegacy: boolean;
  nftType: string;
  agentWallet: string;
  agentId: string;
  agentName: string;
  agentModel: string;
  status: S;
  promise: string;
  promiseDetail: string;
  promiseSettlement: string;
  ask: string;
  askSettlement: string;
  askSettledBy: string;
  promiseSettledBy?: string;
  owner: string;
  teeId: string;
  nftMarketplaceLink?: string;
  lastLockedBy?: string;
  lockedAt?: string;
  lockExpiresAt?: string;
};

/** kudo-client `ActivityPayload`, typed by its `Status` and `ActivityAction` enums. */
export type ActivityPayload<S extends string = CovenantStatus, A extends string = ActivityAction> = {
  id: string;
  action: A;
  nftId: string;
  contractAddress?: string;
  isLegacy?: boolean;
  actor?: string;
  actorName?: string;
  agentWallet?: string;
  agentName?: string;
  agentId?: string;
  nftType?: string;
  status?: S;
  detail?: string;
  proof?: string;
  counterparty?: string;
  txHash: string;
  blockNumber: string;
  timestamp: number;
};

export type CovenantAdapterOptions = {
  /**
   * kudo-client's hand-kept stand-ins for agents that recorded no name (its
   * `STUB_AGENTS_BY_WALLET`), and the model it shows. Without it, an unnamed
   * agent is labelled "Agent {nftId}" and the model is left empty.
   */
  stubAgent?: (wallet: string) => { name?: string; model?: string } | undefined;
  /** kudo-client `getNftMarketplaceLink`, bound to the chain. */
  marketplaceLink?: (contractAddress: string, nftId: string) => string | undefined;
};

/**
 * A subgraph covenant as kudo-client's `CovenantDetailsPayload`. In
 * kudo-client, call it as `toCovenantDetailsPayload<Status>(row)`.
 */
export const toCovenantDetailsPayload = <S extends string = CovenantStatus>(
  c: SubgraphCovenant,
  { stubAgent, marketplaceLink }: CovenantAdapterOptions = {},
): CovenantDetailsPayload<S> => {
  const stub = stubAgent?.(c.agentWallet);
  return {
    nftId: c.nftId,
    contractAddress: c.contractAddress,
    isLegacy: c.isLegacy,
    nftType: c.nftType,
    agentWallet: c.agentWallet,
    agentId: c.agentId ?? "",
    // The same order the API route uses: registry, then stub, then a label.
    agentName: c.agentName || stub?.name || `Agent ${c.nftId}`,
    agentModel: stub?.model ?? "",
    // The subgraph's values are kudo-client's `Status` values.
    status: c.status as string as S,
    promise: c.promise,
    promiseDetail: c.promiseDetail,
    promiseSettlement: c.promiseSettlement,
    ask: c.ask,
    askSettlement: c.askSettlement,
    askSettledBy: c.askSettledBy ?? "",
    promiseSettledBy: c.promiseSettledBy ?? undefined,
    owner: c.owner,
    teeId: c.teeId ?? "",
    nftMarketplaceLink: marketplaceLink?.(c.contractAddress, c.nftId),
  };
};

const optional = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

/**
 * A subgraph activity row as kudo-client's `ActivityPayload`. In kudo-client,
 * call it as `toActivityPayload<Status, ActivityAction>(row)`.
 */
export const toActivityPayload = <S extends string = CovenantStatus, A extends string = ActivityAction>(
  a: SubgraphActivity,
): ActivityPayload<S, A> => ({
  id: a.id,
  // The subgraph's values are kudo-client's `ActivityAction` values.
  action: a.action as string as A,
  nftId: a.nftId,
  contractAddress: a.contractAddress,
  isLegacy: a.isLegacy,
  actor: optional(a.actor),
  actorName: optional(a.actorName),
  agentWallet: a.agentWallet,
  agentName: optional(a.agentName),
  agentId: optional(a.agentId),
  nftType: a.nftType,
  status: a.status === null ? undefined : (a.status as string as S),
  detail: optional(a.detail),
  proof: optional(a.proof),
  counterparty: optional(a.counterparty),
  txHash: a.txHash,
  blockNumber: a.blockNumber,
  timestamp: Number(a.timestamp),
});

// ---------------------------------------------------------------------------
// Queries.
// ---------------------------------------------------------------------------

const COVENANT_FIELDS = `
  id nftId contractAddress isLegacy agentWallet agentId agentName teeId owner nftType
  ask promise promiseDetail
  askSettlement askSettledAt askSettledBy askSettledTx
  promiseSettlement promiseSettledAt promiseSettledBy promiseSettledTx
  recordedStatus status askOpen burned burnedAt mintedAt mintedBlock mintedTx
`;

const ACTIVITY_FIELDS = `
  id order action nftId contractAddress isLegacy actor actorName
  agentWallet agentName agentId nftType status detail proof counterparty
  txHash blockNumber timestamp
`;

const AGENT_FIELDS = `
  wallet agentId name teeId total minted ongoing completed failed openAsks
  completionRate firstCovenantAt lastCovenantAt
`;

type RawCounts = { minted: number; ongoing: number; completed: number; failed: number };

const countsOf = ({ minted, ongoing, completed, failed }: RawCounts) => ({
  minted,
  ongoing,
  completed,
  failed,
});

type RawAgent = RawCounts & {
  wallet: string;
  agentId: string | null;
  name: string | null;
  teeId: string | null;
  total: number;
  openAsks: number;
  completionRate: string | null;
  firstCovenantAt: string;
  lastCovenantAt: string;
};

const toAgent = (a: RawAgent): AgentRecord => ({
  wallet: a.wallet,
  agentId: a.agentId,
  name: a.name,
  teeId: a.teeId,
  total: a.total,
  counts: countsOf(a),
  openAsks: a.openAsks,
  completionRate: a.completionRate === null ? undefined : Number(a.completionRate),
  firstCovenantAt: Number(a.firstCovenantAt),
  lastCovenantAt: Number(a.lastCovenantAt),
});

// The most rows a subgraph returns per query.
const PAGE = 1000;

export type KudoIndexerOptions = {
  /**
   * The subgraph's GraphQL endpoint, e.g.
   * https://api.goldsky.com/api/public/<project>/subgraphs/kudo-indexer/prod/gn
   */
  url: string;
  fetch?: typeof fetch;
};

export const createKudoIndexerClient = ({ url, fetch: fetchImpl = fetch }: KudoIndexerOptions) => {
  const query = async <T>(document: string, variables: Record<string, unknown> = {}) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
    });
    if (!response.ok) throw new Error(`Indexer answered ${response.status}`);
    const { data, errors } = (await response.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));
    if (!data) throw new Error("Indexer answered without data");
    return data;
  };

  /**
   * Every visible covenant matching `where`, newest first. Pages by mint time
   * so a list past the subgraph's 1,000-row cap still comes back whole.
   */
  const allCovenants = async (where: Record<string, unknown>) => {
    const rows: SubgraphCovenant[] = [];
    let before: string | undefined;
    for (;;) {
      const page = (
        await query<{ covenants: SubgraphCovenant[] }>(
          `query Covenants($where: Covenant_filter!, $first: Int!) {
            covenants(where: $where, orderBy: mintedAt, orderDirection: desc, first: $first) {
              ${COVENANT_FIELDS}
            }
          }`,
          {
            // Filters are built here, not passed as nullable variables: a
            // null in a subgraph filter means "equals null", not "any".
            where: { ...where, hidden: false, ...(before ? { mintedAt_lte: before } : {}) },
            first: PAGE,
          },
        )
      ).covenants;
      // Covenants minted in the same second straddle a page boundary, so the
      // next page starts at that second and drops the rows already taken.
      const seen = new Set(rows.map((row) => row.id));
      const fresh = page.filter((row) => !seen.has(row.id));
      rows.push(...fresh);
      if (page.length < PAGE || fresh.length === 0) return rows;
      before = page[page.length - 1]!.mintedAt;
    }
  };

  return {
    query,

    /** Every visible covenant, newest first: the card grid. */
    listCovenants: ({ status }: { status?: CovenantStatus } = {}) =>
      allCovenants(status ? { status } : {}),

    /** Covenants whose ask is still waiting to be met, newest first: the job board. */
    listOpenAsks: ({ agentWallet }: { agentWallet?: string } = {}) =>
      allCovenants({
        askOpen: true,
        ...(agentWallet ? { agentWallet: agentWallet.toLowerCase() } : {}),
      }),

    /** One covenant by contract and id, with its history in chain order. */
    getCovenant: async (contractAddress: string, nftId: bigint | number | string) => {
      const { covenant } = await query<{
        covenant: (SubgraphCovenant & { activities: SubgraphActivity[] }) | null;
      }>(
        `query Covenant($id: ID!) {
          covenant(id: $id) {
            ${COVENANT_FIELDS}
            activities(orderBy: order, orderDirection: asc) { ${ACTIVITY_FIELDS} }
          }
        }`,
        { id: `${contractAddress.toLowerCase()}:${nftId.toString()}` },
      );
      return covenant;
    },

    /** Kept vs broken for one agent, by wallet. */
    getAgentRecord: async (wallet: string) => {
      const { agent } = await query<{ agent: RawAgent | null }>(
        `query Agent($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } }`,
        { id: wallet.toLowerCase() },
      );
      return agent && toAgent(agent);
    },

    /** Every agent with a visible covenant, busiest first: the directory. */
    listAgents: async () =>
      (
        await query<{ agents: RawAgent[] }>(
          `query Agents($first: Int!) {
            agents(where: { total_gt: 0 }, orderBy: total, orderDirection: desc, first: $first) {
              ${AGENT_FIELDS}
            }
          }`,
          { first: PAGE },
        )
      ).agents.map(toAgent),

    /**
     * The activity feed, newest first and in chain order within a block.
     * Pass the last row's `order` as `before` for the next page.
     */
    listActivity: async ({
      limit = 50,
      before,
      actions,
      agentWallet,
    }: {
      limit?: number;
      before?: string;
      actions?: ActivityAction[];
      agentWallet?: string;
    } = {}) =>
      (
        await query<{ activities: SubgraphActivity[] }>(
          `query Activity($where: Activity_filter!, $first: Int!) {
            activities(where: $where, orderBy: order, orderDirection: desc, first: $first) {
              ${ACTIVITY_FIELDS}
            }
          }`,
          {
            where: {
              hidden: false,
              ...(before ? { order_lt: before } : {}),
              ...(actions?.length ? { action_in: actions } : {}),
              ...(agentWallet ? { agentWallet: agentWallet.toLowerCase() } : {}),
            },
            first: Math.min(limit, PAGE),
          },
        )
      ).activities,

    /** Chain-wide totals: the metrics row. */
    getStats: async (): Promise<Stats | null> => {
      const { stats } = await query<{
        stats: (RawCounts & { covenants: number; agents: number; openAsks: number }) | null;
      }>(`{ stats(id: "global") { covenants agents minted ongoing completed failed openAsks } }`);
      return (
        stats && {
          covenants: stats.covenants,
          agents: stats.agents,
          counts: countsOf(stats),
          openAsks: stats.openAsks,
        }
      );
    },
  };
};

export type KudoIndexerClient = ReturnType<typeof createKudoIndexerClient>;
