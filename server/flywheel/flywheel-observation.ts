/**
 * 飞轮 Observation 聚合层（self-evolution-loop.md 的观测层）——
 * 把两路独立信号聚合成一次调用可读的「演化观测」：
 *  - experience：客观验证器轨迹的全局通过率/失败原因码（信号源）；
 *  - evolution：进化 worker 的运行状态/就绪候选/门槛通过率（演化动作本身）。
 *
 * 设计约束：
 *  - 纯只读聚合，不写任何数据；
 *  - 单路失败/未配置只标记 unavailable，不拖垮整个观测（运营面要尽量可看）；
 *  - 低敏：全部复用各 store 已脱敏的聚合口径，不引入任何新明细。
 */
import { getExperienceOverview, type ExperienceOverview } from './experience-central-store.js';
import {
  ensureEvolutionSchema,
  getEvolutionOverview,
  type EvolutionOverview,
  type EvolutionPool,
} from '../evolution/evolution-store.js';

type SourceStatus = 'ok' | 'not_configured' | 'unavailable';

export interface FlywheelObservation {
  windowDays: number;
  generatedAt: string;
  experience: { status: SourceStatus; overview?: ExperienceOverview };
  evolution: { status: SourceStatus; overview?: EvolutionOverview };
}

function centralDbUrl(): string {
  return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}

let evolutionPoolReady: Promise<EvolutionPool> | null = null;
async function evolutionPool(): Promise<EvolutionPool> {
  if (!centralDbUrl()) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  if (!evolutionPoolReady) {
    evolutionPoolReady = (async () => {
      const pgMod = await import('pg' as string);
      const PgPool = (pgMod as { default?: { Pool: new (cfg: unknown) => EvolutionPool } }).default
        ?.Pool;
      if (!PgPool) throw new Error('pg 模块不可用');
      return new PgPool({ connectionString: centralDbUrl(), max: 2 });
    })().catch((error) => {
      evolutionPoolReady = null;
      throw error;
    });
  }
  return evolutionPoolReady;
}

/** 聚合一次飞轮观测。每路独立容错：单路异常只降级为 unavailable。 */
export async function getFlywheelObservation(days = 7): Promise<FlywheelObservation> {
  const windowDays = Math.min(Math.max(Math.floor(days) || 7, 1), 90);
  const observation: FlywheelObservation = {
    windowDays,
    generatedAt: new Date().toISOString(),
    experience: { status: 'unavailable' },
    evolution: { status: 'unavailable' },
  };

  const [experience, evolution] = await Promise.allSettled([
    getExperienceOverview(windowDays),
    (async () => {
      if (!centralDbUrl()) return null;
      const p = await evolutionPool();
      await ensureEvolutionSchema(p);
      return getEvolutionOverview(p);
    })(),
  ]);

  if (experience.status === 'fulfilled') {
    observation.experience = experience.value.configured
      ? { status: 'ok', overview: experience.value }
      : { status: 'not_configured' };
  }
  if (evolution.status === 'fulfilled') {
    observation.evolution = evolution.value
      ? { status: 'ok', overview: evolution.value }
      : { status: 'not_configured' };
  }
  return observation;
}
