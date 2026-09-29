// Cloudflare Pages Function adapter.
//
// Pages uses file based routing rather than a single fetch handler, so this
// catch-all takes every request under /v1 and any other route and hands it to
// the shared handler in src/index.js. That keeps one implementation to maintain
// whether it runs on Pages or Workers.
//
//   npx wrangler pages deploy public
//   # set pages_build_output_dir = "public" in wrangler.toml
import worker from "../src/index.js";

export const onRequest = ({ request, env }) => worker.fetch(request, env);
export const onRequestGet = ({ request, env }) => worker.fetch(request, env);
export const onRequestPost = ({ request, env }) => worker.fetch(request, env);
export const onRequestOptions = ({ request, env }) => worker.fetch(request, env);
