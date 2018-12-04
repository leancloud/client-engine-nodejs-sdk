// tslint:disable:max-classes-per-file
import { EventEmitter } from "events";
import {
  LoadBalancer,
  LoadBalancerConsumerEvent,
} from "./load-balancer";

const { LOAD_CHANGE } = LoadBalancerConsumerEvent;

interface IOriginalConsumer extends EventEmitter {
  [key: string]: any;
  load: number;
  close(): Promise<any>;
}

class ProxiedConsumer extends EventEmitter {
  public originalMethods = new Map();

  constructor(protected originalConsumer: IOriginalConsumer) {
    super();
    this.on(LOAD_CHANGE, (...args: any[]) => this.emit(LOAD_CHANGE, ...args));
  }

  get load() {
    return this.originalConsumer.load;
  }

  public consume(methodName: string, ...params: any[]) {
    const originalMethod = this.originalMethods.get(methodName);
    if (typeof originalMethod === "function") {
      return originalMethod.call(this.originalConsumer, ...params);
    }
  }

  public close() {
    return this.originalConsumer.close();
  }
}

interface ILoadBalancerOptions {
  redisUrl?: string;
  poolId?: string;
  reportInterval?: number;
}

export class LoadBalancerFactory {
  protected loadBalancers: Array<LoadBalancer<[string, ...any[]], any>> = [];

  constructor(
    private options: ILoadBalancerOptions = {},
  ) {}

  public bind(
    target: IOriginalConsumer,
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

  public close() {
    return Promise.all(this.loadBalancers.map((balancer) => balancer.close()));
  }
}
