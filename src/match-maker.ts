export interface IMatchMaker {
  match(playerIds: string[], roomProperties?: { [key: string]: any }): Promise<string>;
  reserveSeats(playerIds: string[], roomName: string): Promise<void>;
}
export enum MatchErrorCode {
  NO_MATCH = "No match",
}
