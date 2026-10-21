import { util } from "./util";

export function run() {
  return util();
}

export class Svc {
  m() {
    return this.n();
  }
  n() {
    return 0;
  }
}
