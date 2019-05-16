import { Client, EventEmitter as PlayEventEmitter, PlayEvent } from "@leancloud/play";
import { EventEmitter } from "events";
import generate = require("nanoid/generate");

class WrappedPlayError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

export function listen<
  T extends PlayEvent,
  K extends keyof T,
  L extends keyof T
>(target: PlayEventEmitter<T>, resolveEvent: K, rejectEvent?: L) {
  return new Promise<T[K]>((resolve, reject) => {
    let rejectCallback: (error: T[L]) => any;
    const resolveCallback = (payload: T[K]) => {
      if (rejectEvent) {
        target.off(rejectEvent, rejectCallback);
      }
      resolve(payload);
    };
    target.once(resolveEvent, resolveCallback);
    if (rejectEvent) {
      rejectCallback = (error) => {
        target.off(resolveEvent, resolveCallback);
        if (error instanceof Error) {
          reject(error);
        } else {
          const {
            detail,
            code,
          } = error as any;
          const wrappedError = new WrappedPlayError(detail || JSON.stringify(error));
          if (code) {
            wrappedError.code = code;
          }
          reject(wrappedError);
        }
      };
      target.once(rejectEvent, rejectCallback);
    }
  });
}

export function listenNodeEE<T>(
  target: EventEmitter,
  resolveEvent: string | symbol,
  rejectEvent?: string | symbol
) {
  return new Promise<T>((resolve, reject) => {
    let rejectCallback: (error: Error) => any;
    const resolveCallback = (payload: T) => {
      if (rejectEvent) {
        target.off(rejectEvent, rejectCallback);
      }
      resolve(payload);
    };
    target.once(resolveEvent, resolveCallback);
    if (rejectEvent) {
      rejectCallback = (error) => {
        target.off(resolveEvent, resolveCallback);
        reject(error);
      };
      target.once(rejectEvent, rejectCallback);
    }
  });
}

const alphabet =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const generateId = (length = 10) => generate(alphabet, length);

export const createClient = (appId: string, appKey: string, clientId = generateId()) => {
  const env = process.env.LEANCLOUD_APP_ENV;
  const masterClient = new Client({
    appId,
    appKey,
    ssl: env !== "production" && env !== "staging",
    userId: clientId,
  });
  return masterClient;
};
