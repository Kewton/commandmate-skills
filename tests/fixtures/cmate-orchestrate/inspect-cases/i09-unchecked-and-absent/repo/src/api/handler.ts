// fixture: src/api/handler.ts
import { readConfig } from './config.ts';

const DEFAULT_LAUNCHER = 'commandmate';

export function handle(request) {
  return request;
}
export function resolveLauncher(readConfig) {
  return DEFAULT_LAUNCHER;
}
// end
