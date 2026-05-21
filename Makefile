# Knock — build & release Makefile
#
# Targets:
#   make dev              — run Tauri app in dev mode
#   make build            — release build for host triple (CLI + Tauri)
#   make build-cli        — only the CLI binary (host)
#   make build-app        — only the Tauri desktop bundle (host)
#   make cross TARGET=... — cross-build CLI for given triple
#   make package          — package host CLI binary into dist/ tarball/zip
#   make clean            — cargo clean + remove dist/
#
# Release artifacts are written to dist/.

APP_NAME      := knock
CLI_BIN       := knock
WORKSPACE_DIR := $(CURDIR)
APP_DIR       := $(WORKSPACE_DIR)/apps/knock-app
DIST_DIR      := $(WORKSPACE_DIR)/dist
VERSION       := $(shell awk -F\" '/^version/ {print $$2; exit}' Cargo.toml 2>/dev/null || echo 0.0.0)

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
  HOST_OS := macos
else ifeq ($(UNAME_S),Linux)
  HOST_OS := linux
else
  HOST_OS := windows
endif

ifeq ($(UNAME_M),x86_64)
  HOST_ARCH := x86_64
else ifeq ($(UNAME_M),amd64)
  HOST_ARCH := x86_64
else ifeq ($(UNAME_M),arm64)
  HOST_ARCH := aarch64
else ifeq ($(UNAME_M),aarch64)
  HOST_ARCH := aarch64
else
  HOST_ARCH := $(UNAME_M)
endif

.PHONY: help dev build build-cli build-app cross package package-cross clean install-deps tag set-version

help:
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install-deps: ## Install JS deps for Tauri app
	cd $(APP_DIR) && pnpm install --frozen-lockfile

dev: ## Run Tauri app in dev mode
	cd $(APP_DIR) && pnpm tauri dev

build: build-cli build-app ## Build CLI + Tauri bundles (host)

build-cli: ## Build CLI release binary (host)
	cargo build --release --bin $(CLI_BIN)
	@mkdir -p $(DIST_DIR)
	@cp target/release/$(CLI_BIN)$(if $(filter windows,$(HOST_OS)),.exe,) $(DIST_DIR)/

build-app: install-deps ## Build Tauri desktop bundle (host)
	cd $(APP_DIR) && pnpm tauri build
	@mkdir -p $(DIST_DIR)
	@find $(APP_DIR)/src-tauri/target/release/bundle -type f \
		\( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.msi' -o -name '*.exe' \) \
		-exec cp {} $(DIST_DIR)/ \; 2>/dev/null || true

cross: ## Cross-build CLI for TARGET=<triple>
	@test -n "$(TARGET)" || (echo "TARGET=<triple> required"; exit 1)
	rustup target add $(TARGET)
	cargo build --release --bin $(CLI_BIN) --target $(TARGET)

package: build-cli ## Package host CLI binary into dist/ archive
	@mkdir -p $(DIST_DIR)
	@cd $(DIST_DIR) && \
	if [ "$(HOST_OS)" = "windows" ]; then \
		zip -q $(APP_NAME)-$(VERSION)-$(HOST_OS)-$(HOST_ARCH).zip $(CLI_BIN).exe; \
	else \
		tar -czf $(APP_NAME)-$(VERSION)-$(HOST_OS)-$(HOST_ARCH).tar.gz $(CLI_BIN); \
	fi

package-cross: ## Package cross-built CLI. Vars: TARGET, OS, ARCH
	@test -n "$(TARGET)" -a -n "$(OS)" -a -n "$(ARCH)" || (echo "TARGET, OS, ARCH required"; exit 1)
	@mkdir -p $(DIST_DIR)
	@if [ "$(OS)" = "windows" ]; then \
		cp target/$(TARGET)/release/$(CLI_BIN).exe $(DIST_DIR)/; \
		cd $(DIST_DIR) && zip -q $(APP_NAME)-$(VERSION)-$(OS)-$(ARCH).zip $(CLI_BIN).exe && rm $(CLI_BIN).exe; \
	else \
		cp target/$(TARGET)/release/$(CLI_BIN) $(DIST_DIR)/; \
		cd $(DIST_DIR) && tar -czf $(APP_NAME)-$(VERSION)-$(OS)-$(ARCH).tar.gz $(CLI_BIN) && rm $(CLI_BIN); \
	fi

tag: ## Create + push git tag v$(VERSION)
	git tag -a v$(VERSION) -m "Release v$(VERSION)"
	git push origin v$(VERSION)

set-version: ## Bump version everywhere. Vars: V=<x.y.z>
	@test -n "$(V)" || (echo "V=<x.y.z> required"; exit 1)
	./scripts/set-version.sh $(V)

clean: ## Remove build artifacts
	cargo clean
	rm -rf $(DIST_DIR)
	rm -rf $(APP_DIR)/dist $(APP_DIR)/src-tauri/target
