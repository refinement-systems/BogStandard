import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Prevent worker processes from hanging due to open pg.Pool TCP sockets
		// that linger after pool.end().
		forceExit: true,
	},
});
