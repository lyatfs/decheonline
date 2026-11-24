import { COMMAND_DELAY_TURNS, MAX_ORDER_UNITS, ObjectState, TOWN_CENTER } from '@aoe/sim';
import type {
  BotIntent,
  BotObservation,
  BotPlanner,
  BotProfile,
  FailedTargetRecord,
  IntentOutcome,
  ObservedEnemy,
  ObservedOwnBuilding,
  ObservedOwnUnit,
  PlannerInput,
  SquadPhase,
  SquadRole,
  SquadState,
} from './types';

export const SQUAD_ORDER_COOLDOWN_TURNS = COMMAND_DELAY_TURNS + 2;
export const SQUAD_REORDER_COOLDOWN_TURNS = COMMAND_DELAY_TURNS + 4;
export const SQUAD_STUCK_TIMEOUT_TURNS = 6;
export const SQUAD_FAILED_TARGET_BACKOFF_TURNS = 16;

const RALLY_GROUP_RADIUS = 8.0;
const RALLY_ARRIVE_RADIUS = 6.0;
const RALLY_TIMEOUT_TURNS = 16;
const RETREAT_ARRIVE_RADIUS = 6.5;
const RETREAT_TIMEOUT_TURNS = 16;
const MIN_RECOVER_TURNS = 8;
const DEFENSE_BASE_RADIUS = 22.0;
const DEFENSE_VILLAGER_RADIUS = 12.0;
const VISIBLE_OUTNUMBER_RADIUS = 10.0;
const SCOUT_UNIT_TYPE = 299;
const DOCK_UNIT_TYPE = 45;

const PRIORITY_DEFENSE_ATTACK = 98;
const PRIORITY_RETREAT = 91;
const PRIORITY_ASSAULT_ATTACK = 82;
const PRIORITY_RALLY_MOVE = 72;
const PRIORITY_SCOUT_MOVE = 64;

interface Point {
  x: number;
  y: number;
}

interface CommandCommitSpec {
  readonly squadId: number;
  readonly role: SquadRole;
  readonly phase: SquadPhase;
  readonly targetId: number | null;
  readonly targetPos: Point | null;
  readonly unitIds: readonly number[];
  readonly clearStuck: boolean;
}

interface PlannedSnapshot {
  readonly turn: number;
  readonly player: number;
  readonly baseSquads: SquadState[];
  readonly nextSquadSeq: number;
  readonly failedTargetUpdates: Record<number, FailedTargetRecord>;
  readonly commandCommits: ReadonlyMap<string, CommandCommitSpec>;
}

function isOwnMilitaryAlive(u: ObservedOwnUnit): boolean {
  return u.isMilitary && u.hp > 0 && u.state < ObjectState.Dying && u.inside === null;
}

function isOwnBuildingAlive(b: ObservedOwnBuilding): boolean {
  return b.hp > 0 && b.state < ObjectState.Dying;
}

function isOwnVillagerAlive(u: ObservedOwnUnit): boolean {
  return u.isVillager && u.hp > 0 && u.state < ObjectState.Dying && u.inside === null;
}

function clampPoint(obs: BotObservation, x: number, y: number): Point {
  const maxX = Math.max(1, obs.mapWidth - 2);
  const maxY = Math.max(1, obs.mapHeight - 2);
  return {
    x: Math.min(maxX, Math.max(1, x)),
    y: Math.min(maxY, Math.max(1, y)),
  };
}

function getHomeAnchor(obs: BotObservation): Point {
  const aliveBuildings = obs.ownBuildings.filter(isOwnBuildingAlive);
  const activeTc = aliveBuildings.find((b) => b.type === TOWN_CENTER && !b.isUnbuilt);
  if (activeTc) return { x: activeTc.x, y: activeTc.y };
  const anyTc = aliveBuildings.find((b) => b.type === TOWN_CENTER);
  if (anyTc) return { x: anyTc.x, y: anyTc.y };
  if (aliveBuildings.length > 0) {
    return { x: aliveBuildings[0]!.x, y: aliveBuildings[0]!.y };
  }
  const villagers = obs.ownUnits.filter(isOwnVillagerAlive);
  if (villagers.length > 0) {
    return { x: villagers[0]!.x, y: villagers[0]!.y };
  }
  const mil = obs.ownUnits.filter(isOwnMilitaryAlive);
  if (mil.length > 0) {
    return { x: mil[0]!.x, y: mil[0]!.y };
  }
  return { x: obs.mapWidth / 2, y: obs.mapHeight / 2 };
}

function getNavalAnchor(obs: BotObservation, members: readonly ObservedOwnUnit[]): Point {
  const rep = members[0];
  const docks = obs.ownBuildings.filter((b) => isOwnBuildingAlive(b) && b.type === DOCK_UNIT_TYPE);
  if (rep && docks.length > 0) {
    for (const d of docks) {
      if (obs.canReach(rep.id, d.x, d.y, 4.0, false)) {
        return clampPoint(obs, d.x, d.y);
      }
    }
  }
  if (rep) {
    return clampPoint(obs, rep.x, rep.y);
  }
  return getHomeAnchor(obs);
}

function cloneSquad(s: SquadState): SquadState {
  return {
    id: s.id,
    role: s.role,
    phase: s.phase,
    memberIds: [...s.memberIds],
    targetId: s.targetId,
    targetPos: s.targetPos ? { x: s.targetPos.x, y: s.targetPos.y } : null,
    lastOrderTurn: s.lastOrderTurn,
    lastOrderTime: s.lastOrderTime,
    stuckSinceTurn: s.stuckSinceTurn,
  };
}

function squadDedupPriority(s: SquadState): number {
  let score = 0;
  if (s.role === 'defense') score += 100;
  if (s.phase === 'attacking') score += 50;
  else if (s.phase === 'retreating') score += 40;
  else if (s.phase === 'recovering') score += 30;
  else if (s.phase === 'rallying') score += 20;
  else score += 10;
  return score;
}

function getEffectiveAttackRange(
  obs: BotObservation,
  actor: ObservedOwnUnit,
  enemy: ObservedEnemy,
): number {
  const actorMaster = obs.enabledMasters[actor.type];
  const combatRange = actorMaster?.combat?.range ?? 0;
  return Math.max(enemy.reachRange, combatRange);
}

function canUnitReachEnemy(
  obs: BotObservation,
  actor: ObservedOwnUnit,
  enemy: ObservedEnemy,
  checkDynamicPath: boolean,
): boolean {
  return obs.canReach(
    actor.id,
    enemy.x,
    enemy.y,
    getEffectiveAttackRange(obs, actor, enemy),
    checkDynamicPath,
  );
}

function canSquadReachEnemy(
  obs: BotObservation,
  members: readonly ObservedOwnUnit[],
  enemy: ObservedEnemy,
  checkDynamicPath: boolean,
): boolean {
  const rep = members[0];
  if (!rep) return false;
  if (!checkDynamicPath) {
    return members.some((m) => canUnitReachEnemy(obs, m, enemy, false));
  }
  for (let i = 0; i < Math.min(members.length, 2); i++) {
    const m = members[i]!;
    if (canUnitReachEnemy(obs, m, enemy, true)) return true;
  }
  return false;
}

function getSquadCentroid(members: readonly ObservedOwnUnit[]): Point {
  if (members.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const m of members) {
    sx += m.x;
    sy += m.y;
  }
  return { x: sx / members.length, y: sy / members.length };
}

function getSquadAvgHpRatio(members: readonly ObservedOwnUnit[]): number {
  if (members.length === 0) return 1;
  let hp = 0;
  let maxHp = 0;
  for (const m of members) {
    hp += Math.max(0, m.hp);
    maxHp += Math.max(1, m.maxHp);
  }
  return maxHp > 0 ? hp / maxHp : 1;
}

function areMembersGrouped(members: readonly ObservedOwnUnit[], center: Point, radius: number): boolean {
  for (const m of members) {
    if (Math.hypot(m.x - center.x, m.y - center.y) > radius) return false;
  }
  return true;
}

function isEnemyAvailable(
  enemy: ObservedEnemy,
  failedTargets: Readonly<Record<number, FailedTargetRecord>>,
  turn: number,
): boolean {
  if (enemy.hp <= 0 || enemy.state >= ObjectState.Dying) return false;
  const failed = failedTargets[enemy.id];
  return !failed || failed.retryAfterTurn <= turn;
}

function getDefenseThreats(
  obs: BotObservation,
  anchor: Point,
  aliveBuildings: readonly ObservedOwnBuilding[],
  villagers: readonly ObservedOwnUnit[],
  failedTargets: Readonly<Record<number, FailedTargetRecord>>,
): ObservedEnemy[] {
  const threats: { enemy: ObservedEnemy; distScore: number }[] = [];

  for (const e of obs.knownEnemies) {
    if (!e.visibleNow || !isEnemyAvailable(e, failedTargets, obs.turn)) continue;

    let minVillagerDist = Infinity;
    for (const v of villagers) {
      const d = Math.hypot(e.x - v.x, e.y - v.y);
      if (d < minVillagerDist) minVillagerDist = d;
    }

    let minBuildingDist = Math.hypot(e.x - anchor.x, e.y - anchor.y);
    for (const b of aliveBuildings) {
      const d = Math.hypot(e.x - b.x, e.y - b.y);
      if (d < minBuildingDist) minBuildingDist = d;
    }

    if (minVillagerDist <= DEFENSE_VILLAGER_RADIUS || minBuildingDist <= DEFENSE_BASE_RADIUS) {
      const priorityBias = minVillagerDist <= DEFENSE_VILLAGER_RADIUS ? minVillagerDist : minBuildingDist + 5;
      const mobileBias = e.isBuilding ? 15 : 0;
      threats.push({ enemy: e, distScore: priorityBias + mobileBias });
    }
  }

  threats.sort((a, b) => a.distScore - b.distScore || a.enemy.id - b.enemy.id);
  return threats.map((t) => t.enemy);
}

function pickBestEnemyTarget(
  obs: BotObservation,
  members: readonly ObservedOwnUnit[],
  anchor: Point,
  failedTargets: Readonly<Record<number, FailedTargetRecord>>,
): ObservedEnemy | null {
  if (members.length === 0) return null;
  const centroid = getSquadCentroid(members);

  const candidates: { enemy: ObservedEnemy; score: number }[] = [];
  for (const e of obs.knownEnemies) {
    if (!isEnemyAvailable(e, failedTargets, obs.turn)) continue;
    if (!canSquadReachEnemy(obs, members, e, false)) continue;

    let score = 0;
    if (e.visibleNow) score += 200;
    if (Math.hypot(e.x - anchor.x, e.y - anchor.y) <= DEFENSE_BASE_RADIUS) score += 400;
    if (e.isMilitary) score += 120;
    else if (e.isVillager) score += 100;
    else if (e.type === TOWN_CENTER) score += 90;
    else if (e.isBuilding) score += 50;
    else score += 40;

    score -= Math.hypot(e.x - centroid.x, e.y - centroid.y) * 2;
    candidates.push({ enemy: e, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.enemy.id - b.enemy.id);

  const checkLimit = Math.min(candidates.length, 10);
  for (let i = 0; i < checkLimit; i++) {
    const cand = candidates[i]!.enemy;
    if (canSquadReachEnemy(obs, members, cand, true)) {
      return cand;
    }
  }
  return null;
}

function isOutnumberedByVisibleEnemies(
  obs: BotObservation,
  centroid: Point,
  squadSize: number,
): boolean {
  let nearbyVisibleMilitary = 0;
  for (const e of obs.knownEnemies) {
    if (!e.visibleNow || !e.isMilitary || e.hp <= 0 || e.state >= ObjectState.Dying) continue;
    if (Math.hypot(e.x - centroid.x, e.y - centroid.y) <= VISIBLE_OUTNUMBER_RADIUS) {
      nearbyVisibleMilitary++;
    }
  }
  return nearbyVisibleMilitary >= Math.max(2, squadSize * 2);
}

function getRecoveryExitHpRatio(profile: BotProfile): number {
  return Math.min(0.8, Math.max(0.4, profile.retreatHpRatio + 0.25));
}

function getRequiredSizeForRole(role: SquadRole, profile: BotProfile): number {
  if (role === 'defense' || role === 'scout') return 1;
  if (role === 'naval') return Math.min(2, profile.minAttackSquadSize);
  return profile.minAttackSquadSize;
}

function capOrderUnits(ids: readonly number[]): number[] {
  return ids.length <= MAX_ORDER_UNITS ? [...ids] : ids.slice(0, MAX_ORDER_UNITS);
}

export class SquadPlanner implements BotPlanner {
  readonly name = 'squads';
  private lastPlan: PlannedSnapshot | null = null;

  propose(input: PlannerInput): BotIntent[] {
    const { observation: obs, profile, state, pendingActions, seed } = input;
    const turn = obs.turn;
    const worldTime = obs.worldTime;

    const aliveMilitary = obs.ownUnits
      .filter(isOwnMilitaryAlive)
      .sort((a, b) => a.id - b.id);
    const militaryById = new Map<number, ObservedOwnUnit>(aliveMilitary.map((u) => [u.id, u]));
    const aliveBuildings = obs.ownBuildings.filter(isOwnBuildingAlive);
    const villagers = obs.ownUnits.filter(isOwnVillagerAlive);

    const anchor = getHomeAnchor(obs);
    const rallyPoint = clampPoint(obs, anchor.x, anchor.y);

    const reservedUnits = new Set<number>();
    for (const p of pendingActions) {
      if (p.status !== 'issued') continue;
      for (const uid of p.unitIds) reservedUnits.add(uid);
    }

    const isUnitAvailable = (u: ObservedOwnUnit): boolean =>
      !reservedUnits.has(u.id) && (state.unitCooldownUntil[u.id] ?? 0) <= turn;

    const failedTargetsView: Record<number, FailedTargetRecord> = {};
    for (const [rawId, rec] of Object.entries(state.failedTargets)) {
      if (rec.retryAfterTurn > turn) {
        failedTargetsView[Number(rawId)] = { ...rec };
      }
    }
    const newFailedTargetUpdates: Record<number, FailedTargetRecord> = {};
    const recordFailedTarget = (targetId: number): void => {
      const prev = failedTargetsView[targetId] ?? state.failedTargets[targetId];
      const nextRec: FailedTargetRecord = {
        count: (prev?.count ?? 0) + 1,
        retryAfterTurn: turn + SQUAD_FAILED_TARGET_BACKOFF_TURNS,
      };
      failedTargetsView[targetId] = nextRec;
      newFailedTargetUpdates[targetId] = nextRec;
    };

    const knownEnemyById = new Map<number, ObservedEnemy>(obs.knownEnemies.map((e) => [e.id, e]));

    // 1. Reconcile existing squads (strictly unique membership & domain purity)
    const clonedWithOrder = state.squads.map((s, idx) => ({ squad: cloneSquad(s), idx }));
    clonedWithOrder.sort(
      (a, b) =>
        squadDedupPriority(b.squad) - squadDedupPriority(a.squad) ||
        a.squad.id - b.squad.id ||
        a.idx - b.idx,
    );

    const assignedUnitIds = new Set<number>();
    const reconciledByOrigIdx: (SquadState | null)[] = new Array(clonedWithOrder.length).fill(null);

    for (const item of clonedWithOrder) {
      const s = item.squad;
      const isNavalRole = s.role === 'naval';
      const kept: number[] = [];
      for (const uid of s.memberIds) {
        const u = militaryById.get(uid);
        if (!u) continue;
        if (u.isNaval !== isNavalRole) continue;
        if (assignedUnitIds.has(uid)) continue;
        assignedUnitIds.add(uid);
        kept.push(uid);
      }
      if (kept.length > 0) {
        s.memberIds = kept;
        reconciledByOrigIdx[item.idx] = s;
      }
    }

    const workingSquads: SquadState[] = reconciledByOrigIdx.filter(
      (s): s is SquadState => s !== null,
    );

    let nextSeq = Math.max(1, state.nextSquadSeq);
    for (const s of workingSquads) {
      if (s.id >= nextSeq) nextSeq = s.id + 1;
    }

    // 2. Detect base / villager defense threats strictly from fog-filtered knownEnemies
    const defenseThreats = getDefenseThreats(
      obs,
      anchor,
      aliveBuildings,
      villagers,
      failedTargetsView,
    );

    // Clear defense role when all base threats are gone
    if (defenseThreats.length === 0) {
      for (const s of workingSquads) {
        if (s.role !== 'defense') continue;
        const members = s.memberIds.map((id) => militaryById.get(id)!);
        const avgHp = getSquadAvgHpRatio(members);
        if (avgHp <= profile.retreatHpRatio && profile.retreatHpRatio > 0) {
          s.phase = 'recovering';
          s.targetId = null;
          s.targetPos = rallyPoint;
          s.stuckSinceTurn = null;
        } else {
          s.role = 'assault';
          s.targetId = null;
          s.stuckSinceTurn = null;
          if (!profile.allowCounterAttack) {
            s.phase = 'forming';
            s.targetPos = rallyPoint;
          } else {
            s.phase = s.memberIds.length >= profile.minAttackSquadSize ? 'rallying' : 'forming';
            s.targetPos = rallyPoint;
          }
        }
      }
    }

    // 3. Assign unassigned military units respecting passability & maxSquads
    const unassignedLand = aliveMilitary.filter((u) => !u.isNaval && !assignedUnitIds.has(u.id));
    const unassignedNaval = aliveMilitary.filter((u) => u.isNaval && !assignedUnitIds.has(u.id));

    const maxSquadsCap = Math.max(1, profile.maxSquads);
    const idealWaveSize = Math.max(profile.minAttackSquadSize + 2, 6);
    const hasNavalSquad = workingSquads.some((s) => s.role === 'naval');
    const reservedNavalSlots = unassignedNaval.length > 0 && !hasNavalSquad && maxSquadsCap >= 2 ? 1 : 0;
    const landSquadCap = Math.max(1, maxSquadsCap - reservedNavalSlots);

    const canJoinSquadReach = (u: ObservedOwnUnit, s: SquadState): boolean => {
      const repId = s.memberIds[0];
      if (repId === undefined) return false;
      const rep = militaryById.get(repId);
      if (!rep) return false;
      if (!obs.canReach(u.id, rep.x, rep.y, 4.0, false)) return false;
      if (s.phase === 'attacking' && s.targetId !== null) {
        const t = knownEnemyById.get(s.targetId);
        if (t && !canUnitReachEnemy(obs, u, t, false)) return false;
      }
      return true;
    };

    for (const u of unassignedLand) {
      let joined: SquadState | undefined;

      // Prefer joining existing defense squad if threat exists
      if (defenseThreats.length > 0) {
        joined = workingSquads.find(
          (s) => s.role === 'defense' && canJoinSquadReach(u, s),
        );
      }

      // Join non-full forming/rallying/recovering land squad
      if (!joined) {
        joined = workingSquads.find(
          (s) =>
            s.role !== 'naval' &&
            s.role !== 'scout' &&
            (s.phase === 'forming' || s.phase === 'rallying' || s.phase === 'recovering') &&
            s.memberIds.length < idealWaveSize &&
            canJoinSquadReach(u, s),
        );
      }

      // Reinforce under-sized attacking squad (or any compatible when at maxSquads) WITHOUT resetting its phase!
      if (!joined) {
        const wantNewWaveSlot = workingSquads.length < maxSquadsCap;
        joined = workingSquads.find(
          (s) =>
            s.role !== 'naval' &&
            s.role !== 'scout' &&
            s.phase === 'attacking' &&
            (!wantNewWaveSlot || s.memberIds.length < profile.minAttackSquadSize + 2) &&
            canJoinSquadReach(u, s),
        );
      }

      if (joined) {
        joined.memberIds.push(u.id);
        assignedUnitIds.add(u.id);
        continue;
      }

      if (workingSquads.length < landSquadCap) {
        const hasScout = workingSquads.some((s) => s.role === 'scout');
        const noReachableEnemyYet = !obs.knownEnemies.some(
          (e) => isEnemyAvailable(e, failedTargetsView, turn) && canUnitReachEnemy(obs, u, e, false),
        );
        const chooseScout =
          defenseThreats.length === 0 &&
          !hasScout &&
          (u.type === SCOUT_UNIT_TYPE ||
            (noReachableEnemyYet &&
              workingSquads.length === 0 &&
              unassignedLand.length === 1 &&
              profile.minAttackSquadSize > 1));

        const initialRole: SquadRole = chooseScout ? 'scout' : 'assault';
        const created: SquadState = {
          id: nextSeq++,
          role: initialRole,
          phase: 'forming',
          memberIds: [u.id],
          targetId: null,
          targetPos: rallyPoint,
          lastOrderTurn: -1,
          lastOrderTime: -1,
          stuckSinceTurn: null,
        };
        workingSquads.push(created);
        assignedUnitIds.add(u.id);
        continue;
      }

      // At maxSquads cap: join any reachable land squad without changing its phase
      const fallback = workingSquads.find((s) => s.role !== 'naval' && canJoinSquadReach(u, s));
      if (fallback) {
        fallback.memberIds.push(u.id);
        assignedUnitIds.add(u.id);
      }
    }

    for (const u of unassignedNaval) {
      const joinedNaval = workingSquads.find(
        (s) => s.role === 'naval' && canJoinSquadReach(u, s),
      );
      if (joinedNaval) {
        joinedNaval.memberIds.push(u.id);
        assignedUnitIds.add(u.id);
        continue;
      }
      if (workingSquads.length < maxSquadsCap) {
        workingSquads.push({
          id: nextSeq++,
          role: 'naval',
          phase: 'forming',
          memberIds: [u.id],
          targetId: null,
          targetPos: { x: u.x, y: u.y },
          lastOrderTurn: -1,
          lastOrderTime: -1,
          stuckSinceTurn: null,
        });
        assignedUnitIds.add(u.id);
      }
    }

    // Check if an existing land squad should be flagged for defense preemption
    let preemptDefenseSquadId: number | null = null;
    if (defenseThreats.length > 0) {
      const existingDefense = workingSquads.find((s) => {
        if (s.role !== 'defense') return false;
        const members = s.memberIds.map((id) => militaryById.get(id)!);
        return defenseThreats.some((t) => canSquadReachEnemy(obs, members, t, false));
      });

      if (!existingDefense) {
        const landCandidates = workingSquads.filter((s) => {
          if (s.role === 'naval' || s.phase === 'retreating') return false;
          const members = s.memberIds.map((id) => militaryById.get(id)!);
          return defenseThreats.some((t) => canSquadReachEnemy(obs, members, t, false));
        });
        landCandidates.sort((a, b) => {
          const rank = (s: SquadState): number => {
            if (s.phase === 'forming') return 0;
            if (s.phase === 'rallying') return 1;
            if (s.role === 'scout') return 2;
            if (s.phase === 'recovering') return 3;
            return 4;
          };
          return rank(a) - rank(b) || b.memberIds.length - a.memberIds.length || a.id - b.id;
        });
        if (landCandidates.length > 0) {
          preemptDefenseSquadId = landCandidates[0]!.id;
        }
      }
    }

    // 4. Evaluate phase logic and propose BotIntents (never mutating input.state!)
    const intents: BotIntent[] = [];
    const commandCommits = new Map<string, CommandCommitSpec>();

    const addAttackIntent = (
      s: SquadState,
      orderUnits: readonly ObservedOwnUnit[],
      target: ObservedEnemy,
      priority: number,
      nextRole: SquadRole,
      reason: string,
    ): void => {
      if (orderUnits.length === 0) return;
      const unitIds = capOrderUnits(orderUnits.map((u) => u.id));
      const key = `squad:${s.id}:attack:${target.id}`;
      intents.push({
        key,
        priority,
        reason,
        unitIds,
        command: { type: 'attack', units: unitIds, target: target.id },
      });
      commandCommits.set(key, {
        squadId: s.id,
        role: nextRole,
        phase: 'attacking',
        targetId: target.id,
        targetPos: { x: target.x, y: target.y },
        unitIds,
        clearStuck: true,
      });
    };

    const addMoveIntent = (
      s: SquadState,
      orderUnits: readonly ObservedOwnUnit[],
      dest: Point,
      kind: 'rally' | 'retreat' | 'scout',
      priority: number,
      nextPhase: SquadPhase,
      reason: string,
    ): void => {
      if (orderUnits.length === 0) return;
      const unitIds = capOrderUnits(orderUnits.map((u) => u.id));
      const rx = Math.round(dest.x * 10) / 10;
      const ry = Math.round(dest.y * 10) / 10;
      const key = `squad:${s.id}:${kind}:${rx}:${ry}`;
      intents.push({
        key,
        priority,
        reason,
        unitIds,
        command: { type: 'move', units: unitIds, x: dest.x, y: dest.y },
      });
      commandCommits.set(key, {
        squadId: s.id,
        role: s.role,
        phase: nextPhase,
        targetId: null,
        targetPos: { x: dest.x, y: dest.y },
        unitIds,
        clearStuck: true,
      });
    };

    for (const s of workingSquads) {
      const members = s.memberIds.map((id) => militaryById.get(id)!);
      if (members.length === 0) continue;

      const centroid = getSquadCentroid(members);
      const avgHpRatio = getSquadAvgHpRatio(members);
      const isNaval = s.role === 'naval';
      const minSize = getRequiredSizeForRole(s.role, profile);
      const hasPending = members.some((m) => reservedUnits.has(m.id));
      const availableMembers = members.filter(isUnitAvailable);
      const safeHome = isNaval ? getNavalAnchor(obs, members) : rallyPoint;
      const distFromHome = Math.hypot(centroid.x - safeHome.x, centroid.y - safeHome.y);

      // A. Defense preemption when threat exists
      const wantsDefense =
        !isNaval &&
        defenseThreats.length > 0 &&
        (s.role === 'defense' || s.id === preemptDefenseSquadId);

      if (wantsDefense) {
        const currentTarget = s.targetId !== null ? knownEnemyById.get(s.targetId) : undefined;
        const currentThreatValid =
          currentTarget !== undefined &&
          defenseThreats.some((t) => t.id === currentTarget.id) &&
          canSquadReachEnemy(obs, members, currentTarget, false);

        if (s.role === 'defense' && s.phase === 'attacking' && currentThreatValid && currentTarget) {
          // Keep valid actively engaged defenders undisturbed!
          const anyEngaged = members.some(
            (m) => m.isActivelyEngaged && m.attackTarget === currentTarget.id,
          );
          const anyMoving = members.some((m) => m.isMoving);
          if (anyEngaged || anyMoving || hasPending) {
            s.stuckSinceTurn = null;
            // Only send idle reinforcements (e.g. newly arrived unit) without interrupting engaged defenders
            if (turn - s.lastOrderTurn >= COMMAND_DELAY_TURNS + 1) {
              const idleJoiners = availableMembers.filter(
                (m) => !m.isActivelyEngaged && !m.isMoving,
              );
              if (idleJoiners.length > 0) {
                addAttackIntent(
                  s,
                  idleJoiners,
                  currentTarget,
                  PRIORITY_DEFENSE_ATTACK,
                  'defense',
                  'Reinforce defense squad against base threat',
                );
              }
            }
            continue;
          }

          if (s.stuckSinceTurn === null) {
            if (turn > s.lastOrderTurn + COMMAND_DELAY_TURNS) {
              s.stuckSinceTurn = turn;
            }
            continue;
          }

          if (turn - s.stuckSinceTurn >= SQUAD_STUCK_TIMEOUT_TURNS) {
            if (!canSquadReachEnemy(obs, members, currentTarget, true)) {
              recordFailedTarget(currentTarget.id);
              s.targetId = null;
            } else if (
              turn - s.lastOrderTurn >= SQUAD_REORDER_COOLDOWN_TURNS &&
              availableMembers.length > 0
            ) {
              addAttackIntent(
                s,
                availableMembers,
                currentTarget,
                PRIORITY_DEFENSE_ATTACK,
                'defense',
                'Reissue defense attack after stuck timeout',
              );
              continue;
            }
          } else {
            continue;
          }
        }

        // Acquire reachable defense threat
        let chosenThreat: ObservedEnemy | null = null;
        for (const t of defenseThreats) {
          if (canSquadReachEnemy(obs, members, t, true)) {
            chosenThreat = t;
            break;
          }
        }
        if (chosenThreat) {
          // Preserve any members already actively engaged on a valid nearby threat
          const nonEngaged = availableMembers.filter(
            (m) => !(m.isActivelyEngaged && m.attackTarget !== null && defenseThreats.some((t) => t.id === m.attackTarget)),
          );
          addAttackIntent(
            s,
            nonEngaged,
            chosenThreat,
            PRIORITY_DEFENSE_ATTACK,
            'defense',
            'Defend base/villagers against nearby enemy',
          );
          continue;
        }
      }

      // B. Retreat check for attacking combat squads (never peek fog, always transitions through retreating -> recovering)
      if (s.phase === 'attacking' && s.role !== 'scout') {
        const lowHp = profile.retreatHpRatio > 0 && avgHpRatio <= profile.retreatHpRatio;
        const overwhelmed =
          avgHpRatio < 0.6 && isOutnumberedByVisibleEnemies(obs, centroid, members.length);

        if (lowHp || overwhelmed) {
          if (distFromHome <= RETREAT_ARRIVE_RADIUS) {
            // Already at safe home: enter recovering directly instead of useless move spam
            s.phase = 'recovering';
            s.targetId = null;
            s.targetPos = safeHome;
            s.lastOrderTurn = turn;
            s.lastOrderTime = worldTime;
            s.stuckSinceTurn = null;
            continue;
          }

          if (
            availableMembers.length > 0 &&
            obs.canReach(availableMembers[0]!.id, safeHome.x, safeHome.y, RETREAT_ARRIVE_RADIUS, false)
          ) {
            addMoveIntent(
              s,
              availableMembers,
              safeHome,
              'retreat',
              PRIORITY_RETREAT,
              'retreating',
              'Retreat wounded/outnumbered squad to safe home anchor',
            );
            continue;
          }
        }
      }

      // C. Phase state machine
      if (s.phase === 'retreating') {
        const dest = s.targetPos ?? safeHome;
        const arrived = Math.hypot(centroid.x - dest.x, centroid.y - dest.y) <= RETREAT_ARRIVE_RADIUS;
        const stoppedMoving =
          turn - s.lastOrderTurn >= COMMAND_DELAY_TURNS + 2 &&
          !hasPending &&
          members.every((m) => !m.isMoving);
        const timedOut = turn - s.lastOrderTurn >= RETREAT_TIMEOUT_TURNS;

        if (arrived || stoppedMoving || timedOut) {
          s.phase = 'recovering';
          s.targetId = null;
          s.targetPos = dest;
          s.lastOrderTurn = turn;
          s.lastOrderTime = worldTime;
          s.stuckSinceTurn = null;
          continue;
        }

        if (
          turn - s.lastOrderTurn >= SQUAD_REORDER_COOLDOWN_TURNS &&
          !hasPending &&
          members.every((m) => !m.isMoving) &&
          availableMembers.length > 0
        ) {
          addMoveIntent(
            s,
            availableMembers,
            dest,
            'retreat',
            PRIORITY_RETREAT,
            'retreating',
            'Resume retreat move to safe anchor',
          );
        }
        continue;
      }

      if (s.phase === 'recovering') {
        const dwellMet = turn - s.lastOrderTurn >= MIN_RECOVER_TURNS;
        const exitRatio = getRecoveryExitHpRatio(profile);
        if (dwellMet && avgHpRatio >= exitRatio) {
          s.phase = members.length >= minSize ? 'rallying' : 'forming';
          s.targetId = null;
          s.targetPos = safeHome;
          s.stuckSinceTurn = null;
        }
        continue;
      }

      if (s.phase === 'forming') {
        const reorderReady =
          s.lastOrderTurn < 0 || turn - s.lastOrderTurn >= SQUAD_REORDER_COOLDOWN_TURNS;

        if (s.role === 'scout') {
          if (
            obs.knownEnemies.length > 0 &&
            members.length >= profile.minAttackSquadSize &&
            pickBestEnemyTarget(obs, members, anchor, failedTargetsView)
          ) {
            s.role = 'assault';
          } else {
            if (
              !hasPending &&
              availableMembers.length > 0 &&
              reorderReady &&
              members.every((m) => !m.isMoving && !m.isActivelyEngaged)
            ) {
              const exploreDest = obs.findNearestExploreTarget(
                availableMembers[0]!.id,
                seed + s.id + turn,
              );
              if (exploreDest) {
                addMoveIntent(
                  s,
                  availableMembers,
                  exploreDest,
                  'scout',
                  PRIORITY_SCOUT_MOVE,
                  'rallying',
                  'Scout unexplored reachable tiles',
                );
              }
            }
            continue;
          }
        }

        if (members.length < minSize) {
          // If no reachable enemies are known yet and squad is still forming, optionally explore nearby if all idle
          const hasReachableEnemy = obs.knownEnemies.some(
            (e) => isEnemyAvailable(e, failedTargetsView, turn) && canSquadReachEnemy(obs, members, e, false),
          );
          if (
            !hasReachableEnemy &&
            !hasPending &&
            availableMembers.length > 0 &&
            reorderReady &&
            members.every((m) => !m.isMoving && !m.isActivelyEngaged) &&
            !workingSquads.some((other) => other.id !== s.id && other.role === 'scout')
          ) {
            const scoutCandidate = availableMembers[0]!;
            const exploreDest = obs.findNearestExploreTarget(
              scoutCandidate.id,
              seed + s.id + turn,
            );
            if (exploreDest) {
              addMoveIntent(
                s,
                [scoutCandidate],
                exploreDest,
                'scout',
                PRIORITY_SCOUT_MOVE,
                'forming',
                'Explore fog while forming squad',
              );
            }
          }
          continue;
        }

        // Enough members formed
        const grouped = areMembersGrouped(members, centroid, RALLY_GROUP_RADIUS);
        const target = pickBestEnemyTarget(obs, members, anchor, failedTargetsView);

        if (grouped && target && availableMembers.length > 0) {
          addAttackIntent(
            s,
            availableMembers,
            target,
            PRIORITY_ASSAULT_ATTACK,
            s.role,
            'Launch attack wave on reachable enemy',
          );
        } else if (!grouped && availableMembers.length > 0 && !hasPending) {
          const rallyDest = isNaval ? safeHome : rallyPoint;
          addMoveIntent(
            s,
            availableMembers,
            rallyDest,
            'rally',
            PRIORITY_RALLY_MOVE,
            'rallying',
            'Rally formed squad before attack',
          );
        } else if (
          grouped &&
          !target &&
          !hasPending &&
          availableMembers.length > 0 &&
          reorderReady &&
          members.every((m) => !m.isMoving && !m.isActivelyEngaged)
        ) {
          const exploreDest = obs.findNearestExploreTarget(
            availableMembers[0]!.id,
            seed + s.id + turn,
          );
          if (exploreDest) {
            addMoveIntent(
              s,
              [availableMembers[0]!],
              exploreDest,
              'scout',
              PRIORITY_SCOUT_MOVE,
              'forming',
              'Fallback scout when no reachable enemy is known',
            );
          }
        }
        continue;
      }

      if (s.phase === 'rallying') {
        const reorderReady =
          s.lastOrderTurn < 0 || turn - s.lastOrderTurn >= SQUAD_REORDER_COOLDOWN_TURNS;

        if (s.role === 'scout') {
          const moving = members.some((m) => m.isMoving);
          if (moving || hasPending) continue;
          if (s.lastOrderTurn >= 0 && turn - s.lastOrderTurn < COMMAND_DELAY_TURNS + 2) continue;
          const exploreDest =
            availableMembers.length > 0
              ? obs.findNearestExploreTarget(availableMembers[0]!.id, seed + s.id + turn)
              : null;
          if (exploreDest && availableMembers.length > 0) {
            addMoveIntent(
              s,
              availableMembers,
              exploreDest,
              'scout',
              PRIORITY_SCOUT_MOVE,
              'rallying',
              'Continue scouting unexplored reachable tiles',
            );
          } else {
            s.phase = 'forming';
            s.targetPos = safeHome;
          }
          continue;
        }

        if (members.length < minSize) {
          s.phase = 'forming';
          s.stuckSinceTurn = null;
          continue;
        }

        const rallyDest = s.targetPos ?? safeHome;
        const grouped =
          areMembersGrouped(members, centroid, RALLY_GROUP_RADIUS) ||
          areMembersGrouped(members, rallyDest, RALLY_ARRIVE_RADIUS) ||
          (s.lastOrderTurn >= 0 && turn - s.lastOrderTurn >= RALLY_TIMEOUT_TURNS);

        const target = pickBestEnemyTarget(obs, members, anchor, failedTargetsView);
        if (grouped && target && availableMembers.length > 0) {
          addAttackIntent(
            s,
            availableMembers,
            target,
            PRIORITY_ASSAULT_ATTACK,
            s.role,
            'Attack reachable enemy after rally',
          );
        } else if (!grouped && !hasPending && availableMembers.length > 0) {
          const stragglers = availableMembers.filter(
            (m) =>
              !m.isMoving &&
              Math.hypot(m.x - rallyDest.x, m.y - rallyDest.y) > RALLY_ARRIVE_RADIUS,
          );
          if (stragglers.length > 0 && reorderReady) {
            addMoveIntent(
              s,
              stragglers,
              rallyDest,
              'rally',
              PRIORITY_RALLY_MOVE,
              'rallying',
              'Gather stragglers at squad rally point',
            );
          }
        } else if (
          grouped &&
          !target &&
          !hasPending &&
          availableMembers.length > 0 &&
          reorderReady &&
          members.every((m) => !m.isMoving && !m.isActivelyEngaged)
        ) {
          const exploreDest = obs.findNearestExploreTarget(
            availableMembers[0]!.id,
            seed + s.id + turn,
          );
          if (exploreDest) {
            addMoveIntent(
              s,
              [availableMembers[0]!],
              exploreDest,
              'scout',
              PRIORITY_SCOUT_MOVE,
              'rallying',
              'Explore fog when rallied squad has no reachable target',
            );
          }
        }
        continue;
      }

      if (s.phase === 'attacking') {
        const currentTarget = s.targetId !== null ? knownEnemyById.get(s.targetId) : undefined;
        const targetZoneValid =
          currentTarget !== undefined &&
          isEnemyAvailable(currentTarget, failedTargetsView, turn) &&
          canSquadReachEnemy(obs, members, currentTarget, false);

        if (targetZoneValid && currentTarget) {
          const anyEngagedOnTarget = members.some(
            (m) => m.isActivelyEngaged && m.attackTarget === currentTarget.id,
          );
          const anyMoving = members.some((m) => m.isMoving);

          if (anyEngagedOnTarget || anyMoving || hasPending) {
            s.stuckSinceTurn = null;
            // Reinforce ONLY idle newcomers without re-ordering already-engaged units!
            if (turn - s.lastOrderTurn >= COMMAND_DELAY_TURNS + 1) {
              const idleReinforcements = availableMembers.filter(
                (m) => !m.isActivelyEngaged && !m.isMoving,
              );
              if (idleReinforcements.length > 0) {
                addAttackIntent(
                  s,
                  idleReinforcements,
                  currentTarget,
                  s.role === 'defense' ? PRIORITY_DEFENSE_ATTACK : PRIORITY_ASSAULT_ATTACK,
                  s.role,
                  'Send idle squad reinforcements to current target',
                );
              }
            }
            continue;
          }

          // No unit is engaged or moving and no pending command exists -> track stuck timeout
          if (s.stuckSinceTurn === null) {
            if (turn > s.lastOrderTurn + COMMAND_DELAY_TURNS) {
              s.stuckSinceTurn = turn;
            }
            continue;
          }

          if (turn - s.stuckSinceTurn < SQUAD_STUCK_TIMEOUT_TURNS) {
            continue;
          }

          // Stuck timeout reached: check dynamic path to current target
          if (canSquadReachEnemy(obs, members, currentTarget, true)) {
            if (
              turn - s.lastOrderTurn >= SQUAD_REORDER_COOLDOWN_TURNS &&
              availableMembers.length > 0
            ) {
              addAttackIntent(
                s,
                availableMembers,
                currentTarget,
                s.role === 'defense' ? PRIORITY_DEFENSE_ATTACK : PRIORITY_ASSAULT_ATTACK,
                s.role,
                'Reissue attack after stuck timeout',
              );
              continue;
            }
            continue;
          } else {
            // Dynamically unreachable (e.g. walled off): back off and replan
            recordFailedTarget(currentTarget.id);
          }
        }

        // Current target is invalid / dead / vanished into fog / unreachable -> replan
        const nextTarget = pickBestEnemyTarget(obs, members, anchor, failedTargetsView);
        if (nextTarget && availableMembers.length > 0) {
          addAttackIntent(
            s,
            availableMembers,
            nextTarget,
            s.role === 'defense' ? PRIORITY_DEFENSE_ATTACK : PRIORITY_ASSAULT_ATTACK,
            s.role,
            'Switch squad to next valid reachable enemy',
          );
          continue;
        }

        // No reachable enemy target remains -> exit attacking cleanly (no fog leak)
        s.targetId = null;
        s.targetPos = safeHome;
        s.stuckSinceTurn = null;
        s.phase = members.length >= minSize ? 'rallying' : 'forming';
      }
    }

    this.lastPlan = {
      turn,
      player: obs.player,
      baseSquads: workingSquads,
      nextSquadSeq: nextSeq,
      failedTargetUpdates: newFailedTargetUpdates,
      commandCommits,
    };

    return intents;
  }

  commit(outcomes: Readonly<Record<string, IntentOutcome>>, input: PlannerInput): void {
    const { observation: obs, state } = input;
    const turn = obs.turn;
    const worldTime = obs.worldTime;

    // Prune expired cooldowns & failed-target backoffs
    for (const [id, until] of Object.entries(state.unitCooldownUntil)) {
      if (until <= turn) delete state.unitCooldownUntil[Number(id)];
    }
    for (const [id, rec] of Object.entries(state.failedTargets)) {
      if (rec.retryAfterTurn <= turn) delete state.failedTargets[Number(id)];
    }

    const plan = this.lastPlan;
    this.lastPlan = null;

    if (!plan || plan.turn !== turn || plan.player !== obs.player) {
      return;
    }

    // Apply observation-driven state updates
    for (const [rawId, rec] of Object.entries(plan.failedTargetUpdates)) {
      state.failedTargets[Number(rawId)] = { ...rec };
    }

    const committedSquads = plan.baseSquads.map(cloneSquad);
    const squadById = new Map<number, SquadState>(committedSquads.map((s) => [s.id, s]));

    // Apply command-dependent state ONLY for arbiter-accepted intents (`B05`)
    for (const [key, spec] of plan.commandCommits.entries()) {
      const outcome = outcomes[key];
      if (!outcome?.accepted) continue;

      const squad = squadById.get(spec.squadId);
      if (squad) {
        squad.role = spec.role;
        squad.phase = spec.phase;
        squad.targetId = spec.targetId;
        squad.targetPos = spec.targetPos ? { ...spec.targetPos } : null;
        squad.lastOrderTurn = turn;
        squad.lastOrderTime = worldTime;
        if (spec.clearStuck) {
          squad.stuckSinceTurn = null;
        }
      }

      const cooldownTurn = turn + SQUAD_ORDER_COOLDOWN_TURNS;
      for (const uid of spec.unitIds) {
        state.unitCooldownUntil[uid] = Math.max(
          state.unitCooldownUntil[uid] ?? 0,
          cooldownTurn,
        );
      }
    }

    state.squads = committedSquads;
    state.nextSquadSeq = plan.nextSquadSeq;
  }
}

export function createSquadPlanner(): SquadPlanner {
  return new SquadPlanner();
}
