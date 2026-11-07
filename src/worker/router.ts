import type { Ctx } from './context';
import { HttpError, readJson } from './http';

type Handler = (ctx: Ctx) => Promise<Response>;
interface Route { method: string; re: RegExp; handler: Handler; rawBody: boolean }

export class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, handler: Handler, rawBody = false) {
    const re = new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_-]{1,64})') + '$');
    this.routes.push({ method, re, handler, rawBody });
  }
  get(p: string, h: Handler) { this.add('GET', p, h); }
  post(p: string, h: Handler, opts: { rawBody?: boolean } = {}) { this.add('POST', p, h, opts.rawBody); }
  put(p: string, h: Handler) { this.add('PUT', p, h); }
  delete(p: string, h: Handler) { this.add('DELETE', p, h); }

  async handle(ctx: Ctx, path: string): Promise<Response> {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== ctx.req.method && !(r.method === 'GET' && ctx.req.method === 'HEAD')) continue;
      ctx.params = { ...(m.groups ?? {}) };
      if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD' && !r.rawBody) ctx.body = await readJson(ctx.req);
      return r.handler(ctx);
    }
    throw pathMatched ? new HttpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED') : new HttpError(404, 'Not found.', 'NOT_FOUND');
  }
}
