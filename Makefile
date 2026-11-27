.PHONY: dev

# API on :4546 and Vite with HMR on :5173, opened in the browser. Pass CLI options with ARGS, e.g.
# make dev ARGS="--dir /tmp/sessions".
dev: node_modules
	bun run dev -- --open $(ARGS)

node_modules: package.json bun.lock
	bun install
	@touch node_modules
