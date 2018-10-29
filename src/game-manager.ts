import { CreateRoomFlag, Event, Play, Region, Room } from "@leancloud/play";
import d = require("debug");
import { EventEmitter } from "events";
import PQueue = require("p-queue");
import { Game, GameEvent } from "./game";
import { IConsumer, RedisLoadBalancerConsumerEvent } from "./redis-load-balancer";
import { generateId, listen } from "./utils";

const debug = d("ClientEngine:GameManager");

interface IGameConstructor<T extends Game> {
  playerLimit: number;
  new(room: Room, masterClient: Play, ...args: any[]): T;
}

/**
 * GameManager 负责游戏房间的分配
 */
export class GameManager<T extends Game> extends EventEmitter implements IConsumer<string, string> {
  public open = true;
  private games = new Set<T>();
  private get availableGames() {
    return Array.from(this.games).filter(
      (game) => game.room.opened && game.availableSeatCount !== 0,
    );
  }
  private queue: PQueue;
  private reservationHoldTime: number;

  constructor(
    private gameClass: IGameConstructor<T>,
    private appId: string,
    private appKey: string,
    {
      // 创建游戏的并发数
      concurrency = 1,
      // 匹配成功后座位的保留时间，超过这个时间后该座位将被释放。
      reservationHoldTime = 10000,
    } = {},
    ) {
    super();
    this.queue = new PQueue({
      concurrency,
    });
    this.reservationHoldTime = reservationHoldTime;
  }

  public getLoad() {
    return this.games.size;
  }

  public getStatus() {
    return {
      availableGames: this.availableGames.map((game) => game.room.name),
      games: Array.from(this.games).map(({
        room: {
          name, master, visible,
        },
        availableSeatCount,
        registeredPlayers,
        players,
      }) => ({
        availableSeatCount,
        master: master.userId,
        name,
        players: players.map((player) => player.userId),
        registeredPlayers: Array.from(registeredPlayers.values()),
        visible,
      })),
      load: this.getLoad(),
      open: this.open,
      queue: this.queue.size,
    };
  }

  public async consume(playerId: string) {
    return this.makeReservation(playerId);
  }

  public async makeReservation(playerId: string) {
    if (!this.open) {
      throw new Error("GameManager closed.");
    }
    let game: T;
    const { availableGames } = this;
    if (availableGames.length > 0) {
      game = availableGames[0];
    } else {
      debug(`No game available, creating a new one`);
      console.log("before start", process.memoryUsage());
      game = await this.queue.add(() => this.createNewGame());
      this.addGame(game);
      game.once(GameEvent.END, () => this.remove(game));
    }
    this.reserveSeats(game, playerId);
    debug(`Reservation completed: %o`, game.room.name);
    return game.room.name;
  }

  public async close() {
    // 停止接受新的请求
    this.open = false;
    // 等待所有游戏结束
    return Promise.all(Array.from(this.games).map((game) => game.terminate()));
  }

  private createNewMasterClient(id = generateId()) {
    const masterClient = new Play();
    masterClient.init({
      appId: this.appId,
      appKey: this.appKey,
      region: Region.NorthChina,
    });
    masterClient.userId = id;
    return masterClient;
  }

  private addGame(game: T) {
    this.games.add(game);
    this.emit(RedisLoadBalancerConsumerEvent.LOAD_CHANGE);
  }

  private reserveSeats(game: T, playerId: string) {
    const { availableSeatCount } = game;
    if (availableSeatCount <= 0) {
      // 这种情况不应该出现
      throw new Error(`Reserve seats fail: room[${game.room.name}] is full`);
    }
    // 预订成功
    game.makeReservation(playerId);
    // 订位超时未加入房间的话释放该位置
    setTimeout(() => {
      if (game.registeredPlayers.has(playerId)) {
        debug(`Reservation[${playerId}] timeout, canceling.`);
        game.cancelReservation(playerId);
      }
    }, this.reservationHoldTime);
  }

  private async createNewGame() {
    const masterClient = this.createNewMasterClient();
    masterClient.connect();
    await listen(masterClient, Event.CONNECTED, Event.CONNECT_FAILED);
    debug(`New master client online: ${masterClient.userId}`);
    masterClient.createRoom({
      roomOptions: {
        flag:
          // tslint:disable-next-line:no-bitwise
          CreateRoomFlag.FixedMaster |
          CreateRoomFlag.MasterSetMaster |
          CreateRoomFlag.MasterUpdateRoomProperties,
        maxPlayerCount: this.gameClass.playerLimit + 1, // masterClient should be included
        visible: true,
      },
    });
    return listen(masterClient, Event.ROOM_CREATED, Event.ROOM_CREATE_FAILED).then(
      () => new this.gameClass(masterClient.room, masterClient),
    );
  }

  private remove(game: T) {
    debug(`Removing [${game.room.name}].`);
    this.games.delete(game);
    this.emit(RedisLoadBalancerConsumerEvent.LOAD_CHANGE);
  }
}
