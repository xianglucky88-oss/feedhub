SHELL := /bin/sh
NODE ?= node

.PHONY: help test demo verify clean

help:
	@echo "make test     运行 Node 单元测试"
	@echo "make demo     跑本地 RSS 采集与推送"
	@echo "make verify   断言 SQLite 状态和 fanout"

test:
	$(NODE) --test

demo:
	$(NODE) src/cli.mjs demo

verify:
	sh scripts/verify.sh

clean:
	rm -rf /tmp/feedhub
