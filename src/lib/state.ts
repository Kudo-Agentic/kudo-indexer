import type { Agent, Covenant, EvmOnEventContext as HandlerContext, Stats } from "envio";
import type { CovenantStatus } from "./contracts";

const STATS_ID = "global";

const COUNTER: Record<CovenantStatus, "minted" | "ongoing" | "completed" | "failed"> = {
  Minted: "minted",
  Ongoing: "ongoing",
  Completed: "completed",
  Failed: "failed",
};

/** What a covenant contributes to the rollups. Hidden covenants contribute nothing. */
type Contribution = { status: CovenantStatus; askOpen: boolean } | undefined;

const contributionOf = (covenant: Covenant | undefined): Contribution =>
  covenant && !covenant.hidden
    ? { status: covenant.status, askOpen: covenant.askOpen }
    : undefined;

type Counts = {
  total: number;
  minted: number;
  ongoing: number;
  completed: number;
  failed: number;
  openAsks: number;
};

/** `counts` with `before` taken out and `after` put in. */
const shift = <T extends Counts>(counts: T, before: Contribution, after: Contribution): T => {
  const next = { ...counts };
  if (before) {
    next.total -= 1;
    next[COUNTER[before.status]] -= 1;
    if (before.askOpen) next.openAsks -= 1;
  }
  if (after) {
    next.total += 1;
    next[COUNTER[after.status]] += 1;
    if (after.askOpen) next.openAsks += 1;
  }
  return next;
};

const unchanged = (a: Contribution, b: Contribution) =>
  a?.status === b?.status && a?.askOpen === b?.askOpen;

const completionRate = (counts: Counts) => {
  const resolved = counts.completed + counts.failed;
  return resolved ? counts.completed / resolved : undefined;
};

const emptyStats = (): Stats => ({
  id: STATS_ID,
  covenants: 0,
  agents: 0,
  minted: 0,
  ongoing: 0,
  completed: 0,
  failed: 0,
  openAsks: 0,
});

/**
 * Write a covenant and move the agent's and the chain's counts by the
 * difference it made. Every covenant write goes through here, so the rollups
 * never drift from the rows they summarize.
 *
 * `agent` is the agent row as the caller already has it (possibly just
 * created), so a mint can create both in one pass.
 */
export const saveCovenant = async (
  context: HandlerContext,
  before: Covenant | undefined,
  after: Covenant,
  agent: Agent,
) => {
  context.Covenant.set(after);

  const was = contributionOf(before);
  const now = contributionOf(after);

  if (unchanged(was, now)) {
    // Still written: the caller may have changed its name or id, and a
    // covenant must never point at an agent row that does not exist.
    context.Agent.set(agent);
    return;
  }

  // `hidden` is fixed at mint, so an agent's first counted covenant is the
  // one that takes its total off zero.
  const isNewAgent = agent.total === 0 && !was && !!now;

  const agentCounts = shift(agent, was, now);
  context.Agent.set({ ...agentCounts, completionRate: completionRate(agentCounts) });

  const { covenants, ...statsCounts } = (await context.Stats.get(STATS_ID)) ?? emptyStats();
  const { total, ...rest } = shift({ ...statsCounts, total: covenants }, was, now);
  context.Stats.set({
    ...rest,
    covenants: total,
    agents: rest.agents + (isNewAgent ? 1 : 0),
  });
};

/** The agent row for a wallet, or a fresh one with nothing counted. */
export const loadAgent = async (
  context: HandlerContext,
  wallet: string,
  timestamp: bigint,
): Promise<Agent> =>
  (await context.Agent.get(wallet)) ?? {
    id: wallet,
    wallet,
    agentId: undefined,
    name: undefined,
    total: 0,
    minted: 0,
    ongoing: 0,
    completed: 0,
    failed: 0,
    openAsks: 0,
    completionRate: undefined,
    firstCovenantAt: timestamp,
    lastCovenantAt: timestamp,
  };
