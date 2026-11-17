// Secrets are not in wrangler.jsonc; set with `wrangler secret put REBUILD_HOOK_URL`.
interface Env {
	REBUILD_HOOK_URL?: string;
}
