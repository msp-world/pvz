/**
 * 《植物大战僵尸》原版内存桥接 MSP World（移植自 cortico-world-pvz）：
 * - 工具：pvz_observe, pvz_do, pvz_stop
 * - 信号：pvz.state, pvz.task, pvz.wave
 */
import type { MSPNode } from "../shared/msp.ts";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export class PvzWorld {
  private readonly bridgeUrl: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: FetchImpl;
  private node: MSPNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWave = -1;
  private lastScreen = "";

  constructor(config: { bridgeUrl?: string; pollIntervalMs?: number } = {}, fetchImpl?: FetchImpl) {
    this.bridgeUrl = (config.bridgeUrl ?? "http://127.0.0.1:17750").replace(/\/+$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 1200;
    this.fetchImpl = fetchImpl ?? ((u, i) => fetch(u, i));
  }

  attach(node: MSPNode): void {
    this.node = node;
    node.declareSignal("pvz.state", "PvZ 界面或棋盘状态变化");
    node.declareSignal("pvz.task", "PvZ 动作队列回执");
    node.declareSignal("pvz.wave", "PvZ 尸潮波次推进");

    node.tool(
      "pvz_observe",
      "读取当前 PvZ 界面、可见棋盘、卡片、阳光、关卡进度与任务队列",
      async (args) => {
        const detail = args.detail === "full" ? "full" : "summary";
        const res = await this.fetchImpl(`${this.bridgeUrl}/observe?detail=${detail}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`PvZ bridge HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      },
      { type: "object", properties: { detail: { type: "string", enum: ["summary", "full"], default: "summary" } } },
    );

    node.tool(
      "pvz_do",
      "提交有序 PvZ 动作队列（选卡/种植/铲除/收集阳光/砸罐等）",
      async (args) => {
        const res = await this.fetchImpl(`${this.bridgeUrl}/do`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`PvZ bridge HTTP ${res.status}`);
        const out = (await res.json()) as Record<string, unknown>;
        this.node?.publish("pvz.task", out);
        return out;
      },
      {
        type: "object",
        required: ["steps"],
        properties: { steps: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 64 } },
      },
    );

    node.tool(
      "pvz_stop",
      "清空当前 PvZ 动作队列",
      async () => {
        const res = await this.fetchImpl(`${this.bridgeUrl}/stop`, { method: "POST", signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`PvZ bridge HTTP ${res.status}`);
        return (await res.json()) as Record<string, unknown>;
      },
      { type: "object", additionalProperties: false, properties: {} },
    );

    node.skill({
      name: "observe_then_do",
      summary: "先观察阳光/卡片冷却/棋盘僵尸，再按顺序排入种植/铲除动作队列",
      whenToUse: "关卡战斗中需要布局植物、收集阳光或应对突发僵尸波次时使用",
      toolsUsed: ["pvz_observe", "pvz_do", "pvz_stop"],
    });
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => void this.pollOnce(), this.pollIntervalMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.bridgeUrl}/observe?detail=summary`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, unknown>;
      const screen = String(data.screen ?? "");
      if (screen && screen !== this.lastScreen) {
        this.lastScreen = screen;
        this.node?.publish("pvz.state", data);
      }
      if (typeof data.wave === "number" && data.wave !== this.lastWave) {
        this.lastWave = data.wave;
        this.node?.publish("pvz.wave", { wave: data.wave, totalWaves: data.totalWaves ?? null, sun: data.sun ?? null });
      }
    } catch {
      /* ignore offline */
    }
  }
}
