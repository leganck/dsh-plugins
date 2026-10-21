import { T } from "./types";

export function tfun(x: T) {
  return tfun2(x);
}

export function tfun2(x: T) {
  return x;
}
