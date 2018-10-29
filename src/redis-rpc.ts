import d = require("debug");
import * as Redis from "ioredis";
import { bind } from "lodash-decorators";
import { fromEvent, Observable } from "rxjs";
import { filter, first, map, timeout as rxTimeout } from "rxjs/operators";
import { generateId } from "./utils";

const debug = d("RRPC");

interface IPubSubMessage<T> {
  id: string;
  payload: T;
  caller?: string;
}

/**
 * RedisPRCNode 是一个节点，通过一个共享的 Redis，节点之间可以远程调用
 */
export default class RedisPRCNode<T, U> {
  private subClient: Redis.Redis;
  private pubClient: Redis.Redis;

  private subChannel?: string;

  private subClientMessageStream: Observable<[string, IPubSubMessage<T | U>]>;

  /**
   * @param id 节点的唯一标识
   * @param handler 处理远程调用的方法
   * @param redisUrl redis URL，如果不提供下面的 client 参数，会使用该 url 创建 redis client
   * @param pubClient 用于发布消息的 redis client
   * @param pubClient 用于订阅消息的 redis client，这个 client 会被独占，不能发送任何其他命令
   */
  constructor(
    public id: string,
    private handler: (params: T) => Promise<U>,
    redisUrl?: string,
    {
      pubClient = new Redis(redisUrl).on("error", debug),
      subClient = new Redis(redisUrl).on("error", debug),
    } = {},
  ) {
    this.pubClient = pubClient;
    this.subClient = subClient;

    this.subChannel = `RLB:RPC:${id}`;
    this.subClient.subscribe([this.subChannel, `${this.subChannel}:result`]);
    this.subClientMessageStream = fromEvent<[string, string]>(
      this.subClient,
      "message",
    ).pipe(
      map(
        ([channel, message]) =>
          [channel, JSON.parse(message)] as [string, IPubSubMessage<T | U>],
      ),
    );
    this.subClientMessageStream.subscribe(debug);
    this.subClientMessageStream
      .pipe(filter(([channel]) => channel === this.subChannel))
      .pipe(map(([channel, message]) => message as IPubSubMessage<T>))
      .subscribe(this.handleRPCCall);
  }

  public diconnect() {
    this.subClient.unsubscribe();
  }

  /**
   * @param nodeId 目标节点 id
   * @param params 调用参数
   * @param timeout 超时毫秒数
   */
  public async call(nodeId: string, params: T, timeout = 15000) {
    const id = generateId(10);
    const message: IPubSubMessage<T> = {
      caller: this.id,
      id,
      payload: params,
    };
    debug(`call ${nodeId}:`, message);
    const recievedClientsNumber = await this.pubClient.publish(
      `RLB:RPC:${nodeId}`,
      JSON.stringify(message),
    );
    debug(`${recievedClientsNumber} clients recieved`);
    if (recievedClientsNumber === 0) {
      throw new Error("Target node does not exist");
    }
    return this.subClientMessageStream
    .pipe(
      filter(
        ([channel, incomingMessage]) =>
          channel === `${this.subChannel}:result` && incomingMessage.id === id,
      ),
      map(
        ([channel, incomingMessage]) =>
          (incomingMessage as IPubSubMessage<U>).payload,
      ),
      first(),
      rxTimeout(timeout),
    ).toPromise();
  }

  @bind
  private async handleRPCCall(message: IPubSubMessage<T>) {
    debug("handle %O", message);
    const { caller, id, payload: params } = message;
    const result = await this.handler(params);
    debug("responed %O", result);
    const responseMessage: IPubSubMessage<U> = {
      id,
      payload: result,
    };
    const recievedClientsNumber = await this.pubClient.publish(
      `RLB:RPC:${caller}:result`,
      JSON.stringify(responseMessage),
    );
    debug(`${recievedClientsNumber} clients recieved`);
  }
}
