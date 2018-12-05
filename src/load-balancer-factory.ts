// tslint:disable:max-classes-per-file
import { EventEmitter } from "events";
import {
  LoadBalancer,
  LoadBalancerConsumerEvent,
} from "./load-balancer";

const { LOAD_CHANGE } = LoadBalancerConsumerEvent;

export interface ILoadBalancerFactoryBindingTarget extends EventEmitter {
  [key: string]: any;
  load: number;
  close(): Promise<any>;
}

class ProxiedConsumer extends EventEmitter {
  public originalMethods = new Map();

  constructor(protected target: ILoadBalancerFactoryBindingTarget) {
    super();
    this.on(LOAD_CHANGE, (...args: any[]) => this.emit(LOAD_CHANGE, ...args));
  }

  get load() {
    return this.target.load;
  }

  public consume(methodName: string, ...params: any[]) {
    const originalMethod = this.originalMethods.get(methodName);
    if (typeof originalMethod === "function") {
      return originalMethod.call(this.target, ...params);
    }
  }

  public close() {
    return this.target.close();
  }
}

interface ILoadBalancerOptions {
  redisUrl?: string;
  /** LoadBalancer 资源池的标识，同样 poolId LoadBalancer 之间是隔离的。用于在一个 Redis 中运行多个 LoadBalancer。 */
  poolId?: string;
  /** 上报本地 consumer load 时间间隔，单位毫秒。 */
  reportInterval?: number;
}

/**
 * LoadBalancer 工厂，用于给指定对象包装 LoadBalancer。
 */
export class LoadBalancerFactory {
  protected loadBalancers: Array<LoadBalancer<[string, ...any[]], any>> = [];

  /**
   * @param options 创建新的 LoadBalancer 时使用的参数，该参数可以在 bind 的时候覆盖。
   */
  constructor(
    private options: ILoadBalancerOptions = {},
  ) {}

  /**
   * 绑定一个对象，创建一个与该对象绑定的 LoadBalancer，对该对象上指定方法的调用会被自动转到合适的 LoadBalancer 节点执行。
   * @param target 指定的对象
   * @param proxiedMethodNames 需要委托的方法名
   * @param options 创建新的 LoadBalancer 时使用的参数
   */
  public bind(
    target: ILoadBalancerFactoryBindingTarget,
    proxiedMethodNames: string[],
    options: ILoadBalancerOptions = {},
  ) {
    const {
      redisUrl,
      ...restOptions
    } = options;
    const proxiedConsumer = new ProxiedConsumer(target);
    const loadBalancer = new LoadBalancer(
      proxiedConsumer,
      options.redisUrl = this.options.redisUrl,
      {
        ...this.options,
        ...restOptions,
      },
    );
    proxiedMethodNames.forEach((methodName) => {
      const originalMethod = target[methodName];
      if (typeof originalMethod !== "function") {
        throw new Error(
          `LoadBalancer binding error: target has no method named ${methodName}.`,
        );
      }
      proxiedConsumer.originalMethods.set(methodName, originalMethod);
      target[methodName] = (...params: any[]) =>
        loadBalancer.consume(methodName, ...params);
    });
    this.loadBalancers.push(loadBalancer);
    return loadBalancer;
  }

  public getStatus() {
    return Promise.all(this.loadBalancers.map((balancer) => balancer.getStatus()));
  }

  /**
   * 关闭该 LoadBalancer 工厂生成的所有 LoadBalancer
   */
  public close() {
    return Promise.all(this.loadBalancers.map((balancer) => balancer.close()));
  }
}
