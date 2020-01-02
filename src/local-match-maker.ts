import d = require("debug");
import sift, { SiftQuery } from "sift";
import { Game } from "./game";
import { IMatchMaker, MatchErrorCode } from "./match-maker";

const debug = d("ClientEngine:LocalMatchMaker");

export class LocalMatchMaker<T extends Game> implements IMatchMaker {
  protected reservationHoldTime: number;
  constructor(
    protected games: Set<T>,
    {
      // 匹配成功后座位的保留时间，超过这个时间后该座位将被释放。
      reservationHoldTime = 10000
    } = {}
  ) {
    this.reservationHoldTime = reservationHoldTime;
  }
  /**
   * 获取可用的游戏列表
   * @param availableSeatCount 可用空位数量，只返回大于这个数量的游戏
   */
  public getAvailableGames(
    availableSeatCount = 1,
    roomQuery: SiftQuery<{ [index: string]: any }> = {}
  ) {
    return Array.from(this.games)
      .filter(
        (game) =>
          game.room.open && game.availableSeatCount >= availableSeatCount
      )
      .filter((game) => sift(roomQuery)(game.room.customProperties));
  }
  public async match(
    playerIds: string[],
    roomQuery?: {
      [key: string]: any;
    }
  ) {
    debug(`match for %o with conditions %o`, playerIds, roomQuery);
    const playerCount = playerIds.length;
    const availableGames = this.getAvailableGames(playerCount, roomQuery);
    const game = availableGames[0];
    if (!game) {
      debug(`No game matches for %o`, playerIds);
      throw new Error(MatchErrorCode.NO_MATCH);
    }
    const name = game.room.name;
    this.reserveSeats(playerIds, name);
    debug(`Matched game for %o: %s`, playerIds, name);
    return name;
  }
  public async reserveSeats(playerIds: string[], roomName: string) {
    debug(`Reserve seats for %o: %s`, playerIds, roomName);
    const game = Array.from(this.games).find((g) => g.room.name === roomName);
    if (!game) {
      return;
    }
    if (game.availableSeatCount < playerIds.length) {
      // 这种情况不应该出现
      throw new Error(`Reserve seats fail: room[${game.room.name}] is full`);
    }
    // 预订成功
    playerIds.forEach((playerId) => {
      game.makeReservation(playerId);
      // 订位超时未加入房间的话释放该位置
      setTimeout(() => {
        if (game.registeredPlayers.has(playerId)) {
          debug(`Reservation[${playerId}] timeout, canceling.`);
          game.cancelReservation(playerId);
        }
      }, this.reservationHoldTime);
    });
  }
}
