// tslint:disable:max-classes-per-file
import { Event, Player } from "@leancloud/play";
import d = require("debug");
import { interval } from "rxjs";
import { filter, take } from "rxjs/operators";
import { Game, GameEvent } from "./game";

const debug = d("ClientEngine:Automation");

export const AutomaticGameEvent = {
  ROOM_FULL: Symbol("Room Full"),
};

/**
 * 在房间满员时自动派发 AutomaticGameEvent.ROOM_FULL 事件
 * @returns a Game decorator
 */
export function watchRoomFull() {
  return <T extends new (...args: any[]) => Game>(gameClass: T) => {
    return class extends gameClass {
      constructor(...params: any[]) {
        super(...params);
        this.watchPlayers();
      }

      private watchPlayers() {
        const playerJoinedHandler = () => {
          if (
            this.room.playerList.length === this.room.maxPlayerCount
          ) {
            debug(`Room [${this.room.name}] is full`);
            this.emit(AutomaticGameEvent.ROOM_FULL);
            unwatch();
          }
        };

        const unwatch = () =>
          this.masterClient.off(Event.PLAYER_ROOM_JOINED, playerJoinedHandler);

        this.masterClient.on(Event.PLAYER_ROOM_JOINED, playerJoinedHandler);
        this.once(GameEvent.END, unwatch);
      }
    } as T;
  };
}

/**
 * 在所有玩家离开房间后自动销毁
 * @returns a Game decorator
 */
export function autoDestroy({ checkInterval = 10000 } = {}) {
  return <T extends new (...args: any[]) => Game>(gameClass: T) => {
    return class AutoDestroyGame extends gameClass {
      private static killerTimer = interval(checkInterval);

      constructor(...params: any[]) {
        super(...params);
        const roomIsEmpty = () => {
          if (!this.masterClient.room) {
            return true;
          }
          return this.players.length + this.registeredPlayers.size === 0;
        };
        AutoDestroyGame.killerTimer
          .pipe(
            filter(roomIsEmpty),
            take(2),
          )
          .toPromise()
          .then(() => {
            debug(`Room [${this.room.name}] is empty. Destroying.`);
            this.destroy();
          });
      }
    } as T;
  };
}
