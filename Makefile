.PHONY: setup test check-extension

setup:
	cd apps/extension && npm ci

test: check-extension

check-extension:
	cd apps/extension && npm test && npm run check
