SHELL := /bin/bash
.DEFAULT_GOAL := help
PROFILE ?=

help: ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-9s %s\n", $$1, $$2}'

install: ## install JS + Python dev dependencies
	pnpm install
	uv sync

check: ## lint + unit tests (no models, no services)
	pnpm lint
	pnpm typecheck
	pnpm test
	uv run ruff check .
	uv run ruff format --check .
	uv run pytest
	for f in infra/scripts/*.sh infra/models/*.sh; do bash -n $$f || exit 1; done

prereqs: ## check host tools; prints install commands for anything missing
	infra/scripts/prereqs.sh

models: ## download every model in config/models.yaml (resumable, ~30 GB)
	infra/models/download.sh $(if $(PROFILE),--profile $(PROFILE),)

up: ## start postgres, the LLM (PROFILE=fast|quality), whisper, the Hermes smoke gateway
	infra/scripts/up.sh $(PROFILE)

down: ## stop everything make up started
	infra/scripts/down.sh

smoke: ## live checks against the running stack, offline, with egress + memory guards
	HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 uv run --group live pytest -m live infra/py/tests/live

dev: ## chat stack for manual testing: postgres, relay, bridge, web on http://127.0.0.1:5173
	infra/scripts/dev.sh

seed: ## create the four demo users; prints their PINs once
	docker compose -f infra/docker-compose.yaml up -d --wait postgres
	pnpm --filter @sa/bridge run migrate
	pnpm --filter @sa/bridge run seed

e2e: ## Playwright: four browsers chat end to end (self-contained, no docker)
	pnpm --filter @sa/e2e run e2e

.PHONY: help install check prereqs models up down smoke dev seed e2e
