BINARY   := brogang
VERSION  ?= 0.1.0
LDFLAGS  := -ldflags "-s -w -X main.Version=$(VERSION)"
PLATFORMS := linux/amd64 linux/arm64 windows/amd64 darwin/amd64 darwin/arm64

.PHONY: build install run clean release test fmt

## Build the binary into ./bin
build:
	go build $(LDFLAGS) -o bin/$(BINARY) ./cmd/brogang

## Build and install into GOBIN
install:
	go install $(LDFLAGS) ./cmd/brogang

## Run from source
run: build
	./bin/$(BINARY)

test:
	go test ./...

fmt:
	gofmt -w ./cmd ./internal

## Cross-compile every supported platform into dist/
release: clean
	@for p in $(PLATFORMS); do \
		os=$${p%/*}; arch=$${p#*/}; \
		ext=""; [ "$$os" = "windows" ] && ext=".exe"; \
		out=dist/$(BINARY)-$$os-$$arch$$ext; \
		echo "  building $$out"; \
		GOOS=$$os GOARCH=$$arch CGO_ENABLED=0 go build $(LDFLAGS) -o $$out ./cmd/brogang || exit 1; \
	done

clean:
	rm -rf bin dist
