import d = require("debug");
import { EventEmitter } from "events";
import * as Redis from "ioredis";
import _ = require("lodash");
import { throttle } from "lodash-decorators";
import RedisPRCNode from "./redis-rpc";
import { generateId } from "./utils";

const debug = d("RLB");

export interface IConsumer<T, U> extends EventEmitter {
  getLoad(): number;
  consume(params: T): Promise<U>;
  close(): Promise<any>;
}

/**
 * 基于 Redis 的负载均衡客户端。
 * 每个客户端都需要负责接受请求与处理请求。
 * 请求会被转发给负载最低的实例处理。
 */
export class RedisLoadBalancer<T, U> extends EventEmitter {
  /**
   * 标记是否在线。在离线状态下，客户端会直接处理收到的请求。
   */
  public get online() {
    return this._online;
  }
  public set online(value) {
    if (value !== this._online) {
      debug(`going ${value ? "online" : "offline"}`);
      this._online = value;
      this.emit(value ? "online" : "offline");
    }
  }
  public open = true;
  public id = generateId(5);
  public loads: { [key: string]: number } = {};
  // tslint:disable-next-line:variable-name
  private _online?: boolean;

  private redis: Redis.Redis;
  private redisPrefix: string;
  private redisKey: string;
  private reportInterval: number;
  private reportIntervalTimer?: NodeJS.Timer;

  private redisPRCNode: RedisPRCNode<T, U>;

  /**
   * @param consumer 负责处理请求的消费者实例，consumer 通过派发 LOAD_CHANGE 事件通知 RedisLoadBalancer 其负载的变化。
   * @param redisUrl
   * @param poolId consumer 池的标识，用于不同的 RedisLoadBalancer 共享一个 Redis。
   * @param reportInterval 上报本地 consumer load 时间间隔，单位毫秒。
   */
  constructor(
    private consumer: IConsumer<T, U>,
    redisUrl?: string,
    { poolId = "global", reportInterval = 30000 } = {},
  ) {
    super();

    debug(`connect to redis: ${redisUrl}`);
    this.redis = new Redis(redisUrl);
    this.redis
      .on("error", (error) => {
        debug(`redis error: ${error}`);
        if (error.code === "ECONNREFUSED") {
          this.online = false;
        }
      })
      .on("connect", () => {
        debug(`redis connected`);
        this.online = true;
      });
    this.redisPrefix = `RDB:${poolId}`;
    this.redisKey = `${this.redisPrefix}:${this.id}`;

    this.reportInterval = reportInterval;

    consumer.on(RedisLoadBalancerConsumerEvent.LOAD_CHANGE, () => this.reportLoad());
    this.fetchLoads();
    this.reportLoad();

    this.redisPRCNode = new RedisPRCNode(
      this.id,
      (params) => this.consumer.consume(params),
      redisUrl,
      {
        poolId,
        pubClient: this.redis,
      },
    );
  }

  public getStatus() {
    return _.pick(this, ["id", "loads", "online", "open"]);
  }

  public async close() {
    // 停止接受新的请求
    this.open = false;
    this.redis.del(this.redisKey);
    this.redisPRCNode.diconnect();
    return this.consumer.close();
  }

  /**
   * 处理请求
   */
  public async consume(params: T) {
    if (!this.open) {
      throw new Error("RedisLoadBalancer closed.");
    }
    if (!this.online) {
      // offline 时，直接将请求转发给 local consumer
      debug("offline. consume locally.");
      return this.consumer.consume(params);
    } else {
      // 找到负载最低的实例
      const [instanceId, load] = await this.getLowestLoadInfo();
      const localLoad = this.consumer.getLoad();
      debug("current load %O, remote loads: %O", localLoad, this.loads);
      if (load === localLoad) {
        // 自己就是负载最低的实例
        return this.consumer.consume(params);
      }
      try {
        return await this.redisPRCNode.call(instanceId, params);
      } catch (error) {
        console.warn(
          `RPC call ${instanceId} failed: ${
            error.message
          }. Fallback to local consumer`,
        );
        return this.consumer.consume(params);
      }
    }
  }

  /**
   * 获取负载最低的实例与其负载
   * @return 实例 id 与其负载
   */
  private async getLowestLoadInfo() {
    await this.fetchLoads();
    const loads = { ...this.loads, [this.id]: this.consumer.getLoad() };
    return _(loads)
      .toPairs()
      .minBy(([id, load]) => load)!;
  }

  /**
   * 从 Redis 获取各实例的负载
   */
  @throttle(1000)
  private async fetchLoads() {
    const keys = await this.redis.keys(`${this.redisPrefix}:*`);
    if (!keys.length) {
      // mget 需要至少一个参数
      return {};
    }
    const loads: Array<string | null> = await this.redis.mget(...keys);
    this.loads = loads.filter(_.isString).reduce(
      (result, load, index) => ({
        ...result,
        [keys[index].split(":").pop()!]: Number(load),
      }),
      {},
    );
  }

  /**
   * 向 Redis 上报本地负载
   */
  @throttle(1000)
  private reportLoad() {
    if (!this.open) {
      return;
    }
    if (this.online) {
      const load = this.consumer.getLoad();
      debug(`report load: ${load}`);
      this.redis.set(
        this.redisKey,
        load.toString(),
        // 一个上报周期后自动过期
        "PX",
        this.reportInterval,
      );
    } else {
      debug("RLB offline. Skip reporting load");
    }
    if (this.reportIntervalTimer) {
      clearTimeout(this.reportIntervalTimer);
    }
    this.reportIntervalTimer = setTimeout(
      () => this.reportLoad(),
      this.reportInterval,
    );
  }

}

export const RedisLoadBalancerConsumerEvent = {
  LOAD_CHANGE: Symbol("LOAD_CHANGE"),
};
