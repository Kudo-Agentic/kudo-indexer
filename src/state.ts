import { BigDecimal, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { Agent, Covenant, Stats } from "../generated/schema";

const STATS_ID = "global";

/** The agent row for a wallet, or a fresh one with nothing counted. */
export function loadAgent(wallet: Bytes, timestamp: BigInt): Agent {
  const id = wallet.toHexString();
  let agent = Agent.load(id);
  if (agent == null) {
    agent = new Agent(id);
    agent.wallet = wallet;
    agent.total = 0;
    agent.minted = 0;
    agent.ongoing = 0;
    agent.completed = 0;
    agent.failed = 0;
    agent.openAsks = 0;
    agent.firstCovenantAt = timestamp;
    agent.lastCovenantAt = timestamp;
  }
  return agent;
}

function loadStats(): Stats {
  let stats = Stats.load(STATS_ID);
  if (stats == null) {
    stats = new Stats(STATS_ID);
    stats.covenants = 0;
    stats.agents = 0;
    stats.minted = 0;
    stats.ongoing = 0;
    stats.completed = 0;
    stats.failed = 0;
    stats.openAsks = 0;
  }
  return stats;
}

/** What a covenant contributes to the rollups. Hidden covenants contribute nothing. */
class Contribution {
  constructor(
    public counted: boolean,
    public status: string,
    public askOpen: boolean,
  ) {}

  static of(covenant: Covenant | null): Contribution {
    if (covenant == null || covenant.hidden) return new Contribution(false, "", false);
    return new Contribution(true, covenant.status, covenant.askOpen);
  }

  same(other: Contribution): boolean {
    return (
      this.counted == other.counted &&
      this.status == other.status &&
      this.askOpen == other.askOpen
    );
  }
}

/** Status counts and open asks, moved by `sign` (+1 or -1) for one contribution. */
function shiftAgent(agent: Agent, c: Contribution, sign: i32): void {
  if (!c.counted) return;
  agent.total += sign;
  if (c.status == "minted") agent.minted += sign;
  else if (c.status == "ongoing") agent.ongoing += sign;
  else if (c.status == "completed") agent.completed += sign;
  else if (c.status == "failed") agent.failed += sign;
  if (c.askOpen) agent.openAsks += sign;
}

function shiftStats(stats: Stats, c: Contribution, sign: i32): void {
  if (!c.counted) return;
  stats.covenants += sign;
  if (c.status == "minted") stats.minted += sign;
  else if (c.status == "ongoing") stats.ongoing += sign;
  else if (c.status == "completed") stats.completed += sign;
  else if (c.status == "failed") stats.failed += sign;
  if (c.askOpen) stats.openAsks += sign;
}

function completionRate(agent: Agent): BigDecimal | null {
  const resolved = agent.completed + agent.failed;
  if (resolved == 0) return null;
  return BigInt.fromI32(agent.completed)
    .toBigDecimal()
    .div(BigInt.fromI32(resolved).toBigDecimal());
}

/**
 * Write a covenant and move the agent's and the chain's counts by the
 * difference it made. Every covenant write goes through here, so the rollups
 * never drift from the rows they summarize.
 *
 * `agent` is the agent row as the caller already has it (possibly new), so a
 * mint can create both in one pass. It is always saved: a covenant must
 * never point at an agent row that does not exist.
 */
export function saveCovenant(before: Covenant | null, after: Covenant, agent: Agent): void {
  after.save();

  const was = Contribution.of(before);
  const now = Contribution.of(after);

  if (was.same(now)) {
    agent.save();
    return;
  }

  // `hidden` is fixed at mint, so an agent's first counted covenant is the
  // one that takes its total off zero.
  const isNewAgent = agent.total == 0 && !was.counted && now.counted;

  shiftAgent(agent, was, -1);
  shiftAgent(agent, now, 1);
  agent.completionRate = completionRate(agent);
  agent.save();

  const stats = loadStats();
  shiftStats(stats, was, -1);
  shiftStats(stats, now, 1);
  if (isNewAgent) stats.agents += 1;
  stats.save();
}
