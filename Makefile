.PHONY: dev release

# API on :4546 and Vite with HMR on :5173, opened in the browser. Pass CLI options with ARGS, e.g.
# make dev ARGS="--dir /tmp/sessions".
dev: node_modules
	bun run dev -- --open $(ARGS)

# Check, build and force-push the installable package to the `release` branch (see scripts/release.sh).
release: node_modules
	scripts/release.sh

node_modules: package.json bun.lock
	bun install
	@touch node_modules
