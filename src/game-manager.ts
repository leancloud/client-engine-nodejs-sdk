import { Client, CreateRoomFlag, Event, Room } from "@leancloud/play";
import d = require("debug");
import { EventEmitter } from "events";
import PQueue from "p-queue";
import { Game, GameEvent } from "./game";
import { LoadBalancerConsumerEvent } from "./load-balancer";
import { LocalMatchMaker } from "./local-match-maker";
import { IMatchMaker } from "./match-maker";
import { createClient } from "./utils";

const debug = d("ClientEngine:GameManager");

interface IGameConstructor<T extends Game> {
  defaultSeatCount: number;
  maxSeatCount?: number;
  minSeatCount?: number;
  new (room: Room, masterClient: Client, ...args: any[]): T;
}

/**
 * 创建 Room 时的选项，
 * 是 {@link https://leancloud.github.io/Play-SDK-JS/doc/Play.html#createRoom Play SDK 中 createRoom 方法}
 * 的 `roomOptions` 参数的一个子集。
 */
export interface IRoomOptions {
  visible?: boolean;
  customRoomProperties?: { [key: string]: any };
  customRoomPropertyKeysForLobby?: string[];
}

/**
 * 创建游戏时的选项
 */
export interface ICreateGameOptions {
  /** 游戏房间席位数量（不包含 masterClient） */
  seatCount?: number;
  /** 房间名字 */
  roomName?: string;
  /** 房间选项 */
  roomOptions?: IRoomOptions;
  /** 队员id */
  expectedUserIds?: string[];
}

/**
 * GameManager 负责游戏房间的分配
 */
export class GameManager<T extends Game> extends EventEmitter {
  public get load() {
    return this.games.size;
  }
  public open = true;
  public games = new Set<T>();
  protected queue: PQueue;
  protected matchMaker: IMatchMaker;

  constructor(
    protected gameClass: IGameConstructor<T>,
    protected appId: string,
    protected appKey: string,
    {
      // 创建游戏的并发数
      concurrency = 1,
      matchMaker
    }: {
      concurrency?: number;
      matchMaker?: IMatchMaker;
    } = {}
  ) {
    super();
    this.queue = new PQueue({
      concurrency
    });
    this.matchMaker = matchMaker || new LocalMatchMaker(this.games);
  }

  public async getStatus() {
    return {
      games: Array.from(this.games).map(
        ({
          room: { name, master, visible, opened },
          seatCount,
          availableSeatCount,
          registeredPlayers,
          players
        }) => ({
          availableSeatCount,
          master: master.userId,
          name,
          opened,
          players: players.map((player) => player.userId),
          registeredPlayers: Array.from(registeredPlayers.values()),
          seatCount,
          visible
        })
      ),
      load: this.load,
      open: this.open,
      queue: this.queue.size
    };
  }

  public async close() {
    // 停止接受新的请求
    this.open = false;
    // 等待所有游戏结束
    return Promise.all(Array.from(this.games).map((game) => game.terminate()));
  }

  public setMatchMaker(matchMaker: IMatchMaker) {
    this.matchMaker = matchMaker;
  }

  public async match(
    playerIds: string[],
    roomProperties?: {
      [key: string]: any;
    }
  ) {
    return this.matchMaker.match(playerIds, roomProperties);
  }

  /**
   * 创建一个新的游戏。
   * @param playerIds 预留位置的的玩家 ID
   * @param options 配置项，详见其类型说明
   */
  public async createGame(playerIds: string[], options?: ICreateGameOptions) {
    if (!this.open) {
      throw new Error("GameManager closed.");
    }
    debug(`Creating a new game`);
    const game = await this.queue.add(() => this.createEmptyGame(options));
    this.addGame(game);
    game.once(GameEvent.END, () => this.remove(game));
    this.matchMaker.reserveSeats(playerIds, game.room.name);
    return game;
  }

  /**
   * 创建一个新的 masterClient
   * @param id 指定 masterClient id
   */
  protected createMasterClient(id?: string) {
    return createClient(this.appId, this.appKey, id);
  }

  protected addGame(game: T) {
    this.games.add(game);
    debug(`Load: ${this.load}`);
    this.emit(LoadBalancerConsumerEvent.LOAD_CHANGE);
  }

  /**
   * 创建新游戏
   * @param options 可以指定席位数量、房间名与房间选项等配置
   */
  protected async createEmptyGame(options: ICreateGameOptions = {}) {
    const {
      expectedUserIds,
      seatCount = this.gameClass.defaultSeatCount,
      roomName,
      roomOptions
    } = options;
    const { gameClass } = this;
    if (gameClass.maxSeatCount && seatCount > gameClass.maxSeatCount) {
      throw new Error(
        `seatCount too large. The maxSeatCount is ${gameClass.maxSeatCount}`
      );
    }
    if (gameClass.minSeatCount && seatCount < gameClass.minSeatCount) {
      throw new Error(
        `seatCount too small. The minSeatCount is ${gameClass.minSeatCount}`
      );
    }
    const masterClient = this.createMasterClient();
    await masterClient.connect();
    debug(`New master client online: ${masterClient.userId}`);
    const room = await masterClient.createRoom({
      expectedUserIds,
      roomName,
      roomOptions: {
        visible: true,
        ...roomOptions,
        flag:
          // tslint:disable-next-line:no-bitwise
          CreateRoomFlag.FixedMaster |
          CreateRoomFlag.MasterUpdateRoomProperties,
        maxPlayerCount: seatCount + 1 // masterClient should be included
      }
    });
    return new gameClass(room, masterClient);
  }

  protected remove(game: T) {
    debug(`Removing [${game.room.name}].`);
    this.games.delete(game);
    this.emit(LoadBalancerConsumerEvent.LOAD_CHANGE);
  }
}
